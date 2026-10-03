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
import { tool, type Hooks, type Plugin, type PluginInput, type PluginOptions } from "@opencode-ai/plugin";

import { ClmSession } from "./src/clm.ts";
import { buildCompactPrompt, loadCompactPrompt } from "./src/compact.ts";
import { continuityTools } from "./src/continuity.ts";
import { replaceInPlace, type OcMessage } from "./src/opencode.ts";
import { statusText, systemGuidance } from "./src/presentation.ts";
import { COMPACT_COMMAND, COMPACT_TEMPLATE, STATUS_COMMAND, STATUS_TEMPLATE } from "./src/commands.ts";
import { changeSetting, resetSettings, showSetting } from "./src/overrides.ts";
import { settingsText } from "./src/settings-table.ts";
import { parseClmCommand, type Page } from "./src/panel/command.ts";
import { buildPanelModel } from "./src/panel/model.ts";
import { panelPageText } from "./src/panel/text.ts";
import { readSessionDirectory } from "./src/session-files.ts";
import { fallbackBudget, settingsView } from "./src/tui/data.ts";
import { resolveSettings, SKILLS_DIR, type ClmSettings } from "./src/settings.ts";
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

	const session = (sessionID: string): Promise<ClmSession> => {
		const id = checkSessionID(sessionID);
		let existing = sessions.get(id);
		if (!existing) {
			existing = ClmSession.open(id, settings, { steering }).then((clm) => {
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
			await resetSettings(clm.store.directory);
			await clm.refreshSettings(true);
			toast("CLM settings reset to the defaults.");
			return "CLM settings reset to the defaults for this session.";
		}
		if (valueWords.length === 0) return showSetting(name, effective, format);
		const result = await changeSetting(clm.changeRequest(input.directory), name, valueWords.join(" "));
		await clm.refreshSettings(true);
		toast(`CLM ${result.text}.`);
		return `CLM ${result.text}. It applies from the next request.`;
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
				await changeSetting(clm.changeRequest(input.directory), "editing", argument);
				await clm.refreshSettings(true);
				toast(`CLM ${argument} for this session`);
				return argument === "on"
					? "CLM is on for this session: the mirror is refreshed before the next request."
					: "CLM is off for this session: requests carry the raw history and the mirror is no longer read.";
			}
			case "reset": {
				await clm.resetProjection("/clm reset");
				toast("CLM revision dropped");
				return "CLM dropped the accepted revision: the next request carries the stored history, and the mirror is rewritten from it.";
			}
			default:
				return `${STATUS_USAGE}\nUnknown argument: ${JSON.stringify(args)}`;
		}
	}

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
				toast(`not active for session ${sessionID}: ${describe(error)}`, "error");
				return;
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
