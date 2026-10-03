// opentui adapter for the `/clm` panel: one Text renderable holding the frame as
// StyledText, a key layer in its own mode, and the effects of the pure reducer (close,
// reload, settings prompt/apply). Everything else is in src/panel/*. Written for this package.
//
// `@opentui/core` must stay a static ESM import: the host rewrites it to its own instance.

import { BoxRenderable, RGBA, StyledText, TextAttributes, TextRenderable } from "@opentui/core";
import type { TextChunk } from "@opentui/core";
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui";

import type { Page } from "../panel/command.ts";
import { reduce, type Effect, type Key } from "../panel/keys.ts";
import type { Line, Tone } from "../panel/lines.ts";
import type { PanelModel } from "../panel/model.ts";
import { initialPanelState, renderPanel, type PanelSize, type PanelState } from "../panel/view.ts";

export const PANEL_MODE = "opencode-clm.panel";

/** Host key names (opentui keymap) → panel keys. */
export const KEY_BINDINGS: ReadonlyArray<readonly [string, Key]> = [
	["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"],
	["tab", "tab"], ["shift+tab", "shift+tab"],
	["left", "left"], ["right", "right"], ["up", "up"], ["down", "down"],
	["pageup", "pageup"], ["pagedown", "pagedown"],
	["home", "home"], ["end", "end"], ["g", "g"], ["shift+g", "G"],
	["return", "enter"], ["space", "space"],
	["a", "a"], ["z", "z"], ["r", "r"], ["q", "q"], ["escape", "escape"], ["ctrl+c", "q"],
	["j", "j"], ["k", "k"], ["[", "["], ["]", "]"],
];

type ToneStyle = { color: keyof TuiThemeCurrent; attributes?: number };

const TONES: Record<Tone, ToneStyle> = {
	text: { color: "text" },
	muted: { color: "textMuted" },
	dim: { color: "textMuted", attributes: TextAttributes.DIM },
	accent: { color: "accent" },
	edit: { color: "markdownLink" },
	warning: { color: "warning" },
	error: { color: "error" },
	success: { color: "success" },
	diffAdd: { color: "diffAdded" },
	diffDel: { color: "diffRemoved" },
	diffAddEm: { color: "diffHighlightAdded", attributes: TextAttributes.BOLD },
	diffDelEm: { color: "diffHighlightRemoved", attributes: TextAttributes.BOLD },
	border: { color: "border" },
};

/** Lines → one StyledText, tones resolved against the current theme. */
export function toStyledText(lines: readonly Line[], theme: TuiThemeCurrent): StyledText {
	const chunks: TextChunk[] = [];
	lines.forEach((line, index) => {
		if (index > 0) chunks.push({ __isChunk: true, text: "\n" });
		for (const part of line) {
			const style = TONES[part.tone ?? "text"];
			const color = theme[style.color];
			const attributes = (style.attributes ?? 0) | (part.bold ? TextAttributes.BOLD : 0);
			chunks.push({
				__isChunk: true,
				text: part.text,
				...(color instanceof RGBA ? { fg: color } : {}),
				...(attributes ? { attributes } : {}),
			});
		}
	});
	return new StyledText(chunks);
}

/** A one-line text renderable for a host slot (the footer), restyled on each `set`. */
export function createFooter(api: Pick<TuiPluginApi, "renderer" | "theme">, id: string): { renderable: TextRenderable; set(text: string | undefined): void } {
	const renderable = new TextRenderable(api.renderer, { id, content: "", wrapMode: "none" });
	return {
		renderable,
		set(text) {
			renderable.content = toStyledText(text ? [[{ text, tone: "muted" }]] : [[]], api.theme.current);
		},
	};
}

export interface PanelOptions {
	page: Page;
	/** Reads the session files and builds the model. Never rejects with a broken panel: errors become a model. */
	load: () => Promise<PanelModel>;
	/** Applies a setting; resolves to an error message, or undefined on success. */
	apply: (setting: string, value: string) => Promise<string | undefined>;
	/** Called once after the panel released its key layer and mode (q, Esc, ctrl+c). */
	onClose: () => void;
	/** Called once when the panel is disposed for any reason, including the host unmounting the route. */
	onDispose?: () => void;
}

export interface PanelController {
	readonly renderable: BoxRenderable;
	dispatch(key: Key): void;
	reload(): Promise<void>;
	setPage(page: Page): void;
	/** Current state and model, for tests. */
	snapshot(): { state: PanelState; model: PanelModel | undefined };
	dispose(): void;
}

type PanelApi = Pick<TuiPluginApi, "renderer" | "theme" | "keymap" | "mode" | "ui">;

export function createPanel(api: PanelApi, options: PanelOptions): PanelController {
	let state = initialPanelState(options.page);
	let model: PanelModel | undefined;
	let disposed = false;
	const box = new BoxRenderable(api.renderer, { id: "opencode-clm-panel", width: "100%", height: "100%", flexDirection: "column" });
	const text = new TextRenderable(api.renderer, { id: "opencode-clm-panel-text", content: "Loading CLM panel…", wrapMode: "none", width: "100%", height: "100%" });
	box.add(text);

	const size = (): PanelSize => ({
		width: Math.max(20, box.width || api.renderer.width),
		height: Math.max(10, box.height || api.renderer.height),
	});
	const render = () => {
		if (disposed || !model) return;
		text.content = toStyledText(renderPanel(model, state, size()), api.theme.current);
	};
	box.onSizeChange = render;
	// Leaving the route any other way (another plugin's navigate, a session event) removes or
	// destroys the box: release the key mode then, or the prompt's base-mode keys stay dead.
	const unmounted = () => controller.dispose();
	(box as unknown as { onRemove: () => void }).onRemove = unmounted;
	(box as unknown as { on?: (event: string, fn: () => void) => void }).on?.("destroyed", unmounted);

	const popMode = api.mode.push(PANEL_MODE);
	const dropLayer = api.keymap.registerLayer({
		mode: PANEL_MODE,
		bindings: KEY_BINDINGS.map(([key, panelKey]) => ({ key, desc: `CLM panel: ${panelKey}`, cmd: () => controller.dispatch(panelKey) })),
	});

	const perform = (effect: Effect | undefined) => {
		if (!effect) return;
		switch (effect.kind) {
			case "close":
				controller.dispose();
				options.onClose();
				return;
			case "reload":
				void controller.reload();
				return;
			case "apply":
				void applySetting(effect.setting, effect.value);
				return;
			case "prompt":
				api.ui.dialog.replace(() =>
					api.ui.DialogPrompt({
						title: `${effect.setting} · currently ${effect.current}`,
						...(effect.placeholder ? { placeholder: effect.placeholder } : {}),
						value: effect.current,
						onConfirm: (value: string) => {
							api.ui.dialog.clear();
							if (value.trim() !== "") void applySetting(effect.setting, value.trim());
						},
						onCancel: () => api.ui.dialog.clear(),
					}),
				);
				return;
		}
	};

	const applySetting = async (setting: string, value: string) => {
		const error = await options.apply(setting, value).catch((cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));
		await controller.reload();
		const row = model?.settings.rows.find((candidate) => candidate.key === setting);
		const shown = `${row?.label ?? setting}: ${row?.value ?? value}`;
		state = { ...state, message: error ? { text: error, warning: true } : { text: shown, warning: false } };
		render();
	};

	const controller: PanelController = {
		renderable: box,
		dispatch(key) {
			if (disposed || !model) {
				if (key === "q" || key === "escape") perform({ kind: "close" });
				return;
			}
			const result = reduce(state, key, model, size());
			state = result.state;
			render();
			perform(result.effect);
		},
		async reload() {
			const next = await options.load();
			if (disposed) return;
			model = next;
			render();
		},
		setPage(page) {
			state = { ...state, page, scroll: 0 };
			render();
		},
		snapshot: () => ({ state, model }),
		dispose() {
			if (disposed) return;
			disposed = true;
			dropLayer();
			popMode();
			options.onDispose?.();
		},
	};
	void controller.reload();
	return controller;
}
