// Session lifecycle tests, ported from the earlier private OpenCode port's
// test/session.test.ts and extended for the block 8 requirements.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ClmSession, lastProviderReported, pinnedCount } from "../src/clm.ts";
import { AnnotationStore } from "../src/continuity.ts";
import { loadLiveContextState, saveLiveContextState, statePath } from "../src/state.ts";
import { statusText } from "../src/presentation.ts";
import { assistant, conversation, SESSION, settings, toolOutput, user } from "./fixtures.ts";
import { blockId, replaceBody } from "./helpers.ts";

const text = (message: { parts: Array<{ type: string; text?: string }> } | undefined) =>
	message?.parts.filter((candidate) => candidate.type === "text").map((candidate) => candidate.text).join("\n");

/** Render once, then let `edit` rewrite the mirror text. */
async function renderAndEdit(clm: ClmSession, raw: ReturnType<typeof conversation>, edit: (mirror: string) => string) {
	await clm.transform(structuredClone(raw));
	writeFileSync(clm.mirrorPath, edit(readFileSync(clm.mirrorPath, "utf8")));
}

describe("helpers", () => {
	test("pinned prefix ends at the first user message; observed size skips failed and summary messages", () => {
		const raw = conversation();
		expect(pinnedCount(raw)).toBe(1);
		expect(pinnedCount([])).toBe(0);
		const ok = assistant("msg_a3", "x", [], 500);
		const failed = assistant("msg_a4", "y", [], 900);
		failed.info.error = { name: "APIError", data: { message: "no" } };
		const summary = assistant("msg_a5", "s", [], 700);
		summary.info.summary = true;
		expect(lastProviderReported([...raw, ok, failed, summary])).toEqual({ tokens: 500, index: 3, messageID: "msg_a3" });
	});
});

describe("session lifecycle", () => {
	test("renders the mirror, commits the model's edit, and sends the edited context next", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		expect(clm.mirrorPath).toContain(join(".opencode", "clm", `clm-${SESSION}`));
		const raw1 = conversation();
		const first = await clm.transform(structuredClone(raw1));
		expect(first.messages.map((message) => message.info.id)).toEqual(["msg_u1", "msg_a1", "msg_a2"]);
		const mirror = readFileSync(clm.mirrorPath, "utf8");
		expect(mirror).not.toContain("Inspect the repository"); // the task is pinned outside the mirror
		expect(mirror).toContain("big output");

		const id = blockId(clm.baseline!.snapshot, "toolResult", 0);
		writeFileSync(clm.mirrorPath, replaceBody(mirror, id, "[summary: 400 x's]"));
		expect(clm.receipt("bash", { command: `python3 edit.py > ${clm.mirrorPath}` }, "/")).toStartWith("[CLM] Mirror edit valid");

		const raw2 = [...structuredClone(raw1), assistant("msg_a3", "Next step.", [{ callID: "call_3", output: "new output" }])];
		const second = await clm.transform(raw2);
		expect(second.notices.join("\n")).toContain("Applied revision 1");
		expect(toolOutput(second.messages[1], "call_1")).toBe("[summary: 400 x's]");
		expect(second.messages[3]).toBe(raw2[3]!); // the raw suffix passes through untouched
		expect(second.messages.at(-1)!.parts[0]!.synthetic).toBe(true); // notices travel as one user note
		expect(toolOutput(raw2[1], "call_1")).toStartWith("big output");
		const mirror2 = readFileSync(clm.mirrorPath, "utf8");
		expect(mirror2).toContain("revision=1");
		expect(mirror2).toContain("[summary: 400 x's]");
		expect(mirror2).toContain("new output");
		expect(existsSync(join(clm.store.directory, "revisions", "r1.md"))).toBe(true);
		expect(clm.state.checkpoint!.sourceIds).toEqual(["msg_a1", "msg_a1", "msg_a1", "msg_a2"]);

		// A new session object for the same id restores the revision from disk.
		const resumed = await ClmSession.open(SESSION, clm.settings);
		expect(resumed.state.revision).toBe(1);
		const third = await resumed.transform(structuredClone(raw2));
		expect(toolOutput(third.messages[1], "call_1")).toBe("[summary: 400 x's]");
		expect(third.notices.join("\n")).not.toContain("dropped");
	});

	test("a second edit on top of an active revision is saved and survives a reload", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const raw1 = conversation();
		await renderAndEdit(clm, raw1, (mirror) => replaceBody(mirror, blockId(clm.baseline!.snapshot, "toolResult", 0), "first"));
		const raw2 = [...structuredClone(raw1), assistant("msg_a3", "More.", [{ callID: "call_3", output: "y".repeat(300) }])];
		await renderAndEdit(clm, raw2, (mirror) => replaceBody(mirror, blockId(clm.baseline!.snapshot, "toolResult", 2), "second"));
		const raw3 = [...structuredClone(raw2), user("msg_u2", "next")];
		const result = await clm.transform(raw3);
		expect(result.notices.join("\n")).toContain("Applied revision 2");
		expect(toolOutput(result.messages[3], "call_3")).toBe("second");
		expect((await loadLiveContextState(clm.store.directory)).warning).toBeUndefined();
		const resumed = await ClmSession.open(SESSION, clm.settings);
		expect(resumed.state.checkpoint?.revision).toBe(2);
	});

	test("a rejected edit leaves the context unchanged and says why", async () => {
		const clm = await ClmSession.open(SESSION, settings({ gate: "shrink" }));
		const raw = conversation();
		await renderAndEdit(clm, raw, (mirror) => replaceBody(mirror, blockId(clm.baseline!.snapshot, "assistant", 1), "z".repeat(4000)));
		expect(clm.receipt("bash", { command: `sed -i s/a/b/ ${clm.mirrorPath}` }, "/")).toStartWith("[CLM] Mirror edit would be refused");
		const next = await clm.transform(structuredClone(raw));
		expect(next.notices.join("\n")).toContain("Edit rejected");
		expect(text(next.messages[2])).toBe("Found what I need.");
		expect(clm.rejected).toBe(1);
		expect(clm.state.lastOutcome?.kind).toBe("rejected");
	});

	test("the fit gate measures growth against budget − reserve in tokens", async () => {
		const clm = await ClmSession.open(SESSION, settings({ budget: 2000, reserve: 100, remindAt: "off" }));
		const raw = conversation();
		await clm.transform(structuredClone(raw));
		const limit = clm.baseline!.limit!;
		const pinned = clm.estimate([{ role: "user", content: [{ type: "text", text: "Inspect the repository and report." }] }]);
		expect(limit).toBe(1900 - pinned);
		const id = blockId(clm.baseline!.snapshot, "assistant", 1);
		writeFileSync(clm.mirrorPath, replaceBody(readFileSync(clm.mirrorPath, "utf8"), id, "g".repeat(300)));
		expect(clm.receipt("bash", { command: `sed -i x ${clm.mirrorPath}` }, "/")).toContain("grows");
		writeFileSync(clm.mirrorPath, replaceBody(readFileSync(clm.mirrorPath, "utf8"), id, "g".repeat(9000)));
		expect(clm.receipt("bash", { command: `sed -i x ${clm.mirrorPath}` }, "/")).toContain(`limit ${limit} tokens`);
	});

	test("a projection whose anchor no longer matches history is discarded", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const raw = conversation();
		await renderAndEdit(clm, raw, () => "Summary only.");
		await clm.transform(structuredClone(raw));
		expect(clm.state.checkpoint).toBeDefined();
		const compacted = [user("msg_c1", "What did we do so far?"), assistant("msg_c2", "Summary of work.")];
		const result = await clm.transform(compacted);
		expect(result.notices.join("\n")).toContain("Revision 1 was dropped");
		expect(clm.state.checkpoint).toBeUndefined();
		expect(clm.state.revision).toBe(2);
		expect(result.messages.slice(0, 2)).toEqual(compacted);
	});

	test("after a reported compaction the session rebases onto the summary: no drop note, pins kept", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const raw = conversation();
		await clm.transform(structuredClone(raw));
		const id = blockId(clm.lastSnapshot!, "toolResult", 0);
		const source = clm.blockSource(id)!;
		await new AnnotationStore(clm.store.directory).create({
			sessionId: SESSION, blockId: id, revision: source.revision, message: source.message,
			title: "keep the big output", reason: "needed later", futureAction: "quote it", retention: "pin",
		});
		writeFileSync(clm.mirrorPath, replaceBody(readFileSync(clm.mirrorPath, "utf8"), blockId(clm.baseline!.snapshot, "assistant", 1), "Done."));
		await clm.transform(structuredClone(raw));
		expect(clm.state.revision).toBe(1);

		const context = await clm.compactionContext();
		expect(context).toStartWith("CLM note for the summary:");
		expect(context).toContain("keep the big output");

		const summary = assistant("msg_c2", "Summary of work.");
		summary.info.summary = true;
		const compacted = [user("msg_c1", "What did we do so far?"), summary, user("msg_c3", "Continue.")];
		clm.compacted = true;
		const result = await clm.transform(structuredClone(compacted));
		expect(clm.compacted).toBe(false);
		expect(result.notices.join("\n")).not.toContain("dropped");
		expect(clm.state.revision).toBe(2);
		expect(clm.state.checkpoint).toBeUndefined();
		expect(clm.state.lastOutcome?.kind).toBe("compacted");
		expect(readFileSync(clm.mirrorPath, "utf8")).toContain("revision=2");
		expect(readFileSync(clm.mirrorPath, "utf8")).toContain("Summary of work.");
		const continuity = result.messages.map(text).find((candidate) => candidate?.includes("[CLM CONTINUITY"));
		expect(continuity).toContain("keep the big output");
		expect(continuity).toContain("<clm-pinned-source>");
		const events = readFileSync(join(clm.store.directory, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(events.filter((event) => event.event === "compacted")).toMatchObject([{ revision: 2, previous: 1, summary: "msg_c2" }]);
		expect(events.some((event) => event.event === "projection-reset")).toBe(false);

		// Edits continue from the rebased baseline.
		writeFileSync(clm.mirrorPath, replaceBody(readFileSync(clm.mirrorPath, "utf8"), blockId(clm.baseline!.snapshot, "assistant", 0), "Short summary."));
		const next = await clm.transform(structuredClone(compacted));
		expect(next.notices.join("\n")).toContain("Applied revision 3");

		// A stale compaction signal does not hide a later history change.
		clm.compacted = true;
		const reverted = await clm.transform([user("msg_r1", "Start over.")]);
		expect(reverted.notices.join("\n")).toContain("Revision 3 was dropped");
	});

	test("OpenCode prune of an old tool output keeps the accepted revision", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const raw = conversation();
		await renderAndEdit(clm, raw, (mirror) => replaceBody(mirror, blockId(clm.baseline!.snapshot, "assistant", 1), "Done."));
		await clm.transform(structuredClone(raw));
		const pruned = structuredClone(raw);
		pruned[1]!.parts.find((candidate) => candidate.callID === "call_1")!.state.time.compacted = 10;
		const result = await clm.transform(pruned);
		expect(result.notices.join("\n")).not.toContain("dropped");
		expect(text(result.messages[2])).toBe("Done.");
		// The request carries the revision's text, as the mirror does, not OpenCode's placeholder.
		expect(toolOutput(result.messages[1], "call_1")).toStartWith("big output");
		expect(result.messages[1]!.parts.find((candidate) => candidate.callID === "call_1")!.state.time.compacted).toBeUndefined();
		expect(readFileSync(clm.mirrorPath, "utf8")).toContain("big output");
		expect(pruned[1]!.parts.find((candidate) => candidate.callID === "call_1")!.state.time.compacted).toBe(10); // raw untouched
	});

	test("toggling the reasoning view keeps the checkpoint (flattening ignores settings)", async () => {
		const project = settings();
		const clm = await ClmSession.open(SESSION, project);
		const raw = conversation();
		raw[2]!.parts.splice(1, 0, { id: "prt_r", sessionID: SESSION, messageID: "msg_a2", type: "reasoning", text: "hmm", time: { start: 1 } });
		await renderAndEdit(clm, raw, (mirror) => replaceBody(mirror, blockId(clm.baseline!.snapshot, "toolResult", 1), "tiny"));
		await clm.transform(structuredClone(raw));
		const hidden = await ClmSession.open(SESSION, { ...project, reasoning: false });
		const result = await hidden.transform(structuredClone(raw));
		expect(hidden.state.checkpoint?.revision).toBe(1);
		expect(result.notices.join("\n")).not.toContain("dropped");
		expect(readFileSync(hidden.mirrorPath, "utf8")).not.toContain("hmm");
		expect(result.messages[2]!.parts.some((candidate) => candidate.type === "reasoning")).toBe(true); // raw goes out
	});

	test("budget notices fire as the conversation grows, at most once per tier", async () => {
		const clm = await ClmSession.open(SESSION, settings({ budget: 2000, reserve: 100, guard: "off" }));
		const small = await clm.transform(conversation("x".repeat(100)));
		expect(small.notices).toHaveLength(0);
		const half = await clm.transform(conversation("x".repeat(4000)));
		expect(half.notices.join("\n")).toContain("[CLM BUDGET] Context crossed 50% of a 2,000-token budget");
		expect(half.reading?.estimateExcludes).toBe("the system prompt and tool schemas");
		const again = await clm.transform(conversation("x".repeat(4000)));
		expect(again.notices).toHaveLength(0);
	});

	test("with the guard off the budget notice does not describe the overflow guard", async () => {
		const clm = await ClmSession.open(SESSION, settings({ budget: 2000, reserve: 100, guard: "off" }));
		const result = await clm.transform(conversation("x".repeat(7400)));
		expect(result.notices.join("\n")).toContain("[CLM BUDGET]");
		expect(result.notices.join("\n")).not.toContain("overflow guard");
	});

	test("known system prompt and tool schema sizes count in the reading, guard and fit gate", async () => {
		const raw = conversation("x".repeat(2000));
		const bare = await ClmSession.open(SESSION, settings({ budget: 4000, reserve: 100, remindAt: "off" }));
		const without = await bare.transform(structuredClone(raw));
		const bareLimit = bare.baseline!.limit!;
		expect(toolOutput(without.messages[1], "call_1")).toStartWith("big output");

		const clm = await ClmSession.open(SESSION, settings({ budget: 4000, reserve: 100, remindAt: "off" }));
		clm.scope = { systemTokens: 1500 };
		const partial = await clm.transform(structuredClone(raw));
		expect(partial.reading?.estimateExcludes).toBe("tool schemas");
		expect(partial.reading!.estimated).toBe(without.reading!.estimated + 1500);
		expect(clm.baseline!.limit).toBe(bareLimit - 1500);

		clm.scope = { systemTokens: 1500, toolTokens: 2000 };
		const full = await clm.transform(structuredClone(raw));
		expect(full.reading?.estimateExcludes).toBeUndefined();
		// 3,500 fixed tokens leave no room for the 500-token output under the 3,900 limit.
		expect(String(toolOutput(full.messages[1], "call_1"))).toStartWith("[clm overflow guard] bash#call_1");
	});

	test("the model output limit shrinks the budget and the notice names the guard limit", async () => {
		const clm = await ClmSession.open(SESSION, settings({ budget: "window", reserve: 100 }));
		clm.limits = { context: 3000, output: 1000 };
		const result = await clm.transform(conversation("x".repeat(7000)));
		expect(clm.lastReading?.budget).toBe(2000);
		expect(result.notices.join("\n")).toContain("Above 1,900 tokens the overflow guard");
	});

	test("the overflow guard withholds the oldest new tool output above the limit", async () => {
		const clm = await ClmSession.open(SESSION, settings({ budget: 1500, reserve: 100, remindAt: "off" }));
		const result = await clm.transform(conversation("x".repeat(20000)));
		expect(result.notices.join("\n")).toContain("Overflow guard");
		const output = String(toolOutput(result.messages[1], "call_1"));
		expect(output).toStartWith("[clm overflow guard] bash#call_1");
		const file = /Full text: (\S+)/.exec(output)![1]!;
		expect(readFileSync(file, "utf8")).toStartWith("big output");
		expect(readFileSync(clm.mirrorPath, "utf8")).not.toContain("x".repeat(100));
	});

	test("the observation cap shortens tool output in the request and the mirror only", async () => {
		const clm = await ClmSession.open(SESSION, settings({ observationCap: "500" }));
		const raw = conversation("x".repeat(5000));
		const result = await clm.transform(structuredClone(raw));
		const output = String(toolOutput(result.messages[1], "call_1"));
		expect(output.length).toBeLessThan(800);
		expect(output).toContain("[clm observation cap: 500 of");
		expect(toolOutput(result.messages[1], "call_2")).toBe("small output");
		expect(readFileSync(clm.mirrorPath, "utf8")).not.toContain("x".repeat(600));
	});

	test("during OpenCode compaction the projection is applied but nothing is committed or rendered", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const raw = conversation();
		await renderAndEdit(clm, raw, (mirror) => replaceBody(mirror, blockId(clm.baseline!.snapshot, "toolResult", 0), "short"));
		await clm.transform(structuredClone(raw));
		const before = readFileSync(clm.mirrorPath, "utf8");
		writeFileSync(clm.mirrorPath, "an edit that must not be committed");
		clm.compacting = true;
		const result = await clm.transform(structuredClone(raw));
		expect(result.notices).toHaveLength(0);
		expect(toolOutput(result.messages[1], "call_1")).toBe("short");
		expect(clm.state.revision).toBe(1);
		writeFileSync(clm.mirrorPath, before);
		// A head slice shorter than the checkpoint is passed through and nothing is reset.
		clm.compacting = true;
		const head = structuredClone(raw.slice(0, 2));
		expect((await clm.transform(head)).messages).toBe(head);
		expect(clm.state.checkpoint?.revision).toBe(1);
	});

	test("disabled sessions pass the history through", async () => {
		const clm = await ClmSession.open(SESSION, settings({ enabled: false }));
		const raw = conversation();
		expect((await clm.transform(raw)).messages).toBe(raw);
		expect(existsSync(clm.mirrorPath)).toBe(false);
	});

	test("continuity annotations ride after the conversation, outside the mirror", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const raw = conversation();
		await clm.transform(structuredClone(raw));
		const id = blockId(clm.lastSnapshot!, "toolResult", 1);
		const source = clm.blockSource(id)!;
		await new AnnotationStore(clm.store.directory).create({
			sessionId: SESSION, blockId: id, revision: source.revision, message: source.message,
			title: "keep the small output", reason: "needed later", futureAction: "quote it", retention: "continuity",
		});
		const result = await clm.transform(structuredClone(raw));
		expect(text(result.messages.at(-1))).toContain("keep the small output");
		expect(readFileSync(clm.mirrorPath, "utf8")).not.toContain("keep the small output");
	});
});

describe("estimates and persistence", () => {
	test("calibration needs the system prompt and tool sizes", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const raw = conversation();
		await clm.transform(structuredClone(raw));
		await clm.transform([...structuredClone(raw), assistant("msg_a3", "ok", [], 100000)]);
		expect(clm.calibrator.sampleCount).toBe(0);

		const scoped = await ClmSession.open(SESSION, settings());
		scoped.scope = { systemTokens: 1000, toolTokens: 500 };
		await scoped.transform(structuredClone(raw));
		await scoped.transform([...structuredClone(raw), assistant("msg_a3", "ok", [], 3200)]);
		expect(scoped.calibrator.sampleCount).toBe(1);
		expect(scoped.calibrator.factor).toBeGreaterThan(1.5);
	});

	test("saves are serialized: the newest state is the one on disk", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		await Promise.all([clm.setEnabled(false), clm.setEnabled(true), clm.setEnabled(false), clm.resetProjection("test")]);
		const loaded = await loadLiveContextState(clm.store.directory);
		expect(loaded.state).toEqual(clm.state);
		expect(loaded.state.enabled).toBe(false);
		expect(loaded.state.revision).toBe(1);
	});

	test("the document id does not repeat after a corrupt state file resets the revision", async () => {
		const project = settings();
		const clm = await ClmSession.open(SESSION, project);
		await clm.transform(conversation());
		const firstId = clm.lastSnapshot!.documentId;
		writeFileSync(statePath(clm.store.directory), "{ not json");
		const reopened = await ClmSession.open(SESSION, project);
		expect(reopened.loadWarning).toContain("not valid JSON");
		await reopened.transform(conversation());
		expect(reopened.lastSnapshot!.revision).toBe(0);
		expect(reopened.lastSnapshot!.documentId).not.toBe(firstId);
	});

	test("status reflects the session", async () => {
		const clm = await ClmSession.open(SESSION, settings({ budget: 4000 }));
		await saveLiveContextState(clm.store.directory, clm.state);
		await clm.transform(conversation());
		const status = statusText(clm.status());
		expect(status).toContain(`CLM status for session ${SESSION}`);
		expect(status).toContain("no accepted edit");
		expect(status).toContain("last request: 3 raw messages → 3 sent");
	});

	test("session ids that would alias another directory are refused", async () => {
		await expect(ClmSession.open("../x", settings())).rejects.toThrow("Invalid session id");
		await expect(ClmSession.open("a/b", settings())).rejects.toThrow("Invalid session id");
	});
});

describe("edit receipt", () => {
	test("names the blocks an edit touched and flags growth; reads get no receipt", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		await clm.transform(conversation());
		const mirror = readFileSync(clm.mirrorPath, "utf8");
		expect(clm.receipt("bash", { command: `python3 x > ${clm.mirrorPath}` }, "/")).toStartWith("[CLM] Mirror unchanged");
		writeFileSync(clm.mirrorPath, replaceBody(mirror, blockId(clm.baseline!.snapshot, "toolResult", 1), "y".repeat(800)));
		const receipt = clm.receipt("bash", { command: `python3 x > ${clm.mirrorPath}` }, "/")!;
		expect(receipt).toContain("blocks 3 toolResult edited");
		expect(receipt).toContain("grows");
		expect(clm.receipt("bash", { command: `grep -n CTX ${clm.mirrorPath}` }, "/")).toBeUndefined();
		expect(clm.receipt("bash", { command: "ls" }, "/")).toBeUndefined();
	});
});

describe("budget-too-small check", () => {
	const events = (clm: ClmSession) =>
		readFileSync(join(clm.store.directory, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	/** Request 1, then request 2 after a reply the provider measured at `observed` input tokens. */
	const measuredRaw = (observed: number) => [...conversation(), assistant("msg_a3", "ok", [], observed)];

	test("a small budget is raised once: event, notice and alert on the measuring request only; it survives a restart", async () => {
		const options = settings({ budget: 12_000 });
		const clm = await ClmSession.open(SESSION, options);
		const first = await clm.transform(conversation());
		expect(first.alert).toBeUndefined();
		expect(clm.state.budgetCheck).toBeUndefined();

		const second = await clm.transform(measuredRaw(18_000));
		const check = clm.state.budgetCheck!;
		expect(check.source).toBe("provider");
		// Provider count minus the first request's conversation estimate.
		expect(check.overhead).toBeGreaterThan(17_000);
		expect(check.overhead).toBeLessThan(18_000);
		expect(check).toMatchObject({ configured: 12_000, reserve: 2048, raised: true, effective: check.overhead + 8000 + 2048 });
		expect(second.alert).toContain("Budget 12,000 is too small");
		expect(second.notices.filter((notice) => notice.includes("is too small for this session"))).toHaveLength(1);
		expect(second.reading).toMatchObject({ budget: check.effective, raisedFrom: 12_000 });
		expect(statusText(clm.status())).toContain(`effective budget ${check.effective.toLocaleString("en-US")} tok (raised`);

		const third = await clm.transform([...measuredRaw(18_000), assistant("msg_a4", "more", [], 18_500)]);
		expect(third.alert).toBeUndefined();
		expect(third.notices.join("\n")).not.toContain("too small");
		expect(events(clm).filter((event) => event.event === "budget-too-small")).toHaveLength(1);

		// Restart: the persisted check keeps the raise and is not repeated.
		const reopened = await ClmSession.open(SESSION, options);
		expect(reopened.state.budgetCheck).toEqual(check);
		expect(reopened.resolvedBudget()).toMatchObject({ budget: check.effective, raisedFrom: 12_000 });
		await reopened.transform(measuredRaw(18_000));
		const after = await reopened.transform([...measuredRaw(18_000), assistant("msg_a4", "more", [], 18_500)]);
		expect(after.alert).toBeUndefined();
		expect(after.reading?.budget).toBe(check.effective);
		expect(events(reopened).filter((event) => event.event === "budget-too-small")).toHaveLength(1);
	});

	test("an accepted edit and a reset keep the check", async () => {
		const clm = await ClmSession.open(SESSION, settings({ budget: 12_000 }));
		await clm.transform(conversation());
		await clm.transform(measuredRaw(18_000));
		const check = clm.state.budgetCheck;
		writeFileSync(clm.mirrorPath, replaceBody(readFileSync(clm.mirrorPath, "utf8"), blockId(clm.baseline!.snapshot, "toolResult", 0), "short"));
		const applied = await clm.transform(measuredRaw(18_000));
		expect(applied.notices.join("\n")).toContain("Applied revision 1");
		expect(clm.state.budgetCheck).toEqual(check!);
		await clm.resetProjection("test");
		expect(clm.state.budgetCheck).toEqual(check!);
	});

	test("an adequate budget is not raised and gets no notice", async () => {
		const clm = await ClmSession.open(SESSION, settings({ budget: 64_000 }));
		await clm.transform(conversation());
		const second = await clm.transform(measuredRaw(18_000));
		expect(second.alert).toBeUndefined();
		expect(second.notices.join("\n")).not.toContain("too small");
		expect(clm.state.budgetCheck).toMatchObject({ raised: false, effective: 64_000, source: "provider" });
		expect(second.reading?.budget).toBe(64_000);
		expect(second.reading?.raisedFrom).toBeUndefined();
		expect(events(clm).map((event) => event.event)).toContain("budget-check");
		expect(events(clm).map((event) => event.event)).not.toContain("budget-too-small");
		const status = statusText(clm.status());
		expect(status).toContain("fixed overhead (system prompt + tool schemas)");
		expect(status).not.toContain("effective budget");
	});

	test("without a provider count the hook estimate measures the overhead", async () => {
		const clm = await ClmSession.open(SESSION, settings({ budget: 12_000 }));
		clm.scope = { systemTokens: 9000, toolTokens: 6000 };
		await clm.transform(conversation());
		// The same history again: no reply yet, so nothing is measured.
		await clm.transform(conversation());
		expect(clm.state.budgetCheck).toBeUndefined();
		const second = await clm.transform(measuredRaw(0));
		expect(clm.state.budgetCheck).toMatchObject({ source: "estimate", overhead: 15_000, raised: true, effective: 15_000 + 8000 + 2048 });
		expect(second.alert).toContain("too small");

		// The first provider count replaces the estimate; the warning is not repeated.
		const third = await clm.transform([...measuredRaw(0), assistant("msg_a4", "more", [], 20_000)]);
		expect(clm.state.budgetCheck?.source).toBe("provider");
		expect(clm.state.budgetCheck!.overhead).toBeGreaterThan(19_000);
		expect(third.alert).toBeUndefined();
		expect(third.notices.join("\n")).not.toContain("too small");
		expect(clm.resolvedBudget()?.budget).toBe(clm.state.budgetCheck!.overhead + 8000 + 2048);
		expect(events(clm).filter((event) => event.event === "budget-too-small")).toHaveLength(1);
		expect(events(clm).find((event) => event.replaces === "estimate")).toMatchObject({ event: "budget-check", previousOverhead: 15_000 });
	});

	test("a long conversation is not measured: its estimate error would land in the overhead", async () => {
		// Guard off, so the 10,000-token output is sent rather than withheld.
		const clm = await ClmSession.open(SESSION, settings({ budget: 12_000, guard: "off" }));
		// About 10,000 estimated tokens of conversation against a provider count of 20,000.
		await clm.transform(conversation("x".repeat(40_000)));
		await clm.transform([...conversation("x".repeat(40_000)), assistant("msg_a3", "ok", [], 20_000)]);
		expect(clm.state.budgetCheck).toBeUndefined();
	});

	test("a tool result withheld at the configured budget is delivered after the raise", async () => {
		// Hook sizes as in OpenCode: the system prompt is sized, the built-in tool schemas only
		// partly, so the provider reports more than the 12,000 estimated. Request 2 adds a
		// ~4,000-token tool result: no room under 12,000 − 2,048, room under the raised limit.
		const scope = { systemTokens: 9000, toolTokens: 3000 };
		const big = (tokens: number) => [
			...conversation(),
			assistant("msg_a3", "Reading.", [{ callID: "call_big", output: "y".repeat(16_000) }], tokens),
		];
		const control = await ClmSession.open(SESSION, settings({ budget: 12_000 }));
		control.scope = scope;
		const starved = await control.transform(big(0)); // a first request: nothing measured yet
		expect(String(toolOutput(starved.messages[3], "call_big"))).toStartWith("[clm overflow guard]");
		expect(events(control).map((event) => event.event)).toContain("overflow-guard");

		const clm = await ClmSession.open(SESSION, settings({ budget: 12_000 }));
		clm.scope = scope;
		await clm.transform(conversation());
		const fed = await clm.transform(big(18_000));
		expect(clm.state.budgetCheck?.raised).toBe(true);
		expect(String(toolOutput(fed.messages[3], "call_big"))).toBe("y".repeat(16_000));
		// Request 1 ran at the configured budget; nothing is withheld once the raise applies.
		const names = events(clm).map((event) => event.event);
		expect(names.slice(names.indexOf("budget-too-small"))).not.toContain("overflow-guard");
	});
});
