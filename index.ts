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
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { tool, type Hooks, type Plugin, type PluginInput, type PluginOptions } from "@opencode-ai/plugin";

import { ClmSession } from "./src/clm.ts";
import { MirrorDirectoryError } from "./src/mirror-store.ts";
import { buildCompactPrompt, loadCompactPrompt } from "./src/compact.ts";
import { continuityTools } from "./src/continuity.ts";
import { replaceInPlace, type OcMessage } from "./src/opencode.ts";
import { statusText, systemGuidance } from "./src/presentation.ts";
import { COMPACT_COMMAND, COMPACT_TEMPLATE, STATUS_COMMAND, STATUS_TEMPLATE } from "./src/commands.ts";
import { changeSetting, resetSettings, showSetting } from "./src/overrides.ts";
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

const STATUS_USAGE = "Usage: /clm [overview | input | edits | settings | status | path | on | off | reset | config [setting [value] | reset]]";

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
	// Read once at load: a missing or empty steering file fails the plugin with its path.
	const steering: SteeringDocument | undefined = settings.steeringPath ? loadSteeringDocument(settings.steeringPath) : undefined;

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
	/** Command names this plugin defined; a user's own `clm` / `clm-compact` stays theirs. */
	const ownCommands = new Set<string>();

	/**
	 * OpenCode's record of a session: its metadata (`Session.Info.metadata`, a free record) and
	 * whether it is a child (subagent) session (`parentID`). Undefined when the client is
	 * unavailable; a failed call is logged as `stamp-error`. The v1 SDK's `Session` type omits
	 * `metadata`.
	 */
	const sessionRecord = async (clm: ClmSession): Promise<{ metadata: Record<string, unknown>; child: boolean } | undefined> => {
		const get = input.client?.session?.get;
		if (typeof get !== "function") return undefined;
		try {
			const result = await input.client.session.get({ path: { id: clm.sessionID } });
			const failed = (result as { error?: unknown } | undefined)?.error;
			const data = (result as { data?: { metadata?: unknown; parentID?: unknown } } | undefined)?.data;
			if (failed !== undefined || !data) {
				await clm.log({ event: "stamp-error", stage: "get", error: JSON.stringify(failed ?? "no data") });
				return undefined;
			}
			const metadata = data.metadata;
			return {
				metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {},
				child: typeof data.parentID === "string" && data.parentID !== "",
			};
		} catch (error) {
			await clm.log({ event: "stamp-error", stage: "get", error: describe(error) });
			return undefined;
		}
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
	const linkFork = async (clm: ClmSession): Promise<void> => {
		const record = await sessionRecord(clm);
		// Child (subagent) sessions are never forked: no stamp, no PATCH bumping their time.
		if (!record || record.child) return;
		const metadata = record.metadata;
		const stamp = metadata.clm && typeof metadata.clm === "object" && !Array.isArray(metadata.clm) ? (metadata.clm as Record<string, unknown>) : {};
		const origin = stamp.origin;
		if (origin === clm.sessionID) return;
		if (typeof origin === "string" && !clm.state.checkpoint && clm.state.revision === 0) {
			try {
				clm.forkOrigin = { sessionID: origin, directory: sessionDirectory(settings.mirrorDir, checkSessionID(origin)) };
			} catch {
				// a foreign stamp that is not a usable session id: ignore it
			}
		}
		try {
			const result = await input.client?.session?.update?.({ path: { id: clm.sessionID }, body: { metadata: { ...metadata, clm: { ...stamp, origin: clm.sessionID } } } } as never);
			const error = (result as { error?: unknown } | undefined)?.error;
			if (error) await clm.log({ event: "stamp-error", stage: "update", error: JSON.stringify(error) });
		} catch (error) {
			await clm.log({ event: "stamp-error", stage: "update", error: describe(error) });
		}
	};

	/** The project's default mirror parent, inside the project (no external-directory prompts). */
	const projectMirrorDir = defaultMirrorDir(input.directory);
	/** Sessions already told that CLM could not start for them (one error toast each). */
	const openFailures = new Set<string>();

	/**
	 * Opens a session in `mirrorDir`. Only a failure to create or use the session directory
	 * (`MirrorDirectoryError`) is handled here; any other error propagates as before.
	 * - An explicitly configured `mirrorDir` that fails: the session uses the project default
	 *   `.opencode/clm` instead, and a toast names both. Inside the project the model's tools
	 *   reach it without an `external_directory` permission prompt.
	 * - The default itself fails: the request goes out with the raw history (the transform
	 *   hook fails open), and the user gets one error toast for the session.
	 */
	const openSession = async (id: string): Promise<ClmSession> => {
		try {
			return await ClmSession.open(id, settings, { steering });
		} catch (error) {
			if (!(error instanceof MirrorDirectoryError) || settings.mirrorDir === projectMirrorDir) throw error;
			const clm = await ClmSession.open(id, { ...settings, mirrorDir: projectMirrorDir }, { steering });
			const message = `could not use the configured mirrorDir ${settings.mirrorDir} (${describe(error.cause)}); the files of session ${id} are in ${clm.store.directory} instead.`;
			log("warn", message);
			toast(message, "warning");
			await clm.log({ event: "mirror-dir-fallback", configured: settings.mirrorDir, used: projectMirrorDir, reason: describe(error.cause) });
			return clm;
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
		const format = { modelWindow: clm.limits.context };
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
		const format = { ...(clm.limits.context ? { modelWindow: clm.limits.context } : {}) };
		model.settings = settingsView(clm.settingsValues(), model, { format, ...(clm.settingsWarning ? { warning: clm.settingsWarning } : {}) });
		return panelPageText(model, page);
	}

	async function statusCommand(clm: ClmSession, args: string): Promise<string> {
		await clm.refreshSettings();
		const words = args.split(/\s+/).filter(Boolean);
		const argument = (words[0] ?? "").toLowerCase();
		if (argument === "config") return configCommand(clm, words.slice(1));
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
				return `CLM mirror: ${clm.mirrorPath}`;
			case "on":
			case "off": {
				// The same override the TUI and `/clm config editing` write.
				await setSetting(clm, "editing", argument);
				toast(`CLM ${argument} for this session`);
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

	function compactCommand(clm: ClmSession, argument: string): string {
		return buildCompactPrompt(loadCompactPrompt(clm.settings.compactPromptPath), {
			mirror: clm.mirrorPath,
			current: clm.lastReading?.estimated ?? 0,
			budget: clm.resolvedBudget()?.budget,
			instructions: argument,
		});
	}

	const hooks: Hooks = {
		async config(config) {
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
			if (!clm.enabled) return;
			const limit = (hookInput.model as { limit?: { context?: number; output?: number } } | undefined)?.limit;
			if (limit) clm.limits = { context: limit.context || undefined, output: limit.output || undefined };
			const sections = [systemGuidance(clm.mirrorPath, clm.resolvedBudget()?.budget)];
			if (clm.steering) sections.push(steeringPromptSection(clm.steering));
			output.system.push(sections.join("\n\n"));
			clm.scope = { ...clm.scope, systemTokens: clm.textTokens(output.system.join("\n")) };
		},

		async "experimental.chat.messages.transform"(_hookInput, output) {
			const raw = output.messages as unknown as OcMessage[];
			const sessionID = raw[0]?.info?.sessionID;
			if (!sessionID) return;
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
			try {
				const result = await clm.transform(raw);
				replaceInPlace(raw, result.messages);
				if (result.alert) {
					toast(result.alert, "warning");
					log("warn", result.alert);
				}
				for (const error of result.errors ?? []) {
					toast(error, "error");
					log("error", `${sessionID}: ${error}`);
				}
			} catch (error) {
				// Fail open: the request goes out with the raw history.
				await clm.log({ event: "error", message: describe(error), stack: error instanceof Error ? error.stack : undefined });
				toast(`transform failed: ${describe(error)}`, "error");
			}
		},

		async "experimental.session.compacting"(hookInput, output) {
			const clm = await opened(hookInput.sessionID);
			if (!clm) return;
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
			if (clm) clm.compacted = true;
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
			if (event.type !== "session.compacted") return;
			const clm = await opened(event.properties.sessionID);
			if (clm) clm.compacted = true;
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

		async "tool.execute.after"(hookInput, output) {
			const clm = await opened(hookInput.sessionID);
			if (!clm || typeof output.output !== "string") return;
			// Runs inside the tool's own call: a throw here would fail the model's command.
			let receipt: string | undefined;
			try {
				receipt = clm.receipt(hookInput.tool, hookInput.args, input.directory);
			} catch (error) {
				await clm.log({ event: "receipt-error", tool: hookInput.tool, message: describe(error) });
				return;
			}
			if (!receipt) return;
			output.output = output.output ? `${output.output}${output.output.endsWith("\n") ? "\n" : "\n\n"}${receipt}` : receipt;
		},

		async "command.execute.before"(hookInput, output) {
			if (!settings.commands || !ownCommands.has(hookInput.command)) return;
			// A rejected hook fails the command request: report errors as the command's text.
			let text: string;
			try {
				const clm = await session(hookInput.sessionID);
				const argument = (hookInput.arguments ?? "").trim();
				text = hookInput.command === STATUS_COMMAND
					? relay(await statusCommand(clm, argument))
					: compactCommand(clm, argument);
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
		}),
	};
	return hooks;
};

export default { id: PLUGIN_ID, server };
