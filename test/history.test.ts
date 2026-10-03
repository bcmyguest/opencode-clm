// Checkpoint history: restore after a revert, restore into a fork, cap, corrupt files.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import { server } from "../index.ts";
import { ClmSession } from "../src/clm.ts";
import { HISTORY_DIR, loadHistory, remapProjection, saveHistoryEntry, type HistoryEntry } from "../src/history.ts";
import type { OcMessage } from "../src/opencode.ts";
import { buildPanelModel } from "../src/panel/model.ts";
import { createProjectionCheckpoint, digestSourceContent } from "../src/projection.ts";
import { readSessionDirectory } from "../src/session-files.ts";
import { AnnotationStore, forkAnnotations, sourceContentHash } from "../src/continuity.ts";
import { assistant, conversation, SESSION, settings, tempDir, toolOutput } from "./fixtures.ts";
import { blockId, replaceBody } from "./helpers.ts";

const events = (clm: ClmSession) =>
	readFileSync(join(clm.store.directory, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

/** Render, then replace the body of the n-th tool result in the mirror. */
async function editToolResult(clm: ClmSession, raw: OcMessage[], nth: number, body: string) {
	await clm.transform(structuredClone(raw));
	const mirror = readFileSync(clm.mirrorPath, "utf8");
	writeFileSync(clm.mirrorPath, replaceBody(mirror, blockId(clm.baseline!.snapshot, "toolResult", nth), body));
}

/** r1 edits call_1 over `conversation()`; r2 edits call_3 over that plus msg_a3. */
async function twoRevisions(clm: ClmSession) {
	const raw1 = conversation();
	await editToolResult(clm, raw1, 0, "first");
	const raw2 = [...structuredClone(raw1), assistant("msg_a3", "More.", [{ callID: "call_3", output: "y".repeat(300) }])];
	await editToolResult(clm, raw2, 2, "second");
	const raw3 = [...structuredClone(raw2), assistant("msg_a4", "Done.")];
	await clm.transform(structuredClone(raw3));
	expect(clm.state.revision).toBe(2);
	expect(clm.state.checkpoint!.revision).toBe(2);
	return { raw1, raw2, raw3 };
}

/** The same history under new message ids and another session id, as `Session.fork` copies it. */
function forkOf(raw: OcMessage[], sessionID: string): OcMessage[] {
	const ids = new Map(raw.map((message, index) => [message.info.id, `msg_f${index}`]));
	return raw.map((message) => ({
		info: { ...structuredClone(message.info), id: ids.get(message.info.id)!, sessionID },
		parts: message.parts.map((part, index) => ({ ...structuredClone(part), id: `prt_f${message.info.id}_${index}`, sessionID, messageID: ids.get(message.info.id)! })),
	}));
}

describe("restore after a revert", () => {
	test("a revert into r2's prefix restores r1, which still fits, as a new revision", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const { raw1 } = await twoRevisions(clm);
		// OpenCode reverted to before msg_a3 and the user went on from there.
		const reverted = [...structuredClone(raw1), assistant("msg_a5", "Another way.")];
		const result = await clm.transform(reverted);
		expect(result.notices.join("\n")).toContain("restored revision 1, which still does, as revision 3");
		expect(result.notices.join("\n")).not.toContain("was dropped");
		expect(toolOutput(result.messages[1], "call_1")).toBe("first");
		expect(clm.state.revision).toBe(3);
		expect(clm.state.checkpoint!.revision).toBe(3);
		expect(readFileSync(clm.mirrorPath, "utf8")).toContain("first");
		const restored = events(clm).find((event) => event.event === "restored");
		expect(restored).toMatchObject({ revision: 3, from: 1, dropped: 2 });
		// The restored revision is itself in the history, and survives a reload.
		expect((await loadHistory(clm.store.directory)).entries.map((entry) => entry.checkpoint.revision)).toContain(3);
		const resumed = await ClmSession.open(SESSION, clm.settings);
		const again = await resumed.transform(structuredClone(reverted));
		expect(toolOutput(again.messages[1], "call_1")).toBe("first");
		// The panel shows it as a restore marker.
		const model = buildPanelModel(await readSessionDirectory(clm.store.directory, SESSION));
		const marker = model.timeline.markers.find((candidate) => candidate.kind === "restored");
		expect(marker).toMatchObject({ revision: 3, message: "restored r1 (revert)" });
	});

	test("nothing in the history fits: the revision is dropped as before", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const { raw1 } = await twoRevisions(clm);
		const reverted = [structuredClone(raw1[0]!), assistant("msg_a9", "Started over.")];
		const result = await clm.transform(reverted);
		expect(result.notices.join("\n")).toContain("Revision 2 was dropped");
		expect(clm.state.checkpoint).toBeUndefined();
		expect(clm.state.revision).toBe(3);
		expect(events(clm).some((event) => event.event === "restored")).toBe(false);
	});

	test("/clm reset forgets the history, so a later revert cannot bring an edit back", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const { raw1 } = await twoRevisions(clm);
		await clm.resetProjection("/clm reset");
		expect((await loadHistory(clm.store.directory)).entries).toEqual([]);
		const result = await clm.transform([...structuredClone(raw1), assistant("msg_a5", "x")]);
		expect(toolOutput(result.messages[1], "call_1")).toStartWith("big output");
	});

	test("a corrupt history file is skipped, the rest still restores", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const { raw1 } = await twoRevisions(clm);
		const directory = join(clm.store.directory, HISTORY_DIR);
		writeFileSync(join(directory, "r9.json"), "{not json");
		const r1 = JSON.parse(readFileSync(join(directory, "r1.json"), "utf8"));
		writeFileSync(join(directory, "r7.json"), JSON.stringify(r1)); // names revision 7, holds revision 1
		const result = await clm.transform([...structuredClone(raw1), assistant("msg_a5", "x")]);
		expect(toolOutput(result.messages[1], "call_1")).toBe("first");
		expect(events(clm).find((event) => event.event === "history-ignored")).toMatchObject({ files: expect.arrayContaining(["r7.json", "r9.json"]) });
	});
});

describe("history files", () => {
	const entry = (revision: number): HistoryEntry => {
		const source = [{ role: "user", content: "s", ocMessageID: "msg_1" }];
		const checkpoint = createProjectionCheckpoint({
			revision,
			sourceMessages: source,
			projectedMessages: [{ role: "user", content: `p${revision}`, ocMessageID: "msg_1" }],
			beforeEstimate: 10,
			afterEstimate: 5,
			estimateUnit: "tokens",
		});
		return { version: 1, checkpoint, contentDigest: digestSourceContent(source) };
	};

	test("keeps the newest `cap` checkpoints", async () => {
		const directory = tempDir();
		for (const revision of [1, 2, 3, 4, 5]) await saveHistoryEntry(directory, entry(revision), 3);
		expect(readdirSync(join(directory, HISTORY_DIR)).sort()).toEqual(["r3.json", "r4.json", "r5.json"]);
		expect((await loadHistory(directory)).entries.map((item) => item.checkpoint.revision)).toEqual([5, 4, 3]);
	});

	test("a missing directory is an empty history; invalid entries are reported, not thrown", async () => {
		const directory = tempDir();
		expect(await loadHistory(directory)).toEqual({ entries: [], ignored: [] });
		mkdirSync(join(directory, HISTORY_DIR));
		writeFileSync(join(directory, HISTORY_DIR, "r1.json"), JSON.stringify({ version: 1, checkpoint: { revision: 1 }, contentDigest: "x" }));
		writeFileSync(join(directory, HISTORY_DIR, "notes.txt"), "ignored silently");
		expect(await loadHistory(directory)).toEqual({ entries: [], ignored: ["r1.json"] });
	});

	test("remapProjection swaps the origin's ids for the fork's, position by position", () => {
		const checkpoint = entry(1).checkpoint;
		const projected = remapProjection(checkpoint, [{ role: "user", content: "s", ocMessageID: "msg_new" }]);
		expect(projected).toEqual([{ role: "user", content: "p1", ocMessageID: "msg_new" }]);
		expect(checkpoint.projectedMessages[0]!.ocMessageID).toBe("msg_1");
	});
});

describe("restore into a fork", () => {
	test("the fork's first request restores the origin's newest revision its history contains", async () => {
		const base = settings();
		const origin = await ClmSession.open(SESSION, base);
		const { raw2 } = await twoRevisions(origin);
		// Forked at msg_a4: the copy holds raw2 (r2's source) under new ids.
		const fork = await ClmSession.open("ses_fork", base);
		fork.forkOrigin = { sessionID: SESSION, directory: origin.store.directory };
		const forked = forkOf(raw2, "ses_fork");
		const result = await fork.transform(forked);
		expect(result.notices.join("\n")).toContain(`fork of ${SESSION}; restored its revision 2 as revision 1`);
		expect(toolOutput(result.messages[1], "call_1")).toBe("first");
		expect(toolOutput(result.messages[3], "call_3")).toBe("second");
		// Untouched blocks map back to the fork's own OpenCode objects.
		expect(result.messages[2]).toBe(forked[2]!);
		expect(fork.state.checkpoint!.sourceIds.every((id) => id.startsWith("msg_f"))).toBe(true);
		expect(events(fork).find((event) => event.event === "restored")).toMatchObject({ revision: 1, from: 2, origin: SESSION });
		// Origin state is untouched.
		expect(origin.state.revision).toBe(2);
	});

	test("a fork taken before r2's source ends gets r1; one taken before any revision gets nothing", async () => {
		const base = settings();
		const origin = await ClmSession.open(SESSION, base);
		const { raw1 } = await twoRevisions(origin);
		const early = await ClmSession.open("ses_fork1", base);
		early.forkOrigin = { sessionID: SESSION, directory: origin.store.directory };
		const one = await early.transform(forkOf(raw1, "ses_fork1"));
		expect(toolOutput(one.messages[1], "call_1")).toBe("first");
		expect(early.state.checkpoint!.revision).toBe(1);

		const none = await ClmSession.open("ses_fork2", base);
		none.forkOrigin = { sessionID: SESSION, directory: origin.store.directory };
		const result = await none.transform(forkOf(raw1.slice(0, 2), "ses_fork2"));
		expect(none.state.checkpoint).toBeUndefined();
		expect(result.notices.join("\n")).not.toContain("fork of");
	});
});

describe("annotations carried into a fork (R3)", () => {
	/** Origin with two revisions and annotations made at fixed times (ms). */
	async function annotated() {
		const base = settings();
		const origin = await ClmSession.open(SESSION, base);
		const { raw2 } = await twoRevisions(origin);
		const blocks = origin.lastSnapshot!.blocks;
		const more = blocks.find((block) => block.role === "assistant" && JSON.stringify(block.source).includes("More."))!;
		const result = blocks.find((block) => block.role === "toolResult")!;
		const at = (ms: number) => new AnnotationStore(origin.store.directory, { now: () => new Date(ms) });
		const create = (ms: number, block: typeof more, retention: "pin" | "continuity", title: string) =>
			at(ms).create({ sessionId: SESSION, blockId: block.id, revision: 2, message: block.source, title, reason: "r", futureAction: "n", retention });
		const pin = await create(2, more, "pin", "pinned");
		const kept = await create(2, result, "continuity", "kept");
		const resolvedLater = await create(2, result, "continuity", "resolved later");
		await at(10).resolve(resolvedLater.id, "done");
		const resolvedBefore = await create(2, result, "continuity", "resolved before");
		await at(3).resolve(resolvedBefore.id);
		const later = await create(10, more, "continuity", "made after the fork");
		return { base, origin, raw2, pin, kept, resolvedLater, resolvedBefore, later };
	}

	test("the fork's first request copies the annotations made up to the fork point, re-pointed at its messages", async () => {
		const { base, origin, raw2, pin, kept, resolvedLater, resolvedBefore, later } = await annotated();
		const fork = await ClmSession.open("ses_fork", base);
		// Fixture messages complete at 3 ms; the fork itself was created at 5 ms.
		fork.forkOrigin = { sessionID: SESSION, directory: origin.store.directory, created: 5 };
		const result = await fork.transform(forkOf(raw2, "ses_fork"));
		const copied = await fork.annotations.list();
		expect(copied.map((annotation) => annotation.id)).toEqual([pin.id, kept.id, resolvedLater.id, resolvedBefore.id]);
		expect(copied.map((annotation) => annotation.id)).not.toContain(later.id);
		const byId = new Map(copied.map((annotation) => [annotation.id, annotation]));
		expect(byId.get(resolvedLater.id)!.resolvedAt).toBeUndefined();
		expect(byId.get(resolvedBefore.id)!.resolvedAt).toBeDefined();
		// Sources point at the fork's copies: hash, block id and session.
		const blocks = fork.lastSnapshot!.blocks;
		const copiedPin = byId.get(pin.id)!;
		const block = blocks.find((candidate) => candidate.id === copiedPin.source.blockId)!;
		expect(block).toBeDefined();
		expect(copiedPin.source.contentHash).toBe(sourceContentHash(block.source));
		expect(copiedPin.source.contentHash).not.toBe(pin.source.contentHash);
		expect(copiedPin.source.sessionId).toBe("ses_fork");
		expect(copiedPin.source.text).toBe(pin.source.text);
		// The pin is recognised as still in the conversation, so its text is not repeated.
		const sent = JSON.stringify(result.messages);
		expect(sent).toContain(`[${pin.id}] pin: pinned`);
		expect(sent).toContain("The pinned source is still in the conversation above.");
		expect(sent).toContain(`[${kept.id}] continuity: kept`);
		expect(sent).toContain("resolved later");
		expect(sent).not.toContain("made after the fork");
		expect(events(fork).find((event) => event.event === "annotations-forked")).toMatchObject({ origin: SESSION, count: 4, mapped: 4 });
		// Recall works in the fork; the origin's file is untouched.
		expect((await fork.annotations.recall(pin.id)).text).toContain(pin.source.text);
		expect((await origin.annotations.list()).length).toBe(5);
		// Only the first request copies.
		await fork.transform(forkOf(raw2, "ses_fork"));
		expect((await fork.annotations.list()).length).toBe(4);
	});

	test("forkAnnotations: an unmatched source keeps the origin's values; no cutoff carries everything", async () => {
		const { origin, pin, later } = await annotated();
		const all = await origin.annotations.list();
		const unmatched = forkAnnotations(all, [], { sessionId: "ses_fork" });
		expect(unmatched).toHaveLength(5);
		expect(unmatched.find((annotation) => annotation.id === pin.id)!.source).toEqual(pin.source);
		expect(forkAnnotations(all, [], { sessionId: "ses_fork", cutoff: 3 }).map((annotation) => annotation.id)).not.toContain(later.id);
	});

	test("a store that already holds annotations does not import", async () => {
		const { origin } = await annotated();
		const target = new AnnotationStore(tempDir("clm-import-"));
		const all = await origin.annotations.list();
		expect(await target.importAll(all)).toBe(5);
		expect(await target.importAll(all)).toBe(0);
		expect((await target.list()).length).toBe(5);
	});
});

describe("fork stamp in OpenCode's session metadata", () => {
	async function load(metadata: Record<string, unknown> | undefined, created?: number) {
		const directory = tempDir("clm-plugin-");
		const updates: unknown[] = [];
		const input = {
			directory,
			worktree: directory,
			client: {
				tui: { showToast: async () => undefined },
				app: { log: async () => undefined },
				session: {
					get: async () => ({ data: { id: "x", metadata, ...(created !== undefined ? { time: { created } } : {}) } }),
					update: async (options: unknown) => {
						updates.push(options);
						return { data: {} };
					},
				},
			},
		} as unknown as PluginInput;
		const hooks: Hooks = await server(input, { mirrorDir: join(directory, "mirrors") });
		return { hooks, updates, directory };
	}

	async function transform(hooks: Hooks, messages: OcMessage[]) {
		await hooks["experimental.chat.messages.transform"]!({}, { messages } as never);
	}

	test("an unstamped session is stamped with its own id; other metadata keys are kept", async () => {
		const { hooks, updates } = await load({ other: 1 });
		await transform(hooks, conversation());
		expect(updates).toEqual([{ path: { id: SESSION }, body: { metadata: { other: 1, clm: { origin: SESSION } } } }]);
	});

	test("a session stamped with its own id is left alone", async () => {
		const { hooks, updates } = await load({ clm: { origin: SESSION } });
		await transform(hooks, conversation());
		expect(updates).toEqual([]);
	});

	test("a stamp naming another session restores from it and is rewritten", async () => {
		const { hooks, updates, directory } = await load({ clm: { origin: "ses_origin" } });
		// The origin's history, as the origin session would have written it.
		const base = settings({ mirrorDir: join(directory, "mirrors") });
		const origin = await ClmSession.open("ses_origin", base);
		const { raw2 } = await twoRevisions(origin);
		const forked = forkOf(raw2, SESSION);
		await transform(hooks, forked);
		expect(toolOutput(forked[1], "call_1")).toBe("first");
		expect(updates).toEqual([{ path: { id: SESSION }, body: { metadata: { clm: { origin: SESSION } } } }]);
	});

	test("the fork's creation time bounds the annotations it carries", async () => {
		const { hooks, directory } = await load({ clm: { origin: "ses_origin" } }, 5);
		const base = settings({ mirrorDir: join(directory, "mirrors") });
		const origin = await ClmSession.open("ses_origin", base);
		const { raw2 } = await twoRevisions(origin);
		const block = origin.lastSnapshot!.blocks.find((candidate) => candidate.role === "toolResult")!;
		const create = (ms: number, title: string) => new AnnotationStore(origin.store.directory, { now: () => new Date(ms) })
			.create({ sessionId: "ses_origin", blockId: block.id, revision: 2, message: block.source, title, reason: "r", futureAction: "n", retention: "continuity" });
		await create(2, "before the fork");
		await create(10, "after the fork");
		// The fork's own new prompt, created after the fork, does not move the fork point.
		const forked = [...forkOf(raw2, SESSION), { ...conversation()[0]!, info: { ...conversation()[0]!.info, id: "msg_new", time: { created: 20 } } }];
		const output = { messages: forked };
		await hooks["experimental.chat.messages.transform"]!({}, output as never);
		const sent = JSON.stringify(output.messages);
		expect(sent).toContain("before the fork");
		expect(sent).not.toContain("after the fork");
	});
});
