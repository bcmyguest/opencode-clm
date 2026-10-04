// Key handling for the `/clm` panel as a pure reducer. The key table follows pi-clm
// src/viewer.ts `handleInput` (MIT, Copyright 2026 Emanuel Casco), plus `r` reload; the
// edits page's scroll-inside-an-expanded-diff rule follows its `scrollWithinExpandedEdit`.

import { PAGES } from "./command.ts";
import type { PanelModel } from "./model.ts";
import { availableTimelineZooms } from "./timeline.ts";
import {
	contentWidth,
	currentRevision,
	editKey,
	editsPage,
	effectiveZoom,
	markerSelection,
	maxScroll,
	pageViewport,
	revisionIndex,
	settingsPage,
	viewportHeight,
	type PanelSize,
	type PanelState,
} from "./view.ts";

export type { PanelState } from "./view.ts";
export { initialPanelState } from "./view.ts";

export type Key =
	| "1" | "2" | "3" | "4"
	| "tab" | "shift+tab"
	| "left" | "right" | "up" | "down"
	| "pageup" | "pagedown"
	| "home" | "end" | "g" | "G"
	| "enter" | "space"
	| "a" | "z" | "r" | "q" | "escape"
	// Aliases: j k for down/up, [ ] for left/right.
	| "j" | "k" | "[" | "]";

export type Effect =
	| { kind: "close" }
	| { kind: "reload" }
	| { kind: "prompt"; setting: string; current: string; placeholder?: string }
	| { kind: "apply"; setting: string; value: string };

export interface ReduceResult {
	state: PanelState;
	effect?: Effect;
}

const ALIASES: Partial<Record<Key, Key>> = { j: "down", k: "up", "[": "left", "]": "right" };

function withPage(state: PanelState, page: PanelState["page"]): PanelState {
	return { ...state, page, scroll: 0 };
}

/** Edits page: keep the selected row (header plus any expanded diff) on screen, header first. */
function revealEdit(state: PanelState, model: PanelModel, size: PanelSize): PanelState {
	const { lines, rowStarts } = editsPage(model, state, contentWidth(size));
	const viewport = viewportHeight(size);
	const start = rowStarts[state.editSel];
	if (start === undefined) return state;
	const end = rowStarts[state.editSel + 1] ?? lines.length;
	let scroll = state.scroll;
	if (start < scroll) scroll = start;
	else if (end > scroll + viewport) scroll = Math.min(start, end - viewport);
	return { ...state, scroll };
}

/**
 * ↓/↑ first scroll through the selected row's expanded diff while it extends past the
 * viewport, then move to the next/previous row. Returns undefined when it did not scroll.
 */
function scrollWithinExpanded(state: PanelState, model: PanelModel, size: PanelSize, delta: number): PanelState | undefined {
	const revision = currentRevision(model, state);
	if (!state.expanded.has(editKey(revision, state.editSel))) return undefined;
	const { lines, rowStarts } = editsPage(model, state, contentWidth(size));
	const start = rowStarts[state.editSel];
	if (start === undefined) return undefined;
	const end = rowStarts[state.editSel + 1] ?? lines.length;
	const viewport = viewportHeight(size);
	if (delta > 0 && end > state.scroll + viewport) {
		return { ...state, scroll: state.scroll + Math.min(delta, end - (state.scroll + viewport)) };
	}
	if (delta < 0 && start < state.scroll) {
		return { ...state, scroll: state.scroll - Math.min(-delta, state.scroll - start) };
	}
	return undefined;
}

function moveSelection(state: PanelState, model: PanelModel, size: PanelSize, delta: number): PanelState {
	switch (state.page) {
		case "overview":
			return moveMarker(state, model, delta);
		case "edits": {
			const scrolled = scrollWithinExpanded(state, model, size, delta);
			if (scrolled) return scrolled;
			const count = currentRevision(model, state)?.edits.length ?? 0;
			if (count === 0) return { ...state, scroll: Math.max(0, state.scroll + delta) };
			return revealEdit({ ...state, editSel: Math.max(0, Math.min(count - 1, state.editSel + delta)) }, model, size);
		}
		case "settings":
			return revealSetting({ ...state, settingSel: clampSetting(model, state.settingSel + delta), message: undefined }, model, size);
		case "input":
			return { ...state, scroll: Math.max(0, state.scroll + delta) };
	}
}

/** ← → (and ↑ ↓ on the overview) step through markers; the stop after the newest is "now". */
function moveMarker(state: PanelState, model: PanelModel, delta: number): PanelState {
	const now = model.timeline.markers.length;
	const next = Math.max(0, Math.min(now, markerSelection(model, state) + delta));
	return { ...state, markerSel: next === now ? undefined : next };
}

function clampSetting(model: PanelModel, index: number): number {
	return Math.max(0, Math.min(model.settings.rows.length - 1, index));
}

function revealSetting(state: PanelState, model: PanelModel, size: PanelSize): PanelState {
	const { focus } = settingsPage(model, state, contentWidth(size));
	const viewport = pageViewport(state, size);
	let scroll = state.scroll;
	if (focus < scroll) scroll = focus;
	else if (focus >= scroll + viewport) scroll = focus - viewport + 1;
	return { ...state, scroll };
}

/** Enter on the overview: a marker with a revision opens edits there; "now" opens input. */
function openMarker(state: PanelState, model: PanelModel): PanelState {
	const selection = markerSelection(model, state);
	if (selection === model.timeline.markers.length) return withPage(state, "input");
	const marker = model.timeline.markers[selection];
	if (!marker || marker.kind !== "applied") return state;
	const index = model.revisions.findIndex((revision) => revision.revision === marker.revision);
	if (index < 0) return state;
	return { ...withPage(state, "edits"), revisionIndex: index, editSel: 0 };
}

function toggleEdit(state: PanelState, model: PanelModel, size: PanelSize): PanelState {
	const revision = currentRevision(model, state);
	if (!revision?.edits[state.editSel]) return state;
	const key = editKey(revision, state.editSel);
	const expanded = new Set(state.expanded);
	if (expanded.delete(key)) return { ...state, expanded };
	expanded.add(key);
	return revealEdit({ ...state, expanded }, model, size);
}

function toggleAllEdits(state: PanelState, model: PanelModel): PanelState {
	const revision = currentRevision(model, state);
	if (!revision) return state;
	const keys = revision.edits.map((_edit, index) => editKey(revision, index));
	const collapse = keys.length > 0 && keys.every((key) => state.expanded.has(key));
	const expanded = new Set(state.expanded);
	for (const key of keys) {
		if (collapse) expanded.delete(key);
		else expanded.add(key);
	}
	return { ...state, expanded };
}

/** Enter/Space on a setting: next choice, or a text prompt. */
function changeSetting(state: PanelState, model: PanelModel): ReduceResult {
	const row = model.settings.rows[clampSetting(model, state.settingSel)];
	if (!row) return { state };
	const cleared = { ...state, message: undefined };
	if (row.choices && row.choices.length > 0) {
		const index = row.choices.indexOf(row.value);
		return { state: cleared, effect: { kind: "apply", setting: row.key, value: row.choices[(index + 1) % row.choices.length]! } };
	}
	return {
		state: cleared,
		effect: { kind: "prompt", setting: row.key, current: row.value, ...(row.placeholder ? { placeholder: row.placeholder } : {}) },
	};
}

function jump(state: PanelState, model: PanelModel, toEnd: boolean): PanelState {
	switch (state.page) {
		case "overview":
			return { ...state, markerSel: toEnd ? undefined : model.timeline.markers.length === 0 ? undefined : 0 };
		case "edits":
			return {
				...state,
				editSel: toEnd ? Math.max(0, (currentRevision(model, state)?.edits.length ?? 1) - 1) : 0,
				scroll: toEnd ? Number.MAX_SAFE_INTEGER : 0,
			};
		case "settings":
			return { ...state, settingSel: toEnd ? Math.max(0, model.settings.rows.length - 1) : 0, scroll: toEnd ? Number.MAX_SAFE_INTEGER : 0 };
		case "input":
			return { ...state, scroll: toEnd ? Number.MAX_SAFE_INTEGER : 0 };
	}
}

function step(state: PanelState, key: Key, model: PanelModel, size: PanelSize): ReduceResult {
	const page = state.page;
	if (page === "settings" && (key === "up" || key === "down")) return { state: moveSelection(state, model, size, key === "up" ? -1 : 1) };
	if (page === "settings" && (key === "enter" || key === "space")) return changeSetting(state, model);
	if (key === "q" || key === "escape") return { state, effect: { kind: "close" } };
	if (key === "r") return { state, effect: { kind: "reload" } };
	if (page === "overview" && key === "enter") return { state: openMarker(state, model) };
	if (page === "overview" && (key === "left" || key === "right")) return { state: moveMarker(state, model, key === "left" ? -1 : 1) };
	if (page === "overview" && key === "z") {
		const width = contentWidth(size);
		const zooms = availableTimelineZooms(model.timeline, width);
		const next = zooms[(zooms.indexOf(effectiveZoom(model, state, width)) + 1) % zooms.length]!;
		return { state: { ...state, zoom: next } };
	}
	if (page === "edits" && (key === "left" || key === "right")) {
		if (model.revisions.length === 0) return { state };
		const index = Math.max(0, Math.min(model.revisions.length - 1, revisionIndex(model, state) + (key === "left" ? -1 : 1)));
		return { state: { ...state, revisionIndex: index, editSel: 0, scroll: 0 } };
	}
	const pageIndex = PAGES.indexOf(page);
	if (key === "tab") return { state: withPage(state, PAGES[(pageIndex + 1) % PAGES.length]!) };
	if (key === "shift+tab") return { state: withPage(state, PAGES[(pageIndex - 1 + PAGES.length) % PAGES.length]!) };
	if (key === "enter" || key === "space") return { state: page === "edits" ? toggleEdit(state, model, size) : state };
	if (page === "edits" && key === "a") return { state: toggleAllEdits(state, model) };
	if (key === "up" || key === "down") return { state: moveSelection(state, model, size, key === "up" ? -1 : 1) };
	if (key === "pageup" || key === "pagedown") {
		const viewport = viewportHeight(size);
		const sign = key === "pageup" ? -1 : 1;
		if (page === "edits") return { state: moveSelection(state, model, size, sign * Math.max(1, viewport - 2)) };
		return { state: { ...state, scroll: Math.max(0, state.scroll + sign * viewport) } };
	}
	if (key === "home" || key === "g") return { state: jump(state, model, false) };
	if (key === "end" || key === "G") return { state: jump(state, model, true) };
	if (/^[1-4]$/.test(key)) return { state: withPage(state, PAGES[Number(key) - 1]!) };
	return { state };
}

/**
 * The settings page with a result message pinned below it. The message takes body rows, so
 * the selected row is scrolled back into view if the message would cover it.
 */
export function withMessage(state: PanelState, message: PanelState["message"], model: PanelModel, size: PanelSize): PanelState {
	const next = { ...state, message };
	return next.page === "settings" ? revealSetting(next, model, size) : next;
}

/** Applies one key. The result's scroll is clamped to the page. */
export function reduce(state: PanelState, key: Key, model: PanelModel, size: PanelSize): ReduceResult {
	const result = step(state, ALIASES[key] ?? key, model, size);
	const limit = maxScroll(model, result.state, size);
	if (result.state.scroll > limit) result.state = { ...result.state, scroll: limit };
	return result;
}
