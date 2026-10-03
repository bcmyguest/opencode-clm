// Host data the TUI panel needs, extracted from plain values so it is testable without
// opentui: the server plugin's options, the newest provider count, the model limits and
// the read-only settings rows. Written for this package.

import { resolveBudget } from "../budget.ts";
import type { LatestUsage, PanelModel, PanelSettings, SettingRow } from "../panel/model.ts";
import { formatTokenCount } from "../panel/timeline.ts";
import type { ClmSettings } from "../settings.ts";

/** `opencode-clm`, `opencode-clm@1.2.3`, or a scoped/aliased path ending in it. */
const NPM_SPEC = /(^|\/)opencode-clm(@[^/]*)?$/;

/**
 * Options of the server plugin entry in `api.state.config.plugin`: a spec naming the
 * package, or a `file://` URL equal to the package's own index.ts. Undefined when no entry
 * matches (the caller falls back to the TUI plugin's options).
 */
export function serverPluginOptions(entries: unknown, packageIndexUrl: string): Record<string, unknown> | undefined {
	if (!Array.isArray(entries)) return undefined;
	const target = normalizeUrl(packageIndexUrl);
	for (const entry of entries) {
		const [spec, options] = Array.isArray(entry) ? entry : [entry, undefined];
		if (typeof spec !== "string") continue;
		const matches = spec.startsWith("file:") ? normalizeUrl(spec) === target : NPM_SPEC.test(spec);
		if (!matches) continue;
		return options && typeof options === "object" && !Array.isArray(options) ? (options as Record<string, unknown>) : {};
	}
	return undefined;
}

function normalizeUrl(value: string): string {
	try {
		return decodeURIComponent(new URL(value).pathname).replace(/\/+$/, "");
	} catch {
		return value;
	}
}

interface MessageLike {
	role?: string;
	time?: { created?: number; completed?: number };
	error?: unknown;
	summary?: boolean;
	tokens?: { input?: number; cache?: { read?: number; write?: number } };
	providerID?: string;
	modelID?: string;
}

/**
 * The newest assistant reply with usage, measured as clm.ts measures `observedPrevious`
 * (input + cache read + cache write). Errored and summary messages are skipped.
 */
export function latestUsage(messages: ReadonlyArray<unknown>): LatestUsage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as MessageLike;
		if (message?.role !== "assistant" || message.error || message.summary || !message.tokens) continue;
		const tokens = Number(message.tokens.input ?? 0) + Number(message.tokens.cache?.read ?? 0) + Number(message.tokens.cache?.write ?? 0);
		if (!Number.isFinite(tokens) || tokens <= 0) continue;
		return { tokens, ...(message.time?.completed !== undefined ? { completedAt: message.time.completed } : {}) };
	}
	return undefined;
}

/** Context and output limits of the model of the newest assistant message. */
export function modelLimits(messages: ReadonlyArray<unknown>, providers: ReadonlyArray<unknown>): { context?: number; output?: number } {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as MessageLike;
		if (message?.role !== "assistant" || !message.providerID || !message.modelID) continue;
		const provider = providers.find((item) => (item as { id?: string })?.id === message.providerID) as
			| { models?: Record<string, { limit?: { context?: number; output?: number } }> }
			| undefined;
		const limit = provider?.models?.[message.modelID]?.limit;
		return { context: limit?.context, output: limit?.output };
	}
	return {};
}

/** Budget for sessions without snapshot.json, resolved as the server resolves it. */
export function fallbackBudget(settings: ClmSettings, limits: { context?: number; output?: number }) {
	const resolved = resolveBudget(settings.budget, limits.context, limits.output);
	if (!resolved) return undefined;
	const cap = limits.context !== undefined
		? limits.context - (limits.output !== undefined && limits.output > 0 && limits.output < limits.context ? limits.output : 0)
		: undefined;
	return { budget: resolved.budget, reserve: resolved.reserve, source: resolved.source, ...(cap !== undefined ? { cap } : {}) };
}

/**
 * Read-only settings rows until `/clm config` lands: the values in force, with choices or
 * a placeholder so Enter produces the apply/prompt effect the reducer defines.
 */
export function settingsView(settings: ClmSettings, model: Pick<PanelModel, "enabled" | "budgetInfo" | "timeline" | "mirrorPath">): PanelSettings {
	const onOff = (value: boolean) => (value ? "on" : "off");
	const budget = settings.budget.contextBudget === undefined ? "window" : formatTokenCount(settings.budget.contextBudget);
	const rows: SettingRow[] = [
		{ key: "editing", label: "CLM editing", value: onOff(model.enabled), choices: ["on", "off"], description: "Whether the model's mirror edits are applied. Env: CLM_ENABLED" },
		{ key: "budget", label: "Budget", value: budget, placeholder: "32k, 1.5m or window", description: "Context budget the reminders and the overflow guard measure against. Env: CLM_BUDGET" },
		{ key: "reserve", label: "Reserve", value: formatTokenCount(settings.budget.reserve), placeholder: "2k", description: "Room kept free below the budget. Env: CLM_RESERVE" },
		{ key: "gate", label: "Edit gate", value: settings.gate, choices: ["fit", "shrink", "none"], description: "Which growing edits are accepted. Env: CLM_EDIT_GATE" },
		{ key: "guard", label: "Overflow guard", value: settings.guard === "off" ? "off" : "on", choices: ["on", "off"], description: "Withhold the oldest tool results above budget − reserve. Env: CLM_OVERFLOW" },
		{ key: "reasoning", label: "Reasoning", value: onOff(settings.reasoning), choices: ["on", "off"], description: "Show assistant reasoning in the mirror. Env: CLM_REASONING" },
	];
	const latest = model.timeline.points.at(-1);
	const summary: string[] = [];
	if (latest) summary.push(`Size last request ${latest.measured ? "" : "~"}${formatTokenCount(latest.tokens)}${latest.measured ? " (provider count)" : " (estimate)"}`);
	const info = model.budgetInfo;
	if (info?.overhead !== undefined) summary.push(`Fixed overhead ~${formatTokenCount(info.overhead)} · usable ${formatTokenCount(info.usable ?? 0)}`);
	summary.push(`Files mirror ${model.mirrorPath}`);
	return { rows, summary, changed: [] };
}
