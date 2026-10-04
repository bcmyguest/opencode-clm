// The `/clm` panel as styled lines: frame, tab row, one of four pages, help row. Pure.
// Adapted from pi-clm src/viewer.ts (MIT, Copyright 2026 Emanuel Casco): the page layouts,
// texts and help rows follow its CLM layout; state lives in keys.ts instead of a component.

import type { Page } from "./command.ts";
import { PAGES } from "./command.ts";
import { editDiffRows, renderDiff, type SideBySideRow } from "./diff.ts";
import { fit, normalize, span, truncate, wrap, type Line, type Span, type Tone } from "./lines.ts";
import type { BudgetView, EditRevision, EditView, PanelModel } from "./model.ts";
import {
	availableTimelineZooms,
	bucketIndexOf,
	formatBucketSpan,
	formatClockTime,
	formatMarkerCompact,
	formatTokenCount,
	layoutTimeline,
	renderTimelineChart,
	type TimelineMarker,
	type TimelineZoom,
} from "./timeline.ts";

export interface PanelState {
	page: Page;
	/** First visible body line. */
	scroll: number;
	zoom: TimelineZoom;
	/** Selected overview marker; undefined = "now". */
	markerSel?: number;
	/** Index into `model.revisions`; undefined = newest. */
	revisionIndex?: number;
	editSel: number;
	/** Expanded edit rows, keyed `revision:row`. */
	expanded: ReadonlySet<string>;
	settingSel: number;
	message?: { text: string; warning: boolean };
}

export interface PanelSize {
	width: number;
	height: number;
}

export function initialPanelState(page: Page = "overview"): PanelState {
	return { page, scroll: 0, zoom: "fit", editSel: 0, expanded: new Set(), settingSel: 0 };
}

/** Frame rows around the body: top border, tabs, separator, separator, help, bottom border. */
const FRAME_ROWS = 6;
const ZOOM_LABELS: Record<TimelineZoom, string> = { fit: "all", requests: "detail", turns: "turns" };
const EDIT_TONE: Tone = "edit";
const KEPT_PREVIEW_CHARACTERS = 2_000;
const MIRROR_TEXT_MAX_LINES = 200;
const MIRROR_UNAVAILABLE_TEXT = "No mirror: requests carry the raw history plus the continuity annotations; edits are off.";
const NOTICES_ONLY_TEXT = "Mode notices-only: requests carry the raw history plus the budget notices; no mirror, so the model cannot edit its context (/clm config mode edit).";

/** Body rows available for the page. */
export function viewportHeight(size: PanelSize): number {
	return Math.max(1, size.height - FRAME_ROWS);
}

/** Columns available for page text (inside the border and one space of padding each side). */
export function contentWidth(size: PanelSize): number {
	return Math.max(1, size.width - 4);
}

const fmt = formatTokenCount;

function wrapAll(lines: readonly Line[], width: number): Line[] {
	return lines.flatMap((line) => (line.length === 0 ? [[]] : wrap(line, width)));
}

function text(value: string, tone?: Tone, bold?: boolean): Line {
	return [span(value, tone, bold)];
}

function formatTime(value: string | undefined): string {
	if (!value) return "unknown";
	const date = new Date(value);
	return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

// ---- overview ------------------------------------------------------------------------

/** The chosen zoom, or the first offered one when it is not offered at this width. */
export function effectiveZoom(model: PanelModel, state: PanelState, width: number): TimelineZoom {
	const zooms = availableTimelineZooms(model.timeline, width);
	return zooms.includes(state.zoom) ? state.zoom : zooms[0]!;
}

/** Index of the selected marker, or markers.length for "now". */
export function markerSelection(model: PanelModel, state: PanelState): number {
	const now = model.timeline.markers.length;
	return state.markerSel === undefined ? now : Math.max(0, Math.min(now, state.markerSel));
}

/** One line on fixed overhead and the usable share of the budget, when known. */
export function budgetLine(info: BudgetView | undefined): Line | undefined {
	if (!info || (info.overhead === undefined && !info.tooSmall)) return undefined;
	const parts: string[] = [];
	if (info.overhead !== undefined) {
		parts.push(`fixed overhead ~${fmt(info.overhead)}${info.overheadSource === "estimate" ? " (estimated)" : ""}`);
	}
	if (info.usable !== undefined && info.configured !== undefined) parts.push(`usable ${fmt(info.usable)} of ${fmt(info.configured)}`);
	if (info.reserve !== undefined) parts.push(`reserve ${fmt(info.reserve)}`);
	if (info.raised && info.budget !== undefined && info.effectiveUsable !== undefined) {
		parts.push(`raised to ${fmt(info.budget)}${info.capped ? " (window cap)" : ""}, usable ${fmt(info.effectiveUsable)}`);
	}
	const label = info.tooSmall ? (info.raised ? "Budget was too small: " : "Budget too small: ") : "Budget: ";
	return text(`${label}${parts.join(" · ")}`, info.tooSmall ? "warning" : "muted");
}

/**
 * Picks the groups (a list row plus any details) to show within `budget` lines: the
 * selected group always, then neighbours after and before it, with a `⋯ N earlier/later`
 * line for what is cut at either end.
 */
export function windowAroundSelection(
	groups: readonly (readonly Line[])[],
	selected: number,
	budget: number,
	more: (count: number, where: "earlier" | "later") => Line,
): Line[] {
	const total = groups.reduce((sum, group) => sum + group.length, 0);
	if (total <= budget || groups.length === 0) return groups.flat();
	const pick = Math.max(0, Math.min(groups.length - 1, selected));
	let start = pick;
	let end = pick + 1;
	let used = groups[pick]!.length;
	const markers = (from: number, to: number) => (from > 0 ? 1 : 0) + (to < groups.length ? 1 : 0);
	for (let grew = true; grew;) {
		grew = false;
		if (end < groups.length && used + groups[end]!.length + markers(start, end + 1) <= budget) {
			used += groups[end]!.length;
			end++;
			grew = true;
		}
		if (start > 0 && used + groups[start - 1]!.length + markers(start - 1, end) <= budget) {
			used += groups[start - 1]!.length;
			start--;
			grew = true;
		}
	}
	return [
		...(start > 0 ? [more(start, "earlier")] : []),
		...groups.slice(start, end).flat(),
		...(end < groups.length ? [more(groups.length - end, "later")] : []),
	];
}

function markerDetails(
	model: PanelModel,
	zoom: TimelineZoom,
	width: number,
	marker: TimelineMarker | undefined,
	focusPoint: number | undefined,
): string[] {
	const timeline = model.timeline;
	const layout = timeline.points.length > 0 ? layoutTimeline(timeline, { width, zoom, focusPoint }) : undefined;
	const bucket = layout?.buckets[bucketIndexOf(layout, focusPoint)];
	const bucketed = zoom !== "requests" && bucket !== undefined && bucket.first !== bucket.last;
	const shared = bucketed && bucket.edits.length > 1 ? `${bucket.edits.length} edits in this column` : undefined;
	const period = bucketed ? formatBucketSpan(timeline, bucket) : undefined;
	const columnSpan = [period, shared].filter(Boolean).join(" · ") || undefined;
	const lines: string[] = [];
	if (marker) {
		const parts = [
			marker.afterPoint >= 0
				? `after request ${timeline.points[marker.afterPoint]?.request ?? marker.afterPoint + 1}`
				: "before the first request",
		];
		const revision = marker.kind === "applied" ? model.revisions.find((item) => item.revision === marker.revision) : undefined;
		if (revision) {
			const counts = new Map<string, number>();
			for (const edit of revision.edits) counts.set(edit.kind, (counts.get(edit.kind) ?? 0) + 1);
			parts.push(...["edited", "normalized", "removed", "restored", "added", "kept"]
				.filter((kind) => counts.has(kind))
				.map((kind) => `${counts.get(kind)} ${kind}`));
		}
		if (marker.kind === "reset" || marker.kind === "compacted") parts.push(marker.message);
		lines.push(parts.join(" · "));
		if (columnSpan) lines.push(columnSpan);
		if (revision) lines.push("Enter: before/after in edits");
	} else {
		if (columnSpan) lines.push(columnSpan);
		lines.push("Enter: current input");
	}
	return lines;
}

function overviewLines(model: PanelModel, state: PanelState, width: number, viewport: number): Line[] {
	if (!model.found) return notFoundLines(model, width);
	const timeline = model.timeline;
	const notice = !model.enabled
		? text("Projection off: the model sees the raw history (/clm on).", "warning")
		: model.mirrorUnavailable !== undefined
		? text(MIRROR_UNAVAILABLE_TEXT, "warning")
		: model.noticesOnly
		? text(NOTICES_ONLY_TEXT, "warning")
		: model.lastOutcome?.kind === "rejected"
			? text(`Last edit rejected: ${model.lastOutcome.message}`, "warning")
			: undefined;
	const above = notice ? wrapAll([notice, []], width) : [];
	const zoom = effectiveZoom(model, state, width);
	const chartHeight = Math.max(4, Math.min(6, viewport - 8));
	const selection = markerSelection(model, state);
	const atNow = selection === timeline.markers.length;
	const newest = timeline.points.length - 1;
	const focusPoint = atNow ? Math.max(0, newest) : timeline.markers[selection]?.afterPoint;
	const chart = renderTimelineChart(timeline, {
		width,
		height: chartHeight,
		zoom,
		focusPoint,
		budget: model.budget,
		selectedMarker: atNow ? undefined : selection,
		selectedPoint: atNow && newest >= 0 ? newest : undefined,
	});
	const latest = timeline.points.at(-1);
	const summary = [
		`${timeline.points.length} requests`,
		latest ? `now ${latest.measured ? "" : "~"}${fmt(latest.tokens)}` : undefined,
		latest ? `peak ${fmt(timeline.peakTokens)}` : undefined,
		model.budget !== undefined ? `budget ${fmt(model.budget)}` : undefined,
	].filter(Boolean).join(" · ");
	const budget = budgetLine(model.budgetInfo);
	const head = wrapAll([
		[span("Context size", "accent", true), span(` · ${summary}`, "muted")],
		...(budget ? [budget] : []),
		...chart,
		[],
	], width);
	const details = (marker: TimelineMarker | undefined) =>
		markerDetails(model, zoom, width, marker, focusPoint)
			.flatMap((line) => wrap([span(line, "dim")], Math.max(10, width - 6)))
			.map((line) => [span("      "), ...line]);
	const groups: Line[][] = timeline.markers.map((marker, index) => {
		const selected = index === selection;
		const tone: Tone = marker.kind === "applied" ? EDIT_TONE : marker.kind === "rejected" ? "warning" : "muted";
		const row = `${selected ? "› ▾" : "  ▸"} ${formatMarkerCompact(marker)}`;
		return [...wrap([span(row, tone, selected)], width), ...(selected ? details(marker) : [])];
	});
	const nowTime = formatClockTime(latest?.at) ?? "--:--";
	const nowSize = latest ? `${latest.measured ? "" : "~"}${fmt(latest.tokens)}`.padStart(5) : "no completed requests yet";
	const nowRow = `${atNow ? "› ▾" : "  ▸"} now ${nowTime}  ${nowSize}`;
	groups.push([...wrap([span(nowRow, atNow ? "text" : "muted", atNow)], width), ...(atNow ? details(undefined) : [])]);
	const listBudget = viewport - above.length - head.length;
	const more = (count: number, where: "earlier" | "later") => text(`    ⋯ ${count} ${where}`, "dim");
	return [...above, ...head, ...windowAroundSelection(groups, selection, listBudget, more)];
}

function notFoundLines(model: PanelModel, width: number): Line[] {
	return wrapAll([
		text("No CLM data for this session.", "warning"),
		[],
		text(`Looked in ${model.directory}`, "muted"),
		text("The server plugin writes it on the first model request of a session with CLM enabled.", "dim"),
		...model.warnings.map((warning) => text(warning, "warning")),
	], width);
}

// ---- input ---------------------------------------------------------------------------

function savingsBar(raw: number, effective: number, width: number): Line {
	const barWidth = Math.max(10, Math.min(48, width - 18));
	const fraction = raw > 0 ? effective / raw : 1;
	const used = Math.max(0, Math.min(barWidth, Math.round(barWidth * fraction)));
	const removed = raw > 0 ? Math.max(0, ((raw - effective) / raw) * 100) : 0;
	return [span("█".repeat(used), "accent"), span("░".repeat(barWidth - used), "dim"), span(` ${removed.toFixed(1)}% removed`)];
}

function inputLines(model: PanelModel, width: number): Line[] {
	if (!model.found) return notFoundLines(model, width);
	const input = model.input;
	const title: Line = [span("Current input", "accent", true), span(" · what the next model request will contain", "muted")];
	if (!input) {
		return wrapAll([
			title,
			[],
			model.mirrorUnavailable !== undefined
				? text(`${MIRROR_UNAVAILABLE_TEXT} No input snapshot is kept.`, "warning")
				: text("No input snapshot yet: snapshot.json appears after the next model request.", "muted"),
			[],
			text(`Mirror: ${model.mirrorPath}`, "dim"),
		], width);
	}
	const messages: Line[] = input.messages.length === 0
		? [text("No model-visible messages in the snapshot.", "muted")]
		: input.messages.map((message) => [
			span(`#${message.index}`, "dim"),
			span(" "),
			span(message.role, "accent"),
			span(` ${fmt(message.tokens)} tok`, "muted"),
			span(` · ${message.preview}`),
		]);
	return wrapAll([
		title,
		[],
		savingsBar(input.rawTokens, input.effectiveTokens, width),
		text(`Tokens       ${fmt(input.rawTokens)} raw → ${fmt(input.effectiveTokens)} effective`),
		text(`Messages     ${input.rawMessages} raw → ${input.sentMessages} effective · ${input.suffix} after the last edit`),
		text(`Captured     ${formatTime(input.capturedAt)}`),
		...(input.stale ? [text("Newer requests ran after this snapshot; the next model call includes their messages.", "warning")] : []),
		[],
		...messages,
		[],
		text(`Mirror: ${input.mirrorPath}`, "dim"),
	], width);
}

// ---- edits ---------------------------------------------------------------------------

export function revisionIndex(model: PanelModel, state: PanelState): number {
	const last = model.revisions.length - 1;
	return state.revisionIndex === undefined ? Math.max(0, last) : Math.max(0, Math.min(last, state.revisionIndex));
}

export function currentRevision(model: PanelModel, state: PanelState): EditRevision | undefined {
	return model.revisions[revisionIndex(model, state)];
}

export function editKey(revision: EditRevision | undefined, row: number): string {
	return `${revision?.revision ?? 0}:${row}`;
}

const diffCache = new WeakMap<EditView, SideBySideRow[]>();

function diffRowsOf(edit: EditView): SideBySideRow[] {
	let rows = diffCache.get(edit);
	if (!rows) {
		rows = editDiffRows(edit.kind, edit.beforeText ?? "", edit.afterText ?? "");
		diffCache.set(edit, rows);
	}
	return rows;
}

function editGlyph(edit: EditView): { glyph: string; tone: Tone } {
	switch (edit.kind) {
		case "kept":
			return { glyph: "=", tone: "muted" };
		case "removed":
			return { glyph: "−", tone: "error" };
		case "added":
			return { glyph: "+", tone: "success" };
		case "restored":
			return { glyph: "↺", tone: "warning" };
		default:
			return { glyph: "~", tone: "accent" };
	}
}

function editRowHeader(edit: EditView, selected: boolean, expanded: boolean, width: number): Line[] {
	const source = edit.sourceIndex === undefined ? "" : `#${edit.sourceIndex}`;
	const destination = edit.outputIndex === undefined ? "" : `→#${edit.outputIndex}`;
	const role = edit.beforeRole ?? edit.afterRole ?? "message";
	const size = edit.beforeTokens === undefined
		? `${fmt(edit.afterTokens ?? 0)} tok`
		: edit.afterTokens === undefined
			? `${fmt(edit.beforeTokens)} tok`
			: `${fmt(edit.beforeTokens)}→${fmt(edit.afterTokens)} tok`;
	const { glyph, tone } = editGlyph(edit);
	const where = [source, destination].filter(Boolean).join(" ");
	return wrap([
		span(selected ? "›" : " ", "accent"),
		span(` ${expanded ? "▾" : "▸"} `),
		span(`${glyph} ${where ? `${where} ` : ""}${role} · ${edit.kind} · ${size}`, tone),
	], width);
}

function editBodyLines(edit: EditView, width: number): Line[] {
	const indent = "    ";
	if (edit.kind === "kept" || edit.kind === "restored") {
		const body = edit.beforeText ?? edit.afterText;
		if (body === undefined) return [];
		const clipped = body.length <= KEPT_PREVIEW_CHARACTERS ? body : `${body.slice(0, KEPT_PREVIEW_CHARACTERS - 1)}…`;
		const label = `${edit.kind === "kept" ? "content" : "restored original"} · ${fmt(edit.beforeTokens ?? edit.afterTokens ?? 0)} tok`;
		return wrapAll([
			[span(indent), span(label, edit.kind === "kept" ? "muted" : "warning")],
			...clipped.split(/\r?\n/).map((line): Line => [span(`${indent}  `), span(line || " ", "dim")]),
		], width);
	}
	const rows = diffRowsOf(edit);
	if (rows.length === 0) {
		const note = edit.beforeRole !== edit.afterRole && edit.beforeRole && edit.afterRole
			? `no text change · role ${edit.beforeRole} → ${edit.afterRole}`
			: "no text change (full text compared; message structure only)";
		return [[span(indent), span(note, "muted")]];
	}
	const describe = (label: string, index: number | undefined, role: string | undefined, tokens: number | undefined) =>
		index === undefined && tokens === undefined
			? `${label} · —`
			: `${label}${index === undefined ? "" : ` · #${index}`}${role ? ` ${role}` : ""} · ${fmt(tokens ?? 0)} tok`;
	const rendered = renderDiff(rows, Math.max(1, width - indent.length), {
		leftTitle: describe("before", edit.sourceIndex, edit.beforeRole, edit.beforeTokens),
		rightTitle: describe("after", edit.outputIndex, edit.afterRole, edit.afterTokens),
		leftPlaceholder: "(new block)",
		rightPlaceholder: "(removed from the next request)",
	});
	return rendered.map((line) => [span(indent), ...line]);
}

/** The edits page plus where each message row starts, so keys can keep the selection on screen. */
export function editsPage(model: PanelModel, state: PanelState, width: number): { lines: Line[]; rowStarts: number[] } {
	if (model.revisions.length === 0) {
		return {
			lines: wrapAll([
				text("No accepted live-context compression is available in this session.", "muted"),
				text("Open the panel after an accepted mirror edit.", "dim"),
			], width),
			rowStarts: [],
		};
	}
	const index = revisionIndex(model, state);
	const revision = model.revisions[index]!;
	const tabs: Span[] = [];
	model.revisions.forEach((item, position) => {
		if (position > 0) tabs.push(span(" "));
		tabs.push(position === index ? span(`[r${item.revision}]`, "accent", true) : span(` r${item.revision} `, "muted"));
	});
	const source = revision.traceSource === "recorded" ? "exact recorded provenance" : "provenance unavailable (no revisions/rN.json)";
	const size = `${revision.beforeTokens === undefined ? "?" : fmt(revision.beforeTokens)}→${fmt(revision.afterTokens ?? 0)} tokens`;
	const lines = wrapAll([
		text("Live-context compression runs", "accent", true),
		[span("Runs  ← "), ...tabs, span(` →   ${index + 1}/${model.revisions.length}`)],
		text(`r${revision.revision} from r${revision.sourceRevision} · ${size} · ${source}`, "muted"),
		text("= kept · ~ rewritten · − removed · + added · ↺ restored · Enter: side-by-side diff · a: all", "dim"),
		[],
	], width);
	const rowStarts: number[] = [];
	if (revision.edits.length === 0) {
		lines.push(...wrapAll([text("This revision is saved, but its per-message provenance is unavailable.", "warning")], width));
		if (revision.mirrorText !== undefined) {
			const all = revision.mirrorText.split(/\r?\n/);
			lines.push([], ...wrapAll([text(`Accepted mirror text (revisions/r${revision.revision}.md):`, "muted")], width));
			lines.push(...wrapAll(all.slice(0, MIRROR_TEXT_MAX_LINES).map((line) => text(`  ${line}`, "dim")), width));
			if (all.length > MIRROR_TEXT_MAX_LINES) lines.push(text(`  ⋯ ${all.length - MIRROR_TEXT_MAX_LINES} more lines`, "dim"));
		}
		return { lines, rowStarts };
	}
	revision.edits.forEach((edit, row) => {
		rowStarts.push(lines.length);
		const expanded = state.expanded.has(editKey(revision, row));
		lines.push(...editRowHeader(edit, row === state.editSel, expanded, width));
		if (expanded) lines.push(...editBodyLines(edit, width));
	});
	return { lines, rowStarts };
}

// ---- settings ------------------------------------------------------------------------

/** The settings page plus the line of the selected row. */
export function settingsPage(model: PanelModel, state: PanelState, width: number): { lines: Line[]; focus: number } {
	const settings = model.settings;
	const header = wrapAll([
		[span("Settings", "accent", true), span(" · changes apply from the next request and are saved in this session", "muted")],
		...settings.summary.map((line) => text(line, "dim")),
		...(settings.warning ? [text(`⚠ ${settings.warning}`, "warning")] : []),
		// The server's own record, also when the TUI's settings check passed.
		...(model.steeringError && !settings.warning?.includes(model.steeringError)
			? [text(`⚠ steering document not loaded, the session runs without it: ${model.steeringError}`, "warning")]
			: []),
		[],
	], width);
	if (settings.rows.length === 0) {
		return { lines: [...header, ...wrapAll([text("Settings are not available here.", "muted")], width)], focus: header.length };
	}
	const selected = Math.max(0, Math.min(settings.rows.length - 1, state.settingSel));
	const labelWidth = Math.min(Math.max(...settings.rows.map((row) => row.label.length + (row.changed ? 2 : 0))) + 2, Math.floor(width / 2));
	const lines = [...header];
	let focus = header.length;
	settings.rows.forEach((row, index) => {
		const isSelected = index === selected;
		if (isSelected) focus = lines.length;
		const label = `${row.label}${row.changed ? " •" : ""}`;
		lines.push(normalize([
			span(isSelected ? "› " : "  ", "accent"),
			...fit([span(label, isSelected ? "accent" : undefined)], labelWidth),
			...truncate([span(row.value, isSelected ? "accent" : "muted", isSelected)], Math.max(1, width - labelWidth - 2)),
		]));
	});
	const row = settings.rows[selected]!;
	if (row.description) lines.push([], ...wrapAll([text(row.description, "dim")], width));
	lines.push([], ...wrapAll([text(row.choices?.length ? "Enter: next value" : "Enter: type a value", "dim")], width));
	return { lines, focus };
}

/**
 * Lines pinned below the scrolling page: the settings page's result message ("✓ Budget:
 * 20k"), so it stays on screen when the page is longer than the viewport. At most
 * `viewport` − 1 lines, so one page line always shows.
 */
export function pinnedLines(state: PanelState, width: number, viewport: number): Line[] {
	if (state.page !== "settings" || !state.message) return [];
	const message = wrapAll([text(`${state.message.warning ? "⚠" : "✓"} ${state.message.text}`, state.message.warning ? "warning" : "success")], width);
	return message.slice(0, Math.max(0, viewport - 1));
}

/** Body rows left for the scrolling page once the pinned lines take theirs. */
export function pageViewport(state: PanelState, size: PanelSize): number {
	const viewport = viewportHeight(size);
	return Math.max(1, viewport - pinnedLines(state, contentWidth(size), viewport).length);
}

// ---- frame ---------------------------------------------------------------------------

/** The whole page at `width` (unclipped; the frame scrolls it). */
export function pageLines(model: PanelModel, state: PanelState, width: number, viewport: number): Line[] {
	switch (state.page) {
		case "overview":
			return overviewLines(model, state, width, viewport);
		case "input":
			return inputLines(model, width);
		case "edits":
			return model.found ? editsPage(model, state, width).lines : notFoundLines(model, width);
		case "settings":
			return settingsPage(model, state, width).lines;
	}
}

export function helpText(model: PanelModel, state: PanelState, width: number): string {
	switch (state.page) {
		case "overview":
			return `← → select · z zoom: ${ZOOM_LABELS[effectiveZoom(model, state, width)]} · Enter open · r reload · Tab pages · q close`;
		case "settings":
			return "↑ ↓ select · Enter change · Tab pages · q close";
		case "edits":
			return "1–4 or Tab: pages · ← →: revisions · ↑ ↓: select · Enter: diff · a: diff all · q: close";
		case "input":
			return "1–4 or Tab: pages · ↑ ↓ or j k: scroll · g G: ends · r reload · q: close";
	}
}

export function maxScroll(model: PanelModel, state: PanelState, size: PanelSize): number {
	return Math.max(0, pageLines(model, state, contentWidth(size), viewportHeight(size)).length - pageViewport(state, size));
}

/** The framed panel, exactly `size.height` lines of `size.width` cells. */
export function renderPanel(model: PanelModel, state: PanelState, size: PanelSize): Line[] {
	const width = Math.max(8, size.width);
	const inner = width - 2;
	const content = contentWidth({ width, height: size.height });
	const body = viewportHeight(size);
	const page = pageLines(model, state, content, body);
	const pinned = pinnedLines(state, content, body);
	const viewport = pageViewport(state, size);
	const scroll = Math.max(0, Math.min(state.scroll, page.length - viewport));
	// The pinned lines follow the page directly when it fits, else sit at the bottom.
	const visible = [...page.slice(scroll, scroll + viewport), ...pinned];
	while (visible.length < body) visible.push([]);

	const border = (value: string) => span(value, "border");
	const row = (line: Line): Line => normalize([border("│"), span(" "), ...fit(line, inner - 1), border("│")]);
	const title = ` Live Context Viewer · r${model.revision}${model.noticesOnly && model.enabled ? " · notices-only" : ""} `;
	const titleText = truncate([span(title)], inner, "").map((part) => part.text).join("");
	const left = Math.max(0, Math.floor((inner - titleText.length) / 2));
	const right = Math.max(0, inner - titleText.length - left);
	const tabs: Span[] = [];
	PAGES.forEach((page, index) => {
		if (index > 0) tabs.push(span(" "));
		const label = `${index + 1}:${page}`;
		tabs.push(page === state.page ? span(`[${label}]`, "accent", true) : span(` ${label} `, "muted"));
	});
	// The position goes first so a narrow help row cannot cut it off.
	const position = page.length > viewport ? `lines ${scroll + 1}-${Math.min(page.length, scroll + viewport)}/${page.length} · ` : "";
	return [
		normalize([border(`╭${"─".repeat(left)}`), span(titleText, "accent", true), border(`${"─".repeat(right)}╮`)]),
		row(tabs),
		[border(`├${"─".repeat(inner)}┤`)],
		...visible.map((line) => row(line)),
		[border(`├${"─".repeat(inner)}┤`)],
		row([span(`${position}${helpText(model, state, content)}`, "dim")]),
		[border(`╰${"─".repeat(inner)}╯`)],
	];
}
