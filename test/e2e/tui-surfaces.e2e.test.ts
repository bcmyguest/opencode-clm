/**
 * Parity block 6 in the real opencode TUI (1.18.34): the footer right of the session prompt,
 * the settings page's detail lines and its "Reset to defaults" row. Gated like the other
 * e2e cases (OPENCODE_CLM_E2E=1).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Case, CASE_TIMEOUT_MS, cleanup, ENABLED, mirrorEdit } from "./harness.ts";
import { bash, steps, text } from "./mock-server.ts";
import { TuiDriver } from "./tui-driver.ts";

afterAll(cleanup);

const MARKER_PY = `"ALPHA_" + str(6 * 7) + "_OUTPUT"`;
const REPLACEMENT_PY = `"[note: REPLACED_" + "BETA]"`;

describe.skipIf(!ENABLED)("opencode-clm status surfaces in the TUI", () => {
	test("footer, settings details and the reset row", async () => {
		const c = new Case("tui-surfaces", steps(
			bash("echo ALPHA_$((6*7))_OUTPUT", "Print the marker"),
			(request: { mirrorPath?: string }) => bash(mirrorEdit(request.mirrorPath!, MARKER_PY, "replace", REPLACEMENT_PY), "Rewrite"),
			text("E2E_DONE"),
		), { plugin: { budget: "16k", reserve: 512 } });
		await c.run(["Run the e2e script."]);
		const requests = c.mock.requests.length;

		const tui = new TuiDriver(c, ["-s", c.sessionID()]);
		try {
			expect(await tui.waitFor(/E2E_DONE/, 60_000)).toBe(true);
			// The footer: the newest size (~ for an estimate) against the 16k budget, revision 1.
			expect(await tui.waitFor(/clm ~?[\d.,]+k? \/ 16k · r1/, 30_000)).toBe(true);

			await tui.type("/clm settings");
			await tui.write("\r", 800);
			expect(await tui.waitFor(/› CLM editing/)).toBe(true);
			const screen = tui.screen();
			expect(screen).toMatch(/Estimate (×\d\.\d\d, calibrated from \d+ provider count|not calibrated yet)/);
			expect(screen).toMatch(/Guard withholds the oldest tool results above 15(\.\d)?k/);
			expect(screen).toContain("Reset to defaults");
			expect(screen).toContain("nothing changed");

			// Change the budget, then reset it from the last row.
			await tui.write("\x1b[B");
			expect(await tui.waitFor(/› Budget/)).toBe(true);
			await tui.write("\r", 800);
			await tui.write("\x7f".repeat(12), 300);
			await tui.type("20k");
			await tui.write("\r", 800);
			expect(await tui.waitFor(/✓ Budget: 20k/)).toBe(true);
			const overrides = join(c.sessionDir(), "overrides.json");
			expect(JSON.parse(readFileSync(overrides, "utf8")).overrides).toEqual({ budget: 20_000 });
			await tui.write("G");
			expect(await tui.waitFor(/› Reset to defaults\s+1 changed/)).toBe(true);
			await tui.write("\r", 800);
			expect(await tui.waitFor(/✓ Reset to defaults: nothing changed/)).toBe(true);
			expect(existsSync(overrides) ? JSON.parse(readFileSync(overrides, "utf8")).overrides : {}).toEqual({});

			await tui.write("q", 800);
			expect(await tui.waitFor(/E2E_DONE/)).toBe(true);
			expect(c.mock.requests.length).toBe(requests);
		} finally {
			tui.kill();
		}
	}, CASE_TIMEOUT_MS);
});
