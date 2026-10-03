/**
 * M1 against real opencode and the scripted mock: neither the configured mirrorDir nor the
 * project default can be created. Gated like clm.e2e.test.ts (OPENCODE_CLM_E2E=1).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Case, CASE_TIMEOUT_MS, cleanup, ENABLED, userTexts } from "./harness.ts";
import { text } from "./mock-server.ts";

afterAll(cleanup);

describe.skipIf(!ENABLED)("opencode-clm without a mirror directory", () => {
	test("the run completes with the raw history, no protocol prompt, and a log naming both directories", async () => {
		// Every request (agent and title helper alike) gets one answer: no request is "main".
		const c = new Case("mirrorless", () => text("E2E_DONE"), { plugin: { mirrorDir: "blocked/mirrors" } });
		writeFileSync(join(c.project, "blocked"), "a file, not a directory");
		mkdirSync(join(c.project, ".opencode"), { recursive: true });
		writeFileSync(join(c.project, ".opencode", "clm"), "a file, not a directory");
		const result = await c.run(["Run the e2e script."], { expectMain: false });
		const agent = c.mock.requests.filter((request) => Array.isArray(request.body.tools) && request.body.tools.length > 0);
		expect(agent.length).toBeGreaterThan(0);
		for (const request of agent) {
			expect(request.system).not.toContain("## Editable context");
			expect(userTexts(request).join("\n")).toContain("Run the e2e script.");
			expect(JSON.stringify(request.messages)).not.toContain("[CLM]");
		}
		expect(result.stderr).toContain("no mirror directory could be used");
		expect(result.stderr).toContain(join(c.project, "blocked", "mirrors"));
		expect(result.stderr).toContain(join(c.project, ".opencode", "clm"));
		expect(result.stdout).toContain("E2E_DONE");
	}, CASE_TIMEOUT_MS);
});
