// Adapted from pi-clm src/__tests__/observation-steering.test.ts (MIT, Copyright 2026 Emanuel Casco).
import { describe, expect, test } from "bun:test";
import {
	capObservations,
	capToolResult,
	parseObservationCap,
	resolveObservationCap,
	truncationMarker,
	uncappedSource,
} from "../src/observation.ts";
import type { LiveContextMessage } from "../src/types.ts";

const big = (n: number) => Array.from({ length: n }, (_v, i) => `line ${i}`).join("\n");
const body = (message: LiveContextMessage) => (message.content as { text: string }[])[0]!.text;
/** Flattened OpenCode tool result, as opencode.ts `flatten` emits it. */
const tool = (id: string, text: string, extra: unknown[] = []): LiveContextMessage => ({
	role: "toolResult", toolCallId: id, toolName: "read", isError: false, ocMessageID: "msg_a", timestamp: 1,
	content: [{ type: "text", text }, ...extra],
});

describe("observation cap", () => {
	test("parsing and validation", () => {
		expect(parseObservationCap(undefined)).toEqual({});
		expect(parseObservationCap("")).toEqual({});
		expect(parseObservationCap(" off ")).toEqual({});
		expect(parseObservationCap("0")).toEqual({});
		expect(parseObservationCap("10000")).toEqual({ maxCharacters: 10_000 });
		expect(parseObservationCap("10000.7")).toEqual({ maxCharacters: 10_000 });
		expect(parseObservationCap("10000:0.5")).toEqual({ maxCharacters: 10_000, headFraction: 0.5 });
		expect(parseObservationCap("10000:")).toEqual({ maxCharacters: 10_000 });
		expect(() => parseObservationCap("10000:2")).toThrow(/head fraction/);
		expect(() => parseObservationCap("10000:0")).toThrow(/head fraction/);
		expect(() => parseObservationCap("many")).toThrow(/CLM_OBSERVATION_CAP must be a positive number/);
		expect(() => parseObservationCap("-5")).toThrow(/positive number/);
		expect(() => parseObservationCap("1:0.5:9")).toThrow(/positive number/);
		expect(() => parseObservationCap("x", "observationCap")).toThrow(/^observationCap must/);
		expect(() => resolveObservationCap({ maxCharacters: 10 })).toThrow(/at least 200/);
		expect(() => resolveObservationCap({ maxCharacters: 1000, headFraction: 1.5 })).toThrow(/headFraction/);
		expect(resolveObservationCap(undefined)).toEqual({ headFraction: 0.8 });
		expect(resolveObservationCap(parseObservationCap("10000:0.5"))).toEqual({ maxCharacters: 10_000, headFraction: 0.5 });
	});

	test("only oversized tool results change; head and tail are kept with a marker", () => {
		const policy = resolveObservationCap({ maxCharacters: 1000 });
		const text = big(400);
		const result = tool("t1", text);
		const small = tool("t2", "ok");
		const user: LiveContextMessage = { role: "user", content: big(400), timestamp: 3 };
		const capped = capToolResult(result, policy);
		expect(capped).not.toBe(result);
		const out = body(capped);
		expect(out.startsWith("line 0\nline 1")).toBe(true);
		expect(out).toContain(`…[${(text.length - 1000).toLocaleString("en-US")} characters omitted]…`);
		expect(out).toContain("line 399");
		expect(out).toContain(`[clm observation cap: 1,000 of ${text.length.toLocaleString("en-US")} characters shown.`);
		expect(out.length).toBeLessThan(1400);
		// Head is 80% by default.
		expect(out.indexOf("\n…[")).toBe(800);
		// Shape for unflatten: same role / ids, flagged, source untouched.
		expect(capped.toolCallId).toBe("t1");
		expect(capped.ocMessageID).toBe("msg_a");
		expect(capped.capped).toBe(true);
		expect(result.capped).toBeUndefined();
		expect(uncappedSource(capped)).toBe(result);
		expect(uncappedSource(result)).toBe(result);
		expect(capToolResult(small, policy)).toBe(small);
		expect(capToolResult(user, policy)).toBe(user);
		expect(capToolResult(result, resolveObservationCap(undefined))).toBe(result);
	});

	test("head fraction 0.5 splits evenly; 1 keeps the head only", () => {
		const text = "a".repeat(600) + "b".repeat(600);
		const half = body(capToolResult(tool("t", text), resolveObservationCap({ maxCharacters: 400, headFraction: 0.5 })));
		expect(half.startsWith("a".repeat(200) + "\n…[800 characters omitted]…\n" + "b".repeat(200))).toBe(true);
		const headOnly = body(capToolResult(tool("t", text), resolveObservationCap({ maxCharacters: 400, headFraction: 1 })));
		expect(headOnly).toBe("a".repeat(400) + truncationMarker(400, 1200));
	});

	test("capping is idempotent, on the object and on a JSON copy", () => {
		const policy = resolveObservationCap({ maxCharacters: 300 });
		const capped = capToolResult(tool("t", big(200)), policy);
		expect(capToolResult(capped, policy)).toBe(capped);
		const copy = structuredClone(capped);
		expect(capToolResult(copy, policy)).toBe(copy);
		const json = JSON.parse(JSON.stringify(capped)) as LiveContextMessage;
		expect(capToolResult(json, policy)).toBe(json);
		expect(capObservations([copy], policy)[0]).toBe(copy);
	});

	test("never splits a surrogate pair at the head or tail cut", () => {
		const emoji = "\u{1F600}"; // two UTF-16 code units
		const text = "a".repeat(239) + emoji.repeat(200) + "b".repeat(59);
		// head 240 ends inside the first emoji; tail 60 starts inside the last emoji.
		const out = body(capToolResult(tool("t", text), resolveObservationCap({ maxCharacters: 300 })));
		expect(out.startsWith("a".repeat(239) + "\n…[")).toBe(true);
		expect(out).toContain("]…\n" + "b".repeat(59) + "\n\n[clm observation cap: 298 of");
		expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
	});

	test("string content is capped too", () => {
		const message: LiveContextMessage = { role: "toolResult", toolCallId: "s", toolName: "bash", content: "z".repeat(500) };
		const capped = capToolResult(message, resolveObservationCap({ maxCharacters: 200 }));
		expect(Array.isArray(capped.content)).toBe(true);
		expect(body(capped)).toContain("200 of 500 characters shown");
	});

	test("images survive and identity is stable across calls", () => {
		const policy = resolveObservationCap({ maxCharacters: 500 });
		const result = tool("t1", big(200), [{ type: "image", data: "abc", mimeType: "image/png" }]);
		const messages = [result, { role: "user", content: "next", timestamp: 2 } as LiveContextMessage];
		const first = capObservations(messages, policy);
		const second = capObservations(messages, policy);
		expect(first[0]).toBe(second[0]!);
		expect(first[1]).toBe(messages[1]!);
		const parts = first[0]!.content as { type: string }[];
		expect(parts.map((part) => part.type)).toEqual(["text", "image"]);
		expect(capObservations(messages, resolveObservationCap(undefined))).toBe(messages);
	});

	test("unchanged input returns the same array; a different head fraction is not served from cache", () => {
		const messages = [tool("t", "short")];
		expect(capObservations(messages, resolveObservationCap({ maxCharacters: 500 }))).toBe(messages);
		const long = [tool("t", "a".repeat(600) + "b".repeat(600))];
		const head = capObservations(long, resolveObservationCap({ maxCharacters: 400, headFraction: 1 }));
		const even = capObservations(long, resolveObservationCap({ maxCharacters: 400, headFraction: 0.5 }));
		expect(head[0]).not.toBe(even[0]!);
		expect(body(even[0]!)).toContain("b".repeat(200));
	});
});
