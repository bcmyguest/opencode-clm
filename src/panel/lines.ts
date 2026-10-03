// Styled lines for the `/clm` panel: spans carry theme tones instead of ANSI escapes, so
// the pure renderers can be tested as plain text and the TUI adapter maps each tone to
// the host theme. Written for this package.

export type Tone =
	| "text"
	| "muted"
	| "dim"
	| "accent"
	| "edit"
	| "warning"
	| "error"
	| "success"
	| "diffAdd"
	| "diffDel"
	| "diffAddEm"
	| "diffDelEm"
	| "border";

export interface Span {
	text: string;
	tone?: Tone;
	bold?: boolean;
}

export type Line = Span[];

export function span(text: string, tone?: Tone, bold?: boolean): Span {
	const result: Span = { text };
	if (tone !== undefined) result.tone = tone;
	if (bold) result.bold = true;
	return result;
}

/** The text of a line without styles. */
export function plain(line: readonly Span[]): string {
	return line.map((part) => part.text).join("");
}

/**
 * Terminal cells of one code point: 0 for combining marks, 2 for East Asian wide and
 * emoji ranges, 1 otherwise. An approximation; it covers the scripts a diff is likely to show.
 */
export function charWidth(char: string): number {
	const code = char.codePointAt(0) ?? 0;
	if (code === 0) return 0;
	if ((code >= 0x0300 && code <= 0x036f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f) return 0;
	if (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1faff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	) return 2;
	return 1;
}

export function textWidth(text: string): number {
	let width = 0;
	for (const char of text) width += charWidth(char);
	return width;
}

export function lineWidth(line: readonly Span[]): number {
	return line.reduce((total, part) => total + textWidth(part.text), 0);
}

function sameStyle(a: Span, b: Span): boolean {
	return a.tone === b.tone && Boolean(a.bold) === Boolean(b.bold);
}

/** Drops empty spans and merges neighbours with the same style. */
export function normalize(line: readonly Span[]): Line {
	const result: Line = [];
	for (const part of line) {
		if (part.text === "") continue;
		const last = result.at(-1);
		if (last && sameStyle(last, part)) last.text += part.text;
		else result.push({ ...part });
	}
	return result;
}

/** Gives every span without a tone the given tone. */
export function withTone(line: readonly Span[], tone: Tone): Line {
	return line.map((part) => (part.tone === undefined ? { ...part, tone } : { ...part }));
}

/** Cuts a line to `width` cells, ending with `ellipsis` (styled like the cut span) when it was cut. */
export function truncate(line: readonly Span[], width: number, ellipsis = "…"): Line {
	if (width <= 0) return [];
	if (lineWidth(line) <= width) return line.map((part) => ({ ...part }));
	const target = Math.max(0, width - textWidth(ellipsis));
	const result: Line = [];
	let used = 0;
	let lastStyle: Span | undefined;
	for (const part of line) {
		let text = "";
		for (const char of part.text) {
			const cells = charWidth(char);
			if (used + cells > target) break;
			text += char;
			used += cells;
		}
		lastStyle = part;
		if (text) result.push({ ...part, text });
		if (text.length < part.text.length) break;
	}
	if (ellipsis && textWidth(ellipsis) <= width) {
		result.push({ ...(lastStyle ?? {}), text: ellipsis });
	}
	return normalize(result);
}

/** Pads a line with plain spaces to `width` cells (no-op when already wider). */
export function padEnd(line: readonly Span[], width: number): Line {
	const missing = width - lineWidth(line);
	const result = line.map((part) => ({ ...part }));
	if (missing > 0) result.push({ text: " ".repeat(missing) });
	return result;
}

/** Fits a line to exactly `width` cells: truncated with an ellipsis, then padded. */
export function fit(line: readonly Span[], width: number): Line {
	return padEnd(truncate(line, width), width);
}

/** Removes trailing whitespace. */
export function trimEnd(line: readonly Span[]): Line {
	const result = line.map((part) => ({ ...part }));
	while (result.length > 0) {
		const last = result.at(-1)!;
		last.text = last.text.replace(/\s+$/u, "");
		if (last.text !== "") break;
		result.pop();
	}
	return result;
}

export function concat(...lines: ReadonlyArray<readonly Span[]>): Line {
	return normalize(lines.flat());
}

interface Cell {
	char: string;
	width: number;
	style: Span;
}

function toCells(line: readonly Span[]): Cell[] {
	const cells: Cell[] = [];
	for (const part of line) {
		for (const char of part.text) cells.push({ char, width: charWidth(char), style: part });
	}
	return cells;
}

function fromCells(cells: readonly Cell[]): Line {
	return normalize(cells.map((cell) => {
		const out: Span = { text: cell.char };
		if (cell.style.tone !== undefined) out.tone = cell.style.tone;
		if (cell.style.bold) out.bold = true;
		return out;
	}));
}

function cellsWidth(cells: readonly Cell[]): number {
	return cells.reduce((total, cell) => total + cell.width, 0);
}

/** Splits a line at newline characters, keeping styles. */
export function splitNewlines(line: readonly Span[]): Line[] {
	const rows: Line[] = [[]];
	for (const part of line) {
		const pieces = part.text.split(/\r\n?|\n/);
		pieces.forEach((piece, index) => {
			if (index > 0) rows.push([]);
			if (piece) rows.at(-1)!.push({ ...part, text: piece });
		});
	}
	return rows;
}

/**
 * Word-wraps a styled line to `width` cells. Breaks at whitespace when it can and inside a
 * word when the word alone is wider than the row. Leading whitespace of the first row is
 * kept (indentation); whitespace at a break is dropped. Newlines start a new row. Always
 * returns at least one row.
 */
export function wrap(line: readonly Span[], width: number): Line[] {
	if (width <= 0) return [[]];
	const rows: Line[] = [];
	for (const physical of splitNewlines(line)) rows.push(...wrapOne(physical, width));
	return rows.length > 0 ? rows : [[]];
}

function wrapOne(line: readonly Span[], width: number): Line[] {
	// A cell wider than the row (a wide character at width 1) is shown as "?".
	const cells = toCells(line).map((cell) => (cell.width > width ? { ...cell, char: "?", width: 1 } : cell));
	if (cells.length === 0) return [[]];
	// Tokens: runs of whitespace or of non-whitespace.
	const tokens: Cell[][] = [];
	for (const cell of cells) {
		const space = /\s/u.test(cell.char);
		const last = tokens.at(-1);
		if (last && /\s/u.test(last[0]!.char) === space) last.push(cell);
		else tokens.push([cell]);
	}
	const rows: Cell[][] = [];
	let row: Cell[] = [];
	let used = 0;
	const flush = () => {
		while (row.length > 0 && /\s/u.test(row.at(-1)!.char)) used -= row.pop()!.width;
		rows.push(row);
		row = [];
		used = 0;
	};
	for (const token of tokens) {
		const tokenWidth = cellsWidth(token);
		const space = /\s/u.test(token[0]!.char);
		if (space) {
			if (row.length === 0 && rows.length > 0) continue; // no leading space after a break
			if (row.length === 0 && tokenWidth > width) {
				// Indentation wider than the row: keep what fits rather than an empty row.
				for (const cell of token) {
					if (used + cell.width > width) break;
					row.push(cell);
					used += cell.width;
				}
				continue;
			}
			if (used + tokenWidth <= width) {
				row.push(...token);
				used += tokenWidth;
			} else {
				flush();
			}
			continue;
		}
		if (used + tokenWidth <= width) {
			row.push(...token);
			used += tokenWidth;
			continue;
		}
		if (tokenWidth <= width && row.length > 0) {
			flush();
			row.push(...token);
			used = tokenWidth;
			continue;
		}
		// Hard break: the word is wider than a row.
		for (const cell of token) {
			if (used + cell.width > width && row.length > 0) flush();
			row.push(cell);
			used += cell.width;
		}
	}
	if (row.length > 0 || rows.length === 0) flush();
	return rows.map(fromCells);
}

/** Wraps plain text in one tone. */
export function wrapText(text: string, width: number, tone?: Tone, bold?: boolean): Line[] {
	return wrap([span(text, tone, bold)], width);
}
