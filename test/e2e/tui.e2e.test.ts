/**
 * The `/clm` panel in the real opencode TUI (1.18.34) against the scripted mock. Gated like
 * clm.e2e.test.ts (OPENCODE_CLM_E2E=1). One `opencode run` produces a session with an
 * accepted mirror edit; then the TUI opens that session in a pty, `/clm` opens the panel,
 * keys switch pages, and `q` returns to the session.
 */
import { afterAll, describe, expect, test } from "bun:test";

import { Case, CASE_TIMEOUT_MS, cleanup, ENABLED, mirrorEdit } from "./harness.ts";
import { bash, steps, text } from "./mock-server.ts";
import { TuiDriver } from "./tui-driver.ts";

afterAll(cleanup);

const MARKER_PY = `"ALPHA_" + str(6 * 7) + "_OUTPUT"`;
const REPLACEMENT_PY = `"[note: REPLACED_" + "BETA]"`;

describe.skipIf(!ENABLED)("opencode-clm panel in the TUI", () => {
	test("/clm opens the panel; 1–4, Enter and q work; no model request", async () => {
		const c = new Case("tui-panel", steps(
			bash("echo ALPHA_$((6*7))_OUTPUT", "Print the marker"),
			(request: { mirrorPath?: string }) => bash(mirrorEdit(request.mirrorPath!, MARKER_PY, "replace", REPLACEMENT_PY), "Rewrite"),
			text("E2E_DONE"),
		), { plugin: { budget: "16k", reserve: 512 } });
		await c.run(["Run the e2e script."]);
		expect(c.stateJson().revision).toBe(1);
		const requests = c.mock.requests.length;

		const tui = new TuiDriver(c, ["-s", c.sessionID()]);
		try {
			expect(await tui.waitFor(/E2E_DONE/, 60_000)).toBe(true);
			await Bun.sleep(1_000);
			await tui.type("/clm");
			await tui.write("\r", 800);
			expect(await tui.waitFor(/Live Context Viewer · r1/)).toBe(true);
			let screen = tui.screen();
			expect(screen).toContain("[1:overview]");
			// The newest bar is the host's provider count for the finished reply (no "~").
			expect(screen).toMatch(/Context size · 3 requests · now \d/);
			expect(screen).toMatch(/r1 .*→/);

			await tui.write("3");
			expect(await tui.waitFor(/Live-context compression runs/)).toBe(true);
			await tui.write("\r");
			screen = tui.screen();
			expect(screen).toMatch(/\[3:edits\]/);

			await tui.write("2");
			expect(await tui.waitFor(/Current input/)).toBe(true);
			await tui.write("4");
			expect(await tui.waitFor(/› CLM editing/)).toBe(true);
			await tui.write("\t");
			expect(await tui.waitFor(/\[1:overview\]/)).toBe(true);

			await tui.write("q", 800);
			expect(await tui.waitFor(/E2E_DONE/)).toBe(true);
			expect(tui.screen()).not.toContain("Live Context Viewer");

			// A typed `/clm input` is handled in the TUI: no model turn.
			await tui.type("/clm input");
			await tui.write("\r", 800);
			expect(await tui.waitFor(/\[2:input\]/)).toBe(true);
			await tui.write("\x1b", 800);
			expect(c.mock.requests.length).toBe(requests);
		} finally {
			tui.kill();
		}
	}, CASE_TIMEOUT_MS);
});
