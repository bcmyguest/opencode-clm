/**
 * Budget and reminder policy.
 *
 * Adapted from pi-clm src/budget.ts (MIT, Copyright 2026 Emanuel Casco).
 * Default reminder steps (25/50/75 % of the budget) follow the CLM paper harness design;
 * pi-clm uses 50/75/90. Text written for this package.
 *
 * Two measurements are kept apart and always labelled:
 *
 * - `estimated`: the harness estimate of the *next* request (pinned task + editable
 *   context + notices, plus the system prompt and tool schemas once their sizes are
 *   known). Available before every call.
 * - `observed`: the provider-reported input size of the *previous* request (OpenCode's
 *   assistant `tokens`). Authoritative but one call late.
 *
 * The estimate alone governs reminder tiers and the reminder text; `observed` calibrates
 * the estimate and is shown for reference. The harness never
 * blocks a request; the overflow guard (overflow.ts) withholds old tool output when the
 * estimate exceeds budget - reserve.
 */
export interface BudgetPolicyConfig {
	/**
	 * Context budget in tokens the reminders are measured against. Advisory: requests are
	 * never blocked or rolled back. When undefined, `contextFraction` decides; when both are
	 * undefined, the budget is the model context window (the `window` setting).
	 */
	contextBudget?: number;
	/**
	 * Budget as a fraction (0 < f <= 1) of the model window minus its output limit, used when
	 * `contextBudget` is undefined (the `50%` setting). With the window unknown the budget is
	 * `FALLBACK_BUDGET`.
	 */
	contextFraction?: number;
	/** Generation headroom reserved below the budget. The final reminder fires at budget - reserve. */
	reserve: number;
	/** Fractions of the budget at which escalating reminders fire (0 < f < 1), ascending. */
	remindAtFractions: readonly number[];
	/** Whether to fire the final "budget - reserve" reminder. */
	remindAtReserve: boolean;
}

/** Budget when a percentage budget meets an unknown model window. */
export const FALLBACK_BUDGET = 32_000;

export const DEFAULT_BUDGET_POLICY: BudgetPolicyConfig = {
	contextFraction: 0.5,
	reserve: 2048,
	remindAtFractions: [0.25, 0.5, 0.75],
	remindAtReserve: true,
};

/**
 * Room the conversation needs on top of OpenCode's fixed overhead (system prompt and tool
 * schemas) and the reserve: the pinned task, a few tool results and the model's own edits.
 * A budget with less room than this makes the overflow guard withhold nearly every tool
 * result; `budgetFit` then raises the session's effective budget.
 */
export const WORKING_MARGIN = 8000;

export interface BudgetReading {
	/** Effective budget in tokens (config or model window). */
	budget: number;
	reserve: number;
	/**
	 * Harness estimate of the conversation in the next request, in tokens: pinned task,
	 * editable context, and notices. Excludes the system prompt and tool schemas.
	 */
	estimated: number;
	/** What the estimate knowingly leaves out, named in the notice so the gap is not misread. */
	estimateExcludes?: string;
	/** Calibration factor applied to the raw character estimate (1 = none). */
	calibration?: number;
	/**
	 * Provider-reported tokens of the previous request, when known. Includes the system
	 * prompt and tool schemas, so it is displayed but never governs reminders.
	 */
	observed?: number;
	/**
	 * True when a context edit was accepted after the observed request, so `observed`
	 * describes a context that no longer exists. The notice says so.
	 */
	observedStale?: boolean;
	/**
	 * Where `budget` came from, for status text: `config` (a token count), `model-window`
	 * (the window, or a token count capped by it), `window-fraction` (`fraction` of the
	 * window), `fallback` (`FALLBACK_BUDGET`: a percentage with the window unknown).
	 */
	source: BudgetSource;
	/** The configured fraction, for `window-fraction` and `fallback`. */
	fraction?: number;
	/** Set when `budget` was raised above the configured value to cover the fixed overhead (see `budgetFit`). */
	raisedFrom?: number;
}

export type BudgetSource = "config" | "model-window" | "window-fraction" | "fallback";

/** A reminder threshold in absolute tokens plus a stable label for re-arming. */
export interface BudgetTier {
	label: string;
	tokens: number;
}

/**
 * Defaults plus `overrides`, validated. An own `contextBudget` key without an own
 * `contextFraction` key replaces the default fraction (`{ contextBudget: undefined }` still
 * means "the model window"); a defined `contextBudget` always clears `contextFraction`.
 */
export function resolveBudgetPolicy(overrides: Partial<BudgetPolicyConfig> | undefined): BudgetPolicyConfig {
	const merged: BudgetPolicyConfig = { ...DEFAULT_BUDGET_POLICY, ...(overrides ?? {}) };
	const budgetGiven = overrides !== undefined && Object.hasOwn(overrides, "contextBudget");
	const fractionGiven = overrides !== undefined && Object.hasOwn(overrides, "contextFraction");
	if (merged.contextBudget !== undefined || (budgetGiven && !fractionGiven)) delete merged.contextFraction;
	if (merged.contextBudget !== undefined && (!Number.isFinite(merged.contextBudget) || merged.contextBudget <= 0)) {
		throw new Error(`contextBudget must be a positive number of tokens, got ${String(merged.contextBudget)}`);
	}
	if (merged.contextFraction !== undefined && (!Number.isFinite(merged.contextFraction) || merged.contextFraction <= 0 || merged.contextFraction > 1)) {
		throw new Error(`contextFraction must be in (0, 1], got ${String(merged.contextFraction)}`);
	}
	if (merged.contextFraction === undefined) delete merged.contextFraction;
	if (merged.contextBudget === undefined) delete merged.contextBudget;
	if (!Number.isFinite(merged.reserve) || merged.reserve < 0) {
		throw new Error(`reserve must be a nonnegative number of tokens, got ${String(merged.reserve)}`);
	}
	const fractions = [...merged.remindAtFractions];
	for (const fraction of fractions) {
		if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
			throw new Error(`remindAtFractions entries must be in (0, 1), got ${String(fraction)}`);
		}
	}
	fractions.sort((left, right) => left - right);
	return { ...merged, remindAtFractions: fractions };
}

/**
 * Effective budget against the model window minus its output allowance (the base): a token
 * count, capped by the base when that is smaller; else `contextFraction` of the base
 * (default 50%), or `FALLBACK_BUDGET` with the window unknown; else the base itself. An
 * output limit that is not finite, <= 0, or >= the window is ignored. Undefined only for
 * the `window` setting with the window unknown.
 */
export function resolveBudget(
	policy: BudgetPolicyConfig,
	modelContextWindow: number | undefined,
	modelOutputLimit = 0,
): Pick<BudgetReading, "budget" | "reserve" | "source" | "fraction"> | undefined {
	const window = modelContextWindow !== undefined && Number.isFinite(modelContextWindow) && modelContextWindow > 0
		? modelContextWindow - (Number.isFinite(modelOutputLimit) && modelOutputLimit > 0 && modelOutputLimit < modelContextWindow ? modelOutputLimit : 0)
		: undefined;
	if (policy.contextBudget !== undefined && (window === undefined || policy.contextBudget <= window)) {
		return { budget: policy.contextBudget, reserve: Math.min(policy.reserve, policy.contextBudget), source: "config" };
	}
	const fraction = policy.contextBudget === undefined ? policy.contextFraction : undefined;
	if (fraction !== undefined) {
		const budget = window !== undefined ? Math.max(1, Math.floor(window * fraction)) : FALLBACK_BUDGET;
		return { budget, reserve: Math.min(policy.reserve, budget), source: window !== undefined ? "window-fraction" : "fallback", fraction };
	}
	if (window !== undefined) {
		return { budget: window, reserve: Math.min(policy.reserve, window), source: "model-window" };
	}
	return undefined;
}

/** Budget arithmetic for status text, the TUI panel and the budget-too-small check. */
export interface BudgetFit {
	/** Budget before any raise (configured, or the model window). */
	configured: number;
	reserve: number;
	/** OpenCode's fixed overhead per request in tokens; undefined until measured. */
	overhead?: number;
	/** configured − reserve − overhead: what the conversation gets without a raise (may be negative). */
	usable?: number;
	/** True when configured − reserve leaves less than `margin` after the overhead. */
	tooSmall: boolean;
	/** overhead + margin + reserve: the smallest budget that leaves the margin. */
	minimum?: number;
	/** The budget CLM applies: `configured`, or raised toward `minimum` (capped by `cap`). */
	effective: number;
	/** effective − reserve − overhead. */
	effectiveUsable?: number;
	raised: boolean;
	/** True when `cap` stopped the raise short of `minimum`. */
	capped: boolean;
	margin: number;
}

/**
 * Pure: how the budget compares with OpenCode's fixed overhead. When budget − reserve leaves
 * less than `margin` after the overhead, the effective budget rises to overhead + margin +
 * reserve, but never above `cap` (the model window minus its output limit) nor below the
 * configured budget.
 */
export function budgetFit(
	configured: number,
	reserve: number,
	overhead: number | undefined,
	cap?: number,
	margin = WORKING_MARGIN,
): BudgetFit {
	if (overhead === undefined) {
		return { configured, reserve, tooSmall: false, effective: configured, raised: false, capped: false, margin };
	}
	const usable = configured - reserve - overhead;
	const minimum = overhead + margin + reserve;
	const tooSmall = usable < margin;
	const limit = cap !== undefined && Number.isFinite(cap) && cap > 0 ? cap : Number.POSITIVE_INFINITY;
	const effective = tooSmall ? Math.max(configured, Math.min(minimum, limit)) : configured;
	return {
		configured,
		reserve,
		overhead,
		usable,
		tooSmall,
		minimum,
		effective,
		effectiveUsable: effective - reserve - overhead,
		raised: effective > configured,
		capped: tooSmall && minimum > limit,
		margin,
	};
}

/** Status line for `budgetFit`: fixed overhead, usable budget, and the raise if any. */
export function budgetFitLine(fit: BudgetFit): string {
	if (fit.overhead === undefined) return "fixed overhead (system prompt + tool schemas): not measured yet";
	const parts = [
		`fixed overhead (system prompt + tool schemas) ${formatTokens(fit.overhead)} tok`,
		`usable ${formatTokens(fit.usable!)} tok (budget ${formatTokens(fit.configured)} − reserve ${formatTokens(fit.reserve)} − overhead)`,
	];
	if (fit.raised) {
		parts.push(
			`effective budget ${formatTokens(fit.effective)} tok (raised${fit.capped ? ", capped by the model window" : ""}; usable ${formatTokens(fit.effectiveUsable!)} tok)`,
		);
	} else if (fit.tooSmall) {
		parts.push("too small, and the model window allows no raise");
	}
	return parts.join(" · ");
}

/**
 * The one-time model notice for a budget that cannot hold OpenCode's fixed overhead plus a
 * working margin. Text written for this package.
 */
export function budgetTooSmallNoticeText(fit: BudgetFit): string {
	const head =
		`[CLM BUDGET] The configured budget of ${formatTokens(fit.configured)} tokens is too small for this session: ` +
		`OpenCode's system prompt and tool schemas take about ${formatTokens(fit.overhead ?? 0)} tokens of every request, ` +
		`which leaves ${formatTokens(Math.max(0, fit.usable ?? 0))} tokens for the conversation after the ${formatTokens(fit.reserve)}-token reserve.`;
	const left = formatTokens(Math.max(0, fit.effectiveUsable ?? 0));
	if (fit.capped) {
		const raise = fit.raised ? `CLM raised this session's budget to ${formatTokens(fit.effective)} tokens, the most the model window allows, ` : "The model window allows no larger budget, ";
		return (
			`${head} ${raise}which still leaves only ${left} tokens for the conversation. ` +
			"The overflow guard will hold back most tool results: keep the context mirror short and read files in small parts."
		);
	}
	return (
		`${head} CLM raised this session's budget to ${formatTokens(fit.effective)} tokens, ` +
		`about ${left} tokens for the conversation. ` +
		"Budget reminders and the overflow guard count against the raised budget from now on."
	);
}

/** The user-facing toast for the same case: what happened and what to change. */
export function budgetTooSmallAlertText(fit: BudgetFit): string {
	const head = `Budget ${formatTokens(fit.configured)} is too small: OpenCode's system prompt and tools take ~${formatTokens(fit.overhead ?? 0)} tokens.`;
	if (fit.capped) {
		return `${head} The model window limits this session to ${formatTokens(fit.effective)}, leaving ~${formatTokens(Math.max(0, fit.effectiveUsable ?? 0))} for the conversation; lower reserve, use fewer tools, or use a model with a larger context window.`;
	}
	return `${head} Raised to ${formatTokens(fit.effective)} for this session; set budget to at least ${formatTokens(fit.minimum!)}.`;
}

export function budgetTiers(policy: BudgetPolicyConfig, budget: number, reserve: number): BudgetTier[] {
	const tiers: BudgetTier[] = policy.remindAtFractions.map((fraction) => ({
		label: `${Math.round(fraction * 100)}%`,
		tokens: Math.floor(budget * fraction),
	}));
	if (policy.remindAtReserve && reserve > 0 && budget - reserve > 0) {
		tiers.push({ label: "budget-reserve", tokens: budget - reserve });
	}
	tiers.sort((left, right) => left.tokens - right.tokens);
	// Drop tiers that collapse onto the same token count; keep the more urgent label.
	return tiers.filter((tier, index) => index === tiers.length - 1 || tier.tokens !== tiers[index + 1]!.tokens);
}

/**
 * The value reminders are judged against: the estimate alone. The provider count also
 * covers the system prompt and tool schemas, which the budget excludes.
 */
export function governingTokens(reading: Pick<BudgetReading, "estimated">): number {
	return reading.estimated;
}

/**
 * Escalating, re-arming tier tracker over absolute token thresholds. Re-derives its state
 * when the tier set changes (for example after the budget changes).
 */
export class BudgetTracker {
	private fired = new Set<string>();
	private tierKey = "";

	reset(): void {
		this.fired.clear();
	}

	/** Returns the highest newly crossed tier, or undefined when nothing new fired. */
	observe(reading: BudgetReading, tiers: readonly BudgetTier[]): BudgetTier | undefined {
		const key = tiers.map((tier) => `${tier.label}:${tier.tokens}`).join("|");
		if (key !== this.tierKey) {
			this.tierKey = key;
			this.fired.clear();
		}
		const tokens = governingTokens(reading);
		this.fired = new Set([...this.fired].filter((label) => {
			const tier = tiers.find((candidate) => candidate.label === label);
			return tier !== undefined && tokens >= tier.tokens;
		}));
		const crossed = tiers.filter((tier) => tokens >= tier.tokens && !this.fired.has(tier.label));
		if (crossed.length === 0) return undefined;
		const top = crossed[crossed.length - 1]!;
		for (const tier of tiers) if (tier.tokens <= top.tokens) this.fired.add(tier.label);
		return top;
	}
}

/** `12345` -> `12,345`. */
export function formatTokens(value: number): string {
	return value.toLocaleString("en-US");
}

function calibrated(reading: Pick<BudgetReading, "calibration">): boolean {
	return reading.calibration !== undefined && reading.calibration > 1.005;
}

/** `0.5` → `50%`, `0.125` → `12.5%`. */
export function formatPercent(fraction: number): string {
	return `${Number((fraction * 100).toFixed(2))}%`;
}

/** Short origin label of a budget: `configured`, `model window`, `50% of model window`, … */
export function budgetOrigin(reading: Pick<BudgetReading, "source" | "fraction">): string {
	const percent = reading.fraction !== undefined ? formatPercent(reading.fraction) : "";
	switch (reading.source) {
		case "config": return "configured";
		case "model-window": return "model window";
		case "window-fraction": return `${percent} of model window`;
		case "fallback": return `fallback, ${percent} of an unknown model window`;
	}
}

/** One line for status text: budget, estimate, and observation, each labelled. */
export function budgetSummaryLine(reading: BudgetReading): string {
	const origin = reading.raisedFrom !== undefined
		? `raised from ${formatTokens(reading.raisedFrom)} to cover the fixed overhead`
		: budgetOrigin(reading);
	const parts = [
		`budget ${formatTokens(reading.budget)} tok (${origin}, reserve ${formatTokens(reading.reserve)})`,
		`estimated next request ${formatTokens(reading.estimated)}${calibrated(reading) ? ` (×${reading.calibration!.toFixed(2)} calibrated)` : ""}`,
	];
	parts.push(
		reading.observed === undefined
			? "observed previous request: unknown"
			: `observed previous request ${formatTokens(reading.observed)}${reading.observedStale ? " (before the last accepted edit)" : ""}`,
	);
	return parts.join(" · ");
}

/**
 * The model-facing reminder. States the estimate and the provider count separately, the
 * budget and the tokens left, the mirror path, and, from the third tier up, what the
 * overflow guard does above `overflowLimit` (default budget - reserve). Pass `null` when the
 * guard is off: the notice then leaves the guard out.
 */
export function budgetNoticeText(
	reading: BudgetReading,
	tier: BudgetTier,
	mirrorPath: string | undefined,
	overflowLimit: number | null = reading.budget - reading.reserve,
): string {
	const governing = governingTokens(reading);
	const remaining = Math.max(0, reading.budget - governing);
	const where = mirrorPath ?? "the context mirror";
	const calibration = calibrated(reading) ? ` (calibrated ×${reading.calibration!.toFixed(2)} from provider counts)` : "";
	const excludes = `${calibration}${reading.estimateExcludes ? `, excluding ${reading.estimateExcludes}` : ""}`;
	const measurement =
		reading.observed === undefined
			? `estimated ${formatTokens(reading.estimated)} tokens for the next request${excludes}; provider-reported size of the previous request unknown`
			: `estimated ${formatTokens(reading.estimated)} tokens for the next request${excludes}; the provider reported ${formatTokens(reading.observed)} for the previous one, system prompt and tool schemas included${reading.observedStale ? ", before your last accepted edit" : ""}`;
	const overflow = overflowLimit === null
		? ""
		: ` Above ${formatTokens(overflowLimit)} tokens the overflow guard holds back the oldest new tool results and saves them to files.`;
	if (tier.label === "budget-reserve") {
		return (
			`[CLM BUDGET] Context is at ${formatTokens(governing)} of a ${formatTokens(reading.budget)}-token budget ` +
			`(${measurement}). Only ${formatTokens(remaining)} tokens remain, which is inside the ${formatTokens(reading.reserve)}-token generation reserve. ` +
			`Edit ${where} now to free space.${overflow}`
		);
	}
	const base =
		`[CLM BUDGET] Context crossed ${tier.label} of a ${formatTokens(reading.budget)}-token budget: ${measurement}. ` +
		`${formatTokens(remaining)} tokens remain. You may reorganize ${where} at any time; the final reminder comes at ${formatTokens(reading.budget - reading.reserve)} tokens.`;
	const fraction = tier.tokens / reading.budget;
	if (fraction <= 0.25) return base;
	if (fraction <= 0.5) return `${base} Summaries should keep what you would otherwise have to look up again.`;
	return `${base}${overflow}`;
}

/**
 * Runtime calibration of the character-based estimator against the provider's own counts.
 *
 * chars/4 undercounts many inputs (random strings, code, non-English text tokenize at
 * 2-3 chars per token). Each request carries an estimate; when the provider reports the
 * actual size of that request, the ratio updates a factor that scales future estimates.
 * The factor never drops below 1 (only undercounting is corrected) and is capped so one
 * odd sample cannot run away.
 */
export class EstimateCalibrator {
	private pending: { estimate: number; rawCount: number; offset: number } | undefined;
	private current = 1;
	private samples = 0;

	constructor(private readonly options: { min?: number; max?: number; smoothing?: number; initial?: number } = {}) {
		const smoothing = options.smoothing;
		if (smoothing !== undefined && (!Number.isFinite(smoothing) || smoothing <= 0 || smoothing > 1)) {
			throw new Error(`smoothing must be in (0, 1], got ${String(smoothing)}`);
		}
		this.current = this.initialFactor();
	}

	get factor(): number {
		return this.current;
	}

	get sampleCount(): number {
		return this.samples;
	}

	reset(): void {
		this.pending = undefined;
		this.current = this.initialFactor();
		this.samples = 0;
	}

	/**
	 * Remember the raw (uncalibrated) estimate of the request about to be sent. The estimate
	 * must cover the same scope as the provider count it will be compared with; an estimate
	 * that omits the system prompt and tool schemas reads their size as undercounting.
	 * `offset`: tokens of the provider count the estimate does not cover, already measured
	 * (the fixed overhead); they are subtracted from the observation before the comparison.
	 */
	record(estimate: number, rawCount: number, offset = 0): void {
		if (estimate > 0) this.pending = { estimate, rawCount, offset };
	}

	/**
	 * Feed the newest provider-reported request size. `index` is the position of the
	 * reporting assistant message in the raw transcript; only a message appended after the
	 * recorded request counts as its measurement.
	 */
	observe(observed: { tokens: number; index: number } | undefined): number {
		if (!observed || !this.pending || observed.index < this.pending.rawCount) return this.current;
		const sample = (observed.tokens - this.pending.offset) / this.pending.estimate;
		this.pending = undefined;
		if (!Number.isFinite(sample) || sample <= 0) return this.current;
		const smoothing = this.options.smoothing ?? 0.5;
		const next = this.samples === 0 ? sample : this.current * (1 - smoothing) + sample * smoothing;
		this.current = this.clamp(next);
		this.samples += 1;
		return this.current;
	}

	apply(estimate: number): number {
		return Math.ceil(estimate * this.current);
	}

	private clamp(value: number): number {
		return Math.min(this.options.max ?? 4, Math.max(this.options.min ?? 1, value));
	}

	private initialFactor(): number {
		return this.clamp(this.options.initial ?? 1);
	}
}
