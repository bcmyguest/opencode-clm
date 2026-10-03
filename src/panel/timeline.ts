// Adapted from pi-clm src/timeline.ts (MIT, Copyright 2026 Emanuel Casco).
//
// Context-size timeline for the `/clm` overview page: one point per request, markers where
// an edit was accepted or rejected, the projection reset, or OpenCode compacted. pi builds
// the timeline from session entries; here model.ts builds it from events.jsonl, so this
// module holds only the shapes, the column layout and the chart. The chart returns styled
// lines (tones, see lines.ts) instead of strings run through style hooks.

import { normalize, span, type Line, type Span, type Tone } from "./lines.ts";

export interface TimelinePoint {
	/** 1-based request number in this session. */
	request: number;
	at?: string;
	/** Context size of this request: provider-reported when `measured`, else the CLM estimate. */
	tokens: number;
	measured: boolean;
	/** The CLM estimate logged for this request, kept beside a provider count (`measured`). */
	estimated?: number;
	/** Live-context revision active when the request was sent. */
	revision: number;
}

export type MarkerKind = "applied" | "rejected" | "reset" | "compacted" | "restored";

export interface TimelineMarker {
	kind: MarkerKind;
	/** Revision in force after the marker. */
	revision: number;
	at?: string;
	/** Index into `points` of the request after which this marker was recorded (−1 = before any). */
	afterPoint: number;
	beforeTokens?: number;
	afterTokens?: number;
	message: string;
}

export interface ContextTimeline {
	points: TimelinePoint[];
	markers: TimelineMarker[];
	peakTokens: number;
	/** Indices into `points` of the first request after each user message (turn landmarks). */
	turnStarts: number[];
}

export function formatTokenCount(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

/**
 * How requests map to columns.
 * - `fit`: the whole session, consecutive requests bucketed to the width (default).
 * - `requests`: one column per request; a window around the focus when the session is wider.
 * - `turns`: one column per user turn, consecutive turns grouped when there are too many.
 * Wall-clock buckets are not offered: idle gaps would become empty space and bursts of tool
 * calls would collapse into one bar.
 */
export type TimelineZoom = "fit" | "requests" | "turns";
export const TIMELINE_ZOOMS: readonly TimelineZoom[] = ["fit", "requests", "turns"];

export interface TimelineChartOptions {
	width: number;
	height: number;
	/** Default `requests`, as in pi; the panel passes its zoom state (default `fit`). */
	zoom?: TimelineZoom;
	/** Budget drawn as a dashed row when it is within 2× the peak. */
	budget?: number;
	/** Index into `markers` to highlight. */
	selectedMarker?: number;
	/** Index into `points` whose column is highlighted (the panel's "now"). Wins over `selectedMarker`. */
	selectedPoint?: number;
	/** Index into `points` kept visible in `requests` zoom (window centred on it). */
	focusPoint?: number;
}

/** Tones of the chart parts: grey context, blue edits, white selection, yellow budget. */
const STYLE = {
	bar: { tone: "muted" },
	editBar: { tone: "edit" },
	marker: { tone: "edit" },
	budget: { tone: "warning" },
	axis: { tone: "dim" },
	selected: { tone: "text", bold: true },
	selectedMarker: { tone: "edit", bold: true },
	landmark: { tone: "dim" },
} as const satisfies Record<string, { tone: Tone; bold?: boolean }>;

function styled(text: string, style: { tone: Tone; bold?: boolean }): Span {
	return span(text, style.tone, "bold" in style ? style.bold : undefined);
}

/**
 * The window of consecutive requests to draw: at most `columns`, centred on `focus` and
 * clamped so it stays full (a focus near the newest request keeps the newest at the right edge).
 */
export function timelineWindow(pointCount: number, columns: number, focus: number | undefined): { start: number; end: number } {
	const size = Math.max(1, Math.min(columns, pointCount));
	if (pointCount <= size) return { start: 0, end: pointCount };
	let start = pointCount - size;
	if (focus !== undefined && focus >= 0 && focus < pointCount) {
		start = Math.max(0, Math.min(pointCount - size, focus - Math.floor(size / 2)));
	}
	return { start, end: start + size };
}

export interface TimelineBucket {
	/** Inclusive range of indices into `points`. */
	first: number;
	last: number;
	/** Peak size in the bucket (keeps spikes visible). */
	tokens: number;
	/** Size of the bucket's last request. */
	finalTokens: number;
	/** User turns that start in this bucket. */
	turns: number;
	/** Indices into `markers` of accepted edits recorded after a request in this bucket. */
	edits: number[];
}

export interface TimelineLayout {
	zoom: TimelineZoom;
	buckets: TimelineBucket[];
	columnWidth: number;
	gap: number;
	/** Largest number of requests in one bucket. */
	requestsPerColumn: number;
	/** Turns per column in `turns` zoom. */
	turnsPerColumn: number;
}

/** Cells before the axis, e.g. ` 32.0k `. */
export const CHART_LABEL_WIDTH = 7;

function plotWidthFor(width: number): number {
	return Math.max(8, width - CHART_LABEL_WIDTH - 1);
}

/** Few buckets: up to 3 cells per column plus a gap; many: one cell each. */
function columnGeometry(bucketCount: number, plotWidth: number): { columnWidth: number; gap: number; columns: number } {
	const columnWidth = Math.max(1, Math.min(3, Math.floor(plotWidth / Math.max(1, bucketCount)) - 1));
	const gap = bucketCount * (columnWidth + 1) <= plotWidth && columnWidth > 1 ? 1 : 0;
	return { columnWidth, gap, columns: Math.max(1, Math.floor(plotWidth / (columnWidth + gap))) };
}

/** Start indices of user-turn groups; requests before the first user message form group 0. */
function turnGroupStarts(timeline: ContextTimeline): number[] {
	const starts = new Set(timeline.turnStarts);
	starts.add(0);
	return [...starts].filter((index) => index >= 0 && index < timeline.points.length).sort((a, b) => a - b);
}

function bucketOf(timeline: ContextTimeline, first: number, last: number, turnStarts: ReadonlySet<number>): TimelineBucket {
	let tokens = 0;
	let turns = 0;
	for (let index = first; index <= last; index++) {
		tokens = Math.max(tokens, timeline.points[index]?.tokens ?? 0);
		if (turnStarts.has(index)) turns++;
	}
	return { first, last, tokens, finalTokens: timeline.points[last]?.tokens ?? 0, turns, edits: [] };
}

/** The columns a chart of `width` shows for `zoom`; shared by the chart and the panel's detail line. */
export function layoutTimeline(
	timeline: ContextTimeline,
	options: Pick<TimelineChartOptions, "width" | "zoom" | "focusPoint">,
): TimelineLayout {
	const zoom = options.zoom ?? "requests";
	const count = timeline.points.length;
	const plotWidth = plotWidthFor(options.width);
	const turnStarts = new Set(timeline.turnStarts);
	const ranges: Array<[number, number]> = [];
	let requestsPerColumn = 1;
	let turnsPerColumn = 1;
	switch (zoom) {
		case "requests": {
			const { columns } = columnGeometry(count, plotWidth);
			const window = timelineWindow(count, columns, options.focusPoint);
			for (let index = window.start; index < window.end; index++) ranges.push([index, index]);
			break;
		}
		case "fit": {
			requestsPerColumn = Math.max(1, Math.ceil(count / plotWidth));
			for (let first = 0; first < count; first += requestsPerColumn) {
				ranges.push([first, Math.min(count, first + requestsPerColumn) - 1]);
			}
			break;
		}
		case "turns": {
			const starts = turnGroupStarts(timeline);
			turnsPerColumn = Math.max(1, Math.ceil(starts.length / plotWidth));
			for (let group = 0; group < starts.length; group += turnsPerColumn) {
				const next = starts[group + turnsPerColumn];
				ranges.push([starts[group]!, (next ?? count) - 1]);
			}
			requestsPerColumn = ranges.reduce((most, [first, last]) => Math.max(most, last - first + 1), 1);
			break;
		}
	}
	const buckets = ranges.map(([first, last]) => bucketOf(timeline, first, last, turnStarts));
	timeline.markers.forEach((marker, index) => {
		if (marker.kind !== "applied") return;
		const column = bucketIndexIn(buckets, marker.afterPoint);
		if (column >= 0) buckets[column]!.edits.push(index);
	});
	const { columnWidth, gap } = columnGeometry(buckets.length, plotWidth);
	return { zoom, buckets, columnWidth, gap, requestsPerColumn, turnsPerColumn };
}

function bucketIndexIn(buckets: readonly TimelineBucket[], point: number | undefined): number {
	if (point === undefined || point < 0) return -1;
	return buckets.findIndex((bucket) => point >= bucket.first && point <= bucket.last);
}

/** Index of the bucket holding `point`, or −1 (e.g. panned out of view in `requests` zoom). */
export function bucketIndexOf(layout: TimelineLayout, point: number | undefined): number {
	return bucketIndexIn(layout.buckets, point);
}

/**
 * Zooms worth offering at this width. When every request already has its own column, `fit`
 * is the per-request view, so `requests` is dropped.
 */
export function availableTimelineZooms(timeline: ContextTimeline, width: number): TimelineZoom[] {
	const fitsWidth = timeline.points.length <= plotWidthFor(width);
	return TIMELINE_ZOOMS.filter((zoom) => !(fitsWidth && zoom === "requests"));
}

/** `hh:mm` in the local time zone, or undefined for a missing or invalid time. */
export function formatClockTime(at: string | undefined): string | undefined {
	if (!at) return undefined;
	const date = new Date(at);
	return Number.isNaN(date.valueOf()) ? undefined : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(milliseconds: number): string {
	const minutes = Math.round(milliseconds / 60_000);
	if (minutes < 1) return "<1 min";
	if (minutes < 60) return `${minutes} min`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function timeSpan(timeline: ContextTimeline, first: number, last: number): string | undefined {
	const start = timeline.points[first]?.at;
	const end = timeline.points[last]?.at;
	const from = formatClockTime(start);
	const to = formatClockTime(end);
	if (!from) return undefined;
	if (first === last || !to || !start || !end) return from;
	return `${from}–${to} (${formatDuration(new Date(end).valueOf() - new Date(start).valueOf())})`;
}

/** Clock span a column covers, e.g. `11:44–11:53 (9 min)`, or the time of one request. */
export function formatBucketSpan(timeline: ContextTimeline, bucket: TimelineBucket): string | undefined {
	return timeSpan(timeline, bucket.first, bucket.last);
}

/** One-line description of a column: range, time, peak/final size, turns, edits. `~` marks estimates. */
export function describeTimelineBucket(timeline: ContextTimeline, bucket: TimelineBucket): string {
	const first = timeline.points[bucket.first];
	const last = timeline.points[bucket.last];
	if (!first || !last) return "";
	const parts = bucket.first === bucket.last
		? [`request ${first.request}`, `${first.measured ? "" : "~"}${formatTokenCount(bucket.tokens)} tok`]
		: [
			`requests ${first.request}–${last.request} (${bucket.last - bucket.first + 1})`,
			`peak ${formatTokenCount(bucket.tokens)} · last ${last.measured ? "" : "~"}${formatTokenCount(bucket.finalTokens)} tok`,
		];
	const span = timeSpan(timeline, bucket.first, bucket.last);
	if (span) parts.splice(1, 0, span);
	if (bucket.turns > 0) parts.push(`${bucket.turns} user turn${bucket.turns === 1 ? "" : "s"}`);
	if (bucket.edits.length > 0) parts.push(`${bucket.edits.length} accepted edit${bucket.edits.length === 1 ? "" : "s"}`);
	return parts.join(" · ");
}

/**
 * Vertical bar chart, one column per request or bucket. Bars show the bucket's peak;
 * columns followed by an accepted edit use `▓` and get a marker above the bar (`▿`, `▼`
 * when selected, a digit when several edits share the column). User turns are `•` on the
 * baseline; the budget, when near the data, is a dashed row with `┼` on the axis.
 */
export function renderTimelineChart(timeline: ContextTimeline, options: TimelineChartOptions): Line[] {
	if (timeline.points.length === 0) return [[span("No completed requests in this session yet.", "muted")]];
	const height = Math.max(4, options.height);
	const layout = layoutTimeline(timeline, options);
	const { buckets, columnWidth, gap } = layout;
	const blank = (cells: number): Span => span(" ".repeat(cells));
	const cell = (glyph: string, style: { tone: Tone; bold?: boolean }): Span[] =>
		gap > 0 ? [styled(glyph.repeat(columnWidth), style), blank(gap)] : [styled(glyph.repeat(columnWidth), style)];

	// A budget far above the data (a 272k window against 10k requests) would flatten every
	// bar, so it is drawn only within 2× the peak and otherwise named in the x label.
	const budgetOnChart = options.budget !== undefined && options.budget <= Math.max(1, timeline.peakTokens) * 2;
	const ceiling = Math.max(timeline.peakTokens, budgetOnChart ? options.budget ?? 0 : 0, 1);
	const selectedMarker = options.selectedMarker !== undefined ? timeline.markers[options.selectedMarker] : undefined;
	let selectedColumn = selectedMarker?.kind === "applied" ? bucketIndexOf(layout, selectedMarker.afterPoint) : -1;
	if (options.selectedPoint !== undefined) selectedColumn = bucketIndexOf(layout, options.selectedPoint);
	const budgetRow = budgetOnChart && options.budget !== undefined
		? height - 1 - Math.min(height - 1, Math.round((options.budget / ceiling) * (height - 1)))
		: undefined;

	const filledAt = (bucket: TimelineBucket, row: number) =>
		bucket.tokens >= ((height - row) / height) * ceiling - ceiling / height / 2 || (row === height - 1 && bucket.tokens > 0);
	const topRows = buckets.map((bucket) => {
		for (let row = 0; row < height; row++) if (filledAt(bucket, row)) return row;
		return height;
	});
	const markerSelected = (column: number) => column === selectedColumn && selectedMarker !== undefined;
	// A shared column keeps its count when selected; selection shows through the style.
	const markerGlyph = (bucket: TimelineBucket, column: number) =>
		bucket.edits.length > 1
			? (bucket.edits.length > 9 ? "+" : String(bucket.edits.length))
			: markerSelected(column) ? "▼" : "▿";
	const markerCell = (bucket: TimelineBucket, column: number): Span[] => {
		const text = markerGlyph(bucket, column).padStart(Math.ceil((columnWidth + 1) / 2)).padEnd(columnWidth);
		const out = [styled(text, markerSelected(column) ? STYLE.selectedMarker : STYLE.marker)];
		if (gap > 0) out.push(blank(gap));
		return out;
	};
	// The marker sits in the empty cell above its bar; a bar that reaches the top needs a headroom row.
	const markerRowOf = (column: number) => (buckets[column]!.edits.length > 0 ? topRows[column]! - 1 : undefined);

	const rows: Line[] = [];
	if (buckets.some((_bucket, column) => markerRowOf(column) === -1)) {
		const headroom: Span[] = [blank(CHART_LABEL_WIDTH + 1)];
		buckets.forEach((bucket, column) => {
			headroom.push(...(markerRowOf(column) === -1 ? markerCell(bucket, column) : [blank(columnWidth + gap)]));
		});
		rows.push(headroom);
	}

	for (let row = 0; row < height; row++) {
		let label = " ".repeat(CHART_LABEL_WIDTH);
		if (row === 0) label = formatTokenCount(ceiling).padStart(6) + " ";
		else if (row === Math.floor(height / 2)) label = formatTokenCount(ceiling / 2).padStart(6) + " ";
		const line: Span[] = [styled(label, STYLE.axis), budgetRow === row ? styled("┼", STYLE.budget) : styled("┤", STYLE.axis)];
		buckets.forEach((bucket, column) => {
			if (filledAt(bucket, row)) {
				if (column === selectedColumn) line.push(...cell("█", STYLE.selected));
				else if (bucket.edits.length > 0) line.push(...cell("▓", STYLE.editBar));
				else line.push(...cell("█", STYLE.bar));
			} else if (markerRowOf(column) === row) {
				line.push(...markerCell(bucket, column));
			} else if (budgetRow === row) {
				line.push(styled("╌".repeat(columnWidth + gap), STYLE.budget));
			} else {
				line.push(blank(columnWidth + gap));
			}
		});
		rows.push(line);
	}

	// Baseline with user-turn landmarks (none in `turns` zoom, where every column is a turn).
	const baseline: Span[] = [styled("     0 ", STYLE.axis), styled("┴", STYLE.axis)];
	for (const bucket of buckets) {
		if (layout.zoom !== "turns" && bucket.turns > 0) {
			baseline.push(styled("•", STYLE.landmark));
			if (columnWidth - 1 + gap > 0) baseline.push(styled("─".repeat(columnWidth - 1 + gap), STYLE.axis));
		} else {
			baseline.push(styled("─".repeat(columnWidth + gap), STYLE.axis));
		}
	}
	rows.push(baseline);

	rows.push([blank(CHART_LABEL_WIDTH + 1), styled(xLabel(timeline, layout, options, budgetOnChart), STYLE.axis)]);
	return rows.map(normalize);
}

function xLabel(timeline: ContextTimeline, layout: TimelineLayout, options: TimelineChartOptions, budgetOnChart: boolean): string {
	const total = timeline.points.length;
	const firstShown = layout.buckets[0]?.first ?? 0;
	const lastShown = layout.buckets.at(-1)?.last ?? total - 1;
	const offChart = options.budget !== undefined && !budgetOnChart ? ` · budget ${formatTokenCount(options.budget)} (above scale)` : "";
	let label: string;
	switch (layout.zoom) {
		case "requests": {
			const before = firstShown;
			const after = total - 1 - lastShown;
			const range = firstShown === lastShown ? `request ${firstShown + 1}` : `requests ${firstShown + 1}–${lastShown + 1}`;
			label = `${before > 0 ? `◂ ${before} earlier  ` : ""}${range} of ${total}${after > 0 ? `  ${after} later ▸` : ""}`;
			break;
		}
		case "fit":
			label = layout.requestsPerColumn === 1 ? `all ${total} requests` : `all ${total} requests · ${layout.requestsPerColumn}/column`;
			break;
		case "turns": {
			const turns = turnGroupStarts(timeline).length;
			label = `${turns} user turn${turns === 1 ? "" : "s"} · ${layout.turnsPerColumn}/column · ${total} requests`;
			break;
		}
	}
	if (layout.zoom !== "requests") {
		// The time span is extra context: only when the label still fits.
		const span = timeSpan(timeline, 0, total - 1);
		if (span && CHART_LABEL_WIDTH + 1 + `${label} · ${span}${offChart}`.length <= options.width) label += ` · ${span}`;
	}
	return label + offChart;
}

function changePercent(before: number, after: number): string {
	if (before <= 0) return "";
	return `${after <= before ? "−" : "+"}${Math.abs(Math.round(((before - after) / before) * 100))}%`;
}

/** List row for the overview: `r1  11:43   9.5k → 2.9k    −69%`. */
export function formatMarkerCompact(marker: TimelineMarker): string {
	const time = formatClockTime(marker.at) ?? "--:--";
	switch (marker.kind) {
		case "reset":
			return `r${marker.revision}  ${time}  reset to raw context`;
		case "compacted":
			return `r${marker.revision}  ${time}  compacted by OpenCode`;
		case "restored":
			return `r${marker.revision}  ${time}  ${marker.message}`;
		case "rejected":
			return `r${marker.revision}  ${time}  rejected: ${marker.message}`;
		case "applied": {
			const { beforeTokens: before, afterTokens: after } = marker;
			if (before === undefined || after === undefined) return `r${marker.revision}  ${time}  size not recorded`;
			return `r${marker.revision}  ${time}  ${formatTokenCount(before).padStart(5)} → ${formatTokenCount(after).padEnd(5)}  ${changePercent(before, after)}`.trimEnd();
		}
	}
}

/** Long row for the text report: `r3  16:52  edit accepted  9.5k → 2.9k −70%  (after request 4)`. */
export function formatMarkerRow(marker: TimelineMarker, timeline: ContextTimeline): string {
	const time = formatClockTime(marker.at) ?? "--:--";
	const where = marker.afterPoint >= 0
		? `after request ${timeline.points[marker.afterPoint]?.request ?? marker.afterPoint + 1}`
		: "before first request";
	switch (marker.kind) {
		case "applied": {
			const { beforeTokens: before, afterTokens: after } = marker;
			const change = before !== undefined && after !== undefined ? changePercent(before, after) : "";
			const sizes = before !== undefined && after !== undefined
				? `${formatTokenCount(before)} → ${formatTokenCount(after)}${change ? ` ${change}` : ""}`
				: "size not recorded";
			return `r${marker.revision}  ${time}  edit accepted  ${sizes}  (${where})`;
		}
		case "reset":
			return `r${marker.revision}  ${time}  reset to raw context  (${where})`;
		case "compacted":
			return `r${marker.revision}  ${time}  compacted by OpenCode  (${where})`;
		case "restored":
			return `r${marker.revision}  ${time}  ${marker.message}  (${where})`;
		case "rejected":
			return `r${marker.revision}  ${time}  edit rejected: ${marker.message}  (${where})`;
	}
}

/** Plain-text chart plus marker list, for output outside the TUI. */
export function formatTimelineReport(timeline: ContextTimeline, width = 72, budget?: number): string {
	const lines = renderTimelineChart(timeline, { width, height: 8, budget }).map((line) => line.map((part) => part.text).join(""));
	const applied = timeline.markers.filter((marker) => marker.kind === "applied").length;
	lines.push("", applied === 0 ? "No accepted context edits yet." : `${applied} accepted context edit${applied === 1 ? "" : "s"}:`);
	for (const marker of timeline.markers) lines.push(`  ${formatMarkerRow(marker, timeline)}`);
	return lines.join("\n");
}
