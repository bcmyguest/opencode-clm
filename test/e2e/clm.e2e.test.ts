/**
 * Integration tests: the real `opencode` binary (1.18.34; OPENCODE_BIN overrides) with this
 * plugin, against a scripted OpenAI-compatible mock (mock-server.ts). No GPU, no model.
 *
 * Gated: runs only with OPENCODE_CLM_E2E=1 (`bun run test:e2e`). All opencode state goes to
 * temp HOME/XDG directories (harness.ts); each case gets its own project, data dir, mirror
 * dir and mock on an OS-assigned 127.0.0.1 port. HOME, XDG_CONFIG_HOME and XDG_CACHE_HOME
 * are shared, so the npm install of `@opencode-ai/plugin` that opencode performs on first
 * start happens once per test process. That install needs the npm registry; if opencode
 * never reaches the mock, the case fails with the reason and the stderr tail.
 *
 * Literals the assertions look for are built by concatenation or arithmetic inside the
 * scripted commands, so a request never contains them merely because it carries the
 * command text.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
	Case,
	CASE_TIMEOUT_MS,
	cleanup,
	conversation,
	ENABLED,
	mirrorEdit,
	mirrorRevision,
	PLUGIN,
	SKILLS_DIR,
	toolTexts,
	userTexts,
} from "./harness.ts";
import { bash, COMPACTION_SUMMARY, SCRIPT_EXHAUSTED, steps, text } from "./mock-server.ts";

afterAll(cleanup);

/** Printed by `MARKER_COMMAND`; the command text itself never contains it. */
const MARKER = "ALPHA_42_OUTPUT";
const MARKER_COMMAND = "echo ALPHA_$((6*7))_OUTPUT";
const MARKER_PY = `"ALPHA_" + str(6 * 7) + "_OUTPUT"`;
/** What the accepted edit writes in place of the marker's tool result. */
const REPLACEMENT = "[note: REPLACED_BETA the echo printed the marker]";
const REPLACEMENT_PY = `"[note: REPLACED_" + "BETA the echo printed the marker]"`;
const FINAL_ANSWER = "E2E_DONE";
/** Title of the pin test 6 creates. */
const PIN_TITLE = "E2E pin title";

const CTX_TURN = /^\[\[CTX_TURN /gm;

function headers(mirror: string | undefined): number {
	return mirror?.match(CTX_TURN)?.length ?? 0;
}

/** Turn 1 prints the marker, turn 2 replaces the marker's block in the mirror. */
const markerThenEdit = [
	bash(MARKER_COMMAND, "Print the marker"),
	(request: { mirrorPath?: string }) => bash(mirrorEdit(request.mirrorPath!, MARKER_PY, "replace", REPLACEMENT_PY), "Rewrite the marker block"),
] as const;

describe.skipIf(!ENABLED)("opencode-clm in opencode", () => {
	test("1. plugin loads: debug config lists /clm, /clm-compact and the skill path; debug skill lists clm-context", async () => {
		const c = new Case("load", steps());
		const config = await c.exec(["debug", "config"]);
		expect(config.code).toBe(0);
		const resolved = JSON.parse(config.stdout);
		expect(resolved.plugin?.[0]?.[0]).toBe(PLUGIN);
		expect(resolved.command?.clm?.template).toBe("Show the CLM status. $ARGUMENTS");
		expect(resolved.command?.["clm-compact"]?.template).toBe("Compact your context. $ARGUMENTS");
		expect(resolved.skills?.paths).toContain(SKILLS_DIR);

		const skills = await c.exec(["debug", "skill"]);
		expect(skills.code).toBe(0);
		const names = (JSON.parse(skills.stdout) as Array<{ name: string; location: string }>).map((skill) => skill.name);
		expect(names).toContain("clm-context");

		// Control: the same project without the plugin has neither command nor the skill.
		const bare = new Case("load-control", steps(), { withoutPlugin: true });
		const bareConfigRun = await bare.exec(["debug", "config"]);
		expect(bareConfigRun.code).toBe(0);
		const bareConfig = JSON.parse(bareConfigRun.stdout);
		expect(bareConfig.command?.clm).toBeUndefined();
		expect(bareConfig.command?.["clm-compact"]).toBeUndefined();
		const bareSkillRun = await bare.exec(["debug", "skill"]);
		expect(bareSkillRun.code).toBe(0);
		const bareSkills = (JSON.parse(bareSkillRun.stdout) as Array<{ name: string }>).map((skill) => skill.name);
		expect(bareSkills).not.toContain("clm-context");
	}, CASE_TIMEOUT_MS);

	test("1b. /clm path and /clm-compact run through command.execute.before", async () => {
		const c = new Case("commands", steps(text("PATH_SHOWN"), text("COMPACT_ACK"), text("OVERVIEW_SHOWN")), { plugin: { budget: "24000" } });
		const first = await c.run(["--command", "clm", "path"]);
		const [pathRequest] = c.mock.main();
		const mirror = pathRequest!.mirrorPath!;
		expect(mirror).toBe(join(c.sessionDir(), "LIVE_CONTEXT.md"));
		const pathUser = userTexts(pathRequest!).join("\n");
		// The template "Show the CLM status." was replaced by the plugin's text.
		expect(pathUser).toContain(`CLM mirror: ${mirror}`);
		expect(pathUser).toContain("Show the CLM text above to the user exactly as written.");
		expect(pathUser).not.toContain("Show the CLM status.");
		expect(first.stdout).toContain("PATH_SHOWN");

		await c.run(["--session", c.sessionID(), "--command", "clm-compact", "keep the build log"]);
		const compactRequest = c.mock.main()[1]!;
		const compactUser = userTexts(compactRequest).at(-1)!;
		expect(compactUser).toStartWith("Compact your live context now.");
		expect(compactUser).toContain(`\`${mirror}\``);
		expect(compactUser).toContain("(budget 24,000)");
		// opencode run quotes a multi-word argument: the template sees `"keep the build log"`.
		expect(compactUser).toMatch(/^Also: "?keep the build log"?$/m);
		expect(compactUser).not.toContain("Compact your context. keep");

		// `/clm overview` outside the TUI: the panel page as plain text.
		await c.run(["--session", c.sessionID(), "--command", "clm", "overview"]);
		const overviewUser = userTexts(c.mock.main()[2]!).join("\n");
		expect(overviewUser).toContain("CLM overview · r0");
		expect(overviewUser).toMatch(/Context size · \d+ requests?/);
		expect(overviewUser).toContain("Show the CLM text above to the user exactly as written.");
	}, CASE_TIMEOUT_MS);

	test("2. the mirror is created on the first request and re-rendered on every turn", async () => {
		const c = new Case("mirror", steps(
			bash("echo FIRST_$((1+1))", "first"),
			bash("echo SECOND_$((2+1))", "second"),
			text(FINAL_ANSWER),
		));
		await c.run(["PINNED_TASK_TEXT"]);
		const main = c.mock.main();
		expect(main.length).toBe(3);
		const [m1, m2, m3] = main.map((request) => request.mirrorText);

		// Request 1: only the pinned task exists, and it stays out of the mirror.
		expect(m1).toStartWith("[[LIVE_CONTEXT ");
		expect(mirrorRevision(m1)).toBe(0);
		expect(headers(m1)).toBe(0);
		// Request 2: the first command's call and output.
		expect(headers(m2)).toBe(2);
		expect(m2).toContain("FIRST_2");
		expect(m2).not.toContain("SECOND_3");
		// Request 3: both.
		expect(headers(m3)).toBe(4);
		expect(m3).toContain("FIRST_2");
		expect(m3).toContain("SECOND_3");
		for (const mirror of [m1, m2, m3]) expect(mirror).not.toContain("PINNED_TASK_TEXT");
		// The file on disk is the last render.
		expect(c.mirrorText()).toBe(m3!);
		expect(c.events().filter((event) => event.event === "request").map((event) => event.blocks)).toEqual([0, 2, 4]);
	}, CASE_TIMEOUT_MS);

	test("3. an accepted mirror edit reaches the next request", async () => {
		const c = new Case("edit", steps(...markerThenEdit, text(FINAL_ANSWER)), { plugin: { budget: "16k", reserve: 512 } });
		const run = await c.run(["Run the e2e script."]);
		const main = c.mock.main();
		expect(main.length).toBe(3);
		expect(main[0]!.toolResults).toBe(0);

		const sessionDir = c.sessionDir();
		expect(existsSync(join(sessionDir, "LIVE_CONTEXT.md"))).toBe(true);

		// Request 2 carried the marker output; the scripted edit targets it.
		expect(toolTexts(main[1]!)).toEqual([`${MARKER}\n`]);

		// Edit accepted: receipt in the edit's tool result, [CLM] note, state revision, revision file.
		const third = main[2]!;
		const thirdTools = toolTexts(third);
		expect(thirdTools.length).toBe(2);
		expect(thirdTools[1]).toContain("[CLM] Mirror edit valid");
		expect(userTexts(third).some((note) => note.includes("[CLM] Applied revision 1"))).toBe(true);
		const state = c.stateJson();
		expect(state.revision).toBe(1);
		expect(state.lastOutcome?.kind).toBe("applied");
		expect(existsSync(join(sessionDir, "revisions", "r1.md"))).toBe(true);
		expect(mirrorRevision(third.mirrorText)).toBe(1);

		// The marker's tool result now holds exactly the replacement; nothing else names it.
		expect(thirdTools[0]!.trim()).toBe(REPLACEMENT);
		expect(conversation(third)).not.toContain(MARKER);
		expect(third.messages.filter((m) => JSON.stringify(m).includes("REPLACED_BETA"))).toEqual([
			third.messages.find((m) => m.role === "tool")!,
		]);
		expect(run.stdout).toContain(FINAL_ANSWER);
	}, CASE_TIMEOUT_MS);

	test("4. the edit gate refuses a growing edit and the model sees why", async () => {
		const c = new Case("gate", steps(
			bash(MARKER_COMMAND, "Print the marker"),
			(request) => bash(mirrorEdit(request.mirrorPath!, MARKER_PY, "append", `"GROWN_" + "TEXT " * 200`), "Grow the marker block"),
			text(FINAL_ANSWER),
		), { plugin: { gate: "shrink" } });
		await c.run(["Run the e2e script."]);
		const main = c.mock.main();
		expect(main.length).toBe(3);

		const third = main[2]!;
		const [markerResult, editResult] = toolTexts(third);
		// tool.execute.after: the dry-run verdict is appended to the edit command's output.
		expect(editResult).toMatch(/\[CLM\] Mirror edit would be refused: Edit refused \(gate shrink: limit = size before the edit\)\. Size \d+ -> \d+ tokens \(estimated\)\./);
		// Next transform: the commit is rejected and the note says so.
		const notes = userTexts(third).join("\n");
		expect(notes).toMatch(/\[CLM\] Edit rejected; the context is unchanged\. Edit refused \(gate shrink: limit = size before the edit\)\. Size (\d+) -> (\d+) tokens \(estimated\)\. The previous context is still in effect\./);
		const [, before, after] = notes.match(/Size (\d+) -> (\d+) tokens/)!;
		expect(Number(after)).toBeGreaterThan(Number(before));
		// The context is the stored history: marker intact, appended text nowhere.
		expect(markerResult).toBe(`${MARKER}\n`);
		expect(conversation(third)).not.toContain("GROWN_TEXT");
		expect(third.mirrorText).not.toContain("GROWN_TEXT");
		expect(mirrorRevision(third.mirrorText)).toBe(0);
		const state = c.stateJson();
		expect(state.revision).toBe(0);
		expect(state.lastOutcome?.kind).toBe("rejected");
		expect(existsSync(join(c.sessionDir(), "revisions"))).toBe(false);
	}, CASE_TIMEOUT_MS);

	test("5. budget nudges fire at the configured thresholds and go out once", async () => {
		// 40,000 characters of output per command: about 10,000 estimated tokens each.
		const big = (letter: string) => `python3 -c "print(('${letter}'*99+'\\n')*400, end='')"`;
		const c = new Case("budget", steps(
			bash(big("a"), "big output a"),
			bash(big("b"), "big output b"),
			text(FINAL_ANSWER),
		), {
			// Tiers: 50% = 12,000; budget - reserve = 22,000. Guard off: nothing is withheld.
			plugin: { budget: "24000", reserve: "2000", remindAt: "0.5", guard: "off" },
			limit: { context: 200000, output: 4096 },
		});
		await c.run(["Run the e2e script."]);
		const main = c.mock.main();
		expect(main.length).toBe(3);
		const notes = main.map((request) => userTexts(request).filter((note) => note.includes("[CLM BUDGET]")));
		const estimates = c.events().filter((event) => event.event === "request").map((event) => event.estimated as number);
		// Margins: each request lands well inside its band, so the tiers below are not luck.
		expect(estimates[0]).toBeLessThan(12_000);
		expect(estimates[1]).toBeGreaterThan(12_000);
		expect(estimates[1]).toBeLessThan(22_000);
		expect(estimates[2]).toBeGreaterThan(22_000);

		expect(notes[0]).toEqual([]);
		expect(notes[1]!.length).toBe(1);
		expect(notes[1]![0]).toStartWith("[CLM BUDGET] Context crossed 50% of a 24,000-token budget: estimated ");
		expect(notes[1]![0]).toContain("Summaries should keep what you would otherwise have to look up again.");
		expect(notes[1]![0]).toContain(c.mock.main()[1]!.mirrorPath!);
		expect(notes[2]!.length).toBe(1);
		expect(notes[2]![0]).toStartWith("[CLM BUDGET] Context is at ");
		expect(notes[2]![0]).toContain("inside the 2,000-token generation reserve");
		// Guard off: the notice does not promise withholding.
		expect(notes[2]![0]).not.toContain("overflow guard");
		// The 50% nudge was for request 2 only; it is not stored in the history.
		expect(conversation(main[2]!)).not.toContain("Context crossed 50%");
		expect(c.events().filter((event) => event.event === "budget-notice").map((event) => event.tier)).toEqual(["50%", "budget-reserve"]);
	}, CASE_TIMEOUT_MS);

	test("6. auto-compaction: the summary carries the revision and the pins; the next request rebases onto it", async () => {
		const c = new Case("compaction", steps(
			...markerThenEdit,
			// Pin the edited tool result; its title is built so the pin text is the only source.
			(request) => ({
				tools: [{
					name: "clm_annotate",
					args: {
						action: "create",
						source: /^\[\[CTX_TURN [^\n]* role=toolResult id=(\S+) /m.exec(request.mirrorText!)![1]!,
						title: PIN_TITLE,
						reason: "e2e pin",
						futureAction: "keep it",
						retention: "pin",
					},
				}],
			}),
			// Reported usage near the 32k window: opencode compacts before the next step.
			bash("echo THIRD_$((1+2))", "third", { prompt_tokens: 31_900, completion_tokens: 10 }),
			text(FINAL_ANSWER),
		), { autocompact: true, config: { compaction: { tail_turns: 0 } } });
		await c.run(["Run the e2e script."]);
		const compaction = c.mock.ofKind("compaction");
		expect(compaction.length).toBe(1);
		const main = c.mock.main();
		expect(main.length).toBe(5);
		// Revision 1 was accepted on request 3, before compaction.
		expect(mirrorRevision(main[2]!.mirrorText)).toBe(1);
		expect(mirrorRevision(main[3]!.mirrorText)).toBe(1);
		// The compaction request follows request 4 and precedes request 5.
		expect(compaction[0]!.n).toBeGreaterThan(main[3]!.n);
		expect(compaction[0]!.n).toBeLessThan(main[4]!.n);

		// opencode serializes the transformed head into the compaction prompt: it carries the
		// edited context (replacement, no marker), the later turn, no CLM notice, and the
		// plugin's instruction to keep the pin verbatim.
		const input = conversation(compaction[0]!);
		expect(input).toContain("REPLACED_BETA");
		expect(input).toContain("THIRD_3");
		expect(input).not.toContain(MARKER);
		expect(input).not.toContain("[CLM] Applied revision");
		expect(input).not.toContain("[CLM BUDGET]");
		expect(input).toContain("CLM note for the summary:");
		expect(input).toContain(PIN_TITLE);
		// The compaction transform neither commits, renders nor counts a request.
		expect(c.events().filter((event) => event.event === "request").length).toBe(main.length);

		// Request 5 rebases onto the summary: next revision number, no drop note, the pin kept.
		const after = main[4]!;
		expect(mirrorRevision(after.mirrorText)).toBe(2);
		expect(after.mirrorText).toContain(COMPACTION_SUMMARY);
		expect(conversation(after)).toContain(COMPACTION_SUMMARY);
		const notes = userTexts(after).join("\n");
		expect(notes).not.toContain("was dropped");
		expect(notes).toContain("[CLM CONTINUITY");
		expect(notes).toContain(PIN_TITLE);
		expect(notes).toContain("<clm-pinned-source>");
		expect(notes).toContain("REPLACED_BETA");
		expect(c.stateJson().lastOutcome?.kind).toBe("compacted");
		expect(c.events().filter((event) => event.event === "compacted")).toMatchObject([{ revision: 2, previous: 1 }]);
		expect(c.events().some((event) => event.event === "projection-reset")).toBe(false);
	}, CASE_TIMEOUT_MS);

	test("7. tool.execute.after: receipts on mirror writes only, stored in the tool output", async () => {
		const c = new Case("receipts", steps(
			bash(MARKER_COMMAND, "Print the marker"),
			(request) => bash(`head -n 1 "${request.mirrorPath}"`, "Read the mirror header"),
			(request) => bash(`python3 - "${request.mirrorPath}" <<'PY'\nimport sys\np = sys.argv[1]\nt = open(p).read()\nopen(p, "w").write(t)\nPY`, "Rewrite the mirror unchanged"),
			(request) => bash(mirrorEdit(request.mirrorPath!, MARKER_PY, "replace", REPLACEMENT_PY), "Rewrite the marker block"),
			text(FINAL_ANSWER),
		));
		await c.run(["Run the e2e script."]);
		const main = c.mock.main();
		expect(main.length).toBe(5);
		const results = toolTexts(main[4]!);
		expect(results.length).toBe(4);
		const [plain, read, unchanged, edited] = results;
		// No mirror reference: untouched. Read-only reference: untouched.
		expect(plain).not.toContain("[CLM]");
		expect(read).toStartWith("[[LIVE_CONTEXT ");
		expect(read).not.toContain("[CLM]");
		// Write with identical content, then a real edit.
		expect(unchanged).toContain("[CLM] Mirror unchanged: the file still matches the last render.");
		expect(edited).toMatch(/\[CLM\] Mirror edit valid: about \d+ → \d+ tokens; blocks 2 toolResult edited\.( The context grows with this edit\.)? It applies from your next request\./);
		// Stored by opencode: request 4 (no accepted revision yet) still carries the
		// unchanged-receipt in the raw tool output, which the transform does not add.
		expect(toolTexts(main[3]!)[2]).toContain("[CLM] Mirror unchanged");
		expect(c.events().filter((event) => event.event === "accepted").length).toBe(1);
	}, CASE_TIMEOUT_MS);

	test("7b. observation cap: an oversized tool result reaches the model capped", async () => {
		const command = `python3 -c "print('HEAD_' + 'x'*3000 + 'MIDDLE_' + 'MARK' + 'y'*3000 + 'TAIL_' + 'END')"`;
		const c = new Case("cap", steps(bash(command, "big output"), text(FINAL_ANSWER)), { plugin: { observationCap: "1000" } });
		await c.run(["Run the e2e script."]);
		const [result] = toolTexts(c.mock.main()[1]!);
		expect(result).toStartWith("HEAD_");
		expect(result).toContain("TAIL_END");
		expect(result).not.toContain("MIDDLE_MARK");
		expect(result).toContain("[clm observation cap: 1,000 of 6,");
		expect(result!.length).toBeLessThan(1_400);
		expect(c.mock.main()[1]!.mirrorText).not.toContain("MIDDLE_MARK");
	}, CASE_TIMEOUT_MS);

	test("8. a second opencode process resumes the session: revision, mirror and state carry over", async () => {
		const c = new Case("restart", steps(...markerThenEdit, text(FINAL_ANSWER), text("E2E_SECOND"), text("STATUS_SHOWN")));
		await c.run(["Run the e2e script."]);
		expect(c.stateJson().revision).toBe(1);
		const id = c.sessionID();
		const firstRunMain = c.mock.main().length;
		expect(firstRunMain).toBe(3);

		const second = await c.run(["--session", id, "SECOND_PROMPT"]);
		expect(second.stdout).toContain("E2E_SECOND");
		const resumed = c.mock.main()[3]!;
		// Same session dir, same revision: the new process applied the saved checkpoint.
		expect(c.sessionID()).toBe(id);
		expect(mirrorRevision(resumed.mirrorText)).toBe(1);
		expect(resumed.mirrorText).toContain("REPLACED_BETA");
		expect(resumed.mirrorText).not.toContain(MARKER);
		expect(toolTexts(resumed)[0]!.trim()).toBe(REPLACEMENT);
		expect(conversation(resumed)).not.toContain(MARKER);
		expect(userTexts(resumed)).toContain("SECOND_PROMPT");
		expect(conversation(resumed)).not.toContain("was dropped");
		expect(c.stateJson().revision).toBe(1);

		// /clm status in a third process reports the persisted revision.
		await c.run(["--session", id, "--command", "clm", "status"]);
		const status = userTexts(c.mock.main()[4]!).at(-1)!;
		expect(status).toContain(`CLM status for session ${id}`);
		expect(status).toMatch(/^revision 1 · /m);
		expect(conversation(c.mock.main()[4]!)).not.toContain(SCRIPT_EXHAUSTED);
	}, CASE_TIMEOUT_MS);
});
