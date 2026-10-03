// The `compaction`, `one-tool` and `trailer` settings: pure decisions (src/compaction.ts),
// setting descriptors, and the hooks of index.ts driven as opencode 1.18.34 calls them.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import { server } from "../index.ts";
import { ClmSession } from "../src/clm.ts";
import {
	applyCompactionMode,
	compactionAuto,
	nativeCompactionText,
	oneToolText,
	overflowNotCompactedText,
	sizeTrailer,
	ToolCallCounter,
} from "../src/compaction.ts";
import type { OcMessage } from "../src/opencode.ts";
import { resolveSettings } from "../src/settings.ts";
import { applyOverrides, sanitizeOverrides, settingDescriptor, settingsAsOverrides } from "../src/settings-table.ts";
import { conversation, SESSION, settings, tempDir, toolOutput } from "./fixtures.ts";
import { blockId, replaceBody } from "./helpers.ts";

describe("compaction mode", () => {
	test("off forces it off; auto and on keep the user's value", () => {
		expect([compactionAuto("auto", undefined), compactionAuto("auto", false), compactionAuto("auto", true)]).toEqual([undefined, false, true]);
		expect([compactionAuto("on", undefined), compactionAuto("on", false), compactionAuto("on", true)]).toEqual([undefined, false, true]);
		expect([compactionAuto("off", true), compactionAuto("off", undefined)]).toEqual([false, false]);
	});

	test("applies to the config object and restores the user's value", () => {
		const config: { compaction?: { auto?: boolean; prune?: boolean } } = {};
		applyCompactionMode(config, "off", undefined);
		expect(config).toEqual({ compaction: { auto: false } });
		applyCompactionMode(config, "auto", undefined);
		expect(config).toEqual({ compaction: {} });
		const user = { compaction: { auto: true, prune: true } };
		applyCompactionMode(user, "off", true);
		expect(user.compaction).toEqual({ auto: false, prune: true });
		applyCompactionMode(user, "on", true);
		expect(user.compaction).toEqual({ auto: true, prune: true });
		const untouched: { compaction?: { auto?: boolean } } = {};
		applyCompactionMode(untouched, "auto", undefined);
		expect(untouched).toEqual({});
	});

	test("texts", () => {
		expect(nativeCompactionText(false, "auto")).toContain("at its token threshold");
		expect(nativeCompactionText(true, "on")).toContain("context overflow");
		expect(nativeCompactionText(false, "off")).not.toContain("compaction off");
		expect(overflowNotCompactedText("/m/LIVE_CONTEXT.md")).toContain("/m/LIVE_CONTEXT.md");
	});
});

describe("one tool per response", () => {
	test("the counter counts per session and resets per request", () => {
		const counter = new ToolCallCounter();
		expect([counter.next("a"), counter.next("a"), counter.next("b"), counter.next("a")]).toEqual([1, 2, 1, 3]);
		counter.reset("a");
		expect([counter.next("a"), counter.next("b")]).toEqual([1, 2]);
	});

	test("the blocked call's text names the tool and its position", () => {
		expect(oneToolText("bash", 2)).toBe("[CLM] One tool call per response (setting one-tool): this bash call was #2 in the response and did not run. Call it again on its own in your next response.");
	});
});

describe("size trailer", () => {
	test("text", () => {
		expect(sizeTrailer(12_000, 345, 32_000)).toBe("\n[context: ~12,345 of 32,000 tokens after this result]");
	});

	test("ClmSession: only when on, editing and a budget resolves", async () => {
		const off = await ClmSession.open(SESSION, settings({ budget: "32k" }));
		expect(off.sizeTrailer("x".repeat(400))).toBeUndefined();
		const on = await ClmSession.open(SESSION, settings({ budget: "32k", trailer: true }));
		expect(on.sizeTrailer("x".repeat(400))).toBe("\n[context: ~100 of 32,000 tokens after this result]");
		const window = await ClmSession.open(SESSION, settings({ trailer: true, budget: "window" }));
		expect(window.sizeTrailer("x")).toBeUndefined(); // budget "window" without a known window
	});
});

describe("settings", () => {
	test("options, environment and defaults", () => {
		const defaults = resolveSettings({}, {}, "/p");
		expect([defaults.compaction, defaults.oneTool, defaults.trailer]).toEqual(["auto", false, false]);
		const env = resolveSettings({}, { CLM_NATIVE_COMPACTION: "off", CLM_ONE_TOOL_PER_TURN: "1", CLM_SIZE_TRAILER: "on" }, "/p");
		expect([env.compaction, env.oneTool, env.trailer]).toEqual(["off", true, true]);
		const options = resolveSettings({ compaction: "ON", oneTool: false, trailer: "no" }, { CLM_NATIVE_COMPACTION: "off", CLM_ONE_TOOL_PER_TURN: "1" }, "/p");
		expect([options.compaction, options.oneTool, options.trailer]).toEqual(["on", false, false]);
		expect(() => resolveSettings({ compaction: "sometimes" }, {}, "/p")).toThrow("compaction must be auto, off or on");
		expect(() => resolveSettings({}, { CLM_SIZE_TRAILER: "maybe" }, "/p")).toThrow("trailer must be true or false");
	});

	test("descriptors: names, aliases, parse, format, overrides", () => {
		for (const [alias, key] of [["compaction", "compaction"], ["native-compaction", "compaction"], ["one-tool", "oneTool"], ["ONETOOL", "oneTool"], ["one-tool-per-turn", "oneTool"], ["trailer", "trailer"], ["size-trailer", "trailer"], ["sizetrailer", "trailer"]] as const) {
			expect([alias, settingDescriptor(alias)?.key]).toEqual([alias, key]);
		}
		const context = { directory: "/p" };
		expect(settingDescriptor("compaction")!.parse("Off", context)).toEqual({ compaction: "off" });
		expect(() => settingDescriptor("compaction")!.parse("never", context)).toThrow("auto, off or on");
		expect(settingDescriptor("one-tool")!.parse("on", context)).toEqual({ oneTool: true });
		expect(settingDescriptor("trailer")!.parse("off", context)).toEqual({ trailer: false });
		const base = resolveSettings({}, {}, "/p");
		const changed = applyOverrides(base, { compaction: "on", oneTool: true, trailer: true });
		const values = { editing: true, settings: changed };
		expect(["compaction", "one-tool", "trailer"].map((name) => settingDescriptor(name)!.format(values))).toEqual(["on", "on", "on"]);
		expect(settingsAsOverrides(changed)).toMatchObject({ compaction: "on", oneTool: true, trailer: true });
		expect(sanitizeOverrides({ compaction: "never", oneTool: "yes", trailer: true })).toEqual({ overrides: { trailer: true }, ignored: ["compaction", "oneTool"] });
	});
});

// ---- hooks -------------------------------------------------------------------------------

interface Harness {
	hooks: Hooks;
	mirror: string;
	toasts: string[];
	config: Record<string, any>;
}

async function load(options: Record<string, unknown>, config: Record<string, any> = {}): Promise<Harness> {
	const directory = tempDir("clm-compaction-");
	const toasts: string[] = [];
	const input = {
		directory,
		worktree: directory,
		client: {
			tui: { showToast: async ({ body }: { body: { message: string } }) => toasts.push(body.message) },
			app: { log: async () => undefined },
		},
	} as unknown as PluginInput;
	const mirror = join(directory, "mirrors");
	const hooks = await server(input, { mirrorDir: mirror, budget: "32k", ...options });
	await hooks.config!(config as never);
	return { hooks, mirror, toasts, config };
}

async function transform(hooks: Hooks, messages: OcMessage[]): Promise<OcMessage[]> {
	const output = { messages } as never;
	await hooks["experimental.chat.messages.transform"]!({}, output);
	return (output as { messages: OcMessage[] }).messages;
}

const before = (hooks: Hooks, tool: string, sessionID = SESSION) =>
	hooks["tool.execute.before"]!({ tool, sessionID, callID: `c_${tool}` }, { args: {} });

describe("hooks", () => {
	test("compaction: off at load and per request; auto restores the user's value", async () => {
		const h = await load({ compaction: "off" }, { compaction: { auto: true, prune: false } });
		expect(h.config.compaction).toEqual({ auto: false, prune: false });
		await transform(h.hooks, conversation());
		expect(h.config.compaction.auto).toBe(false);
		// A session that changes its own setting to auto gets the user's value back.
		const directory = join(h.mirror, `clm-${SESSION}`);
		writeFileSync(join(directory, "overrides.json"), JSON.stringify({ version: 1, overrides: { compaction: "auto" } }));
		await transform(h.hooks, conversation());
		expect(h.config.compaction).toEqual({ auto: true, prune: false });

		const defaults = await load({});
		expect(defaults.config.compaction).toBeUndefined();
		await transform(defaults.hooks, conversation());
		expect(defaults.config.compaction).toBeUndefined();
	});

	test("compaction: the compaction's own transform leaves the flag alone", async () => {
		const h = await load({ compaction: "off" }, { compaction: { auto: true } });
		await transform(h.hooks, conversation());
		expect(h.config.compaction.auto).toBe(false);
		h.config.compaction.auto = "sentinel";
		await h.hooks["experimental.session.compacting"]!({ sessionID: SESSION }, { context: [], prompt: undefined });
		await transform(h.hooks, conversation().slice(0, 2));
		expect(h.config.compaction.auto).toBe("sentinel");
	});

	test("native compaction and an overflow with compaction off are reported", async () => {
		const h = await load({ compaction: "off" });
		await transform(h.hooks, conversation());
		await h.hooks["experimental.compaction.autocontinue"]!({ sessionID: SESSION, overflow: false } as never, { enabled: true });
		expect(h.toasts.some((toast) => toast.includes("at its token threshold"))).toBe(true);
		await h.hooks.event!({ event: { type: "session.error", properties: { sessionID: SESSION, error: { name: "ContextOverflowError", data: {} } } } as never });
		expect(h.toasts.some((toast) => toast.includes("automatic compaction is off"))).toBe(true);
		const next = await transform(h.hooks, conversation());
		expect(JSON.stringify(next)).toContain("rejected the last request as too long");
		const events = readFileSync(join(h.mirror, `clm-${SESSION}`, "events.jsonl"), "utf8");
		expect(events).toContain("\"native-compaction\"");
		expect(events).toContain("\"overflow-not-compacted\"");

		const auto = await load({});
		await transform(auto.hooks, conversation());
		await auto.hooks.event!({ event: { type: "session.error", properties: { sessionID: SESSION, error: { name: "ContextOverflowError" } } } as never });
		expect(auto.toasts).toEqual([]);
	});

	const overflow = (hooks: Hooks) =>
		hooks.event!({ event: { type: "session.error", properties: { sessionID: SESSION, error: { name: "ContextOverflowError" } } } as never });

	test("the overflow notice follows the flag OpenCode read, not this session's setting", async () => {
		// Setting off, but another session put the user's `true` back before OpenCode read it:
		// OpenCode compacted, so nothing is said.
		const off = await load({ compaction: "off" }, { compaction: { auto: true } });
		await transform(off.hooks, conversation());
		off.config.compaction.auto = true;
		await overflow(off.hooks);
		expect(off.toasts.filter((toast) => toast.includes("too long"))).toEqual([]);
		// Setting auto, but the flag OpenCode read was false (the user's config or another
		// session's off): the overflow was not compacted, so the model is told.
		const auto = await load({}, { compaction: { auto: false } });
		await transform(auto.hooks, conversation());
		await overflow(auto.hooks);
		expect(auto.toasts.filter((toast) => toast.includes("too long"))).toHaveLength(1);
		expect(JSON.stringify(await transform(auto.hooks, conversation()))).toContain("automatic compaction is off, so nothing was compacted");
	});

	test("no overflow notice for an overflow of the compaction request itself", async () => {
		const h = await load({ compaction: "off" });
		await transform(h.hooks, conversation());
		await h.hooks["experimental.session.compacting"]!({ sessionID: SESSION }, { context: [], prompt: undefined });
		await transform(h.hooks, conversation().slice(0, 2));
		await overflow(h.hooks);
		expect(h.toasts.filter((toast) => toast.includes("too long"))).toEqual([]);
		// The next main request clears the mark.
		await transform(h.hooks, conversation());
		await overflow(h.hooks);
		expect(h.toasts.filter((toast) => toast.includes("too long"))).toHaveLength(1);
	});

	test("enabled: false leaves the config untouched", async () => {
		const directory = tempDir("clm-compaction-");
		const hooks = await server({ directory, worktree: directory, client: {} } as unknown as PluginInput, { enabled: false, compaction: "off" });
		const config: Record<string, unknown> = { compaction: { auto: true } };
		await hooks.config?.(config as never);
		expect(config).toEqual({ compaction: { auto: true } });
	});

	test("a pending mirror edit is committed before OpenCode compacts", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const raw = conversation();
		await clm.transform(structuredClone(raw));
		// The model edits the mirror in its final step; the user runs /compact next.
		writeFileSync(clm.mirrorPath, replaceBody(readFileSync(clm.mirrorPath, "utf8"), blockId(clm.baseline!.snapshot, "toolResult", 0), "short"));
		await clm.commitBeforeCompaction();
		expect([clm.state.revision, clm.state.lastOutcome?.kind]).toEqual([1, "applied"]);
		// The compaction's transform then sends the edited context.
		clm.compacting = true;
		const result = await clm.transform(structuredClone(raw));
		expect(toolOutput(result.messages[1], "call_1")).toBe("short");
		// Editing off: nothing is committed.
		const off = await ClmSession.open("ses_off", settings());
		await off.transform(structuredClone(raw));
		writeFileSync(off.mirrorPath, replaceBody(readFileSync(off.mirrorPath, "utf8"), blockId(off.baseline!.snapshot, "toolResult", 0), "short"));
		writeFileSync(join(off.store.directory, "overrides.json"), JSON.stringify({ version: 1, overrides: { editing: false } }));
		await off.commitBeforeCompaction();
		expect(off.state.revision).toBe(0);
	});

	test("one-tool: the second call of a response fails with the explanation", async () => {
		const h = await load({ oneTool: true });
		await transform(h.hooks, conversation());
		await before(h.hooks, "read");
		await expect(before(h.hooks, "bash")).rejects.toThrow(oneToolText("bash", 2));
		// Another session counts on its own; a new request starts again at one.
		await before(h.hooks, "read", "ses_other");
		await transform(h.hooks, conversation());
		await before(h.hooks, "read");
		await expect(before(h.hooks, "glob")).rejects.toThrow("#2");
	});

	test("one-tool: parallel calls are counted on arrival, before any await", async () => {
		const h = await load({ oneTool: true });
		await transform(h.hooks, conversation());
		const results = await Promise.allSettled([before(h.hooks, "a"), before(h.hooks, "b"), before(h.hooks, "c")]);
		expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "rejected"]);
	});

	test("one-tool off: every call runs", async () => {
		const h = await load({});
		await transform(h.hooks, conversation());
		await before(h.hooks, "a");
		await before(h.hooks, "b");
	});

	test("trailer: appended after the result, receipts included", async () => {
		const h = await load({ trailer: true });
		await transform(h.hooks, conversation());
		const output = { title: "", output: "x".repeat(400), metadata: {} };
		await h.hooks["tool.execute.after"]!({ tool: "bash", sessionID: SESSION, callID: "c1", args: { command: "ls" } }, output);
		expect(output.output).toMatch(/^x{400}\n\[context: ~[\d,]+ of 32,000 tokens after this result\]$/);
		const plain = await load({});
		await transform(plain.hooks, conversation());
		const unchanged = { title: "", output: "y", metadata: {} };
		await plain.hooks["tool.execute.after"]!({ tool: "bash", sessionID: SESSION, callID: "c1", args: {} }, unchanged);
		expect(unchanged.output).toBe("y");
	});
});
