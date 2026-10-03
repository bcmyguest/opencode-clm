// Robustness (parity block 5): user toasts for mirror and checkpoint failures (T4, R6), a
// steering file that does not load (S7), and a mirror directory that cannot be created (M1).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import { server, STATUS_COMMAND } from "../index.ts";
import { ClmSession } from "../src/clm.ts";
import { buildPanelModel } from "../src/panel/model.ts";
import { initialPanelState, settingsPage } from "../src/panel/view.ts";
import { readSessionDirectory } from "../src/session-files.ts";
import type { OcMessage } from "../src/opencode.ts";
import { COMMAND_EVENT, decodeReply, encodeRequest, type ChannelReply, type ChannelRequest } from "../src/channel.ts";
import { conversation, SESSION, settings, tempDir, toolOutput } from "./fixtures.ts";
import { blockId, replaceBody } from "./helpers.ts";

interface Harness {
	hooks: Hooks;
	directory: string;
	toasts: Array<{ message: string; variant: string }>;
	logs: string[];
}

async function load(options: Record<string, unknown>): Promise<Harness> {
	const directory = tempDir("clm-robust-");
	const harness: Harness = { hooks: {} as Hooks, directory, toasts: [], logs: [] };
	const input = {
		directory,
		worktree: directory,
		client: {
			tui: { showToast: async ({ body }: { body: { message: string; variant: string } }) => harness.toasts.push(body) },
			app: { log: async ({ body }: { body: { message: string } }) => harness.logs.push(body.message) },
		},
	} as unknown as PluginInput;
	harness.hooks = await server(input, { mirrorDir: join(directory, "mirrors"), ...options });
	await harness.hooks.config!({} as never);
	// Toasts and logs are sent on a later microtask.
	await Bun.sleep(1);
	return harness;
}

async function transform(hooks: Hooks, messages: OcMessage[]): Promise<OcMessage[]> {
	const output = { messages } as never as { messages: OcMessage[] };
	await hooks["experimental.chat.messages.transform"]!({}, output as never);
	await Bun.sleep(1);
	return output.messages;
}

async function systemPrompt(hooks: Hooks): Promise<string> {
	const output = { system: ["base"] };
	await hooks["experimental.chat.system.transform"]!({ sessionID: SESSION, model: { limit: { context: 100_000, output: 8_000 } } as never }, output);
	return output.system.join("\n");
}

async function status(hooks: Hooks): Promise<string> {
	const output = { parts: [{ type: "text", text: "template" }] } as never as { parts: Array<{ text: string }> };
	await hooks["command.execute.before"]!({ command: STATUS_COMMAND, sessionID: SESSION, arguments: "status" }, output as never);
	return output.parts[0]!.text;
}

describe("T4/R6: failures reach the user, not only the model", () => {
	test("a mirror that cannot be read or rewritten: model notice and error toast", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		await clm.transform(structuredClone(conversation()));
		// The mirror path becomes a directory: reading and rewriting it fail.
		rmSync(clm.mirrorPath);
		mkdirSync(clm.mirrorPath);
		writeFileSync(join(clm.mirrorPath, "x"), "");
		const result = await clm.transform(structuredClone(conversation()));
		expect(result.notices.join("\n")).toContain("[CLM] Could not refresh the mirror");
		expect(result.errors?.some((error) => error.startsWith("could not refresh the mirror"))).toBe(true);
		// Errors are reported once.
		rmSync(clm.mirrorPath, { recursive: true });
		expect((await clm.transform(structuredClone(conversation()))).errors).toBeUndefined();
	});

	test("an edit whose checkpoint cannot be saved: model notice and error toast", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const raw = conversation();
		await clm.transform(structuredClone(raw));
		writeFileSync(clm.mirrorPath, replaceBody(readFileSync(clm.mirrorPath, "utf8"), blockId(clm.baseline!.snapshot, "toolResult", 0), "short"));
		// state.json becomes a directory: the atomic write's rename fails.
		const state = join(clm.store.directory, "state.json");
		rmSync(state, { force: true });
		mkdirSync(state);
		writeFileSync(join(state, "x"), "");
		const result = await clm.transform(structuredClone(raw));
		expect(result.notices.join("\n")).toContain("Revision 1 was not applied: it could not be saved");
		expect(result.errors?.some((error) => error.startsWith("revision 1 could not be saved"))).toBe(true);
		expect(toolOutput(result.messages[1], "call_1")).not.toBe("short");
	});

	test("the plugin toasts and logs transform errors", async () => {
		const h = await load({});
		await transform(h.hooks, structuredClone(conversation()));
		const mirror = join(h.directory, "mirrors", `clm-${SESSION}`, "LIVE_CONTEXT.md");
		rmSync(mirror);
		mkdirSync(mirror);
		writeFileSync(join(mirror, "x"), "");
		await transform(h.hooks, structuredClone(conversation()));
		expect(h.toasts.filter((toast) => toast.variant === "error").map((toast) => toast.message).join("\n")).toContain("could not refresh the mirror");
		expect(h.logs.join("\n")).toContain("could not refresh the mirror");
	});
});

describe("M1: a mirror directory that cannot be created", () => {
	test("an explicit mirrorDir that fails: the session uses the project default and says so", async () => {
		const blocked = join(tempDir("clm-blocked-"), "file");
		writeFileSync(blocked, "not a directory");
		const h = await load({ mirrorDir: join(blocked, "mirrors") });
		await transform(h.hooks, structuredClone(conversation()));
		const fallback = join(h.directory, ".opencode", "clm", `clm-${SESSION}`);
		expect(readFileSync(join(fallback, "LIVE_CONTEXT.md"), "utf8")).toContain("LIVE_CONTEXT");
		expect(await systemPrompt(h.hooks)).toContain(join(fallback, "LIVE_CONTEXT.md"));
		const warning = h.toasts.find((toast) => toast.message.includes("could not use the configured mirrorDir"));
		expect(warning?.variant).toBe("warning");
		expect(warning?.message).toContain(join(blocked, "mirrors"));
		expect(warning?.message).toContain(fallback);
		expect(readFileSync(join(fallback, "events.jsonl"), "utf8")).toContain("mirror-dir-fallback");
	});

	test("an explicit mirrorDir that fails: the channel's locate names the fallback directory", async () => {
		const blocked = join(tempDir("clm-blocked-"), "file");
		writeFileSync(blocked, "not a directory");
		const directory = tempDir("clm-robust-locate-");
		const replies: ChannelReply[] = [];
		const input = {
			directory,
			worktree: directory,
			client: {
				tui: {
					showToast: async () => undefined,
					publish: async ({ body }: { body: { properties: { command: string } } }) => {
						const reply = decodeReply(body.properties.command);
						if (reply) replies.push(reply);
					},
				},
				app: { log: async () => undefined },
				session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) },
			},
		} as unknown as PluginInput;
		const hooks = await server(input, { mirrorDir: join(blocked, "mirrors") });
		await hooks.config!({} as never);
		await transform(hooks, structuredClone(conversation()));
		const command = encodeRequest({ op: "locate", v: 1, id: "loc", session: SESSION } as ChannelRequest);
		await hooks.event!({ event: { type: COMMAND_EVENT, properties: { command } } as never });
		await Bun.sleep(5);
		const reply = replies.find((candidate) => candidate.id === "loc");
		expect(reply?.directory).toBe(join(directory, ".opencode", "clm", `clm-${SESSION}`));
	});

	test("the default itself fails: raw history, and one error toast however many requests", async () => {
		const h = await load({ mirrorDir: undefined });
		// <project>/.opencode is a file: the default cannot be created.
		writeFileSync(join(h.directory, ".opencode"), "");
		const raw = conversation();
		expect(await transform(h.hooks, structuredClone(raw))).toEqual(raw);
		expect(await transform(h.hooks, structuredClone(raw))).toEqual(raw);
		const errors = h.toasts.filter((toast) => toast.variant === "error" && toast.message.includes("not active"));
		expect(errors).toHaveLength(1);
		expect(errors[0]!.message).toContain("raw history");
		expect(h.toasts.some((toast) => toast.message.includes("could not use the configured mirrorDir"))).toBe(false);
	});

	test("a failure that is not about the directory does not move the session", async () => {
		const h = await load({});
		const sessionDir = join(h.directory, "mirrors", `clm-${SESSION}`);
		mkdirSync(sessionDir, { recursive: true });
		// overrides.json as a directory: reading it fails inside ClmSession.open, after the store.
		mkdirSync(join(sessionDir, "overrides.json"));
		const raw = conversation();
		await transform(h.hooks, structuredClone(raw));
		expect(h.toasts.some((toast) => toast.message.includes("could not use the configured mirrorDir"))).toBe(false);
		expect(existsSync(join(h.directory, ".opencode", "clm", `clm-${SESSION}`))).toBe(false);
	});
});

describe("block 5 review fixes", () => {
	test("an unwritable mirror is toasted once until a write succeeds again", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		await clm.transform(structuredClone(conversation()));
		const block = () => {
			rmSync(clm.mirrorPath, { recursive: true, force: true });
			mkdirSync(clm.mirrorPath);
			writeFileSync(join(clm.mirrorPath, "x"), "");
		};
		const refreshErrors = async () =>
			((await clm.transform(structuredClone(conversation()))).errors ?? []).filter((error) => error.startsWith("could not refresh the mirror"));
		block();
		expect(await refreshErrors()).toHaveLength(1);
		expect(await refreshErrors()).toHaveLength(0);
		// The model notice still says so on every request.
		expect((await clm.transform(structuredClone(conversation()))).notices.join("\n")).toContain("Could not refresh the mirror");
		rmSync(clm.mirrorPath, { recursive: true });
		expect(await refreshErrors()).toHaveLength(0);
		block();
		expect(await refreshErrors()).toHaveLength(1);
	});

	test("a per-session steering file that does not load reaches snapshot.json and the panel's settings page", async () => {
		const h = await load({});
		const directory = join(h.directory, "mirrors", `clm-${SESSION}`);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "overrides.json"), JSON.stringify({ version: 1, overrides: { steering: "/nonexistent/session-brief.md" } }));
		await systemPrompt(h.hooks);
		await transform(h.hooks, structuredClone(conversation()));
		const snapshot = JSON.parse(readFileSync(join(directory, "snapshot.json"), "utf8"));
		expect(snapshot.steeringError).toContain("/nonexistent/session-brief.md");
		const model = buildPanelModel(await readSessionDirectory(directory, SESSION));
		expect(model.steeringError).toContain("/nonexistent/session-brief.md");
		const page = settingsPage(model, initialPanelState("settings"), 100).lines.map((line) => line.map((part) => part.text).join("")).join("\n");
		expect(page).toContain("steering document not loaded");
		// Fixed again: the snapshot drops the error.
		writeFileSync(join(directory, "overrides.json"), JSON.stringify({ version: 1, overrides: {} }));
		await transform(h.hooks, structuredClone(conversation()));
		expect(JSON.parse(readFileSync(join(directory, "snapshot.json"), "utf8")).steeringError).toBeUndefined();
	});
});
