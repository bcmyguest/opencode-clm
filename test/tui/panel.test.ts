// Component test for src/tui/panel.ts: a real opentui test renderer and a fake host api
// that records the key layer, mode and dialogs.

import { afterEach, describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";

import type { Key } from "../../src/panel/keys.ts";
import { createPanel, KEY_BINDINGS, PANEL_MODE, toStyledText } from "../../src/tui/panel.ts";
import { richModel } from "../panel/model-fixture.ts";

let setup: TestRendererSetup | undefined;

afterEach(() => {
	setup?.renderer.destroy();
	setup = undefined;
});

const theme = new Proxy({}, {
	get: (_target, name) => (name === "thinkingOpacity" ? 1 : RGBA.fromHex(name === "warning" ? "#ffaa00" : "#cccccc")),
});

function fakeApi(renderer: TestRendererSetup["renderer"]) {
	const calls = { layers: [] as Array<{ mode?: string; bindings: Array<{ key: string; cmd: () => void }> }>, modes: [] as string[], popped: 0, dropped: 0, dialogs: 0 };
	const api = {
		renderer,
		theme: { current: theme },
		mode: {
			current: () => calls.modes.at(-1) ?? "base",
			push: (mode: string) => {
				calls.modes.push(mode);
				return () => {
					calls.popped++;
				};
			},
		},
		keymap: {
			registerLayer: (layer: { mode?: string; bindings: Array<{ key: string; cmd: () => void }> }) => {
				calls.layers.push(layer);
				return () => {
					calls.dropped++;
				};
			},
		},
		ui: {
			dialog: { replace: () => calls.dialogs++, clear: () => undefined },
			DialogPrompt: (props: unknown) => props,
		},
	};
	return { api: api as never, calls };
}

function press(calls: ReturnType<typeof fakeApi>["calls"], hostKey: string) {
	const binding = calls.layers[0]!.bindings.find((item) => item.key === hostKey);
	if (!binding) throw new Error(`no binding for ${hostKey}`);
	binding.cmd();
}

describe("tui panel", () => {
	test("renders the overview, switches pages through the key layer, closes cleanly", async () => {
		setup = await createTestRenderer({ width: 100, height: 30 });
		const { api, calls } = fakeApi(setup.renderer);
		let closed = 0;
		const panel = createPanel(api, {
			page: "overview",
			load: async () => richModel(),
			apply: async () => "not yet",
			onClose: () => closed++,
		});
		setup.renderer.root.add(panel.renderable);
		await panel.reload();
		await setup.renderOnce();
		await setup.renderOnce();
		let frame = setup.captureCharFrame();
		expect(frame).toContain("Live Context Viewer · r2");
		expect(frame).toContain("[1:overview]");
		expect(frame).toContain("Context size · 4 requests");
		expect(frame).toContain("fixed overhead ~9.0k");
		expect(calls.modes).toEqual([PANEL_MODE]);
		expect(calls.layers[0]!.mode).toBe(PANEL_MODE);

		press(calls, "left");
		press(calls, "left");
		press(calls, "left");
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toContain("▼");

		press(calls, "4");
		await setup.renderOnce();
		frame = setup.captureCharFrame();
		expect(frame).toContain("[4:settings]");
		expect(frame).toMatch(/› CLM editing +on/);

		press(calls, "down");
		press(calls, "return");
		expect(calls.dialogs).toBe(1); // budget has no choices: text prompt

		press(calls, "up");
		press(calls, "return"); // editing: apply → stub error message
		await Bun.sleep(10);
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toContain("⚠ not yet");

		press(calls, "3");
		press(calls, "down");
		press(calls, "return");
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toMatch(/2 old answer +~ 2 new answer/);

		press(calls, "q");
		expect(closed).toBe(1);
		expect(calls.popped).toBe(1);
		expect(calls.dropped).toBe(1);
	});

	test("every panel key has a host binding", () => {
		const keys = new Set<Key>(KEY_BINDINGS.map(([, key]) => key));
		for (const key of ["1", "2", "3", "4", "tab", "shift+tab", "left", "right", "up", "down", "pageup", "pagedown", "home", "end", "g", "G", "enter", "space", "a", "z", "r", "q", "escape"] as Key[]) {
			expect(keys.has(key)).toBe(true);
		}
	});

	test("tones map to theme colours and attributes", () => {
		const styled = toStyledText([[{ text: "a", tone: "warning", bold: true }, { text: "b" }], [{ text: "c", tone: "dim" }]], theme as never);
		expect(styled.chunks.map((chunk) => chunk.text)).toEqual(["a", "b", "\n", "c"]);
		expect(styled.chunks[0]!.attributes).toBeGreaterThan(0);
		expect(styled.chunks[0]!.fg).toBeInstanceOf(RGBA);
	});
});
