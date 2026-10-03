/**
 * Parity block 7 (C13) in the real opencode TUI (1.18.34): Tab completes a typed `/clm …`
 * line inline, and the completed line runs. Gated like the other e2e cases (OPENCODE_CLM_E2E=1).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Case, CASE_TIMEOUT_MS, cleanup, ENABLED } from "./harness.ts";
import { steps, text } from "./mock-server.ts";
import { TuiDriver } from "./tui-driver.ts";

afterAll(cleanup);

describe.skipIf(!ENABLED)("opencode-clm /clm completion in the TUI", () => {
	test("Tab completes subcommands and setting values; no model request", async () => {
		const c = new Case("tui-complete", steps(text("E2E_DONE")), { plugin: { budget: "16k", reserve: 512 } });
		await c.run(["Say done."]);
		const requests = c.mock.requests.length;

		const tui = new TuiDriver(c, ["-s", c.sessionID()]);
		try {
			expect(await tui.waitFor(/E2E_DONE/, 60_000)).toBe(true);
			await Bun.sleep(1_000);
			await tui.type("/clm config gu");
			await tui.write("\t", 800);
			expect(await tui.waitFor(/\/clm config guard /)).toBe(true);
			await tui.type("of");
			await tui.write("\t", 800);
			expect(await tui.waitFor(/\/clm config guard off/)).toBe(true);
			await tui.write("\r", 800);
			const overrides = join(c.sessionDir(), "overrides.json");
			const deadline = Date.now() + 10_000;
			while (!existsSync(overrides) && Date.now() < deadline) await Bun.sleep(150);
			expect(JSON.parse(readFileSync(overrides, "utf8")).overrides).toEqual({ guard: "off" });
			// Ambiguous: the items are listed and the line is kept.
			await tui.type("/clm o");
			await tui.write("\t", 800);
			expect(await tui.waitFor(/\/clm overview · \/clm on · \/clm off/)).toBe(true);
			expect(c.mock.requests.length).toBe(requests);
		} finally {
			tui.kill();
		}
	}, CASE_TIMEOUT_MS);
});
