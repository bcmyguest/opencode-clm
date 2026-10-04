// Tests for src/panel/keys.ts: the key table (after pi-clm viewer.ts handleInput).

import { describe, expect, test } from "bun:test";

import { initialPanelState, reduce, withMessage, type Key, type PanelState } from "../../src/panel/keys.ts";
import { plain } from "../../src/panel/lines.ts";
import { buildPanelModel, type PanelModel } from "../../src/panel/model.ts";
import { renderPanel } from "../../src/panel/view.ts";
import { accepted, files, request } from "./fixtures.ts";
import { richModel } from "./model-fixture.ts";

const size = { width: 90, height: 30 };

function press(keys: Key[], model: PanelModel = richModel(), start: PanelState = initialPanelState(), at = size) {
	let state = start;
	let effect;
	for (const key of keys) ({ state, effect } = reduce(state, key, model, at));
	return { state, effect };
}

describe("pages", () => {
	test("digits, Tab and Shift+Tab", () => {
		expect(press(["3"]).state.page).toBe("edits");
		expect(press(["tab"]).state.page).toBe("input");
		expect(press(["shift+tab"]).state.page).toBe("settings");
		expect(press(["4", "tab"]).state.page).toBe("overview");
		expect(press(["9" as Key]).state.page).toBe("overview");
	});

	test("q, Esc close; r reloads", () => {
		expect(press(["q"]).effect).toEqual({ kind: "close" });
		expect(press(["2", "escape"]).effect).toEqual({ kind: "close" });
		expect(press(["r"]).effect).toEqual({ kind: "reload" });
	});
});

describe("overview", () => {
	test("← → and ↑ ↓ (j k, [ ]) step through markers; the last stop is now", () => {
		expect(press(["left"]).state.markerSel).toBe(2);
		expect(press(["left", "left", "left", "left", "left"]).state.markerSel).toBe(0);
		expect(press(["left", "right"]).state.markerSel).toBeUndefined();
		expect(press(["right"]).state.markerSel).toBeUndefined();
		expect(press(["k", "["]).state.markerSel).toBe(1);
		expect(press(["up", "down", "j"]).state.markerSel).toBeUndefined();
		expect(press(["g"]).state.markerSel).toBe(0);
		expect(press(["g", "G"]).state.markerSel).toBeUndefined();
		expect(press(["home", "end"]).state.markerSel).toBeUndefined();
	});

	test("Enter on an applied marker opens its revision; on now opens input; others do nothing", () => {
		const edits = press(["g", "enter"]).state;
		expect(edits).toMatchObject({ page: "edits", revisionIndex: 0, editSel: 0 });
		expect(press(["enter"]).state.page).toBe("input");
		expect(press(["left", "enter"]).state.page).toBe("overview"); // reset marker
	});

	test("z cycles the zooms offered at this width", () => {
		// 4 requests fit the width: requests zoom is skipped.
		expect(press(["z"]).state.zoom).toBe("turns");
		expect(press(["z", "z"]).state.zoom).toBe("fit");
		const many = buildPanelModel(files({ events: Array.from({ length: 300 }, (_v, i) => request(1000 + i, i)) }));
		expect(press(["z"], many).state.zoom).toBe("requests");
		const help = renderPanel(many, press(["z"], many).state, size).map(plain).at(-2);
		expect(help).toMatch(/z zoom: detail/);
	});
});

describe("edits", () => {
	test("↑ ↓ select rows, Enter/Space expand, a toggles all", () => {
		const { state } = press(["3", "down", "enter"]);
		expect(state.editSel).toBe(1);
		expect([...state.expanded]).toEqual(["1:1"]);
		expect([...press(["3", "down", "enter", "space"]).state.expanded]).toEqual([]);
		expect(press(["3", "a"]).state.expanded.size).toBe(3);
		expect(press(["3", "a", "a"]).state.expanded.size).toBe(0);
		expect(press(["3", "down", "down", "down", "down"]).state.editSel).toBe(2);
		expect(press(["3", "G"]).state.editSel).toBe(2);
		expect(press(["3", "G", "g"]).state).toMatchObject({ editSel: 0, scroll: 0 });
	});

	test("← → switch revisions and reset the row", () => {
		const model = buildPanelModel(files({ events: [request(10, 1), accepted(1, 2, 10, 5), request(5, 3), accepted(2, 4, 5, 3)] }));
		expect(press(["3"], model).state.revisionIndex).toBeUndefined(); // newest
		expect(press(["3", "left"], model).state).toMatchObject({ revisionIndex: 0, editSel: 0 });
		expect(press(["3", "left", "left", "right", "right"], model).state.revisionIndex).toBe(1);
	});

	test("↓ scrolls inside a long expanded diff before moving on", () => {
		const long = Array.from({ length: 60 }, (_v, i) => `line ${i}`).join("\n");
		const model = richModel();
		const edit = model.revisions[0]!.edits[1]!;
		edit.beforeText = long;
		edit.afterText = long.replace(/line/g, "LINE");
		const small = { width: 90, height: 16 };
		let { state } = press(["3", "down", "enter"], model, initialPanelState(), small);
		expect(state.editSel).toBe(1);
		const before = state.scroll;
		state = reduce(state, "down", model, small).state;
		expect(state.editSel).toBe(1);
		expect(state.scroll).toBe(before + 1);
		state = press(["pagedown", "pagedown", "pagedown", "pagedown", "pagedown", "pagedown", "pagedown", "pagedown", "pagedown", "pagedown", "pagedown"], model, state, small).state;
		expect(state.editSel).toBe(2);
		const screen = renderPanel(model, state, small).map(plain).join("\n");
		expect(screen).toMatch(/› ▸ − #3 tool/);
	});
});

describe("input", () => {
	test("↑ ↓ PgUp PgDn g G scroll, clamped to the page", () => {
		const small = { width: 90, height: 10 };
		expect(press(["2", "down", "down"], richModel(), initialPanelState(), small).state.scroll).toBe(2);
		expect(press(["2", "up"], richModel(), initialPanelState(), small).state.scroll).toBe(0);
		const end = press(["2", "G"], richModel(), initialPanelState(), small).state.scroll;
		expect(end).toBeGreaterThan(0);
		expect(end).toBeLessThan(100);
		expect(press(["2", "pagedown", "pagedown", "pagedown", "pagedown"], richModel(), initialPanelState(), small).state.scroll).toBe(end);
	});
});

describe("settings", () => {
	test("↑ ↓ select; Enter cycles a choice or opens a prompt", () => {
		expect(press(["4", "down"]).state.settingSel).toBe(1);
		expect(press(["4", "down", "down", "up"]).state.settingSel).toBe(0);
		expect(press(["4", "enter"]).effect).toEqual({ kind: "apply", setting: "editing", value: "off" });
		expect(press(["4", "down", "space"]).effect).toEqual({ kind: "prompt", setting: "budget", current: "16k", placeholder: "32k" });
	});

	test("a result message keeps the selected row in view and limits the scroll", () => {
		const many = { ...richModel() };
		many.settings = {
			...many.settings,
			rows: Array.from({ length: 40 }, (_unused, index) => ({ key: `s${index}`, label: `Setting ${index}`, value: `v${index}` })),
		};
		const small = { width: 90, height: 20 }; // 14 body rows; 13 with a one-line message
		// Select the row that sits on the last body row (header: title, summary, blank = 3 lines).
		const selected = press(Array.from({ length: 10 }, () => "down" as Key), many, initialPanelState("settings"), small).state;
		expect(selected).toMatchObject({ settingSel: 10, scroll: 0 });
		const shown = withMessage(selected, { text: "Setting 10: x", warning: false }, many, small);
		expect(shown.scroll).toBe(1);
		const text = renderPanel(many, shown, small).map(plain);
		expect(text.join("\n")).toMatch(/› Setting 10 /);
		expect(text.at(-4)).toMatch(/✓ Setting 10: x/);
		// End scrolls to the last line above the message, which stays visible.
		const end = press(["end"], many, shown, small).state;
		expect(renderPanel(many, end, small).map(plain).at(-4)).toMatch(/✓ Setting 10: x/);
		expect(withMessage(initialPanelState("overview"), { text: "x", warning: false }, many, small).scroll).toBe(0);
	});

	test("a key clears the result message; Tab and q stay panel keys", () => {
		const start = { ...initialPanelState("settings"), message: { text: "x", warning: false } };
		expect(press(["down"], richModel(), start).state.message).toBeUndefined();
		expect(press(["tab"], richModel(), start).state.page).toBe("overview");
		expect(press(["q"], richModel(), start).effect).toEqual({ kind: "close" });
	});
});
