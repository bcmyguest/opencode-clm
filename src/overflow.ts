/**
 * Overflow guard: keep the next request under the budget when the model has not.
 *
 * Adapted from pi-clm src/overflow.ts (MIT, Copyright 2026 Emanuel Casco).
 *
 * Reminders arrive at request boundaries, but one assistant turn with many parallel tool
 * calls can add tens of thousands of tokens at once. When the estimated request exceeds
 * the guard limit, tool results are *withheld* from the effective context, oldest first —
 * each replaced by a short note giving the tool, call id, size, and a file holding the
 * full text — until the estimate fits or nothing withholdable is left.
 *
 * Properties:
 * - transcript-only: OpenCode's stored parts are untouched and no tool is ever re-run;
 * - oldest first, tool results only; user, assistant and note blocks are never touched.
 *   Oldest first matters: the result the model just asked for (often a re-read of a
 *   withheld file) must stay visible, otherwise withholding turns into a loop;
 * - deterministic and cached per source message, so repeated transform calls agree;
 * - a note keeps the `toolResult` role and `toolCallId`, so tool-call pairing stays legal,
 *   and carries `withheld: true` so the unflatten step writes it into the tool part;
 * - the note is an ordinary block in the mirror: the model can shorten, delete, or
 *   replace it, and can re-read the saved file.
 *
 * OpenCode differences from pi-clm: the limit has no `window − 4096` ceiling (that one
 * models pi-ai's `max_tokens` clamp). The caller must therefore pass the model's output
 * limit to `resolveBudget` (budget.ts), which subtracts it from the window; otherwise the
 * guard limit can exceed the room OpenCode leaves for input. The saved file holds the
 * uncapped output when the observation cap cut it.
 */

import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { uncappedSource } from "./observation.ts";
import type { LiveContextMessage } from "./types.ts";

export interface OverflowGuardPolicy {
	mode: "withhold" | "off";
}

export const DEFAULT_OVERFLOW_GUARD: OverflowGuardPolicy = { mode: "withhold" };

/** Prefix of every withheld note; a result that starts with it is never withheld again. */
export const WITHHELD_NOTE_PREFIX = "[clm overflow guard]";

export function resolveOverflowGuard(overrides: Partial<OverflowGuardPolicy> | undefined): OverflowGuardPolicy {
	return { ...DEFAULT_OVERFLOW_GUARD, ...(overrides ?? {}) };
}

/** The limit the guard enforces: the budget minus the generation reserve (at least 1). */
export function overflowGuardLimit(budget: number, reserve: number): number {
	return Math.max(1, budget - reserve);
}

export interface WithheldRecord {
	message: LiveContextMessage;
	toolCallId: string;
	toolName: string;
	tokens: number;
	file?: string;
}

export interface OverflowGuardResult {
	messages: LiveContextMessage[];
	withheld: WithheldRecord[];
	/** Estimated tokens of the returned messages plus `fixedTokens` (same estimator as the caller). */
	estimated: number;
}

interface TextPart {
	type: "text";
	text: string;
}

function toolResultText(message: LiveContextMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is TextPart => Boolean(part) && typeof part === "object" && (part as TextPart).type === "text" && typeof (part as TextPart).text === "string")
		.map((part) => part.text)
		.join("\n");
}

/** Short by design: notes accumulate, so each costs as little context as possible. */
export function withheldNoteText(record: Omit<WithheldRecord, "message">): string {
	const where = record.file ? ` Full text: ${record.file}` : " Full text remains in the session history.";
	return `${WITHHELD_NOTE_PREFIX} ${record.toolName}#${record.toolCallId} (~${record.tokens.toLocaleString("en-US")} tok) withheld over budget.${where}`;
}

const withheldCache = new WeakMap<LiveContextMessage, LiveContextMessage>();
const savedFiles = new WeakMap<LiveContextMessage, string>();

export interface ApplyOverflowGuardOptions {
	limit: number;
	/** Estimated tokens of everything outside `messages` (system prompt, notices). */
	fixedTokens: number;
	estimate: (messages: LiveContextMessage[]) => number;
	/** Directory for saved outputs (`<mirror dir>/withheld`); omitted → nothing is written. */
	saveDirectory?: string;
	/** Only messages at or after this index are candidates (the raw suffix after the last accepted edit); default 0. */
	protectBefore?: number;
}

const MAX_FILE_NAME = 120;

function safeName(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * `<ocMessageID>-<callID>.txt`, sanitized. Call ids repeat across messages, so the
 * message id is part of the name. Names over 120 characters are cut and suffixed with a
 * short hash of the source text.
 */
export function withheldFileName(source: LiveContextMessage, index: number, text: string): string {
	const base = `${safeName(String(source.ocMessageID ?? "msg"))}-${safeName(String(source.toolCallId ?? `idx${index}`))}`;
	if (base.length + 4 <= MAX_FILE_NAME) return `${base}.txt`;
	const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);
	return `${base.slice(0, MAX_FILE_NAME - 4 - hash.length - 1)}-${hash}.txt`;
}

function saveFullText(source: LiveContextMessage, index: number, directory: string): string | undefined {
	let fd: number | undefined;
	try {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700); // an existing directory keeps its old mode otherwise
		const text = toolResultText(uncappedSource(source));
		const file = join(directory, withheldFileName(source, index, text));
		// O_NOFOLLOW: never write through a symlink planted at the target path.
		fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
		fchmodSync(fd, 0o600); // an existing file keeps its old mode otherwise
		writeSync(fd, text);
		return file;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * Withhold tool results, oldest first, until `fixedTokens + estimate(messages) <= limit`.
 * Returns the same array when nothing needed to change.
 */
export function applyOverflowGuard(messages: LiveContextMessage[], options: ApplyOverflowGuardOptions): OverflowGuardResult {
	let current = messages;
	let estimated = options.fixedTokens + options.estimate(current);
	const withheld: WithheldRecord[] = [];
	if (estimated <= options.limit) return { messages, withheld, estimated };

	const candidates: number[] = [];
	for (let index = Math.max(0, options.protectBefore ?? 0); index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role !== "toolResult") continue;
		if (withheldCache.get(message) === message) continue; // already a note
		if (toolResultText(message).startsWith(WITHHELD_NOTE_PREFIX)) continue;
		candidates.push(index);
	}
	if (candidates.length === 0) return { messages, withheld, estimated };

	const output = [...messages];
	for (const index of candidates) {
		const source = output[index]!;
		const tokens = options.estimate([source]);
		let file = savedFiles.get(source);
		if (!file && options.saveDirectory) {
			file = saveFullText(source, index, options.saveDirectory);
			if (file) savedFiles.set(source, file);
		}
		const record: WithheldRecord = {
			message: source,
			toolCallId: String(source.toolCallId ?? "unknown"),
			toolName: String(source.toolName ?? "tool"),
			tokens,
			file,
		};
		let note = withheldCache.get(source);
		if (!note) {
			// A note replaces the whole result, so the cap flag no longer applies.
			const { capped: _capped, ...rest } = source;
			note = {
				...rest,
				content: [{ type: "text", text: withheldNoteText(record) }],
				withheld: true,
			};
			withheldCache.set(source, note);
			withheldCache.set(note, note);
		}
		output[index] = note;
		withheld.push(record);
		current = output;
		estimated = options.fixedTokens + options.estimate(current);
		if (estimated <= options.limit) break;
	}
	return { messages: current, withheld, estimated };
}

/** `noticesOnly` (`mode notices-only`): no mirror, so the text names no edit. */
export function overflowNoticeText(result: OverflowGuardResult, limit: number, options: { noticesOnly?: boolean } = {}): string {
	const count = result.withheld.length;
	const files = result.withheld.filter((record) => record.file).length;
	const list = result.withheld
		.map((record) => `${record.toolName}#${record.toolCallId} (~${record.tokens.toLocaleString("en-US")} tok)`)
		.join(", ");
	const fits = result.estimated <= limit;
	return (
		`[CLM BUDGET] Overflow guard: the request would have exceeded the limit of ${limit.toLocaleString("en-US")} tokens, so ${count} tool result${count === 1 ? "" : "s"} ` +
		`${count === 1 ? "was" : "were"} withheld from your context and replaced by notes${files > 0 ? " with file paths" : ""}: ${list}. ` +
		`Estimated request is now ${result.estimated.toLocaleString("en-US")} tokens${fits ? "" : options.noticesOnly ? " and still over the limit" : " and still over the limit; edit your context now"}. ` +
		"Nothing was re-run; the full outputs are in the files named in the notes and in the session history. " +
		(options.noticesOnly
			? "Re-read only the parts you need, e.g. with sed -n or grep."
			: "Free space by editing the context mirror, then re-read only the parts you need, e.g. with sed -n or grep.")
	);
}
