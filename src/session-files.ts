// Read-only access to one session's CLM directory (`<mirrorDir>/clm-<session>/`) for the
// `/clm` panel: events.jsonl, state.json, snapshot.json and revisions/rN.{json,md}. Missing
// files are normal (a v0.1 session has no snapshot or rN.json); torn or corrupt lines and
// files are skipped, never thrown. Written for this package.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { safeSessionId } from "./mirror-store.ts";
import {
	EVENTS_FILE,
	MIRROR_FILE,
	REVISIONS_DIRECTORY,
	SNAPSHOT_FILE,
	type ClmEvent,
	type SessionFiles,
} from "./panel/files.ts";
import { STATE_FILE } from "./state.ts";

/** `<mirrorDir>/clm-<safe session id>`, the directory MirrorStore creates for the session. */
export function sessionDirectory(mirrorDir: string, sessionID: string): string {
	return join(mirrorDir, `clm-${safeSessionId(sessionID)}`);
}

/**
 * Parses events.jsonl text. Blank lines are ignored; lines that are not a JSON object (a
 * torn final line from a concurrent append, or corruption) are counted and skipped.
 */
export function parseEvents(text: string): { events: ClmEvent[]; skipped: number } {
	const events: ClmEvent[] = [];
	let skipped = 0;
	const lines = text.split("\n");
	lines.forEach((line, index) => {
		if (line.trim() === "") return;
		// An unterminated last line is usually an append in progress: parse it if it is
		// whole, but do not count it as unreadable.
		const unterminated = index === lines.length - 1;
		try {
			const value: unknown = JSON.parse(line);
			if (value && typeof value === "object" && !Array.isArray(value)) events.push(value as ClmEvent);
			else if (!unterminated) skipped++;
		} catch {
			if (!unterminated) skipped++;
		}
	});
	return { events, skipped };
}

/**
 * Revision files keyed by path, kept while their mtime and size are unchanged, so a reload
 * on every streamed message reads only new or changed revisions. rN files are written once.
 */
const revisionCache = new Map<string, { mtimeMs: number; size: number; value: unknown }>();
const REVISION_CACHE_LIMIT = 2_000;

async function readCached(path: string, kind: "json" | "md", warnings: string[]): Promise<unknown> {
	let info;
	try {
		info = await stat(path);
	} catch (error) {
		if (!isMissing(error)) warnings.push(`Could not read ${path}: ${describe(error)}`);
		return undefined;
	}
	const cached = revisionCache.get(path);
	if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value;
	const value = kind === "json" ? await readJson(path, warnings) : await readText(path, warnings);
	if (value !== undefined) {
		if (revisionCache.size >= REVISION_CACHE_LIMIT) revisionCache.delete(revisionCache.keys().next().value!);
		revisionCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, value });
	}
	return value;
}

function isRevisionFile(value: unknown): boolean {
	return Boolean(value) && typeof value === "object" && (value as { version?: unknown }).version === 1 &&
		Array.isArray((value as { rows?: unknown }).rows);
}

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function readText(path: string, warnings: string[]): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (!isMissing(error)) warnings.push(`Could not read ${path}: ${describe(error)}`);
		return undefined;
	}
}

async function readJson(path: string, warnings: string[]): Promise<unknown> {
	const text = await readText(path, warnings);
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch (error) {
		warnings.push(`${path} is not valid JSON: ${describe(error)}`);
		return undefined;
	}
}

/** Reads the session directory of `sessionID` under `mirrorDir`. */
export function readSessionFiles(mirrorDir: string, sessionID: string): Promise<SessionFiles> {
	return readSessionDirectory(sessionDirectory(mirrorDir, sessionID), sessionID);
}

/** Reads a session directory given its path. Never throws for missing or corrupt files. */
export async function readSessionDirectory(directory: string, sessionID: string): Promise<SessionFiles> {
	const warnings: string[] = [];
	const files: SessionFiles = {
		sessionID,
		directory,
		found: false,
		events: [],
		skippedEventLines: 0,
		revisions: new Map(),
		revisionTexts: new Map(),
		mirrorPath: join(directory, MIRROR_FILE),
		warnings,
	};
	try {
		files.found = (await stat(directory)).isDirectory();
	} catch (error) {
		if (!isMissing(error)) warnings.push(`Could not read ${directory}: ${describe(error)}`);
	}
	if (!files.found) return files;

	const [eventsText, state, snapshot] = await Promise.all([
		readText(join(directory, EVENTS_FILE), warnings),
		readJson(join(directory, STATE_FILE), warnings),
		readJson(join(directory, SNAPSHOT_FILE), warnings),
	]);
	if (eventsText !== undefined) {
		const parsed = parseEvents(eventsText);
		files.events = parsed.events;
		files.skippedEventLines = parsed.skipped;
	}
	if (state !== undefined) files.state = state;
	if (snapshot !== undefined) files.snapshot = snapshot;

	const revisionsDirectory = join(directory, REVISIONS_DIRECTORY);
	let names: string[] = [];
	try {
		names = await readdir(revisionsDirectory);
	} catch (error) {
		if (!isMissing(error)) warnings.push(`Could not list ${revisionsDirectory}: ${describe(error)}`);
	}
	const jsonRevisions = new Set<number>();
	const mdRevisions = new Set<number>();
	for (const name of names) {
		const match = /^r(\d+)\.(json|md)$/.exec(name);
		if (match) (match[2] === "json" ? jsonRevisions : mdRevisions).add(Number(match[1]));
	}
	await Promise.all([...jsonRevisions].map(async (revision) => {
		const value = await readCached(join(revisionsDirectory, `r${revision}.json`), "json", warnings);
		if (value !== undefined) files.revisions.set(revision, value);
	}));
	// rN.md is only shown when rN.json is missing or invalid.
	await Promise.all([...mdRevisions].filter((revision) => !isRevisionFile(files.revisions.get(revision))).map(async (revision) => {
		const text = await readCached(join(revisionsDirectory, `r${revision}.md`), "md", warnings);
		if (typeof text === "string") files.revisionTexts.set(revision, text);
	}));
	return files;
}
