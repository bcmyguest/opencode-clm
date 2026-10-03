/**
 * The `compaction`, `one-tool` and `trailer` settings against real opencode 1.18.34 and the
 * scripted mock. Gated like clm.e2e.test.ts (OPENCODE_CLM_E2E=1).
 */
import { afterAll, describe, expect, test } from "bun:test";

import { Case, CASE_TIMEOUT_MS, cleanup, ENABLED, toolTexts } from "./harness.ts";
import { bash, steps, text } from "./mock-server.ts";

afterAll(cleanup);

/** Reported usage near the 32k window: OpenCode compacts before the next step when allowed. */
const NEAR_WINDOW = { prompt_tokens: 31_900, completion_tokens: 10 };

describe.skipIf(!ENABLED)("opencode-clm settings: compaction, one-tool, trailer", () => {
	test("compaction on: OpenCode compacts as its config allows", async () => {
		const c = new Case("setting-compaction-on", steps(
			bash("echo FIRST_$((1+1))", "first", NEAR_WINDOW),
			text("E2E_DONE"),
		), { plugin: { compaction: "on" }, autocompact: true, config: { compaction: { tail_turns: 0 } } });
		await c.run(["Run the e2e script."]);
		expect(c.mock.ofKind("compaction")).toHaveLength(1);
		expect(c.events().filter((event) => event.event === "native-compaction")).toMatchObject([{ reason: "threshold", setting: "on" }]);
	}, CASE_TIMEOUT_MS);

	test("compaction off: OpenCode does not compact although its config allows it", async () => {
		const c = new Case("setting-compaction-off", steps(
			bash("echo FIRST_$((1+1))", "first", NEAR_WINDOW),
			text("E2E_DONE"),
		), { plugin: { compaction: "off" }, autocompact: true, config: { compaction: { tail_turns: 0 } } });
		await c.run(["Run the e2e script."]);
		expect(c.mock.ofKind("compaction")).toHaveLength(0);
		expect(c.mock.main()).toHaveLength(2);
	}, CASE_TIMEOUT_MS);

	test("one-tool: the second call of a response fails; the model sees why", async () => {
		const c = new Case("setting-one-tool", steps(
			{ tools: [
				{ name: "bash", args: { command: "echo ONE_$((0+1))", description: "one" } },
				{ name: "bash", args: { command: "echo TWO_$((1+1))", description: "two" } },
			] },
			text("E2E_DONE"),
		), { plugin: { oneTool: true } });
		await c.run(["Run the e2e script."]);
		const results = toolTexts(c.mock.main()[1]!);
		expect(results).toHaveLength(2);
		expect(results.filter((result) => result.includes("ONE_1") || result.includes("TWO_2"))).toHaveLength(1);
		const blocked = results.find((result) => !result.includes("ONE_1") && !result.includes("TWO_2"))!;
		// The model-visible text of the blocked call, exactly: OpenCode adds no wrapping.
		expect(blocked).toBe("[CLM] One tool call per response (setting one-tool): this bash call was #2 in the response and did not run. Call it again on its own in your next response.");
		expect(c.events().filter((event) => event.event === "tool-blocked")).toMatchObject([{ tool: "bash", position: 2 }]);
	}, CASE_TIMEOUT_MS);

	test("trailer: the next request's tool result ends with the size line", async () => {
		const c = new Case("setting-trailer", steps(
			bash("echo TRAILED_$((2+3))", "trailed"),
			text("E2E_DONE"),
		), { plugin: { trailer: true, budget: "16k" } });
		await c.run(["Run the e2e script."]);
		const [result] = toolTexts(c.mock.main()[1]!);
		expect(result).toContain("TRAILED_5");
		expect(result).toMatch(/\n\[context: ~[\d,]+ of 16,000 tokens after this result\]$/);
	}, CASE_TIMEOUT_MS);
});
