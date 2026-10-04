// Parity block 6, server side: `/clm budget`, `/clm-compact` checks and size, the
// composition-warning toast and the toast for ignored saved settings.
import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import { COMPACT_COMMAND, server, STATUS_COMMAND } from "../index.ts";
import { ClmSession, COMPOSITION_WARNING } from "../src/clm.ts";
import { filterCompacted, type OcMessage } from "../src/opencode.ts";
import { CLM_USAGE, parseClmCommand } from "../src/panel/command.ts";
import { assistant, conversation, part, SESSION, settings, tempDir, user } from "./fixtures.ts";
import { blockId, replaceBody } from "./helpers.ts";
import { buildPanelModel } from "../src/panel/model.ts";
import { countAnnotations, readSessionDirectory } from "../src/session-files.ts";
import { resolveSettings } from "../src/settings.ts";
import { detailLines, footerText, RESET_NOW, RESET_ROW, resetRow } from "../src/tui/data.ts";

interface Harness {
	hooks: Hooks;
	mirror: string;
	toasts: Array<{ message: string; variant: string }>;
	history: OcMessage[] | undefined;
	/** `client.session.status()` data; undefined = every session idle. */
	status?: Record<string, { type: string }>;
}

async function load(options: Record<string, unknown> = {}): Promise<Harness> {
	const directory = tempDir("clm-surfaces-");
	const harness: Harness = { hooks: {} as Hooks, mirror: join(directory, "mirrors"), toasts: [], history: [] };
	const input = {
		directory,
		worktree: directory,
		client: {
			tui: { showToast: async ({ body }: { body: { message: string; variant: string } }) => harness.toasts.push(body) },
			app: { log: async () => undefined },
			session: {
				messages: async () => (harness.history ? { data: harness.history } : { error: { name: "NotFound" } }),
				status: async () => ({ data: harness.status ?? {} }),
			},
		},
	} as unknown as PluginInput;
	harness.hooks = await server(input, { mirrorDir: harness.mirror, budget: "32k", ...options });
	await harness.hooks.config!({} as never);
	return harness;
}

async function command(h: Harness, name: string, args = ""): Promise<string> {
	const output = { parts: [{ type: "text", text: "template" }] } as never as { parts: Array<{ text: string }> };
	await h.hooks["command.execute.before"]!({ command: name, sessionID: SESSION, arguments: args }, output as never);
	await Bun.sleep(1);
	return output.parts[0]!.text;
}

async function transform(h: Harness, messages: OcMessage[]): Promise<void> {
	await h.hooks["experimental.chat.messages.transform"]!({}, { messages } as never);
	await Bun.sleep(1);
}

describe("/clm budget", () => {
	test("TUI parse: shorthand for /clm config budget", () => {
		expect(parseClmCommand("/clm budget")).toEqual({ kind: "config-show", setting: "budget" });
		expect(parseClmCommand("/clm budget 64k")).toEqual({ kind: "config-set", setting: "budget", value: "64k" });
		expect(parseClmCommand("/clm BUDGET window")).toEqual({ kind: "config-set", setting: "budget", value: "window" });
		expect(CLM_USAGE).toContain("budget [value]");
	});

	test("server command: shows and changes the budget", async () => {
		const h = await load();
		expect(await command(h, STATUS_COMMAND, "budget")).toContain("Budget: 32k");
		expect(await command(h, STATUS_COMMAND, "budget 64k")).toContain("CLM Budget: 64k.");
		const overrides = JSON.parse(readFileSync(join(h.mirror, `clm-${SESSION}`, "overrides.json"), "utf8"));
		expect(overrides).toEqual({ version: 1, overrides: { budget: 64_000 } });
		expect(await command(h, STATUS_COMMAND, "budget lots")).toContain("failed");
	});

	test("server command: percentages and the default share", async () => {
		const h = await load({ budget: undefined });
		expect(await command(h, STATUS_COMMAND, "budget")).toContain("Budget: 50% — ");
		expect(await command(h, STATUS_COMMAND, "budget 25%")).toContain("CLM Budget: 25%.");
		const file = () => JSON.parse(readFileSync(join(h.mirror, `clm-${SESSION}`, "overrides.json"), "utf8"));
		expect(file()).toEqual({ version: 1, overrides: { budget: "25%" } });
		expect(await command(h, STATUS_COMMAND, "config budget 100%")).toContain("CLM Budget: 100%.");
		expect(file()).toEqual({ version: 1, overrides: { budget: "100%" } });
		expect(await command(h, STATUS_COMMAND, "budget 101%")).toContain("failed");
		expect(file()).toEqual({ version: 1, overrides: { budget: "100%" } });
		expect(await command(h, STATUS_COMMAND, "budget 50%")).toContain("CLM Budget: 50%.");
		expect(file()).toEqual({ version: 1, overrides: {} });
	});
});

describe("/clm-compact", () => {
	test("refused when CLM is off for the session", async () => {
		const h = await load();
		h.history = conversation();
		await command(h, STATUS_COMMAND, "off");
		const text = await command(h, COMPACT_COMMAND);
		expect(text).toContain("CLM is off for this session");
		expect(text).not.toContain("Compact your live context now.");
		expect(h.toasts.some((toast) => toast.variant === "warning" && toast.message.includes("CLM is off"))).toBe(true);
	});

	test("refused when the context is empty", async () => {
		const h = await load();
		h.history = [];
		const text = await command(h, COMPACT_COMMAND);
		expect(text).toContain("Nothing to compact yet");
		h.history = [user("msg_u1", "only the task")];
		expect(await command(h, COMPACT_COMMAND)).toContain("Nothing to compact yet");
	});

	test("the size is measured on the stored history when idle, with a toast", async () => {
		const h = await load();
		h.history = conversation("x".repeat(40_000));
		const text = await command(h, COMPACT_COMMAND, "keep the tests");
		expect(text).toStartWith("Compact your live context now.");
		const match = /about ([\d.,k]+) tokens/.exec(h.toasts.map((toast) => toast.message).join("\n"));
		expect(match).not.toBeNull();
		// 40k characters of tool output ≈ 10k tokens; the old figure was 0 before any request.
		expect(text).toMatch(/1\d(\.\d)?k|10,\d{3}|1\d,\d{3}/);
		expect(text).toContain("keep the tests");
	});

	test("idleEstimate follows the accepted revision", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const raw = conversation("x".repeat(8_000));
		const before = clm.idleEstimate(raw)!;
		expect(before).toBeGreaterThan(2_000);
		await clm.transform(structuredClone(raw));
		writeFileSync(clm.mirrorPath, replaceBody(readFileSync(clm.mirrorPath, "utf8"), blockId(clm.baseline!.snapshot, "toolResult", 0), "short"));
		await clm.transform(structuredClone(raw));
		expect(clm.state.checkpoint?.revision).toBe(1);
		expect(clm.idleEstimate(raw)!).toBeLessThan(before - 1_500);
		expect(clm.idleEstimate([])).toBeUndefined();
	});
});

describe("toasts", () => {
	test("the composition warning is shown once per session", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const alerts: string[] = [];
		const notices: string[] = [];
		const send = async (raw: OcMessage[]) => {
			const result = await clm.transform(structuredClone(raw));
			alerts.push(result.alert ?? "");
			notices.push(result.notices.join(" "));
		};
		const edit = () => writeFileSync(clm.mirrorPath, replaceBody(readFileSync(clm.mirrorPath, "utf8"), blockId(clm.baseline!.snapshot, "toolResult", 0), "short"));
		const histories = ["a", "b", "c", "d"].map((tag) => [
			user(`msg_${tag}1`, `Task ${tag}.`),
			assistant(`msg_${tag}2`, "Looking.", [{ callID: `call_${tag}`, output: `output ${tag} ${"z".repeat(200)}` }]),
			assistant(`msg_${tag}3`, "Done."),
		]);
		// Each request commits the edit made on the previous one, and finds the history changed
		// under it before the revision was ever used: consecutive drops.
		for (const raw of histories) {
			await send(raw);
			edit();
		}
		expect(notices.filter((notice) => notice.includes("was dropped"))).toHaveLength(3);
		expect(alerts.filter((alert) => alert.includes(COMPOSITION_WARNING))).toHaveLength(1);
	});

	test("ignored saved settings toast once, again only when the warning changes", async () => {
		const h = await load();
		await transform(h, conversation());
		const overrides = join(h.mirror, `clm-${SESSION}`, "overrides.json");
		writeFileSync(overrides, JSON.stringify({ version: 1, overrides: { budget: "lots" } }));
		await transform(h, conversation());
		await transform(h, conversation());
		const shown = () => h.toasts.filter((toast) => toast.message.includes("saved settings partly ignored"));
		expect(shown()).toHaveLength(1);
		expect(shown()[0]!.message).toContain("budget");
		writeFileSync(overrides, JSON.stringify({ version: 1, overrides: { guard: "maybe" } }));
		await transform(h, conversation());
		expect(shown()).toHaveLength(2);
	});
});

describe("TUI surfaces (pure parts)", () => {
	const base = { editing: true, settings: resolveSettings({ budget: "32k" }, {}, "/tmp") };
	const timeline = (tokens: number, measured: boolean) => ({ points: [{ tokens, measured }], markers: [], peakTokens: tokens, turnStarts: [] }) as never;

	test("footer text", () => {
		expect(footerText({ found: false, enabled: true, revision: 0, timeline: timeline(1, true) })).toBeUndefined();
		expect(footerText({ found: true, enabled: false, revision: 2, timeline: timeline(1, true) })).toBe("clm off · r2");
		expect(footerText({ found: true, enabled: true, revision: 2, timeline: timeline(12_300, true), budget: 32_000 })).toBe("clm 12k / 32k · r2");
		expect(footerText({ found: true, enabled: true, revision: 0, timeline: timeline(900, false) })).toBe("clm ~900 · r0");
		expect(footerText({ found: true, enabled: true, revision: 1, timeline: { points: [], markers: [], peakTokens: 0, turnStarts: [] } as never })).toBe("clm · r1");
	});

	test("reset row", () => {
		expect(resetRow(0)).toMatchObject({ key: RESET_ROW, label: "Reset to defaults", value: "nothing changed", choices: ["nothing changed"] });
		expect(resetRow(2)).toMatchObject({ value: "2 changed", choices: ["2 changed", RESET_NOW] });
	});

	test("detail lines: calibration, guard, steering, annotations", () => {
		expect(detailLines(base, { budgetInfo: { limit: 30_000, tooSmall: false }, calibration: { factor: 1.234, samples: 3 }, steering: { name: "brief.md", hash: "abcd1234", path: "/x/brief.md" }, annotations: { active: 2, archived: 1, total: 4 } })).toEqual([
			"Estimate ×1.23, calibrated from 3 provider counts",
			"Guard withholds the oldest tool results above 30k",
			"Steering brief.md (sha256 abcd1234…)",
			"Annotations 2 continuity/pin · 1 archive · 4 total",
		]);
		const off = { editing: true, settings: resolveSettings({ guard: "off" }, {}, "/tmp") };
		expect(detailLines(off, { calibration: { factor: 1, samples: 0 }, annotations: { active: 0, archived: 0, total: 0 } })).toEqual([
			"Estimate not calibrated yet (characters ÷ 4 until the provider reports a size)",
			"Guard off",
			"Annotations none",
		]);
		expect(detailLines(base, {})).toEqual(["Guard withholds the oldest tool results above budget − reserve"]);
	});

	test("annotation counts come from annotations.jsonl as the server reconstructs them", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const raw = conversation();
		await clm.transform(structuredClone(raw));
		const id = blockId(clm.lastSnapshot!, "toolResult", 0);
		const source = clm.blockSource(id)!;
		const create = (title: string, retention: "continuity" | "archive" | "pin") => clm.annotations.create({
			sessionId: SESSION, blockId: id, revision: source.revision, message: source.message,
			title, reason: "r", futureAction: "f", retention,
		});
		await create("one", "continuity");
		await create("two", "archive");
		await create("three", "pin");
		const files = await readSessionDirectory(clm.store.directory, SESSION);
		expect(files.annotations).toEqual({ active: 2, archived: 1, total: 3 });
		expect(buildPanelModel(files).annotations).toEqual({ active: 2, archived: 1, total: 3 });
		expect(countAnnotations("not json\n")).toEqual({ active: 0, archived: 0, total: 0 });
	});
});

/** `history` after an OpenCode compaction: compaction request, its summary, a new user turn. */
function compactedHistory(history: OcMessage[], tailStart?: string): OcMessage[] {
	const request: OcMessage = {
		info: { ...user("msg_c1", "").info },
		parts: [part("msg_c1", { type: "compaction", auto: false, ...(tailStart ? { tail_start_id: tailStart } : {}) })],
	};
	const summary = assistant("msg_s1", "Summary: the repository was inspected.");
	summary.info = { ...summary.info, parentID: "msg_c1", summary: true };
	return [...history, request, summary, user("msg_u9", "Continue.")];
}

async function idle(h: Harness): Promise<void> {
	await h.hooks.event!({ event: { type: "session.idle", properties: { sessionID: SESSION } } } as never);
}

/** A size as `formatTokens` prints it ("900", "10,046", "12k", "1.2k"), in tokens. */
function tokenFigure(text: string | undefined): number {
	if (!text) return Number.NaN;
	return text.endsWith("k") ? Number(text.slice(0, -1)) * 1_000 : Number(text.replaceAll(",", ""));
}

describe("review fixes (block 6)", () => {
	const ids = (messages: OcMessage[]) => messages.map((message) => message.info.id);

	test("filterCompacted: no compaction leaves the history unchanged", () => {
		const raw = conversation();
		expect(ids(filterCompacted(raw))).toEqual(ids(raw));
	});

	test("filterCompacted: a completed compaction starts the history at its request", () => {
		expect(ids(filterCompacted(compactedHistory(conversation())))).toEqual(["msg_c1", "msg_s1", "msg_u9"]);
	});

	test("filterCompacted: an unfinished summary does not cut the history", () => {
		const raw = compactedHistory(conversation());
		const summary = raw.find((message) => message.info.id === "msg_s1")!;
		summary.info = { ...summary.info, finish: undefined };
		expect(ids(filterCompacted(raw))).toEqual(ids(raw));
	});

	test("filterCompacted: a retained tail follows the summary", () => {
		const raw = compactedHistory([...conversation(), user("msg_u5", "Next."), assistant("msg_a5", "Done next.")], "msg_u5");
		expect(ids(filterCompacted(raw))).toEqual(["msg_c1", "msg_s1", "msg_u5", "msg_a5", "msg_u9"]);
	});

	test("/clm-compact measures only what OpenCode sends after a compaction", async () => {
		const full = await load();
		full.history = conversation("x".repeat(40_000));
		await command(full, COMPACT_COMMAND);
		const compacted = await load();
		compacted.history = compactedHistory(conversation("x".repeat(40_000)));
		await command(compacted, COMPACT_COMMAND);
		const size = (h: Harness) => h.toasts.map((toast) => /about ([\d.,k]+) tokens/.exec(toast.message)?.[1]).find(Boolean);
		expect(tokenFigure(size(full))).toBeGreaterThan(9_000);
		expect(tokenFigure(size(compacted))).toBeLessThan(2_000);
	});

	test("/clm-compact toast and prompt give the same size, within range", async () => {
		const h = await load();
		h.history = conversation("x".repeat(40_000));
		const text = await command(h, COMPACT_COMMAND);
		const figure = /about ([\d.,k]+) tokens/.exec(h.toasts.map((toast) => toast.message).join("\n"))?.[1];
		expect(tokenFigure(figure)).toBeGreaterThan(9_000);
		expect(tokenFigure(figure)).toBeLessThan(13_000);
		expect(text).toContain(figure!);
	});

	test("/clm-compact while the session runs says the size predates the run's end", async () => {
		const h = await load();
		h.history = conversation("x".repeat(4_000));
		h.status = { [SESSION]: { type: "busy" } };
		await command(h, COMPACT_COMMAND);
		expect(h.toasts.some((toast) => toast.message.includes("measured before the current run finishes"))).toBe(true);
		h.status = {};
		await idle(h);
		await command(h, COMPACT_COMMAND);
		expect(h.toasts.at(-1)!.message).toContain("Asked the model to compact");
		expect(h.toasts.at(-1)!.message).not.toContain("measured before");
	});

	test("/clm-compact reads the compact prompt the saved settings name", async () => {
		const h = await load();
		h.history = conversation("x".repeat(4_000));
		await transform(h, conversation());
		const template = join(tempDir("clm-template-"), "compact.md");
		writeFileSync(template, "Own compact prompt: {{current}}");
		writeFileSync(join(h.mirror, `clm-${SESSION}`, "overrides.json"), JSON.stringify({ version: 1, overrides: { compactPrompt: template } }));
		expect(await command(h, COMPACT_COMMAND)).toStartWith("Own compact prompt:");
	});

	test("a base steering document that does not load toasts once, not as ignored saved settings", async () => {
		const h = await load({ steering: join(tempDir("clm-steer-"), "missing.md") });
		await transform(h, conversation());
		await transform(h, conversation());
		expect(h.toasts.filter((toast) => toast.message.includes("steering document not loaded"))).toHaveLength(1);
		expect(h.toasts.some((toast) => toast.message.includes("saved settings partly ignored"))).toBe(false);
		expect(await command(h, STATUS_COMMAND, "status")).toContain("steering document not loaded");
	});

	test("alerts raised while CLM is off are still shown", async () => {
		const h = await load();
		await transform(h, conversation());
		writeFileSync(join(h.mirror, `clm-${SESSION}`, "overrides.json"), JSON.stringify({ version: 1, overrides: { editing: false, budget: "lots" } }));
		await transform(h, conversation());
		expect(h.toasts.filter((toast) => toast.message.includes("saved settings partly ignored"))).toHaveLength(1);
	});

	test("a second /clm-compact is refused until the model receives the first", async () => {
		const h = await load();
		h.history = conversation("x".repeat(4_000));
		const first = await command(h, COMPACT_COMMAND);
		expect(first).toStartWith("Compact your live context now.");
		const second = await command(h, COMPACT_COMMAND);
		expect(second).toContain("already queued");
		expect(second).not.toContain("Compact your live context now.");
		expect(h.toasts.at(-1)!.message).toContain("already queued");
		// A request without the prompt (the running step) keeps it pending.
		await transform(h, conversation("x".repeat(4_000)));
		expect(await command(h, COMPACT_COMMAND)).toContain("already queued");
		// The request that carries the prompt ends it.
		await transform(h, [...conversation("x".repeat(4_000)), user("msg_u7", first)]);
		expect(await command(h, COMPACT_COMMAND)).toStartWith("Compact your live context now.");
	});

	test("two /clm-compact invocations at once: only one prompt is sent", async () => {
		const h = await load();
		h.history = conversation("x".repeat(4_000));
		const replies = await Promise.all([command(h, COMPACT_COMMAND), command(h, COMPACT_COMMAND)]);
		expect(replies.filter((reply) => reply.startsWith("Compact your live context now."))).toHaveLength(1);
		expect(replies.filter((reply) => reply.includes("already queued"))).toHaveLength(1);
	});

	test("a refused /clm-compact (CLM off) leaves nothing pending", async () => {
		const h = await load();
		h.history = conversation("x".repeat(4_000));
		await transform(h, conversation());
		writeFileSync(join(h.mirror, `clm-${SESSION}`, "overrides.json"), JSON.stringify({ version: 1, overrides: { editing: false } }));
		expect(await command(h, COMPACT_COMMAND)).toContain("CLM is off");
		rmSync(join(h.mirror, `clm-${SESSION}`, "overrides.json"));
		expect(await command(h, COMPACT_COMMAND)).toStartWith("Compact your live context now.");
	});

	test("a pending /clm-compact ends when the session goes idle without it", async () => {
		const h = await load();
		h.history = conversation("x".repeat(4_000));
		await command(h, COMPACT_COMMAND);
		expect(await command(h, COMPACT_COMMAND)).toContain("already queued");
		await idle(h);
		expect(await command(h, COMPACT_COMMAND)).toStartWith("Compact your live context now.");
	});
});
