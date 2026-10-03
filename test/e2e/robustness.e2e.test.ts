/**
 * Robustness against real opencode 1.18.34 and the scripted mock (parity block 5). Gated
 * like clm.e2e.test.ts (OPENCODE_CLM_E2E=1).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Case, CASE_TIMEOUT_MS, cleanup, ENABLED, mirrorEdit, toolTexts } from "./harness.ts";
import { bash, steps, text } from "./mock-server.ts";

afterAll(cleanup);

describe.skipIf(!ENABLED)("opencode-clm robustness", () => {
	test("an explicit mirrorDir that cannot be created: the session uses the project default, and the model can edit there", async () => {
		const c = new Case("robust-mirror-dir", steps(
			bash("echo FALLBACK_$((3+4))", "fallback"),
			(request: { mirrorPath?: string }) => bash(mirrorEdit(request.mirrorPath!, `"FALLBACK_" + str(3 + 4)`, "replace", `"[note: SHORTENED_" + "OUTPUT]"`), "Rewrite"),
			text("E2E_DONE"),
		), { plugin: { mirrorDir: "blocked/mirrors" } });
		writeFileSync(join(c.project, "blocked"), "a file, not a directory");
		await c.run(["Run the e2e script."]);
		const main = c.mock.main();
		expect(main).toHaveLength(3);
		const fallback = join(c.project, ".opencode", "clm");
		for (const request of main) expect(request.mirrorPath?.startsWith(`${fallback}/clm-`)).toBe(true);
		// The second request's mirror shows the first step's tool result.
		expect(main[1]!.mirrorText).toContain("FALLBACK_7");
		// The model's edit inside the project went through without a permission refusal.
		expect(toolTexts(main[2]!).some((value) => value.includes("[CLM] Mirror edit valid"))).toBe(true);
		const sessionDir = main[0]!.mirrorPath!.replace(/\/LIVE_CONTEXT\.md$/, "");
		expect(JSON.parse(readFileSync(join(sessionDir, "state.json"), "utf8")).revision).toBe(1);
	}, CASE_TIMEOUT_MS);
});
