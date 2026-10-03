// Tab completion for `/clm …` lines (src/tui/complete.ts), with a fake key context and prompt.
import { describe, expect, test } from "bun:test";

import { CLM_COMPLETIONS, clmCompletions, completeClmLine, interceptTab } from "../../src/tui/complete.ts";
import { SETTING_NAMES } from "../../src/settings-table.ts";

function tab(text: string, options: { event?: Record<string, unknown>; owned?: boolean; cursor?: number } = {}) {
	const calls = { consumed: 0, shown: [] as string[][] };
	const prompt = {
		plainText: text,
		cursorOffset: options.cursor ?? text.length,
		setText(value: string) {
			this.plainText = value;
			this.cursorOffset = 0;
		},
	};
	const result = interceptTab(
		{ event: { name: "tab", ...(options.event ?? {}) }, consume: () => calls.consumed++ },
		{ focused: () => prompt, owned: () => options.owned ?? true, show: (items) => calls.shown.push([...items]) },
	);
	return { result, calls, prompt };
}

describe("/clm completion items", () => {
	test("pi's word list plus budget", () => {
		expect(CLM_COMPLETIONS).toEqual([
			"overview", "input", "edits", "settings", "status", "config",
			...SETTING_NAMES.map((name) => `config ${name}`),
			"config reset", "on", "off", "reset", "path", "budget",
		]);
	});

	test("prefix filter, and a setting's choices after config <setting>", () => {
		expect(clmCompletions("s")).toEqual(["settings", "status"]);
		expect(clmCompletions("config g")).toEqual(["config gate", "config guard"]);
		expect(clmCompletions("config gate s")).toEqual(["config gate shrink"]);
		expect(clmCompletions("config budget ")).toEqual([]);
		expect(clmCompletions("x")).toEqual([]);
	});

	test("line completion: unique, common prefix, ambiguous, none", () => {
		expect(completeClmLine("/clm sta")).toEqual({ text: "/clm status ", items: ["status"] });
		expect(completeClmLine("/clm config co")).toEqual({ text: "/clm config compact", items: ["config compaction", "config compact-prompt"] });
		expect(completeClmLine("/clm o")).toEqual({ text: "/clm o", items: ["overview", "on", "off"] });
		expect(completeClmLine("/clm zz")).toBeUndefined();
		expect(completeClmLine("/clm")).toBeUndefined();
		expect(completeClmLine("hello")).toBeUndefined();
	});
});

describe("Tab intercept", () => {
	test("completes the line and puts the cursor at its end", () => {
		const { result, calls, prompt } = tab("/clm config gu");
		expect(result?.text).toBe("/clm config guard ");
		expect([calls.consumed, prompt.plainText, prompt.cursorOffset]).toEqual([1, "/clm config guard ", 18]);
	});

	test("shows the items when Tab cannot extend the line", () => {
		const { calls, prompt } = tab("/clm o");
		expect([calls.consumed, prompt.plainText]).toEqual([1, "/clm o"]);
		expect(calls.shown).toEqual([["overview", "on", "off"]]);
	});

	test("normal Tab elsewhere: other text, /clm without a space, no match, modifiers, cursor inside, not owned", () => {
		for (const run of [
			tab("hello"),
			tab("/clm"),
			tab("/cl"),
			tab("/clm zz"),
			tab("/clm sta", { event: { shift: true } }),
			tab("/clm sta", { cursor: 2 }),
			tab("/clm sta", { owned: false }),
			tab("/clm sta", { event: { name: "return" } }),
		]) {
			expect([run.result, run.calls.consumed]).toEqual([undefined, 0]);
		}
	});
});
