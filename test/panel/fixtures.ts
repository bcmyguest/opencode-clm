// Event fixtures for the panel tests: events.jsonl lines as clm.ts logs them.

import type { ClmEvent, SessionFiles } from "../../src/panel/files.ts";
import type { LatestUsage } from "../../src/panel/model.ts";

const START = Date.parse("2026-01-01T09:00:00Z");

export function at(seconds: number): string {
	return new Date(START + seconds * 1000).toISOString();
}

export function request(estimated: number, seconds: number, extra: Partial<ClmEvent> = {}): ClmEvent {
	return { at: at(seconds), event: "request", n: 0, revision: 0, raw: 1, sent: 1, blocks: 1, withheld: 0, estimated, calibration: 1, notices: [], ...extra };
}

export function accepted(revision: number, seconds: number, before?: number, after?: number): ClmEvent {
	return { at: at(seconds), event: "accepted", revision, before, after };
}

export function rejected(revision: number, seconds: number, reason = "unknown block ids"): ClmEvent {
	return { at: at(seconds), event: "rejected", revision, reason };
}

export function reset(revision: number, seconds: number, reason = "/clm reset"): ClmEvent {
	return { at: at(seconds), event: "reset", revision, reason };
}

export function files(partial: Partial<SessionFiles> = {}): SessionFiles {
	return {
		sessionID: "ses_test",
		directory: "/tmp/clm-ses_test",
		found: true,
		events: [],
		skippedEventLines: 0,
		revisions: new Map(),
		revisionTexts: new Map(),
		mirrorPath: "/tmp/clm-ses_test/LIVE_CONTEXT.md",
		warnings: [],
		...partial,
	};
}

/**
 * A v0.1 session (rewritten from pi-clm's timeline test fixture): one user turn, two
 * requests, an accepted edit, two more requests, a rejection and a reset. Sizes are
 * provider counts via the next request's `observedPrevious`, except the newest.
 */
export const basicEvents: ClmEvent[] = [
	request(2800, 1, { users: 1 }),
	request(5900, 2, { observedPrevious: 3000, users: 1 }),
	accepted(1, 3, 9500, 2900),
	request(3900, 4, { observedPrevious: 6000, revision: 1, users: 1 }),
	request(6800, 5, { observedPrevious: 4000, revision: 1, users: 1 }),
	rejected(1, 6),
	reset(2, 7),
];

/** A reply completed at `seconds` (still streaming when `completed` is false). */
export function latest(tokens: number, seconds: number, completed = true): LatestUsage {
	return completed ? { tokens, completedAt: at(seconds) } : { tokens };
}

/** One accepted revision with a kept, an edited and a removed row (rN.json shape). */
export const revisionFile = {
	version: 1,
	revision: 1,
	sourceRevision: 0,
	at: at(3),
	beforeTokens: 9500,
	afterTokens: 2900,
	rows: [
		{ kind: "kept", sourceIndex: 0, outputIndex: 0, role: "user", beforeTokens: 300, afterTokens: 300, before: "task", after: "task" },
		{ kind: "edited", sourceIndex: 1, outputIndex: 1, role: "assistant", beforeTokens: 9000, afterTokens: 2500, before: "long\nold answer\ntail", after: "short\nnew answer\ntail" },
		{ kind: "removed", sourceIndex: 2, role: "tool", beforeTokens: 200, before: "output" },
	],
};

export const snapshotFile = {
	at: at(5),
	request: 4,
	revision: 1,
	enabled: true,
	budget: { budget: 16_000, reserve: 2_000, limit: 14_000, source: "config" },
	calibration: { factor: 1, samples: 0 },
	sizes: { estimated: 6800 },
	input: {
		raw: 9, sent: 5, suffix: 2, rawTokens: 12_000, effectiveTokens: 4_000,
		messages: [{ index: 1, role: "user", tokens: 300, preview: "task" }, { index: 2, role: "assistant", tokens: 900, preview: "answer" }],
	},
	overhead: 9_000,
};

export const settingsFixture = {
	rows: [
		{ key: "editing", label: "CLM editing", value: "on", choices: ["on", "off"], description: "Whether edits apply." },
		{ key: "budget", label: "Budget", value: "16k", placeholder: "32k" },
	],
	summary: ["Size last request 7.0k"],
	changed: [],
};
