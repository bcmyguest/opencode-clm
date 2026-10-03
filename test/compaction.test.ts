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
	lastFinishedStep,
	nativeCompactionText,
	oneToolText,
	openCodeCount,
	openCodeMaxOutput,
	openCodeUsable,
	outputTokenMaxFlag,
	overflowNotCompactedText,
	sizeTrailer,
	thresholdReachable,
	ThresholdWatch,
	ToolCallCounter,
} from "../src/compaction.ts";
import type { OcMessage } from "../src/opencode.ts";
import { resolveSettings } from "../src/settings.ts";
import { applyOverrides, sanitizeOverrides, settingDescriptor, settingsAsOverrides } from "../src/settings-table.ts";
import { assistant, conversation, SESSION, settings, tempDir, toolOutput } from "./fixtures.ts";
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

// ---- K1 / K5: OpenCode's threshold, paused under `auto` -----------------------------------

describe("OpenCode threshold", () => {
	test("usable and count follow session/overflow.ts", () => {
		// No input limit: window minus min(output, 32k) (or 32k when output is 0).
		expect(openCodeUsable({ context: 128_000, output: 8_000 }, undefined)).toBe(120_000);
		expect(openCodeUsable({ context: 128_000, output: 64_000 }, undefined)).toBe(96_000);
		expect(openCodeUsable({ context: 128_000 }, undefined)).toBe(96_000);
		// Input limit: minus `compaction.reserved`, else min(20k, max output).
		expect(openCodeUsable({ context: 200_000, input: 150_000, output: 8_000 }, undefined)).toBe(142_000);
		expect(openCodeUsable({ context: 200_000, input: 150_000, output: 64_000 }, undefined)).toBe(130_000);
		expect(openCodeUsable({ context: 200_000, input: 150_000, output: 64_000 }, 5_000)).toBe(145_000);
		// The output-cap flag: the lower of the two call sites wins.
		expect(openCodeUsable({ context: 128_000, output: 64_000 }, undefined, 48_000)).toBe(80_000);
		expect(openCodeUsable({ context: 128_000, output: 64_000 }, undefined, 16_000)).toBe(96_000);
		expect([openCodeUsable({}, undefined), openCodeUsable({ context: 0 }, undefined)]).toEqual([undefined, undefined]);
		expect([openCodeMaxOutput(8_000), openCodeMaxOutput(undefined), openCodeMaxOutput(64_000, 48_000)]).toEqual([8_000, 32_000, 48_000]);
		expect([outputTokenMaxFlag({ OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "4096" }), outputTokenMaxFlag({ OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "-1" }), outputTokenMaxFlag({})]).toEqual([4096, undefined, undefined]);
		expect(openCodeCount({ total: 900, input: 1 })).toBe(900);
		expect(openCodeCount({ input: 100, output: 20, cache: { read: 300, write: 4 } })).toBe(424);
		expect([thresholdReachable(90_000, 120_000, 30_000), thresholdReachable(89_999, 120_000, 30_000)]).toEqual([true, false]);
	});

	test("lastFinishedStep: the newest finished assistant, summaries skipped", () => {
		const raw = conversation();
		expect(lastFinishedStep(raw)?.id).toBe("msg_a2");
		const open = assistant("msg_a3", "streaming", [], 99);
		delete (open.info as { finish?: string }).finish;
		expect(lastFinishedStep([...raw, open])?.id).toBe("msg_a2");
		const summary = assistant("msg_a4", "summary", [], 5);
		summary.info.summary = true;
		expect(lastFinishedStep([...raw, summary])).toBeUndefined();
		expect(lastFinishedStep([raw[0]!])).toBeUndefined();
	});

	test("ThresholdWatch: one report per crossing, only under the plugin's flag", () => {
		const watch = new ThresholdWatch();
		expect(watch.observe("s", { id: "a", count: 500 }, 100)).toBeUndefined(); // nothing recorded yet
		watch.set("s", undefined);
		expect(watch.observe("s", { id: "b", count: 500 }, 100)).toBeUndefined(); // the user's flag: OpenCode compacted
		watch.set("s", "auto");
		expect(watch.observe("s", { id: "c", count: 500 }, 100)).toEqual({ count: 500, by: "auto" });
		expect(watch.observe("s", { id: "c", count: 500 }, 100)).toBeUndefined(); // same step
		expect(watch.observe("s", { id: "d", count: 600 }, 100)).toBeUndefined(); // same crossing
		expect(watch.observe("s", { id: "e", count: 50 }, 100)).toBeUndefined(); // below: re-armed
		watch.set("s", "off");
		expect(watch.observe("s", { id: "f", count: 200 }, 100)).toEqual({ count: 200, by: "off" });
		watch.reset("s");
		expect(watch.observe("s", { id: "g", count: 200 }, 100)).toEqual({ count: 200, by: "off" });
		expect(watch.observe("s", { id: "h", count: 200 }, undefined)).toBeUndefined();
	});
});

describe("hooks: threshold compaction under auto (K1, K5)", () => {
	const limits = (hooks: Hooks, limit: Record<string, number>) =>
		hooks["experimental.chat.system.transform"]!({ sessionID: SESSION, model: { limit } } as never, { system: [] });
	/** The conversation plus one finished step whose provider count is `count`. */
	const withStep = (id: string, count: number) => [...conversation(), assistant(id, "step", [], count - 10)];

	test("the flag is off only for requests that can reach the threshold", async () => {
		const h = await load({}, { compaction: { auto: true } });
		await transform(h.hooks, conversation());
		expect(h.config.compaction.auto).toBe(true); // no model limits yet
		await limits(h.hooks, { context: 200_000, output: 8_000 });
		await transform(h.hooks, conversation());
		expect(h.config.compaction.auto).toBe(true); // ~1k + 8k output, far below 192k
		await limits(h.hooks, { context: 10_000, output: 8_000 });
		await transform(h.hooks, conversation());
		expect(h.config.compaction.auto).toBe(false); // usable 2k: paused
		await limits(h.hooks, { context: 200_000, input: 100_000, output: 8_000 });
		await transform(h.hooks, conversation());
		expect(h.config.compaction.auto).toBe(true); // usable 92k: restored
		expect(h.toasts).toEqual([]);
	});

	test("no pause with the guard off, the user's auto false, or a mode other than auto", async () => {
		for (const [options, config, expected] of [
			[{ guard: "off" }, { compaction: { auto: true } }, true],
			[{}, { compaction: { auto: false } }, false],
			[{ compaction: "on" }, { compaction: { auto: true } }, true],
		] as const) {
			const h = await load(options, structuredClone(config));
			await limits(h.hooks, { context: 10_000, output: 8_000 });
			await transform(h.hooks, withStep("msg_a3", 5_000));
			await transform(h.hooks, withStep("msg_a4", 6_000));
			expect(h.config.compaction.auto).toBe(expected);
			expect(h.toasts.filter((toast) => toast.includes("threshold compaction"))).toEqual([]);
		}
	});

	test("a paused threshold compaction is reported once per crossing (toast, no notice)", async () => {
		const h = await load({}, { compaction: { auto: true } });
		await limits(h.hooks, { context: 10_000, output: 8_000 });
		await transform(h.hooks, conversation()); // paused for this request
		const sent = await transform(h.hooks, withStep("msg_a3", 5_000));
		const paused = h.toasts.filter((toast) => toast.includes("Paused OpenCode's threshold compaction"));
		expect(paused).toHaveLength(1);
		expect(paused[0]).toContain("counted 5,000 of OpenCode's 2,000-token threshold");
		expect(JSON.stringify(sent)).not.toContain("was cancelled");
		await transform(h.hooks, withStep("msg_a4", 5_500));
		expect(h.toasts.filter((toast) => toast.includes("Paused"))).toHaveLength(1);
		// A compaction re-arms it.
		await h.hooks.event!({ event: { type: "session.compacted", properties: { sessionID: SESSION } } as never });
		await transform(h.hooks, withStep("msg_a5", 5_500));
		expect(h.toasts.filter((toast) => toast.includes("Paused"))).toHaveLength(2);
		const events = readFileSync(join(h.mirror, `clm-${SESSION}`, "events.jsonl"), "utf8");
		expect(events).toContain('"compaction-cancelled"');
		expect(events).toContain('"compaction-pause"');
	});

	test("off: a cancelled threshold compaction gets a notice and a toast", async () => {
		const h = await load({ compaction: "off" }, { compaction: { auto: true } });
		await limits(h.hooks, { context: 10_000, output: 8_000 });
		await transform(h.hooks, conversation());
		const sent = await transform(h.hooks, withStep("msg_a3", 5_000));
		expect(JSON.stringify(sent)).toContain("automatic compaction (threshold) was cancelled");
		expect(h.toasts.filter((toast) => toast.includes("Cancelled OpenCode's threshold compaction"))).toHaveLength(1);
		// Below the threshold nothing is said.
		const quiet = await load({ compaction: "off" }, { compaction: { auto: true } });
		await limits(quiet.hooks, { context: 10_000, output: 8_000 });
		await transform(quiet.hooks, conversation());
		await transform(quiet.hooks, withStep("msg_a3", 1_000));
		expect(quiet.toasts).toEqual([]);
	});

	test("a subagent's request does not undo the parent's pause: its tool call re-applies it", async () => {
		const h = await load({}, { compaction: { auto: true } });
		await limits(h.hooks, { context: 10_000, output: 8_000 });
		await transform(h.hooks, conversation());
		expect(h.config.compaction.auto).toBe(false);
		// The `task` tool's child session: no model limits, so not paused, the user's value.
		const child = conversation().map((message) => ({ ...message, info: { ...message.info, sessionID: "ses_child" } }));
		await transform(h.hooks, child);
		expect(h.config.compaction.auto).toBe(true);
		// The parent's task call returns before OpenCode's finish-step check of the parent.
		await h.hooks["tool.execute.after"]!({ tool: "task", sessionID: SESSION, callID: "c_task", args: {} }, { title: "", output: "done", metadata: {} });
		expect(h.config.compaction.auto).toBe(false);
		// The child's own tool calls keep the child's value.
		await h.hooks["tool.execute.after"]!({ tool: "bash", sessionID: "ses_child", callID: "c_b", args: {} }, { title: "", output: "x", metadata: {} });
		expect(h.config.compaction.auto).toBe(true);
	});

	test("a finished subagent hands the flag back to the newest other session's decision", async () => {
		const h = await load({}, { compaction: { auto: true } });
		await limits(h.hooks, { context: 10_000, output: 8_000 });
		await transform(h.hooks, conversation());
		const child = conversation().map((message) => ({ ...message, info: { ...message.info, sessionID: "ses_child" } }));
		await transform(h.hooks, child);
		expect(h.config.compaction.auto).toBe(true);
		// The parent's task call threw (no tool.execute.after); the child's idle event restores the parent's pause.
		await h.hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } as never });
		expect(h.config.compaction.auto).toBe(false);
		// The last session going idle keeps its own value for its next prompt's pre-step check.
		await h.hooks.event!({ event: { type: "session.idle", properties: { sessionID: SESSION } } as never });
		expect(h.config.compaction.auto).toBe(false);
	});

	test("a failed transform or open leaves no pause behind", async () => {
		const h = await load({}, { compaction: { auto: true } });
		await limits(h.hooks, { context: 10_000, output: 8_000 });
		await transform(h.hooks, conversation());
		expect(h.config.compaction.auto).toBe(false);
		const original = ClmSession.prototype.transform;
		ClmSession.prototype.transform = async () => {
			throw new Error("boom");
		};
		try {
			await transform(h.hooks, conversation());
		} finally {
			ClmSession.prototype.transform = original;
		}
		expect(h.config.compaction.auto).toBe(true);
		expect(h.toasts.some((toast) => toast.includes("transform failed: boom"))).toBe(true);
		// Paused again, then a session that cannot open (an invalid id) sends raw history.
		await transform(h.hooks, conversation());
		expect(h.config.compaction.auto).toBe(false);
		await transform(h.hooks, conversation().map((message) => ({ ...message, info: { ...message.info, sessionID: "bad/id" } })));
		expect(h.config.compaction.auto).toBe(true);
	});

	test("a pause on a config without `compaction` leaves none behind", async () => {
		const h = await load({});
		await limits(h.hooks, { context: 10_000, output: 8_000 });
		await transform(h.hooks, conversation());
		expect(h.config.compaction).toEqual({ auto: false });
		await limits(h.hooks, { context: 200_000, output: 8_000 });
		await transform(h.hooks, conversation());
		expect(h.config.compaction).toBeUndefined();
	});

	test("a provider overflow while paused still gets the overflow notice", async () => {
		const h = await load({}, { compaction: { auto: true } });
		await limits(h.hooks, { context: 10_000, output: 8_000 });
		await transform(h.hooks, conversation());
		expect(h.config.compaction.auto).toBe(false);
		await h.hooks.event!({ event: { type: "session.error", properties: { sessionID: SESSION, error: { name: "ContextOverflowError" } } } as never });
		expect(h.toasts.filter((toast) => toast.includes("too long"))).toHaveLength(1);
	});
});
