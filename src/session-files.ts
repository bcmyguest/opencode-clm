// Read-only access to one session's CLM directory (`<mirrorDir>/clm-<session>/`) for the
// `/clm` panel: events.jsonl, state.json, snapshot.json and revisions/rN.{json,md}. Missing
// files are normal (a v0.1 session has no snapshot or rN.json); torn or corrupt lines and
// files are skipped, never thrown. Reads go through a `SessionReader`: the disk, or the
// server's file API for an attached TUI (src/tui/remote.ts). Written for this package.

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
import { activeContinuityAnnotations, ANNOTATIONS_FILE, reconstructAnnotations } from "./continuity.ts";

/** Counts of annotations.jsonl (latest snapshot per id, as the server reconstructs them). */
export function countAnnotations(text: string): { active: number; archived: number; total: number } {
	const annotations = reconstructAnnotations(parseEvents(text).events);
	return {
		active: activeContinuityAnnotations(annotations).length,
		archived: annotations.filter((annotation) => annotation.retention === "archive" && annotation.resolvedAt === undefined).length,
		total: annotations.length,
	};
}

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
 * Where a session directory is read from: the local disk, or the server through OpenCode's
 * file API when the TUI runs elsewhere (src/tui/remote.ts). Paths are the server's absolute
 * paths either way.
 */
export interface SessionReader {
	/** Cache-key prefix, so the same path read two ways does not share entries. */
	readonly name: string;
	/** True for a directory; false when missing. Throws for other errors. */
	isDirectory(path: string): Promise<boolean>;
	/** File text; undefined when missing. Throws for other errors. */
	readText(path: string): Promise<string | undefined>;
	/** Entry names; [] when the directory is missing. Throws for other errors. */
	list(path: string): Promise<string[]>;
	/**
	 * Version stamp of a file for the revision cache (mtime and size locally); undefined
	 * when missing. A constant stamp caches the file for good (rN files are written once).
	 */
	stamp(path: string): Promise<string | undefined>;
}

export const localReader: SessionReader = {
	name: "local",
	async isDirectory(path) {
		try {
			return (await stat(path)).isDirectory();
		} catch (error) {
			if (isMissing(error)) return false;
			throw error;
		}
	},
	async readText(path) {
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
	},
	async list(path) {
		try {
			return await readdir(path);
		} catch (error) {
			if (isMissing(error)) return [];
			throw error;
		}
	},
	async stamp(path) {
		try {
			const info = await stat(path);
			return `${info.mtimeMs}:${info.size}`;
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
	},
};

/**
 * Revision files keyed by reader and path, kept while their stamp is unchanged, so a reload
 * on every streamed message reads only new or changed revisions. rN files are written once.
 */
const revisionCache = new Map<string, { stamp: string; size: number; value: unknown }>();
const REVISION_CACHE_LIMIT = 2_000;
/** Total text kept (characters); the oldest entries go first once it is exceeded. */
const REVISION_CACHE_BYTES = 32 * 1024 * 1024;
let revisionCacheBytes = 0;

/** The last `state.json` revision seen per reader and session directory. */
const lastStateRevision = new Map<string, number>();

/**
 * Drop the cached revision files of one session directory when `state.json`'s revision went
 * down since the last read: the session restarted its count (a corrupt state file starts at
 * 0), so its next rN files replace old ones. Needed for readers with a constant stamp (no
 * mtime over the file API or the channel); harmless for the disk.
 */
function invalidateRevisions(reader: SessionReader, revisionsDirectory: string, stateRevision: number): void {
	const prefix = `${reader.name}:${revisionsDirectory}/`;
	const last = lastStateRevision.get(prefix);
	lastStateRevision.set(prefix, stateRevision);
	if (last === undefined || stateRevision >= last) return;
	for (const [key, entry] of [...revisionCache.entries()]) {
		if (!key.startsWith(prefix)) continue;
		revisionCache.delete(key);
		revisionCacheBytes -= entry.size;
	}
}

function evictRevision(): void {
	const [path, entry] = revisionCache.entries().next().value!;
	revisionCache.delete(path);
	revisionCacheBytes -= entry.size;
}

async function readCached(reader: SessionReader, path: string, kind: "json" | "md", warnings: string[]): Promise<unknown> {
	let stamp: string | undefined;
	try {
		stamp = await reader.stamp(path);
	} catch (error) {
		warnings.push(`Could not read ${path}: ${describe(error)}`);
		return undefined;
	}
	if (stamp === undefined) return undefined;
	const key = `${reader.name}:${path}`;
	const cached = revisionCache.get(key);
	if (cached && cached.stamp === stamp) return cached.value;
	const text = await readText(reader, path, warnings);
	if (text === undefined) return undefined;
	const value = kind === "json" ? parseJson(text, path, warnings) : text;
	if (value !== undefined) {
		if (cached) {
			revisionCache.delete(key);
			revisionCacheBytes -= cached.size;
		}
		while (revisionCache.size > 0 && (revisionCache.size >= REVISION_CACHE_LIMIT || revisionCacheBytes + text.length > REVISION_CACHE_BYTES)) evictRevision();
		revisionCache.set(key, { stamp, size: text.length, value });
		revisionCacheBytes += text.length;
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

async function readText(reader: SessionReader, path: string, warnings: string[]): Promise<string | undefined> {
	try {
		return await reader.readText(path);
	} catch (error) {
		warnings.push(`Could not read ${path}: ${describe(error)}`);
		return undefined;
	}
}

function parseJson(text: string, path: string, warnings: string[]): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		warnings.push(`${path} is not valid JSON: ${describe(error)}`);
		return undefined;
	}
}

async function readJson(reader: SessionReader, path: string, warnings: string[]): Promise<unknown> {
	const text = await readText(reader, path, warnings);
	return text === undefined ? undefined : parseJson(text, path, warnings);
}

/** Reads the session directory of `sessionID` under `mirrorDir`. */
export function readSessionFiles(mirrorDir: string, sessionID: string): Promise<SessionFiles> {
	return readSessionDirectory(sessionDirectory(mirrorDir, sessionID), sessionID);
}

/** Reads a session directory given its path. Never throws for missing or corrupt files. */
export async function readSessionDirectory(directory: string, sessionID: string, reader: SessionReader = localReader): Promise<SessionFiles> {
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
		files.found = await reader.isDirectory(directory);
	} catch (error) {
		warnings.push(`Could not read ${directory}: ${describe(error)}`);
	}
	if (!files.found) return files;

	const [eventsText, state, snapshot, annotationsText] = await Promise.all([
		readText(reader, join(directory, EVENTS_FILE), warnings),
		readJson(reader, join(directory, STATE_FILE), warnings),
		readJson(reader, join(directory, SNAPSHOT_FILE), warnings),
		readText(reader, join(directory, ANNOTATIONS_FILE), warnings),
	]);
	if (annotationsText !== undefined) files.annotations = countAnnotations(annotationsText);
	if (eventsText !== undefined) {
		const parsed = parseEvents(eventsText);
		files.events = parsed.events;
		files.skippedEventLines = parsed.skipped;
	}
	if (state !== undefined) files.state = state;
	if (snapshot !== undefined) files.snapshot = snapshot;

	const revisionsDirectory = join(directory, REVISIONS_DIRECTORY);
	const stateRevision = (state as { revision?: unknown } | undefined)?.revision;
	if (typeof stateRevision === "number" && Number.isInteger(stateRevision)) invalidateRevisions(reader, revisionsDirectory, stateRevision);
	let names: string[] = [];
	try {
		names = await reader.list(revisionsDirectory);
	} catch (error) {
		warnings.push(`Could not list ${revisionsDirectory}: ${describe(error)}`);
	}
	const jsonRevisions = new Set<number>();
	const mdRevisions = new Set<number>();
	for (const name of names) {
		const match = /^r(\d+)\.(json|md)$/.exec(name);
		if (match) (match[2] === "json" ? jsonRevisions : mdRevisions).add(Number(match[1]));
	}
	await Promise.all([...jsonRevisions].map(async (revision) => {
		const value = await readCached(reader, join(revisionsDirectory, `r${revision}.json`), "json", warnings);
		if (value !== undefined) files.revisions.set(revision, value);
	}));
	// rN.md is only shown when rN.json is missing or invalid.
	await Promise.all([...mdRevisions].filter((revision) => !isRevisionFile(files.revisions.get(revision))).map(async (revision) => {
		const text = await readCached(reader, join(revisionsDirectory, `r${revision}.md`), "md", warnings);
		if (typeof text === "string") files.revisionTexts.set(revision, text);
	}));
	return files;
}
