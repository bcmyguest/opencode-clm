import { describe, expect, test } from "bun:test";

import { fitLimitText, gateEdit, shrinkLimitText, toEditGate } from "../src/policy.ts";

describe("gateEdit", () => {
	test("fit accepts growth that fits the limit and rejects growth past it", () => {
		expect(gateEdit({ gate: "fit", before: 100, after: 150, limit: 200 }).accepted).toBe(true);
		expect(gateEdit({ gate: "fit", before: 100, after: 200, limit: 200 }).accepted).toBe(true);
		const rejected = gateEdit({ gate: "fit", before: 100, after: 250, limit: 200 });
		expect(rejected.accepted).toBe(false);
		expect(rejected.reason).toContain(fitLimitText(200));
		expect(rejected.reason).toContain("Size 100 -> 250 tokens");
	});

	test("shrink rejects any growth; equal or smaller edits pass every gate", () => {
		const rejected = gateEdit({ gate: "shrink", before: 100, after: 101, limit: 1000 });
		expect(rejected.accepted).toBe(false);
		expect(rejected.reason).toContain(shrinkLimitText);
		expect(gateEdit({ gate: "shrink", before: 100, after: 100 }).accepted).toBe(true);
		expect(gateEdit({ gate: "fit", before: 100, after: 50 }).accepted).toBe(true);
		expect(gateEdit({ gate: "none", before: 1, after: 1e9 }).accepted).toBe(true);
	});

	test("fit without a positive finite limit accepts growth, like none", () => {
		for (const limit of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(gateEdit({ gate: "fit", before: 100, after: 1e9, limit }).accepted).toBe(true);
		}
	});

	test("shrink ignores the limit", () => {
		expect(gateEdit({ gate: "shrink", before: 100, after: 101, limit: Number.NaN }).accepted).toBe(false);
	});

	test("the rejection names the unit and says the context is unchanged", () => {
		const reason = gateEdit({ gate: "fit", before: 10, after: 20, limit: 15, unit: "characters" }).reason!;
		expect(reason).toStartWith("Edit refused (gate fit: limit 15 characters).");
		expect(reason).toContain("Size 10 -> 20 characters");
		expect(reason).toContain(fitLimitText(15, "characters"));
		expect(reason).toEndWith("The previous context is still in effect.");
	});
});

describe("toEditGate", () => {
	test("reads the three gate names, ignoring case and surrounding space", () => {
		expect(toEditGate("fit")).toBe("fit");
		expect(toEditGate(" Shrink ")).toBe("shrink");
		expect(toEditGate("NONE")).toBe("none");
	});

	test("refuses booleans, flag words and other values", () => {
		for (const value of [true, false, "true", "off", "1", "grow", 3, undefined]) {
			expect(() => toEditGate(value)).toThrow(/^unknown edit gate .*; use "fit", "shrink" or "none"$/);
		}
	});
});
