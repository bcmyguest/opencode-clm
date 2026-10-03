// Tests for src/panel/view.ts: every page as plain text.

import { describe, expect, test } from "bun:test";

import { lineWidth, plain } from "../../src/panel/lines.ts";
import { buildPanelModel } from "../../src/panel/model.ts";
import { budgetLine, initialPanelState, renderPanel, windowAroundSelection, type PanelState } from "../../src/panel/view.ts";
import { basicEvents, files } from "./fixtures.ts";
import { richModel } from "./model-fixture.ts";

const size = { width: 90, height: 30 };
const screen = (state: PanelState, model = richModel(), at = size) => renderPanel(model, state, at).map(plain);

describe("frame", () => {
	test("exact size, title, tabs and help row", () => {
		const lines = renderPanel(richModel(), initialPanelState(), size);
		expect(lines.length).toBe(30);
		for (const line of lines) expect(lineWidth(line)).toBe(90);
		const text = lines.map(plain);
		expect(text[0]).toMatch(/^╭─+ Live Context Viewer · r2 ─+╮$/);
		expect(text[1]).toMatch(/^│ \[1:overview\] {2}2:input {3}3:edits {3}4:settings +│$/);
		expect(text.at(-2)).toMatch(/← → select · z zoom: all · Enter open/);
		expect(text.at(-1)).toMatch(/^╰─+╯$/);
	});

	test("a long page shows its line position", () => {
		const text = screen({ ...initialPanelState("edits"), expanded: new Set(["1:0", "1:1", "1:2"]) }, richModel(), { width: 90, height: 14 });
		expect(text.at(-2)).toMatch(/^│ lines 1-8\/\d+ · 1–4 or Tab/);
	});
});

describe("overview", () => {
	test("title, budget line with overhead and usable, chart, markers and now", () => {
		const text = screen(initialPanelState()).join("\n");
		expect(text).toMatch(/Context size · 4 requests · now 7\.0k · peak 7\.0k · budget 19k/);
		expect(text).toMatch(/Budget was too small: fixed overhead ~9\.0k · usable 5\.0k of 16k · reserve 2\.0k ·/);
		expect(text).toMatch(/raised to 19k, usable 8\.0k/);
		expect(text).toMatch(/7\.0k ┤/);
		expect(text).toMatch(/▸ r1 .* 9\.5k → 2\.9k {3}−69%/);
		expect(text).toMatch(/▸ r1 .*rejected: unknown block ids/);
		expect(text).toMatch(/› ▾ now .* 7\.0k/);
		expect(text).toMatch(/Enter: current input/);
	});

	test("a selected marker expands with its counts", () => {
		const text = screen({ ...initialPanelState(), markerSel: 0 }).join("\n");
		expect(text).toMatch(/› ▾ r1 /);
		expect(text).toMatch(/after request 2 · 1 edited · 1 removed · 1 kept/);
		expect(text).toMatch(/Enter: before\/after in edits/);
		expect(text).toMatch(/▼/);
	});

	test("notices: projection off and last edit rejected", () => {
		const off = buildPanelModel(files({ events: basicEvents, state: { version: 1, enabled: false, revision: 0 } }));
		expect(screen(initialPanelState(), off).join("\n")).toMatch(/Projection off: the model sees the raw history \(\/clm on\)\./);
		const rejected = buildPanelModel(files({ state: { version: 1, enabled: true, revision: 0, lastOutcome: { kind: "rejected", message: "bad ids", at: "x" } } }));
		expect(screen(initialPanelState(), rejected).join("\n")).toMatch(/Last edit rejected: bad ids/);
	});

	test("v0.1 session: estimated now, no budget line; missing directory", () => {
		const v01 = buildPanelModel(files({ events: basicEvents }));
		const text = screen(initialPanelState(), v01).join("\n");
		expect(text).toMatch(/now ~6\.8k/);
		expect(text).not.toMatch(/Budget/);
		const missing = buildPanelModel(files({ found: false }));
		expect(screen(initialPanelState(), missing).join("\n")).toMatch(/No CLM data for this session\./);
	});

	test("budget line only when there is something to say", () => {
		expect(budgetLine(undefined)).toBeUndefined();
		expect(budgetLine({ tooSmall: false, budget: 32_000 })).toBeUndefined();
		expect(plain(budgetLine({ tooSmall: false, overhead: 5_000, configured: 32_000, usable: 25_000, reserve: 2_000 })!))
			.toBe("Budget: fixed overhead ~5.0k · usable 25k of 32k · reserve 2.0k");
		expect(budgetLine({ tooSmall: true, overhead: 30_000, configured: 32_000, usable: 0 })?.[0]?.tone).toBe("warning");
	});

	test("windowAroundSelection keeps the selection and marks what is cut", () => {
		const groups = Array.from({ length: 10 }, (_v, i) => [[{ text: `row ${i}` }]]);
		const more = (count: number, where: string) => [{ text: `⋯ ${count} ${where}` }];
		expect(windowAroundSelection(groups, 5, 5, more).map(plain)).toEqual(["⋯ 4 earlier", "row 4", "row 5", "row 6", "⋯ 3 later"]);
		expect(windowAroundSelection(groups, 0, 20, more).length).toBe(10);
	});
});

describe("input", () => {
	test("savings bar, counts and messages", () => {
		const text = screen(initialPanelState("input")).join("\n");
		expect(text).toMatch(/Current input · what the next model request will contain/);
		expect(text).toMatch(/█+░+ 66\.7% removed/);
		expect(text).toMatch(/Tokens {7}12k raw → 4\.0k effective/);
		expect(text).toMatch(/Messages {5}9 raw → 5 effective · 2 after the last edit/);
		expect(text).toMatch(/#1 user 300 tok · task/);
		expect(text).toMatch(/Mirror: \/tmp\/clm-ses_test\/LIVE_CONTEXT\.md/);
		expect(text).not.toMatch(/Newer requests/);
	});

	test("without a snapshot", () => {
		const text = screen(initialPanelState("input"), buildPanelModel(files({ events: basicEvents }))).join("\n");
		expect(text).toMatch(/No input snapshot yet/);
	});
});

describe("edits", () => {
	test("header, rows and a side-by-side diff", () => {
		const collapsed = screen(initialPanelState("edits")).join("\n");
		expect(collapsed).toMatch(/Live-context compression runs/);
		expect(collapsed).toMatch(/Runs {2}← \[r1\] → {3}1\/1/);
		expect(collapsed).toMatch(/r1 from r0 · 9\.5k→2\.9k tokens · exact recorded provenance/);
		expect(collapsed).toMatch(/› ▸ = #1 →#1 user · kept · 300→300 tok/);
		expect(collapsed).toMatch(/ {2}▸ ~ #2 →#2 assistant · edited · 9\.0k→2\.5k tok/);
		expect(collapsed).toMatch(/ {2}▸ − #3 tool · removed · 200 tok/);
		const open = screen({ ...initialPanelState("edits"), editSel: 1, expanded: new Set(["1:1"]) }).join("\n");
		expect(open).toMatch(/before · #2 assistant · 9\.0k tok +│ after · #2 assistant · 2\.5k tok/);
		expect(open).toMatch(/2 old answer +~ 2 new answer/);
		expect(open).toMatch(/3 tail +│ 3 tail/);
	});

	test("narrow panel uses the unified diff", () => {
		const text = screen({ ...initialPanelState("edits"), editSel: 1, expanded: new Set(["1:1"]) }, richModel(), { width: 50, height: 30 }).join("\n");
		expect(text).toMatch(/-2 old answer/);
		expect(text).toMatch(/\+2 new answer/);
	});

	test("kept row expands to its content; v0.1 revision shows the mirror text", () => {
		expect(screen({ ...initialPanelState("edits"), expanded: new Set(["1:0"]) }).join("\n")).toMatch(/content · 300 tok +│\n│ {7}task/);
		const v01 = buildPanelModel(files({ events: basicEvents, revisionTexts: new Map([[1, "[[CTX_TURN a]]\nbody"]]) }));
		const text = screen(initialPanelState("edits"), v01).join("\n");
		expect(text).toMatch(/provenance unavailable/);
		expect(text).toMatch(/Accepted mirror text \(revisions\/r1\.md\):/);
		expect(text).toMatch(/\[\[CTX_TURN a\]\]/);
		const none = buildPanelModel(files({ events: [] }));
		expect(screen(initialPanelState("edits"), none).join("\n")).toMatch(/No accepted live-context compression/);
	});
});

describe("settings", () => {
	test("rows, selection, description and message", () => {
		const text = screen({ ...initialPanelState("settings"), message: { text: "Budget: 20k", warning: false } }).join("\n");
		expect(text).toMatch(/Settings · changes apply from the next request/);
		expect(text).toMatch(/Size last request 7\.0k/);
		expect(text).toMatch(/› CLM editing +on/);
		expect(text).toMatch(/ {3}Budget +16k/);
		expect(text).toMatch(/Whether edits apply\./);
		expect(text).toMatch(/Enter: next value/);
		expect(text).toMatch(/✓ Budget: 20k/);
		expect(screen({ ...initialPanelState("settings"), settingSel: 1 }).join("\n")).toMatch(/Enter: type a value/);
	});

	test("no rows", () => {
		const bare = buildPanelModel(files());
		expect(screen(initialPanelState("settings"), bare).join("\n")).toMatch(/Settings are not available here\./);
	});
});
