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
 * The `compaction.auto` value a mode asks for; undefined = the user's own config value.
 * pi's `on` is "Pi's default" (its handler leaves compaction alone), so `on` keeps the
 * user's configuration. pi's `auto` cancels threshold compaction while the guard enforces a
 * budget; here the guard already keeps the provider count below OpenCode's threshold
 * (review K1), so `auto` keeps the configuration too and only `off` changes the flag.
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
