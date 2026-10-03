// M1: no usable mirror directory. pi-clm keeps continuity annotations and their size notice
// without a mirror store; here the session runs from a private temporary directory instead.
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import { server, STATUS_COMMAND } from "../index.ts";
import { COMPACT_COMMAND } from "../src/commands.ts";
import { buildPanelModel } from "../src/panel/model.ts";
import { readSessionDirectory } from "../src/session-files.ts";
import { initialLiveContextState, saveLiveContextState } from "../src/state.ts";
import { ClmSession } from "../src/clm.ts";
import { ANNOTATIONS_FILE, AnnotationStore, PERSISTED_ANNOTATIONS_BYTES, persistAnnotations, restorePersisted } from "../src/continuity.ts";
import { copyPrivateFile, MirrorDirectoryError } from "../src/mirror-store.ts";
import type { OcMessage } from "../src/opencode.ts";
import { conversation, SESSION, settings, tempDir } from "./fixtures.ts";

interface Harness {
	hooks: Hooks;
	directory: string;
	toasts: Array<{ message: string; variant: string }>;
	logs: string[];
	config: { compaction?: { auto?: boolean } };
}

async function load(options: Record<string, unknown>, prepare?: (directory: string) => void): Promise<Harness> {
	const directory = tempDir("clm-mirrorless-");
	prepare?.(directory);
	const harness: Harness = { hooks: {} as Hooks, directory, toasts: [], logs: [], config: {} };
	const input = {
		directory,
		worktree: directory,
		client: {
			tui: { showToast: async ({ body }: { body: { message: string; variant: string } }) => harness.toasts.push(body) },
			app: { log: async ({ body }: { body: { message: string } }) => harness.logs.push(body.message) },
		},
	} as unknown as PluginInput;
	harness.hooks = await server(input, options);
	await harness.hooks.config!(harness.config as never);
	await Bun.sleep(1);
	return harness;
}

async function transform(hooks: Hooks, messages: OcMessage[]): Promise<OcMessage[]> {
	const output = { messages } as never as { messages: OcMessage[] };
	await hooks["experimental.chat.messages.transform"]!({}, output as never);
	await Bun.sleep(1);
	return output.messages;
}

async function command(hooks: Hooks, args: string, sessionID = SESSION, name = STATUS_COMMAND): Promise<string> {
	const output = { parts: [{ type: "text", text: "template" }] } as never as { parts: Array<{ text: string }> };
	await hooks["command.execute.before"]!({ command: name, sessionID, arguments: args }, output as never);
	return output.parts[0]!.text;
}

function text(messages: OcMessage[]): string {
	return JSON.stringify(messages);
}

async function annotate(directory: string, title: string, content: string, retention: "pin" | "continuity" = "continuity") {
	return await new AnnotationStore(directory).create({
		sessionId: SESSION,
		blockId: "2-0123456789ab",
		revision: 0,
		message: { role: "user", content, timestamp: 1 } as never,
		title,
		reason: "needed later",
		futureAction: "check it",
		retention,
	});
}

/** A session opened normally, then marked as having no mirror. */
async function mirrorless(extra: Record<string, unknown> = {}): Promise<ClmSession> {
	const clm = await ClmSession.open(SESSION, settings(extra));
	clm.mirrorUnavailable = "/blocked: EACCES";
	return clm;
}

describe("ClmSession without a mirror", () => {
	test("raw history plus the continuity message; no mirror is written and no edit is read", async () => {
		const clm = await mirrorless();
		await annotate(clm.store.directory, "Keep the deploy steps", "Deploy with make ship.");
		clm.queueNotice("[CLM] a notice that names the mirror");
		const raw = conversation();
		const result = await clm.transform(structuredClone(raw));
		expect(result.messages.slice(0, raw.length)).toEqual(raw);
		expect(result.messages).toHaveLength(raw.length + 1);
		expect(text(result.messages.slice(raw.length))).toContain("Keep the deploy steps");
		expect(text(result.messages)).not.toContain("a notice that names the mirror");
		expect(result.notices).toEqual([]);
		expect(existsSync(clm.mirrorPath)).toBe(false);
		expect(clm.baseline).toBeUndefined();
		expect(clm.sizeTrailer("x".repeat(4000))).toBeUndefined();
		expect(clm.status().mirrorPath).toContain("unavailable");
		expect(clm.status().mirrorPath).toContain("/blocked: EACCES");
	});

	test("no annotations: the request is the raw history", async () => {
		const clm = await mirrorless();
		const raw = conversation();
		expect((await clm.transform(structuredClone(raw))).messages).toEqual(raw);
	});

	test("the continuity size notice fires once when annotations grow past the threshold", async () => {
		// estimateFactor inflates every estimate, so one pin crosses the 8k warning.
		const clm = await mirrorless({ estimateFactor: 4 });
		await annotate(clm.store.directory, "Big pin", "p".repeat(12_000), "pin");
		const first = await clm.transform(structuredClone(conversation()));
		expect(first.notices).toHaveLength(1);
		expect(first.notices[0]).toContain("annotations");
		expect(text(first.messages)).toContain(first.notices[0]!.slice(0, 40));
		expect((await clm.transform(structuredClone(conversation()))).notices).toEqual([]);
	});

	test("compaction input is passed through; the summary still gets the annotations", async () => {
		const clm = await mirrorless();
		await annotate(clm.store.directory, "Carry me", "Carry this through compaction.");
		clm.compacting = true;
		const raw = conversation();
		expect((await clm.transform(structuredClone(raw))).messages).toEqual(raw);
		expect(await clm.compactionContext()).toContain("Carry me");
	});

	test("CLM off for the session: raw history, no continuity", async () => {
		const clm = await mirrorless({ enabled: true });
		await annotate(clm.store.directory, "Hidden", "Not sent.");
		clm.state = { ...clm.state, enabled: false };
		const raw = conversation();
		expect((await clm.transform(structuredClone(raw))).messages).toEqual(raw);
	});
});

describe("copyPrivateFile", () => {
	test("copies a regular file from a private directory, mode 0600, never overwriting", async () => {
		const from = tempDir();
		const to = tempDir();
		writeFileSync(join(from, "a.jsonl"), "one\n");
		expect(await copyPrivateFile(from, to, "a.jsonl")).toBe(true);
		expect(readFileSync(join(to, "a.jsonl"), "utf8")).toBe("one\n");
		expect(statSync(join(to, "a.jsonl")).mode & 0o777).toBe(0o600);
		writeFileSync(join(from, "a.jsonl"), "two\n");
		expect(await copyPrivateFile(from, to, "a.jsonl")).toBe(false);
		expect(readFileSync(join(to, "a.jsonl"), "utf8")).toBe("one\n");
		expect(await copyPrivateFile(from, to, "missing.jsonl")).toBe(false);
	});

	test("refuses a symlinked source directory and a non-file entry", async () => {
		const real = tempDir();
		writeFileSync(join(real, "a.jsonl"), "one\n");
		const link = join(tempDir(), "link");
		symlinkSync(real, link);
		const to = tempDir();
		expect(await copyPrivateFile(link, to, "a.jsonl")).toBe(false);
		mkdirSync(join(real, "dir.jsonl"));
		expect(await copyPrivateFile(real, to, "dir.jsonl")).toBe(false);
	});
});

describe("plugin: no mirror directory can be used", () => {
	// <project>/.opencode is a file: the project default cannot be created.
	const blockDefault = (directory: string) => writeFileSync(join(directory, ".opencode"), "");

	test("configured and default both fail: one error toast naming both, no protocol prompt, raw history", async () => {
		const blocked = join(tempDir("clm-blocked-"), "file");
		writeFileSync(blocked, "not a directory");
		const h = await load({ mirrorDir: join(blocked, "mirrors") }, blockDefault);
		const raw = conversation();
		expect(await transform(h.hooks, structuredClone(raw))).toEqual(raw);
		expect(await transform(h.hooks, structuredClone(raw))).toEqual(raw);
		const errors = h.toasts.filter((toast) => toast.variant === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]!.message).toContain("no mirror directory could be used");
		expect(errors[0]!.message).toContain(join(blocked, "mirrors"));
		expect(errors[0]!.message).toContain(join(h.directory, ".opencode", "clm"));
		expect(errors[0]!.message).toContain("continuity annotations");
		expect(h.logs.join("\n")).toContain("no mirror directory could be used");

		const system = { system: ["base"] };
		await h.hooks["experimental.chat.system.transform"]!({ sessionID: SESSION, model: { limit: { context: 100_000, output: 8_000 } } as never }, system);
		expect(system.system).toEqual(["base"]);

		expect(await command(h.hooks, "path")).toContain("CLM mirror: unavailable (");
		expect(await command(h.hooks, "status")).toContain("mirror: unavailable");

		const parentMatch = /in (\S+) for this server process only/.exec(errors[0]!.message);
		const sessionDir = parentMatch![1]!;
		expect(sessionDir.startsWith(tmpdir())).toBe(true);
		expect(statSync(join(sessionDir, "..")).mode & 0o777).toBe(0o700);
		expect(readFileSync(join(sessionDir, "events.jsonl"), "utf8")).toContain("mirror-unavailable");
		expect(existsSync(join(sessionDir, "LIVE_CONTEXT.md"))).toBe(false);
	});

	/** Fails the session's first open with an EROFS-like error (not reproducible here), then opens normally. */
	async function withFailedFirstOpen(h: Harness, run: () => Promise<void>): Promise<void> {
		const open = ClmSession.open.bind(ClmSession);
		const spy = spyOn(ClmSession, "open");
		spy.mockImplementationOnce(async () => {
			throw new MirrorDirectoryError(join(h.directory, ".opencode", "clm"), new Error("EROFS: read-only file system"));
		});
		spy.mockImplementation(open);
		try {
			await run();
		} finally {
			spy.mockRestore();
		}
	}

	const failedSessionDir = (directory: string) => join(directory, ".opencode", "clm", `clm-${SESSION}`);

	test("annotations still readable in a failed session directory are copied and sent", async () => {
		const h = await load({}, (directory) => mkdirSync(failedSessionDir(directory), { recursive: true }));
		const failedDir = failedSessionDir(h.directory);
		await annotate(failedDir, "Survives the failure", "Keep the release checklist.");
		await withFailedFirstOpen(h, async () => {
			const raw = conversation();
			const sent = await transform(h.hooks, structuredClone(raw));
			expect(sent.slice(0, raw.length)).toEqual(raw);
			expect(text(sent.slice(raw.length))).toContain("Survives the failure");
			const error = h.toasts.find((toast) => toast.variant === "error")!;
			expect(error.message).toContain(`annotations.jsonl copied from ${failedDir}`);
			// Resolving changes the temporary copy only.
			const sessionDir = /stay in (\S+) for this server process only/.exec(error.message)![1]!;
			expect(sessionDir).not.toBe(failedDir);
			expect(existsSync(join(sessionDir, ANNOTATIONS_FILE))).toBe(true);
		});
	});

	test("state.json and overrides.json are carried before the session loads them", async () => {
		const h = await load({}, (directory) => mkdirSync(failedSessionDir(directory), { recursive: true }));
		const failedDir = failedSessionDir(h.directory);
		await annotate(failedDir, "Not sent while off", "Hidden.");
		await saveLiveContextState(failedDir, { ...initialLiveContextState(), enabled: false });
		writeFileSync(join(failedDir, "overrides.json"), JSON.stringify({ version: 1, overrides: { guard: "off" } }));
		await withFailedFirstOpen(h, async () => {
			const raw = conversation();
			// CLM was off for this session: no continuity either.
			expect(await transform(h.hooks, structuredClone(raw))).toEqual(raw);
			const error = h.toasts.find((toast) => toast.variant === "error")!;
			expect(error.message).toContain(`state.json, overrides.json, annotations.jsonl copied from ${failedDir}`);
			expect(await command(h.hooks, "status")).toContain("guard off");
		});
	});
	test("a second session shares the process's temporary parent", async () => {
		const h = await load({}, blockDefault);
		const other = "ses_other";
		await transform(h.hooks, structuredClone(conversation()));
		const second = conversation().map((message) => ({ ...message, info: { ...message.info, sessionID: other } }));
		await transform(h.hooks, second as OcMessage[]);
		const dirs = h.toasts.filter((toast) => toast.variant === "error").map((toast) => /in (\S+) for this server process only/.exec(toast.message)![1]!);
		expect(dirs).toHaveLength(2);
		expect(join(dirs[0]!, "..")).toBe(join(dirs[1]!, ".."));
	});

	test("/clm-compact refuses and /clm pages never show the temporary directory", async () => {
		const h = await load({}, blockDefault);
		await transform(h.hooks, structuredClone(conversation()));
		const error = h.toasts.find((toast) => toast.variant === "error")!;
		const sessionDir = /in (\S+) for this server process only/.exec(error.message)![1]!;
		const compact = await command(h.hooks, "keep the tests", SESSION, COMPACT_COMMAND);
		expect(compact).toContain("[CLM] The context mirror is unavailable, so the model cannot edit its context.");
		expect(compact).not.toContain(sessionDir);
		expect(compact).not.toContain("LIVE_CONTEXT.md");
		expect(h.toasts.some((toast) => toast.variant === "warning" && toast.message.includes("mirror is unavailable"))).toBe(true);
		for (const page of ["input", "overview", "edits", "settings"]) {
			const shown = await command(h.hooks, page);
			expect(shown).not.toContain(sessionDir);
		}
		expect(await command(h.hooks, "input")).toContain("No mirror");
		expect(await command(h.hooks, "overview")).toContain("No mirror");
		expect(await command(h.hooks, "off")).toContain("CLM is off for this session: requests carry the raw history.\n");
		// The TUI panel reads the same directory (channel `locate`) and says so too.
		const model = buildPanelModel(await readSessionDirectory(sessionDir, SESSION));
		expect(model.mirrorUnavailable).toContain(join(h.directory, ".opencode", "clm"));
		expect(model.mirrorPath.startsWith("unavailable (")).toBe(true);
	});

	test("the temporary directory fails too: raw history, one error toast with every reason", async () => {
		const blocker = join(tempDir("clm-tmp-blocked-"), "file");
		writeFileSync(blocker, "not a directory");
		const h = await load({}, blockDefault);
		const saved = process.env.TMPDIR;
		process.env.TMPDIR = blocker;
		try {
			const raw = conversation();
			expect(await transform(h.hooks, structuredClone(raw))).toEqual(raw);
			expect(await transform(h.hooks, structuredClone(raw))).toEqual(raw);
		} finally {
			if (saved === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = saved;
		}
		const errors = h.toasts.filter((toast) => toast.variant === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]!.message).toContain("not active");
		expect(errors[0]!.message).toContain("raw history");
		expect(errors[0]!.message).toContain(join(h.directory, ".opencode", "clm"));
		expect(errors[0]!.message).toContain("no temporary directory either");
	});

	test("compaction off is not applied without a mirror: OpenCode's compaction stays as configured", async () => {
		const h = await load({ compaction: "off" }, blockDefault);
		await transform(h.hooks, structuredClone(conversation()));
		expect(h.config.compaction?.auto).not.toBe(false);
	});
});

// ---- M1: annotations of a session without a mirror survive a restart (session metadata) ----

describe("annotations persisted in OpenCode's session metadata", () => {
	test("persistAnnotations: resolutions always, snapshots active first within the bound", async () => {
		const directory = tempDir();
		const active = await annotate(directory, "Active", "a".repeat(2_000));
		const done = await annotate(directory, "Done", "d".repeat(2_000));
		const store = new AnnotationStore(directory);
		await store.resolve(done.id, "finished");
		const all = await store.list();
		const full = persistAnnotations(all);
		expect(full.resolved).toEqual([{ id: done.id, resolvedAt: expect.any(String), resolution: "finished" }]);
		expect(full.annotations.map((annotation) => annotation.id)).toEqual([active.id, done.id]);
		// Room for one snapshot: the active one is kept, the resolution still recorded.
		const tight = persistAnnotations(all, 3_000);
		expect(JSON.stringify(tight).length).toBeLessThanOrEqual(3_000);
		expect(tight.annotations.map((annotation) => annotation.id)).toEqual([active.id]);
		expect(tight.resolved).toHaveLength(1);
		expect(JSON.stringify(persistAnnotations(all, PERSISTED_ANNOTATIONS_BYTES)).length).toBeLessThanOrEqual(PERSISTED_ANNOTATIONS_BYTES);
	});

	test("restorePersisted: adds missing snapshots, applies resolutions, ignores junk", async () => {
		const directory = tempDir();
		const keep = await annotate(directory, "Keep", "k");
		const gone = await annotate(directory, "Gone", "g");
		const store = new AnnotationStore(directory);
		await store.resolve(gone.id, "ok");
		const persisted = persistAnnotations(await store.list());
		// A store that only has `gone`, unresolved (the copy from the failed directory).
		const restored = restorePersisted([gone], persisted);
		expect(restored.map((annotation) => [annotation.id, annotation.resolvedAt !== undefined])).toEqual([[keep.id, false], [gone.id, true]]);
		expect(restorePersisted([], { version: 2 })).toEqual([]);
		expect(restorePersisted([], "x")).toEqual([]);
		expect(restorePersisted([], { version: 1, annotations: [{ id: "bad" }], resolved: [{ id: 1 }] })).toEqual([]);
	});

	test("a resolution made without a mirror is still in force after a restart", async () => {
		const metadata: Record<string, unknown> = { other: 1 };
		const start = async () => {
			const directory = tempDir("clm-persist-");
			writeFileSync(join(directory, ".opencode"), "");
			const toasts: string[] = [];
			const input = {
				directory,
				worktree: directory,
				client: {
					tui: { showToast: async ({ body }: { body: { message: string } }) => toasts.push(body.message) },
					app: { log: async () => undefined },
					session: {
						get: async () => ({ data: { id: SESSION, metadata: structuredClone(metadata) } }),
						update: async (options: { body: { metadata: Record<string, unknown> } }) => {
							for (const key of Object.keys(metadata)) delete metadata[key];
							Object.assign(metadata, structuredClone(options.body.metadata));
							return { data: {} };
						},
					},
				},
			} as unknown as PluginInput;
			const hooks = await server(input, {});
			await hooks.config!({} as never);
			const sent = await transform(hooks, structuredClone(conversation()));
			const sessionDir = /stay in (\S+) for this server process only|files are in (\S+) for this server process only/.exec(toasts.join("\n"))!;
			return { hooks, sent, sessionDir: (sessionDir[1] ?? sessionDir[2])! };
		};
		// Process 1: two annotations (as copied from a failed directory); one is resolved.
		const first = await start();
		const keep = await annotate(first.sessionDir, "Still open", "Keep the release checklist.");
		const done = await annotate(first.sessionDir, "Already done", "Old task.");
		const context = { sessionID: SESSION, messageID: "m", agent: "build", abort: new AbortController().signal } as never;
		await first.hooks.tool!.clm_annotate!.execute({ action: "resolve", id: done.id, resolution: "shipped" } as never, context);
		const stamp = (metadata.clm ?? {}) as { annotations?: { resolved: unknown[]; annotations: unknown[] } };
		expect(metadata.other).toBe(1);
		expect(stamp.annotations!.resolved).toHaveLength(1);
		expect(stamp.annotations!.annotations).toHaveLength(2);
		// Process 2: a fresh temporary directory; the annotations come back from the metadata.
		const second = await start();
		expect(second.sessionDir).not.toBe(first.sessionDir);
		const continuity = text(second.sent);
		expect(continuity).toContain("Still open");
		expect(continuity).not.toContain("Already done");
		const restored = await new AnnotationStore(second.sessionDir).list();
		expect(restored.find((annotation) => annotation.id === done.id)!.resolution).toBe("shipped");
		expect(restored.find((annotation) => annotation.id === keep.id)!.resolvedAt).toBeUndefined();
		expect(readFileSync(join(second.sessionDir, "events.jsonl"), "utf8")).toContain('"annotations-restored"');
	});

	/** A plugin whose OpenCode client keeps one session's metadata; get and update yield first. */
	async function withMetadata(metadata: Record<string, unknown>, options: { created?: number; blocked?: boolean; sessionID?: string; getDelays?: number[] } = {}) {
		const directory = tempDir("clm-meta-");
		if (options.blocked !== false) writeFileSync(join(directory, ".opencode"), "");
		const toasts: string[] = [];
		const input = {
			directory,
			worktree: directory,
			client: {
				tui: { showToast: async ({ body }: { body: { message: string } }) => toasts.push(body.message) },
				app: { log: async () => undefined },
				session: {
					get: async () => {
						// Read when the request arrives, answered later.
						const data = { id: options.sessionID ?? SESSION, metadata: structuredClone(metadata), ...(options.created !== undefined ? { time: { created: options.created } } : {}) };
						await Bun.sleep(options.getDelays?.shift() ?? 2);
						return { data };
					},
					update: async (request: { body: { metadata: Record<string, unknown> } }) => {
						await Bun.sleep(2);
						for (const key of Object.keys(metadata)) delete metadata[key];
						Object.assign(metadata, structuredClone(request.body.metadata));
						return { data: {} };
					},
				},
			},
		} as unknown as PluginInput;
		const hooks = await server(input, {});
		await hooks.config!({} as never);
		const sessionDir = () => {
			const match = /(?:stay|files are) in (\S+) for this server process only/.exec(toasts.join("\n"))!;
			return match[1]!;
		};
		return { hooks, directory, sessionDir };
	}
	const toolContext = { sessionID: SESSION, messageID: "m", agent: "build", abort: new AbortController().signal } as never;

	test("parallel changes and the fork stamp are written one after another (no lost update)", async () => {
		const metadata: Record<string, unknown> = { other: 1 };
		// The open's own read, then a slow read for the stamp, then fast ones.
		const h = await withMetadata(metadata, { getDelays: [1, 30] });
		await command(h.hooks, "status"); // opens the session, no stamp yet
		const one = await annotate(h.sessionDir(), "One", "1");
		const two = await annotate(h.sessionDir(), "Two", "2");
		const resolve = (id: string) => h.hooks.tool!.clm_annotate!.execute({ action: "resolve", id } as never, toolContext);
		// The stamp's read is slow: unserialized, its PATCH would land last and drop the annotations.
		await Promise.all([transform(h.hooks, structuredClone(conversation())), resolve(one.id), resolve(two.id)]);
		const stamp = metadata.clm as { origin: string; annotations: { resolved: Array<{ id: string }> } };
		expect(stamp.origin).toBe(SESSION);
		expect(stamp.annotations.resolved.map((entry) => entry.id).sort()).toEqual([one.id, two.id].sort());
		expect(metadata.other).toBe(1);
	});

	test("the byte bound counts UTF-8 bytes", async () => {
		const directory = tempDir();
		await annotate(directory, "Wide", "\u00e9\u4e2d".repeat(1_000));
		const all = await new AnnotationStore(directory).list();
		const json = JSON.stringify(all[0]);
		const bound = json.length + 200;
		// Fits by UTF-16 length, not by bytes: left out.
		expect(Buffer.byteLength(json)).toBeGreaterThan(bound);
		expect(persistAnnotations(all, bound).annotations).toEqual([]);
	});

	test("a session that has its mirror again drops the stale set", async () => {
		const persisted = persistAnnotations([]);
		const metadata: Record<string, unknown> = { clm: { origin: SESSION, annotations: persisted }, other: 1 };
		const h = await withMetadata(metadata, { blocked: false });
		await transform(h.hooks, structuredClone(conversation()));
		expect(metadata).toEqual({ clm: { origin: SESSION }, other: 1 });
	});

	test("a fork without a mirror applies the fork-point cutoff to the origin's persisted set", async () => {
		const source = tempDir();
		const at = (ms: number) => new AnnotationStore(source, { now: () => new Date(ms) });
		const make = (ms: number, title: string) => at(ms).create({ sessionId: "ses_origin", blockId: "2-0123456789ab", revision: 0, message: { role: "user", content: title, timestamp: 1 } as never, title, reason: "r", futureAction: "n", retention: "continuity" });
		await make(2, "Before the fork");
		await make(10, "After the fork");
		const metadata: Record<string, unknown> = { clm: { origin: "ses_origin", annotations: persistAnnotations(await new AnnotationStore(source).list()) } };
		// Fixture messages complete at 3 ms; the fork was created at 5 ms.
		const h = await withMetadata(metadata, { created: 5 });
		const sent = text(await transform(h.hooks, structuredClone(conversation())));
		expect(sent).toContain("Before the fork");
		expect(sent).not.toContain("After the fork");
		// The fork's own set replaces the clone, under its own stamp.
		const stamp = metadata.clm as { origin: string; annotations: { annotations: Array<{ title: string }> } };
		expect(stamp.origin).toBe(SESSION);
		expect(stamp.annotations.annotations.map((annotation) => annotation.title)).toEqual(["Before the fork"]);
	});
});
