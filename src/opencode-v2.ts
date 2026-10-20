/**
 * OpenCode 2 adapter: conversion between the provider-level messages of OpenCode 2's
 * `session.hook("context")` and the `{ info, parts }` messages the core works on
 * (src/opencode.ts, as delivered by OpenCode 1's `experimental.chat.messages.transform`).
 *
 * OpenCode 2 hands the hook the request it is about to send (packages/core/src/session/
 * runner/to-llm-message.ts, 2.1.1): `user` and `assistant` messages carry the stored session
 * message id; an assistant message is followed by one `role: "tool"` message per tool result
 * (no id, paired by call id); a hosted tool's result sits inline in the assistant content.
 * `system` messages (mid-conversation instructions, reasoning-effort markers), messages
 * without an id (native compaction windows) and assistant messages with content OpenCode 1
 * has no part for (media, provider compaction) have no `{ info, parts }` form: they are
 * kept out of the core's view and put back next to the message they followed.
 *
 * Identity rule, as in `unflatten`: a message the core returns untouched (the same object
 * `fromV2` made) maps back to the exact OpenCode 2 messages it stands for, provider metadata
 * included, so an unedited context reaches the provider byte for byte. A rewritten message
 * is rebuilt from its parts, reusing every original part that did not change.
 */
import type { OcMessage, OcPart } from "./opencode.ts";

/** One content part of an OpenCode 2 message (`@opencode/ai` `ContentPart`). */
export type V2Part = { type: string; [key: string]: any };

/** One message of the OpenCode 2 `context` hook (`@opencode/ai` `Message`). */
export interface V2Message {
	id?: string;
	role: "system" | "user" | "assistant" | "tool";
	content: V2Part[];
	metadata?: Record<string, unknown>;
	[key: string]: unknown;
}

/** Provider-reported usage of one assistant message (`session.step.ended` `tokens`). */
export interface V2Tokens {
	input?: number;
	output?: number;
	reasoning?: number;
	cache?: { read?: number; write?: number };
}

/** A message with no `{ info, parts }` form, and where it stood. */
interface Opaque {
	message: V2Message;
	/** Id of the converted message it followed; undefined when it came first. */
	after?: string;
	/** Id of the converted message that followed it; undefined when it came last. */
	before?: string;
}

/** The core's view of one OpenCode 2 request, and what is needed to map it back. */
export interface V2View {
	sessionID: string;
	/** `{ info, parts }` messages, in request order. */
	messages: OcMessage[];
	/** The OpenCode 2 messages each converted message stands for (assistant: plus its tool messages). */
	origin: Map<OcMessage, V2Message[]>;
	/** The same, by message id, for messages the core rewrote. */
	byId: Map<string, V2Message[]>;
	/** Original OpenCode 2 part of each converted part. */
	parts: Map<OcPart, V2Part>;
	opaque: Opaque[];
}

/** The text of a tool result value (`@opencode/ai` `ToolResultValue`). */
function resultText(result: { type?: string; value?: unknown } | undefined): string {
	if (!result) return "";
	const value = result.value;
	if (result.type === "content" && Array.isArray(value)) {
		return value.filter((item) => item?.type === "text").map((item) => String(item.text ?? "")).join("\n");
	}
	if (result.type === "error") {
		const error = (value as { error?: unknown } | undefined)?.error ?? value;
		const message = typeof error === "string" ? error : (error as { message?: unknown } | undefined)?.message;
		const content = (value as { content?: unknown } | undefined)?.content;
		const detail = Array.isArray(content) ? content.filter((item) => item?.type === "text").map((item) => String(item.text ?? "")).join("\n") : "";
		const head = typeof message === "string" ? message : stringify(error);
		return detail ? `${head}\n${detail}` : head;
	}
	return typeof value === "string" ? value : stringify(value);
}

function stringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/** Tool-result file items as OpenCode 1 attachments (`fileBlock` reads `mime` and `filename`). */
function attachments(result: { type?: string; value?: unknown } | undefined): Array<{ mime: string; filename?: string }> {
	if (result?.type !== "content" || !Array.isArray(result.value)) return [];
	return result.value
		.filter((item) => item?.type === "file" && typeof item.mime === "string")
		.map((item) => ({ mime: String(item.mime), ...(typeof item.name === "string" ? { filename: item.name } : {}) }));
}

/** The OpenCode 1 tool state that `toolPartOutput` reads, from a call and its result. */
function toolState(call: V2Part, result: V2Part | undefined): Record<string, unknown> {
	const input = call.input && typeof call.input === "object" ? call.input : {};
	if (!result) return { status: "pending", input };
	const value = result.result as { type?: string; value?: unknown } | undefined;
	if (value?.type === "error") return { status: "error", input, error: resultText(value), time: { start: 0, end: 0 } };
	const files = attachments(value);
	return {
		status: "completed",
		input,
		output: resultText(value),
		title: "",
		metadata: {},
		time: { start: 0, end: 0 },
		...(files.length > 0 ? { attachments: files } : {}),
	};
}

/** Opening line of the user message OpenCode 2 sends in place of a summarized history. */
export const CHECKPOINT_OPEN = "<conversation-checkpoint>";

/** Part types of an assistant message that have an OpenCode 1 counterpart. */
const ASSISTANT_PARTS = new Set(["text", "reasoning", "tool-call", "tool-result"]);

function convertible(message: V2Message): boolean {
	if (typeof message.id !== "string" || message.id === "") return false;
	if (message.role === "user") return message.content.every((part) => part.type === "text" || part.type === "media");
	if (message.role === "assistant") return message.content.every((part) => ASSISTANT_PARTS.has(part.type));
	return false;
}

/**
 * OpenCode 2 request messages → `{ info, parts }` messages. `usage` supplies the provider
 * count of an assistant message (from `session.step.ended`), which the core's budget
 * calibration reads as `info.tokens`.
 */
export function fromV2(messages: readonly V2Message[], sessionID: string, usage?: (messageID: string) => V2Tokens | undefined): V2View {
	const view: V2View = { sessionID, messages: [], origin: new Map(), byId: new Map(), parts: new Map(), opaque: [] };
	const pending: Opaque[] = [];
	let last: string | undefined;
	const add = (oc: OcMessage, group: V2Message[]) => {
		for (const item of pending.splice(0)) item.before = oc.info.id;
		view.messages.push(oc);
		view.origin.set(oc, group);
		view.byId.set(oc.info.id, group);
		last = oc.info.id;
	};
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (!convertible(message)) {
			const item: Opaque = { message, ...(last !== undefined ? { after: last } : {}) };
			view.opaque.push(item);
			pending.push(item);
			continue;
		}
		const id = message.id!;
		const info: OcMessage["info"] = { id, sessionID, role: message.role as "user" | "assistant", time: { created: 0 } };
		if (message.role === "user") {
			// OpenCode 2 sends a summary compaction as one user message (to-llm-message.ts
			// `compaction`); marked like OpenCode 1's summary, so the core rebases onto it.
			if (String(message.content[0]?.text ?? "").startsWith(CHECKPOINT_OPEN)) info.summary = true;
			const parts = message.content.map((part, at): OcPart => {
				const converted: OcPart = part.type === "text"
					? { id: `${id}:${at}`, type: "text", text: String(part.text ?? "") }
					: { id: `${id}:${at}`, type: "file", mime: String(part.media?.mime ?? part.media?.mimeType ?? "application/octet-stream"), filename: part.filename };
				view.parts.set(converted, part);
				return converted;
			});
			add({ info, parts }, [message]);
			continue;
		}
		// An assistant message and the tool messages that follow it.
		const group = [message];
		while (index + 1 < messages.length && messages[index + 1]!.role === "tool" && messages[index + 1]!.id === undefined) {
			group.push(messages[++index]!);
		}
		const results = new Map<string, V2Part>();
		for (const item of group) {
			for (const part of item.content) if (part.type === "tool-result") results.set(String(part.id), part);
		}
		const parts: OcPart[] = [];
		message.content.forEach((part, at) => {
			let converted: OcPart | undefined;
			if (part.type === "text") converted = { id: `${id}:${at}`, type: "text", text: String(part.text ?? "") };
			else if (part.type === "reasoning") converted = { id: `${id}:${at}`, type: "reasoning", text: String(part.text ?? "") };
			else if (part.type === "tool-call") {
				converted = { id: `${id}:${at}`, type: "tool", callID: String(part.id), tool: String(part.name), state: toolState(part, results.get(String(part.id))) };
			}
			if (!converted) return;
			view.parts.set(converted, part);
			parts.push(converted);
		});
		const tokens = usage?.(id);
		add({ info: { ...info, ...(tokens ? { tokens } : {}) }, parts }, group);
	}
	return view;
}

/** A core note or notice (no OpenCode 2 source): plain user text. */
function noteToV2(message: OcMessage): V2Message {
	const text = message.parts.filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join("\n");
	return { role: "user", content: [{ type: "text", text }] };
}

/** A user message the core rewrote: its text parts, original parts reused where unchanged. */
function userToV2(message: OcMessage, original: V2Message, view: V2View): V2Message {
	const content = message.parts.flatMap((part): V2Part[] => {
		const source = view.parts.get(part);
		if (source) return [source];
		return part.type === "text" ? [{ type: "text", text: String(part.text ?? "") }] : [];
	});
	return { ...original, content };
}

/**
 * An assistant message the core rewrote (an edited body, or tool results edited, withheld or
 * capped): untouched parts keep their original form, a changed result becomes a text result
 * in the original place (inline for a hosted tool, else its own `tool` message).
 */
function assistantToV2(message: OcMessage, group: V2Message[], view: V2View): V2Message[] {
	const [original, ...tools] = group as [V2Message, ...V2Message[]];
	const calls = new Map<string, V2Part>();
	for (const part of original.content) if (part.type === "tool-call") calls.set(String(part.id), part);
	const inline = new Map<string, V2Part>();
	for (const part of original.content) if (part.type === "tool-result") inline.set(String(part.id), part);
	const separate = new Map<string, V2Message>();
	for (const tool of tools) {
		const result = tool.content.find((part) => part.type === "tool-result");
		if (result) separate.set(String(result.id), tool);
	}
	const content: V2Part[] = [];
	const results: V2Message[] = [];
	for (const part of message.parts) {
		if (part.type !== "tool") {
			const source = view.parts.get(part);
			if (source) content.push(source);
			else if (part.type === "text") content.push({ type: "text", text: String(part.text ?? "") });
			else if (part.type === "reasoning") content.push({ type: "reasoning", text: String(part.text ?? "") });
			continue;
		}
		const callID = String(part.callID);
		const call = calls.get(callID);
		if (!call) continue;
		content.push(call);
		const untouched = view.parts.has(part);
		const hosted = inline.get(callID);
		if (hosted) {
			content.push(untouched ? hosted : { ...hosted, result: { type: "text", value: String(part.state?.output ?? "") }, providerMetadata: undefined });
			continue;
		}
		const tool = separate.get(callID);
		if (untouched) {
			if (tool) results.push(tool);
			continue;
		}
		const source = tool?.content.find((item) => item.type === "tool-result");
		results.push({
			role: "tool",
			content: [{
				type: "tool-result",
				id: callID,
				name: String(part.tool),
				result: { type: "text", value: String(part.state?.output ?? "") },
				...(source?.providerExecuted !== undefined ? { providerExecuted: source.providerExecuted } : {}),
			}],
		});
	}
	// An edited body drops the replay data of the text it replaced.
	const edited = content.some((item) => !original.content.includes(item));
	const rebuilt: V2Message = { ...original, content };
	if (edited) delete rebuilt.providerMetadata;
	return content.length > 0 ? [rebuilt, ...results] : results;
}

/**
 * `{ info, parts }` messages the core returned → OpenCode 2 request messages, with the
 * messages that had no `{ info, parts }` form put back after the message they followed (or,
 * when that one is gone, before the message that followed them).
 */
export function toV2(view: V2View, result: readonly OcMessage[]): V2Message[] {
	const present = new Set(result.map((message) => message.info.id));
	const placed = new Set<Opaque>();
	const out: V2Message[] = [];
	const emit = (item: Opaque) => {
		if (placed.has(item)) return;
		placed.add(item);
		out.push(item.message);
	};
	for (const item of view.opaque) if (item.after === undefined) emit(item);
	for (const message of result) {
		const id = message.info.id;
		for (const item of view.opaque) {
			if (item.before === id && (item.after === undefined || !present.has(item.after))) emit(item);
		}
		const group = view.origin.get(message);
		if (group) out.push(...group);
		else {
			const original = view.byId.get(id);
			if (!original) out.push(noteToV2(message));
			else if (original[0]!.role === "user") out.push(userToV2(message, original[0]!, view));
			else out.push(...assistantToV2(message, original, view));
		}
		for (const item of view.opaque) if (item.after === id) emit(item);
	}
	for (const item of view.opaque) emit(item);
	return out;
}
