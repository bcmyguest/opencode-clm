/**
 * OpenCode 2 entry point (`setup`): the same CLM behaviour as `server` in index.ts, wired to
 * OpenCode 2's plugin API (packages/plugin/src/promise, 2.1.1). One default export serves both
 * hosts: OpenCode 2 reads `id` + `setup`, OpenCode 1 calls `server`.
 *
 * Hook mapping, checked against OpenCode 2.1.1:
 * - `session.hook("context")` replaces OpenCode 1's `experimental.chat.messages.transform`,
 *   `experimental.chat.system.transform` and `tool.definition`: one event carries the system
 *   parts, the provider-level messages (src/opencode-v2.ts converts them) and the tool
 *   definitions. It fires for the agent loop only; titles and other helper requests have
 *   their own hooks, so no helper-prompt sniffing is needed.
 * - `session.hook("compaction")` replaces `experimental.session.compacting` and the
 *   compaction's own messages transform: the pending edit is committed, the accepted revision
 *   applied to the history being summarized, and the annotations go in as a system part.
 * - Commands registered through `command.transform` run plugin code instead of sending a
 *   template, so `/clm` costs no model turn: its text is posted with `session.synthetic`
 *   and `resume: false` (queued in the session's inbox and delivered with the next turn).
 * - `tool.hook("execute.after")` replaces `tool.execute.after`.
 * - Events come from `event.subscribe`: `session.step.ended` carries the provider's token
 *   count (OpenCode 1 kept it on the message), `session.compaction.ended` marks a compaction.
 *
 * The `compaction` setting: OpenCode 2's compaction settings are internal, so `auto` (pi-clm's
 * and the paper's default) is had by keeping the budget under OpenCode's threshold (`prepare`)
 * instead of by switching OpenCode's compaction off per request; `on` leaves the threshold in
 * play; `off` cannot be done by a plugin and is logged. No toasts (server plugins have no TUI
 * channel): problems and OpenCode's compactions go to `<mirrorDir>/plugin.log`, compactions
 * also to `/clm status`. No TUI panel.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { tool } from "@opencode-ai/plugin";

import { ClmSession } from "./clm.ts";
import { COMPACT_COMMAND, STATUS_COMMAND } from "./commands.ts";
import { oneToolText, ToolCallCounter } from "./compaction.ts";
import { annotateArgs, ANNOTATE_DESCRIPTION, ANNOTATE_TOOL, continuityTools, recallArgs, RECALL_DESCRIPTION, RECALL_TOOL } from "./continuity.ts";
import { checkSessionID, createHost, describe, type SessionRecord, type ToastVariant } from "./host.ts";
import { fromV2, toV2, type V2Message, type V2Tokens } from "./opencode-v2.ts";
import { systemGuidance } from "./presentation.ts";
import { resolveSettings, SKILLS_DIR } from "./settings.ts";
import { loadSteeringDocument, steeringPromptSection, type SteeringDocument } from "./steering.ts";

const PLUGIN_ID = "opencode-clm";

// Structural types for the parts of OpenCode 2's plugin context this module uses; the
// `@opencode/plugin` package is not a dependency (OpenCode 1 installs do not have it).
type Registration = { dispose(): Promise<void> };
interface ContextEvent {
	readonly sessionID: string;
	readonly agent: string;
	readonly model: { providerID: string; id: string };
	system: Array<{ type: "text"; text: string }>;
	messages: V2Message[];
	tools: Record<string, { description: string; input: unknown }>;
}
interface ToolBefore {
	tool: string;
	readonly sessionID: string;
	readonly id: string;
	input: unknown;
}
type ToolAfter = {
	readonly tool: string;
	readonly sessionID: string;
	readonly id: string;
	readonly input: unknown;
} & ({ readonly status: "completed"; result: { output?: unknown; content?: string | ReadonlyArray<{ type: string; text?: string }>; metadata?: Record<string, unknown> } } | { readonly status: "error"; error: unknown });
interface CommandInvocation {
	readonly sessionID: string;
	readonly prompt: { text: string; [key: string]: unknown };
	readonly delivery: string;
}
interface V2Session {
	readonly sessionID: string;
}
export interface V2Context {
	readonly location: { directory: string };
	readonly options: Readonly<Record<string, any>>;
	readonly session: {
		get(input: { sessionID: string }): Promise<any>;
		update(input: { sessionID: string; metadata?: Record<string, unknown> }): Promise<unknown>;
		prompt(input: Record<string, unknown>): Promise<unknown>;
		synthetic(input: { sessionID: string; text: string; resume?: boolean; delivery?: string }): Promise<{ id?: string } | undefined>;
		hook(name: "context" | "compaction", callback: (event: ContextEvent) => Promise<void> | void): Promise<Registration>;
	};
	readonly tool: {
		transform(callback: (editor: { add(tool: Record<string, unknown>): void }) => void): Promise<Registration>;
		hook(name: "execute.before", callback: (event: ToolBefore) => Promise<void> | void): Promise<Registration>;
		hook(name: "execute.after", callback: (event: ToolAfter) => Promise<void> | void): Promise<Registration>;
	};
	readonly command: {
		transform(callback: (editor: { add(command: { name: string; description?: string; execute(input: CommandInvocation): Promise<void> }): void }) => void): Promise<Registration>;
	};
	readonly skill: {
		transform(callback: (editor: { add(skill: Record<string, unknown>): void; get(id: string): unknown }) => void): Promise<Registration>;
	};
	readonly model: { list(): Promise<{ data?: Array<{ providerID: string; id: string; limit?: { context?: number; input?: number; output?: number } }> } | undefined> };
	readonly event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<{ type?: string; created?: number; data?: Record<string, any> }> };
}

/** The bundled skill as an OpenCode 2 `Skill.Info` (OpenCode 1 reads the directory through `skills.paths`). */
function bundledSkill(): Record<string, unknown> | undefined {
	const path = `${SKILLS_DIR}/SKILL.md`;
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	const fields = new Map<string, string>();
	for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
		const field = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line);
		if (field) fields.set(field[1]!, field[2]!.trim());
	}
	const name = fields.get("name") ?? "clm-context";
	return { id: name, name, description: fields.get("description"), path, content: match?.[2] ?? text };
}

/** Text of a completed tool result's content (a string or a list of content items). */
function contentText(content: string | ReadonlyArray<{ type: string; text?: string }> | undefined): string {
	if (typeof content === "string") return content;
	return (content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
}

/** `content` with `text` appended as its own text item (a string stays a string). */
function appendContent(content: string | ReadonlyArray<{ type: string; text?: string }> | undefined, text: string) {
	if (typeof content === "string" || content === undefined) {
		const current = content ?? "";
		return current ? `${current}${current.endsWith("\n") ? "\n" : "\n\n"}${text}` : text;
	}
	return [...content, { type: "text", text }];
}

export async function setup(ctx: V2Context): Promise<(() => void) | void> {
	const directory = ctx.location.directory;
	const settings = resolveSettings(ctx.options ?? {}, process.env, directory);
	if (!settings.enabled) return;
	let steering: SteeringDocument | undefined;
	if (settings.steeringPath) {
		try {
			steering = loadSteeringDocument(settings.steeringPath);
		} catch (error) {
			console.error(`[${PLUGIN_ID}] steering document not loaded, sessions run without it: ${describe(error)}`);
		}
	}

	// No TUI channel or log API for a server plugin: warnings and errors go to stderr and to
	// `<mirrorDir>/plugin.log` (the mirror parent is private and git-ignored).
	const logFile = join(settings.mirrorDir, "plugin.log");
	const log = (level: "info" | "warn" | "error", message: string) => {
		if (level !== "info") console.error(`[${PLUGIN_ID}] ${level}: ${message}`);
		try {
			appendFileSync(logFile, `${new Date().toISOString()} ${level} ${message}\n`, { mode: 0o600 });
		} catch {
			// the mirror parent may not exist yet (no session opened) or be unusable
		}
	};
	// Toasts are mostly status echoes of `/clm` replies the user already sees; only problems are logged.
	const toast = (message: string, variant: ToastVariant = "info") => {
		if (variant === "error" || variant === "warning") log(variant === "error" ? "error" : "warn", message);
	};
	if (settings.compaction === "off") {
		log("warn", `"compaction: off" has no effect on OpenCode 2 (plugins cannot change its compaction settings); set "compaction": { "auto": false } in opencode.json instead.`);
	}

	const record = async (sessionID: string): Promise<SessionRecord | undefined> => {
		const info = await ctx.session.get({ sessionID });
		if (!info) throw new Error("no data");
		const metadata = info.metadata;
		return {
			metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {},
			child: typeof info.parentID === "string" && info.parentID !== "",
			...(typeof info.time?.created === "number" ? { created: info.time.created } : {}),
			...(typeof info.fork?.sessionID === "string" ? { forkOf: info.fork.sessionID } : {}),
		};
	};
	const updateMetadata = async (sessionID: string, metadata: Record<string, unknown>) => {
		await ctx.session.update({ sessionID, metadata });
	};
	const host = createHost({ settings, steering, directory, toast, log, record, updateMetadata });

	/** Provider-reported tokens per assistant message (`session.step.ended`). */
	const usage = new Map<string, V2Tokens>();
	const openFailures = new Set<string>();
	const toolCalls = new ToolCallCounter();

	const openSession = async (sessionID: string): Promise<ClmSession | undefined> => {
		try {
			return await host.session(sessionID);
		} catch (error) {
			// The request goes out with the raw history; say so once per session, not per step.
			if (!openFailures.has(sessionID)) {
				openFailures.add(sessionID);
				log("error", `not active for session ${sessionID}, requests carry the raw history: ${describe(error)}`);
			}
			return undefined;
		}
	};

	/** Model limits and the system prompt section: what `experimental.chat.system.transform` did. */
	const prepare = async (clm: ClmSession, event: ContextEvent) => {
		await clm.refreshSettings();
		const list = await ctx.model.list().catch(() => undefined);
		const limit = list?.data?.find((model) => model.providerID === event.model.providerID && model.id === event.model.id)?.limit;
		if (limit?.context) {
			// pi-clm's `compaction: auto` (the paper's default): OpenCode's threshold compaction must
			// not fire while the guard keeps the context within budget. OpenCode 2 compacts once its
			// measure of the sent context reaches window − reserve (session/compaction.ts
			// `calculateCeiling`, no `compaction.buffer` set), so the core gets that reserve as its
			// output share: a `window` budget, and the guard, then end below the threshold. Recovery
			// from a provider overflow stays OpenCode's. `on` leaves OpenCode's threshold in play.
			const window = limit.input || limit.context;
			const reserve = Math.max(Math.floor(window * 0.15), window >= 32_000 ? 16_000 : 0);
			const output = clm.settings.compaction === "on" ? limit.output : Math.max(limit.output ?? 0, limit.context - window + reserve);
			clm.limits = { context: limit.context, output: output || undefined, ...(limit.input ? { input: limit.input } : {}) };
			clm.limitsKnown = true;
		}
		let toolSize = 0;
		for (const [name, definition] of Object.entries(event.tools ?? {})) {
			toolSize += Math.ceil(((name.length + (definition.description?.length ?? 0) + JSON.stringify(definition.input ?? {}).length) / 4) * settings.estimateFactor);
		}
		clm.scope = { ...clm.scope, toolTokens: toolSize };
		// Without a mirror the model gets no protocol text (pi-clm's before_agent_start).
		if (!clm.enabled || clm.mirrorUnavailable !== undefined) return;
		// notices-only: no protocol section (there is no mirror); the steering document stays.
		const sections = clm.noticesOnly ? [] : [systemGuidance(clm.mirrorPath, clm.resolvedBudget()?.budget)];
		if (clm.steering) sections.push(steeringPromptSection(clm.steering));
		if (sections.length > 0) event.system.push({ type: "text", text: sections.join("\n\n") });
		clm.scope = { ...clm.scope, systemTokens: clm.textTokens(event.system.map((part) => part.text).join("\n")) };
	};

	/** The core's transform over the event's messages, written back in place. */
	const transform = async (clm: ClmSession, event: ContextEvent) => {
		const view = fromV2(event.messages, event.sessionID, (id) => usage.get(id));
		const result = await clm.transform(view.messages);
		event.messages.splice(0, event.messages.length, ...toV2(view, result.messages));
		if (clm.annotationsImported) {
			clm.annotationsImported = false;
			await host.persistAnnotationsOf(event.sessionID);
		}
		if (result.alert) log("warn", result.alert);
		for (const error of result.errors ?? []) log("error", `${event.sessionID}: ${error}`);
	};

	const holdsPrompt = (messages: readonly V2Message[], prompt: string) =>
		messages.some((message) => message.role === "user" && message.content.some((part) => part.type === "text" && part.text === prompt));

	await ctx.session.hook("context", async (event) => {
		const sessionID = event.sessionID;
		const pending = host.compactPending.get(sessionID)?.prompt;
		if (pending !== undefined && holdsPrompt(event.messages, pending)) host.compactPending.delete(sessionID);
		// A new model request: `one-tool` counts its tool calls from zero.
		toolCalls.reset(sessionID);
		const clm = await openSession(sessionID);
		if (!clm) return;
		try {
			// Stamp (and detect a fork) once per process, only while CLM edits this session.
			if (!host.linked.has(sessionID)) {
				await clm.refreshSettings().catch(() => undefined);
				if (clm.enabled) {
					host.linked.add(sessionID);
					await host.linkFork(clm);
				}
			}
			await prepare(clm, event);
			await transform(clm, event);
		} catch (error) {
			// Fail open: the request goes out with the raw history.
			await clm.log({ event: "error", message: describe(error), stack: error instanceof Error ? error.stack : undefined });
			log("error", `transform failed: ${describe(error)}`);
		}
	});

	await ctx.session.hook("compaction", async (event) => {
		const clm = await host.opened(event.sessionID);
		if (!clm) return;
		try {
			await clm.commitBeforeCompaction();
		} catch (error) {
			await clm.log({ event: "error", message: `commit before compaction: ${describe(error)}` });
		}
		// OpenCode 2 starts the follow-up request before `session.compaction.ended` reaches the
		// event stream, so the rebase signal is set here. A compaction that fails leaves the
		// history unchanged: the projection stays valid and no rebase happens.
		clm.compacted = true;
		try {
			const context = await clm.compactionContext();
			if (context) event.system.push({ type: "text", text: context });
			clm.compacting = true;
			await transform(clm, event);
		} catch (error) {
			clm.compacting = false;
			await clm.log({ event: "error", message: describe(error) });
		}
	});

	await ctx.tool.hook("execute.before", async (event) => {
		// Counted before any await: parallel calls of one response arrive concurrently.
		const position = toolCalls.next(event.sessionID);
		if (position < 2) return;
		const clm = await host.opened(event.sessionID);
		if (!clm || !clm.settings.enabled || !clm.enabled || !clm.settings.oneTool) return;
		await clm.log({ event: "tool-blocked", tool: event.tool, position });
		throw new Error(oneToolText(event.tool, position));
	});

	await ctx.tool.hook("execute.after", async (event) => {
		if (event.status !== "completed") return;
		const clm = await host.opened(event.sessionID);
		if (!clm) return;
		const input = event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>) : {};
		let receipt: string | undefined;
		try {
			receipt = clm.receipt(event.tool, input, directory);
		} catch (error) {
			await clm.log({ event: "receipt-error", tool: event.tool, message: describe(error) });
		}
		let content = event.result.content;
		if (receipt) content = appendContent(content, receipt);
		// Last, so it measures the result as the model gets it.
		const trailer = clm.sizeTrailer(contentText(content));
		if (trailer) content = typeof content === "string" ? `${content}${trailer}` : appendContent(content, trailer.trimStart());
		if (content !== event.result.content) event.result = { ...event.result, content };
	});

	/**
	 * Posts `text` to the session without starting a model turn; it is delivered with the next
	 * one, and the model reads it then, as OpenCode 1's `/clm` relay has it read.
	 */
	const display = async (sessionID: string, text: string) => {
		await ctx.session.synthetic({ sessionID, text, resume: false });
	};

	if (settings.commands) {
		await ctx.command.transform((editor) => {
			editor.add({
				name: STATUS_COMMAND,
				description: "CLM: status of the editable context; /clm path | on | off | reset | config | budget",
				execute: async ({ sessionID, prompt }) => {
					let text: string;
					try {
						text = await host.statusCommand(await host.session(checkSessionID(sessionID)), (prompt.text ?? "").trim());
					} catch (error) {
						text = `[CLM] /${STATUS_COMMAND} failed: ${describe(error)}`;
						log("error", text);
					}
					try {
						await display(sessionID, text);
					} catch (error) {
						log("error", `/${STATUS_COMMAND}: could not post the reply: ${describe(error)}`);
					}
				},
			});
			editor.add({
				name: COMPACT_COMMAND,
				description: "CLM: ask the model to compact its context by editing the mirror",
				execute: async ({ sessionID, prompt, delivery }) => {
					try {
						const clm = await host.session(checkSessionID(sessionID));
						// OpenCode 2 has no history in the core's form outside a request: the last request's size stands in.
						const result = await host.compactCommand(clm, sessionID, (prompt.text ?? "").trim(), async () => ({
							current: clm.lastReading?.estimated,
							busy: false,
						}));
						if ("prompt" in result) await ctx.session.prompt({ sessionID, text: result.prompt, delivery });
						else await display(sessionID, result.refused);
					} catch (error) {
						const text = `[CLM] /${COMPACT_COMMAND} failed: ${describe(error)}`;
						log("error", text);
						await display(sessionID, text);
					}
				},
			});
		});
	}

	if (settings.skill) {
		const skill = bundledSkill();
		if (skill) {
			await ctx.skill.transform((editor) => {
				if (!editor.get(String(skill.id))) editor.add(skill);
			});
		}
	}

	const tools = continuityTools({
		schema: tool.schema,
		store: async (sessionID) => (await host.session(sessionID)).annotations,
		block: async (sessionID, blockId) => (await host.session(sessionID)).blockSource(blockId),
		onChange: host.persistAnnotationsOf,
	});
	const z = tool.schema;
	await ctx.tool.transform((editor) => {
		for (const [name, description, args] of [
			[ANNOTATE_TOOL, ANNOTATE_DESCRIPTION, annotateArgs(z)],
			[RECALL_TOOL, RECALL_DESCRIPTION, recallArgs(z)],
		] as const) {
			editor.add({
				name,
				description,
				input: z.object(args),
				execute: async (input: Record<string, unknown>, context: V2Session) => {
					const output = await tools[name]!.execute(input as never, { sessionID: context.sessionID } as never);
					return { content: typeof output === "string" ? output : output.output };
				},
			});
		}
	});

	/** `session.compaction.started` reason per session, read when the compaction ends. */
	const compactionReasons = new Map<string, "auto" | "manual">();
	const controller = new AbortController();
	void (async () => {
		try {
			for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
				const data = event?.data ?? {};
				const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
				switch (event?.type) {
					case "session.step.ended":
						if (typeof data.assistantMessageID === "string" && data.tokens) usage.set(data.assistantMessageID, data.tokens);
						break;
					case "session.compaction.started":
						if (sessionID) compactionReasons.set(sessionID, data.reason === "manual" ? "manual" : "auto");
						break;
					case "session.compaction.ended": {
						if (!sessionID) break;
						const reason = compactionReasons.get(sessionID) ?? "auto";
						compactionReasons.delete(sessionID);
						log("info", `OpenCode compacted session ${sessionID} (${reason === "auto" ? "automatic" : "/compact"})`);
						const clm = await host.opened(sessionID);
						if (!clm) break;
						clm.compacted = true;
						await clm.noteCompaction(reason, typeof event.created === "number" ? event.created : Date.now());
						break;
					}
					case "session.execution.succeeded":
					case "session.execution.failed":
					case "session.execution.interrupted":
						if (sessionID) host.compactPending.delete(sessionID);
						break;
				}
			}
		} catch (error) {
			if (!controller.signal.aborted) log("warn", `event stream ended: ${describe(error)}`);
		}
	})();
	return () => controller.abort();
}
