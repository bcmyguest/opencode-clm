// Where the TUI reads a session's CLM files from. Local disk first (the TUI and the server
// share a file system); otherwise the server's own copy through OpenCode's file API
// (`GET /file`, `GET /file/content`), which serves paths inside the server's instance
// directory only. A session directory outside it cannot be read from an attached TUI.
// Written for this package. Verified against opencode 1.18.34: `GET /file/content`
// server/routes/instance/httpapi/handlers/file.ts:96-124 (missing file → empty text, text
// trimmed, path must stay inside the instance directory); `GET /file` file.ts:66-92 and
// packages/core/src/filesystem.ts:66-99 (a missing directory fails).

import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { OVERRIDES_FILE, parseOverridesText, readOverrides, type OverridesRead } from "../overrides.ts";
import { localReader, type SessionReader } from "../session-files.ts";

/** The part of the TUI api's SDK client (`api.client.file`) this uses. */
export interface FileApi {
	read(parameters: { path: string }): Promise<{ data?: unknown; error?: unknown }>;
	list(parameters: { path: string }): Promise<{ data?: unknown; error?: unknown }>;
}

export type SessionSource =
	| { kind: "local"; directory: string; reader: SessionReader }
	/** Read through the server; `root` is the server's instance directory. */
	| { kind: "remote"; directory: string; root: string; reader: SessionReader }
	/** On the server, outside its instance directory: the server plugin reads it and answers over the channel. */
	| { kind: "channel"; directory: string; root: string; reader: SessionReader }
	/** Outside the server directory and no server plugin answering: unreadable from here. */
	| { kind: "outside"; directory: string; root: string };

/** `path` relative to `root`, or undefined when it lies outside. */
export function insideRoot(root: string, path: string): string | undefined {
	const rel = relative(root, path);
	if (rel === "") return ".";
	if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
	return rel;
}

function failure(error: unknown, path: string): Error {
	if (error instanceof Error) return error;
	const message = error && typeof error === "object" && "data" in error
		? JSON.stringify((error as { data?: unknown }).data)
		: JSON.stringify(error);
	return new Error(`server file API refused ${path}: ${message}`);
}

/**
 * A reader over the server's file API. `GET /file/content` answers a missing file with
 * empty text and trims what it returns (whitespace only matters at the ends of the JSON and
 * JSONL files read here); `GET /file` fails for a missing directory.
 */
export function remoteReader(file: FileApi, root: string): SessionReader {
	const rel = (path: string): string => {
		const inside = insideRoot(root, path);
		if (inside === undefined) throw new Error(`${path} lies outside the server directory ${root}`);
		return inside;
	};
	const list = async (path: string): Promise<string[] | undefined> => {
		const result = await file.list({ path: rel(path) });
		if (result.error !== undefined || !Array.isArray(result.data)) return undefined;
		return result.data.flatMap((item) => (item && typeof (item as { name?: unknown }).name === "string" ? [(item as { name: string }).name] : []));
	};
	return {
		name: `remote:${root}`,
		async isDirectory(path) {
			return (await list(path)) !== undefined;
		},
		async readText(path) {
			const result = await file.read({ path: rel(path) });
			if (result.error !== undefined) throw failure(result.error, path);
			const data = result.data as { type?: unknown; content?: unknown } | undefined;
			if (data?.type !== "text" || typeof data.content !== "string" || data.content === "") return undefined;
			return data.content;
		},
		async list(path) {
			return (await list(path)) ?? [];
		},
		// No mtimes over the API; revisions/rN files are written once, so a fixed stamp is safe.
		async stamp() {
			return "remote";
		},
	};
}

/** Asks the server plugin (src/channel.ts) for one operation on this session; throws on refusal. */
export type ChannelAsk = (operation: { op: "read"; path: string } | { op: "list"; path: string }) => Promise<{ content?: string; names?: string[] }>;

/**
 * A reader that asks the server plugin over the channel: for a session directory the file
 * API cannot reach (outside the server's instance directory). Paths go relative to the
 * session directory; the server refuses anything outside it.
 */
export function channelReader(ask: ChannelAsk, directory: string): SessionReader {
	const rel = (path: string): string => {
		const inside = insideRoot(directory, path);
		if (inside === undefined) throw new Error(`${path} lies outside the session directory ${directory}`);
		return inside === "." ? "" : inside;
	};
	const list = async (path: string) => (await ask({ op: "list", path: rel(path) })).names;
	return {
		name: `channel:${directory}`,
		async isDirectory(path) {
			return (await list(path)) !== undefined;
		},
		async readText(path) {
			return (await ask({ op: "read", path: rel(path) })).content;
		},
		async list(path) {
			return (await list(path)) ?? [];
		},
		async stamp() {
			return "channel";
		},
	};
}

export interface SourceDeps {
	/** The session directory as this TUI resolves it (its own settings and environment). */
	ownDirectory: string;
	/** The server's instance directory (`api.state.path.directory`). */
	serverRoot: string;
	file: FileApi;
	/** The server's answer to `locate`, if it gave one. */
	locate(): Promise<{ directory: string; root: string } | undefined>;
	/**
	 * A fresh cached `locate` answer, without asking. With `relocate`, a TUI that shares the
	 * server's disk skips the wait: see `resolveSource`.
	 */
	located?(): { directory: string; root: string } | undefined;
	/** Starts a `locate` in the background (its answer serves the next resolve). */
	relocate?(): void;
	/** The server plugin, for a located directory outside the server root. */
	ask?: ChannelAsk;
	/** Local check; defaults to the disk. */
	isLocalDirectory?(path: string): Promise<boolean>;
}

/**
 * Local when this TUI's own session directory exists on its disk. Otherwise the server says
 * where the directory is (`locate`), falling back to this TUI's resolution. Inside the
 * server directory it is read through the file API; outside it, through the server plugin
 * over the channel (only when `locate` answered, i.e. the plugin is there).
 */
export async function resolveSource(deps: SourceDeps, options: { write?: boolean } = {}): Promise<SessionSource> {
	const isLocal = deps.isLocalDirectory ?? ((path: string) => localReader.isDirectory(path).catch(() => false));
	if (await isLocal(deps.ownDirectory)) return { kind: "local", directory: deps.ownDirectory, reader: localReader };
	const sameDisk = async () => (await isLocal(dirname(deps.ownDirectory))) && (await isLocal(deps.serverRoot));
	// A write creates the directory it writes to, and the server must read it: no guessing.
	// Locally only when the server names this TUI's own directory, or does not answer (CLM
	// disabled there) on the server's own disk; otherwise wherever the server keeps the files.
	if (options.write) {
		const answer = await deps.locate().catch(() => undefined);
		if ((answer === undefined || answer.directory === deps.ownDirectory) && (await sameDisk())) {
			return { kind: "local", directory: deps.ownDirectory, reader: localReader };
		}
		return placed(deps, answer);
	}
	// Same disk as the server (its directory and this TUI's mirror parent both exist here), and
	// no answer cached yet: most likely a session before its first request, or a server with
	// CLM disabled. Read the (empty) local directory now instead of waiting for `locate`,
	// which runs in the background and corrects the source on the next load if the server
	// keeps the files elsewhere.
	if (deps.relocate && !deps.located?.() && (await sameDisk())) {
		deps.relocate();
		return { kind: "local", directory: deps.ownDirectory, reader: localReader };
	}
	return placed(deps, await deps.locate().catch(() => undefined));
}

/** The source for the server's answer to `locate` (or this TUI's own path without one). */
function placed(deps: SourceDeps, located: { directory: string; root: string } | undefined): SessionSource {
	const directory = located?.directory ?? deps.ownDirectory;
	const root = located?.root ?? deps.serverRoot;
	if (insideRoot(root, directory) === undefined) {
		if (located && deps.ask) return { kind: "channel", directory, root, reader: channelReader(deps.ask, directory) };
		return { kind: "outside", directory, root };
	}
	return { kind: "remote", directory, root, reader: remoteReader(deps.file, root) };
}

/** overrides.json of a source. */
export async function sourceOverrides(source: SessionSource): Promise<OverridesRead> {
	if (source.kind === "local") return readOverrides(source.directory);
	if (source.kind === "outside") return { overrides: {} };
	const path = join(source.directory, OVERRIDES_FILE);
	let text: string | undefined;
	try {
		text = await source.reader.readText(path);
	} catch (error) {
		return { overrides: {}, warning: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
	return text === undefined ? { overrides: {} } : parseOverridesText(text, path);
}

/** Panel text for a session directory the attached TUI cannot read. */
export function outsideMessage(source: { directory: string; root: string }): string {
	return `The CLM files of this session would be at ${source.directory} on the server, outside the server's directory ${source.root}. ` +
		"OpenCode's file API reads only inside that directory, and the opencode-clm server plugin did not answer to read them instead. " +
		"Check that the server loads opencode-clm at this version, or set mirrorDir inside the project (the default .opencode/clm is).";
}
