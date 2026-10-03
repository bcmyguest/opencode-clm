// Per-session settings (overrides.json) and the panel files the server writes (v0.2.0 block 3).
import { describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ClmSession } from "../src/clm.ts";
import { changeSetting, resetSettings, writeOverrides } from "../src/overrides.ts";
import { statusText } from "../src/presentation.ts";
import { sanitizeOverrides } from "../src/settings-table.ts";
import { assistant, conversation, SESSION, settings, tempDir } from "./fixtures.ts";
import { blockId, replaceBody } from "./helpers.ts";

const events = (clm: ClmSession) =>
	readFileSync(join(clm.store.directory, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("refreshSettings", () => {
	test("a changed overrides.json applies from the next request; reset drops it", async () => {
		const clm = await ClmSession.open(SESSION, settings({ budget: 4000, reserve: 100 }));
		const first = await clm.transform(conversation());
		expect(first.reading?.budget).toBe(4000);

		await changeSetting(clm.changeRequest("/project"), "budget", "20k");
		await changeSetting(clm.changeRequest("/project"), "guard", "off");
		const second = await clm.transform(conversation());
		expect(second.reading?.budget).toBe(20_000);
		expect(clm.settings.guard).toBe("off");
		expect(clm.baseSettings.guard).toBe("withhold");
		expect(statusText(clm.status())).toContain("Changed: budget 20k, guard off");
		expect(events(clm).filter((event) => event.event === "settings").at(-1).overrides).toEqual({ budget: 20_000, guard: "off" });

		await resetSettings(clm.store.directory);
		const third = await clm.transform(conversation());
		expect(third.reading?.budget).toBe(4000);
		expect(statusText(clm.status())).not.toContain("Changed:");
	});

	test("a budget change re-arms the reminders", async () => {
		const clm = await ClmSession.open(SESSION, settings({ budget: 2000, reserve: 100, remindAt: "0.5" }));
		const raw = conversation("x".repeat(6000));
		expect((await clm.transform(structuredClone(raw))).notices.join("\n")).toContain("Context crossed 50%");
		expect((await clm.transform(structuredClone(raw))).notices.join("\n")).not.toContain("Context crossed 50%");
		await writeOverrides(clm.store.directory, { budget: 2200 });
		expect((await clm.transform(structuredClone(raw))).notices.join("\n")).toContain("Context crossed 50% of a 2,200-token budget");
	});

	test("the editing override switches the session off and on", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		await writeOverrides(clm.store.directory, { editing: false });
		const base = conversation();
		const off = await clm.transform(structuredClone(base));
		expect(off.messages).toEqual(base);
		expect(clm.enabled).toBe(false);
		expect(clm.state.enabled).toBe(true);
		await writeOverrides(clm.store.directory, {});
		expect((await clm.transform(structuredClone(base))).reading).toBeDefined();
	});

	test("invalid saved settings are dropped with a warning; an unreadable steering file leaves protocol only", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		writeFileSync(join(clm.store.directory, "overrides.json"), JSON.stringify({ version: 1, overrides: { budget: 9000, gate: "loose", steering: "/nonexistent.md" } }));
		await clm.refreshSettings();
		expect(clm.settings.budget.contextBudget).toBe(9000);
		expect(clm.steering).toBeUndefined();
		expect(clm.settingsWarning).toContain("ignored invalid saved settings: gate");
		expect(clm.settingsWarning).toContain("steering document not loaded");
		expect(statusText(clm.status())).toContain("settings warning:");
	});

	test("a steering override is loaded for this session only", async () => {
		const project = tempDir();
		writeFileSync(join(project, "brief.md"), "Keep notes short.");
		const options = settings();
		const clm = await ClmSession.open(SESSION, options);
		await changeSetting(clm.changeRequest(project), "steering", "brief.md");
		await clm.refreshSettings();
		expect(clm.steering?.name).toBe("brief.md");
		const other = await ClmSession.open("ses_other", options);
		expect(other.steering).toBeUndefined();
	});

	test("the budget-too-small check uses the overridden budget", async () => {
		const clm = await ClmSession.open(SESSION, settings({ budget: 64_000 }));
		await writeOverrides(clm.store.directory, { budget: 12_000 });
		await clm.transform(conversation());
		const second = await clm.transform([...conversation(), assistant("msg_a3", "ok", [], 18_000)]);
		expect(clm.state.budgetCheck).toMatchObject({ configured: 12_000, raised: true });
		expect(second.alert).toContain("Budget 12,000 is too small");
	});
});

describe("panel files", () => {
	test("snapshot.json every request; request events carry users and the reporting message id", async () => {
		const clm = await ClmSession.open(SESSION, settings({ budget: 16_000 }));
		await clm.transform(conversation());
		const path = join(clm.store.directory, "snapshot.json");
		let snapshot = json(path);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(snapshot).toMatchObject({ request: 1, revision: 0, enabled: true, budget: { budget: 16_000, reserve: 2048, limit: 16_000 - 2048, source: "config" } });
		expect(snapshot.input).toMatchObject({ raw: 3, sent: 3, suffix: 0 });
		// The server's base, in overrides form: the TUI validates against it.
		expect(snapshot.base).toMatchObject({ budget: 16_000, reserve: 2048, guard: "withhold", gate: "fit", cap: null, steering: null });
		expect(sanitizeOverrides(snapshot.base).ignored).toEqual([]);
		expect(snapshot.input.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "assistant"]);
		expect(Math.max(...snapshot.input.messages.map((message: { preview: string }) => message.preview.length))).toBeLessThanOrEqual(120);
		expect(snapshot.input.messages[0].index).toBe(1);
		expect(snapshot.input.messages[0].preview).toContain("Inspect the repository");

		await clm.transform([...conversation(), assistant("msg_a3", "ok", [], 900)]);
		snapshot = json(path);
		expect(snapshot.request).toBe(2);
		expect(snapshot.sizes.observedPrevious).toBe(900);
		const requests = events(clm).filter((event) => event.event === "request");
		expect(requests.map((event) => event.users)).toEqual([1, 1]);
		expect(requests[1]).toMatchObject({ observedPrevious: 900, observedMessage: "msg_a3" });
		expect(requests[0].observedMessage).toBeUndefined();
	});

	test("an accepted edit writes revisions/rN.json with full text and roles per row", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		await clm.transform(conversation());
		const id = blockId(clm.baseline!.snapshot, "toolResult", 0);
		writeFileSync(clm.mirrorPath, replaceBody(readFileSync(clm.mirrorPath, "utf8"), id, "[summary]"));
		await clm.transform(conversation());
		const file = json(join(clm.store.directory, "revisions", "r1.json"));
		expect(file).toMatchObject({ version: 1, revision: 1, sourceRevision: 0 });
		expect(file.beforeTokens).toBeGreaterThan(file.afterTokens);
		const edited = file.rows.find((row: { kind: string }) => row.kind === "edited");
		expect(edited).toMatchObject({ role: "toolResult", sourceIndex: 1, outputIndex: 1 });
		expect(edited.before).toContain("big output");
		expect(edited.after).toContain("[summary]");
		const kept = file.rows.filter((row: { kind: string }) => row.kind === "kept");
		expect(kept.length).toBeGreaterThan(0);
		// Unchanged rows store their text once.
		for (const row of kept) {
			expect(typeof row.text).toBe("string");
			expect(row.before).toBeUndefined();
			expect(row.after).toBeUndefined();
		}
		expect(statSync(join(clm.store.directory, "revisions", "r1.json")).mode & 0o777).toBe(0o600);
	});
});
