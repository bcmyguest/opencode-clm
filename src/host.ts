/**
 * What both plugin entry points share: the session registry with its mirror fallbacks, fork
 * stamps and persisted annotations in OpenCode's session metadata, and the `/clm` and
 * `/clm-compact` command texts. index.ts wires it to OpenCode 1's hooks (`server`) and
 * src/v2.ts to OpenCode 2's (`setup`); each passes the host calls it has (toasts, logs,
 * session records), so nothing here depends on either plugin API.
 */
import { rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";

import { formatTokens } from "./budget.ts";
import { ClmSession } from "./clm.ts";
import { buildCompactPrompt, loadCompactPrompt } from "./compact.ts";
import { ANNOTATIONS_FILE, persistAnnotations, restorePersisted } from "./continuity.ts";
import { copyPrivateFile, MirrorDirectoryError, privateTemporaryParent } from "./mirror-store.ts";
import { changeSetting, OVERRIDES_FILE, resetSettings, showSetting } from "./overrides.ts";
import { parseClmCommand, type Page } from "./panel/command.ts";
import { buildPanelModel } from "./panel/model.ts";
import { panelPageText } from "./panel/text.ts";
import { statusText } from "./presentation.ts";
import { readSessionDirectory, sessionDirectory } from "./session-files.ts";
import { defaultMirrorDir, type ClmSettings } from "./settings.ts";
import { settingsText } from "./settings-table.ts";
import { STATE_FILE } from "./state.ts";
import type { SteeringDocument } from "./steering.ts";
import { fallbackBudget, settingsView } from "./tui/data.ts";

export type ToastVariant = "info" | "success" | "warning" | "error";

export const STATUS_USAGE = "Usage: /clm [overview | input | edits | settings | status | path | on | off | reset | budget [value] | config [setting [value] | reset]]";
/** A pending `/clm-compact` older than this no longer refuses a new one (its prompt may have failed to send). */
export const COMPACT_PENDING_MS = 5 * 60_000;

export function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Session ids name a directory (`<mirrorDir>/clm-<id>`). A separator or `..` would reach
 * outside it, so such ids are refused before anything touches the file system.
 */
export function checkSessionID(sessionID: unknown): string {
	if (typeof sessionID !== "string" || sessionID === "" || /[/\\]/.test(sessionID) || sessionID.includes("..")) {
		throw new Error(`CLM refuses session id ${JSON.stringify(sessionID)}: it must not contain "/", "\\" or "..".`);
	}
	return sessionID;
}

/** The text the model receives in place of the `/clm` template. */
export function relay(text: string): string {
	return `${text}\n\nShow the CLM text above to the user exactly as written. Do not edit the mirror or run tools.`;
}

/** OpenCode's record of a session, as far as CLM reads it. */
export interface SessionRecord {
	/** `metadata`, a free record (empty object when absent). */
	metadata: Record<string, unknown>;
	/** A child (subagent) session. */
	child: boolean;
	created?: number;
	/** The session this one was forked from, when the host records it (OpenCode 2 `fork.sessionID`). */
	forkOf?: string;
}

export interface HostDeps {
	settings: ClmSettings;
	steering?: SteeringDocument;
	/** The project directory (default mirror parent, `/clm config` paths). */
	directory: string;
	toast(message: string, variant?: ToastVariant): void;
	log(level: "info" | "warn" | "error", message: string): void;
	/** The session's record; undefined when the host cannot read it. A throw is logged as `stamp-error`. */
	record?(sessionID: string): Promise<SessionRecord | undefined>;
	/** Replaces the session's metadata. A throw is logged. */
	updateMetadata?(sessionID: string, metadata: Record<string, unknown>): Promise<void>;
}

/** What `/clm-compact` measures before it asks the model to compact. */
export interface CompactMeasure {
	/** Context size now, in tokens; undefined when the context is empty. */
	current: number | undefined;
	/** The session is running (the size misses the rest of the current turn). */
	busy: boolean;
}

export type ClmHost = ReturnType<typeof createHost>;

export function createHost(deps: HostDeps) {
	const { settings, steering, toast, log } = deps;
	const sessions = new Map<string, Promise<ClmSession>>();

	/** Read-modify-write of a session's metadata runs one at a time per session. */
	const metadataChains = new Map<string, Promise<unknown>>();
	const inMetadataChain = <T>(sessionID: string, task: () => Promise<T>): Promise<T> => {
		const run = (metadataChains.get(sessionID) ?? Promise.resolve()).then(task, task);
		const tail = run.catch(() => undefined);
		metadataChains.set(sessionID, tail);
		void tail.then(() => {
			if (metadataChains.get(sessionID) === tail) metadataChains.delete(sessionID);
		});
		return run;
	};

	const sessionRecord = async (clm: ClmSession): Promise<SessionRecord | undefined> => {
		if (!deps.record) return undefined;
		try {
			return await deps.record(clm.sessionID);
		} catch (error) {
			await clm.log({ event: "stamp-error", stage: "get", error: describe(error) });
			return undefined;
		}
	};

	/** `metadata.clm` of a session record, or an empty object. */
	const clmStamp = (metadata: Record<string, unknown>): Record<string, unknown> =>
		metadata.clm && typeof metadata.clm === "object" && !Array.isArray(metadata.clm) ? (metadata.clm as Record<string, unknown>) : {};

	/** Sessions whose stamp was handled in this process (`linkFork`). */
	const linked = new Set<string>();

	/**
	 * Fork detection. The plugin stamps `metadata.clm.origin = <own id>` on every session it
	 * opens; a fork copies the metadata, so a stamp naming another session marks a fork of
	 * it. A host that records forks itself (`forkOf`) names the origin directly. A fresh fork
	 * restores the origin's newest matching revision on its first request (clm.ts
	 * `restoreFromFork`); the stamp is then rewritten to the fork's id. The metadata update
	 * replaces the whole record, so the other keys are copied.
	 */
	const linkFork = (clm: ClmSession): Promise<void> => inMetadataChain(clm.sessionID, async () => {
		const record = await sessionRecord(clm);
		// Child (subagent) sessions are never forked: no stamp, no update bumping their time.
		if (!record || record.child) return;
		const metadata = record.metadata;
		const stamp = clmStamp(metadata);
		const origin = record.forkOf ?? stamp.origin;
		// `annotations` is the store of a session without a mirror (M1). A session with a mirror
		// drops it, so a later run without one does not restore a stale set; a fork drops the
		// origin's copy and persists its own after its first request.
		const own = origin === clm.sessionID;
		const fork = typeof origin === "string" && !own;
		const dropAnnotations = "annotations" in stamp && (fork || clm.mirrorUnavailable === undefined);
		if (own && !dropAnnotations) return;
		if (!own && typeof origin === "string" && !clm.state.checkpoint && clm.state.revision === 0) {
			try {
				clm.forkOrigin = {
					sessionID: origin,
					directory: sessionDirectory(settings.mirrorDir, checkSessionID(origin)),
					...(record.created !== undefined ? { created: record.created } : {}),
				};
			} catch {
				// a foreign stamp that is not a usable session id: ignore it
			}
		}
		if (!deps.updateMetadata) return;
		try {
			const { annotations: _dropped, ...kept } = stamp;
			const next = { ...(dropAnnotations ? kept : stamp), origin: clm.sessionID };
			await deps.updateMetadata(clm.sessionID, { ...metadata, clm: next });
		} catch (error) {
			await clm.log({ event: "stamp-error", stage: "update", error: describe(error) });
		}
	});

	/** The project's default mirror parent, inside the project (no external-directory prompts). */
	const projectMirrorDir = defaultMirrorDir(deps.directory);

	/** Private parent for sessions without a usable mirror directory, made on first use (`openWithoutMirror`). */
	let unmirroredParent: Promise<string> | undefined;

	/**
	 * Opens a session in `mirrorDir`. Only a failure to create or use the session directory
	 * (`MirrorDirectoryError`) is handled here; any other error propagates as before.
	 * - An explicitly configured `mirrorDir` that fails: the session uses the project default
	 *   `.opencode/clm` instead, and a toast names both. Inside the project the model's tools
	 *   reach it without an `external_directory` permission prompt.
	 * - The default fails too: the session runs without a mirror (`openWithoutMirror`).
	 */
	const openSession = async (id: string): Promise<ClmSession> => {
		const failures: MirrorDirectoryError[] = [];
		try {
			return await ClmSession.open(id, settings, { steering });
		} catch (error) {
			if (!(error instanceof MirrorDirectoryError)) throw error;
			failures.push(error);
		}
		if (settings.mirrorDir !== projectMirrorDir) {
			try {
				const clm = await ClmSession.open(id, { ...settings, mirrorDir: projectMirrorDir }, { steering });
				const error = failures[0]!;
				const message = `could not use the configured mirrorDir ${settings.mirrorDir} (${describe(error.cause)}); the files of session ${id} are in ${clm.store.directory} instead.`;
				log("warn", message);
				toast(message, "warning");
				await clm.log({ event: "mirror-dir-fallback", configured: settings.mirrorDir, used: projectMirrorDir, reason: describe(error.cause) });
				return clm;
			} catch (error) {
				if (!(error instanceof MirrorDirectoryError)) throw error;
				failures.push(error);
			}
		}
		return await openWithoutMirror(id, failures);
	};

	/**
	 * pi-clm's degraded mode (src/index.ts `replaceStore` and the `context` handler's `!store`
	 * branch): no mirror, no protocol prompt, no edits; requests carry the raw history plus the
	 * continuity annotations and their size notice. The session's files go to a private
	 * directory under the OS temp directory, made once per process and removed at exit. The
	 * model is never pointed there, so no `external_directory` prompt arises. state.json,
	 * overrides.json and annotations.jsonl still readable in a failed session directory (ours,
	 * not a symlink) are copied in before the session loads them; changes stay in the copy.
	 * When even that fails, the open fails: raw history, one "not active" toast naming every
	 * reason.
	 */
	const openWithoutMirror = async (id: string, failures: MirrorDirectoryError[]): Promise<ClmSession> => {
		const reason = failures.map((failure) => `${failure.parent}: ${describe(failure.cause)}`).join("; ");
		const copied: string[] = [];
		let copiedFrom: string | undefined;
		let clm: ClmSession;
		try {
			if (!unmirroredParent) {
				unmirroredParent = privateTemporaryParent().then((parent) => {
					process.once("exit", () => rmSync(parent, { recursive: true, force: true }));
					return parent;
				});
				unmirroredParent.catch(() => (unmirroredParent = undefined));
			}
			const parent = await unmirroredParent;
			const directory = sessionDirectory(parent, id);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			for (const name of [STATE_FILE, OVERRIDES_FILE, ANNOTATIONS_FILE]) {
				for (const failure of failures) {
					const from = sessionDirectory(failure.parent, id);
					if (await copyPrivateFile(from, directory, name)) {
						copied.push(name);
						copiedFrom ??= from;
						break;
					}
				}
			}
			clm = await ClmSession.open(id, { ...settings, mirrorDir: parent }, { steering });
		} catch (error) {
			throw new Error(`no mirror directory could be used (${reason}), and no temporary directory either: ${describe(error)}`);
		}
		clm.mirrorUnavailable = reason;
		await restoreAnnotations(clm);
		const kept = copiedFrom ? `${copied.join(", ")} copied from ${copiedFrom}; changes stay` : "No saved session files found; the session's files are";
		const message = `CLM editing not active for session ${id}: no mirror directory could be used (${reason}). Requests carry the raw history plus the continuity annotations and their size notice. ${kept} in ${clm.store.directory} for this server process only.`;
		log("error", message);
		toast(message, "error");
		await clm.log({ event: "mirror-unavailable", reason, directory: clm.store.directory, ...(copiedFrom ? { copiedFrom, copied } : {}) });
		return clm;
	};

	/**
	 * M1: a session without a mirror keeps its files in a per-process temp directory, so its
	 * annotations (resolutions made while degraded, and the snapshots copied in) would be lost
	 * at restart; pi keeps them in session entries. They go to OpenCode's session metadata
	 * (`metadata.clm.annotations`, bounded by PERSISTED_ANNOTATIONS_BYTES) after each change
	 * and are restored when the session opens without a mirror again.
	 */
	const restoreAnnotations = async (clm: ClmSession): Promise<void> => {
		const record = await inMetadataChain(clm.sessionID, () => sessionRecord(clm));
		const stamp = record ? clmStamp(record.metadata) : {};
		const persisted = stamp.annotations;
		if (persisted === undefined) return;
		// A fork's metadata is the origin's clone: the fork's first request applies the
		// fork-point cutoff to that set (clm.ts `copyForkAnnotations`) instead.
		const origin = record!.forkOf ?? stamp.origin;
		if (typeof origin === "string" && origin !== clm.sessionID && !record!.child) {
			clm.forkPersisted = restorePersisted([], persisted);
			return;
		}
		try {
			const snapshots = restorePersisted(await clm.annotations.list(), persisted);
			await clm.annotations.appendAll(snapshots);
			if (snapshots.length > 0) await clm.log({ event: "annotations-restored", count: snapshots.length });
		} catch (error) {
			await clm.log({ event: "annotations-restore-error", error: describe(error) });
		}
	};
	const persistAnnotationsOf = async (sessionID: string): Promise<void> => {
		const clm = await opened(sessionID);
		if (!clm || clm.mirrorUnavailable === undefined) return;
		await inMetadataChain(sessionID, () => persistNow(clm));
	};
	const persistNow = async (clm: ClmSession): Promise<void> => {
		const record = await sessionRecord(clm);
		if (!record || !deps.updateMetadata) return;
		try {
			const annotations = persistAnnotations(await clm.annotations.list());
			const metadata = { ...record.metadata, clm: { ...clmStamp(record.metadata), annotations } };
			await deps.updateMetadata(clm.sessionID, metadata);
			await clm.log({ event: "annotations-persisted", count: annotations.annotations.length, resolved: annotations.resolved.length });
		} catch (error) {
			await clm.log({ event: "annotations-persist-error", error: describe(error) });
		}
	};

	const session = (sessionID: string): Promise<ClmSession> => {
		const id = checkSessionID(sessionID);
		let existing = sessions.get(id);
		if (!existing) {
			existing = openSession(id).then(async (clm) => {
				if (clm.loadWarning) toast(`state reset for ${id}: ${clm.loadWarning}`, "warning");
				return clm;
			});
			existing.catch(() => sessions.delete(id));
			sessions.set(id, existing);
		}
		return existing;
	};
	/** An already open session, without opening one. */
	const opened = async (sessionID: string): Promise<ClmSession | undefined> => {
		try {
			return await sessions.get(sessionID);
		} catch {
			return undefined;
		}
	};

	/** One setting through `changeSetting`, activated at once; returns `Label: value`. */
	async function setSetting(clm: ClmSession, name: string, value: string): Promise<string> {
		const result = await changeSetting(clm.changeRequest(deps.directory), name, value);
		await clm.refreshSettings(true);
		return result.text;
	}

	async function clearSettings(clm: ClmSession): Promise<void> {
		await resetSettings(clm.store.directory);
		await clm.refreshSettings(true);
		toast("CLM settings reset to the defaults.");
	}

	async function dropRevision(clm: ClmSession): Promise<void> {
		await clm.resetProjection("/clm reset");
		toast("CLM revision dropped");
	}

	/**
	 * `/clm config …` as text (pi-clm's `/clm config` semantics; the TUI opens the settings
	 * page instead). `words` keep their case: values may be paths.
	 */
	async function configCommand(clm: ClmSession, words: string[]): Promise<string> {
		const [name, ...valueWords] = words;
		const { base, effective } = clm.settingsValues();
		const format = { modelWindow: clm.limits.context, modelOutput: clm.limits.output };
		if (!name) return settingsText(base, effective, format, clm.settingsWarning);
		if (name.toLowerCase() === "reset" && valueWords.length === 0) {
			await clearSettings(clm);
			return "CLM settings reset to the defaults for this session.";
		}
		if (valueWords.length === 0) return showSetting(name, effective, format);
		const text = await setSetting(clm, name, valueWords.join(" "));
		toast(`CLM ${text}.`);
		return `CLM ${text}. It applies from the next request.`;
	}

	/** `/clm overview|input|edits|settings` outside the TUI: the panel page as plain text. */
	async function pageCommand(clm: ClmSession, page: Page): Promise<string> {
		const files = await readSessionDirectory(clm.store.directory, clm.sessionID);
		const budget = fallbackBudget(clm.settings, clm.limits);
		const model = buildPanelModel(files, budget ? { budget } : {});
		model.enabled = clm.enabled;
		if (clm.noticesOnly) model.noticesOnly = true;
		// No mirror: name why, never the temporary directory (the text reaches the model).
		if (clm.mirrorUnavailable !== undefined) {
			model.mirrorUnavailable = clm.mirrorUnavailable;
			model.mirrorPath = `unavailable (${clm.mirrorUnavailable})`;
		}
		const format = { ...(clm.limits.context ? { modelWindow: clm.limits.context } : {}), ...(clm.limits.output ? { modelOutput: clm.limits.output } : {}) };
		model.settings = settingsView(clm.settingsValues(), model, { format, ...(clm.settingsWarning ? { warning: clm.settingsWarning } : {}) });
		return panelPageText(model, page);
	}

	async function statusCommand(clm: ClmSession, args: string): Promise<string> {
		await clm.refreshSettings();
		const words = args.split(/\s+/).filter(Boolean);
		const argument = (words[0] ?? "").toLowerCase();
		if (argument === "config") return configCommand(clm, words.slice(1));
		// pi's shorthand: `/clm budget <value>` = `/clm config budget <value>`.
		if (argument === "budget") return configCommand(clm, ["budget", ...words.slice(1)]);
		const command = parseClmCommand(`/clm ${args}`);
		if (args !== "" && command?.kind === "open") return pageCommand(clm, command.page);
		if (words.length > 1) return `${STATUS_USAGE}\nUnknown argument: ${JSON.stringify(args)}`;
		switch (argument) {
			case "":
			case "status": {
				const text = statusText(clm.status());
				toast(text.split("\n").slice(0, 3).join("\n"));
				return text;
			}
			case "path":
				if (clm.mirrorUnavailable !== undefined) return `CLM mirror: unavailable (${clm.mirrorUnavailable})`;
				return clm.noticesOnly ? "CLM mirror: not used (mode notices-only)" : `CLM mirror: ${clm.mirrorPath}`;
			case "on":
			case "off": {
				// The same override the TUI and `/clm config editing` write.
				await setSetting(clm, "editing", argument);
				toast(`CLM ${argument} for this session`);
				if (clm.mirrorUnavailable !== undefined) {
					return argument === "on"
						? "CLM is on for this session. No mirror is available: requests carry the raw history plus the continuity annotations."
						: "CLM is off for this session: requests carry the raw history.";
				}
				if (clm.noticesOnly) {
					return argument === "on"
						? "CLM is on for this session in notices-only mode: requests carry the raw history plus the budget notices; the model cannot edit its context."
						: "CLM is off for this session: requests carry the raw history and no notices.";
				}
				return argument === "on"
					? "CLM is on for this session: the mirror is refreshed before the next request."
					: "CLM is off for this session: requests carry the raw history and the mirror is no longer read.";
			}
			case "reset": {
				await dropRevision(clm);
				return "CLM dropped the accepted revision: the next request carries the stored history, and the mirror is rewritten from it.";
			}
			default:
				return `${STATUS_USAGE}\nUnknown argument: ${JSON.stringify(args)}`;
		}
	}

	/**
	 * Sessions with a `/clm-compact` prompt the model has not received yet, and that prompt.
	 * pi refuses a second `/clm-compact` while one waits (`compactPending`, pi src/index.ts:235,
	 * 997-1000): set when the command is accepted (:1008), cleared once its prompt is sent
	 * (:1046). OpenCode sends the prompt itself, into the running loop or a new one, so here
	 * pending ends at the first model request whose history holds the prompt, or when the
	 * session goes idle or fails without one. If the prompt never reaches a request, an entry
	 * older than COMPACT_PENDING_MS no longer refuses.
	 */
	const compactPending = new Map<string, { prompt?: string; at: number }>();

	/**
	 * `/clm-compact [instructions]`: the compaction prompt, with the size of the context as
	 * it would be sent now (`measure`). pi's checks (pi src/index.ts compactCommand): CLM off
	 * and an empty context are refused with a toast; the result is then `{ refused }` text for
	 * the host to show instead of the prompt. A second invocation before the model received
	 * the first prompt is refused like pi's (`compactPending`).
	 */
	async function compactCommand(
		clm: ClmSession,
		sessionID: string,
		argument: string,
		measure: () => Promise<CompactMeasure>,
	): Promise<{ prompt: string } | { refused: string }> {
		if (clm.mirrorUnavailable !== undefined) {
			// pi-clm's compactCommand: nothing for the model to edit, so nothing is asked of it.
			toast(`The context mirror is unavailable, so the model cannot edit its context (${clm.mirrorUnavailable}).`, "warning");
			return { refused: "[CLM] The context mirror is unavailable, so the model cannot edit its context." };
		}
		await clm.refreshSettings();
		if (clm.noticesOnly) {
			// The compaction prompt asks for a mirror edit; notices-only has no mirror.
			const message = "CLM runs in notices-only mode for this session, so the model cannot edit its context. Switch with /clm config mode edit.";
			toast(message, "warning");
			return { refused: `[CLM] ${message}` };
		}
		const waiting = compactPending.get(sessionID);
		if (waiting && Date.now() - waiting.at < COMPACT_PENDING_MS) {
			const message = "A /clm-compact is already queued and the model has not received it yet.";
			toast(message, "info");
			return { refused: `[CLM] ${message}` };
		}
		// Reserved before the first await, so a second invocation in the meantime is refused.
		const entry: { prompt?: string; at: number } = { at: Date.now() };
		compactPending.set(sessionID, entry);
		const refuse = (message: string) => {
			if (compactPending.get(sessionID) === entry) compactPending.delete(sessionID);
			toast(message, "warning");
			return { refused: `[CLM] ${message}` };
		};
		try {
			await clm.refreshSettings();
			const template = loadCompactPrompt(clm.settings.compactPromptPath);
			if (!clm.enabled) {
				return refuse("CLM is off for this session, so there is no editable context to compact. Turn it on with /clm on.");
			}
			const { current, busy } = await measure();
			if (current === undefined) return refuse("Nothing to compact yet: the context is empty.");
			toast(`Asked the model to compact its context (now about ${formatTokens(current)} tokens` +
				`${busy ? ", measured before the current run finishes" : ""}).`);
			const prompt = buildCompactPrompt(template, {
				mirror: clm.mirrorPath,
				current,
				budget: clm.resolvedBudget()?.budget,
				instructions: argument,
			});
			entry.prompt = prompt;
			entry.at = Date.now();
			return { prompt };
		} catch (error) {
			if (compactPending.get(sessionID) === entry) compactPending.delete(sessionID);
			throw error;
		}
	}

	return {
		sessions,
		session,
		opened,
		linked,
		linkFork,
		persistAnnotationsOf,
		setSetting,
		clearSettings,
		dropRevision,
		statusCommand,
		compactCommand,
		compactPending,
	};
}
