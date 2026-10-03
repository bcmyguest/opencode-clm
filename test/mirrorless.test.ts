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
import { ANNOTATIONS_FILE, AnnotationStore } from "../src/continuity.ts";
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
