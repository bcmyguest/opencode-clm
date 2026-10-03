// The `compaction`, `one-tool` and `trailer` settings: pure decisions for index.ts.
// Semantics follow pi-clm's `PI_CLM_NATIVE_COMPACTION`, `oneToolPerTurn` and `sizeTrailer`
// (pi-clm src/index.ts, MIT, Copyright 2026 Emanuel Casco); texts and the OpenCode mapping
// are this package's.
//
// OpenCode 1.18.34 has one flag for automatic compaction, `compaction.auto` in the config.
// It gates both threshold compaction (session/overflow.ts:28, checked at
// session/processor.ts:491 after each step and session/prompt.ts:1161 before the next) and
// recovery from a provider overflow error (session/processor.ts:620-628). Every check reads
// `config.get()`, the object the plugin's `config` hook received (plugin/index.ts:152,245-252;
// config/config.ts:620-622), so setting the key on that object takes effect at once, for
// every session of the instance.

import type { CompactionMode } from "./settings.ts";

/**
 * The `compaction.auto` value a mode asks for outside a pause; undefined = the user's own
 * config value. pi's `on` is "Pi's default" (its handler leaves compaction alone), so `on`
 * keeps the user's configuration. pi's `auto` cancels threshold compaction while the guard
 * enforces a budget; here `auto` keeps the configuration and index.ts turns the flag off
 * per request only when the threshold can fire (`thresholdReachable`, K1).
 */
export function compactionAuto(mode: CompactionMode, userAuto: boolean | undefined): boolean | undefined {
	return mode === "off" ? false : userAuto;
}

/** Sets `config.compaction.auto` for `mode`, restoring the user's value (or its absence) for `auto`. */
export function applyCompactionMode(config: { compaction?: { auto?: boolean } }, mode: CompactionMode, userAuto: boolean | undefined): void {
	const value = compactionAuto(mode, userAuto);
	if (value === undefined) {
		if (config.compaction && "auto" in config.compaction) delete config.compaction.auto;
		return;
	}
	(config.compaction ??= {}).auto = value;
}

/** Toast after OpenCode compacted a session on its own. */
export function nativeCompactionText(overflow: boolean, mode: CompactionMode): string {
	const why = overflow ? "after the provider reported a context overflow" : "at its token threshold";
	const hint = mode === "off" ? "" : " Set /clm config compaction off to keep the model's own edits instead.";
	return `OpenCode compacted this session ${why}; CLM continues from the summary.${hint}`;
}

/** Model notice when a provider overflow was not compacted because `compaction.auto` was false. */
export function overflowNotCompactedText(mirrorPath: string): string {
	return `[CLM] The provider rejected the last request as too long, and OpenCode's automatic compaction is off, so nothing was compacted. Shrink the context by editing ${mirrorPath}, or ask the user to run /compact.`;
}

/**
 * Per-session count of tool calls since the session's last model request. `next` must run
 * synchronously at the start of `tool.execute.before`: parallel calls of one response
 * reach the hook concurrently, so "first" means first to arrive, not first in the response.
 */
export class ToolCallCounter {
	private readonly counts = new Map<string, number>();

	/** Called for every model request of the session. */
	reset(sessionID: string): void {
		this.counts.delete(sessionID);
	}

	/** This call's position (1-based) in the current response. */
	next(sessionID: string): number {
		const count = (this.counts.get(sessionID) ?? 0) + 1;
		this.counts.set(sessionID, count);
		return count;
	}
}

/** The error a blocked call returns to the model. */
export function oneToolText(tool: string, position: number): string {
	return `[CLM] One tool call per response (setting one-tool): this ${tool} call was #${position} in the response and did not run. Call it again on its own in your next response.`;
}

/** `\n[context: ~N of B tokens after this result]`, appended to a tool result. */
export function sizeTrailer(estimated: number, resultTokens: number, budget: number): string {
	const format = (value: number) => value.toLocaleString("en-US");
	return `\n[context: ~${format(estimated + resultTokens)} of ${format(budget)} tokens after this result]`;
}

// ---- `auto`: pausing threshold compaction while the guard enforces a budget (K1, K5) ----
//
// pi's `auto` cancels every threshold compaction while the overflow guard enforces a budget
// (pi-clm src/index.ts `session_before_compact`) and leaves overflow recovery to Pi. OpenCode
// gives no cancel hook and one flag for both. So before each request the plugin predicts
// whether OpenCode's threshold check on that request's count can fire, and sets the flag false
// only then; below the threshold the user's value (and with it overflow recovery) stays.
//
// The threshold check reads the count of one finished request (`tokens.total`, input plus
// output) after that request's step (session/processor.ts:491) and again before the next
// step (session/prompt.ts:1161, `lastFinished`); both run after this request's transform and
// before the next one, so the flag set here governs exactly this request's count.

/** OpenCode's default output cap (provider/transform.ts:18 `OUTPUT_TOKEN_MAX`). */
export const OPENCODE_OUTPUT_TOKEN_MAX = 32_000;
/** OpenCode's `COMPACTION_BUFFER` (session/overflow.ts:8). */
const OPENCODE_COMPACTION_BUFFER = 20_000;

/** The model limits OpenCode's threshold reads (`Provider.Model.limit`). */
export interface ThresholdModel {
	context?: number;
	input?: number;
	output?: number;
}

/** `ProviderTransform.maxOutputTokens` (provider/transform.ts:1481-1483). */
export function openCodeMaxOutput(output: number | undefined, outputTokenMax = OPENCODE_OUTPUT_TOKEN_MAX): number {
	return Math.min(output ?? 0, outputTokenMax) || outputTokenMax;
}

/**
 * The `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` runtime flag (effect/runtime-flags.ts:52), a
 * positive integer; undefined when unset or invalid.
 */
export function outputTokenMaxFlag(env: Record<string, string | undefined> = process.env): number | undefined {
	const value = Number(env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX);
	return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * OpenCode's threshold (session/overflow.ts:10-20 `usable`); undefined when the window is
 * unknown or 0 (OpenCode then never compacts at a threshold). processor.ts:491 calls it
 * without the output-cap flag and prompt.ts:1161 with it; the lower of the two is returned.
 */
export function openCodeUsable(model: ThresholdModel, reserved: number | undefined, outputTokenMax?: number): number | undefined {
	const context = model.context ?? 0;
	if (context <= 0) return undefined;
	const usable = (cap: number) => {
		const maxOutput = openCodeMaxOutput(model.output, cap);
		const reserve = reserved ?? Math.min(OPENCODE_COMPACTION_BUFFER, maxOutput);
		return model.input ? Math.max(0, model.input - reserve) : Math.max(0, context - maxOutput);
	};
	return Math.min(usable(OPENCODE_OUTPUT_TOKEN_MAX), usable(outputTokenMax ?? OPENCODE_OUTPUT_TOKEN_MAX));
}

/** Token fields of an OpenCode assistant message (`SessionV1.Assistant["tokens"]`). */
export interface StepTokens {
	total?: number;
	input?: number;
	output?: number;
	cache?: { read?: number; write?: number };
}

/** The count OpenCode compares with the threshold (session/overflow.ts:31-32). */
export function openCodeCount(tokens: StepTokens): number {
	const parts = Number(tokens.input ?? 0) + Number(tokens.output ?? 0) + Number(tokens.cache?.read ?? 0) + Number(tokens.cache?.write ?? 0);
	return Number(tokens.total ?? 0) || parts;
}

/**
 * `auto` with the guard on: whether OpenCode's threshold check can fire on this request, i.e.
 * the request's estimate plus the most it may generate reaches the threshold. The output
 * allowance is OpenCode's own output cap for the request, so the prediction errs toward
 * pausing (pi pauses every threshold compaction).
 */
export function thresholdReachable(estimated: number, usable: number, maxOutput: number): boolean {
	return estimated + maxOutput >= usable;
}

/**
 * Per-session record of the flag the plugin set for each request and of threshold
 * crossings, for K5: a step whose count reached the threshold while the plugin held the flag
 * false is a threshold compaction the plugin cancelled. Reported once per crossing; a step
 * below the threshold or a compaction re-arms it.
 */
export class ThresholdWatch {
	private readonly sessions = new Map<string, { by?: "auto" | "off"; checked?: string; crossing: boolean }>();

	/**
	 * The flag this session's request ran under: `by` names the mode that turned it off
	 * against the user's value (`auto` paused it, `off` forced it); undefined when it was not.
	 */
	set(sessionID: string, by: "auto" | "off" | undefined): void {
		const entry = this.sessions.get(sessionID) ?? { crossing: false };
		entry.by = by;
		this.sessions.set(sessionID, entry);
	}

	/** The mode that turned the flag off for the session's last request, if any. */
	by(sessionID: string): "auto" | "off" | undefined {
		return this.sessions.get(sessionID)?.by;
	}

	/** A compaction ran: the next crossing is a new one. */
	reset(sessionID: string): void {
		const entry = this.sessions.get(sessionID);
		if (entry) entry.crossing = false;
	}

	/**
	 * The newest finished step of the session (not a summary), seen at the next transform.
	 * Returns its count and the mode when the plugin's flag cancelled a threshold compaction on
	 * it and this crossing was not reported yet; undefined otherwise. Each step is judged once.
	 */
	observe(sessionID: string, step: { id: string; count: number } | undefined, usable: number | undefined): { count: number; by: "auto" | "off" } | undefined {
		const entry = this.sessions.get(sessionID);
		if (!entry || !step || step.id === entry.checked) return undefined;
		entry.checked = step.id;
		if (usable === undefined || step.count < usable) {
			entry.crossing = false;
			return undefined;
		}
		if (!entry.by || entry.crossing) return undefined;
		entry.crossing = true;
		return { count: step.count, by: entry.by };
	}
}

/** Toast when `auto` paused a threshold compaction (pi: toast only). */
export function thresholdPausedText(count: number, usable: number, guardLimit: number | undefined): string {
	const format = (value: number) => value.toLocaleString("en-US");
	const guard = guardLimit !== undefined ? `; the overflow guard keeps the context under ~${format(guardLimit)} tokens` : "";
	return `Paused OpenCode's threshold compaction: the last request counted ${format(count)} of OpenCode's ${format(usable)}-token threshold${guard}. Set /clm config compaction on to let OpenCode compact.`;
}

/** Model notice when `off` cancelled a threshold compaction (pi: notice and toast). */
export function thresholdCancelledNoticeText(mirrorPath: string): string {
	return `[CLM] OpenCode's automatic compaction (threshold) was cancelled: CLM manages this context. Free space by editing ${mirrorPath}.`;
}

/** Toast when `off` cancelled a threshold compaction. */
export function thresholdCancelledText(count: number, usable: number): string {
	const format = (value: number) => value.toLocaleString("en-US");
	return `Cancelled OpenCode's threshold compaction (setting compaction off): the last request counted ${format(count)} of ${format(usable)} tokens.`;
}

/**
 * The step OpenCode's pre-step check reads (`MessageV2.latest(...).finished`,
 * session/message-v2.ts:586-602): the newest assistant message with `finish` set, by
 * creation time then id. Undefined when there is none or it is a compaction summary
 * (prompt.ts:1163 skips summaries).
 */
export function lastFinishedStep(raw: readonly { info: { id: string; role: string; [key: string]: any } }[]): { id: string; count: number } | undefined {
	let finished: { id: string; role: string; [key: string]: any } | undefined;
	for (const { info } of raw) {
		if (info.role !== "assistant" || !info.finish) continue;
		const created = Number(info.time?.created ?? 0);
		const newest = Number(finished?.time?.created ?? 0);
		if (!finished || created > newest || (created === newest && info.id > finished.id)) finished = info;
	}
	if (!finished || finished.summary === true || !finished.tokens) return undefined;
	return { id: finished.id, count: openCodeCount(finished.tokens as StepTokens) };
}
