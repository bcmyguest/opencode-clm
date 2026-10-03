/**
 * Settings: plugin options (the `plugin` entry in opencode.json) override environment
 * variables, which override the defaults. Parsed once when the plugin loads; an invalid
 * value throws an error naming the setting, so OpenCode reports the plugin as failed
 * instead of running with a guess.
 *
 * Setting set adapted from pi-clm src/settings.ts (MIT, Copyright 2026 Emanuel Casco).
 * Per-session overrides (`/clm config`) live in src/settings-table.ts and src/overrides.ts.
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_BUDGET_POLICY, resolveBudgetPolicy, type BudgetPolicyConfig } from "./budget.ts";
import { parseObservationCap, resolveObservationCap, type ObservationCapPolicy } from "./observation.ts";
import { toEditGate, type EditGate } from "./policy.ts";

export interface ClmSettings {
	enabled: boolean;
	budget: BudgetPolicyConfig;
	gate: EditGate;
	guard: "withhold" | "off";
	/** Per-result cap on tool output in the effective context; `maxCharacters` undefined = off. */
	observationCap: ObservationCapPolicy;
	/** Parent directory of the per-session mirror directories. */
	mirrorDir: string;
	/** Steering document path; undefined means protocol only. */
	steeringPath?: string;
	/** `/clm-compact` template path; undefined means the built-in prompt. */
	compactPromptPath?: string;
	/** Multiplier on the chars/4 token estimate (dense content: 1.5–2). */
	estimateFactor: number;
	/** Render assistant reasoning in the mirror. */
	reasoning: boolean;
	/** Register the clm-context skill directory with OpenCode. */
	skill: boolean;
	/** Register the /clm and /clm-compact commands. */
	commands: boolean;
	/** Write every transformed request to `<session dir>/requests/nN.json` (debugging). */
	dumpRequests: boolean;
}

export const PACKAGE_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const HOUSE_STEERING = join(PACKAGE_DIR, "steering", "house-brief.md");
export const SKILLS_DIR = join(PACKAGE_DIR, "skills");

type Env = Record<string, string | undefined>;

const OFF_WORDS = ["none", "off"];

function pick(options: Record<string, unknown>, key: string, env: Env, envKey: string): unknown {
	if (options[key] !== undefined) return options[key];
	const raw = env[envKey]?.trim();
	return raw === undefined || raw === "" ? undefined : raw;
}

/** `32000`, `32k`, `1.5m`, `32_000`, `32,000`. */
/** The default `mirrorDir`: `<project>/.opencode/clm`, inside the project, so the model's tools reach it without an external-directory permission. */
export function defaultMirrorDir(directory: string): string {
	return join(directory, ".opencode", "clm");
}

export function parseTokens(value: unknown, name: string): number {
	const text = String(value).trim().toLowerCase().replace(/[_,]/g, "");
	const match = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(text);
	if (!match) throw new Error(`${name} must be a number of tokens (e.g. 32000, 32k), got ${JSON.stringify(value)}`);
	const scale = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1;
	return Math.round(Number(match[1]) * scale);
}

export function parseFlag(value: unknown, name: string): boolean {
	if (typeof value === "boolean") return value;
	const key = String(value).trim().toLowerCase();
	if (["1", "true", "on", "yes"].includes(key)) return true;
	if (["0", "false", "off", "no"].includes(key)) return false;
	throw new Error(`${name} must be true or false, got ${JSON.stringify(value)}`);
}

export function parseFractions(value: unknown, name: string): number[] | "off" {
	if (value === false) return "off";
	const parts: unknown[] = Array.isArray(value)
		? value
		: String(value).trim().toLowerCase() === "off" || String(value).trim().toLowerCase() === "none"
			? []
			: String(value).split(/[\s,/]+/).filter(Boolean);
	if (parts.length === 0) return "off";
	const fractions = parts.map((part) => {
		const number = Number(String(part).trim().replace(/%$/, ""));
		return number > 1 ? number / 100 : number;
	});
	if (fractions.some((fraction) => !Number.isFinite(fraction))) {
		throw new Error(`${name} must be fractions like 0.25,0.5,0.75 (or 25/50/75%), or off; got ${JSON.stringify(value)}`);
	}
	return [...new Set(fractions)];
}

function withName<T>(name: string, parse: () => T): T {
	try {
		return parse();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(message.startsWith(name) ? message : `${name}: ${message}`);
	}
}

/** A path setting: off words mean unset; relative paths resolve against the project. */
function parsePath(value: unknown, directory: string, offWords: string[]): string | undefined {
	const text = String(value).trim();
	if (!text || offWords.includes(text.toLowerCase())) return undefined;
	return resolve(directory, text);
}

export function resolveSettings(options: Record<string, unknown> = {}, env: Env = process.env, directory = process.cwd()): ClmSettings {
	const enabledRaw = pick(options, "enabled", env, "CLM_ENABLED");
	const budgetRaw = pick(options, "budget", env, "CLM_BUDGET");
	const reserveRaw = pick(options, "reserve", env, "CLM_RESERVE");
	const remindRaw = pick(options, "remindAt", env, "CLM_REMIND_AT");
	const gateRaw = pick(options, "gate", env, "CLM_EDIT_GATE");
	const guardRaw = pick(options, "guard", env, "CLM_OVERFLOW");
	const capRaw = pick(options, "observationCap", env, "CLM_OBSERVATION_CAP");
	const dirRaw = pick(options, "mirrorDir", env, "CLM_MIRROR_DIR");
	const steeringRaw = pick(options, "steering", env, "CLM_STEERING");
	const compactRaw = pick(options, "compactPrompt", env, "CLM_COMPACT_PROMPT");
	const factorRaw = pick(options, "estimateFactor", env, "CLM_ESTIMATE_FACTOR");
	const reasoningRaw = pick(options, "reasoning", env, "CLM_REASONING");
	const dumpRaw = pick(options, "dumpRequests", env, "CLM_DUMP_REQUESTS");

	const overrides: Partial<BudgetPolicyConfig> = {};
	if (budgetRaw !== undefined) {
		overrides.contextBudget = String(budgetRaw).trim().toLowerCase() === "window" ? undefined : parseTokens(budgetRaw, "budget");
		if (overrides.contextBudget === 0) throw new Error(`budget must be a positive number of tokens or "window", got ${JSON.stringify(budgetRaw)}`);
	}
	if (reserveRaw !== undefined) overrides.reserve = parseTokens(reserveRaw, "reserve");
	if (remindRaw !== undefined) {
		const fractions = parseFractions(remindRaw, "remindAt");
		if (fractions === "off") {
			overrides.remindAtFractions = [];
			overrides.remindAtReserve = false;
		} else {
			const outside = fractions.find((fraction) => fraction <= 0 || fraction >= 1);
			if (outside !== undefined) {
				throw new Error(`remindAt entries must lie strictly between 0 and 1 (or 0% and 100%), got ${JSON.stringify(remindRaw)}`);
			}
			overrides.remindAtFractions = fractions;
		}
	}
	const budget = withName("budget", () => resolveBudgetPolicy({ ...DEFAULT_BUDGET_POLICY, ...overrides }));

	let guard: ClmSettings["guard"] = "withhold";
	if (guardRaw !== undefined) {
		const text = String(guardRaw).trim().toLowerCase();
		if (text === "withhold" || text === "on" || text === "true") guard = "withhold";
		else if (text === "off" || text === "false") guard = "off";
		else throw new Error(`guard must be withhold or off, got ${JSON.stringify(guardRaw)}`);
	}

	const observationCap = withName("observationCap", () =>
		resolveObservationCap(capRaw === undefined || capRaw === false ? {} : parseObservationCap(String(capRaw), "observationCap")),
	);

	let steeringPath: string | undefined;
	if (steeringRaw !== undefined) {
		const text = String(steeringRaw).trim().toLowerCase();
		steeringPath = ["house", "house-brief", "house-brief.md"].includes(text)
			? HOUSE_STEERING
			: parsePath(steeringRaw, directory, OFF_WORDS);
	}

	const compactPromptPath = compactRaw === undefined ? undefined : parsePath(compactRaw, directory, ["default", ...OFF_WORDS]);

	// Only a number or a numeric string: Number(true) and Number([2]) would pass silently.
	const factorValid = factorRaw === undefined || typeof factorRaw === "number" ||
		(typeof factorRaw === "string" && factorRaw.trim() !== "");
	const estimateFactor = factorRaw === undefined ? 1 : factorValid ? Number(factorRaw) : Number.NaN;
	if (!Number.isFinite(estimateFactor) || estimateFactor < 1 || estimateFactor > 4) {
		throw new Error(`estimateFactor must be between 1 and 4, got ${JSON.stringify(factorRaw)}`);
	}

	return {
		enabled: enabledRaw === undefined ? true : parseFlag(enabledRaw, "enabled"),
		budget,
		gate: gateRaw === undefined ? "fit" : withName("gate (CLM_EDIT_GATE)", () => toEditGate(gateRaw)),
		guard,
		observationCap,
		mirrorDir: dirRaw === undefined ? defaultMirrorDir(directory) : resolve(directory, String(dirRaw)),
		steeringPath,
		compactPromptPath,
		estimateFactor,
		reasoning: reasoningRaw === undefined ? true : parseFlag(reasoningRaw, "reasoning"),
		skill: options.skill === undefined ? true : parseFlag(options.skill, "skill"),
		commands: options.commands === undefined ? true : parseFlag(options.commands, "commands"),
		dumpRequests: dumpRaw === undefined ? false : parseFlag(dumpRaw, "dumpRequests"),
	};
}
