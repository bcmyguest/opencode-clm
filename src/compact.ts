// Adapted from pi-clm src/compact.ts (MIT, Copyright 2026 Emanuel Casco).
/**
 * `/clm-compact [instructions]`: ask the model to compact its own live context now.
 *
 * This is a fixed prompt, not a harness-side edit: the model decides what to keep and
 * edits the mirror with its tools, and the edit is validated and committed before the next
 * request like any other. (OpenCode's own compaction instead summarizes the raw transcript
 * with a separate model call.)
 *
 * A replacement template (the `compactPrompt` setting) may use `{{mirror}}`, `{{current}}`,
 * `{{budget}}` and `{{instructions}}`; unknown placeholders are left as written.
 */

import { readFileSync } from "node:fs";

import { formatTokens } from "./budget.ts";

export const DEFAULT_COMPACT_PROMPT = `Compact your live context now.

Your next request is about {{current}} tokens{{budget}}. Your context is mirrored at \`{{mirror}}\`; edit that file, following the Editable context protocol, to remove what you no longer need.

Keep what you still need: the task and the user's latest requests, decisions and their reasons, open items, and exact values (ids, paths, numbers) you will use again. Drop what you no longer need: tool output you have already used, superseded drafts and intermediate steps. Prefer one scripted edit of the whole file over many small ones.

{{instructions}}

When the edit is saved, reply in one line: what you kept, and the new approximate size.`;

export interface CompactPromptValues {
	mirror: string;
	/** Calibrated size of the next request, tokens. */
	current: number;
	budget?: number;
	/** Free text after `/clm-compact`. */
	instructions?: string;
}

export function buildCompactPrompt(template: string, values: CompactPromptValues): string {
	const instructions = values.instructions?.trim() ? `Also: ${values.instructions.trim()}` : "";
	const replacements = new Map<string, string>([
		["mirror", values.mirror],
		["current", formatTokens(values.current)],
		["budget", values.budget === undefined ? "" : ` (budget ${formatTokens(values.budget)})`],
		["instructions", instructions],
	]);
	// Typed instructions are never dropped: a template without the placeholder gets them at the end.
	const withInstructions = instructions && !template.includes("{{instructions}}") ? `${template}\n\n{{instructions}}` : template;
	// An empty instructions slot takes its own blank lines with it; the rest of the template stays as written.
	const emptySlot = "\u0000";
	return withInstructions
		.replace(/\{\{(\w+)\}\}/g, (match, name: string) => (name === "instructions" && !instructions ? emptySlot : replacements.get(name) ?? match))
		.replace(/\n*\u0000\n*/g, (slot) => (slot.includes("\n") ? "\n\n" : ""))
		.trim();
}

/** `CLM_COMPACT_PROMPT`: a template path; unset, `default`, `none` or `off` mean the built-in prompt. */
export function compactPromptFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
	const raw = env.CLM_COMPACT_PROMPT?.trim();
	if (!raw || ["default", "none", "off"].includes(raw.toLowerCase())) return undefined;
	return raw;
}

/** The built-in prompt, or the template at `path` (read on every use, so edits apply at once). */
export function loadCompactPrompt(path: string | undefined): string {
	if (!path) return DEFAULT_COMPACT_PROMPT;
	let text: string;
	try {
		text = readFileSync(path, "utf8").trim();
	} catch (error) {
		throw new Error(`compactPrompt: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!text) throw new Error(`compactPrompt: template is empty: ${path}`);
	return text;
}
