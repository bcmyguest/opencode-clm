// Tests for src/panel/lines.ts.

import { describe, expect, test } from "bun:test";

import { fit, lineWidth, normalize, plain, span, textWidth, trimEnd, truncate, wrap, wrapText } from "../../src/panel/lines.ts";

describe("styled lines", () => {
	test("plain and widths", () => {
		const line = [span("ab", "accent"), span("cd")];
		expect(plain(line)).toBe("abcd");
		expect(lineWidth(line)).toBe(4);
		expect(textWidth("日本")).toBe(4);
		expect(textWidth("e\u0301")).toBe(1);
	});

	test("normalize merges equal styles and drops empty spans", () => {
		expect(normalize([span("a", "muted"), span(""), span("b", "muted"), span("c", "muted", true)])).toEqual([
			{ text: "ab", tone: "muted" },
			{ text: "c", tone: "muted", bold: true },
		]);
	});

	test("truncate keeps styles and adds an ellipsis", () => {
		const cut = truncate([span("hello", "accent"), span(" world", "muted")], 8);
		expect(plain(cut)).toBe("hello w…");
		expect(cut.at(-1)?.tone).toBe("muted");
		expect(plain(truncate([span("short")], 10))).toBe("short");
		expect(plain(fit([span("ab")], 4))).toBe("ab  ");
	});

	test("trimEnd removes trailing whitespace across spans", () => {
		expect(trimEnd([span("a  ", "muted"), span("   ")])).toEqual([{ text: "a", tone: "muted" }]);
	});

	test("wrap breaks at spaces, keeps styles, hard-breaks long words", () => {
		const rows = wrap([span("one two ", "accent"), span("three", "error")], 7);
		expect(rows.map(plain)).toEqual(["one two", "three"]);
		expect(rows[1]).toEqual([{ text: "three", tone: "error" }]);
		expect(wrapText("abcdefghij", 4).map(plain)).toEqual(["abcd", "efgh", "ij"]);
		expect(wrapText("  indented text", 10).map(plain)).toEqual(["  indented", "text"]);
		expect(wrapText("a\nb", 10).map(plain)).toEqual(["a", "b"]);
		expect(wrap([], 10)).toEqual([[]]);
		for (const row of wrapText("日本語のテキスト", 5)) expect(lineWidth(row)).toBeLessThanOrEqual(5);
	});
});
