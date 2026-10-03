// Tests for src/panel/model.ts.

import { describe, expect, test } from "bun:test";

import type { RevisionFile, SnapshotFile } from "../../src/panel/files.ts";
import { buildBudget, buildPanelModel, buildRevisions, buildTimeline } from "../../src/panel/model.ts";
import { accepted, at, basicEvents, files, latest, request } from "./fixtures.ts";

describe("timeline from events", () => {
	test("points from request events, markers from outcome events", () => {
		const timeline = buildTimeline(basicEvents, latest(7000, 6));
		expect(timeline.points.map((p) => [p.request, p.tokens, p.measured, p.revision])).toEqual([
			[1, 3000, true, 0],
			[2, 6000, true, 0],
			[3, 4000, true, 1],
			[4, 7000, true, 1],
		]);
		expect(timeline.points[0]?.at).toBe(at(1));
		expect(timeline.peakTokens).toBe(7000);
		expect(timeline.markers.map((m) => [m.kind, m.revision, m.afterPoint, m.beforeTokens, m.afterTokens])).toEqual([
			["applied", 1, 1, 9500, 2900],
			["rejected", 1, 3, undefined, undefined],
			["reset", 2, 3, undefined, undefined],
		]);
		expect(timeline.markers[1]?.message).toBe("unknown block ids");
		expect(timeline.turnStarts).toEqual([0]);
	});

	test("provider-measured vs estimated sizes", () => {
		// Without the host's count the newest request falls back to its estimate.
		const estimated = buildTimeline(basicEvents);
		expect(estimated.points.at(-1)).toMatchObject({ tokens: 6800, measured: false });
		// A missing or zero observedPrevious leaves the previous request estimated.
		const gaps = buildTimeline([request(100, 1), request(200, 2, { observedPrevious: 0 }), request(300, 3, { observedPrevious: 250 })], latest(400, 4));
		expect(gaps.points.map((p) => [p.tokens, p.measured])).toEqual([[100, false], [250, true], [400, true]]);
	});

	test("the newest request takes the host count only from a reply completed after it was sent", () => {
		// While the reply streams, the newest count is the previous reply's: not used.
		expect(buildTimeline(basicEvents, latest(4000, 4)).points.at(-1)).toMatchObject({ tokens: 6800, measured: false });
		expect(buildTimeline(basicEvents, latest(7000, 6, false)).points.at(-1)).toMatchObject({ tokens: 6800, measured: false });
		expect(buildTimeline(basicEvents, latest(7000, 6)).points.at(-1)).toMatchObject({ tokens: 7000, measured: true });
	});

	test("a repeated observedPrevious (failed reply) leaves the request unmeasured", () => {
		const timeline = buildTimeline([
			request(100, 1),
			request(200, 2, { observedPrevious: 150 }),
			request(300, 3, { observedPrevious: 150 }),
		]);
		expect(timeline.points.map((p) => [p.tokens, p.measured])).toEqual([[150, true], [200, false], [300, false]]);
	});

	test("compaction requests are not points but their observedPrevious still sizes the request before", () => {
		const timeline = buildTimeline([
			request(100, 1),
			request(150, 2, { compaction: true, observedPrevious: 120 }),
			request(90, 3, { observedPrevious: 160 }),
		]);
		expect(timeline.points.map((p) => [p.request, p.tokens, p.measured])).toEqual([[1, 120, true], [2, 90, false]]);
	});

	test("projection-reset, compacted and turn starts", () => {
		const timeline = buildTimeline([
			request(100, 1, { users: 1 }),
			request(100, 2, { users: 1 }),
			{ at: at(3), event: "projection-reset", revision: 3, reason: "history changed" },
			request(100, 4, { users: 2 }),
			{ at: at(5), event: "compacted", revision: 5, previous: 4, summary: "msg_9", written: true },
			request(100, 6, { users: 1 }),
			request(100, 7, { users: 2 }),
			{ at: at(8), event: "budget-notice", tier: "50%" },
		]);
		expect(timeline.markers.map((m) => [m.kind, m.revision, m.afterPoint, m.message])).toEqual([
			["reset", 4, 1, "Revision 3 dropped: history changed"],
			["compacted", 5, 2, "Rebased on compaction summary msg_9."],
		]);
		// The drop after compaction resets the user count; the next rise is a new turn.
		expect(timeline.turnStarts).toEqual([0, 2, 4]);
	});

	test("events named with `type` are accepted", () => {
		const timeline = buildTimeline([{ type: "request", estimated: 50, at: at(1) }, { type: "accepted", revision: 1, before: 50, after: 20 }]);
		expect(timeline.points.length).toBe(1);
		expect(timeline.markers[0]?.kind).toBe("applied");
	});
});

const snapshot: SnapshotFile = {
	at: at(10),
	request: 4,
	revision: 1,
	enabled: true,
	budget: { budget: 40_000, reserve: 2_000, limit: 38_000, source: "config" },
	calibration: { factor: 1.1, samples: 3 },
	steering: { name: "house-brief.md", hash: "abc123", path: "/x/house-brief.md" },
	sizes: { estimated: 6800, observedPrevious: 4000 },
	input: {
		raw: 9,
		sent: 5,
		suffix: 2,
		rawTokens: 12_000,
		effectiveTokens: 4_000,
		messages: [{ index: 1, role: "user", tokens: 300, preview: "task" }, { index: 2, role: "assistant", tokens: 900, preview: "answer" }],
	},
	overhead: 9_000,
};

const revision1: RevisionFile = {
	version: 1,
	revision: 1,
	sourceRevision: 0,
	at: at(3),
	beforeTokens: 9500,
	afterTokens: 2900,
	rows: [
		{ kind: "kept", sourceIndex: 0, outputIndex: 0, role: "user", beforeTokens: 300, afterTokens: 300, before: "task", after: "task" },
		{ kind: "edited", sourceIndex: 1, outputIndex: 1, role: "assistant", beforeTokens: 9000, afterTokens: 2500, before: "long\nanswer", after: "short\nanswer" },
		{ kind: "removed", sourceIndex: 2, role: "tool", beforeTokens: 200, before: "output" },
		{ kind: "added", outputIndex: 2, role: "user", afterTokens: 100, after: "note" },
	],
};

describe("buildPanelModel", () => {
	test("v0.1 session without snapshot or revisions/rN.json", () => {
		const model = buildPanelModel(files({
			events: basicEvents,
			state: { version: 1, enabled: true, revision: 2, lastOutcome: { kind: "reset", message: "/clm reset", at: at(7) } },
			revisionTexts: new Map([[1, "[[CTX_TURN ...]]\nmirror text"]]),
		}));
		expect(model.found).toBe(true);
		expect(model.revision).toBe(2);
		expect(model.enabled).toBe(true);
		expect(model.lastOutcome).toEqual({ kind: "reset", message: "/clm reset", at: at(7) });
		expect(model.timeline.points.length).toBe(4);
		expect(model.timeline.markers.length).toBe(3);
		expect(model.input).toBeUndefined();
		expect(model.budget).toBeUndefined();
		expect(model.budgetInfo).toBeUndefined();
		expect(model.revisions).toEqual([{
			revision: 1,
			sourceRevision: 0,
			createdAt: at(3),
			beforeTokens: 9500,
			afterTokens: 2900,
			edits: [],
			traceSource: "unavailable",
			mirrorText: "[[CTX_TURN ...]]\nmirror text",
		}]);
		expect(model.settings).toEqual({ rows: [], summary: [], changed: [] });
	});

	test("missing session directory", () => {
		const model = buildPanelModel(files({ found: false }));
		expect(model).toMatchObject({ found: false, enabled: true, revision: 0, revisions: [] });
		expect(model.timeline.points).toEqual([]);
	});

	test("snapshot, recorded revision and host size", () => {
		const settings = { rows: [{ key: "budget", label: "Budget", value: "40k" }], summary: ["x"], changed: [] };
		const model = buildPanelModel(files({
			events: basicEvents,
			state: { version: 1, enabled: false, revision: 2 },
			snapshot,
			revisions: new Map([[1, revision1]]),
		}), { latest: latest(7000, 6), settings });
		expect(model.enabled).toBe(false); // state.json wins over the snapshot
		expect(model.timeline.points.at(-1)).toMatchObject({ tokens: 7000, measured: true });
		expect(model.input).toEqual({
			capturedAt: at(10),
			rawMessages: 9,
			sentMessages: 5,
			suffix: 2,
			rawTokens: 12_000,
			effectiveTokens: 4_000,
			messages: snapshot.input.messages,
			mirrorPath: "/tmp/clm-ses_test/LIVE_CONTEXT.md",
			stale: false,
		});
		expect(model.calibration).toEqual({ factor: 1.1, samples: 3 });
		expect(model.steering?.name).toBe("house-brief.md");
		expect(model.settings).toBe(settings);
		const [revision] = model.revisions;
		expect(revision).toMatchObject({ revision: 1, sourceRevision: 0, beforeTokens: 9500, afterTokens: 2900, traceSource: "recorded" });
		expect(revision!.edits.map((edit) => [edit.kind, edit.sourceIndex, edit.outputIndex, edit.beforeRole, edit.afterRole])).toEqual([
			["kept", 1, 1, "user", "user"],
			["edited", 2, 2, "assistant", "assistant"],
			["removed", 3, undefined, "tool", undefined],
			["added", undefined, 3, undefined, "user"],
		]);
		expect(revision!.edits[1]).toMatchObject({ beforeText: "long\nanswer", afterText: "short\nanswer", beforePreview: "long answer" });
	});

	test("invalid revision files fall back; bad rows are dropped; warnings collected", () => {
		const revisions = buildRevisions({
			events: [accepted(2, 5, 100, 50)],
			revisions: new Map<number, unknown>([
				[1, { version: 2, rows: [] }],
				[2, { ...revision1, revision: 2, sourceRevision: 1, rows: [{ kind: "bogus" }, { kind: "kept", role: "user", before: "a", after: "a" }] }],
			]),
			revisionTexts: new Map(),
		});
		expect(revisions.map((r) => [r.revision, r.traceSource, r.edits.length])).toEqual([[1, "unavailable", 0], [2, "recorded", 1]]);
		const model = buildPanelModel(files({ skippedEventLines: 2, warnings: ["Could not read x"] }));
		expect(model.warnings).toEqual(["Could not read x", "Skipped 2 unreadable lines in events.jsonl."]);
	});

	test("unknown or malformed snapshot fields are ignored", () => {
		const model = buildPanelModel(files({ snapshot: { input: { messages: [{ index: "x" }, { index: 0, role: "user" }] }, calibration: "x" }, state: "nonsense" }));
		expect(model.input?.messages).toEqual([{ index: 0, role: "user", tokens: 0, preview: "" }]);
		expect(model.calibration).toBeUndefined();
		expect(model.enabled).toBe(true);
	});
});

describe("budget and fixed overhead", () => {
	test("snapshot overhead and budget give the usable share", () => {
		const view = buildBudget(snapshot as unknown as Record<string, unknown>, undefined, []);
		expect(view).toEqual({
			budget: 40_000, configured: 40_000, reserve: 2_000, limit: 38_000, source: "config", overhead: 9_000,
			usable: 29_000, effectiveUsable: 29_000, raised: false, capped: false, tooSmall: false,
		});
		expect(buildPanelModel(files({ snapshot })).budget).toBe(40_000);
	});

	test("usable equals budgetFit: configured − reserve − overhead; the raise is recomputed", () => {
		const events = [
			request(100, 1),
			{ type: "budget-too-small", overhead: 14_000, budget: 16_000, reserve: 2_000, effectiveBudget: 24_000, extra: { x: 1 } },
		];
		const model = buildPanelModel(files({ events }));
		expect(model.budgetInfo).toEqual({
			budget: 24_000, configured: 16_000, reserve: 2_000, overhead: 14_000,
			usable: 0, effectiveUsable: 8_000, raised: true, capped: false, tooSmall: true,
		});
		expect(model.budget).toBe(24_000);
		// A window cap stops the raise.
		expect(buildBudget(undefined, undefined, events, { budget: 16_000, reserve: 2_000, cap: 20_000 })).toMatchObject({
			budget: 20_000, raised: true, capped: true, effectiveUsable: 4_000,
		});
	});

	test("the event as clm.ts logs it, and state.budgetCheck", () => {
		const logged = {
			at: at(2), event: "budget-too-small", overhead: 14_000, source: "provider", configured: 16_000, reserve: 2_000,
			effective: 24_000, raised: true, usable: 0, margin: 8_000, minimum: 24_000, capped: false,
		};
		expect(buildBudget(undefined, undefined, [logged])).toMatchObject({
			budget: 24_000, configured: 16_000, overhead: 14_000, overheadSource: "provider", raised: true, usable: 0, effectiveUsable: 8_000, tooSmall: true,
		});
		const state = { budgetCheck: { overhead: 5_000, source: "estimate", configured: 32_000, reserve: 2_000, effective: 32_000, raised: false, at: at(2) } };
		expect(buildBudget(undefined, state, [])).toMatchObject({
			budget: 32_000, configured: 32_000, reserve: 2_000, overhead: 5_000, overheadSource: "estimate", raised: false, usable: 25_000, tooSmall: false,
		});
		// The snapshot's overhead wins over the once-per-session check.
		expect(buildBudget({ overhead: 6_000 }, state, [])?.overhead).toBe(6_000);
		expect(buildBudget(undefined, undefined, [{ event: "budget-check", overhead: 1_000 }])).toEqual({ overhead: 1_000, tooSmall: false });
	});

	test("without snapshot.json the resolved settings win over the stored check", () => {
		const state = { budgetCheck: { overhead: 14_000, source: "provider", configured: 16_000, reserve: 2_000, effective: 24_000, raised: true, at: at(2) } };
		// The user raised the budget to 64k since the check ran: no raise any more.
		expect(buildBudget(undefined, state, [], { budget: 64_000, reserve: 2_000, source: "config" })).toMatchObject({
			budget: 64_000, configured: 64_000, raised: false, tooSmall: false, usable: 48_000, source: "config",
		});
		// A v0.1 session with neither file still gets a budget line.
		expect(buildPanelModel(files({ events: basicEvents }), { budget: { budget: 32_000, reserve: 2_000 } }).budget).toBe(32_000);
	});
});

describe("snapshot staleness and roles", () => {
	test("a snapshot older than the newest request is stale", () => {
		const events = [request(100, 1), request(100, 20)];
		expect(buildPanelModel(files({ events, snapshot })).input?.stale).toBe(true);
		expect(buildPanelModel(files({ events: [request(100, 1)], snapshot })).input?.stale).toBe(false);
	});

	test("rows with beforeRole/afterRole keep both", () => {
		const [revision] = buildRevisions({
			events: [],
			revisions: new Map([[1, { ...revision1, rows: [{ kind: "edited", role: "user", beforeRole: "tool", afterRole: "user", before: "a", after: "b" }] }]]),
			revisionTexts: new Map(),
		});
		expect(revision!.edits[0]).toMatchObject({ beforeRole: "tool", afterRole: "user" });
	});
});
