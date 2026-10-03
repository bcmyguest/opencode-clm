// Tests for src/tui/data.ts.

import { describe, expect, test } from "bun:test";

import { buildPanelModel } from "../../src/panel/model.ts";
import { resolveSettings } from "../../src/settings.ts";
import { fallbackBudget, latestUsage, modelLimits, overridesNewer, serverBase, serverPluginOptions, settingsView } from "../../src/tui/data.ts";
import { settingsAsOverrides } from "../../src/settings-table.ts";
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

	test("matches any version, tag or file: source, and paths naming the package", () => {
		for (const spec of [
			"opencode-clm@latest",
			"opencode-clm@^0.2",
			"opencode-clm@file:/tmp/opencode-clm-0.2.0.tgz",
			"opencode-clm@file:../opencode-clm",
			"npm:opencode-clm@0.2.0",
			"file:///home/u/opencode-clm",
			"file:///srv/checkouts/opencode-clm/index.ts",
			"/srv/opencode-clm",
			"../opencode-clm/",
			"/tmp/opencode-clm-0.2.0.tgz",
		]) {
			expect([spec, serverPluginOptions([[spec, { mirrorDir: "/m" }]], INDEX)]).toEqual([spec, { mirrorDir: "/m" }]);
		}
		for (const spec of ["opencode-clm-extra", "other@file:/x/opencode-clm", "file:///srv/other/index.ts", "/srv/opencode-clm-fork", "my-opencode-clm"]) {
			expect([spec, serverPluginOptions([[spec, {}]], INDEX)]).toEqual([spec, undefined]);
		}
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
	test("rows come from the settings table, carry choices or placeholders, and mark changes", () => {
		const model = buildPanelModel(files({ events: basicEvents }));
		const base = { editing: true, settings: resolveSettings({}, {}, "/tmp") };
		const view = settingsView({ base, effective: base }, model);
		expect(view.rows.map((row) => row.key)).toEqual(["editing", "budget", "reserve", "reminders", "gate", "guard", "compaction", "cap", "steering", "one-tool", "trailer", "compact-prompt", "reasoning"]);
		expect(view.rows[0]).toMatchObject({ value: "on", choices: ["on", "off"] });
		expect(view.rows[1]?.placeholder).toBeDefined();
		expect(view.summary.at(-1)).toMatch(/^Files mirror /);
		expect(view.changed).toEqual([]);

		const effective = { editing: false, settings: resolveSettings({ budget: "20k", guard: "off" }, {}, "/tmp") };
		const changed = settingsView({ base, effective }, model, { warning: "w" });
		expect(changed.changed).toEqual(["editing", "budget", "guard"]);
		expect(changed.rows.find((row) => row.key === "budget")).toMatchObject({ value: "20k", changed: true });
		expect(changed.rows.find((row) => row.key === "budget")!.description).toContain("Default: 32k.");
		expect(changed.warning).toBe("w");
	});

	test("status toast text", () => {
		expect(statusSummary(buildPanelModel(files({ events: basicEvents })))).toBe("CLM on · revision 2 · last request ~6.8k");
		expect(statusSummary(buildPanelModel(files({ found: false })))).toMatch(/^No CLM data/);
	});
});

describe("server authority over the settings base", () => {
	test("snapshot.json's base replaces the TUI's own resolution; mirrorDir stays the TUI's", () => {
		const own = resolveSettings({ mirrorDir: "/m" }, { CLM_BUDGET: "50k" }, "/tmp");
		const server = resolveSettings({ budget: "16k", guard: "off" }, {}, "/tmp");
		const result = serverBase(own, { base: settingsAsOverrides(server) });
		expect(result.source).toBe("server");
		expect(result.base.budget.contextBudget).toBe(16_000);
		expect(result.base.guard).toBe("off");
		expect(result.base.mirrorDir).toBe("/m");
		expect(serverBase(own, {}).source).toBe("tui");
		expect(serverBase(own, undefined).base).toBe(own);
		expect(serverBase(own, { base: { reserve: -5 } }).base.budget.reserve).toBe(own.budget.reserve);
	});

	test("overrides newer than the snapshot", () => {
		const at = "2026-10-03T10:00:00.000Z";
		expect(overridesNewer(Date.parse(at) + 1, { at })).toBe(true);
		expect(overridesNewer(Date.parse(at) - 1, { at })).toBe(false);
		expect(overridesNewer(undefined, { at })).toBe(false);
		expect(overridesNewer(1, undefined)).toBe(true);
	});
});
