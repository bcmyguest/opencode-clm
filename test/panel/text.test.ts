import { describe, expect, test } from "bun:test";

import { buildPanelModel } from "../../src/panel/model.ts";
import { panelPageText, TEXT_WIDTH } from "../../src/panel/text.ts";
import { files } from "./fixtures.ts";
import { richModel } from "./model-fixture.ts";

const widths = (text: string) => Math.max(...text.split("\n").map((line) => [...line].length));

describe("panel pages as plain text", () => {
	test("overview", () => {
		const text = panelPageText(richModel(), "overview");
		expect(text).toStartWith("CLM overview · r2 · session ");
		expect(text).toContain("Context size · 4 requests");
		expect(text).toContain("fixed overhead ~9.0k");
		expect(widths(text)).toBeLessThanOrEqual(TEXT_WIDTH);
		expect(text).not.toMatch(/ +\n/);
	});

	test("input", () => {
		const text = panelPageText(richModel(), "input");
		expect(text).toContain("Current input");
		expect(text).toMatch(/Tokens +\S+ raw → \S+ effective/);
		expect(widths(text)).toBeLessThanOrEqual(TEXT_WIDTH);
	});

	test("edits", () => {
		const text = panelPageText(richModel(), "edits");
		expect(text).toContain("Live-context compression runs");
		expect(text).toMatch(/r\d+ from r\d+/);
		expect(widths(text)).toBeLessThanOrEqual(TEXT_WIDTH);
	});

	test("settings", () => {
		const text = panelPageText(richModel(), "settings");
		expect(text).toContain("Settings");
		expect(text).toMatch(/CLM editing +on/);
		expect(widths(text)).toBeLessThanOrEqual(TEXT_WIDTH);
	});

	test("a session without files", () => {
		expect(panelPageText(buildPanelModel(files({ found: false })), "overview")).toContain("No CLM data for this session.");
	});
});
