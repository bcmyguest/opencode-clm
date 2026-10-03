// Adapted from pi-clm src/diff.ts (MIT, Copyright 2026 Emanuel Casco).
//
// Line and word diffs for the `/clm` edits page, laid out side by side (unified below
// MIN_SIDE_BY_SIDE_WIDTH). A small self-contained LCS diff, so the plugin needs no diff
// dependency. Output is styled lines (lines.ts tones) rather than ANSI strings.

import { fit, normalize, padEnd, span, trimEnd, wrap, type Line, type Span, type Tone } from "./lines.ts";

export interface DiffLine {
	/** One-based line number in its own text. */
	line: number;
	text: string;
}

export type DiffOp =
	| { kind: "same"; left: DiffLine; right: DiffLine }
	| { kind: "removed"; left: DiffLine }
	| { kind: "added"; right: DiffLine };

export type SideBySideRow =
	| { kind: "same"; left: DiffLine; right: DiffLine }
	| { kind: "changed"; left: DiffLine; right: DiffLine }
	| { kind: "removed"; left: DiffLine }
	| { kind: "added"; right: DiffLine }
	| { kind: "skipped"; count: number }
	/** Rows cut by `limitRows`; `count` is the number of source lines not shown. */
	| { kind: "omitted"; count: number };

/** Above this many LCS cells the unmatched middle is treated as one replaced block. */
const MAX_LINE_CELLS = 1_000_000;
const MAX_WORD_CELLS = 40_000;
/** Longer lines are clipped for display (a minified blob would otherwise wrap into thousands of rows). */
export const MAX_LINE_CHARACTERS = 2_000;
/** Rows shown per edited message before an explicit "preview truncated" row. */
export const EDITED_DIFF_MAX_ROWS = 400;
/** Rows shown for a removed or added message (one-sided, so "expand all" stays cheap). */
export const ONE_SIDED_DIFF_MAX_ROWS = 60;
/** Below this width the diff is shown unified (one column). */
export const MIN_SIDE_BY_SIDE_WIDTH = 60;

function splitLines(text: string): string[] {
	if (text === "") return [];
	return text.replace(/\r\n?/g, "\n").split("\n");
}

/** LCS alignment of `a` and `b` as index pairs; undefined when the table would exceed `maxCells`. */
function lcsPairs<T>(a: readonly T[], b: readonly T[], maxCells: number): Array<[number, number]> | undefined {
	const n = a.length;
	const m = b.length;
	if (n === 0 || m === 0) return [];
	if ((n + 1) * (m + 1) > maxCells) return undefined;
	const stride = m + 1;
	const table = new Uint32Array((n + 1) * stride);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i * stride + j] = a[i] === b[j]
				? table[(i + 1) * stride + j + 1]! + 1
				: Math.max(table[(i + 1) * stride + j]!, table[i * stride + j + 1]!);
		}
	}
	const pairs: Array<[number, number]> = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			pairs.push([i++, j++]);
		} else if (table[(i + 1) * stride + j]! >= table[i * stride + j + 1]!) {
			i++;
		} else {
			j++;
		}
	}
	return pairs;
}

/** Line diff. The common prefix and suffix are matched first, so a small edit in a large body stays cheap. */
export function diffLines(before: string, after: string): DiffOp[] {
	const a = splitLines(before);
	const b = splitLines(after);
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	) suffix++;

	const ops: DiffOp[] = [];
	const same = (i: number, j: number) => ops.push({
		kind: "same",
		left: { line: i + 1, text: a[i]! },
		right: { line: j + 1, text: b[j]! },
	});
	for (let index = 0; index < prefix; index++) same(index, index);

	const middleA = a.slice(prefix, a.length - suffix);
	const middleB = b.slice(prefix, b.length - suffix);
	const pairs = lcsPairs(middleA, middleB, MAX_LINE_CELLS) ?? [];
	let i = 0;
	let j = 0;
	const flushTo = (untilI: number, untilJ: number) => {
		for (; i < untilI; i++) ops.push({ kind: "removed", left: { line: prefix + i + 1, text: middleA[i]! } });
		for (; j < untilJ; j++) ops.push({ kind: "added", right: { line: prefix + j + 1, text: middleB[j]! } });
	};
	for (const [pi, pj] of pairs) {
		flushTo(pi, pj);
		same(prefix + i, prefix + j);
		i++;
		j++;
	}
	flushTo(middleA.length, middleB.length);
	for (let index = 0; index < suffix; index++) same(a.length - suffix + index, b.length - suffix + index);
	return ops;
}

/**
 * Pairs removed/added runs into `changed` rows (like `diff -y`) and folds unchanged runs
 * longer than `2 × context` into a `skipped` row. Returns [] when nothing differs.
 */
export function sideBySideRows(ops: readonly DiffOp[], context = 3): SideBySideRow[] {
	if (!ops.some((op) => op.kind !== "same")) return [];
	const paired: SideBySideRow[] = [];
	for (let index = 0; index < ops.length;) {
		const op = ops[index]!;
		if (op.kind === "same") {
			paired.push(op);
			index++;
			continue;
		}
		const removed: DiffLine[] = [];
		const added: DiffLine[] = [];
		for (let next = ops[index]; next?.kind === "removed"; next = ops[++index]) removed.push(next.left);
		for (let next = ops[index]; next?.kind === "added"; next = ops[++index]) added.push(next.right);
		const count = Math.max(removed.length, added.length);
		for (let k = 0; k < count; k++) {
			const left = removed[k];
			const right = added[k];
			if (left && right) paired.push({ kind: "changed", left, right });
			else if (left) paired.push({ kind: "removed", left });
			else if (right) paired.push({ kind: "added", right });
		}
	}

	const rows: SideBySideRow[] = [];
	for (let index = 0; index < paired.length;) {
		if (paired[index]!.kind !== "same") {
			rows.push(paired[index++]!);
			continue;
		}
		let end = index;
		while (end < paired.length && paired[end]!.kind === "same") end++;
		const run = paired.slice(index, end);
		// Context is kept only on the side that touches a change.
		const keepHead = index === 0 ? 0 : context;
		const keepTail = end === paired.length ? 0 : context;
		if (run.length <= keepHead + keepTail + 1) {
			rows.push(...run);
		} else {
			rows.push(...run.slice(0, keepHead));
			rows.push({ kind: "skipped", count: run.length - keepHead - keepTail });
			rows.push(...run.slice(run.length - keepTail));
		}
		index = end;
	}
	return rows;
}

function rowLineCount(row: SideBySideRow): number {
	return row.kind === "skipped" || row.kind === "omitted" ? row.count : 1;
}

/** Keeps at most `maxRows` rows and replaces the rest with one `omitted` row. */
export function limitRows(rows: readonly SideBySideRow[], maxRows: number): SideBySideRow[] {
	if (rows.length <= maxRows) return [...rows];
	const kept = rows.slice(0, Math.max(0, maxRows));
	const count = rows.slice(kept.length).reduce((total, row) => total + rowLineCount(row), 0);
	return [...kept, { kind: "omitted", count }];
}

export type EditDiffKind = "kept" | "edited" | "removed" | "restored" | "normalized" | "added";

/**
 * Diff rows for one edit row of the edits page, bounded for display: removed and added
 * messages compare against an empty side and show fewer rows. The diff itself runs on the
 * full text, so a change anywhere is found.
 */
export function editDiffRows(kind: EditDiffKind, before: string, after: string): SideBySideRow[] {
	const left = kind === "added" ? "" : before;
	const right = kind === "removed" ? "" : after;
	const maxRows = kind === "removed" || kind === "added" ? ONE_SIDED_DIFF_MAX_ROWS : EDITED_DIFF_MAX_ROWS;
	return limitRows(sideBySideRows(diffLines(left, right)), maxRows);
}

export interface WordSpan {
	text: string;
	changed: boolean;
}

function tokenize(text: string): string[] {
	return text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

function mergeWordSpans(tokens: readonly string[], changed: readonly boolean[]): WordSpan[] {
	const spans: WordSpan[] = [];
	tokens.forEach((token, index) => {
		const flag = changed[index]!;
		const last = spans.at(-1);
		if (last && last.changed === flag) last.text += token;
		else spans.push({ text: token, changed: flag });
	});
	return spans;
}

/** Word-level spans for a changed line pair; all changed when the lines are too long to align. */
export function diffWords(before: string, after: string): { left: WordSpan[]; right: WordSpan[] } {
	const a = tokenize(before);
	const b = tokenize(after);
	const pairs = lcsPairs(a, b, MAX_WORD_CELLS);
	if (!pairs) {
		return {
			left: before ? [{ text: before, changed: true }] : [],
			right: after ? [{ text: after, changed: true }] : [],
		};
	}
	const leftChanged = a.map(() => true);
	const rightChanged = b.map(() => true);
	for (const [i, j] of pairs) {
		leftChanged[i] = false;
		rightChanged[j] = false;
	}
	// Whitespace alone between two changed words is not a meaningful match.
	const markIsolatedSpace = (tokens: string[], changed: boolean[]) => {
		for (let k = 1; k < tokens.length - 1; k++) {
			if (!changed[k] && /^\s+$/.test(tokens[k]!) && changed[k - 1] && changed[k + 1]) changed[k] = true;
		}
	};
	markIsolatedSpace(a, leftChanged);
	markIsolatedSpace(b, rightChanged);
	return { left: mergeWordSpans(a, leftChanged), right: mergeWordSpans(b, rightChanged) };
}

export interface DiffTitles {
	leftTitle: string;
	rightTitle: string;
	/** Shown in the empty column when one side has no text at all. */
	leftPlaceholder?: string;
	rightPlaceholder?: string;
}

const CONTEXT: Tone = "muted";
const LINE_NUMBER: Tone = "dim";
const MUTED: Tone = "muted";
const TITLE: Tone = "accent";

function sanitize(text: string): string {
	// Tabs become three spaces; other control characters would corrupt the layout.
	const clean = text.replace(/\t/g, "   ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "�");
	return clean.length <= MAX_LINE_CHARACTERS
		? clean
		: `${clean.slice(0, MAX_LINE_CHARACTERS)}… (+${clean.length - MAX_LINE_CHARACTERS} chars)`;
}

function clipLine(text: string): string {
	return text.length <= MAX_LINE_CHARACTERS ? text : text.slice(0, MAX_LINE_CHARACTERS);
}

function omittedLabel(count: number): string {
	return `⋯ diff preview truncated: ${count} more line${count === 1 ? "" : "s"} not shown`;
}

function skippedLabel(count: number): string {
	return `⋯ ${count} unchanged line${count === 1 ? "" : "s"}`;
}

/** Changed words get the emphasis tone of their side. */
function wordLine(spans: readonly WordSpan[], side: "left" | "right"): Line {
	const base: Tone = side === "left" ? "diffDel" : "diffAdd";
	const emphasis: Tone = side === "left" ? "diffDelEm" : "diffAddEm";
	return normalize(spans.map((part) => span(sanitize(part.text), part.changed ? emphasis : base)));
}

interface RowSides {
	left?: { line: number; text: Line };
	right?: { line: number; text: Line };
	marker: Span;
}

function rowSides(row: Exclude<SideBySideRow, { kind: "skipped" | "omitted" }>): RowSides {
	switch (row.kind) {
		case "same":
			return {
				left: { line: row.left.line, text: [span(sanitize(row.left.text), CONTEXT)] },
				right: { line: row.right.line, text: [span(sanitize(row.right.text), CONTEXT)] },
				marker: span("│", MUTED),
			};
		case "removed":
			return { left: { line: row.left.line, text: [span(sanitize(row.left.text), "diffDel")] }, marker: span("−", "diffDel") };
		case "added":
			return { right: { line: row.right.line, text: [span(sanitize(row.right.text), "diffAdd")] }, marker: span("+", "diffAdd") };
		case "changed": {
			const words = diffWords(clipLine(row.left.text), clipLine(row.right.text));
			return {
				left: { line: row.left.line, text: wordLine(words.left, "left") },
				right: { line: row.right.line, text: wordLine(words.right, "right") },
				marker: span("~", TITLE),
			};
		}
	}
}

function lineNumberWidth(rows: readonly SideBySideRow[]): number {
	let max = 1;
	for (const row of rows) {
		if (row.kind === "skipped" || row.kind === "omitted") continue;
		if ("left" in row) max = Math.max(max, row.left.line);
		if ("right" in row) max = Math.max(max, row.right.line);
	}
	return String(max).length;
}

function wrapped(text: Line, width: number): Line[] {
	return text.length === 0 ? [[]] : wrap(text, width);
}

/**
 * Two columns of `line-number text`, separated by a marker column: `│` unchanged, `~`
 * changed pair (changed words in the emphasis tone), `−` removed, `+` added. Every line
 * is at most `width` cells wide.
 */
export function renderSideBySide(rows: readonly SideBySideRow[], width: number, titles: DiffTitles): Line[] {
	const leftWidth = Math.max(8, Math.floor((width - 3) / 2));
	const rightWidth = Math.max(8, width - 3 - leftWidth);
	const gutter = lineNumberWidth(rows);
	const leftText = Math.max(1, leftWidth - gutter - 1);
	const rightText = Math.max(1, rightWidth - gutter - 1);

	const lines: Line[] = [
		normalize([...fit([span(titles.leftTitle, TITLE)], leftWidth), span(" │ ", MUTED), ...fit([span(titles.rightTitle, TITLE)], rightWidth)]),
		[span(`${"─".repeat(leftWidth)}─┼─${"─".repeat(rightWidth)}`, MUTED)],
	];
	const content = (row: SideBySideRow) => row.kind !== "skipped" && row.kind !== "omitted";
	let placeholderLeft = rows.some((row) => content(row) && row.kind !== "added") ? undefined : titles.leftPlaceholder;
	let placeholderRight = rows.some((row) => content(row) && row.kind !== "removed") ? undefined : titles.rightPlaceholder;
	const number = (line: number | undefined): Span =>
		span(line === undefined ? " ".repeat(gutter) : String(line).padStart(gutter, " "), LINE_NUMBER);

	for (const row of rows) {
		if (row.kind === "skipped") {
			const label = [span(skippedLabel(row.count), MUTED)];
			lines.push(trimEnd(normalize([...fit(label, leftWidth), span(" ┆ ", MUTED), ...fit(label, rightWidth)])));
			continue;
		}
		if (row.kind === "omitted") {
			// Spans both columns: it describes the diff, not one side.
			lines.push(...wrap([span(omittedLabel(row.count), TITLE)], width));
			continue;
		}
		const sides = rowSides(row);
		// Placeholders wrap inside their own column like text.
		const leftLines = sides.left
			? wrapped(sides.left.text, leftText)
			: placeholderLeft ? wrap([span(placeholderLeft, MUTED)], leftText) : [[]];
		const rightLines = sides.right
			? wrapped(sides.right.text, rightText)
			: placeholderRight ? wrap([span(placeholderRight, MUTED)], rightText) : [[]];
		if (!sides.left) placeholderLeft = undefined;
		if (!sides.right) placeholderRight = undefined;
		const height = Math.max(leftLines.length, rightLines.length);
		for (let k = 0; k < height; k++) {
			const left = padEnd([number(k === 0 ? sides.left?.line : undefined), span(" "), ...(leftLines[k] ?? [])], leftWidth);
			const right = [number(k === 0 ? sides.right?.line : undefined), span(" "), ...(rightLines[k] ?? [])];
			const marker = k === 0 ? sides.marker : span("│", MUTED);
			lines.push(trimEnd(normalize([...left, span(" "), marker, span(" "), ...right])));
		}
	}
	return lines;
}

/** One-column `-`/`+` layout for narrow widths. */
export function renderUnified(rows: readonly SideBySideRow[], width: number, titles: DiffTitles): Line[] {
	const gutter = lineNumberWidth(rows);
	const textWidth = Math.max(1, width - gutter - 2);
	const lines: Line[] = [...wrap([span(`${titles.leftTitle} → ${titles.rightTitle}`, TITLE)], width)];
	const emit = (prefix: Span, line: number | undefined, text: Line) => {
		wrapped(text, textWidth).forEach((part, k) => {
			const number = span(k === 0 && line !== undefined ? String(line).padStart(gutter, " ") : " ".repeat(gutter), LINE_NUMBER);
			lines.push(trimEnd(normalize([k === 0 ? prefix : span(" "), number, span(" "), ...part])));
		});
	};
	for (const row of rows) {
		switch (row.kind) {
			case "skipped":
				lines.push([span(`${" ".repeat(gutter + 2)}${skippedLabel(row.count)}`, MUTED)]);
				break;
			case "omitted":
				lines.push(...wrap([span(omittedLabel(row.count), TITLE)], width));
				break;
			case "same":
				emit(span(" "), row.left.line, [span(sanitize(row.left.text), CONTEXT)]);
				break;
			case "removed":
				emit(span("-", "diffDel"), row.left.line, [span(sanitize(row.left.text), "diffDel")]);
				break;
			case "added":
				emit(span("+", "diffAdd"), row.right.line, [span(sanitize(row.right.text), "diffAdd")]);
				break;
			case "changed": {
				const words = diffWords(clipLine(row.left.text), clipLine(row.right.text));
				emit(span("-", "diffDel"), row.left.line, wordLine(words.left, "left"));
				emit(span("+", "diffAdd"), row.right.line, wordLine(words.right, "right"));
				break;
			}
		}
	}
	return lines;
}

/** Side by side at `MIN_SIDE_BY_SIDE_WIDTH` and wider, unified below. */
export function renderDiff(rows: readonly SideBySideRow[], width: number, titles: DiffTitles): Line[] {
	return width >= MIN_SIDE_BY_SIDE_WIDTH ? renderSideBySide(rows, width, titles) : renderUnified(rows, width, titles);
}
