import { describe, expect, test } from "bun:test";

import {
	applyOverrides,
	changedSettings,
	changedSummary,
	compactTokens,
	describeSetting,
	mergeOverrides,
	sanitizeOverrides,
	settingDescriptor,
	settingsAsOverrides,
	settingsText,
	SETTINGS_TABLE,
	type SettingsValues,
} from "../src/settings-table.ts";
import { HOUSE_STEERING, resolveSettings } from "../src/settings.ts";

const base = resolveSettings({}, {}, "/project");
const values = (overrides = {}, editing = true): SettingsValues => ({ editing, settings: applyOverrides(base, overrides) });
const ctx = { directory: "/project" };
const parse = (name: string, text: string) => settingDescriptor(name)!.parse(text, ctx);

describe("settings table", () => {
	test("names, aliases and case", () => {
		expect(SETTINGS_TABLE.map((item) => item.name)).toEqual(["editing", "budget", "reserve", "reminders", "gate", "guard", "compaction", "cap", "steering", "one-tool", "trailer", "compact-prompt", "reasoning"]);
		for (const [alias, key] of [["enabled", "editing"], ["REMIND", "reminders"], ["remind-at", "reminders"], ["overflow", "guard"], ["observation", "cap"], ["observation-cap", "cap"], ["edit-gate", "gate"], ["compactprompt", "compactPrompt"], ["Compact-Prompt", "compactPrompt"]]) {
			expect(settingDescriptor(alias!)?.key).toBe(key as never);
		}
		expect(settingDescriptor("no-such-setting")).toBeUndefined();
		for (const item of SETTINGS_TABLE.filter((entry) => entry.key !== "editing")) expect(item.description).toMatch(/Env: CLM_[A-Z_]+\.$/);
	});

	test("parse uses the option parsers", () => {
		expect(parse("budget", "20k")).toEqual({ budget: 20_000 });
		expect(parse("budget", "1.5m")).toEqual({ budget: 1_500_000 });
		expect(parse("budget", "Window")).toEqual({ budget: null });
		expect(() => parse("budget", "lots")).toThrow("budget must be a number of tokens");
		expect(parse("reserve", "4_096")).toEqual({ reserve: 4096 });
		expect(parse("reminders", "75/50%")).toEqual({ reminders: [0.5, 0.75] });
		expect(parse("reminders", "0.9")).toEqual({ reminders: [0.9] });
		expect(parse("reminders", "off")).toEqual({ reminders: [] });
		expect(() => parse("reminders", "150")).toThrow("between 0 and 100");
		expect(parse("gate", "SHRINK")).toEqual({ gate: "shrink" });
		expect(() => parse("gate", "loose")).toThrow("unknown edit gate");
		expect(parse("guard", "off")).toEqual({ guard: "off" });
		expect(parse("guard", "withhold")).toEqual({ guard: "withhold" });
		expect(parse("cap", "10k chars")).toEqual({ cap: 10_000 });
		expect(parse("cap", "10k:0.5")).toEqual({ cap: 10_000, capHead: 0.5 });
		expect(parse("cap", "off")).toEqual({ cap: null });
		expect(() => parse("cap", "100")).toThrow("at least 200");
		expect(() => parse("cap", "10k:2")).toThrow("head fraction");
		expect(parse("steering", "house")).toEqual({ steering: HOUSE_STEERING });
		expect(parse("steering", "docs/Brief.md")).toEqual({ steering: "/project/docs/Brief.md" });
		expect(parse("steering", "none")).toEqual({ steering: null });
		expect(parse("compact-prompt", "default")).toEqual({ compactPrompt: null });
		expect(parse("compact-prompt", "/abs/p.md")).toEqual({ compactPrompt: "/abs/p.md" });
		expect(parse("reasoning", "no")).toEqual({ reasoning: false });
		expect(parse("editing", "off")).toEqual({ editing: false });
		expect(() => parse("editing", "maybe")).toThrow("editing must be true or false");
	});

	test("format", () => {
		const effective = values({ budget: null, reserve: 4096, reminders: [0.5, 0.9], gate: "none", guard: "off", cap: 10_000, capHead: 0.5, steering: "/x/b.md", reasoning: false }, false);
		const shown = Object.fromEntries(SETTINGS_TABLE.map((item) => [item.name, item.format(effective, { modelWindow: 200_000 })]));
		expect(shown).toEqual({
			editing: "off",
			budget: "window (200k)",
			reserve: "4,096",
			reminders: "50/90%",
			gate: "none",
			guard: "off",
			compaction: "auto",
			cap: "10k chars (50% head)",
			steering: "b.md",
			"one-tool": "off",
			trailer: "off",
			"compact-prompt": "default",
			reasoning: "off",
		});
		expect(settingDescriptor("editing")!.format({ editing: true, settings: { ...base, enabled: false } })).toBe("off (plugin disabled)");
		expect(compactTokens(32_000)).toBe("32k");
		expect(compactTokens(2048)).toBe("2,048");
		expect(compactTokens(1_500_000)).toBe("1.5m");
		// The cycle choices are written as the format shows them.
		expect(settingDescriptor("cap")!.choices).toContain(settingDescriptor("cap")!.format(values({ cap: 10_000 })));
		expect(settingDescriptor("reminders")!.choices).toContain(settingDescriptor("reminders")!.format(values()));
	});

	test("applyOverrides resolves like options and rejects invalid sets", () => {
		const next = applyOverrides(base, { budget: 20_000, reminders: [], guard: "off", cap: 5000 });
		expect(next.budget).toMatchObject({ contextBudget: 20_000, remindAtFractions: [], remindAtReserve: false });
		expect(next.guard).toBe("off");
		expect(next.observationCap.maxCharacters).toBe(5000);
		expect(applyOverrides(base, { budget: null }).budget.contextBudget).toBeUndefined();
		expect(() => applyOverrides(base, { reserve: -1 })).toThrow("reserve");
	});

	test("merge drops keys equal to the base", () => {
		const baseValues = values();
		expect(mergeOverrides(baseValues, {}, { budget: 20_000 })).toEqual({ budget: 20_000 });
		expect(mergeOverrides(baseValues, { budget: 20_000, guard: "off" }, { budget: "50%" })).toEqual({ guard: "off" });
		expect(mergeOverrides(baseValues, {}, { reminders: [0.25, 0.5, 0.75], gate: "fit", editing: true })).toEqual({});
		expect(mergeOverrides(values({}, false), {}, { editing: true })).toEqual({ editing: true });
		expect(mergeOverrides(baseValues, {}, { cap: null, steering: null })).toEqual({});
	});

	test("sanitize keeps valid keys and names the rest", () => {
		expect(sanitizeOverrides({ budget: 20_000, guard: "maybe", cap: 10, reminders: [0.5], extra: 1, steering: "" })).toEqual({
			overrides: { budget: 20_000, reminders: [0.5] },
			ignored: ["guard", "cap", "extra", "steering"],
		});
		expect(sanitizeOverrides(undefined)).toEqual({ overrides: {}, ignored: [] });
		expect(sanitizeOverrides({ budget: 12_345.6, reserve: 1.5 }).ignored).toEqual(["budget", "reserve"]);
		expect(sanitizeOverrides([1])).toEqual({ overrides: {}, ignored: ["overrides"] });
		expect(sanitizeOverrides({ budget: null, editing: false })).toEqual({ overrides: { budget: null, editing: false }, ignored: [] });
	});

	test("changed settings, summary, description and the settings text", () => {
		const baseValues = values();
		const effective = values({ budget: 20_000, guard: "off" });
		expect(changedSettings(baseValues, effective)).toEqual(["budget", "guard"]);
		expect(changedSummary(baseValues, effective)).toBe("budget 20k, guard off");
		expect(changedSummary(baseValues, baseValues)).toBe("");
		expect(changedSettings(baseValues, values({ steering: "/a/house-brief.md" }))).toEqual(["steering"]);
		expect(describeSetting(settingDescriptor("budget")!, effective)).toStartWith("Budget: 20k — Token budget");
		const text = settingsText(baseValues, effective);
		expect(text).toMatch(/Budget +20k {2}\(changed; default 50%\)/);
		expect(text).toMatch(/Edit gate +fit\n/);
		expect(text).toContain("/clm config reset");
	});
});

describe("budget percentages in the settings table", () => {
	const budget = settingDescriptor("budget")!;

	test("parse: percentages are stored as text; the formatted value parses back", () => {
		expect(parse("budget", "50%")).toEqual({ budget: "50%" });
		expect(parse("budget", " 12.5 % ")).toEqual({ budget: "12.5%" });
		expect(parse("budget", "100%")).toEqual({ budget: "100%" });
		expect(parse("budget", "50% (131,072)")).toEqual({ budget: "50%" });
		expect(parse("budget", "window (262,144)")).toEqual({ budget: null });
		expect(parse("budget", "32k")).toEqual({ budget: 32_000 });
		for (const bad of ["0%", "101%", "abc%"]) expect(() => parse("budget", bad)).toThrow(/^budget must be/);
	});

	test("format: the share, with the tokens when the window is known", () => {
		expect(base.budget.contextFraction).toBe(0.5);
		expect(budget.format(values())).toBe("50%");
		expect(budget.format(values(), { modelWindow: 262_144 })).toBe("50% (131,072)");
		expect(budget.format(values(), { modelWindow: 200_000, modelOutput: 32_000 })).toBe("50% (84k)");
		expect(budget.format(values({ budget: "25%" }), { modelWindow: 200_000 })).toBe("25% (50k)");
		expect(budget.format(values({ budget: null }), { modelWindow: 200_000 })).toBe("window (200k)");
		expect(budget.format(values({ budget: 20_000 }), { modelWindow: 200_000 })).toBe("20k");
		expect(budget.placeholder).toContain("50%");
		expect(budget.description).toContain("50%");
	});

	test("round trip: parse → merge → apply → format", () => {
		const baseValues = values();
		for (const text of ["25%", "100%", "50% (131,072)", "window", "20k"]) {
			const overrides = mergeOverrides(baseValues, {}, parse("budget", text));
			const shown = budget.format(values(overrides));
			expect(budget.parse(shown, ctx)).toEqual(text.startsWith("50%") ? { budget: "50%" } : parse("budget", text));
		}
		// The default share equals the base and is dropped; another share is kept.
		expect(mergeOverrides(baseValues, { budget: 20_000 }, { budget: "50%" })).toEqual({});
		expect(mergeOverrides(baseValues, {}, { budget: "25%" })).toEqual({ budget: "25%" });
		const quarter = applyOverrides(base, { budget: "25%" }).budget;
		expect(quarter.contextFraction).toBe(0.25);
		expect(quarter).not.toHaveProperty("contextBudget");
		expect(applyOverrides(base, { budget: 20_000 }).budget).not.toHaveProperty("contextFraction");
		expect(applyOverrides(base, { budget: null }).budget.contextFraction).toBeUndefined();
		// A token base with a percentage override, and back.
		const tokenBase = resolveSettings({ budget: "64k" }, {}, "/project");
		expect(applyOverrides(tokenBase, { budget: "30%" }).budget).toMatchObject({ contextFraction: 0.3 });
		expect(applyOverrides(applyOverrides(tokenBase, { budget: "30%" }), {}).budget.contextFraction).toBe(0.3);
	});

	test("settingsAsOverrides carries the share, and applying it reproduces the base", () => {
		expect(settingsAsOverrides(base).budget).toBe("50%");
		expect(settingsAsOverrides(resolveSettings({ budget: "window" }, {}, "/project")).budget).toBeNull();
		const server = resolveSettings({ budget: "12.5%" }, {}, "/project");
		const other = resolveSettings({ budget: "64k" }, {}, "/project");
		expect(applyOverrides(other, settingsAsOverrides(server)).budget).toEqual(server.budget);
	});

	test("sanitize keeps valid shares and drops the rest", () => {
		expect(sanitizeOverrides({ budget: "50%" })).toEqual({ overrides: { budget: "50%" }, ignored: [] });
		expect(sanitizeOverrides({ budget: "1%" }).ignored).toEqual([]);
		for (const bad of ["0%", "101%", "50", "x%", 0.5]) {
			expect(sanitizeOverrides({ budget: bad })).toEqual({ overrides: {}, ignored: ["budget"] });
		}
		expect(() => applyOverrides(base, { budget: "0%" as never })).toThrow(/^budget must be a percentage/);
	});
});
