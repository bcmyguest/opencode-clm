// The `/clm` panel model: everything the four pages show, built from one session
// directory's files (session-files.ts) without touching the host. Pure. The revision view
// shape follows pi-clm's LiveContextEditRevisionView (src/viewer.ts, MIT, Copyright 2026
// Emanuel Casco); the rest is written for this package.

import { budgetFit } from "../budget.ts";
import type { LiveContextOutcome, OutcomeKind } from "../state.ts";
import type { ClmEvent, SessionFiles } from "./files.ts";
import type { ContextTimeline, MarkerKind, TimelineMarker, TimelinePoint } from "./timeline.ts";

export type EditKind = "kept" | "edited" | "removed" | "restored" | "normalized" | "added";

/** One message row of the edits page. Indices are one-based for display. */
export interface EditView {
	kind: EditKind;
	sourceIndex?: number;
	outputIndex?: number;
	beforeRole?: string;
	afterRole?: string;
	beforeTokens?: number;
	afterTokens?: number;
	beforePreview?: string;
	afterPreview?: string;
	/** Full text for the diff (the diff bounds what it shows). */
	beforeText?: string;
	afterText?: string;
}

export interface EditRevision {
	revision: number;
	sourceRevision: number;
	createdAt?: string;
	beforeTokens?: number;
	afterTokens?: number;
	edits: EditView[];
	/** `recorded`: from revisions/rN.json; `unavailable`: only rN.md or the accepted event exist. */
	traceSource: "recorded" | "unavailable";
	/** The accepted mirror text (revisions/rN.md), when no per-message rows exist. */
	mirrorText?: string;
}

export interface InputMessageView {
	index: number;
	role: string;
	tokens: number;
	preview: string;
}

export interface InputView {
	capturedAt: string;
	rawMessages: number;
	sentMessages: number;
	suffix: number;
	rawTokens: number;
	effectiveTokens: number;
	messages: InputMessageView[];
	mirrorPath: string;
	/** Requests ran after the snapshot was written (it is one request behind). */
	stale: boolean;
}

/** One row of the settings page. Filled by the settings table (a later block). */
export interface SettingRow {
	key: string;
	label: string;
	value: string;
	description?: string;
	changed?: boolean;
	/** Enter cycles through these; without choices Enter opens a text prompt. */
	choices?: string[];
	/** Example value shown in the text prompt. */
	placeholder?: string;
}

export interface PanelSettings {
	rows: SettingRow[];
	summary: string[];
	changed: string[];
	warning?: string;
}

/**
 * Budget arithmetic for the panel, computed with `budgetFit` (src/budget.ts) so the
 * figures equal the server's `/clm status`: `usable` = configured − reserve − overhead,
 * `effectiveUsable` = budget in force − reserve − overhead.
 */
export interface BudgetView {
	/** Budget in force: `configured`, or raised when it was too small for the overhead. */
	budget?: number;
	/** Budget before any raise. */
	configured?: number;
	reserve?: number;
	/** Overflow-guard limit (budget − reserve), from snapshot.json. */
	limit?: number;
	/** Where the budget came from (`config`, `model-window`). */
	source?: string;
	/** Fixed overhead per request (system prompt + tool schemas), tokens. */
	overhead?: number;
	overheadSource?: "provider" | "estimate";
	usable?: number;
	effectiveUsable?: number;
	raised?: boolean;
	/** The model window stopped the raise short of the minimum. */
	capped?: boolean;
	/** configured − reserve leaves less than the working margin after the overhead. */
	tooSmall: boolean;
}

export interface PanelModel {
	sessionID: string;
	directory: string;
	/** False → "no CLM data for this session". */
	found: boolean;
	enabled: boolean;
	revision: number;
	lastOutcome?: LiveContextOutcome;
	timeline: ContextTimeline;
	input?: InputView;
	revisions: EditRevision[];
	settings: PanelSettings;
	/** Budget line of the overview chart (the budget in force). */
	budget?: number;
	budgetInfo?: BudgetView;
	calibration?: { factor: number; samples: number };
	steering?: { name: string; hash: string; path: string };
	mirrorPath: string;
	/** Problems reading the files (corrupt JSON, skipped event lines). */
	warnings: string[];
}

/** Newest provider count the host knows, sized like the server's `observedPrevious`. */
export interface LatestUsage {
	/** input + cache read + cache write of the assistant message (no output), as clm.ts measures. */
	tokens: number;
	/**
	 * When the reply finished (ms or ISO); undefined while it streams. OpenCode creates the
	 * assistant message before the request, so completion (not creation) tells whether the
	 * reply answered the newest request.
	 */
	completedAt?: number | string;
}

export interface PanelExtras {
	/** Sizes the newest request when it is a reply completed after that request was sent. */
	latest?: LatestUsage;
	/**
	 * Budget from the resolved settings and the model limits, for sessions without
	 * snapshot.json. `cap` is the model window minus its output limit (bounds a raise).
	 */
	budget?: { budget: number; reserve: number; source?: string; cap?: number };
	settings?: PanelSettings;
	/**
	 * `budget` (the effective settings) wins over snapshot.json: overrides.json changed after
	 * the last request, so its budget applies from the next one.
	 */
	preferSettings?: boolean;
}

const EDIT_KINDS = new Set<string>(["kept", "edited", "removed", "restored", "normalized", "added"]);
const OUTCOME_KINDS = new Set<string>(["applied", "rejected", "reset", "compacted"]);
const PREVIEW_CHARACTERS = 220;

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function count(value: unknown): number | undefined {
	return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Event name: `event` as clm.ts writes it, `type` accepted too. */
export function eventName(event: ClmEvent): string | undefined {
	return str(event.event) ?? str(event.type);
}

function preview(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= PREVIEW_CHARACTERS ? flat : `${flat.slice(0, PREVIEW_CHARACTERS - 1)}…`;
}

// ---- timeline ------------------------------------------------------------------------

function timeOf(value: number | string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const ms = typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Points from `request` events (requests flagged `compaction` excluded) and markers from
 * outcome events. Every size is the server's measure: input + cache read + cache write of
 * the reply (no output). A request's provider count is the next request event's
 * `observedPrevious`, unless the next event names the same reporting message
 * (`observedMessage`) as this one: the reply failed and the count is the older one again.
 * Events without `observedMessage` fall back to comparing the counts. The newest request takes `latest` when that
 * reply completed after the request was sent; otherwise the logged `estimated`
 * (`measured: false`).
 */
export function buildTimeline(events: readonly ClmEvent[], latest?: LatestUsage): ContextTimeline {
	const points: TimelinePoint[] = [];
	const markers: TimelineMarker[] = [];
	const turnStarts: number[] = [];
	const requests = events
		.map((event, position) => ({ event, position }))
		.filter(({ event }) => eventName(event) === "request");
	const observedAfter = new Map<number, number>();
	requests.forEach(({ event, position }, index) => {
		const next = requests[index + 1];
		const observed = next ? num(next.event.observedPrevious) : undefined;
		if (observed === undefined || observed <= 0) return;
		// The same reporting message again: the reply to this request failed or reported no
		// usage, so the count is the older one. Without the id (logs before v0.2.0), an equal
		// count stands in for "same message".
		const nextMessage = str(next!.event.observedMessage);
		if (nextMessage !== undefined) {
			if (nextMessage === str(event.observedMessage)) return;
		} else if (observed === num(event.observedPrevious)) {
			return;
		}
		observedAfter.set(position, observed);
	});
	const lastRequest = requests.filter(({ event }) => event.compaction !== true).at(-1);
	const lastAt = timeOf(str(lastRequest?.event.at));
	const latestCompleted = timeOf(latest?.completedAt);
	const latestTokens = latest && latestCompleted !== undefined && latest.tokens > 0 &&
			(lastAt === undefined || latestCompleted >= lastAt)
		? latest.tokens
		: undefined;
	let users = 0;

	events.forEach((event, position) => {
		const name = eventName(event);
		const at = str(event.at);
		if (name === "request") {
			if (event.compaction === true) return;
			let tokens = observedAfter.get(position);
			if (tokens === undefined && position === lastRequest?.position) tokens = latestTokens;
			const measured = tokens !== undefined;
			points.push({
				request: points.length + 1,
				...(at ? { at } : {}),
				tokens: tokens ?? Math.max(0, num(event.estimated) ?? 0),
				measured,
				revision: count(event.revision) ?? 0,
			});
			// `users` counts user messages in the raw history; a rise starts a turn. A drop
			// (compaction rewrote the history) only resets the count.
			const seen = count(event.users);
			if (seen !== undefined) {
				if (seen > users) turnStarts.push(points.length - 1);
				users = seen;
			}
			return;
		}
		const marker = markerOf(name, event, points.length - 1);
		if (marker) markers.push(marker);
	});
	return { points, markers, peakTokens: points.reduce((peak, point) => Math.max(peak, point.tokens), 0), turnStarts };
}

function markerOf(name: string | undefined, event: ClmEvent, afterPoint: number): TimelineMarker | undefined {
	const at = str(event.at);
	const revision = count(event.revision);
	const base = (kind: MarkerKind, markerRevision: number, message: string): TimelineMarker => ({
		kind,
		revision: markerRevision,
		...(at ? { at } : {}),
		afterPoint,
		message,
	});
	switch (name) {
		case "accepted": {
			if (revision === undefined) return undefined;
			const marker = base("applied", revision, `Applied revision ${revision}.`);
			const before = num(event.before);
			const after = num(event.after);
			if (before !== undefined) marker.beforeTokens = before;
			if (after !== undefined) marker.afterTokens = after;
			return marker;
		}
		case "rejected":
			return base("rejected", revision ?? 0, str(event.reason) ?? "Context edit rejected.");
		case "reset":
			return base("reset", revision ?? 0, str(event.reason) ?? "Reset to the raw context.");
		case "projection-reset": {
			// Logged with the dropped revision; the reset moves one past it.
			const dropped = revision;
			const reason = str(event.reason) ?? "OpenCode's history changed.";
			return base("reset", dropped === undefined ? 0 : dropped + 1, dropped === undefined ? reason : `Revision ${dropped} dropped: ${reason}`);
		}
		case "restored": {
			// Revert (`dropped`) or fork (`origin`): an older revision became the next one.
			const from = count(event.from);
			const origin = str(event.origin);
			const source = from === undefined ? "an earlier revision" : `r${from}`;
			return base("restored", revision ?? 0, origin ? `restored ${source} of ${origin} (fork)` : `restored ${source} (revert)`);
		}
		case "compacted": {
			const summary = str(event.summary);
			return base("compacted", revision ?? 0, summary ? `Rebased on compaction summary ${summary}.` : "Rebased on a compaction summary.");
		}
		default:
			return undefined;
	}
}

// ---- revisions -----------------------------------------------------------------------

function editFromRow(row: unknown): EditView | undefined {
	if (!isObject(row) || typeof row.kind !== "string" || !EDIT_KINDS.has(row.kind)) return undefined;
	const kind = row.kind as EditKind;
	const role = str(row.role);
	const beforeRole = str(row.beforeRole) ?? role;
	const afterRole = str(row.afterRole) ?? role;
	const sourceIndex = count(row.sourceIndex);
	const outputIndex = count(row.outputIndex);
	// `text` stands for both sides of an unchanged row (written since v0.2.0 block 3 fixes).
	const before = kind === "added" ? undefined : str(row.before) ?? str(row.text);
	const after = kind === "removed" ? undefined : str(row.after) ?? str(row.text);
	const view: EditView = { kind };
	if (sourceIndex !== undefined) view.sourceIndex = sourceIndex + 1;
	if (outputIndex !== undefined) view.outputIndex = outputIndex + 1;
	if (beforeRole !== undefined && kind !== "added") view.beforeRole = beforeRole;
	if (afterRole !== undefined && kind !== "removed") view.afterRole = afterRole;
	const beforeTokens = num(row.beforeTokens);
	const afterTokens = num(row.afterTokens);
	if (beforeTokens !== undefined) view.beforeTokens = beforeTokens;
	if (afterTokens !== undefined) view.afterTokens = afterTokens;
	if (before !== undefined) {
		view.beforeText = before;
		view.beforePreview = preview(before);
	}
	if (after !== undefined) {
		view.afterText = after;
		view.afterPreview = preview(after);
	}
	return view;
}

function revisionFromFile(value: unknown, revision: number): EditRevision | undefined {
	if (!isObject(value) || value.version !== 1 || !Array.isArray(value.rows)) return undefined;
	const result: EditRevision = {
		revision: count(value.revision) ?? revision,
		sourceRevision: count(value.sourceRevision) ?? Math.max(0, revision - 1),
		edits: value.rows.map(editFromRow).filter((edit): edit is EditView => edit !== undefined),
		traceSource: "recorded",
	};
	const at = str(value.at);
	if (at) result.createdAt = at;
	const beforeTokens = num(value.beforeTokens);
	const afterTokens = num(value.afterTokens);
	if (beforeTokens !== undefined) result.beforeTokens = beforeTokens;
	if (afterTokens !== undefined) result.afterTokens = afterTokens;
	return result;
}

/**
 * One entry per accepted revision: rN.json when present and valid; otherwise an
 * `unavailable` entry built from rN.md and the `accepted` event, so v0.1 sessions still
 * list their revisions.
 */
export function buildRevisions(files: Pick<SessionFiles, "events" | "revisions" | "revisionTexts">): EditRevision[] {
	const accepted = new Map<number, ClmEvent>();
	for (const event of files.events) {
		const revision = count(event.revision);
		if (eventName(event) === "accepted" && revision !== undefined) accepted.set(revision, event);
	}
	const numbers = new Set<number>([...files.revisions.keys(), ...files.revisionTexts.keys(), ...accepted.keys()]);
	const result: EditRevision[] = [];
	for (const revision of [...numbers].sort((a, b) => a - b)) {
		const recorded = files.revisions.has(revision) ? revisionFromFile(files.revisions.get(revision), revision) : undefined;
		if (recorded) {
			result.push(recorded);
			continue;
		}
		const event = accepted.get(revision);
		const entry: EditRevision = { revision, sourceRevision: Math.max(0, revision - 1), edits: [], traceSource: "unavailable" };
		const at = event ? str(event.at) : undefined;
		if (at) entry.createdAt = at;
		const before = event ? num(event.before) : undefined;
		const after = event ? num(event.after) : undefined;
		if (before !== undefined) entry.beforeTokens = before;
		if (after !== undefined) entry.afterTokens = after;
		const text = files.revisionTexts.get(revision);
		if (text !== undefined) entry.mirrorText = text;
		result.push(entry);
	}
	return result;
}

// ---- snapshot, state, budget ---------------------------------------------------------

function inputFrom(snapshot: Record<string, unknown> | undefined, mirrorPath: string, lastRequestAt: string | undefined): InputView | undefined {
	const input = snapshot?.input;
	if (!isObject(input)) return undefined;
	const messages = Array.isArray(input.messages)
		? input.messages.flatMap((message): InputMessageView[] => {
			if (!isObject(message)) return [];
			const index = count(message.index);
			const role = str(message.role);
			if (index === undefined || role === undefined) return [];
			return [{ index, role, tokens: num(message.tokens) ?? 0, preview: str(message.preview) ?? "" }];
		})
		: [];
	return {
		capturedAt: str(snapshot?.at) ?? "",
		rawMessages: count(input.raw) ?? 0,
		sentMessages: count(input.sent) ?? 0,
		suffix: count(input.suffix) ?? 0,
		rawTokens: num(input.rawTokens) ?? 0,
		effectiveTokens: num(input.effectiveTokens) ?? 0,
		messages,
		mirrorPath,
		stale: (() => {
			const captured = timeOf(str(snapshot?.at));
			const last = timeOf(lastRequestAt);
			return captured !== undefined && last !== undefined && last > captured;
		})(),
	};
}

function outcomeFrom(value: unknown): LiveContextOutcome | undefined {
	if (!isObject(value) || typeof value.kind !== "string" || !OUTCOME_KINDS.has(value.kind)) return undefined;
	const message = str(value.message);
	const at = str(value.at);
	if (message === undefined || at === undefined) return undefined;
	const outcome: LiveContextOutcome = { kind: value.kind as OutcomeKind, message, at };
	const before = num(value.beforeEstimate);
	const after = num(value.afterEstimate);
	if (before !== undefined) outcome.beforeEstimate = before;
	if (after !== undefined) outcome.afterEstimate = after;
	if (value.estimateUnit === "tokens" || value.estimateUnit === "characters") outcome.estimateUnit = value.estimateUnit;
	return outcome;
}

/**
 * Budget fields. Configured budget and reserve: snapshot.json, else `extras` (the TUI's
 * resolved settings), else the stored check, else the newest check event. Overhead:
 * snapshot.json, else `state.budgetCheck`, else the newest `budget-too-small` /
 * `budget-check` event. The raise is recomputed with `budgetFit`, as the server does on
 * every request, so a stored decision never outlives a config change. With
 * `preferFallback` (overrides.json newer than snapshot.json) the snapshot's budget, reserve
 * and limit are ignored and `fallback` (the effective settings) is used. Event fields are
 * read under the names clm.ts logs (`configured`, `effective`) and the short names
 * (`budget`, `effectiveBudget`); unknown fields are ignored.
 */
export function buildBudget(
	snapshot: Record<string, unknown> | undefined,
	state: Record<string, unknown> | undefined,
	events: readonly ClmEvent[],
	fallback?: PanelExtras["budget"],
	preferFallback = false,
): BudgetView | undefined {
	const snapshotBudget = isObject(snapshot?.budget) && !(preferFallback && fallback) ? snapshot.budget : undefined;
	const check = isObject(state?.budgetCheck) ? state.budgetCheck : undefined;
	let checkEvent: ClmEvent | undefined;
	let tooSmallEvent = false;
	for (const event of events) {
		const name = eventName(event);
		if (name === "budget-too-small" || name === "budget-check") checkEvent = event;
		if (name === "budget-too-small") tooSmallEvent = true;
	}
	const pick = (...values: unknown[]) => values.map(num).find((value) => value !== undefined);
	const overhead = pick(snapshot?.overhead, snapshotBudget?.overhead, check?.overhead, checkEvent?.overhead);
	const configured = pick(snapshotBudget?.budget, fallback?.budget, check?.configured, checkEvent?.configured, checkEvent?.budget);
	const reserve = pick(snapshotBudget?.reserve, fallback?.reserve, check?.reserve, checkEvent?.reserve);
	const limit = pick(snapshotBudget?.limit);
	const overheadSource = str(check?.source) ?? str(checkEvent?.source);

	const view: BudgetView = { tooSmall: false };
	if (configured !== undefined) {
		const fit = budgetFit(configured, reserve ?? 0, overhead, fallback?.cap);
		view.budget = fit.effective;
		view.configured = fit.configured;
		view.reserve = fit.reserve;
		if (fit.usable !== undefined) view.usable = fit.usable;
		if (fit.effectiveUsable !== undefined) view.effectiveUsable = fit.effectiveUsable;
		view.raised = fit.raised;
		view.capped = fit.capped;
		view.tooSmall = fit.overhead === undefined ? tooSmallEvent : fit.tooSmall;
	} else {
		if (overhead === undefined && !tooSmallEvent && limit === undefined) return undefined;
		view.tooSmall = tooSmallEvent;
		const effective = pick(checkEvent?.effective, checkEvent?.effectiveBudget);
		if (effective !== undefined) view.budget = effective;
		if (reserve !== undefined) view.reserve = reserve;
	}
	if (limit !== undefined) view.limit = limit;
	const source = str(snapshotBudget?.source) ?? (snapshotBudget ? undefined : fallback?.source);
	if (source) view.source = source;
	if (overhead !== undefined) view.overhead = overhead;
	if (overhead !== undefined && (overheadSource === "provider" || overheadSource === "estimate")) view.overheadSource = overheadSource;
	return view;
}

// ---- the model -----------------------------------------------------------------------

const EMPTY_SETTINGS: PanelSettings = { rows: [], summary: [], changed: [] };

export function buildPanelModel(files: SessionFiles, extras: PanelExtras = {}): PanelModel {
	const snapshot = isObject(files.snapshot) ? files.snapshot : undefined;
	const state = isObject(files.state) ? files.state : undefined;
	const timeline = buildTimeline(files.events, extras.latest);
	// projection-reset logs the dropped revision; the others log the revision in force.
	const eventRevision = files.events.reduce(
		(most, event) => eventName(event) === "projection-reset" ? most : Math.max(most, count(event.revision) ?? 0),
		0,
	);
	const lastRequestAt = files.events.filter((event) => eventName(event) === "request" && event.compaction !== true).at(-1)?.at;
	const warnings = [...files.warnings];
	if (files.skippedEventLines > 0) {
		warnings.push(`Skipped ${files.skippedEventLines} unreadable line${files.skippedEventLines === 1 ? "" : "s"} in events.jsonl.`);
	}
	const budgetInfo = buildBudget(snapshot, state, files.events, extras.budget, extras.preferSettings === true);
	const model: PanelModel = {
		sessionID: files.sessionID,
		directory: files.directory,
		found: files.found,
		enabled: typeof state?.enabled === "boolean"
			? state.enabled
			: typeof snapshot?.enabled === "boolean" ? snapshot.enabled : true,
		revision: count(state?.revision) ?? count(snapshot?.revision) ?? eventRevision,
		timeline,
		revisions: buildRevisions(files),
		settings: extras.settings ?? EMPTY_SETTINGS,
		mirrorPath: files.mirrorPath,
		warnings,
	};
	const lastOutcome = outcomeFrom(state?.lastOutcome);
	if (lastOutcome) model.lastOutcome = lastOutcome;
	const input = inputFrom(snapshot, files.mirrorPath, typeof lastRequestAt === "string" ? lastRequestAt : undefined);
	if (input) model.input = input;
	if (budgetInfo) {
		model.budgetInfo = budgetInfo;
		if (budgetInfo.budget !== undefined) model.budget = budgetInfo.budget;
	}
	const calibration = isObject(snapshot?.calibration) ? snapshot.calibration : undefined;
	const factor = num(calibration?.factor);
	if (factor !== undefined) model.calibration = { factor, samples: count(calibration?.samples) ?? 0 };
	const steering = isObject(snapshot?.steering) ? snapshot.steering : undefined;
	if (steering && typeof steering.name === "string" && typeof steering.hash === "string" && typeof steering.path === "string") {
		model.steering = { name: steering.name, hash: steering.hash, path: steering.path };
	}
	return model;
}
