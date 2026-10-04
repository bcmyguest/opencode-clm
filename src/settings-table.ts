/**
 * The settings `/clm config` and the panel's settings page can change per session: one
 * descriptor per setting (label, description, panel choices, format, parse), the override
 * shape stored in `overrides.json`, and the pure functions that merge, sanitize and compare
 * overrides. Pure; the file side is in overrides.ts.
 *
 * Table design adapted from pi-clm src/settings.ts (MIT, Copyright 2026 Emanuel Casco). The
 * settings, texts and parsers are this package's: values parse with the same functions as
 * plugin options and environment variables (settings.ts), so all three accept the same text.
 */
import { basename, resolve } from "node:path";

import { FALLBACK_BUDGET, formatPercent, resolveBudget, resolveBudgetPolicy, type BudgetPolicyConfig } from "./budget.ts";
import { MIN_OBSERVATION_CAP, resolveObservationCap } from "./observation.ts";
import { toEditGate, type EditGate } from "./policy.ts";
import { HOUSE_STEERING, parseBudget, parseCompaction, parseCooldown, parseFlag, parseFractions, parseTokens, type ClmSettings, type CompactionMode } from "./settings.ts";

export type SettingKey =
	| "editing" | "budget" | "reserve" | "reminders" | "cooldown" | "gate" | "guard" | "compaction" | "cap" | "steering" | "oneTool" | "trailer"
	| "compactPrompt" | "reasoning";

/**
 * Per-session changes, as stored in overrides.json. Only keys that differ from the base are
 * kept. `null` means "explicitly unset" for optional settings: budget → model window, cap →
 * off, steering → none, compactPrompt → built-in prompt.
 */
export interface ClmOverrides {
	editing?: boolean;
	/** Tokens, a share of the model window as text (`"50%"`), or null for the whole window. */
	budget?: number | BudgetPercent | null;
	reserve?: number;
	/** Reminder fractions; empty disables every reminder, the budget − reserve one included. */
	reminders?: number[];
	/** Reminder cooldown as a share of the budget; 0 is off. */
	cooldown?: number;
	gate?: EditGate;
	guard?: "withhold" | "off";
	compaction?: CompactionMode;
	cap?: number | null;
	capHead?: number;
	/** Absolute path. */
	steering?: string | null;
	/** Absolute path. */
	compactPrompt?: string | null;
	reasoning?: boolean;
	oneTool?: boolean;
	trailer?: boolean;
}

/** A budget percentage as stored in overrides.json: `"50%"`, `"12.5%"`. */
export type BudgetPercent = `${number}%`;

/** Settings in force for one session: the resolved settings plus whether edits apply. */
export interface SettingsValues {
	editing: boolean;
	settings: ClmSettings;
}

export interface FormatContext {
	/** Model context window, shown next to a `window` budget. */
	modelWindow?: number;
	/** Model output limit; a percentage budget is a share of the window minus this. */
	modelOutput?: number;
}

export interface ParseContext {
	/** Relative paths resolve against this directory (the project). */
	directory: string;
}

export interface SettingDescriptor {
	key: SettingKey;
	/** The word typed in `/clm config <name>`. */
	name: string;
	label: string;
	/** What it does; ends with the environment variable that sets the default. */
	description: string;
	/** Values Enter cycles through on the settings page; absent → text prompt. */
	choices?: string[];
	placeholder?: string;
	format(values: SettingsValues, context?: FormatContext): string;
	/** Text → override; throws a user-facing message. */
	parse(text: string, context: ParseContext): ClmOverrides;
}

/** `32000` → `32k`, `1500000` → `1.5m`, `2048` → `2,048`. */
export function compactTokens(value: number): string {
	if (value >= 1_000_000 && value % 10_000 === 0) return `${Number((value / 1_000_000).toFixed(2))}m`;
	if (value >= 1_000 && value % 100 === 0) return `${Number((value / 1_000).toFixed(1))}k`;
	return value.toLocaleString("en-US");
}

const percentText = (fraction: number) => formatPercent(fraction) as BudgetPercent;

/** `"50%"` → 0.5; undefined for anything but a percentage from 1% to 100%. */
export function budgetPercentFraction(value: unknown): number | undefined {
	if (typeof value !== "string" || !/^\d+(?:\.\d+)?%$/.test(value)) return undefined;
	const percent = Number(value.slice(0, -1));
	return percent >= 1 && percent <= 100 ? percent / 100 : undefined;
}

/** The budget fields of a policy for a `budget` override. */
function budgetFields(budget: number | BudgetPercent | null): Pick<BudgetPolicyConfig, "contextBudget" | "contextFraction"> {
	if (budget === null) return { contextBudget: undefined, contextFraction: undefined };
	if (typeof budget === "number") return { contextBudget: budget, contextFraction: undefined };
	const fraction = budgetPercentFraction(budget);
	if (fraction === undefined) throw new Error(`budget must be a percentage from 1% to 100%, got ${JSON.stringify(budget)}`);
	return { contextBudget: undefined, contextFraction: fraction };
}

const onOff = (value: boolean) => (value ? "on" : "off");

function formatReminders(fractions: readonly number[]): string {
	return fractions.length === 0 ? "off" : `${fractions.map((fraction) => Math.round(fraction * 100)).join("/")}%`;
}

function parseReminders(text: string): number[] {
	const parsed = parseFractions(text, "reminders");
	if (parsed === "off") return [];
	if (parsed.some((fraction) => fraction <= 0 || fraction >= 1)) {
		throw new Error(`reminders must be percentages between 0 and 100 like 25/50/75, or off; got "${text}"`);
	}
	return [...parsed].sort((left, right) => left - right);
}

function formatCap(settings: ClmSettings): string {
	const cap = settings.observationCap;
	if (cap.maxCharacters === undefined) return "off";
	const head = Math.round(cap.headFraction * 100);
	return `${compactTokens(cap.maxCharacters)} chars${head === 80 ? "" : ` (${head}% head)`}`;
}

function parseCap(text: string): ClmOverrides {
	const value = text.trim().toLowerCase().replace(/\s*chars?$/, "");
	if (value === "off" || value === "0" || value === "none") return { cap: null };
	const [chars = "", head, ...rest] = value.split(":");
	if (rest.length > 0) throw new Error(`observation cap must be characters[:head fraction] like 10k or 10k:0.5, got "${text}"`);
	const cap = parseTokens(chars, "observation cap");
	if (cap < MIN_OBSERVATION_CAP) throw new Error(`observation cap must be at least ${MIN_OBSERVATION_CAP} characters, got "${text}"`);
	if (head === undefined || head === "") return { cap };
	const capHead = Number(head);
	if (!(capHead > 0 && capHead <= 1)) throw new Error(`observation cap head fraction must be in (0, 1], got "${head}"`);
	return { cap, capHead };
}

function parsePathSetting(text: string, directory: string, unset: string[]): string | null {
	const value = text.trim();
	if (unset.includes(value.toLowerCase())) return null;
	return resolve(directory, value);
}

export const SETTINGS_TABLE: readonly SettingDescriptor[] = [
	{
		key: "editing",
		name: "editing",
		label: "CLM editing",
		description: "Whether this session renders the mirror and applies the model's edits; off sends the raw history. Same as /clm on and /clm off.",
		choices: ["on", "off"],
		// The plugin-wide `enabled: false` (CLM_ENABLED=0) wins over any session value.
		format: (values) => (values.settings.enabled ? onOff(values.editing) : "off (plugin disabled)"),
		parse: (text) => ({ editing: parseFlag(text, "editing") }),
	},
	{
		key: "budget",
		name: "budget",
		label: "Budget",
		description: `Token budget the reminders, the edit gate and the overflow guard measure against, OpenCode's system prompt and tool schemas included. A percentage of the model window minus its output limit (50%; ${compactTokens(FALLBACK_BUDGET)} while the window is unknown), a number (32k), or "window" for all of it. Env: CLM_BUDGET.`,
		placeholder: "50%, 32k, 1.5m, or window",
		format: (values, context) => {
			const policy = values.settings.budget;
			if (policy.contextBudget !== undefined) return compactTokens(policy.contextBudget);
			if (policy.contextFraction !== undefined) {
				const resolved = context?.modelWindow ? resolveBudget(policy, context.modelWindow, context.modelOutput) : undefined;
				return `${formatPercent(policy.contextFraction)}${resolved ? ` (${compactTokens(resolved.budget)})` : ""}`;
			}
			return `window${context?.modelWindow ? ` (${compactTokens(context.modelWindow)})` : ""}`;
		},
		// The settings page pre-fills its prompt with the formatted value: `50% (131,072)`.
		parse: (text) => {
			const parsed = parseBudget(text.replace(/\s*\([^)]*\)\s*$/, ""), "budget");
			switch (parsed.kind) {
				case "window": return { budget: null };
				case "fraction": return { budget: percentText(parsed.fraction) };
				case "tokens": return { budget: parsed.tokens };
			}
		},
	},
	{
		key: "reserve",
		name: "reserve",
		label: "Reserve",
		description: "Tokens kept free below the budget for the reply; the final reminder and the overflow guard act at budget − reserve. Env: CLM_RESERVE.",
		placeholder: "2048 or 2k",
		format: (values) => compactTokens(values.settings.budget.reserve),
		parse: (text) => ({ reserve: parseTokens(text, "reserve") }),
	},
	{
		key: "reminders",
		name: "reminders",
		label: "Reminders",
		description: "Budget fractions at which a [CLM BUDGET] note reaches the model, plus one at budget − reserve; off disables them all. Env: CLM_REMIND_AT.",
		choices: ["25/50/75%", "50/75/90%", "75/90%", "90%", "off"],
		format: (values) => formatReminders(values.settings.budget.remindAtFractions),
		parse: (text) => ({ reminders: parseReminders(text) }),
	},
	{
		key: "cooldown",
		// Named after the reminders it governs; `cooldown` is an alias.
		name: "reminder-cooldown",
		label: "Reminder cooldown",
		description: "After an accepted edit, percentage reminders stay silent until the context grows by this share of the budget; tiers crossed meanwhile are skipped. The budget − reserve reminder always fires. A share (10%, 0.1) or off. Env: CLM_REMINDER_COOLDOWN.",
		choices: ["10%", "25%", "5%", "off"],
		placeholder: "10%, 0.1, or off",
		format: (values) => (values.settings.budget.reminderCooldown > 0 ? formatPercent(values.settings.budget.reminderCooldown) : "off"),
		parse: (text) => ({ cooldown: parseCooldown(text, "reminder-cooldown") }),
	},
	{
		key: "gate",
		name: "gate",
		label: "Edit gate",
		description: "Which edits that grow the context are accepted: fit (while it stays within budget − reserve), shrink (none), none (no size check). Env: CLM_EDIT_GATE.",
		choices: ["fit", "shrink", "none"],
		format: (values) => values.settings.gate,
		parse: (text) => ({ gate: toEditGate(text) }),
	},
	{
		key: "guard",
		name: "guard",
		label: "Overflow guard",
		description: "Above budget − reserve, hold back the oldest new tool results (full text saved to files) so the request fits. Env: CLM_OVERFLOW.",
		choices: ["on", "off"],
		format: (values) => onOff(values.settings.guard === "withhold"),
		parse: (text) => ({ guard: parseFlag(text.trim().toLowerCase() === "withhold" ? "on" : text, "guard") ? "withhold" : "off" }),
	},
	{
		key: "compaction",
		name: "compaction",
		label: "OC compaction",
		description: "OpenCode's automatic compaction: off turns it off (a provider overflow is then reported, not compacted); auto and on leave your config's compaction.auto (under auto the overflow guard keeps requests below OpenCode's threshold). Manual /compact always works. The flag is shared by every session of the server. Env: CLM_NATIVE_COMPACTION.",
		choices: ["auto", "off", "on"],
		format: (values) => values.settings.compaction,
		parse: (text) => ({ compaction: parseCompaction(text) }),
	},
	{
		key: "cap",
		name: "cap",
		label: "Observation cap",
		description: "Keep at most this many characters of each tool result in the context (head and tail); 10k:0.5 keeps 5k + 5k. Env: CLM_OBSERVATION_CAP.",
		// Written as the format shows them, so cycling finds the current value.
		choices: ["off", "5k chars", "10k chars", "20k chars", "50k chars"],
		placeholder: "10k or 10k:0.5",
		format: (values) => formatCap(values.settings),
		parse: parseCap,
	},
	{
		key: "steering",
		name: "steering",
		label: "Steering",
		description: "Markdown guidance appended to the system prompt: a path, \"house\" for the bundled brief, or none. Env: CLM_STEERING.",
		choices: ["none", "house-brief.md"],
		placeholder: "path/to/brief.md, house, or none",
		format: (values) => (values.settings.steeringPath ? basename(values.settings.steeringPath) : "none"),
		parse: (text, context) => {
			const value = text.trim().toLowerCase();
			if (["house", "house-brief", "house-brief.md"].includes(value)) return { steering: HOUSE_STEERING };
			return { steering: parsePathSetting(text, context.directory, ["none", "off", ""]) };
		},
	},
	{
		key: "oneTool",
		name: "one-tool",
		label: "One tool per turn",
		description: "Paper-harness parity: run only the first tool call of each model response; later calls in it fail with a note to repeat them. Env: CLM_ONE_TOOL_PER_TURN.",
		choices: ["off", "on"],
		format: (values) => onOff(values.settings.oneTool),
		parse: (text) => ({ oneTool: parseFlag(text, "one-tool") }),
	},
	{
		key: "trailer",
		name: "trailer",
		label: "Size trailer",
		description: "Paper-harness parity: end every successful tool result with \"[context: ~N of B tokens after this result]\". Env: CLM_SIZE_TRAILER.",
		choices: ["off", "on"],
		format: (values) => onOff(values.settings.trailer),
		parse: (text) => ({ trailer: parseFlag(text, "trailer") }),
	},
	{
		key: "compactPrompt",
		name: "compact-prompt",
		label: "Compact prompt",
		description: "Template /clm-compact sends in place of the built-in prompt; may use {{mirror}} {{current}} {{budget}} {{instructions}}. A path, or default. Env: CLM_COMPACT_PROMPT.",
		placeholder: "path/to/prompt.md, or default",
		format: (values) => (values.settings.compactPromptPath ? basename(values.settings.compactPromptPath) : "default"),
		parse: (text, context) => ({ compactPrompt: parsePathSetting(text, context.directory, ["default", "none", "off", ""]) }),
	},
	{
		key: "reasoning",
		name: "reasoning",
		label: "Reasoning",
		description: "Show the assistant's reasoning in the mirror. Env: CLM_REASONING.",
		choices: ["on", "off"],
		format: (values) => onOff(values.settings.reasoning),
		parse: (text) => ({ reasoning: parseFlag(text, "reasoning") }),
	},
];

const ALIASES: Record<string, SettingKey> = {
	editing: "editing",
	enabled: "editing",
	budget: "budget",
	reserve: "reserve",
	reminders: "reminders",
	remind: "reminders",
	"remind-at": "reminders",
	remindat: "reminders",
	cooldown: "cooldown",
	"reminder-cooldown": "cooldown",
	remindercooldown: "cooldown",
	gate: "gate",
	"edit-gate": "gate",
	guard: "guard",
	overflow: "guard",
	compaction: "compaction",
	"native-compaction": "compaction",
	cap: "cap",
	observation: "cap",
	"observation-cap": "cap",
	observationcap: "cap",
	steering: "steering",
	"one-tool": "oneTool",
	onetool: "oneTool",
	"one-tool-per-turn": "oneTool",
	trailer: "trailer",
	"size-trailer": "trailer",
	sizetrailer: "trailer",
	"compact-prompt": "compactPrompt",
	compactprompt: "compactPrompt",
	reasoning: "reasoning",
};

/** Names `/clm config` lists. */
export const SETTING_NAMES: readonly string[] = SETTINGS_TABLE.map((item) => item.name);

/** The descriptor for a typed name (case-insensitive, aliases accepted). */
export function settingDescriptor(name: string): SettingDescriptor | undefined {
	const key = ALIASES[name.trim().toLowerCase()];
	return key ? SETTINGS_TABLE.find((item) => item.key === key) : undefined;
}

export function unknownSettingText(name: string): string {
	return `Unknown setting "${name}". Settings: ${SETTING_NAMES.join(", ")}.`;
}

/**
 * Base settings with overrides applied. Throws when the result is invalid (the same checks
 * as plugin options). Reminders changed here also switch the budget − reserve reminder on or
 * off with them, as `remindAt: off` does.
 */
export function applyOverrides(base: ClmSettings, overrides: ClmOverrides): ClmSettings {
	const budget = resolveBudgetPolicy({
		...base.budget,
		...(overrides.budget !== undefined
			? budgetFields(overrides.budget)
			: { contextBudget: base.budget.contextBudget, contextFraction: base.budget.contextFraction }),
		reserve: overrides.reserve ?? base.budget.reserve,
		remindAtFractions: overrides.reminders ?? base.budget.remindAtFractions,
		remindAtReserve: overrides.reminders !== undefined ? overrides.reminders.length > 0 : base.budget.remindAtReserve,
		reminderCooldown: overrides.cooldown ?? base.budget.reminderCooldown,
	});
	const observationCap = resolveObservationCap({
		maxCharacters: overrides.cap === null ? undefined : overrides.cap ?? base.observationCap.maxCharacters,
		headFraction: overrides.capHead ?? base.observationCap.headFraction,
	});
	return {
		...base,
		budget,
		gate: overrides.gate ?? base.gate,
		guard: overrides.guard ?? base.guard,
		compaction: overrides.compaction ?? base.compaction,
		oneTool: overrides.oneTool ?? base.oneTool,
		trailer: overrides.trailer ?? base.trailer,
		observationCap,
		steeringPath: overrides.steering === null ? undefined : overrides.steering ?? base.steeringPath,
		compactPromptPath: overrides.compactPrompt === null ? undefined : overrides.compactPrompt ?? base.compactPromptPath,
		reasoning: overrides.reasoning ?? base.reasoning,
	};
}

/** The override-shaped value of each key in `values` (null for an unset optional). */
function baseValue(key: keyof ClmOverrides, values: SettingsValues): unknown {
	const settings = values.settings;
	switch (key) {
		case "editing": return values.editing;
		case "budget": return settings.budget.contextBudget ??
			(settings.budget.contextFraction !== undefined ? percentText(settings.budget.contextFraction) : null);
		case "reserve": return settings.budget.reserve;
		case "reminders": return settings.budget.remindAtReserve || settings.budget.remindAtFractions.length > 0 ? [...settings.budget.remindAtFractions] : [];
		case "cooldown": return settings.budget.reminderCooldown;
		case "gate": return settings.gate;
		case "guard": return settings.guard;
		case "compaction": return settings.compaction;
		case "oneTool": return settings.oneTool;
		case "trailer": return settings.trailer;
		case "cap": return settings.observationCap.maxCharacters ?? null;
		case "capHead": return settings.observationCap.headFraction;
		case "steering": return settings.steeringPath ?? null;
		case "compactPrompt": return settings.compactPromptPath ?? null;
		case "reasoning": return settings.reasoning;
	}
}

/**
 * Every table setting of `settings` in override form (editing excluded: its base is
 * state.json). The server writes this into snapshot.json, so a TUI whose environment
 * resolves differently validates and merges against the server's base:
 * `applyOverrides(ownBase, serverBase)` reproduces it.
 */
export function settingsAsOverrides(settings: ClmSettings): ClmOverrides {
	const values: SettingsValues = { editing: true, settings };
	const keys: Array<keyof ClmOverrides> = ["budget", "reserve", "reminders", "cooldown", "gate", "guard", "compaction", "cap", "capHead", "steering", "oneTool", "trailer", "compactPrompt", "reasoning"];
	return Object.fromEntries(keys.map((key) => [key, baseValue(key, values)])) as ClmOverrides;
}

/** `current` with `change` applied and every key equal to the base dropped, so "changed" means changed. */
export function mergeOverrides(base: SettingsValues, current: ClmOverrides, change: ClmOverrides): ClmOverrides {
	const next: Record<string, unknown> = { ...current, ...change };
	for (const key of Object.keys(next) as Array<keyof ClmOverrides>) {
		if (next[key] === undefined || JSON.stringify(next[key]) === JSON.stringify(baseValue(key, base))) delete next[key];
	}
	return next as ClmOverrides;
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isPath = (value: unknown) => value === null || (typeof value === "string" && value.trim() !== "");

const VALID: Record<keyof ClmOverrides, (value: unknown) => boolean> = {
	editing: (value) => typeof value === "boolean",
	// Integers: state.json's budget check stores them as counts.
	budget: (value) => value === null || (Number.isInteger(value) && (value as number) > 0) || budgetPercentFraction(value) !== undefined,
	reserve: (value) => Number.isInteger(value) && (value as number) >= 0,
	reminders: (value) => Array.isArray(value) && value.every((fraction) => isNumber(fraction) && fraction > 0 && fraction < 1),
	cooldown: (value) => isNumber(value) && value >= 0 && value < 1,
	gate: (value) => value === "fit" || value === "shrink" || value === "none",
	guard: (value) => value === "withhold" || value === "off",
	compaction: (value) => value === "auto" || value === "off" || value === "on",
	oneTool: (value) => typeof value === "boolean",
	trailer: (value) => typeof value === "boolean",
	cap: (value) => value === null || (isNumber(value) && value >= MIN_OBSERVATION_CAP),
	capHead: (value) => isNumber(value) && value > 0 && value <= 1,
	steering: isPath,
	compactPrompt: isPath,
	reasoning: (value) => typeof value === "boolean",
};

/**
 * The well-formed part of stored overrides and the names of what was dropped. A hand edit or
 * a file from another version must never break a session.
 */
export function sanitizeOverrides(raw: unknown): { overrides: ClmOverrides; ignored: string[] } {
	if (raw === undefined || raw === null) return { overrides: {}, ignored: [] };
	if (typeof raw !== "object" || Array.isArray(raw)) return { overrides: {}, ignored: ["overrides"] };
	const overrides: Record<string, unknown> = {};
	const ignored: string[] = [];
	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined) continue;
		if (Object.hasOwn(VALID, key) && VALID[key as keyof ClmOverrides](value)) overrides[key] = value;
		else ignored.push(key);
	}
	return { overrides: overrides as ClmOverrides, ignored };
}

/** Keys whose value in `effective` differs from `base`. */
export function changedSettings(base: SettingsValues, effective: SettingsValues): SettingKey[] {
	return SETTINGS_TABLE.filter((item) =>
		item.format(base) !== item.format(effective) ||
		(item.key === "steering" && base.settings.steeringPath !== effective.settings.steeringPath) ||
		(item.key === "compactPrompt" && base.settings.compactPromptPath !== effective.settings.compactPromptPath),
	).map((item) => item.key);
}

/** `budget 20k, guard off` for status text; empty when nothing changed. */
export function changedSummary(base: SettingsValues, effective: SettingsValues, context?: FormatContext): string {
	return changedSettings(base, effective)
		.map((key) => SETTINGS_TABLE.find((item) => item.key === key)!)
		.map((item) => `${item.name} ${item.format(effective, context)}`)
		.join(", ");
}

/** `Budget: 20k — <description>`, the answer to `/clm config <setting>`. */
export function describeSetting(item: SettingDescriptor, values: SettingsValues, context?: FormatContext): string {
	return `${item.label}: ${item.format(values, context)} — ${item.description}`;
}

/** Every setting with its value, for `/clm config` outside the TUI. */
export function settingsText(base: SettingsValues, effective: SettingsValues, context?: FormatContext, warning?: string): string {
	const changed = new Set(changedSettings(base, effective));
	const rows = SETTINGS_TABLE.map((item) =>
		`${item.label.padEnd(16)} ${item.format(effective, context)}${changed.has(item.key) ? `  (changed; default ${item.format(base, context)})` : ""}`);
	return [
		"CLM settings for this session (changes apply from the next request):",
		...rows,
		...(warning ? [`warning: ${warning}`] : []),
		"",
		`Change with /clm config <${SETTING_NAMES.join("|")}> <value>, or /clm config reset.`,
	].join("\n");
}
