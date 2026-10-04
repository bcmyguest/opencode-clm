// Settings cases adapted from pi-clm src/__tests__/settings.test.ts (MIT, Copyright 2026 Emanuel Casco).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { DEFAULT_BUDGET_POLICY } from "../src/budget.ts";
import { HOUSE_STEERING, PACKAGE_DIR, resolveSettings, SKILLS_DIR } from "../src/settings.ts";

const project = "/work/project";

describe("resolveSettings", () => {
	test("defaults", () => {
		const settings = resolveSettings({}, {}, project);
		expect(settings.enabled).toBe(true);
		expect(settings.budget).toEqual(DEFAULT_BUDGET_POLICY);
		expect(settings.gate).toBe("fit");
		expect(settings.guard).toBe("withhold");
		expect(settings.observationCap).toEqual({ headFraction: 0.8 });
		expect(settings.mirrorDir).toBe(join(project, ".opencode", "clm"));
		expect(settings.steeringPath).toBeUndefined();
		expect(settings.compactPromptPath).toBeUndefined();
		expect(settings.estimateFactor).toBe(1);
		expect(settings.reasoning).toBe(true);
		expect(settings.skill).toBe(true);
		expect(settings.commands).toBe(true);
		expect(settings.dumpRequests).toBe(false);
	});

	test("options override env, env overrides defaults", () => {
		const env = { CLM_BUDGET: "64k", CLM_RESERVE: "1000", CLM_EDIT_GATE: "shrink" };
		expect(resolveSettings({}, env, project).budget.contextBudget).toBe(64_000);
		const settings = resolveSettings({ budget: 10_000 }, env, project);
		expect(settings.budget.contextBudget).toBe(10_000);
		expect(settings.budget.reserve).toBe(1000);
		expect(settings.gate).toBe("shrink");
		expect(resolveSettings({ gate: "none" }, env, project).gate).toBe("none");
	});

	test("empty env values count as unset", () => {
		expect(resolveSettings({}, { CLM_BUDGET: "  ", CLM_ESTIMATE_FACTOR: "" }, project).budget.contextFraction).toBe(0.5);
	});

	test("token counts accept k, m, underscores and commas; window follows the model", () => {
		expect(resolveSettings({ budget: "1.5m" }, {}, project).budget.contextBudget).toBe(1_500_000);
		expect(resolveSettings({ budget: "200_000" }, {}, project).budget.contextBudget).toBe(200_000);
		expect(resolveSettings({}, { CLM_BUDGET: "200,000" }, project).budget.contextBudget).toBe(200_000);
		expect(resolveSettings({ budget: "window" }, {}, project).budget.contextBudget).toBeUndefined();
	});

	test("reminder fractions: decimals, percentages, arrays, off", () => {
		expect(resolveSettings({}, { CLM_REMIND_AT: "50/75/90%" }, project).budget.remindAtFractions).toEqual([0.5, 0.75, 0.9]);
		expect(resolveSettings({ remindAt: [0.9, 0.5] }, {}, project).budget.remindAtFractions).toEqual([0.5, 0.9]);
		const off = resolveSettings({}, { CLM_REMIND_AT: "off" }, project).budget;
		expect(off.remindAtFractions).toEqual([]);
		expect(off.remindAtReserve).toBe(false);
	});

	test("observation cap from option or env", () => {
		expect(resolveSettings({}, { CLM_OBSERVATION_CAP: "10000:0.5" }, project).observationCap).toEqual({ maxCharacters: 10_000, headFraction: 0.5 });
		expect(resolveSettings({ observationCap: 5000 }, { CLM_OBSERVATION_CAP: "10000" }, project).observationCap.maxCharacters).toBe(5000);
		expect(resolveSettings({ observationCap: "off" }, { CLM_OBSERVATION_CAP: "10000" }, project).observationCap.maxCharacters).toBeUndefined();
		expect(resolveSettings({ observationCap: false }, {}, project).observationCap.maxCharacters).toBeUndefined();
	});

	test("paths resolve against the project; keywords mean built in", () => {
		expect(resolveSettings({ mirrorDir: "tmp/m" }, {}, project).mirrorDir).toBe(join(project, "tmp/m"));
		expect(resolveSettings({}, { CLM_MIRROR_DIR: "/abs/m" }, project).mirrorDir).toBe("/abs/m");
		expect(resolveSettings({ steering: "house" }, {}, project).steeringPath).toBe(HOUSE_STEERING);
		expect(resolveSettings({ steering: "house-brief.md" }, {}, project).steeringPath).toBe(HOUSE_STEERING);
		expect(resolveSettings({}, { CLM_STEERING: "docs/brief.md" }, project).steeringPath).toBe(join(project, "docs/brief.md"));
		expect(resolveSettings({ steering: "none" }, { CLM_STEERING: "docs/brief.md" }, project).steeringPath).toBeUndefined();
		expect(resolveSettings({}, { CLM_COMPACT_PROMPT: "prompts/team.md" }, project).compactPromptPath).toBe(join(project, "prompts/team.md"));
		for (const word of ["default", " Default ", "none", "off"]) {
			expect(resolveSettings({ compactPrompt: word }, { CLM_COMPACT_PROMPT: "x.md" }, project).compactPromptPath).toBeUndefined();
		}
	});

	test("estimate factor and flags", () => {
		expect(resolveSettings({}, { CLM_ESTIMATE_FACTOR: "1.5" }, project).estimateFactor).toBe(1.5);
		const flags = resolveSettings({ skill: false, commands: "off" }, { CLM_ENABLED: "no", CLM_REASONING: "0", CLM_DUMP_REQUESTS: "yes" }, project);
		expect(flags).toMatchObject({ enabled: false, reasoning: false, dumpRequests: true, skill: false, commands: false });
		expect(resolveSettings({}, { CLM_OVERFLOW: "off" }, project).guard).toBe("off");
	});

	test("an invalid value throws an error naming the setting", () => {
		const cases: [Record<string, unknown>, Record<string, string>, RegExp][] = [
			[{ budget: "lots" }, {}, /^budget/],
			[{}, { CLM_BUDGET: "-5" }, /^budget/],
			[{}, { CLM_RESERVE: "x" }, /^reserve/],
			[{ remindAt: "half" }, {}, /^remindAt/],
			[{ remindAt: "150%" }, {}, /^remindAt entries must lie strictly between 0 and 1/],
			[{ remindAt: "150" }, {}, /^remindAt entries/],
			[{ budget: "0" }, {}, /^budget must be a positive number of tokens or "window", got "0"/],
			[{ estimateFactor: true }, {}, /^estimateFactor/],
			[{ estimateFactor: [2] }, {}, /^estimateFactor/],
			[{ gate: "maybe" }, {}, /^gate/],
			[{}, { CLM_OVERFLOW: "drop" }, /^guard/],
			[{}, { CLM_OBSERVATION_CAP: "many" }, /^observationCap/],
			[{ observationCap: 50 }, {}, /^observationCap: observation cap must be at least 200/],
			[{}, { CLM_OBSERVATION_CAP: "10000:2" }, /^observationCap head fraction/],
			[{}, { CLM_ESTIMATE_FACTOR: "0.5" }, /^estimateFactor/],
			[{}, { CLM_ESTIMATE_FACTOR: "abc" }, /^estimateFactor/],
			[{}, { CLM_ENABLED: "sometimes" }, /^enabled/],
			[{ skill: "maybe" }, {}, /^skill/],
		];
		for (const [options, env, message] of cases) {
			expect(() => resolveSettings(options, env, project)).toThrow(message);
		}
	});

	test("package directories resolve relative to the module", () => {
		expect(PACKAGE_DIR).toBe(join(import.meta.dir, ".."));
		expect(SKILLS_DIR).toBe(join(PACKAGE_DIR, "skills"));
		expect(HOUSE_STEERING).toBe(join(PACKAGE_DIR, "steering", "house-brief.md"));
	});
});

describe("budget percentages", () => {
	test("plugin option and environment variable", () => {
		expect(resolveSettings({}, {}, project).budget).toMatchObject({ contextFraction: 0.5 });
		expect(resolveSettings({}, {}, project).budget).not.toHaveProperty("contextBudget");
		expect(resolveSettings({ budget: "25%" }, {}, project).budget.contextFraction).toBe(0.25);
		expect(resolveSettings({}, { CLM_BUDGET: " 75 % " }, project).budget.contextFraction).toBe(0.75);
		expect(resolveSettings({ budget: "100%" }, {}, project).budget.contextFraction).toBe(1);
		expect(resolveSettings({ budget: "1%" }, {}, project).budget.contextFraction).toBe(0.01);
		expect(resolveSettings({ budget: "12.5%" }, {}, project).budget.contextFraction).toBe(0.125);
		// The option wins over the variable.
		expect(resolveSettings({ budget: "40%" }, { CLM_BUDGET: "64k" }, project).budget).toMatchObject({ contextFraction: 0.4 });
	});

	test("token counts and window clear the default fraction", () => {
		const tokens = resolveSettings({ budget: "32k" }, {}, project).budget;
		expect(tokens.contextBudget).toBe(32_000);
		expect(tokens).not.toHaveProperty("contextFraction");
		const window = resolveSettings({}, { CLM_BUDGET: "window" }, project).budget;
		expect(window.contextBudget).toBeUndefined();
		expect(window.contextFraction).toBeUndefined();
	});

	test("out-of-range and malformed percentages throw an error naming budget", () => {
		for (const value of ["0%", "0.5%", "101%", "150%", "-5%", "abc%", "%", "5x%", "50%%"]) {
			expect(() => resolveSettings({ budget: value }, {}, project)).toThrow(/^budget must be .*percentage of the model window \(1% to 100%\)/);
			expect(() => resolveSettings({}, { CLM_BUDGET: value }, project)).toThrow(/^budget/);
		}
	});
});
