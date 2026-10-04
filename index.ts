/**
 * opencode-clm: Context Language Model mode for OpenCode.
 *
 * Before every model request the plugin writes the model-visible conversation to a mirror
 * file. The model may rewrite that file with its ordinary tools, and what it leaves there
 * is what it is sent on the following request. OpenCode's stored history is never
 * rewritten: the edit is applied in `experimental.chat.messages.transform`, which OpenCode
 * calls before every LLM request.
 *
 * Port of pi-clm (https://github.com/lolipopshock/pi-clm, MIT, Copyright 2026 Emanuel
 * Casco), whose src/index.ts registers the Pi equivalents of these hooks.
 *
 * Hook behaviour, checked against the opencode 1.18.34 bundle:
 * - `experimental.chat.messages.transform` gets `{}` as input; the session id comes from
 *   `messages[0].info.sessionID`, and OpenCode keeps its own reference to the array, so the
 *   result is written into it in place. The main loop calls it before
 *   `experimental.chat.system.transform` for the same request, so system-prompt sizes and
 *   model limits reach the session one request late.
 * - `experimental.session.compacting` runs right before the compaction's own
 *   `messages.transform` over a clone of the history's head slice; its `output.context`
 *   strings are appended to the compaction prompt.
 * - A finished compaction is signalled by `experimental.compaction.autocontinue` (auto
 *   compaction, before the synthetic "continue" turn) and by the `session.compacted` bus
 *   event (every successful compaction). Either one marks the session for a rebase.
 * - `experimental.chat.system.transform` also runs for OpenCode's helper agents (title,
 *   summary, compaction); those get no protocol text.
 * - `tool.definition` carries no session id; it runs per tool each time OpenCode builds the
 *   tool set, before the request's `messages.transform`.
 */
import { rmSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { tool, type Hooks, type Plugin, type PluginInput, type PluginOptions } from "@opencode-ai/plugin";

import { formatTokens } from "./src/budget.ts";
import { ClmSession } from "./src/clm.ts";
import { copyPrivateFile, MirrorDirectoryError, privateTemporaryParent } from "./src/mirror-store.ts";
import {
	applyCompactionMode,
	compactionAuto,
	lastFinishedStep,
	nativeCompactionText,
	oneToolText,
	openCodeMaxOutput,
	openCodeUsable,
	OPENCODE_OUTPUT_TOKEN_MAX,
	outputTokenMaxFlag,
	overflowNotCompactedText,
	thresholdCancelledNoticeText,
	thresholdCancelledText,
	thresholdPausedText,
	thresholdReachable,
	ThresholdWatch,
	ToolCallCounter,
} from "./src/compaction.ts";
import { buildCompactPrompt, loadCompactPrompt } from "./src/compact.ts";
import { ANNOTATIONS_FILE, continuityTools, persistAnnotations, restorePersisted } from "./src/continuity.ts";
import { filterCompacted, replaceInPlace, type OcMessage } from "./src/opencode.ts";
import { statusText, systemGuidance } from "./src/presentation.ts";
import { COMPACT_COMMAND, COMPACT_TEMPLATE, STATUS_COMMAND, STATUS_TEMPLATE } from "./src/commands.ts";
import { changeSetting, OVERRIDES_FILE, resetSettings, showSetting } from "./src/overrides.ts";
import { STATE_FILE } from "./src/state.ts";
import { CHANNEL_VERSION, commandOf, decodeRequest, encodeReply, MAX_READ_BYTES, type ChannelReply, type ChannelRequest } from "./src/channel.ts";
import { settingsText } from "./src/settings-table.ts";
import { parseClmCommand, type Page } from "./src/panel/command.ts";
import { buildPanelModel } from "./src/panel/model.ts";
import { panelPageText } from "./src/panel/text.ts";
import { readSessionDirectory, sessionDirectory } from "./src/session-files.ts";
import { fallbackBudget, settingsView } from "./src/tui/data.ts";
import { defaultMirrorDir, resolveSettings, SKILLS_DIR, type ClmSettings } from "./src/settings.ts";
import { loadSteeringDocument, steeringPromptSection, type SteeringDocument } from "./src/steering.ts";

export const PLUGIN_ID = "opencode-clm";
export { COMPACT_COMMAND, STATUS_COMMAND } from "./src/commands.ts";

/** Opening words of the system prompts of OpenCode 1.18 helper agents (title, summary, compaction). */
const HELPER_PROMPTS = [
	"You are a title generator",
	"Summarize what was done in this conversation",
	"You are a context summarization agent",
];

const STATUS_USAGE = "Usage: /clm [overview | input | edits | settings | status | path | on | off | reset | budget [value] | config [setting [value] | reset]]";
/** A pending `/clm-compact` older than this no longer refuses a new one (its prompt may have failed to send). */
const COMPACT_PENDING_MS = 5 * 60_000;

type ToastVariant = "info" | "success" | "warning" | "error";

function describe(error: unknown): string {
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

/** ENOENT/ENOTDIR → undefined (missing); anything else rethrown. */
function missingAsUndefined(error: unknown): undefined {
	const code = (error as NodeJS.ErrnoException)?.code;
	if (code === "ENOENT" || code === "ENOTDIR") return undefined;
	throw error;
}

function isHelperPrompt(system: readonly string[]): boolean {
	const first = system[0]?.trimStart() ?? "";
	return HELPER_PROMPTS.some((prompt) => first.startsWith(prompt));
}

/** The text the model receives in place of the `/clm` template. */
function relay(text: string): string {
	return `${text}\n\nShow the CLM text above to the user exactly as written. Do not edit the mirror or run tools.`;
}

export const server: Plugin = async (input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
	const settings: ClmSettings = resolveSettings(options ?? {}, process.env, input.directory);
	if (!settings.enabled) return {};
	// Read once at load. A missing or empty steering file does not stop the plugin (OpenCode
	// would drop it silently, plugin/index.ts:230-241): sessions run protocol-only, each one
	// records the error in its settings warning (`/clm status`), and a toast says so.
	let steering: SteeringDocument | undefined;
	let steeringError: string | undefined;
	if (settings.steeringPath) {
		try {
			steering = loadSteeringDocument(settings.steeringPath);
		} catch (error) {
			steeringError = describe(error);
		}
	}

	const sessions = new Map<string, Promise<ClmSession>>();
	/** Estimated tokens per tool schema, from `tool.definition` (no session id there). */
	const toolSizes = new Map<string, number>();

	const toast = (message: string, variant: ToastVariant = "info") => {
		// The TUI shows it; `opencode run` and a bare server ignore it.
		void Promise.resolve()
			.then(() => input.client?.tui?.showToast?.({ body: { title: "CLM", message, variant } }))
			.catch(() => undefined);
	};

	/** Server log (`opencode` log file); best effort, never throws. */
	const log = (level: "info" | "warn" | "error", message: string) => {
		void Promise.resolve()
			.then(() => input.client?.app?.log?.({ body: { service: PLUGIN_ID, level, message } }))
			.catch(() => undefined);
	};
	/**
	 * The live config object from the `config` hook, and the user's own `compaction.auto`
	 * (undefined = not set) for the `compaction` setting. See src/compaction.ts.
	 */
	let liveConfig: { compaction?: { auto?: boolean; reserved?: number } } | undefined;
	let userAutoCompaction: boolean | undefined;
	/** Which requests ran with the flag turned off by the plugin, and crossings reported (K1, K5). */
	const thresholds = new ThresholdWatch();
	/** Whether the user's config had a `compaction` object; one the plugin added is removed again. */
	let userHadCompaction = false;
	/**
	 * The `compaction.auto` value each session's newest request decided (undefined = the user's
	 * value). Re-applied after each of the session's tool calls: a subagent (`task` tool) runs
	 * its own requests inside the parent's step and overwrites the instance-wide flag before
	 * OpenCode's finish-step check of the parent reads it (session/processor.ts:491).
	 */
	const flagDecisions = new Map<string, boolean | undefined>();
	const applyFlag = (value: boolean | undefined) => {
		if (!liveConfig) return;
		if (value !== undefined) {
			(liveConfig.compaction ??= {}).auto = value;
			return;
		}
		applyCompactionMode(liveConfig, "auto", userAutoCompaction);
		if (!userHadCompaction && liveConfig.compaction && Object.keys(liveConfig.compaction).length === 0) delete liveConfig.compaction;
	};
	const decideFlag = (sessionID: string, value: boolean | undefined) => {
		if (!liveConfig) return;
		// Re-inserted, so the map's order is the order of the newest decisions.
		flagDecisions.delete(sessionID);
		flagDecisions.set(sessionID, value);
		applyFlag(value);
	};
	/**
	 * A session went idle (`session.idle`, session/status.ts:41-44; e.g. a subagent finished,
	 * also when the parent's `task` call then threw, which skips `tool.execute.after`,
	 * session/tools.ts:111): its decision no longer governs anything, so
	 * the newest decision of another session takes the flag back. With no other session the
	 * flag stays: the idle session's own next prompt is checked against it first
	 * (prompt.ts:1161). Best effort: the event reaches the plugin through the bus and can
	 * arrive after the parent's finish-step check.
	 */
	const endFlag = (sessionID: string) => {
		if (!flagDecisions.delete(sessionID) || flagDecisions.size === 0) return;
		applyFlag([...flagDecisions.values()].at(-1));
	};
	/** A request that goes out without CLM (fail-open): the user's flag, no pause left behind. */
	const releaseFlag = (sessionID: string) => {
		decideFlag(sessionID, undefined);
		thresholds.set(sessionID, undefined);
	};
	/** OpenCode's threshold for the session's model (src/compaction.ts `openCodeUsable`). */
	const thresholdOf = (clm: ClmSession) => openCodeUsable(clm.limits, liveConfig?.compaction?.reserved, outputTokenMaxFlag());
	/** Sessions whose newest transform was OpenCode's compaction request (no overflow notice for it). */
	const compactionRequests = new Set<string>();
	/** Tool calls per session since its last model request (`one-tool`). */
	const toolCalls = new ToolCallCounter();

	if (steeringError) {
		const message = `steering document not loaded, sessions run without it: ${steeringError}`;
		log("error", message);
		toast(message, "error");
	}
	/** Command names this plugin defined; a user's own `clm` / `clm-compact` stays theirs. */
	const ownCommands = new Set<string>();

	/**
	 * OpenCode's record of a session: its metadata (`Session.Info.metadata`, a free record) and
	 * whether it is a child (subagent) session (`parentID`). Undefined when the client is
	 * unavailable; a failed call is logged as `stamp-error`. The v1 SDK's `Session` type omits
	 * `metadata`.
	 */
	const sessionRecord = async (clm: ClmSession): Promise<{ metadata: Record<string, unknown>; child: boolean; created?: number } | undefined> => {
		const get = input.client?.session?.get;
		if (typeof get !== "function") return undefined;
		try {
			const result = await input.client.session.get({ path: { id: clm.sessionID } });
			const failed = (result as { error?: unknown } | undefined)?.error;
			const data = (result as { data?: { metadata?: unknown; parentID?: unknown; time?: { created?: unknown } } } | undefined)?.data;
			if (failed !== undefined || !data) {
				await clm.log({ event: "stamp-error", stage: "get", error: JSON.stringify(failed ?? "no data") });
				return undefined;
			}
			const metadata = data.metadata;
			return {
				metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {},
				child: typeof data.parentID === "string" && data.parentID !== "",
				...(typeof data.time?.created === "number" ? { created: data.time.created } : {}),
			};
		} catch (error) {
			await clm.log({ event: "stamp-error", stage: "get", error: describe(error) });
			return undefined;
		}
	};
	/**
	 * Read-modify-write of a session's metadata, one at a time per session: `PATCH
	 * /session/:id` replaces the whole record, so concurrent writers (the fork stamp, two
	 * annotation changes in one step) must each build their body from the previous result.
	 */
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

	/** Sessions whose stamp was handled in this process (`linkFork`). */
	const linked = new Set<string>();

	/**
	 * Fork detection. The plugin stamps `metadata.clm.origin = <own id>` on every session it
	 * opens; `Session.fork` copies the metadata into the fork, so a stamp naming another session
	 * marks a fork of it. A fresh fork restores the origin's newest matching revision on its
	 * first request (clm.ts `restoreFromFork`); the stamp is then rewritten to the fork's id.
	 * `PATCH /session/:id` replaces the whole metadata record, so the other keys are copied.
	 */
	const linkFork = (clm: ClmSession): Promise<void> => inMetadataChain(clm.sessionID, async () => {
		const record = await sessionRecord(clm);
		// Child (subagent) sessions are never forked: no stamp, no PATCH bumping their time.
		if (!record || record.child) return;
		const metadata = record.metadata;
		const stamp = metadata.clm && typeof metadata.clm === "object" && !Array.isArray(metadata.clm) ? (metadata.clm as Record<string, unknown>) : {};
		const origin = stamp.origin;
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
		try {
			const { annotations: _dropped, ...kept } = stamp;
			const next = { ...(dropAnnotations ? kept : stamp), origin: clm.sessionID };
			const result = await input.client?.session?.update?.({ path: { id: clm.sessionID }, body: { metadata: { ...metadata, clm: next } } } as never);
			const error = (result as { error?: unknown } | undefined)?.error;
			if (error) await clm.log({ event: "stamp-error", stage: "update", error: JSON.stringify(error) });
		} catch (error) {
			await clm.log({ event: "stamp-error", stage: "update", error: describe(error) });
		}
	});

	/** The project's default mirror parent, inside the project (no external-directory prompts). */
	const projectMirrorDir = defaultMirrorDir(input.directory);
	/** Sessions already told that CLM could not start for them (one error toast each). */
	const openFailures = new Set<string>();

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

	/** `metadata.clm` of a session record, or an empty object. */
	const clmStamp = (metadata: Record<string, unknown>): Record<string, unknown> =>
		metadata.clm && typeof metadata.clm === "object" && !Array.isArray(metadata.clm) ? (metadata.clm as Record<string, unknown>) : {};

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
		if (typeof stamp.origin === "string" && stamp.origin !== clm.sessionID && !record!.child) {
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
		if (!record) return;
		try {
			const annotations = persistAnnotations(await clm.annotations.list());
			const metadata = { ...record.metadata, clm: { ...clmStamp(record.metadata), annotations } };
			const result = await input.client?.session?.update?.({ path: { id: clm.sessionID }, body: { metadata } } as never);
			const error = (result as { error?: unknown } | undefined)?.error;
			if (error) throw new Error(JSON.stringify(error));
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

	const toolTokens = (): number | undefined => {
		if (toolSizes.size === 0) return undefined;
		let total = 0;
		for (const size of toolSizes.values()) total += size;
		return total;
	};

	/** One setting through `changeSetting`, activated at once; returns `Label: value`. */
	async function setSetting(clm: ClmSession, name: string, value: string): Promise<string> {
		const result = await changeSetting(clm.changeRequest(input.directory), name, value);
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

	/** Session ids the server confirmed; a panel reload sends several requests per session. */
	const knownSessions = new Set<string>();

	/** False when the server does not know the session (the request came from elsewhere). */
	async function knownSession(sessionID: string): Promise<boolean> {
		if (knownSessions.has(sessionID) || sessions.has(sessionID)) return true;
		const get = input.client?.session?.get;
		if (typeof get !== "function") return true;
		try {
			const result = await input.client.session.get({ path: { id: sessionID } });
			const known = Boolean(result?.data) && !result?.error;
			if (known) knownSessions.add(sessionID);
			return known;
		} catch {
			return false;
		}
	}

	/** A request from the TUI over the channel (src/channel.ts): apply it, answer with its id. */
	async function channelRequest(request: ChannelRequest): Promise<Omit<ChannelReply, "v" | "id">> {
		const sessionID = checkSessionID(request.session);
		if (!(await knownSession(sessionID))) throw new Error(`no session ${sessionID} on this server`);
		// A session that fell back from the configured mirrorDir (openSession) lives elsewhere.
		const opened = await sessions.get(sessionID)?.catch(() => undefined);
		const directory = opened?.store.directory ?? sessionDirectory(settings.mirrorDir, sessionID);
		switch (request.op) {
			case "locate":
				return { ok: true, text: "", directory, root: input.directory };
			case "read": {
				const path = await insideSession(directory, request.path);
				if (path === undefined) return { ok: true, text: "" };
				const size = (await stat(path).catch(missingAsUndefined))?.size;
				if (size === undefined) return { ok: true, text: "" };
				if (size > MAX_READ_BYTES) {
					return { ok: false, text: `${request.path} is ${size} bytes, more than the ${MAX_READ_BYTES} a channel reply carries` };
				}
				const content = await readFile(path, "utf8").catch(missingAsUndefined);
				return { ok: true, text: "", ...(content !== undefined ? { content } : {}) };
			}
			case "list": {
				const path = await insideSession(directory, request.path);
				if (path === undefined) return { ok: true, text: "" };
				const names = await readdir(path).catch(missingAsUndefined);
				return { ok: true, text: "", ...(names !== undefined ? { names } : {}) };
			}
		}
		const clm = await session(sessionID);
		await clm.refreshSettings();
		switch (request.op) {
			case "set": {
				const text = await setSetting(clm, request.setting, request.value);
				toast(`CLM ${text}.`);
				return { ok: true, text };
			}
			case "settings-reset":
				await clearSettings(clm);
				return { ok: true, text: "CLM settings reset to the defaults." };
			case "reset":
				await dropRevision(clm);
				return { ok: true, text: "CLM revision dropped" };
		}
	}

	/**
	 * `path` inside the session directory, else a refusal; undefined when it does not exist.
	 * Checked twice: lexically, then with symlinks resolved on both sides, as OpenCode's own
	 * file API does (packages/core/src/filesystem.ts:66-71), so a link the model created in
	 * the mirror directory cannot point a `read` elsewhere.
	 */
	async function insideSession(directory: string, path: string): Promise<string | undefined> {
		const outside = (root: string, target: string) => {
			const rel = relative(root, target);
			return isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`);
		};
		const target = resolve(directory, path);
		if (outside(directory, target)) throw new Error(`${path} lies outside the session directory`);
		const realRoot = await realpath(directory).catch(missingAsUndefined);
		const realTarget = await realpath(target).catch(missingAsUndefined);
		if (realRoot === undefined || realTarget === undefined) return undefined;
		if (outside(realRoot, realTarget)) throw new Error(`${path} lies outside the session directory`);
		return realTarget;
	}

	const reply = (value: ChannelReply) => {
		void Promise.resolve()
			.then(() => input.client?.tui?.publish?.({ body: { type: "tui.command.execute", properties: { command: encodeReply(value) } } as never }))
			.catch(() => undefined);
	};

	/**
	 * `/clm-compact [instructions]`: the compaction prompt, with the size of the context as
	 * it would be sent now. pi's checks (pi src/index.ts compactCommand): CLM off and an empty
	 * context are refused with a toast; the model then gets a short relay instead of the
	 * prompt (the turn cannot be cancelled, see C14). OpenCode does not queue a command behind
	 * a busy session: `SessionPrompt.command` fires `command.execute.before` at once and its
	 * prompt joins the running loop (session/prompt.ts:1346, 1356-1466). Typed mid-run, the
	 * size is therefore measured mid-run, without the rest of the current turn; the toast says
	 * so. pi waits for idle instead; this port accepts the lag. A second invocation before the
	 * model received the first prompt is refused like pi's (`compactPending`, below).
	 */
	async function compactCommand(clm: ClmSession, sessionID: string, argument: string): Promise<string> {
		const waiting = compactPending.get(sessionID);
		if (waiting && Date.now() - waiting.at < COMPACT_PENDING_MS) {
			const message = "A /clm-compact is already queued and the model has not received it yet.";
			toast(message, "info");
			return relay(`[CLM] ${message}`);
		}
		// Reserved before the first await, so a second invocation in the meantime is refused.
		const entry: { prompt?: string; at: number } = { at: Date.now() };
		compactPending.set(sessionID, entry);
		const refuse = (message: string) => {
			if (compactPending.get(sessionID) === entry) compactPending.delete(sessionID);
			toast(message, "warning");
			return relay(`[CLM] ${message}`);
		};
		try {
			return await compactPrompt(clm, sessionID, argument, entry, refuse);
		} catch (error) {
			if (compactPending.get(sessionID) === entry) compactPending.delete(sessionID);
			throw error;
		}
	}

	async function compactPrompt(
		clm: ClmSession,
		sessionID: string,
		argument: string,
		entry: { prompt?: string; at: number },
		refuse: (message: string) => string,
	): Promise<string> {
		await clm.refreshSettings();
		const template = loadCompactPrompt(clm.settings.compactPromptPath);
		if (!clm.enabled) {
			return refuse("CLM is off for this session, so there is no editable context to compact. Turn it on with /clm on.");
		}
		// Without a history (the client cannot list messages) the last request's estimate stands in.
		const history = await sessionMessages(sessionID);
		const current = history ? clm.idleEstimate(filterCompacted(history)) : clm.lastReading?.estimated ?? 0;
		if (current === undefined) return refuse("Nothing to compact yet: the context is empty.");
		const busy = await sessionBusy(sessionID);
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
		return prompt;
	}

	/**
	 * Sessions with a `/clm-compact` prompt the model has not received yet, and that prompt.
	 * pi refuses a second `/clm-compact` while one waits (`compactPending`, pi src/index.ts:235,
	 * 997-1000): set when the command is accepted (:1008), cleared once its prompt is sent
	 * (:1046). OpenCode sends the prompt itself, into the running loop or a new one, so here
	 * pending ends at the first model request whose history holds the prompt (the
	 * `messages.transform` hook), or when the session goes idle or fails without one
	 * (`session.idle`, session/status.ts:43; `session.error`). If OpenCode's prompt() fails after
	 * the hook, neither event may come; an entry older than COMPACT_PENDING_MS no longer refuses.
	 */
	const compactPending = new Map<string, { prompt?: string; at: number }>();

	const holdsPrompt = (raw: OcMessage[], prompt: string) =>
		raw.some((message) => message.info.role === "user" && message.parts.some((part) => part.type === "text" && part.text === prompt));

	/** Whether OpenCode reports the session busy or retrying; false when the client cannot tell. */
	async function sessionBusy(sessionID: string): Promise<boolean> {
		const status = input.client?.session?.status;
		if (typeof status !== "function") return false;
		try {
			const result = await input.client.session.status();
			const entry = (result?.data as Record<string, { type?: string }> | undefined)?.[sessionID];
			return entry?.type === "busy" || entry?.type === "retry";
		} catch {
			return false;
		}
	}

	/** The session's stored messages, or undefined when the client cannot list them. */
	async function sessionMessages(sessionID: string): Promise<OcMessage[] | undefined> {
		const list = input.client?.session?.messages;
		if (typeof list !== "function") return undefined;
		try {
			const result = await input.client.session.messages({ path: { id: sessionID } });
			return Array.isArray(result?.data) ? (result.data as unknown as OcMessage[]) : undefined;
		} catch {
			return undefined;
		}
	}

	const hooks: Hooks = {
		async config(config) {
			liveConfig = config as { compaction?: { auto?: boolean; reserved?: number } };
			const auto = liveConfig.compaction?.auto;
			userAutoCompaction = typeof auto === "boolean" ? auto : undefined;
			userHadCompaction = liveConfig.compaction !== undefined;
			// `enabled: false` returns no hooks at all (above), so this runs only with CLM enabled;
			// the guard keeps it that way if that early return ever moves.
			if (settings.enabled && settings.compaction !== "auto") applyCompactionMode(liveConfig, settings.compaction, userAutoCompaction);
			if (settings.commands) {
				const commands = (config.command ??= {});
				const ours = {
					[STATUS_COMMAND]: {
						description: "CLM: status of the editable context; /clm path | on | off | reset",
						template: STATUS_TEMPLATE,
					},
					[COMPACT_COMMAND]: {
						description: "CLM: ask the model to compact its context by editing the mirror",
						template: COMPACT_TEMPLATE,
					},
				};
				for (const [name, definition] of Object.entries(ours)) {
					if (commands[name] === undefined) {
						commands[name] = definition;
						ownCommands.add(name);
					} else if (!ownCommands.has(name)) {
						log("warn", `the config already defines /${name}; CLM leaves it alone and does not handle it`);
					}
				}
			}
			if (settings.skill) {
				// `skills.paths` exists in the 1.18 config schema; the SDK's v1 Config type lacks it.
				const skills = ((config as { skills?: { paths?: string[] } }).skills ??= {});
				const paths = (skills.paths ??= []);
				if (!paths.includes(SKILLS_DIR)) paths.push(SKILLS_DIR);
			}
		},

		async "experimental.chat.system.transform"(hookInput, output) {
			if (!hookInput.sessionID) return;
			const existing = await opened(hookInput.sessionID);
			// The compaction request follows the compaction's messages.transform; a flag that
			// transform did not consume (an empty head) must not leak into the next request.
			if (existing) existing.compacting = false;
			if (isHelperPrompt(output.system)) return;
			let clm: ClmSession;
			try {
				clm = existing ?? (await session(hookInput.sessionID));
			} catch {
				return;
			}
			await clm.refreshSettings();
			// Without a mirror the model gets no protocol text (pi-clm's before_agent_start).
			if (!clm.enabled || clm.mirrorUnavailable !== undefined) return;
			const limit = (hookInput.model as { limit?: { context?: number; input?: number; output?: number } } | undefined)?.limit;
			if (limit) clm.limits = { context: limit.context || undefined, output: limit.output || undefined, ...(limit.input ? { input: limit.input } : {}) };
			if (hookInput.model) clm.limitsKnown = true;
			// notices-only: no protocol section (there is no mirror); the steering document stays.
			const sections = clm.noticesOnly ? [] : [systemGuidance(clm.mirrorPath, clm.resolvedBudget()?.budget)];
			if (clm.steering) sections.push(steeringPromptSection(clm.steering));
			if (sections.length > 0) output.system.push(sections.join("\n\n"));
			clm.scope = { ...clm.scope, systemTokens: clm.textTokens(output.system.join("\n")) };
		},

		async "experimental.chat.messages.transform"(_hookInput, output) {
			const raw = output.messages as unknown as OcMessage[];
			const sessionID = raw[0]?.info?.sessionID;
			if (!sessionID) return;
			const pendingPrompt = compactPending.get(sessionID)?.prompt;
			if (pendingPrompt !== undefined && holdsPrompt(raw, pendingPrompt)) compactPending.delete(sessionID);
			// A new model request: `one-tool` counts its tool calls from zero.
			toolCalls.reset(sessionID);
			let clm: ClmSession;
			try {
				clm = await session(sessionID);
			} catch (error) {
				// The request goes out with the raw history; say so once per session, not per step.
				if (!openFailures.has(sessionID)) {
					openFailures.add(sessionID);
					toast(`not active for session ${sessionID}, requests carry the raw history: ${describe(error)}`, "error");
					log("error", `not active for session ${sessionID}: ${describe(error)}`);
				}
				releaseFlag(sessionID);
				return;
			}
			// Stamp (and detect a fork) once per process, only while CLM edits this session:
			// a session with CLM off is left untouched in OpenCode's store.
			if (!linked.has(sessionID)) {
				await clm.refreshSettings().catch(() => undefined);
				if (clm.enabled) {
					linked.add(sessionID);
					await linkFork(clm);
				}
			}
			const tools = toolTokens();
			if (tools !== undefined) clm.scope = { ...clm.scope, toolTokens: tools };
			const compaction = clm.compacting;
			if (compaction) compactionRequests.add(sessionID);
			else compactionRequests.delete(sessionID);
			if (!compaction) {
				// K5: the step before this request reached OpenCode's threshold while the flag this
				// session set was false, so OpenCode skipped a threshold compaction (prompt.ts:1161).
				const usable = thresholdOf(clm);
				const cancelled = thresholds.observe(sessionID, lastFinishedStep(raw), usable);
				if (cancelled && usable !== undefined) {
					await clm.log({ event: "compaction-cancelled", reason: "threshold", setting: cancelled.by, count: cancelled.count, usable });
					if (cancelled.by === "off") {
						clm.queueNotice(thresholdCancelledNoticeText(clm.noticesOnly ? undefined : clm.mirrorPath));
						toast(thresholdCancelledText(cancelled.count, usable));
					} else toast(thresholdPausedText(cancelled.count, usable, clm.guardLimit()));
				}
			}
			try {
				const result = await clm.transform(raw);
				replaceInPlace(raw, result.messages);
				if (clm.annotationsImported) {
					clm.annotationsImported = false;
					await persistAnnotationsOf(sessionID);
				}
				// Instance-wide flag, set per request from this session's setting: OpenCode reads
				// it after this step and before the next one (src/compaction.ts). Sessions running
				// concurrently in one server overwrite each other's value.
				if (!compaction && liveConfig) {
					// Without a mirror, OpenCode's compaction is the only way to shrink: leave it as configured.
					const active = clm.settings.enabled && clm.enabled && clm.mirrorUnavailable === undefined;
					const mode = active ? clm.settings.compaction : "auto";
					// K1, pi's `auto`: while the guard enforces a budget, pause threshold compaction for
					// a request whose count can reach OpenCode's threshold (src/compaction.ts).
					const usable = thresholdOf(clm);
					const pause = active && mode === "auto" && userAutoCompaction !== false && clm.settings.guard !== "off" &&
						clm.guardLimit() !== undefined && result.estimated !== undefined && usable !== undefined &&
						thresholdReachable(result.estimated, usable, openCodeMaxOutput(clm.limits.output, Math.max(OPENCODE_OUTPUT_TOKEN_MAX, outputTokenMaxFlag() ?? 0)));
					decideFlag(sessionID, pause ? false : compactionAuto(mode, userAutoCompaction));
					if (pause !== (thresholds.by(sessionID) === "auto")) {
						await clm.log({ event: "compaction-pause", paused: pause, estimated: result.estimated, usable });
					}
					thresholds.set(sessionID, pause ? "auto" : active && mode === "off" && userAutoCompaction !== false ? "off" : undefined);
				}
				if (result.alert) {
					toast(result.alert, "warning");
					log("warn", result.alert);
				}
				for (const error of result.errors ?? []) {
					toast(error, "error");
					log("error", `${sessionID}: ${error}`);
				}
			} catch (error) {
				// Fail open: the request goes out with the raw history, under the user's flag.
				if (!compaction) releaseFlag(sessionID);
				await clm.log({ event: "error", message: describe(error), stack: error instanceof Error ? error.stack : undefined });
				toast(`transform failed: ${describe(error)}`, "error");
			}
		},

		async "experimental.session.compacting"(hookInput, output) {
			const clm = await opened(hookInput.sessionID);
			if (!clm) return;
			try {
				await clm.commitBeforeCompaction();
			} catch (error) {
				await clm.log({ event: "error", message: `commit before compaction: ${describe(error)}` });
			}
			clm.compacting = true;
			try {
				const context = await clm.compactionContext();
				if (context) output.context.push(context);
			} catch (error) {
				await clm.log({ event: "error", message: describe(error) });
			}
		},

		async "experimental.compaction.autocontinue"(hookInput) {
			const clm = await opened(hookInput.sessionID);
			if (!clm) return;
			clm.compacted = true;
			thresholds.reset(hookInput.sessionID);
			if (!clm.settings.enabled || !clm.enabled) return;
			// Automatic compaction only (manual /compact does not reach this hook).
			const overflow = hookInput.overflow === true;
			await clm.log({ event: "native-compaction", reason: overflow ? "overflow" : "threshold", setting: clm.settings.compaction });
			toast(nativeCompactionText(overflow, clm.settings.compaction, clm.noticesOnly));
		},

		async event({ event }) {
			const command = commandOf(event);
			if (command !== undefined) {
				const request = decodeRequest(command);
				if (!request) return;
				let answer: Omit<ChannelReply, "v" | "id">;
				try {
					answer = await channelRequest(request);
				} catch (error) {
					answer = { ok: false, text: describe(error) };
					log("warn", `channel ${request.op} for ${request.session}: ${answer.text}`);
				}
				reply({ ...answer, v: CHANNEL_VERSION, id: request.id });
				return;
			}
			if (event.type === "session.idle" || event.type === "session.error") {
				const ended = (event.properties as { sessionID?: string }).sessionID;
				if (ended) {
					compactPending.delete(ended);
					// Not on session.error: the overflow check below reads the flag OpenCode read.
					if (event.type === "session.idle") endFlag(ended);
				}
			}
			if (event.type === "session.error") {
				const { sessionID, error } = event.properties as { sessionID?: string; error?: { name?: string } };
				if (!sessionID || error?.name !== "ContextOverflowError") return;
				const clm = await opened(sessionID);
				if (!clm || !clm.settings.enabled || !clm.enabled) return;
				// OpenCode surfaced the overflow instead of compacting when the flag it read was
				// false (processor.ts:620-628). The event follows that read synchronously, so the
				// live flag, not this session's setting, says what happened (another session may
				// have set it). An overflow of the compaction request itself is not this case.
				if (liveConfig?.compaction?.auto !== false || compactionRequests.has(sessionID)) return;
				if (clm.mirrorUnavailable !== undefined) {
					await clm.log({ event: "overflow-not-compacted", setting: clm.settings.compaction });
					toast("The provider rejected the request as too long, and OpenCode's automatic compaction is off. Run /compact.", "warning");
					return;
				}
				clm.queueNotice(overflowNotCompactedText(clm.noticesOnly ? undefined : clm.mirrorPath));
				await clm.log({ event: "overflow-not-compacted", setting: clm.settings.compaction });
				toast(clm.noticesOnly
					? "The provider rejected the request as too long, and OpenCode's automatic compaction is off. Run /compact."
					: "The provider rejected the request as too long, and OpenCode's automatic compaction is off. Edit the mirror or run /compact.", "warning");
				return;
			}
			if (event.type !== "session.compacted") return;
			const clm = await opened(event.properties.sessionID);
			if (clm) clm.compacted = true;
			thresholds.reset(event.properties.sessionID);
		},

		async "tool.definition"(hookInput, output) {
			// Runtime output also carries `jsonSchema` (set for plugin and MCP tools). OpenCode's
			// built-in tools carry an Effect schema instead, which is not measured here.
			const schema = (output as { jsonSchema?: unknown }).jsonSchema;
			let size = output.description?.length ?? 0;
			if (schema && typeof schema === "object") {
				try {
					size += JSON.stringify(schema).length;
				} catch {
					// unmeasurable schema: description only
				}
			}
			toolSizes.set(hookInput.toolID, Math.ceil((size / 4) * settings.estimateFactor));
		},

		async "tool.execute.before"(hookInput) {
			// Counted before any await: parallel calls of one response arrive concurrently.
			const position = toolCalls.next(hookInput.sessionID);
			if (position < 2) return;
			const clm = await opened(hookInput.sessionID);
			if (!clm || !clm.settings.enabled || !clm.enabled || !clm.settings.oneTool) return;
			await clm.log({ event: "tool-blocked", tool: hookInput.tool, position });
			// OpenCode turns the throw into the call's error result, which the model sees.
			throw new Error(oneToolText(hookInput.tool, position));
		},

		async "tool.execute.after"(hookInput, output) {
			// Before any await: the session's own flag back after a subagent's requests.
			if (flagDecisions.has(hookInput.sessionID)) applyFlag(flagDecisions.get(hookInput.sessionID));
			const clm = await opened(hookInput.sessionID);
			if (!clm || typeof output.output !== "string") return;
			// Runs inside the tool's own call: a throw here would fail the model's command.
			let receipt: string | undefined;
			try {
				receipt = clm.receipt(hookInput.tool, hookInput.args, input.directory);
			} catch (error) {
				await clm.log({ event: "receipt-error", tool: hookInput.tool, message: describe(error) });
			}
			if (receipt) output.output = output.output ? `${output.output}${output.output.endsWith("\n") ? "\n" : "\n\n"}${receipt}` : receipt;
			// Last, so it measures the result as the model gets it. Not for failed calls:
			// OpenCode runs this hook only after a successful execute (session/tools.ts:105-123).
			const trailer = clm.sizeTrailer(output.output);
			if (trailer) output.output = `${output.output}${trailer}`;
		},

		async "command.execute.before"(hookInput, output) {
			if (!settings.commands || !ownCommands.has(hookInput.command)) return;
			// A rejected hook fails the command request: report errors as the command's text.
			let text: string;
			try {
				const clm = await session(hookInput.sessionID);
				const argument = (hookInput.arguments ?? "").trim();
				if (hookInput.command === STATUS_COMMAND) text = relay(await statusCommand(clm, argument));
				else if (clm.mirrorUnavailable !== undefined) {
					// pi-clm's compactCommand: nothing for the model to edit, so nothing is asked of it.
					toast(`The context mirror is unavailable, so the model cannot edit its context (${clm.mirrorUnavailable}).`, "warning");
					text = relay("[CLM] The context mirror is unavailable, so the model cannot edit its context.");
				} else {
					await clm.refreshSettings();
					if (clm.noticesOnly) {
						// The compaction prompt asks for a mirror edit; notices-only has no mirror.
						const message = "CLM runs in notices-only mode for this session, so the model cannot edit its context. Switch with /clm config mode edit.";
						toast(message, "warning");
						text = relay(`[CLM] ${message}`);
					} else text = await compactCommand(clm, hookInput.sessionID, argument);
				}
			} catch (error) {
				const message = `/${hookInput.command} failed: ${describe(error)}`;
				toast(message, "error");
				log("error", message);
				text = relay(`[CLM] ${message}`);
			}
			const parts = output.parts as Array<{ type: string; text?: string }>;
			const first = parts.find((part) => part.type === "text");
			if (first) first.text = text;
			else parts.unshift({ type: "text", text } as never);
		},

		tool: continuityTools({
			schema: tool.schema,
			store: async (sessionID) => (await session(sessionID)).annotations,
			block: async (sessionID, blockId) => (await session(sessionID)).blockSource(blockId),
			onChange: persistAnnotationsOf,
		}),
	};
	return hooks;
};

export default { id: PLUGIN_ID, server };
