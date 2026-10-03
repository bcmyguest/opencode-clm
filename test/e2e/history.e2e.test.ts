/**
 * Integration tests for the checkpoint history (clm.ts `restoreAfterMismatch`,
 * `restoreFromFork`): a revert through OpenCode's HTTP API brings back the older revision,
 * and `opencode run --session <id> --fork` carries the accepted revision into the fork.
 * Gated like clm.e2e.test.ts (OPENCODE_CLM_E2E=1).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Case, CASE_TIMEOUT_MS, cleanup, conversation, ENABLED, mirrorEdit, toolTexts, userTexts } from "./harness.ts";
import { bash, MODEL_ID, steps, text } from "./mock-server.ts";

afterAll(cleanup);

const MARKER = "ALPHA_42_OUTPUT";
const MARKER_COMMAND = "echo ALPHA_$((6*7))_OUTPUT";
const MARKER_PY = `"ALPHA_" + str(6 * 7) + "_OUTPUT"`;
const REPLACEMENT = "[note: REPLACED_BETA the echo printed the marker]";
const REPLACEMENT_PY = `"[note: REPLACED_" + "BETA the echo printed the marker]"`;
const MARKER2 = "GAMMA_56_OUTPUT";
const MARKER2_COMMAND = "echo GAMMA_$((7*8))_OUTPUT";
const MARKER2_PY = `"GAMMA_" + str(7 * 8) + "_OUTPUT"`;
const REPLACEMENT2_PY = `"[note: REPLACED_" + "DELTA]"`;

const edit = (findPy: string, withPy: string) => (request: { mirrorPath?: string }) =>
	bash(mirrorEdit(request.mirrorPath!, findPy, "replace", withPy), "Rewrite a block");

function events(directory: string): any[] {
	const path = join(directory, "events.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe.skipIf(!ENABLED)("checkpoint history in opencode", () => {
	test("a revert into revision 2's prefix restores revision 1 on the next request", async () => {
		const c = new Case("revert", steps(
			bash(MARKER_COMMAND, "Print the marker"),
			edit(MARKER_PY, REPLACEMENT_PY),
			text("A_DONE"),
			bash(MARKER2_COMMAND, "Print the second marker"),
			edit(MARKER2_PY, REPLACEMENT2_PY),
			text("B_DONE"),
			text("C_DONE"),
		), { plugin: { budget: "16k", reserve: 512 } });
		const server = await c.serve();
		try {
			const model = { providerID: "mock", modelID: MODEL_ID };
			const session = await server.request("POST", "/session", {});
			const prompt = (words: string) => server.request("POST", `/session/${session.id}/message`, { model, parts: [{ type: "text", text: words }] });
			await prompt("Step A.");
			const second = await prompt("Step B.");
			const main = c.mock.main();
			expect(main.length).toBe(6);
			expect(userTexts(main[5]!).some((note) => note.includes("[CLM] Applied revision 2"))).toBe(true);
			expect(c.stateJson().revision).toBe(2);

			// Revert to the second user message: revision 2's source includes it, revision 1's does not.
			await server.request("POST", `/session/${session.id}/revert`, { messageID: second.info.parentID });
			await prompt("Step C.");
			const after = c.mock.main();
			expect(after.length).toBe(7);
			const last = after[6]!;
			expect(toolTexts(last).map((value) => value.trim())).toContain(REPLACEMENT);
			expect(conversation(last)).not.toContain(MARKER);
			expect(conversation(last)).not.toContain(MARKER2);
			expect(conversation(last)).not.toContain("REPLACED_DELTA");
			expect(userTexts(last).some((note) => note.includes("restored revision 1"))).toBe(true);
			expect(c.stateJson().revision).toBe(3);
			expect(events(c.sessionDir()).find((event) => event.event === "restored")).toMatchObject({ revision: 3, from: 1, dropped: 2 });
		} finally {
			server.stop();
		}
	}, CASE_TIMEOUT_MS);

	test("opencode run --fork carries the accepted revision into the fork", async () => {
		const c = new Case("fork", steps(
			bash(MARKER_COMMAND, "Print the marker"),
			edit(MARKER_PY, REPLACEMENT_PY),
			text("A_DONE"),
			text("FORK_DONE"),
		), { plugin: { budget: "16k", reserve: 512 } });
		await c.run(["Run the e2e script."]);
		const origin = c.sessionID();
		expect(c.stateJson().revision).toBe(1);
		await c.run(["--session", origin, "--fork", "Continue in the fork."]);
		const main = c.mock.main();
		expect(main.length).toBe(4);
		const forked = main[3]!;
		expect(toolTexts(forked).map((value) => value.trim())).toContain(REPLACEMENT);
		expect(conversation(forked)).not.toContain(MARKER);
		expect(userTexts(forked).some((note) => note.includes(`fork of ${origin}`))).toBe(true);
		const forkDir = c.sessionDirs().find((directory) => !directory.endsWith(`clm-${origin}`));
		expect(forkDir).toBeDefined();
		expect(events(forkDir!).find((event) => event.event === "restored")).toMatchObject({ revision: 1, from: 1, origin });
	}, CASE_TIMEOUT_MS);
});
