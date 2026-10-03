// Tests for src/panel/timeline.ts. Cases rewritten from pi-clm src/__tests__/timeline.test.ts
// (MIT, Copyright 2026 Emanuel Casco) for events.jsonl input and styled lines.

import { describe, expect, test } from "bun:test";

import { plain, type Line } from "../../src/panel/lines.ts";
import { buildTimeline } from "../../src/panel/model.ts";
import {
	availableTimelineZooms,
	describeTimelineBucket,
	formatMarkerCompact,
	formatMarkerRow,
	formatTimelineReport,
	formatTokenCount,
	layoutTimeline,
	renderTimelineChart,
	timelineWindow,
	type ContextTimeline,
} from "../../src/panel/timeline.ts";
import type { ClmEvent } from "../../src/panel/files.ts";
import { accepted, at, basicEvents, latest, request } from "./fixtures.ts";

const text = (lines: Line[]) => lines.map(plain);
const basic = () => buildTimeline(basicEvents, latest(7000, 6));

/** `<…>` around bold spans, so selection is visible in plain assertions. */
function marked(line: Line): string {
	return line.map((part) => (part.bold ? `<${part.text}>` : part.text)).join("");
}

describe("chart", () => {
	test("labelled axis, marker above the edited bar, budget row, landmarks and x label", () => {
		const timeline = basic();
		const lines = text(renderTimelineChart(timeline, { width: 40, height: 6, budget: 6000, selectedMarker: 0 }));
		// No headroom row: the edited bar (6k of 7k) leaves room for its marker inside the plot.
		expect(lines.length).toBe(6 + 2);
		expect(lines[0]).toMatch(/^ {2}7\.0k ┤ +▼ +███/);
		const markerColumn = lines[0]!.indexOf("▼");
		expect(lines[1]![markerColumn]).toBe("█");
		// The selected edit column is drawn with █; unselected edit columns use ▓.
		expect(lines.some((line) => line.includes("▓"))).toBe(false);
		const unselected = text(renderTimelineChart(timeline, { width: 40, height: 6, budget: 6000 }));
		expect(unselected.some((line) => line.includes("▓"))).toBe(true);
		expect(lines.some((line) => line.includes("╌") && line.includes("┼"))).toBe(true);
		expect(lines.at(-2)).toMatch(/^ {5}0 ┴•─+$/);
		expect(lines.at(-1)).toMatch(/requests 1–4 of 4$/);
		expect((lines[5]!.match(/█/g) ?? []).length).toBeGreaterThanOrEqual(4);
	});

	test("selection and parts carry tones", () => {
		const timeline = basic();
		const selected = renderTimelineChart(timeline, { width: 40, height: 6, selectedMarker: 0 });
		expect(selected.some((line) => marked(line).includes("<█"))).toBe(true);
		expect(selected.flat().some((part) => part.text.includes("▼") && part.tone === "edit" && part.bold)).toBe(true);
		const now = renderTimelineChart(timeline, { width: 40, height: 6, selectedPoint: timeline.points.length - 1 });
		expect(now.some((line) => /<█+> *$/.test(marked(line)))).toBe(true);
		const edited = renderTimelineChart(timeline, { width: 40, height: 6, budget: 6000 }).flat();
		expect(edited.find((part) => part.text.includes("▓"))?.tone).toBe("edit");
		expect(edited.find((part) => part.text.includes("╌"))?.tone).toBe("warning");
		expect(edited.find((part) => part.text.includes("█"))?.tone).toBe("muted");
	});

	test("a full-height edited bar gets one headroom row for its marker", () => {
		const events: ClmEvent[] = [request(3000, 1), request(9000, 2), accepted(1, 3, 9000, 2000), request(2000, 4)];
		const lines = text(renderTimelineChart(buildTimeline(events), { width: 30, height: 4 }));
		expect(lines.length).toBe(1 + 4 + 2);
		expect(lines[0]).toMatch(/^ {8}.*▿/);
		expect(lines[1]).toMatch(/^ {2}9\.0k ┤/);
	});

	test("small sizes under a far budget still show bars; a near budget is drawn", () => {
		const small = buildTimeline([request(10_000, 1), request(4_000, 2), request(250, 3)]);
		const lines = text(renderTimelineChart(small, { width: 60, height: 6, budget: 272_000 }));
		expect(lines[0]).toMatch(/^ {3}10k ┤/);
		expect((lines[5]!.match(/█+/g) ?? []).length).toBe(3);
		expect(lines.at(-1)).toMatch(/budget 272k \(above scale\)/);
		const near = text(renderTimelineChart(small, { width: 60, height: 6, budget: 12_000 }));
		expect(near.some((line) => line.includes("┼╌"))).toBe(true);
	});

	test("empty session", () => {
		const empty = buildTimeline([]);
		expect(empty).toEqual({ points: [], markers: [], peakTokens: 0, turnStarts: [] });
		expect(text(renderTimelineChart(empty, { width: 40, height: 5 }))).toEqual(["No completed requests in this session yet."]);
	});
});

describe("zoom", () => {
	test("requests zoom shows a window that pans to the focus", () => {
		const timeline = buildTimeline(Array.from({ length: 200 }, (_v, i) => request(1000 + i * 10, i)));
		const newest = text(renderTimelineChart(timeline, { width: 30, height: 4 }));
		expect(newest.at(-1)).toMatch(/◂ \d+ earlier {2}requests \d+–200 of 200$/);
		for (const line of newest.slice(0, -1)) expect(line.length).toBeLessThanOrEqual(30);
		const focused = text(renderTimelineChart(timeline, { width: 30, height: 4, focusPoint: 50 }));
		expect(focused.at(-1)).toMatch(/◂ \d+ earlier {2}requests \d+–\d+ of 200 {2}\d+ later ▸$/);
		const start = text(renderTimelineChart(timeline, { width: 30, height: 4, focusPoint: 0 }));
		expect(start.at(-1)).toMatch(/^ +requests 1–\d+ of 200 {2}\d+ later ▸$/);
	});

	test("timelineWindow centres on the focus and stays full", () => {
		expect(timelineWindow(10, 22, 3)).toEqual({ start: 0, end: 10 });
		expect(timelineWindow(100, 20, undefined)).toEqual({ start: 80, end: 100 });
		expect(timelineWindow(100, 20, 50)).toEqual({ start: 40, end: 60 });
		expect(timelineWindow(100, 20, 99)).toEqual({ start: 80, end: 100 });
		expect(timelineWindow(100, 20, 3)).toEqual({ start: 0, end: 20 });
	});

	// 10 user turns × 30 requests; edits after requests 45 and 46 (one bucket when fitted) and 250.
	function longSession(): ContextTimeline {
		const events: ClmEvent[] = [];
		for (let turn = 0; turn < 10; turn++) {
			for (let step = 0; step < 30; step++) {
				const index = turn * 30 + step;
				events.push(request(1_000 + index * 10, index * 60, { users: turn + 1 }));
				if (index === 44) events.push(accepted(1, index * 60 + 1, 9_000, 2_000));
				if (index === 45) events.push(accepted(2, index * 60 + 1, 2_100, 2_000));
				if (index === 249) events.push(accepted(3, index * 60 + 1, 9_000, 2_000));
			}
		}
		return buildTimeline(events);
	}

	test("fit buckets the whole session and counts shared edits", () => {
		const timeline = longSession();
		expect(timeline.turnStarts).toEqual([0, 30, 60, 90, 120, 150, 180, 210, 240, 270]);
		const fit = layoutTimeline(timeline, { width: 40, zoom: "fit" });
		expect(fit.buckets[0]?.first).toBe(0);
		expect(fit.buckets.at(-1)?.last).toBe(299);
		expect(fit.requestsPerColumn).toBe(10);
		expect(fit.buckets.length).toBeLessThanOrEqual(32);
		expect(fit.buckets.some((bucket) => bucket.edits.length === 2)).toBe(true);
		const chart = renderTimelineChart(timeline, { width: 40, height: 4, zoom: "fit" });
		const lines = text(chart);
		expect(lines.some((line) => /┤.*2/.test(line))).toBe(true);
		const sharedIndex = timeline.markers.findIndex((marker) => marker.afterPoint === 44);
		const selected = renderTimelineChart(timeline, { width: 40, height: 4, zoom: "fit", selectedMarker: sharedIndex });
		expect(selected.some((line) => /<2>/.test(marked(line)))).toBe(true);
		expect(lines.at(-2)).toMatch(/•/);
		expect(lines.at(-1)).toMatch(/all 300 requests · 10\/column$/);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
		const wide = text(renderTimelineChart(timeline, { width: 90, height: 4, zoom: "fit" }));
		expect(wide.at(-1)).toMatch(/all 300 requests · 4\/column · .*–.* \(4h 59m\)$/);
	});

	test("turns zoom gives one column per turn and no landmarks", () => {
		const timeline = longSession();
		const turns = layoutTimeline(timeline, { width: 40, zoom: "turns" });
		expect(turns.buckets.length).toBe(10);
		expect(turns.buckets.map((bucket) => bucket.last - bucket.first + 1)).toEqual(Array(10).fill(30));
		const chart = text(renderTimelineChart(timeline, { width: 40, height: 4, zoom: "turns" }));
		expect(chart.at(-1)).toMatch(/10 user turns · 1\/column · 300 requests/);
		expect(chart.at(-2)).not.toMatch(/•/);
		const edited = turns.buckets.find((bucket) => bucket.edits.length > 0)!;
		expect(describeTimelineBucket(timeline, edited)).toMatch(
			/^requests 31–60 \(30\) · .* · peak 1\.6k · last ~1\.6k tok · 1 user turn · 2 accepted edits$/,
		);
		const newest = layoutTimeline(timeline, { width: 40 }).buckets.at(-1)!;
		expect(describeTimelineBucket(timeline, newest)).toMatch(/^request 300 · .+ · ~4\.0k tok$/);
	});

	test("requests zoom is not offered when fit is already one column per request", () => {
		expect(availableTimelineZooms(basic(), 40)).toEqual(["fit", "turns"]);
		expect(availableTimelineZooms(longSession(), 40)).toEqual(["fit", "requests", "turns"]);
	});
});

describe("marker rows", () => {
	test("compact rows keep revision, time, sizes and change", () => {
		const timeline = basic();
		expect(formatMarkerCompact(timeline.markers[0]!)).toMatch(/^r1 {2}.+ {3}9\.5k → 2\.9k {3}−69%$/);
		expect(formatMarkerCompact(timeline.markers[1]!)).toMatch(/^r1 {2}.+ {2}rejected: unknown block ids$/);
		expect(formatMarkerCompact(timeline.markers[2]!)).toMatch(/^r2 {2}.+ {2}reset to raw context$/);
		expect(formatMarkerCompact({ kind: "compacted", revision: 4, afterPoint: 0, message: "x", at: at(9) })).toMatch(/compacted by OpenCode$/);
	});

	test("long rows name the request they follow", () => {
		const timeline = basic();
		expect(formatMarkerRow(timeline.markers[0]!, timeline)).toMatch(/^r1 {2}\d{2}:\d{2}.*edit accepted {2}9\.5k → 2\.9k −69% {2}\(after request 2\)$/);
		expect(formatMarkerRow(timeline.markers[1]!, timeline)).toMatch(/edit rejected: unknown block ids {2}\(after request 4\)/);
		expect(formatMarkerRow(timeline.markers[2]!, timeline)).toMatch(/reset to raw context/);
		expect(formatMarkerRow({ ...timeline.markers[0]!, beforeTokens: 100, afterTokens: 150 }, timeline)).toMatch(/100 → 150 \+50%/);
	});

	test("report and token formatting", () => {
		expect(formatTokenCount(999)).toBe("999");
		expect(formatTokenCount(2_950)).toBe("3.0k");
		expect(formatTokenCount(29_952)).toBe("30k");
		expect(formatTokenCount(1_500_000)).toBe("1.5m");
		const report = formatTimelineReport(basic(), 60, 32_000);
		expect(report).toMatch(/1 accepted context edit:/);
		expect(report).toMatch(/budget 32k \(above scale\)/);
		expect(report).not.toMatch(/┼╌/);
	});
});
