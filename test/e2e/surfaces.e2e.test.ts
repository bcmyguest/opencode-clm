/**
 * Parity block 6 server side against real opencode 1.18.34 and the scripted mock: `/clm
 * budget` and `/clm-compact` with a measured size. Gated like clm.e2e.test.ts (OPENCODE_CLM_E2E=1).
 */
import { afterAll, describe, expect, test } from "bun:test";

import { Case, CASE_TIMEOUT_MS, cleanup, ENABLED, userTexts } from "./harness.ts";
import { bash, steps, text } from "./mock-server.ts";

afterAll(cleanup);

describe.skipIf(!ENABLED)("opencode-clm status surfaces (server)", () => {
	test("/clm budget changes the budget; /clm-compact reports the measured size; off refuses it", async () => {
		const c = new Case("surfaces", steps(
			bash(`printf 'SIZE_%.0s' $(seq 1 3000)`, "big output"),
			text("E2E_DONE"),
			text("BUDGET_SHOWN"),
			text("COMPACT_SENT"),
			text("OFF_SHOWN"),
			text("REFUSED_SHOWN"),
		), { plugin: { budget: "16k", reserve: 512 } });
		await c.run(["Run the e2e script."]);

		await c.run(["--session", c.sessionID(), "--command", "clm", "budget", "24k"]);
		expect(userTexts(c.mock.main().at(-1)!).join("\n")).toContain("CLM Budget: 24k.");

		await c.run(["--session", c.sessionID(), "--command", "clm-compact", "keep", "the", "plan"]);
		const prompt = userTexts(c.mock.main().at(-1)!).join("\n");
		expect(prompt).toContain("Compact your live context now.");
		expect(prompt).toContain("(budget 24,000)");
		expect(prompt).toContain("keep the plan");
		// 3000 × "SIZE_" is about 15k characters, ~3,750 tokens: measured on the stored
		// history, not the old 0 of a fresh process.
		const size = Number(/next request is about ([\d,]+) tokens/.exec(prompt)?.[1]?.replace(/,/g, ""));
		expect(size).toBeGreaterThan(3_000);

		await c.run(["--session", c.sessionID(), "--command", "clm", "off"], { expectMain: false });
		await c.run(["--session", c.sessionID(), "--command", "clm-compact"], { expectMain: false });
		// With CLM off the raw history goes out (it holds the earlier prompt); the newest user
		// message is the refusal, not a compaction prompt.
		const messages = c.mock.requests.at(-1)!.messages.filter((message) => message.role === "user");
		const newest = JSON.stringify(messages.at(-1));
		expect(newest).toContain("CLM is off for this session");
		expect(newest).not.toContain("Compact your live context now.");
	}, 4 * CASE_TIMEOUT_MS);
});
