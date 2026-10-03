// Block 4 review fixes: compaction rebase before restore, the stamp's guards and error
// path, corrupt origin history, and `/clm reset` against a pending history write.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import { server } from "../index.ts";
import { ClmSession } from "../src/clm.ts";
import { HISTORY_DIR, loadHistory, type HistoryEntry } from "../src/history.ts";
import type { OcMessage } from "../src/opencode.ts";
import { assistant, conversation, SESSION, settings, tempDir, toolOutput, user } from "./fixtures.ts";
import { blockId, replaceBody } from "./helpers.ts";

const eventsOf = (directory: string) => {
	const path = join(directory, "events.jsonl");
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
};

async function editToolResult(clm: ClmSession, raw: OcMessage[], nth: number, body: string) {
	await clm.transform(structuredClone(raw));
	writeFileSync(clm.mirrorPath, replaceBody(readFileSync(clm.mirrorPath, "utf8"), blockId(clm.baseline!.snapshot, "toolResult", nth), body));
}

/** r1 over conversation(), r2 over that plus msg_a3. */
async function twoRevisions(clm: ClmSession) {
	const raw1 = conversation();
	await editToolResult(clm, raw1, 0, "first");
	const raw2 = [...structuredClone(raw1), assistant("msg_a3", "More.", [{ callID: "call_3", output: "y".repeat(300) }])];
	await editToolResult(clm, raw2, 2, "second");
	await clm.transform([...structuredClone(raw2), assistant("msg_a4", "Done.")]);
	expect(clm.state.revision).toBe(2);
	return { raw1, raw2 };
}

function forkOf(raw: OcMessage[], sessionID: string): OcMessage[] {
	const ids = new Map(raw.map((message, index) => [message.info.id, `msg_f${index}`]));
	return raw.map((message) => ({
		info: { ...structuredClone(message.info), id: ids.get(message.info.id)!, sessionID },
		parts: message.parts.map((part, index) => ({ ...structuredClone(part), id: `prt_g${message.info.id}_${index}`, sessionID, messageID: ids.get(message.info.id)! })),
	}));
}

describe("restore guards", () => {
	test("a reported compaction rebases even when an older checkpoint would still fit", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const { raw1 } = await twoRevisions(clm);
		// The summarized history still starts with r1's source, but it is a compaction.
		const summary = assistant("msg_c2", "Summary of work.");
		summary.info.summary = true;
		clm.compacted = true;
		const result = await clm.transform([...structuredClone(raw1), summary, user("msg_c3", "Continue.")]);
		expect(clm.state.lastOutcome?.kind).toBe("compacted");
		expect(clm.state.checkpoint).toBeUndefined();
		expect(result.notices.join("\n")).not.toContain("restored");
		expect(eventsOf(clm.store.directory).some((event) => event.event === "restored")).toBe(false);
		expect(toolOutput(result.messages[1], "call_1")).toStartWith("big output");
	});

	test("a reset between an accept and its history write keeps the reset edit out of the history", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		await twoRevisions(clm);
		const entry = (await loadHistory(clm.store.directory)).entries[0]!;
		await clm.resetProjection("/clm reset");
		// The write that was still pending when the user reset.
		await (clm as unknown as { remember(entry: HistoryEntry): Promise<void> }).remember(entry);
		expect(existsSync(join(clm.store.directory, HISTORY_DIR))).toBe(false);
	});

	test("the restore notice puts the reason after a colon, without nested parentheses", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const { raw1 } = await twoRevisions(clm);
		const result = await clm.transform([...structuredClone(raw1), assistant("msg_a5", "x")]);
		const notice = result.notices.find((candidate) => candidate.includes("restored revision 1"))!;
		expect(notice).toContain("no longer matches OpenCode's history: ");
		expect(notice).not.toContain(".)");
		expect(notice).not.toContain(".;");
	});

	test("corrupt files in the origin's history are logged during a fork restore", async () => {
		const base = settings();
		const origin = await ClmSession.open(SESSION, base);
		const { raw2 } = await twoRevisions(origin);
		writeFileSync(join(origin.store.directory, HISTORY_DIR, "r9.json"), "{broken");
		const fork = await ClmSession.open("ses_fork", base);
		fork.forkOrigin = { sessionID: SESSION, directory: origin.store.directory };
		const result = await fork.transform(forkOf(raw2, "ses_fork"));
		expect(toolOutput(result.messages[1], "call_1")).toBe("first");
		expect(eventsOf(fork.store.directory).find((event) => event.event === "history-ignored")).toMatchObject({ origin: SESSION, files: ["r9.json"] });
	});
});

describe("stamp guards and errors", () => {
	async function load(client: { get(): Promise<unknown>; update?(options: unknown): Promise<unknown> }) {
		const directory = tempDir("clm-plugin-");
		const updates: unknown[] = [];
		const input = {
			directory,
			worktree: directory,
			client: {
				tui: { showToast: async () => undefined },
				app: { log: async () => undefined },
				session: {
					get: client.get,
					update: async (options: unknown) => {
						updates.push(options);
						return client.update ? client.update(options) : { data: {} };
					},
				},
			},
		} as unknown as PluginInput;
		const mirror = join(directory, "mirrors");
		const hooks: Hooks = await server(input, { mirrorDir: mirror });
		const transform = (messages: OcMessage[]) => hooks["experimental.chat.messages.transform"]!({}, { messages } as never);
		return { updates, transform, sessionDir: join(mirror, `clm-${SESSION}`) };
	}

	test("a child (subagent) session is not stamped", async () => {
		const h = await load({ get: async () => ({ data: { id: SESSION, parentID: "ses_parent", metadata: {} } }) });
		await h.transform(conversation());
		expect(h.updates).toEqual([]);
	});

	test("a session with CLM off is not stamped until CLM is turned on", async () => {
		let gets = 0;
		const h = await load({ get: async () => { gets++; return { data: { id: SESSION } }; } });
		mkdirSync(h.sessionDir, { recursive: true });
		writeFileSync(join(h.sessionDir, "overrides.json"), JSON.stringify({ version: 1, overrides: { editing: false } }));
		await h.transform(conversation());
		expect([gets, h.updates.length]).toEqual([0, 0]);
		writeFileSync(join(h.sessionDir, "overrides.json"), JSON.stringify({ version: 1, overrides: {} }));
		await h.transform(conversation());
		expect([gets, h.updates.length]).toEqual([1, 1]);
	});

	test("a failed GET or PATCH is logged as stamp-error and the request goes on", async () => {
		const failedGet = await load({ get: async () => ({ error: { name: "NotFoundError" } }) });
		await failedGet.transform(conversation());
		expect(failedGet.updates).toEqual([]);
		expect(eventsOf(failedGet.sessionDir).find((event) => event.event === "stamp-error")).toMatchObject({ stage: "get" });
		expect(eventsOf(failedGet.sessionDir).some((event) => event.event === "request")).toBe(true);

		const thrownUpdate = await load({ get: async () => ({ data: { id: SESSION } }), update: async () => { throw new Error("offline"); } });
		await thrownUpdate.transform(conversation());
		expect(eventsOf(thrownUpdate.sessionDir).find((event) => event.event === "stamp-error")).toMatchObject({ stage: "update", error: "offline" });

		const refusedUpdate = await load({ get: async () => ({ data: { id: SESSION } }), update: async () => ({ error: { name: "BadRequest" } }) });
		await refusedUpdate.transform(conversation());
		expect(eventsOf(refusedUpdate.sessionDir).find((event) => event.event === "stamp-error")).toMatchObject({ stage: "update" });
	});
});
