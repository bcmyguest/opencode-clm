// Parity block 7 (P6): pi's settings-page Size line and compaction state, from session files.
import { describe, expect, test } from "bun:test";

import { buildTimeline } from "../../src/panel/model.ts";
import { resolveSettings } from "../../src/settings.ts";
import { detailLines, sizeLine } from "../../src/tui/data.ts";
import { basicEvents, latest, request } from "../panel/fixtures.ts";

describe("settings size line", () => {
	test("a measured request keeps its logged estimate beside the provider count", () => {
		const points = buildTimeline(basicEvents, latest(7000, 6)).points;
		expect(points.map((p) => p.estimated)).toEqual([2800, 5900, 3900, 6800]);
		expect(sizeLine(points.at(-1)!, 32_000)).toBe("Size last request 7.0k of 32k (provider count) · estimated ~6.8k");
	});

	test("an unmeasured request shows the estimate only, and no field is added", () => {
		const point = buildTimeline([request(900, 1)]).points[0]!;
		expect(point.estimated).toBeUndefined();
		expect(sizeLine(point, 32_000)).toBe("Size last request ~900 of 32k (estimate)");
		expect(sizeLine(point)).toBe("Size last request ~900 (estimate)");
	});

	test("the guard line names compaction off", () => {
		const off = { editing: true, settings: resolveSettings({ compaction: "off" }, {}, "/tmp") };
		expect(detailLines(off, { budgetInfo: { limit: 30_000, tooSmall: false } })).toEqual([
			"Guard withholds the oldest tool results above 30k · OpenCode's automatic compaction off",
		]);
	});
});
