// A panel page as plain text, for the server's `/clm overview|input|edits|settings` (and
// `opencode run --command clm …`), where no TUI draws the panel: the same model and page
// renderer, at a fixed width, tones dropped. pi-clm prints its pages the same way outside
// its TUI (src/index.ts, MIT, Copyright 2026 Emanuel Casco); written for this package.

import type { Page } from "./command.ts";
import { plain } from "./lines.ts";
import type { PanelModel } from "./model.ts";
import { initialPanelState, pageLines } from "./view.ts";

export const TEXT_WIDTH = 72;
/** Rows the overview's chart and marker list size themselves against. */
const TEXT_VIEWPORT = 24;

const TITLES: Record<Page, string> = { overview: "overview", input: "input", edits: "edits", settings: "settings" };

export function panelPageText(model: PanelModel, page: Page, width = TEXT_WIDTH): string {
	const state = initialPanelState(page);
	const lines = pageLines(model, state, width, TEXT_VIEWPORT).map((line) => plain(line).replace(/\s+$/, ""));
	while (lines.length > 0 && lines.at(-1) === "") lines.pop();
	return [`CLM ${TITLES[page]} · r${model.revision} · session ${model.sessionID}`, "", ...lines].join("\n");
}
