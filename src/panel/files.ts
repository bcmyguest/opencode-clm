// Shapes of the session-directory files the `/clm` panel reads (v0.2.0 design §3). The
// server writes events.jsonl and state.json today; snapshot.json and revisions/rN.json are
// the v0.2.0 additions and may be absent (v0.1 sessions). Written for this package.

import type { ContextEditSourceKind } from "../types.ts";

export const EVENTS_FILE = "events.jsonl";
export const SNAPSHOT_FILE = "snapshot.json";
export const REVISIONS_DIRECTORY = "revisions";
export const MIRROR_FILE = "LIVE_CONTEXT.md";

/** One parsed line of events.jsonl: `{ at, event, ...fields }`. Unknown fields are kept. */
export type ClmEvent = Record<string, unknown> & { at?: string; event?: string };

/** One message row of `revisions/rN.json`. Indices are zero-based, as in `ContextEditTrace`. */
export interface RevisionFileRow {
	kind: ContextEditSourceKind | "added";
	sourceIndex?: number;
	outputIndex?: number;
	role: string;
	/** Role before and after, when they differ (`role` is then the after role). */
	beforeRole?: string;
	afterRole?: string;
	beforeTokens?: number;
	afterTokens?: number;
	/** Full rendered text before the edit (absent for `added`). */
	before?: string;
	/** Full rendered text after the edit (absent for `removed`). */
	after?: string;
	/** Full text when before and after are identical (kept rows); `before` and `after` are then absent. */
	text?: string;
}

/** `revisions/rN.json`, written once per accepted edit (0600). */
export interface RevisionFile {
	version: 1;
	revision: number;
	sourceRevision: number;
	at: string;
	beforeTokens: number;
	afterTokens: number;
	rows: RevisionFileRow[];
}

export interface SnapshotInputMessage {
	index: number;
	role: string;
	tokens: number;
	/** At most 120 characters. */
	preview: string;
}

/** `snapshot.json`, replaced atomically on every request. */
export interface SnapshotFile {
	at: string;
	request: number;
	revision: number;
	enabled: boolean;
	/** `budget` is the configured budget before any raise; the panel recomputes the raise with `budgetFit`. */
	budget: { budget: number; reserve: number; limit: number; source: string };
	calibration: { factor: number; samples: number };
	steering?: { name: string; hash: string; path: string };
	/** Why the configured steering document did not load (sessions then run protocol-only). */
	steeringError?: string;
	sizes: { estimated: number; observedPrevious?: number };
	input: {
		raw: number;
		sent: number;
		suffix: number;
		rawTokens: number;
		effectiveTokens: number;
		messages: SnapshotInputMessage[];
	};
	/** Fixed overhead per request (system prompt + tool schemas), tokens, once measured. */
	overhead?: number;
	/**
	 * The server's base settings (options, environment, defaults; before overrides), in
	 * overrides.json form (`settingsAsOverrides`). The TUI validates changes against it.
	 */
	base?: Record<string, unknown>;
}

/**
 * Raw contents of one session directory, as read by session-files.ts. Values are unchecked
 * JSON; model.ts validates them field by field.
 */
export interface SessionFiles {
	sessionID: string;
	directory: string;
	/** False when the session directory does not exist. */
	found: boolean;
	events: ClmEvent[];
	/** events.jsonl lines that did not parse (torn or corrupt). */
	skippedEventLines: number;
	state?: unknown;
	snapshot?: unknown;
	/** `revisions/rN.json` contents by revision number. */
	revisions: Map<number, unknown>;
	/** `revisions/rN.md` (the accepted mirror text, v0.1) by revision number. */
	revisionTexts: Map<number, string>;
	/** Path of the mirror file, whether or not it exists. */
	mirrorPath: string;
	/** annotations.jsonl counts: unresolved continuity/pin, unresolved archive, all. */
	annotations?: { active: number; archived: number; total: number };
	/** Read problems other than missing files. */
	warnings: string[];
}
