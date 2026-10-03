// Tests for src/panel/command.ts.

import { describe, expect, test } from "bun:test";

import { CLM_USAGE, parseClmCommand } from "../../src/panel/command.ts";

describe("parseClmCommand", () => {
	test("not a /clm line", () => {
		expect(parseClmCommand("hello")).toBeUndefined();
		expect(parseClmCommand("/clm-compact keep the plan")).toBeUndefined();
		expect(parseClmCommand("/clmx")).toBeUndefined();
	});

	test("pages", () => {
		expect(parseClmCommand("/clm")).toEqual({ kind: "open", page: "overview" });
		expect(parseClmCommand("  /clm  ")).toEqual({ kind: "open", page: "overview" });
		expect(parseClmCommand("/clm input")).toEqual({ kind: "open", page: "input" });
		expect(parseClmCommand("/clm EDITS")).toEqual({ kind: "open", page: "edits" });
		expect(parseClmCommand("/clm settings")).toEqual({ kind: "open", page: "settings" });
		expect(parseClmCommand("/clm config")).toEqual({ kind: "open", page: "settings" });
	});

	test("config", () => {
		expect(parseClmCommand("/clm config Budget")).toEqual({ kind: "config-show", setting: "budget" });
		expect(parseClmCommand("/clm config budget 200k")).toEqual({ kind: "config-set", setting: "budget", value: "200k" });
		expect(parseClmCommand("/clm config steering /Path/With Spaces.md")).toEqual({
			kind: "config-set", setting: "steering", value: "/Path/With Spaces.md",
		});
		expect(parseClmCommand("/clm config reset")).toEqual({ kind: "config-reset" });
	});

	test("status, path, on/off, reset, usage", () => {
		expect(parseClmCommand("/clm status")).toEqual({ kind: "status" });
		expect(parseClmCommand("/clm path")).toEqual({ kind: "path" });
		expect(parseClmCommand("/clm off")).toEqual({ kind: "enable", enabled: false });
		expect(parseClmCommand("/clm on")).toEqual({ kind: "enable", enabled: true });
		expect(parseClmCommand("/clm reset")).toEqual({ kind: "server", args: "reset" });
		expect(parseClmCommand("/clm bogus")).toEqual({ kind: "usage", text: CLM_USAGE });
		expect(parseClmCommand("/clm status now")).toEqual({ kind: "usage", text: CLM_USAGE });
	});
});
