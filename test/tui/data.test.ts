// Tests for src/tui/data.ts.

import { describe, expect, test } from "bun:test";

import { buildPanelModel } from "../../src/panel/model.ts";
import { resolveSettings } from "../../src/settings.ts";
import { fallbackBudget, latestUsage, modelLimits, serverPluginOptions, settingsView } from "../../src/tui/data.ts";
import { statusSummary } from "../../src/tui/plugin.ts";
import { basicEvents, files } from "../panel/fixtures.ts";

const INDEX = "file:///home/u/opencode-clm/index.ts";

describe("serverPluginOptions", () => {
	test("matches the npm spec or this package's index.ts", () => {
		expect(serverPluginOptions([["opencode-clm", { mirrorDir: "/m" }]], INDEX)).toEqual({ mirrorDir: "/m" });
		expect(serverPluginOptions(["opencode-clm@0.2.0"], INDEX)).toEqual({});
		expect(serverPluginOptions([["file:///home/u/opencode-clm/index.ts", { budget: "20k" }]], INDEX)).toEqual({ budget: "20k" });
		expect(serverPluginOptions([["file:///elsewhere/index.ts", {}], "other-plugin"], INDEX)).toBeUndefined();
		expect(serverPluginOptions(undefined, INDEX)).toBeUndefined();
	});
});

describe("host messages", () => {
	const messages = [
		{ role: "user" },
		{ role: "assistant", providerID: "p", modelID: "m", time: { created: 10, completed: 20 }, tokens: { input: 100, output: 50, reasoning: 5, cache: { read: 1000, write: 10 } } },
		{ role: "assistant", providerID: "p", modelID: "m", time: { created: 30 }, error: { name: "x" }, tokens: { input: 1, cache: { read: 0, write: 0 } } },
	];

	test("latestUsage skips errors and sizes like observedPrevious (no output)", () => {
		expect(latestUsage(messages)).toEqual({ tokens: 1110, completedAt: 20 });
		expect(latestUsage([{ role: "assistant", time: { created: 5 }, tokens: { input: 7 } }])).toEqual({ tokens: 7 });
		expect(latestUsage([])).toBeUndefined();
	});

	test("modelLimits and fallbackBudget", () => {
		const providers = [{ id: "p", models: { m: { limit: { context: 200_000, output: 32_000 } } } }];
		const limits = modelLimits(messages, providers);
		expect(limits).toEqual({ context: 200_000, output: 32_000 });
		const settings = resolveSettings({ budget: "40k" }, {}, "/tmp");
		expect(fallbackBudget(settings, limits)).toMatchObject({ budget: 40_000, source: "config", cap: 168_000 });
		expect(fallbackBudget(resolveSettings({ budget: "window" }, {}, "/tmp"), {})).toBeUndefined();
	});
});

describe("settings view and status", () => {
	test("read-only rows carry choices or placeholders", () => {
		const model = buildPanelModel(files({ events: basicEvents }));
		const view = settingsView(resolveSettings({}, {}, "/tmp"), model);
		expect(view.rows.map((row) => row.key)).toEqual(["editing", "budget", "reserve", "gate", "guard", "reasoning"]);
		expect(view.rows[0]).toMatchObject({ value: "on", choices: ["on", "off"] });
		expect(view.rows[1]?.placeholder).toBeDefined();
		expect(view.summary.at(-1)).toMatch(/^Files mirror /);
	});

	test("status toast text", () => {
		expect(statusSummary(buildPanelModel(files({ events: basicEvents })))).toBe("CLM on · revision 2 · last request ~6.8k");
		expect(statusSummary(buildPanelModel(files({ found: false })))).toMatch(/^No CLM data/);
	});
});
