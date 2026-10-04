// `mode notices-only`: budget notices, reminders and the guard without a mirror or edits.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import { COMPACT_COMMAND, server, STATUS_COMMAND } from "../index.ts";
import { budgetFit, budgetNoticeText, budgetTooSmallNoticeText, type BudgetReading } from "../src/budget.ts";
import { nativeCompactionText, overflowNotCompactedText, thresholdCancelledNoticeText } from "../src/compaction.ts";
import { ClmSession } from "../src/clm.ts";
import type { OcMessage } from "../src/opencode.ts";
import { changeSetting, writeOverrides } from "../src/overrides.ts";
import { buildPanelModel } from "../src/panel/model.ts";
import { plain } from "../src/panel/lines.ts";
import { initialPanelState, renderPanel } from "../src/panel/view.ts";
import { statusLine, statusText } from "../src/presentation.ts";
import {
	applyOverrides,
	changedSummary,
	mergeOverrides,
	sanitizeOverrides,
	settingDescriptor,
	settingsAsOverrides,
} from "../src/settings-table.ts";
import { resolveSettings } from "../src/settings.ts";
import { detailLines, footerText, serverBase, settingsView } from "../src/tui/data.ts";
import { statusSummary } from "../src/tui/plugin.ts";
import { assistant, conversation, SESSION, settings, tempDir, toolOutput } from "./fixtures.ts";
import { blockId, replaceBody } from "./helpers.ts";
import { basicEvents, files } from "./panel/fixtures.ts";
import { richModel } from "./panel/model-fixture.ts";

const NOTICES = { mode: "notices-only" };
const joined = (notices: string[]) => notices.join("\n");

describe("mode setting", () => {
	test("option, environment, precedence, alias and invalid values", () => {
		expect(resolveSettings({}, {}, "/p").mode).toBe("edit");
		expect(resolveSettings({ mode: "notices-only" }, {}, "/p").mode).toBe("notices-only");
		expect(resolveSettings({}, { CLM_MODE: "notices" }, "/p").mode).toBe("notices-only");
		expect(resolveSettings({}, { CLM_MODE: " NOTICES-ONLY " }, "/p").mode).toBe("notices-only");
		expect(resolveSettings({ mode: "edit" }, { CLM_MODE: "notices-only" }, "/p").mode).toBe("edit");
		expect(() => resolveSettings({ mode: "quiet" }, {}, "/p")).toThrow('mode must be edit or notices-only, got "quiet"');
		expect(() => resolveSettings({}, { CLM_MODE: "on" }, "/p")).toThrow("mode must be edit or notices-only");
	});

	test("settings-table round trip: parse, merge, sanitize, apply, server base, summary", async () => {
		const base = resolveSettings({}, {}, "/p");
		const values = { editing: true, settings: base };
		const descriptor = settingDescriptor("MODE")!;
		expect(descriptor.key).toBe("mode");
		expect(descriptor.description).toMatch(/Env: CLM_MODE\.$/);
		expect(descriptor.parse("notices", { directory: "/p" })).toEqual({ mode: "notices-only" });
		expect(descriptor.parse("Edit", { directory: "/p" })).toEqual({ mode: "edit" });
		expect(() => descriptor.parse("off", { directory: "/p" })).toThrow("mode must be edit or notices-only");

		expect(mergeOverrides(values, {}, { mode: "notices-only" })).toEqual({ mode: "notices-only" });
		expect(mergeOverrides(values, { mode: "notices-only" }, { mode: "edit" })).toEqual({});
		expect(sanitizeOverrides({ mode: "notices-only" })).toEqual({ overrides: { mode: "notices-only" }, ignored: [] });
		expect(sanitizeOverrides({ mode: "loud" })).toEqual({ overrides: {}, ignored: ["mode"] });

		const effective = applyOverrides(base, { mode: "notices-only" });
		expect(effective.mode).toBe("notices-only");
		expect(descriptor.format({ editing: true, settings: effective })).toBe("notices-only");
		expect(changedSummary(values, { editing: true, settings: effective })).toBe("mode notices-only");
		expect(settingsAsOverrides(effective).mode).toBe("notices-only");
		expect(serverBase(base, { base: settingsAsOverrides(effective) }).base.mode).toBe("notices-only");

		const clm = await ClmSession.open(SESSION, settings());
		const result = await changeSetting(clm.changeRequest("/p"), "mode", "notices");
		expect(result.text).toBe("Mode: notices-only");
		expect(JSON.parse(readFileSync(join(clm.store.directory, "overrides.json"), "utf8"))).toEqual({ version: 1, overrides: { mode: "notices-only" } });
	});
});

describe("notices-only requests", () => {
	test("carry the raw history: no mirror file, no baseline, mirror blocks 0", async () => {
		const clm = await ClmSession.open(SESSION, settings(NOTICES));
		const raw = conversation();
		const result = await clm.transform(structuredClone(raw));
		expect(result.messages).toEqual(raw);
		expect(existsSync(clm.mirrorPath)).toBe(false);
		expect(clm.baseline).toBeUndefined();
		expect(clm.lastRequest).toEqual({ rawMessages: 3, sentMessages: 3, mirrorBlocks: 0 });
		// The panel still gets its snapshot of the request.
		expect(existsSync(join(clm.store.directory, "snapshot.json"))).toBe(true);
	});

	test("reminders fire with the notices-only wording", async () => {
		const clm = await ClmSession.open(SESSION, settings({ ...NOTICES, budget: 2000, reserve: 100, guard: "off" }));
		const half = joined((await clm.transform(conversation("x".repeat(4000)))).notices);
		expect(half).toContain("[CLM BUDGET] Context crossed 50% of a 2,000-token budget");
		expect(half).toContain("tokens remain; the final reminder comes at 1,900 tokens.");
		expect(half).not.toContain("reorganize");
		expect(half).not.toContain("Summaries");
		expect(half).not.toContain("LIVE_CONTEXT");

		const reserve = joined((await clm.transform(conversation("x".repeat(7800)))).notices);
		expect(reserve).toContain("inside the 100-token generation reserve.");
		expect(reserve).not.toContain("Edit ");
		expect(reserve).not.toContain("mirror");
	});

	test("the overflow guard withholds above budget − reserve, with a notice that names no edit", async () => {
		const clm = await ClmSession.open(SESSION, settings({ ...NOTICES, budget: 1500, reserve: 100, remindAt: "off" }));
		const result = await clm.transform(conversation("x".repeat(20000)));
		expect(String(toolOutput(result.messages[1], "call_1"))).toStartWith("[clm overflow guard] bash#call_1");
		expect(result.reading!.estimated).toBeLessThanOrEqual(1400);
		const notice = joined(result.notices);
		expect(notice).toContain("Overflow guard");
		expect(notice).toContain("Re-read only the parts you need");
		expect(notice).not.toContain("mirror");
		expect(notice).not.toContain("edit your context");
	});

	test("the observation cap still applies", async () => {
		const clm = await ClmSession.open(SESSION, settings({ ...NOTICES, observationCap: "500" }));
		const result = await clm.transform(conversation("x".repeat(5000)));
		expect(String(toolOutput(result.messages[1], "call_1"))).toContain("[clm observation cap: 500 of");
	});

	test("a mirror write is never applied, and the receipt stays silent", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const raw = conversation();
		await clm.transform(structuredClone(raw));
		const edited = replaceBody(readFileSync(clm.mirrorPath, "utf8"), blockId(clm.baseline!.snapshot, "toolResult", 0), "tiny");
		const write = { command: `sed -i s/a/b/ ${clm.mirrorPath}` };
		await writeOverrides(clm.store.directory, NOTICES as never);
		await clm.refreshSettings(true);
		writeFileSync(clm.mirrorPath, edited);
		expect(clm.receipt("bash", write, "/")).toBeUndefined();
		const result = await clm.transform(structuredClone(raw));
		expect(String(toolOutput(result.messages[1], "call_1"))).toStartWith("big output");
		expect(clm.state.revision).toBe(0);
		expect(joined(result.notices)).not.toContain("Applied");
		expect(() => clm.blockSource("1-abc")).toThrow("notices-only mode");
	});

	test("switching mode mid-session keeps the accepted revision and applies it again in edit", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const raw = conversation();
		await clm.transform(structuredClone(raw));
		writeFileSync(clm.mirrorPath, replaceBody(readFileSync(clm.mirrorPath, "utf8"), blockId(clm.baseline!.snapshot, "toolResult", 0), "tiny"));
		const applied = await clm.transform(structuredClone(raw));
		expect(toolOutput(applied.messages[1], "call_1")).toBe("tiny");

		await writeOverrides(clm.store.directory, NOTICES as never);
		await clm.refreshSettings(true);
		const grown = [...structuredClone(raw), assistant("msg_a3", "More.", [{ callID: "call_3", output: "new" }])];
		const notices = await clm.transform(structuredClone(grown));
		expect(String(toolOutput(notices.messages[1], "call_1"))).toStartWith("big output");
		expect(clm.state.checkpoint?.revision).toBe(1);
		expect(joined(notices.notices)).not.toContain("dropped");
		expect(statusText(clm.status())).toContain("revision 1 kept but not applied in notices-only mode");

		// OpenCode's compaction in notices-only summarizes the raw history.
		clm.compacting = true;
		const head = structuredClone(grown);
		expect((await clm.transform(head)).messages).toBe(head);

		await writeOverrides(clm.store.directory, {});
		await clm.refreshSettings(true);
		const back = await clm.transform(structuredClone(grown));
		expect(toolOutput(back.messages[1], "call_1")).toBe("tiny");
		expect(toolOutput(back.messages[3], "call_3")).toBe("new");
		expect(joined(back.notices)).not.toContain("dropped");
		expect(existsSync(clm.mirrorPath)).toBe(true);
	});

	test("status text and line name the mode", async () => {
		const clm = await ClmSession.open(SESSION, settings(NOTICES));
		await clm.transform(conversation());
		const text = statusText(clm.status());
		expect(text).toContain("mirror: not used (mode notices-only)");
		expect(text).toContain("mode notices-only: budget notices and the overflow guard run");
		expect(statusLine(clm.status())).toStartWith("CLM r0 · mode notices-only · ");
		const edit = await ClmSession.open("ses_edit", settings());
		expect(statusLine(edit.status())).not.toContain("mode");
		expect(statusText(edit.status())).not.toContain("notices-only");
	});
});

describe("budgetNoticeText", () => {
	const reading: BudgetReading = { budget: 10_000, reserve: 500, source: "config", estimated: 8_000, calibration: 1 } as BudgetReading;
	test("notices-only drops the mirror and keeps measurement, budget, remainder and guard", () => {
		const tier = { label: "75%", tokens: 7_500 } as never;
		const edit = budgetNoticeText(reading, tier, "/m/LIVE_CONTEXT.md");
		const notices = budgetNoticeText(reading, tier, undefined, 9_500, { noticesOnly: true });
		expect(edit).toContain("You may reorganize /m/LIVE_CONTEXT.md");
		expect(notices).toBe(
			"[CLM BUDGET] Context crossed 75% of a 10,000-token budget: estimated 8,000 tokens for the next request; " +
				"provider-reported size of the previous request unknown. 2,000 tokens remain; the final reminder comes at 9,500 tokens. " +
				"Above 9,500 tokens the overflow guard holds back the oldest new tool results and saves them to files.",
		);
		const quarter = budgetNoticeText(reading, { label: "50%", tokens: 5_000 } as never, undefined, 9_500, { noticesOnly: true });
		expect(quarter).not.toContain("Summaries");
		expect(quarter).not.toContain("overflow guard");
	});
});

describe("other model notices in notices-only", () => {
	test("name no mirror", () => {
		expect(overflowNotCompactedText(undefined)).toEndWith("so nothing was compacted. Ask the user to run /compact.");
		expect(overflowNotCompactedText("/m")).toContain("editing /m");
		expect(thresholdCancelledNoticeText(undefined)).not.toContain("edit");
		expect(nativeCompactionText(false, "auto", true)).not.toContain("edits");
		expect(nativeCompactionText(false, "auto")).toContain("model's own edits");
		const capped = budgetFit(4_000, 500, 3_800, 4_200);
		expect(capped.capped).toBe(true);
		expect(budgetTooSmallNoticeText(capped)).toContain("keep the context mirror short");
		expect(budgetTooSmallNoticeText(capped, { noticesOnly: true })).not.toContain("mirror");
	});
});

interface Harness {
	hooks: Hooks;
	directory: string;
	toasts: string[];
}

async function load(options: Record<string, unknown>): Promise<Harness> {
	const directory = tempDir("clm-notices-");
	const toasts: string[] = [];
	const input = {
		directory,
		worktree: directory,
		client: { tui: { showToast: async ({ body }: { body: { message: string } }) => toasts.push(body.message) }, app: { log: async () => undefined } },
	} as unknown as PluginInput;
	const hooks = await server(input, { mirrorDir: join(directory, "mirrors"), ...options });
	if (hooks.config) await hooks.config({} as never);
	return { hooks, directory, toasts };
}

const mirrorFile = (h: Harness) => join(h.directory, "mirrors", `clm-${SESSION}`, "LIVE_CONTEXT.md");

async function system(h: Harness, prompt: string[]) {
	const output = { system: prompt };
	await h.hooks["experimental.chat.system.transform"]!({ sessionID: SESSION, model: { limit: { context: 100_000, output: 8_000 } } as never }, output);
	return output.system;
}

async function transform(h: Harness, messages: OcMessage[]) {
	const output = { messages } as never as { messages: OcMessage[] };
	await h.hooks["experimental.chat.messages.transform"]!({}, output as never);
	return output.messages;
}

async function command(h: Harness, name: string, args = "") {
	const output = { parts: [{ type: "text", text: "template" }] } as never as { parts: Array<{ text: string }> };
	await h.hooks["command.execute.before"]!({ command: name, sessionID: SESSION, arguments: args }, output as never);
	return output.parts[0]!.text;
}

async function afterTool(h: Harness, args: Record<string, unknown>) {
	const output = { title: "", output: "ok\n", metadata: {} };
	await h.hooks["tool.execute.after"]!({ tool: "bash", sessionID: SESSION, callID: "call_x", args }, output);
	return output.output;
}

describe("notices-only through the plugin hooks", () => {
	test("no protocol section; the steering document is still appended", async () => {
		const brief = join(tempDir(), "brief.md");
		writeFileSync(brief, "Keep the context small.");
		const steered = await load({ ...NOTICES, steering: brief });
		const prompt = await system(steered, ["base"]);
		expect(prompt).toHaveLength(2);
		expect(prompt[1]).toContain("Keep the context small.");
		expect(prompt[1]).not.toContain("## Editable context");

		const bare = await load(NOTICES);
		expect(await system(bare, ["base"])).toEqual(["base"]);
	});

	test("requests write no mirror, the receipt is silent, the trailer runs, /clm-compact refuses", async () => {
		const h = await load({ ...NOTICES, budget: 20_000, trailer: true });
		await system(h, ["base"]);
		await transform(h, structuredClone(conversation()));
		expect(existsSync(mirrorFile(h))).toBe(false);
		const output = await afterTool(h, { command: `sed -i s/a/b/ ${mirrorFile(h)}` });
		expect(output).not.toContain("[CLM]");
		expect(output).toMatch(/\[context: ~[\d,]+ of 20,000 tokens after this result\]$/);

		const compact = await command(h, COMPACT_COMMAND);
		expect(compact).toContain("[CLM] CLM runs in notices-only mode for this session, so the model cannot edit its context.");
		expect(h.toasts.at(-1)).toContain("notices-only mode");
		expect(await command(h, STATUS_COMMAND, "path")).toContain("CLM mirror: not used (mode notices-only)");
		expect(await command(h, STATUS_COMMAND, "on")).toContain("notices-only mode");
	});

	test("/clm config mode switches a session from edit to notices-only", async () => {
		const h = await load({});
		const prompt = await system(h, ["base"]);
		expect(prompt[1]).toContain("## Editable context");
		expect(await command(h, STATUS_COMMAND, "config mode notices")).toContain("CLM Mode: notices-only.");
		expect(await system(h, ["base"])).toEqual(["base"]);
		expect(await command(h, STATUS_COMMAND, "")).toContain("mode notices-only");
	});
});

describe("panel and TUI surfaces", () => {
	const timeline = { points: [{ tokens: 12_300, measured: true }], markers: [], peakTokens: 12_300, turnStarts: [] } as never;

	test("footer, toast summary, details and settings rows", () => {
		expect(footerText({ found: true, enabled: true, revision: 2, timeline, budget: 32_000, noticesOnly: true })).toBe("clm notices-only 12k / 32k · r2");
		expect(footerText({ found: true, enabled: false, revision: 2, timeline, noticesOnly: true })).toBe("clm off · r2");

		const model = buildPanelModel(files({ events: basicEvents }));
		model.noticesOnly = true;
		expect(statusSummary(model)).toStartWith("CLM on · mode notices-only · revision 2");

		const base = { editing: true, settings: resolveSettings({}, {}, "/tmp") };
		const effective = { editing: true, settings: resolveSettings({ mode: "notices-only" }, {}, "/tmp") };
		expect(detailLines(effective, model)).toContain("Mode notices-only: budget notices and the guard run; no mirror, the model cannot edit its context");
		expect(detailLines(base, model).some((line) => line.startsWith("Mode"))).toBe(false);
		const view = settingsView({ base, effective }, model);
		expect(view.rows.find((row) => row.key === "mode")).toMatchObject({ value: "notices-only", changed: true, choices: ["edit", "notices-only"] });
		expect(view.changed).toEqual(["mode"]);
	});

	test("the panel header and overview state the mode", () => {
		const model = richModel();
		model.noticesOnly = true;
		const screen = renderPanel(model, initialPanelState(), { width: 120, height: 30 }).map(plain).join("\n");
		expect(screen).toContain("Live Context Viewer · r2 · notices-only");
		expect(screen).toContain("Mode notices-only: requests carry the raw history plus the budget notices");
		const edit = renderPanel(richModel(), initialPanelState(), { width: 120, height: 30 }).map(plain).join("\n");
		expect(edit).not.toContain("notices-only");
	});
});
