// Adapted from pi-clm src/__tests__/budget.test.ts (MIT, Copyright 2026 Emanuel Casco).
import { describe, expect, test } from "bun:test";
import {
	BudgetTracker,
	DEFAULT_BUDGET_POLICY,
	EstimateCalibrator,
	budgetNoticeText,
	budgetSummaryLine,
	budgetTiers,
	formatTokens,
	governingTokens,
	resolveBudget,
	resolveBudgetPolicy,
	type BudgetReading,
} from "../src/budget.ts";

// pi-clm's fixture: 32,000 budget, 50/75/90% plus budget-reserve.
const policy = resolveBudgetPolicy({ contextBudget: 32_000, remindAtFractions: [0.5, 0.75, 0.9] });
const tiers = budgetTiers(policy, 32_000, 2048);
const reading = (estimated: number, observed?: number): BudgetReading => ({
	budget: 32_000,
	reserve: 2048,
	estimated,
	observed,
	source: "config",
});
const windowPolicy = resolveBudgetPolicy({ contextBudget: undefined });

describe("budget policy resolution", () => {
	test("defaults: 32,000 budget, 2,048 reserve, 25/50/75% plus budget-reserve", () => {
		expect(DEFAULT_BUDGET_POLICY).toEqual({ contextBudget: 32000, reserve: 2048, remindAtFractions: [0.25, 0.5, 0.75], remindAtReserve: true });
		const defaults = resolveBudgetPolicy(undefined);
		const resolved = resolveBudget(defaults, undefined)!;
		expect(resolved).toEqual({ budget: 32000, reserve: 2048, source: "config" });
		expect(budgetTiers(defaults, resolved.budget, resolved.reserve).map((tier) => [tier.label, tier.tokens])).toEqual([
			["25%", 8000], ["50%", 16000], ["75%", 24000], ["budget-reserve", 29952],
		]);
	});
	test("custom fractions produce the matching tiers", () => {
		expect(tiers.map((tier) => [tier.label, tier.tokens])).toEqual([["50%", 16_000], ["75%", 24_000], ["90%", 28_800], ["budget-reserve", 29_952]]);
		const small = resolveBudgetPolicy({ contextBudget: 1000, reserve: 100, remindAtFractions: [0.75, 0.25, 0.5] });
		expect(budgetTiers(small, 1000, 100).map((tier) => [tier.label, tier.tokens])).toEqual([["25%", 250], ["50%", 500], ["75%", 750], ["budget-reserve", 900]]);
	});
	test("configured budget wins when it fits the window; the window is the fallback and the cap", () => {
		expect(resolveBudget(policy, 272_000)).toEqual({ budget: 32_000, reserve: 2048, source: "config" });
		expect(resolveBudget(policy, 262144, 32000)?.budget).toBe(32000);
		expect(resolveBudget(policy, 20000, 4000)).toEqual({ budget: 16000, reserve: 2048, source: "model-window" });
		expect(resolveBudget(windowPolicy, 272_000)).toEqual({ budget: 272_000, reserve: 2048, source: "model-window" });
		expect(resolveBudget(windowPolicy, 100000, 0)?.budget).toBe(100000);
		expect(resolveBudget(windowPolicy, undefined)).toBeUndefined();
		expect(resolveBudget(windowPolicy, 0)).toBeUndefined();
		expect(resolveBudget(policy, Number.NaN)?.source).toBe("config");
		// An output limit that is not finite, <= 0, or >= the window is ignored.
		expect(resolveBudget(windowPolicy, 100000, Number.NaN)?.budget).toBe(100000);
		expect(resolveBudget(windowPolicy, 100000, -5)?.budget).toBe(100000);
		expect(resolveBudget(windowPolicy, 100000, 100000)?.budget).toBe(100000);
		expect(resolveBudget(windowPolicy, 100000, 250000)?.budget).toBe(100000);
		expect(resolveBudget(policy, 20000, 20000)).toEqual({ budget: 20000, reserve: 2048, source: "model-window" });
	});
	test("reserve is clamped to the budget and colliding tiers are deduplicated", () => {
		const tiny = resolveBudgetPolicy({ contextBudget: 1000, reserve: 5000, remindAtFractions: [0.5] });
		const resolved = resolveBudget(tiny, undefined)!;
		expect(resolved.reserve).toBe(1000);
		expect(budgetTiers(tiny, resolved.budget, resolved.reserve).map((t) => t.label)).toEqual(["50%"]);
		const same = resolveBudgetPolicy({ contextBudget: 1000, reserve: 100, remindAtFractions: [0.9] });
		expect(budgetTiers(same, 1000, 100).map((t) => t.label)).toEqual(["budget-reserve"]);
		const off = resolveBudgetPolicy({ remindAtFractions: [], remindAtReserve: false });
		expect(budgetTiers(off, 32000, 2048)).toEqual([]);
	});
	test("rejects nonsensical configuration", () => {
		expect(() => resolveBudgetPolicy({ contextBudget: 0 })).toThrow(/positive/);
		expect(() => resolveBudgetPolicy({ contextBudget: Number("lots") })).toThrow(/positive/);
		expect(() => resolveBudgetPolicy({ reserve: -1 })).toThrow(/nonnegative/);
		expect(() => resolveBudgetPolicy({ remindAtFractions: [1.5] })).toThrow(/\(0, 1\)/);
		expect(() => resolveBudgetPolicy({ remindAtFractions: [0] })).toThrow(/\(0, 1\)/);
	});
});

describe("budget tracker", () => {
	test("fires the highest newly crossed tier once and re-arms after dropping below it", () => {
		const tracker = new BudgetTracker();
		expect(tracker.observe(reading(10_000), tiers)).toBeUndefined();
		expect(tracker.observe(reading(16_500), tiers)?.label).toBe("50%");
		expect(tracker.observe(reading(17_000), tiers)).toBeUndefined();
		expect(tracker.observe(reading(29_000), tiers)?.label).toBe("90%");
		expect(tracker.observe(reading(30_000), tiers)?.label).toBe("budget-reserve");
		expect(tracker.observe(reading(31_000), tiers)).toBeUndefined();
		// A large edit brings usage down; tiers re-arm.
		expect(tracker.observe(reading(4_000), tiers)).toBeUndefined();
		expect(tracker.observe(reading(16_500), tiers)?.label).toBe("50%");
	});
	test("default-style tiers: each fires once, the highest crossed wins, re-arm after compaction", () => {
		const small = resolveBudgetPolicy({ contextBudget: 1000, reserve: 100 });
		const smallTiers = budgetTiers(small, 1000, 100);
		const at = (estimated: number): BudgetReading => ({ budget: 1000, reserve: 100, source: "config", estimated });
		const tracker = new BudgetTracker();
		expect(tracker.observe(at(100), smallTiers)).toBeUndefined();
		expect(tracker.observe(at(260), smallTiers)?.label).toBe("25%");
		expect(tracker.observe(at(300), smallTiers)).toBeUndefined();
		expect(tracker.observe(at(800), smallTiers)?.label).toBe("75%");
		expect(tracker.observe(at(820), smallTiers)).toBeUndefined();
		expect(tracker.observe(at(200), smallTiers)).toBeUndefined();
		expect(tracker.observe(at(600), smallTiers)?.label).toBe("50%");
		expect(tracker.observe(at(950), smallTiers)?.label).toBe("budget-reserve");
	});
	test("the estimate alone governs; the provider count is display-only", () => {
		const tracker = new BudgetTracker();
		expect(governingTokens(reading(1_000, 20_000))).toBe(1_000);
		expect(tracker.observe(reading(1_000, 20_000), tiers)).toBeUndefined();
		expect(tracker.observe(reading(25_000, 20_000), tiers)?.label).toBe("75%");
	});
	test("a stale observation is shown with its caveat and never governs", () => {
		const tracker = new BudgetTracker();
		expect(tracker.observe({ ...reading(1_000, 30_000), observedStale: true }, tiers)).toBeUndefined();
		expect(budgetSummaryLine({ ...reading(1_000, 30_000), observedStale: true })).toMatch(/30,000 \(before the last accepted edit\)/);
		expect(budgetNoticeText({ ...reading(17_000, 30_000), observedStale: true }, tiers[0]!, undefined)).toMatch(/before your last accepted edit/);
	});
	test("changing the tier set resets fired state", () => {
		const tracker = new BudgetTracker();
		expect(tracker.observe(reading(20_000), tiers)?.label).toBe("50%");
		const smaller = budgetTiers(policy, 24_000, 2048);
		expect(tracker.observe({ ...reading(20_000), budget: 24_000 }, smaller)?.label).toBe("75%");
	});
	test("reset clears fired tiers", () => {
		const tracker = new BudgetTracker();
		tracker.observe(reading(20_000), tiers);
		tracker.reset();
		expect(tracker.observe(reading(20_000), tiers)?.label).toBe("50%");
	});
});

describe("budget text", () => {
	const small = resolveBudgetPolicy({ contextBudget: 1000, reserve: 100 });
	const smallTiers = budgetTiers(small, 1000, 100);
	const at = (estimated: number, observed?: number): BudgetReading => ({ budget: 1000, reserve: 100, source: "config", estimated, observed });
	const notices = () => [at(260), at(510), at(760), at(950)].map((r, i) => budgetNoticeText(r, smallTiers[i]!, "/m/LIVE.md"));

	test("every notice carries the marker, the budget, the tokens left, and the mirror path", () => {
		const texts = notices();
		for (const text of texts) {
			expect(text.startsWith("[CLM BUDGET] ")).toBe(true);
			expect(text).toContain("of a 1,000-token budget");
			expect(text).toContain("/m/LIVE.md");
		}
		expect(texts[0]).toBe(
			"[CLM BUDGET] Context crossed 25% of a 1,000-token budget: estimated 260 tokens for the next request; " +
				"provider-reported size of the previous request unknown. 740 tokens remain. " +
				"You may reorganize /m/LIVE.md at any time; the final reminder comes at 900 tokens.",
		);
	});
	test("pi-clm fixture: labels estimate and provider count separately", () => {
		const text = budgetNoticeText(reading(17_000, 16_200), tiers[0]!, "/tmp/m/LIVE_CONTEXT.md");
		expect(text).toMatch(/^\[CLM BUDGET\] Context crossed 50% of a 32,000-token budget/);
		expect(text).toMatch(/estimated 17,000 tokens for the next request/);
		expect(text).toMatch(/provider reported 16,200 for the previous one, system prompt and tool schemas included/);
		expect(text).toMatch(/15,000 tokens remain/);
		expect(text).toMatch(/final reminder comes at 29,952 tokens/);
		expect(text).toMatch(/\/tmp\/m\/LIVE_CONTEXT\.md/);
	});
	test("each tier adds at most its own sentence; the overflow line appears from the third tier up", () => {
		const [low, mid, high, urgent] = notices();
		expect(low).not.toContain("overflow guard");
		expect(mid).toContain("Summaries should keep what you would otherwise have to look up again.");
		expect(mid).not.toContain("overflow guard");
		expect(high).toContain("Above 900 tokens the overflow guard holds back the oldest new tool results and saves them to files.");
		expect(urgent).toMatch(/^\[CLM BUDGET\] Context is at 950 of a 1,000-token budget/);
		expect(urgent).toContain("Only 50 tokens remain, which is inside the 100-token generation reserve.");
		expect(urgent).toContain("Edit /m/LIVE.md now to free space.");
		expect(urgent).toContain("Above 900 tokens the overflow guard");
	});
	test("the overflow limit can be passed in", () => {
		expect(budgetNoticeText(at(950), smallTiers[3]!, "/m", 800)).toContain("Above 800 tokens the overflow guard");
	});
	test("the estimate sets the numbers even when the provider count is larger", () => {
		const text = budgetNoticeText(at(260, 16000), smallTiers[0]!, "/m");
		expect(text).toContain("the provider reported 16,000 for the previous one");
		expect(text).toContain("740 tokens remain");
	});
	test("notice says when the observed size is unknown and falls back to a generic mirror name", () => {
		const text = budgetNoticeText(reading(17_000), tiers[0]!, undefined);
		expect(text).toContain("provider-reported size of the previous request unknown");
		expect(text).toContain("the context mirror");
	});
	test("notice names what the estimate excludes", () => {
		const text = budgetNoticeText({ ...reading(17_000), estimateExcludes: "tool schemas" }, tiers[0]!, "/m");
		expect(text).toContain("estimated 17,000 tokens for the next request, excluding tool schemas;");
	});
	test("summary line separates the three numbers and names the budget source", () => {
		expect(budgetSummaryLine(reading(12_345, 11_900))).toBe(
			"budget 32,000 tok (configured, reserve 2,048) · estimated next request 12,345 · observed previous request 11,900",
		);
		expect(budgetSummaryLine({ ...reading(1), source: "model-window" })).toMatch(/model window/);
		expect(budgetSummaryLine(reading(1))).toMatch(/observed previous request: unknown/);
	});
	test("formatTokens groups thousands", () => {
		expect(formatTokens(29952)).toBe("29,952");
		expect(formatTokens(0)).toBe("0");
	});
	test("no notice keeps wording from the earlier harness", () => {
		const all = [
			...notices(),
			budgetNoticeText({ ...at(950, 990), observedStale: true, calibration: 2, estimateExcludes: "x" }, smallTiers[3]!, undefined),
		].join("\n");
		const banned = ["NUDGE", "tidy ONCE", "do NOT wipe", "under 25%", "COPY facts", "VERIFIED", "NEXT line", "ruled out", "No action needed", "do not retry"];
		for (const phrase of banned) expect(all).not.toContain(phrase);
		expect(all.toLowerCase()).not.toContain("settled spans");
	});
});

describe("estimate calibrator", () => {
	test("learns an undercount factor from provider counts, only for the request it recorded", () => {
		const c = new EstimateCalibrator();
		expect(c.factor).toBe(1);
		c.record(10_000, 5);
		// A message that predates the recorded request is not its measurement.
		expect(c.observe({ tokens: 25_000, index: 4 })).toBe(1);
		expect(c.observe({ tokens: 25_000, index: 5 })).toBe(2.5);
		expect(c.sampleCount).toBe(1);
		expect(c.apply(1_000)).toBe(2_500);
		// Second sample is smoothed, never below 1, capped at 4.
		c.record(10_000, 9);
		expect(c.observe({ tokens: 5_000, index: 9 })).toBe(1.5);
		c.record(1, 12);
		expect(c.observe({ tokens: 1_000_000, index: 12 })).toBe(4);
		c.reset();
		expect(c.factor).toBe(1);
		expect(c.sampleCount).toBe(0);
		expect(c.apply(1_000)).toBe(1_000);
	});
	test("an overcount never pulls the factor below 1", () => {
		const c = new EstimateCalibrator();
		c.record(10_000, 0);
		expect(c.observe({ tokens: 2_000, index: 0 })).toBe(1);
	});
	test("without a pending record or observation the factor stays put", () => {
		const c = new EstimateCalibrator();
		expect(c.observe(undefined)).toBe(1);
		expect(c.observe({ tokens: 100, index: 0 })).toBe(1);
		c.record(0, 0);
		expect(c.observe({ tokens: 100, index: 0 })).toBe(1);
	});
	test("a recorded estimate is consumed by one observation", () => {
		const c = new EstimateCalibrator();
		c.record(1_000, 0);
		expect(c.observe({ tokens: 2_000, index: 1 })).toBe(2);
		expect(c.observe({ tokens: 4_000, index: 2 })).toBe(2);
		expect(c.sampleCount).toBe(1);
	});
	test("smoothing must be in (0, 1]", () => {
		expect(() => new EstimateCalibrator({ smoothing: 0 })).toThrow(/smoothing/);
		expect(() => new EstimateCalibrator({ smoothing: 1.5 })).toThrow(/smoothing/);
		expect(() => new EstimateCalibrator({ smoothing: Number.NaN })).toThrow(/smoothing/);
		expect(new EstimateCalibrator({ smoothing: 1 }).factor).toBe(1);
	});
	test("initial factor is clamped to [min, max]", () => {
		expect(new EstimateCalibrator({ initial: 1.5 }).factor).toBe(1.5);
		expect(new EstimateCalibrator({ initial: 9 }).factor).toBe(4);
		expect(new EstimateCalibrator({ initial: 0.2 }).factor).toBe(1);
		const c = new EstimateCalibrator({ initial: 1.5 });
		c.record(1_000, 0);
		c.observe({ tokens: 3_000, index: 0 });
		c.reset();
		expect(c.factor).toBe(1.5);
	});
	test("notice and status show the calibration when it is above 1", () => {
		const text = budgetNoticeText({ ...reading(17_000, 16_000), calibration: 1.83 }, tiers[0]!, undefined);
		expect(text).toMatch(/estimated 17,000 tokens for the next request \(calibrated ×1\.83 from provider counts\); the provider/);
		expect(budgetNoticeText({ ...reading(17_000), calibration: 1 }, tiers[0]!, undefined)).not.toMatch(/calibrated/);
		expect(budgetSummaryLine({ ...reading(1_000), calibration: 2 })).toMatch(/estimated next request 1,000 \(×2\.00 calibrated\)/);
	});
});
