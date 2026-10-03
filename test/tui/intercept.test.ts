// Unit tests for the TUI's Enter intercept (src/tui/intercept.ts) with a fake key context
// and a fake focused prompt.
import { describe, expect, test } from "bun:test";

import type { ClmCommand } from "../../src/panel/command.ts";
import { interceptEnter, type FocusedPrompt } from "../../src/tui/intercept.ts";
import { userOwnsStatusCommand } from "../../src/commands.ts";

function run(text: string | undefined, options: { event?: Record<string, unknown>; owned?: boolean; focused?: FocusedPrompt | null; fail?: boolean } = {}) {
	const calls = { consumed: 0, cleared: 0, handled: [] as ClmCommand[], reports: [] as string[] };
	const focused = options.focused !== undefined
		? options.focused
		: { plainText: text, setText: (value: string) => { if (value === "") calls.cleared++; } };
	const result = interceptEnter(
		{ event: { name: "return", ...(options.event ?? {}) }, consume: () => calls.consumed++ },
		{
			focused: () => focused,
			owned: () => options.owned ?? true,
			handle: async (command) => {
				calls.handled.push(command);
				if (options.fail) throw new Error("boom");
			},
			report: (message) => calls.reports.push(message),
		},
	);
	return { result, calls };
}

describe("Enter intercept", () => {
	test("consumes and clears a /clm line the TUI handles", async () => {
		for (const [text, kind] of [["/clm", "open"], ["/clm config guard off", "config-set"], ["/clm on", "enable"], ["/clm off", "enable"], ["/clm status", "status"], ["/clm config reset", "config-reset"]] as const) {
			const { result, calls } = run(text);
			expect([text, result?.kind, calls.consumed, calls.cleared]).toEqual([text, kind, 1, 1]);
			await Bun.sleep(0);
			expect(calls.handled.map((command) => command.kind)).toEqual([kind]);
		}
	});

	test("passes through other text, /clm-compact, /clm reset and modified Enter", () => {
		for (const text of ["hello", "/clm-compact keep tests", "/clmx", "/clm reset"]) {
			const { result, calls } = run(text);
			expect([text, result, calls.consumed, calls.cleared]).toEqual([text, undefined, 0, 0]);
		}
		for (const modifier of ["shift", "ctrl", "meta"]) {
			expect(run("/clm", { event: { [modifier]: true } }).calls.consumed).toBe(0);
		}
		expect(run("/clm", { event: { name: "a" } }).calls.consumed).toBe(0);
	});

	test("fails open without the prompt internals", () => {
		expect(run("/clm", { focused: null }).result).toBeUndefined();
		expect(run("/clm", { focused: { plainText: "/clm" } }).calls.consumed).toBe(0);
		expect(run("/clm", { focused: { setText: () => undefined } }).calls.consumed).toBe(0);
	});

	test("leaves a user-defined /clm or commands: false alone", () => {
		expect(run("/clm config guard off", { owned: false }).calls.consumed).toBe(0);
		expect(userOwnsStatusCommand({ clm: { template: "mine" } })).toBe(true);
		expect(userOwnsStatusCommand({ clm: { template: "Show the CLM status. $ARGUMENTS" } })).toBe(false);
		expect(userOwnsStatusCommand({})).toBe(false);
		expect(userOwnsStatusCommand(undefined)).toBe(false);
	});

	test("a usage error keeps the text; a handler error becomes a report", async () => {
		const usage = run("/clm bogus");
		expect([usage.result?.kind, usage.calls.consumed, usage.calls.cleared]).toEqual(["usage", 1, 0]);
		const failing = run("/clm status", { fail: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		expect(failing.calls.reports).toEqual(["CLM: boom"]);
	});
});

describe("Enter intercept ownership errors", () => {
	test("a throwing ownership check lets the line through and reports the error", () => {
		const reports: string[] = [];
		let consumed = 0;
		const result = interceptEnter(
			{ event: { name: "return" }, consume: () => consumed++ },
			{
				focused: () => ({ plainText: "/clm status", setText: () => undefined }),
				owned: () => {
					throw new Error("budget must be a number of tokens");
				},
				handle: async () => undefined,
				report: (message) => reports.push(message),
			},
		);
		expect([result, consumed]).toEqual([undefined, 0]);
		expect(reports).toEqual(["CLM: budget must be a number of tokens"]);
	});
});
