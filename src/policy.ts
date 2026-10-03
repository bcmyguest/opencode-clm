// Gate design after the CLM paper's harness (fit / shrink / none); text written for this package.

/**
 * Edit gate: decides whether a mirror edit that grows the context is applied.
 *
 * - "fit":    growth is accepted while the result stays within the limit (budget − reserve).
 *             Without a positive finite limit there is nothing to measure against, and
 *             fit accepts every edit, like "none".
 * - "shrink": growth is rejected; an edit with after <= before is accepted.
 * - "none":   no size check (pi-clm's CLM mode).
 *
 * `before`, `after` and `limit` must share one unit: that of the estimator that produced them.
 */
export type EditGate = "fit" | "shrink" | "none";

const GATES: readonly EditGate[] = ["fit", "shrink", "none"];

/** Rule text quoted in a shrink refusal. */
export const shrinkLimitText = "gate shrink: limit = size before the edit";

/** Rule text quoted in a fit refusal. */
export function fitLimitText(limit: number, unit: "characters" | "tokens" = "tokens"): string {
	return `gate fit: limit ${limit} ${unit}`;
}

/** Reads a gate name, case-insensitive. Booleans are refused: `false` could mean shrink or none. */
export function toEditGate(value: unknown): EditGate {
	const name = typeof value === "string" ? value.trim().toLowerCase() : undefined;
	const gate = GATES.find((candidate) => candidate === name);
	if (gate) return gate;
	throw new Error(`unknown edit gate ${JSON.stringify(value)}; use "fit", "shrink" or "none"`);
}

export interface GateInput {
	gate: EditGate;
	before: number;
	after: number;
	/** Same unit as `before` and `after`. */
	limit?: number;
	/** Unit named in the rejection text. */
	unit?: "characters" | "tokens";
}

export function gateEdit(input: GateInput): { accepted: boolean; reason?: string } {
	if (input.gate === "none" || input.after <= input.before) return { accepted: true };
	const unit = input.unit ?? "tokens";
	let rule = shrinkLimitText;
	if (input.gate === "fit") {
		const limit = input.limit;
		if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return { accepted: true };
		if (input.after <= limit) return { accepted: true };
		rule = fitLimitText(limit, unit);
	}
	return {
		accepted: false,
		reason:
			`Edit refused (${rule}). Size ${input.before} -> ${input.after} ${unit} (estimated). ` +
			"The previous context is still in effect.",
	};
}
