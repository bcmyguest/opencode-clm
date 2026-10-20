import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { ClmSession } from "../src/clm.ts";
import { flatten } from "../src/opencode.ts";
import { fromV2, toV2, type V2Message } from "../src/opencode-v2.ts";
import { SESSION, settings } from "./fixtures.ts";
import { blockId, replaceBody } from "./helpers.ts";

/** A conversation in the shape OpenCode 2.1 hands the `context` hook (captured from a live run). */
function v2conversation(big = "x".repeat(400)): V2Message[] {
	return [
		{ id: "msg_u1", role: "user", content: [{ type: "text", text: "Inspect the repository and report." }], metadata: {} },
		{
			id: "msg_a1",
			role: "assistant",
			content: [
				{ type: "reasoning", text: "Let me look.", providerMetadata: { p: { signature: "sig" } } },
				{ type: "text", text: "Looking at files." },
				{ type: "tool-call", id: "call_1", name: "read", input: { path: "/repo/big.txt" }, providerExecuted: false },
				{ type: "tool-call", id: "call_2", name: "shell", input: { command: "ls" }, providerExecuted: false },
			],
		},
		{ role: "tool", content: [{ type: "tool-result", id: "call_1", name: "read", result: { type: "text", value: `big output\n${big}` }, providerExecuted: false }] },
		{ role: "tool", content: [{ type: "tool-result", id: "call_2", name: "shell", result: { type: "text", value: "small output" }, providerExecuted: false }] },
		{ id: "msg_a2", role: "assistant", content: [{ type: "text", text: "Found what I need." }] },
	];
}

describe("fromV2", () => {
	test("groups an assistant message with its tool messages into one message with tool parts", () => {
		const view = fromV2(v2conversation(), SESSION);
		expect(view.messages.map((message) => [message.info.id, message.info.role])).toEqual([
			["msg_u1", "user"],
			["msg_a1", "assistant"],
			["msg_a2", "assistant"],
		]);
		const tools = view.messages[1]!.parts.filter((part) => part.type === "tool");
		expect(tools.map((part) => [part.callID, part.tool, part.state.status, part.state.output])).toEqual([
			["call_1", "read", "completed", `big output\n${"x".repeat(400)}`],
			["call_2", "shell", "completed", "small output"],
		]);
		const flat = flatten(view.messages);
		expect(flat.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "assistant"]);
	});

	test("error, json, content and missing results map to OpenCode 1 tool states", () => {
		const messages: V2Message[] = [
			{ id: "msg_u1", role: "user", content: [{ type: "text", text: "go" }] },
			{
				id: "msg_a1",
				role: "assistant",
				content: [
					{ type: "tool-call", id: "c_err", name: "shell", input: {} },
					{ type: "tool-call", id: "c_json", name: "x", input: {} },
					{ type: "tool-call", id: "c_content", name: "read", input: {} },
					{ type: "tool-call", id: "c_none", name: "shell", input: {} },
				],
			},
			{ role: "tool", content: [{ type: "tool-result", id: "c_err", name: "shell", result: { type: "error", value: { error: "boom", content: [] } } }] },
			{ role: "tool", content: [{ type: "tool-result", id: "c_json", name: "x", result: { type: "json", value: { a: 1 } } }] },
			{
				role: "tool",
				content: [{
					type: "tool-result",
					id: "c_content",
					name: "read",
					result: { type: "content", value: [{ type: "text", text: "line" }, { type: "file", uri: "file:///a.png", mime: "image/png", name: "a.png" }] },
				}],
			},
		];
		const parts = fromV2(messages, SESSION).messages[1]!.parts;
		expect(parts.map((part) => [part.state.status, part.state.output ?? part.state.error])).toEqual([
			["error", "boom"],
			["completed", '{"a":1}'],
			["completed", "line"],
			["pending", undefined],
		]);
		expect(parts[2]!.state.attachments).toEqual([{ mime: "image/png", filename: "a.png" }]);
	});

	test("usage from session.step.ended becomes info.tokens", () => {
		const view = fromV2(v2conversation(), SESSION, (id) => (id === "msg_a2" ? { input: 900, cache: { read: 100, write: 0 } } : undefined));
		expect(view.messages[2]!.info.tokens).toEqual({ input: 900, cache: { read: 100, write: 0 } });
		expect(view.messages[1]!.info.tokens).toBeUndefined();
	});
});

describe("toV2", () => {
	test("untouched messages map back to the exact original objects", () => {
		const original = v2conversation();
		const view = fromV2(original, SESSION);
		const back = toV2(view, view.messages);
		expect(back).toHaveLength(original.length);
		back.forEach((message, index) => expect(message).toBe(original[index]!));
	});

	test("a rewritten tool result replaces only that result; other parts keep their objects", () => {
		const original = v2conversation();
		const view = fromV2(original, SESSION);
		const assistant = view.messages[1]!;
		const parts = assistant.parts.map((part) => part.callID === "call_1" ? { ...part, state: { ...part.state, output: "[summary]" } } : part);
		const back = toV2(view, [view.messages[0]!, { info: assistant.info, parts }, view.messages[2]!]);
		expect(back).toHaveLength(5);
		expect(back[1]!.content).toEqual(original[1]!.content);
		back[1]!.content.forEach((part, index) => expect(part).toBe(original[1]!.content[index]!));
		expect(back[1]!.providerMetadata).toBe(original[1]!.providerMetadata);
		expect(back[2]!.content[0]).toMatchObject({ type: "tool-result", id: "call_1", name: "read", result: { type: "text", value: "[summary]" } });
		expect(back[3]).toBe(original[3]!);
		expect(back[4]).toBe(original[4]!);
	});

	test("an edited assistant body becomes a text-only message; notes become user text", () => {
		const view = fromV2(v2conversation(), SESSION);
		const edited = { info: view.messages[2]!.info, parts: [{ id: "p", type: "text", text: "Short." }] };
		const note = { info: { id: "msg_clmabc", sessionID: SESSION, role: "user" as const }, parts: [{ id: "q", type: "text", text: "[CLM] note" }] };
		const back = toV2(view, [view.messages[0]!, edited, note]);
		expect(back[1]).toMatchObject({ id: "msg_a2", role: "assistant", content: [{ type: "text", text: "Short." }] });
		expect(back[2]).toEqual({ role: "user", content: [{ type: "text", text: "[CLM] note" }] });
	});

	test("system messages and messages without an id stay next to the message they followed", () => {
		const conversation = v2conversation();
		const effort: V2Message = { role: "system", content: [{ type: "effort", effort: "high" }] };
		const windowed: V2Message = { role: "user", content: [{ type: "text", text: "native window" }] };
		const messages = [windowed, ...conversation.slice(0, 1), effort, ...conversation.slice(1)];
		const view = fromV2(messages, SESSION);
		expect(view.messages).toHaveLength(3);
		expect(toV2(view, view.messages)).toEqual(messages);
		// Its anchor (msg_u1) removed: it goes before the message that followed it.
		const back = toV2(view, view.messages.slice(1));
		expect(back.indexOf(effort)).toBe(back.indexOf(conversation[1]!) - 1);
		expect(back[0]).toBe(windowed);
	});
});

describe("ClmSession over OpenCode 2 messages", () => {
	test("renders the mirror, commits the model's edit and sends it as an OpenCode 2 tool result", async () => {
		const clm = await ClmSession.open(SESSION, settings());
		const first = fromV2(v2conversation(), SESSION);
		const result1 = await clm.transform(first.messages);
		const out1 = toV2(first, result1.messages);
		expect(out1.slice(0, 5)).toEqual(v2conversation());
		const mirror = readFileSync(clm.mirrorPath, "utf8");
		expect(mirror).toContain("big output");

		writeFileSync(clm.mirrorPath, replaceBody(mirror, blockId(clm.baseline!.snapshot, "toolResult", 0), "[summary: 400 x's]"));
		expect(clm.receipt("edit", { path: clm.mirrorPath }, "/")).toStartWith("[CLM] Mirror edit valid");

		const next = [
			...v2conversation(),
			{ id: "msg_a3", role: "assistant", content: [{ type: "text", text: "Next step." }] } as V2Message,
		];
		const second = fromV2(next, SESSION);
		const result2 = await clm.transform(second.messages);
		expect(result2.notices.join("\n")).toContain("Applied revision 1");
		const out2 = toV2(second, result2.messages);
		const results = out2.filter((message) => message.role === "tool").map((message) => message.content[0]!.result.value);
		expect(results).toEqual(["[summary: 400 x's]", "small output"]);
		expect(out2.at(-1)!.role).toBe("user"); // notices travel as one user note
	});
});
