import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { changeSetting, OVERRIDES_FILE, parseOverridesText, readOverrides, resetSettings, sessionValues, showSetting, stageSettings, writeOverrides } from "../src/overrides.ts";
import { resolveSettings } from "../src/settings.ts";
import { tempDir } from "./fixtures.ts";

const project = tempDir("clm-overrides-");
const base = resolveSettings({}, {}, project);
const request = (directory: string, baseEditing = true) => ({ sessionDirectory: directory, base, baseEditing, projectDirectory: project });
const fileOf = (directory: string) => JSON.parse(readFileSync(join(directory, OVERRIDES_FILE), "utf8"));

describe("overrides.json", () => {
	test("written atomically with mode 0600, only diffs from the base", async () => {
		const directory = join(tempDir(), "clm-s");
		const result = await changeSetting(request(directory), "budget", "20k");
		expect(result.text).toBe("Budget: 20k");
		expect(fileOf(directory)).toEqual({ version: 1, overrides: { budget: 20_000 } });
		expect(statSync(join(directory, OVERRIDES_FILE)).mode & 0o777).toBe(0o600);
		expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		await changeSetting(request(directory), "overflow", "off");
		expect(fileOf(directory).overrides).toEqual({ budget: 20_000, guard: "off" });
		// Setting the base value drops the key.
		await changeSetting(request(directory), "budget", "32000");
		expect(fileOf(directory).overrides).toEqual({ guard: "off" });
		const read = await sessionValues(directory, base, true);
		expect(read.values.settings.guard).toBe("off");
		expect(showSetting("guard", read.values)).toStartWith("Overflow guard: off — ");
		await resetSettings(directory);
		expect(fileOf(directory)).toEqual({ version: 1, overrides: {} });
	});

	test("a change that does not validate or load is not written", async () => {
		const directory = join(tempDir(), "clm-s");
		await writeOverrides(directory, { budget: 20_000 });
		const before = readFileSync(join(directory, OVERRIDES_FILE), "utf8");
		await expect(changeSetting(request(directory), "budget", "lots")).rejects.toThrow("budget must be a number of tokens");
		await expect(changeSetting(request(directory), "steering", "missing.md")).rejects.toThrow("steering document not loaded");
		await expect(changeSetting(request(directory), "compact-prompt", "/nonexistent/p.md")).rejects.toThrow("compactPrompt");
		await expect(changeSetting(request(directory), "nope", "1")).rejects.toThrow('Unknown setting "nope"');
		expect(readFileSync(join(directory, OVERRIDES_FILE), "utf8")).toBe(before);
		// A readable steering file is accepted and stored as an absolute path.
		writeFileSync(join(project, "brief.md"), "Keep notes short.");
		await changeSetting(request(directory), "steering", "brief.md");
		expect(fileOf(directory).overrides.steering).toBe(join(project, "brief.md"));
	});

	test.skipIf(process.getuid?.() === 0)("a failed save says the settings are unchanged", async () => {
		const directory = join(tempDir(), "clm-s");
		await writeOverrides(directory, {});
		chmodSync(directory, 0o500);
		try {
			await expect(changeSetting(request(directory), "guard", "off")).rejects.toThrow("Settings unchanged: saving");
		} finally {
			chmodSync(directory, 0o700);
		}
	});

	test("reading sanitizes and never throws", async () => {
		const directory = tempDir();
		expect(await readOverrides(directory)).toEqual({ overrides: {} });
		writeFileSync(join(directory, OVERRIDES_FILE), "{torn");
		expect((await readOverrides(directory)).warning).toContain("not valid JSON");
		expect(parseOverridesText(JSON.stringify({ version: 2, overrides: {} })).warning).toContain("unknown format");
		expect(parseOverridesText(JSON.stringify({ version: 1, overrides: { budget: 1000, gate: "loose" } }))).toEqual({
			overrides: { budget: 1000 },
			warning: "ignored invalid saved settings: gate",
		});
		expect(existsSync(join(directory, "x"))).toBe(false);
	});

	test("staging: strict rejects a steering file that does not load; lenient records it", () => {
		expect(() => stageSettings(base, { steering: "/nonexistent.md" }, { strict: true })).toThrow("steering document not loaded");
		const staged = stageSettings(base, { steering: "/nonexistent.md" }, { strict: false });
		expect(staged.steering).toBeUndefined();
		expect(staged.steeringError).toContain("cannot read");
	});
});
