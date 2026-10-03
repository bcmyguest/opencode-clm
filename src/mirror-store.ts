// Adapted from pi-clm src/mirror-store.ts (MIT, Copyright 2026 Emanuel Casco).

import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

const STALE_MIRROR_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** `${XDG_STATE_HOME || ~/.local/state}/opencode-clm/mirrors`, resolved at call time. */
export function defaultMirrorParent(): string {
	const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(stateHome, "opencode-clm", "mirrors");
}

/** The session directory under a mirror parent could not be created or was refused. */
export class MirrorDirectoryError extends Error {
	constructor(readonly parent: string, readonly cause: unknown) {
		super(`could not use ${parent}: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
}

export function safeSessionId(sessionId: string): string {
	const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
	return safe || "session";
}

async function exists(path: string): Promise<boolean> {
	return lstat(path).then(
		() => true,
		() => false,
	);
}

/** Newest mtime among a directory and the entries directly inside it. */
async function newestMtime(directory: string): Promise<number> {
	let newest = (await stat(directory)).mtimeMs;
	for (const name of await readdir(directory)) {
		const info = await lstat(join(directory, name)).catch(() => undefined);
		if (info && info.mtimeMs > newest) newest = info.mtimeMs;
	}
	return newest;
}

/**
 * Best-effort removal of mirror directories left behind by sessions that never reached
 * shutdown. Live sessions rewrite their mirror every turn, so a directory whose newest
 * mtime (the directory or any file directly inside it) is older than the threshold has
 * no owner. Failures are ignored: another process may remove or own an entry concurrently.
 */
async function sweepStaleMirrors(parentDirectory: string, keepDirectory: string, maxAgeMs: number): Promise<void> {
	let names: string[];
	try {
		names = await readdir(parentDirectory);
	} catch {
		return;
	}
	const cutoff = Date.now() - maxAgeMs;
	for (const name of names) {
		if (!name.startsWith("clm-")) continue;
		const directory = join(parentDirectory, name);
		if (directory === keepDirectory) continue;
		try {
			const info = await lstat(directory);
			if (!info.isDirectory() || (await newestMtime(directory)) >= cutoff) continue;
			await rm(directory, { recursive: true, force: true });
		} catch {
			// Ignored: sweeping is opportunistic hygiene only.
		}
	}
}

/** Refuse a session directory that is a symlink, not a directory, or owned by another user. */
async function assertPrivateDirectory(directory: string): Promise<void> {
	const info = await lstat(directory);
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw new Error(`Refusing mirror directory ${directory}: not a real directory.`);
	}
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid !== undefined && info.uid !== uid) {
		throw new Error(`Refusing mirror directory ${directory}: owned by uid ${info.uid}, not ${uid}.`);
	}
}

export class MirrorStore {
	readonly directory: string;
	readonly filePath: string;
	private disposed = false;

	private constructor(directory: string) {
		this.directory = directory;
		this.filePath = join(directory, "LIVE_CONTEXT.md");
	}

	/**
	 * One directory per session: `<parent>/clm-<session>/`. The name is deterministic so a
	 * resumed session finds its saved state; the parent gets a `.gitignore` of `*` if absent.
	 * The parent is chmod 0700 when the store creates it or when it is the default parent.
	 */
	static async create(
		sessionId: string,
		parentDirectory?: string,
		staleAgeMs = STALE_MIRROR_AGE_MS,
	): Promise<MirrorStore> {
		const parent = parentDirectory ?? defaultMirrorParent();
		const ownsParent = parentDirectory === undefined || !(await exists(parent));
		await mkdir(parent, { recursive: true, mode: 0o700 });
		if (ownsParent) await chmod(parent, 0o700);
		await writeFile(join(parent, ".gitignore"), "*\n", { flag: "wx" }).catch(() => undefined);
		const directory = join(parent, `clm-${safeSessionId(sessionId)}`);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await assertPrivateDirectory(directory);
		await chmod(directory, 0o700);
		await sweepStaleMirrors(parent, directory, staleAgeMs).catch(() => undefined);
		return new MirrorStore(directory);
	}

	/** Synchronous read for hooks that inspect the file right after a tool ran. */
	readSync(): string | undefined {
		if (this.disposed) return undefined;
		try {
			return readFileSync(this.filePath, "utf8");
		} catch {
			return undefined;
		}
	}

	async write(content: string): Promise<void> {
		if (this.disposed) throw new Error("Mirror store has been disposed.");
		const temporaryPath = join(this.directory, `.${basename(this.filePath)}.${randomUUID()}.tmp`);
		try {
			await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
			await rename(temporaryPath, this.filePath);
			await chmod(this.filePath, 0o600);
		} catch (error) {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	async read(): Promise<string | undefined> {
		if (this.disposed) return undefined;
		try {
			return await readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	/**
	 * Deletes the session directory, including the saved state a resumed session would
	 * read. Call only when the session itself is deleted, never on plain shutdown.
	 */
	async cleanup(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await rm(this.directory, { recursive: true, force: true });
	}
}
