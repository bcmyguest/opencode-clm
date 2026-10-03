// Tab completion for typed `/clm …` lines in the TUI prompt. OpenCode has no argument
// completion for commands (its slash menu closes at the first space), so the TUI plugin
// completes inline: Tab extends the line to the longest common prefix of the matching items
// and lists them when several remain. Items follow pi-clm's `getArgumentCompletions`
// (pi src/index.ts:961-980) plus `budget` and setting values. Written for this package.

import { PAGES } from "../panel/command.ts";
import { SETTING_NAMES, settingDescriptor } from "../settings-table.ts";
import type { FocusedPrompt, InterceptContext } from "./intercept.ts";

const PREFIX = "/clm ";

/** pi's word list: pages, status, config, `config <setting>`, config reset, on, off, reset, path; plus budget. */
export const CLM_COMPLETIONS: readonly string[] = [
	...PAGES,
	"status",
	"config",
	...SETTING_NAMES.map((name) => `config ${name}`),
	"config reset",
	"on",
	"off",
	"reset",
	"path",
	"budget",
];

/** Items for the text after `/clm `: subcommands, or a setting's choices after `config <setting> `. */
export function clmCompletions(args: string): string[] {
	const lower = args.toLowerCase();
	const value = /^config\s+(\S+)\s+(.*)$/i.exec(args);
	if (value) {
		const choices = settingDescriptor(value[1]!)?.choices ?? [];
		return choices
			.filter((choice) => choice.toLowerCase().startsWith(value[2]!.toLowerCase()))
			.map((choice) => `config ${value[1]} ${choice}`);
	}
	return CLM_COMPLETIONS.filter((item) => item.startsWith(lower));
}

function commonPrefix(items: readonly string[]): string {
	let prefix = items[0] ?? "";
	for (const item of items) {
		while (!item.startsWith(prefix)) prefix = prefix.slice(0, -1);
	}
	return prefix;
}

export interface Completion {
	/** The new prompt text; the same text when no item extends it. */
	text: string;
	/** Items still matching; more than one when the line stays ambiguous. */
	items: string[];
}

/** `undefined` unless `text` is `/clm ` followed by something an item completes. */
export function completeClmLine(text: string): Completion | undefined {
	if (!text.startsWith(PREFIX)) return undefined;
	const args = text.slice(PREFIX.length).replace(/^\s+/, "");
	const items = clmCompletions(args);
	if (items.length === 0) return undefined;
	if (items.length === 1) return { text: `${PREFIX}${items[0]} `, items };
	const common = commonPrefix(items);
	return { text: common.length > args.length ? `${PREFIX}${common}` : text, items };
}

export interface TabDeps {
	focused(): (FocusedPrompt & { cursorOffset?: unknown }) | null | undefined;
	/** False when `/clm` is not this package's (as for Enter). */
	owned(): boolean;
	/** Shows the remaining items when Tab cannot extend the line. */
	show(items: readonly string[]): void;
}

/**
 * Called for every key. Consumes Tab (no modifiers) on a `/clm …` line with the cursor at the
 * end when an item matches; everything else, `/clm` without a space (OpenCode's own slash
 * menu completes that) and lines with no match included, passes through to the host's Tab.
 * Returns the completion applied, for tests.
 */
export function interceptTab(context: InterceptContext, deps: TabDeps): Completion | undefined {
	const event = context.event;
	if (event.name !== "tab" || event.shift || event.ctrl || event.meta) return undefined;
	const focused = deps.focused();
	if (!focused || typeof focused.plainText !== "string" || typeof focused.setText !== "function") return undefined;
	const text = focused.plainText;
	if (typeof focused.cursorOffset === "number" && focused.cursorOffset !== text.length) return undefined;
	const completion = completeClmLine(text);
	if (!completion) return undefined;
	try {
		if (!deps.owned()) return undefined;
	} catch {
		return undefined;
	}
	context.consume();
	if (completion.text !== text) {
		focused.setText(completion.text);
		if (typeof focused.cursorOffset === "number") focused.cursorOffset = completion.text.length;
	} else {
		deps.show(completion.items);
	}
	return completion;
}
