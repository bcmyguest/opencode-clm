/**
 * The `/clm` panel under `opencode attach` (opencode 1.18.34): `opencode serve` owns the
 * session; the TUI runs in a separate process whose own CLM_MIRROR_DIR names a directory
 * that does not exist, so it cannot see the server's session files and must read them
 * through the server. Settings changes and `/clm reset` travel over the turn-free channel
 * (src/channel.ts): no model request. A session directory outside the server's directory
 * is read by the server plugin over the same channel. Gated like the other e2e cases
 * (OPENCODE_CLM_E2E=1).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Case, CASE_TIMEOUT_MS, cleanup, ENABLED, mirrorEdit, tempPath } from "./harness.ts";
import { bash, steps, text } from "./mock-server.ts";
import { TuiDriver } from "./tui-driver.ts";

afterAll(cleanup);

const MARKER_PY = `"ALPHA_" + str(6 * 7) + "_OUTPUT"`;
const REPLACEMENT_PY = `"[note: REPLACED_" + "BETA]"`;

describe.skipIf(!ENABLED)("opencode-clm panel under opencode attach", () => {
	test("panel shows the server's data; settings and /clm reset reach the server with no model request", async () => {
		const c = new Case("tui-attach", steps(
			bash("echo ALPHA_$((6*7))_OUTPUT", "Print the marker"),
			(request: { mirrorPath?: string }) => bash(mirrorEdit(request.mirrorPath!, MARKER_PY, "replace", REPLACEMENT_PY), "Rewrite"),
			text("E2E_DONE"),
		), { plugin: { budget: "16k", reserve: 512 }, mirrorViaServerEnv: "inside" });
		await c.run(["Run the e2e script."]);
		expect(c.stateJson().revision).toBe(1);
		const requests = c.mock.requests.length;
		const tuiMirror = tempPath("tui-attach-elsewhere");

		const served = await c.serve();
		const tui = new TuiDriver(c, ["attach", served.url, "-s", c.sessionID()], 120, 34, { CLM_MIRROR_DIR: tuiMirror });
		try {
			expect(await tui.waitFor(/E2E_DONE/, 60_000)).toBe(true);
			await Bun.sleep(1_000);
			// The files come through the server's file API, not the channel.
			await tui.type("/clm path");
			await tui.write("\r", 800);
			expect(await tui.waitFor(/file API\)/)).toBe(true);
			await tui.type("/clm");
			await tui.write("\r", 800);
			expect(await tui.waitFor(/Live Context Viewer · r1/)).toBe(true);
			expect(tui.screen()).toMatch(/r1 .*→/);

			// revisions/r1.json came through the server's file API.
			await tui.write("3");
			expect(await tui.waitFor(/exact recorded provenance/)).toBe(true);

			// Budget from the settings page: the server validates and writes overrides.json.
			await tui.write("4");
			expect(await tui.waitFor(/› CLM editing/)).toBe(true);
			await tui.write("\x1b[B");
			expect(await tui.waitFor(/› Budget/)).toBe(true);
			await tui.write("\r", 800);
			await tui.write("\x7f".repeat(12), 300);
			await tui.type("20k");
			await tui.write("\r", 800);
			expect(await tui.waitFor(/✓ Budget: 20k/)).toBe(true);
			expect(JSON.parse(readFileSync(join(c.sessionDir(), "overrides.json"), "utf8"))).toEqual({ version: 1, overrides: { budget: 20_000 } });
			// The panel re-read overrides.json through the server: the row shows the changed value.
			expect(await tui.waitFor(/› Budget •\s+20k/)).toBe(true);

			await tui.write("q", 800);
			expect(await tui.waitFor(/E2E_DONE/)).toBe(true);

			// `/clm reset` is consumed by the TUI and applied by the server plugin.
			await tui.type("/clm reset");
			await tui.write("\r", 800);
			expect(await tui.waitFor(/CLM revision dropped/)).toBe(true);
			expect(c.stateJson().lastOutcome).toMatchObject({ kind: "reset", message: "/clm reset" });

			// A typed config change goes the same way.
			await tui.type("/clm config guard off");
			await tui.write("\r", 800);
			expect(await tui.waitFor(/CLM Overflow guard: off/)).toBe(true);
			expect(JSON.parse(readFileSync(join(c.sessionDir(), "overrides.json"), "utf8")).overrides).toEqual({ budget: 20_000, guard: "off" });

			expect(c.mock.requests.length).toBe(requests);
			expect(existsSync(tuiMirror)).toBe(false);
		} finally {
			tui.kill();
			served.stop();
		}
	}, CASE_TIMEOUT_MS);

	test("a setting typed before the panel opens reaches the server, not the TUI's own empty directory", async () => {
		const c = new Case("tui-attach-write", steps(
			bash("echo ALPHA_$((6*7))_OUTPUT", "Print the marker"),
			(request: { mirrorPath?: string }) => bash(mirrorEdit(request.mirrorPath!, MARKER_PY, "replace", REPLACEMENT_PY), "Rewrite"),
			text("E2E_DONE"),
		), { plugin: { budget: "16k", reserve: 512 }, mirrorViaServerEnv: "inside" });
		await c.run(["Run the e2e script."]);
		const requests = c.mock.requests.length;
		// The TUI's mirror parent exists on this disk, but the server keeps the files elsewhere.
		const tuiMirror = tempPath("tui-attach-write-elsewhere");
		mkdirSync(tuiMirror, { recursive: true });

		const served = await c.serve();
		const tui = new TuiDriver(c, ["attach", served.url, "-s", c.sessionID()], 120, 34, { CLM_MIRROR_DIR: tuiMirror });
		try {
			expect(await tui.waitFor(/E2E_DONE/, 60_000)).toBe(true);
			await Bun.sleep(1_000);
			await tui.type("/clm config budget 20k");
			await tui.write("\r", 800);
			expect(await tui.waitFor(/CLM Budget: 20k/)).toBe(true);
			expect(JSON.parse(readFileSync(join(c.sessionDir(), "overrides.json"), "utf8")).overrides).toEqual({ budget: 20_000 });
			expect(existsSync(join(tuiMirror, `clm-${c.sessionID()}`))).toBe(false);
			// The panel then shows the server's data.
			await tui.type("/clm");
			await tui.write("\r", 800);
			expect(await tui.waitFor(/Live Context Viewer · r1/)).toBe(true);
			expect(c.mock.requests.length).toBe(requests);
		} finally {
			tui.kill();
			served.stop();
		}
	}, CASE_TIMEOUT_MS);

	test("a session directory outside the server's directory is read through the server plugin", async () => {
		const c = new Case("tui-attach-outside", steps(
			bash("echo ALPHA_$((6*7))_OUTPUT", "Print the marker"),
			(request: { mirrorPath?: string }) => bash(mirrorEdit(request.mirrorPath!, MARKER_PY, "replace", REPLACEMENT_PY), "Rewrite"),
			text("E2E_DONE"),
		), { plugin: { budget: "16k", reserve: 512 }, mirrorViaServerEnv: "outside" });
		await c.run(["Run the e2e script."]);
		expect(c.sessionDir().startsWith(c.project)).toBe(false);
		const requests = c.mock.requests.length;
		const tuiMirror = tempPath("tui-attach-outside-elsewhere");

		const served = await c.serve();
		const tui = new TuiDriver(c, ["attach", served.url, "-s", c.sessionID()], 120, 34, { CLM_MIRROR_DIR: tuiMirror });
		try {
			expect(await tui.waitFor(/E2E_DONE/, 60_000)).toBe(true);
			await Bun.sleep(1_000);
			await tui.type("/clm path");
			await tui.write("\r", 800);
			// The toast wraps; its last words name the reader.
			expect(await tui.waitFor(/plugin channel\)/)).toBe(true);
			await tui.type("/clm edits");
			await tui.write("\r", 800);
			expect(await tui.waitFor(/Live Context Viewer · r1/)).toBe(true);
			expect(await tui.waitFor(/exact recorded provenance/)).toBe(true);
			await tui.write("j");
			await tui.write("\r");
			expect(await tui.waitFor(/REPLACED_BETA/)).toBe(true);
			expect(c.mock.requests.length).toBe(requests);
			expect(existsSync(tuiMirror)).toBe(false);
		} finally {
			tui.kill();
			served.stop();
		}
	}, CASE_TIMEOUT_MS);
});
