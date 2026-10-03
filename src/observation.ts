/**
 * Observation cap: bound the size of each tool result in the *effective* context.
 *
 * Adapted from pi-clm src/observation.ts (MIT, Copyright 2026 Emanuel Casco).
 *
 * One assistant turn can fan out into many parallel tool calls whose results land in the
 * context together, before any request-boundary reminder can be acted on. Capping each
 * result in the effective context (not in OpenCode's stored parts) keeps such a turn from
 * jumping straight past the budget. The full output stays in the session; the marker tells
 * the model how much was cut and that it can re-read with offset/limit when it needs more.
 *
 * Input is the flattened form (opencode.ts `flatten`): one `toolResult` message per tool
 * part, `content: [{ type: "text", text }]`. Capped messages carry `capped: true` so the
 * unflatten step writes the capped text back into the tool part.
 *
 * Capped messages are cached per source object so repeated transform calls produce the
 * same object, which keeps identity-based comparisons and rendering stable.
 */

import type { LiveContextMessage } from "./types.ts";

export interface ObservationCapPolicy {
	/** Maximum characters of text kept per tool result. `undefined` disables the cap. */
	maxCharacters?: number;
	/** Fraction of the kept text taken from the start; the rest comes from the end. */
	headFraction: number;
}

export const DEFAULT_OBSERVATION_CAP: ObservationCapPolicy = { headFraction: 0.8 };

/** Smallest cap accepted: below this the marker alone would crowd out the output. */
export const MIN_OBSERVATION_CAP = 200;

/**
 * Parse a `CLM_OBSERVATION_CAP` value: `10000` or `10000:0.5` (characters[:head fraction]);
 * the CLM paper used 5k head + 5k tail, i.e. `10000:0.5`. Empty, `off` and `0` disable the
 * cap (returns `{}`). `name` labels errors.
 */
export function parseObservationCap(raw: string | undefined, name = "CLM_OBSERVATION_CAP"): Partial<ObservationCapPolicy> {
	const value = raw?.trim();
	if (!value || value === "off" || value === "0") return {};
	const [charsPart, headPart, ...rest] = value.split(":");
	const chars = Number(charsPart);
	if (rest.length > 0 || !Number.isFinite(chars) || chars <= 0) {
		throw new Error(`${name} must be a positive number of characters[:head fraction] or "off", got ${value}`);
	}
	const overrides: Partial<ObservationCapPolicy> = { maxCharacters: Math.floor(chars) };
	if (headPart !== undefined && headPart !== "") {
		const head = Number(headPart);
		if (!(head > 0 && head <= 1)) throw new Error(`${name} head fraction must be in (0, 1], got ${headPart}`);
		overrides.headFraction = head;
	}
	return overrides;
}

export function resolveObservationCap(overrides: Partial<ObservationCapPolicy> | undefined): ObservationCapPolicy {
	const merged = { ...DEFAULT_OBSERVATION_CAP, ...(overrides ?? {}) };
	if (merged.maxCharacters !== undefined && (!Number.isFinite(merged.maxCharacters) || merged.maxCharacters < MIN_OBSERVATION_CAP)) {
		throw new Error(`observation cap must be at least ${MIN_OBSERVATION_CAP} characters, got ${String(merged.maxCharacters)}`);
	}
	if (!(merged.headFraction > 0 && merged.headFraction <= 1)) {
		throw new Error(`headFraction must be in (0, 1], got ${String(merged.headFraction)}`);
	}
	return merged;
}

interface TextPart {
	type: "text";
	text: string;
}

function isTextPart(part: unknown): part is TextPart {
	return Boolean(part) && typeof part === "object" && (part as TextPart).type === "text" && typeof (part as TextPart).text === "string";
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

export function truncationMarker(shown: number, total: number): string {
	return (
		`\n\n[clm observation cap: ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} characters shown. ` +
		"The complete output remains in the session history; re-read the source with offset/limit if you need the rest.]"
	);
}

/** Capped message -> the uncapped source it was cut from. */
const uncapped = new WeakMap<LiveContextMessage, LiveContextMessage>();

/** The uncapped source of a capped tool result, or the message itself. */
export function uncappedSource(message: LiveContextMessage): LiveContextMessage {
	return uncapped.get(message) ?? message;
}

/** Cap one tool result. Returns the same object when nothing changes. */
export function capToolResult(message: LiveContextMessage, policy: ObservationCapPolicy): LiveContextMessage {
	if (policy.maxCharacters === undefined || message.role !== "toolResult") return message;
	// Idempotent: never cap an already-capped result (also after a JSON round trip).
	if (message.capped === true || uncapped.has(message)) return message;
	const content = message.content;
	const parts: unknown[] = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
	const text = parts.filter(isTextPart).map((part) => part.text).join("");
	const total = text.length;
	if (total <= policy.maxCharacters) return message;

	const headBudget = Math.floor(policy.maxCharacters * policy.headFraction);
	const tailBudget = policy.maxCharacters - headBudget;
	// Cut once across the concatenated text, then rebuild a single text part followed by
	// any non-text parts (for example images), in their original order.
	// Never split a UTF-16 surrogate pair at either cut.
	let headEnd = headBudget;
	if (headEnd > 0 && isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd -= 1;
	let tailStart = total - tailBudget;
	if (tailBudget > 0 && tailStart < total && isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1;
	const head = text.slice(0, headEnd);
	const tail = tailBudget > 0 ? text.slice(tailStart) : "";
	const shown = head.length + tail.length;
	const cut = tailBudget > 0 ? `${head}\n…[${(total - shown).toLocaleString("en-US")} characters omitted]…\n${tail}` : head;
	const capped: LiveContextMessage = {
		...message,
		content: [{ type: "text", text: `${cut}${truncationMarker(shown, total)}` }, ...parts.filter((part) => !isTextPart(part))],
		capped: true,
	};
	uncapped.set(capped, message);
	return capped;
}

const cappedCache = new WeakMap<LiveContextMessage, Map<string, LiveContextMessage>>();

/** Cap every tool result in `messages`; returns the same array when nothing changes. */
export function capObservations(messages: LiveContextMessage[], policy: ObservationCapPolicy): LiveContextMessage[] {
	if (policy.maxCharacters === undefined) return messages;
	const key = `${policy.maxCharacters}:${policy.headFraction}`;
	let changed = false;
	const output = messages.map((message) => {
		if (message.role !== "toolResult") return message;
		let perPolicy = cappedCache.get(message);
		if (!perPolicy) {
			perPolicy = new Map();
			cappedCache.set(message, perPolicy);
		}
		let capped = perPolicy.get(key);
		if (!capped) {
			capped = capToolResult(message, policy);
			perPolicy.set(key, capped);
		}
		if (capped !== message) changed = true;
		return capped;
	});
	return changed ? output : messages;
}
