// Checkpoint history: every accepted revision's checkpoint, kept in
// `<session dir>/checkpoints/rN.json` (the newest HISTORY_CAP files). pi-clm rebuilds its
// history from the session entries on the active branch (pi-clm src/index.ts `restore`,
// MIT, Copyright 2026 Emanuel Casco) and restores the checkpoint valid on the branch `/tree`
// selects. OpenCode has no branches; its equivalents are revert
// (packages/opencode/src/session/revert.ts), which cuts the history, and `Session.fork`
// (packages/opencode/src/session/session.ts:691-731), which copies it into a new session
// under new message ids. clm.ts uses this history to restore the newest older revision that
// still fits after either. Written for this package.
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { writeJsonAtomic } from "./atomic.ts";
import { sourceMessageId, type ProjectionCheckpoint } from "./projection.ts";
import { isProjectionCheckpoint } from "./state.ts";
import type { LiveContextMessage } from "./types.ts";

export const HISTORY_DIR = "checkpoints";
/** Checkpoints kept per session; each holds a whole projected context, so the count is small. */
export const HISTORY_CAP = 8;

const FILE_RE = /^r(\d+)\.json$/;

export interface HistoryEntry {
	version: 1;
	checkpoint: ProjectionCheckpoint;
	/** `digestSourceContent` of the checkpoint's source: matches a forked copy of it. */
	contentDigest: string;
}

export interface LoadedHistory {
	/** Newest revision first. */
	entries: HistoryEntry[];
	/** Files that were skipped (unreadable, malformed, or naming another revision). */
	ignored: string[];
}

export function historyDirectory(sessionDirectory: string): string {
	return join(sessionDirectory, HISTORY_DIR);
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<HistoryEntry>;
	return entry.version === 1 && isProjectionCheckpoint(entry.checkpoint) &&
		typeof entry.contentDigest === "string" && /^[a-f0-9]{64}$/.test(entry.contentDigest);
}

/** Write one checkpoint, then delete all but the newest `cap` files. */
export async function saveHistoryEntry(sessionDirectory: string, entry: HistoryEntry, cap = HISTORY_CAP): Promise<void> {
	const directory = historyDirectory(sessionDirectory);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeJsonAtomic(join(directory, `r${entry.checkpoint.revision}.json`), entry);
	const revisions = (await readdir(directory))
		.map((name) => FILE_RE.exec(name))
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match) => Number(match[1]))
		.sort((left, right) => right - left);
	await Promise.all(revisions.slice(Math.max(1, cap)).map((revision) =>
		rm(join(directory, `r${revision}.json`), { force: true })));
}

/** All usable entries, newest first. Never throws: a missing directory is an empty history. */
export async function loadHistory(sessionDirectory: string): Promise<LoadedHistory> {
	const directory = historyDirectory(sessionDirectory);
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return { entries: [], ignored: [] };
	}
	const entries: HistoryEntry[] = [];
	const ignored: string[] = [];
	for (const name of names) {
		const match = FILE_RE.exec(name);
		if (!match) continue;
		try {
			const parsed: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
			if (isHistoryEntry(parsed) && parsed.checkpoint.revision === Number(match[1])) entries.push(parsed);
			else ignored.push(name);
		} catch {
			ignored.push(name);
		}
	}
	entries.sort((left, right) => right.checkpoint.revision - left.checkpoint.revision);
	return { entries, ignored };
}

/** Forget every checkpoint (`/clm reset`: the user dropped the edits on purpose). */
export async function clearHistory(sessionDirectory: string): Promise<void> {
	await rm(historyDirectory(sessionDirectory), { recursive: true, force: true });
}

/**
 * The checkpoint's projected messages with the source session's message ids replaced by
 * the fork's, position by position over the source prefix (`source` is the fork's prefix,
 * same length as `checkpoint.sourceIds`). Ids outside the prefix stay as they are.
 */
export function remapProjection(checkpoint: ProjectionCheckpoint, source: readonly LiveContextMessage[]): LiveContextMessage[] {
	const ids = new Map<string, string>();
	checkpoint.sourceIds.forEach((id, index) => {
		const next = source[index] ? sourceMessageId(source[index]) : "";
		if (id && next && !ids.has(id)) ids.set(id, next);
	});
	return checkpoint.projectedMessages.map((message) => {
		const id = typeof message.ocMessageID === "string" ? ids.get(message.ocMessageID) : undefined;
		return id === undefined ? message : { ...message, ocMessageID: id };
	});
}
