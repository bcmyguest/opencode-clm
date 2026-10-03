// Tests for src/panel/diff.ts. Cases rewritten from pi-clm src/__tests__/diff.test.ts
// (MIT, Copyright 2026 Emanuel Casco) for styled lines.

import { describe, expect, test } from "bun:test";

import {
	diffLines,
	diffWords,
	editDiffRows,
	limitRows,
	MIN_SIDE_BY_SIDE_WIDTH,
	renderDiff,
	renderSideBySide,
	renderUnified,
	sideBySideRows,
} from "../../src/panel/diff.ts";
import { lineWidth, plain, type Line } from "../../src/panel/lines.ts";

const titles = { leftTitle: "before", rightTitle: "after", leftPlaceholder: "(new)", rightPlaceholder: "(removed)" };

/** Plain text with emphasized spans in brackets, like pi's test style. */
function shown(line: Line): string {
	return line.map((part) => (part.tone === "diffAddEm" || part.tone === "diffDelEm" ? `[${part.text}]` : part.text)).join("");
}

describe("line diff", () => {
	test("aligns unchanged lines and numbers each side", () => {
		const ops = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne");
		expect(ops.map((op) => op.kind)).toEqual(["same", "removed", "added", "same", "same", "added"]);
		const added = ops.at(-1);
		expect(added?.kind === "added" ? added.right.line : 0).toBe(5);
	});

	test("LCS pairs replaced runs and folds long unchanged runs", () => {
		const before = Array.from({ length: 30 }, (_v, i) => `line ${i + 1}`).join("\n");
		const after = before.replace("line 15", "line fifteen");
		const rows = sideBySideRows(diffLines(before, after), 2);
		expect(rows.map((row) => row.kind)).toEqual(["skipped", "same", "same", "changed", "same", "same", "skipped"]);
		expect(rows[0]?.kind === "skipped" ? rows[0].count : 0).toBe(12);
		expect(rows[3]?.kind === "changed" ? `${rows[3].left.line}/${rows[3].right.line}` : "").toBe("15/15");
	});

	test("an uneven replaced run pairs what it can, then removes", () => {
		const rows = sideBySideRows(diffLines("keep\nx\ny\nz", "keep\nX"));
		expect(rows.map((row) => row.kind)).toEqual(["same", "changed", "removed", "removed"]);
	});

	test("identical text has no rows", () => {
		expect(sideBySideRows(diffLines("same\ntext", "same\ntext"))).toEqual([]);
	});

	test("an oversized table falls back to one replaced block", () => {
		const before = Array.from({ length: 1_500 }, (_v, i) => `old ${i}`).join("\n");
		const after = Array.from({ length: 1_500 }, (_v, i) => `new ${i}`).join("\n");
		const ops = diffLines(before, after);
		expect(ops.filter((op) => op.kind === "removed").length).toBe(1_500);
		expect(ops.filter((op) => op.kind === "added").length).toBe(1_500);
	});
});

describe("truncation", () => {
	test("limitRows keeps the head and counts the cut source lines", () => {
		const rows = sideBySideRows(diffLines("", Array.from({ length: 10 }, (_v, i) => `l${i}`).join("\n")));
		const limited = limitRows(rows, 4);
		expect(limited.length).toBe(5);
		expect(limited.at(-1)).toEqual({ kind: "omitted", count: 6 });
	});

	test("edited rows are bounded at 400, one-sided at 60", () => {
		const big = Array.from({ length: 1_000 }, (_v, i) => `line ${i}`).join("\n");
		const edited = editDiffRows("edited", big, big.replace(/line/g, "LINE"));
		expect(edited.length).toBe(401);
		expect(edited.at(-1)?.kind).toBe("omitted");
		const removed = editDiffRows("removed", big, "ignored");
		expect(removed.length).toBe(61);
		expect(removed.every((row) => row.kind === "removed" || row.kind === "omitted")).toBe(true);
		const added = editDiffRows("added", "ignored", "one\ntwo");
		expect(added.map((row) => row.kind)).toEqual(["added", "added"]);
	});

	test("the truncation row spans the width", () => {
		const rows = limitRows(sideBySideRows(diffLines("", "a\nb\nc")), 1);
		const lines = renderSideBySide(rows, 70, titles).map(plain);
		expect(lines.at(-1)).toBe("⋯ diff preview truncated: 2 more lines not shown");
	});

	test("lines over 2,000 characters are clipped with a count", () => {
		const long = "x".repeat(2_500);
		const lines = renderUnified(sideBySideRows(diffLines("", long)), 40, titles).map(plain).join("");
		expect(lines).toContain("… (+500 chars)");
	});
});

describe("word diff", () => {
	test("marks only the changed words of a changed pair", () => {
		const { left, right } = diffWords("estimated tokens 27779 to budget", "estimated tokens 27777 to budget");
		expect(left.filter((part) => part.changed).map((part) => part.text)).toEqual(["27779"]);
		expect(right.filter((part) => part.changed).map((part) => part.text)).toEqual(["27777"]);
	});
});

describe("side-by-side rendering", () => {
	test("two columns with change markers and emphasis", () => {
		const rows = sideBySideRows(diffLines("keep\nold value\ngone", "keep\nnew value\nextra"));
		const lines = renderSideBySide(rows, 80, titles);
		expect(lines.every((line) => lineWidth(line) <= 80)).toBe(true);
		expect(plain(lines[0]!)).toMatch(/^before\s+│ after/);
		expect(plain(lines[1]!)).toMatch(/┼/);
		const text = lines.map(shown);
		expect(text.find((line) => line.includes("[old]"))).toMatch(/\[old\] value\s+~ 2 \[new\] value/);
		expect(text.join("\n")).toMatch(/3 \[gone\]\s+~ 3 \[extra\]/);
		const changed = lines.find((line) => plain(line).includes("old"))!;
		expect(changed.find((part) => part.text === "old")?.tone).toBe("diffDelEm");
		expect(changed.find((part) => part.text === "new")?.tone).toBe("diffAddEm");
	});

	test("long lines wrap inside their column; the empty side gets the placeholder", () => {
		const rows = sideBySideRows(diffLines("x ".repeat(60).trim(), ""));
		const lines = renderSideBySide(rows, 70, titles);
		expect(lines.length).toBeGreaterThan(4);
		expect(lines.every((line) => lineWidth(line) <= 70)).toBe(true);
		expect(plain(lines[2]!)).toMatch(/−\s+\(removed\)/);
	});

	test("long placeholders wrap without crossing the column boundary", () => {
		for (const width of [60, 61, 64, 70]) {
			const lines = renderSideBySide(sideBySideRows(diffLines("deleted", "")), width, {
				...titles,
				rightPlaceholder: "(removed from the next request)",
			});
			expect(lines.every((line) => lineWidth(line) <= width)).toBe(true);
			expect(lines.map(plain).join("\n")).toMatch(/removed from/);
		}
	});

	test("folded runs show a count in both columns", () => {
		const before = Array.from({ length: 20 }, (_v, i) => `line ${i}`).join("\n");
		const lines = renderSideBySide(sideBySideRows(diffLines(before, before.replace("line 19", "end"))), 70, titles).map(plain);
		expect(lines[2]).toMatch(/^⋯ 16 unchanged lines\s+┆ ⋯ 16 unchanged lines$/);
	});
});

describe("narrow unified mode", () => {
	test("uses the -/+ convention with emphasis", () => {
		const rows = sideBySideRows(diffLines("a\nold", "a\nnew"));
		const lines = renderUnified(rows, 40, titles);
		expect(plain(lines[0]!)).toBe("before → after");
		const text = lines.map(shown);
		expect(text).toContain(" 1 a");
		expect(text).toContain("-2 [old]");
		expect(text).toContain("+2 [new]");
	});

	test("renderDiff switches to unified below the minimum width", () => {
		const rows = sideBySideRows(diffLines("a\nold", "a\nnew"));
		expect(plain(renderDiff(rows, MIN_SIDE_BY_SIDE_WIDTH - 1, titles)[0]!)).toBe("before → after");
		expect(plain(renderDiff(rows, MIN_SIDE_BY_SIDE_WIDTH, titles)[0]!)).toMatch(/^before\s+│ after/);
		for (const line of renderDiff(sideBySideRows(diffLines("", "word ".repeat(40))), 30, titles)) {
			expect(lineWidth(line)).toBeLessThanOrEqual(30);
		}
	});
});
