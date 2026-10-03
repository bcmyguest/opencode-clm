// Ported from pi-clm src/__tests__/context-document.test.ts, stable-document.test.ts and
// clm-policy.test.ts (MIT, Copyright 2026 Emanuel Casco), plus cases from the earlier
// OpenCode port, rewritten on flat messages.
import { describe, expect, test } from "bun:test";

import {
	applyContextDocument,
	escapeStructuralLines,
	hasOrphanToolMessages,
	NOTE_TYPE,
	renderContextDocument,
	renderMessage,
	unescapeStructuralLines,
} from "../src/context-document.ts";
import type { LiveContextMessage } from "../src/types.ts";
import { blockId, deleteBlock, header, replaceBody } from "./helpers.ts";

function toolCall(id: string, command: string) {
	return { type: "toolCall", id, name: "bash", arguments: { command } };
}

/** pi-clm's fixture: task, one tool step, an answer, a follow-up instruction. */
function conversation(): LiveContextMessage[] {
	return [
		{ role: "user", content: "Fix the parser without changing its public API.", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: "I will inspect the parser." }, toolCall("call-1", "rg parser src")],
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "src/parser.ts\n".repeat(30) }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "The parser bug is in splitTokens." }],
			stopReason: "stop",
			timestamp: 4,
		},
		{ role: "user", content: "Also add a regression test.", timestamp: 5 },
	];
}

/**
 * The editable messages OpenCode yields after the pinned task: one assistant step with two
 * tool calls (each result its own message, as the OpenCode adapter flattens them), then a
 * final answer.
 */
function openCodeStep(bigOutput = "x".repeat(400)): LiveContextMessage[] {
	return [
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Looking at files." },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "cmd call_1" } },
				{ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "cmd call_2" } },
			],
			ocMessageID: "msg_a1",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "bash",
			content: [{ type: "text", text: `big output\n${bigOutput}` }],
			isError: false,
			ocMessageID: "msg_a1",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call_2",
			toolName: "bash",
			content: [{ type: "text", text: "small output" }],
			isError: false,
			ocMessageID: "msg_a1",
			timestamp: 2,
		},
		{ role: "assistant", content: [{ type: "text", text: "Found what I need." }], ocMessageID: "msg_a2", timestamp: 2 },
	];
}

const clm = { editingMode: "clm" as const };
const characters = (messages: LiveContextMessage[]) => JSON.stringify(messages.map((m) => m.content)).length;

function stable(messages = openCodeStep()) {
	return renderContextDocument(messages, { revision: 0, protectedIndexes: new Set(), documentSeed: "seed" });
}

describe("render and identity", () => {
	test("rendering and applying an untouched document is identity", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages, { revision: 3 });
		const result = applyContextDocument(snapshot.text, snapshot);
		expect(result.accepted).toBe(true);
		expect(result.changed).toBe(false);
		expect(result.messages).toEqual(messages);
		result.messages.forEach((message, index) => expect(message).toBe(messages[index]!));
	});

	test("the same input produces a deterministic document", () => {
		const messages = conversation();
		expect(renderContextDocument(messages, { revision: 7 })).toEqual(renderContextDocument(messages, { revision: 7 }));
	});

	test("each flattened tool result is its own block under the metadata line", () => {
		const snapshot = stable();
		expect(snapshot.blocks.map((block) => block.role)).toEqual(["assistant", "toolResult", "toolResult", "assistant"]);
		expect(snapshot.text.split("\n")[0]).toMatch(
			/^\[\[LIVE_CONTEXT version=1 revision=0 document=[a-f0-9]{64} baseline=[a-f0-9]{64}\]\]$/,
		);
		expect(snapshot.text).toContain("small output");
		expect(snapshot.text).toContain("[tool call: bash]");
	});

	test("untouched images, thinking, and provider metadata survive verbatim", () => {
		const messages: LiveContextMessage[] = [
			{ role: "user", content: "Describe this image", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private chain", signature: "signed" },
					{ type: "text", text: "A diagram." },
				],
				usage: { cacheRead: 12, cost: { total: 0 } },
				stopReason: "stop",
				timestamp: 2,
			},
			{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "base64-data" }], timestamp: 3 },
		];
		const snapshot = renderContextDocument(messages);
		expect(snapshot.text).toContain("[image: image/png; data omitted]");
		const result = applyContextDocument(snapshot.text, snapshot);
		expect(result.messages[1]).toBe(messages[1]!);
		expect(result.messages[2]).toBe(messages[2]!);
	});
});

describe("block edits", () => {
	test("editing one assistant changes only that block", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages);
		const edited = replaceBody(snapshot.text, snapshot.blocks[3]!.id, "Parser located; splitTokens needs an escaped-delimiter fix.");
		const result = applyContextDocument(edited, snapshot, { gate: "none" });
		expect(result.accepted).toBe(true);
		expect(result.changed).toBe(true);
		expect(result.messages).toHaveLength(messages.length);
		for (const index of [0, 1, 2, 4]) expect(result.messages[index]).toBe(messages[index]!);
		expect(result.messages[3]).not.toBe(messages[3]!);
		expect(JSON.stringify(result.messages[3]!.content)).toContain("escaped-delimiter");
		expect(result.messages[3]!.edited).toBe(true);
		expect(result.editTrace?.sourceRevision).toBe(0);
		expect(result.editTrace?.sources[3]).toEqual({ sourceIndex: 3, outputIndex: 3, kind: "edited" });
	});

	test("emptying an editable block removes it", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages);
		const result = applyContextDocument(replaceBody(snapshot.text, snapshot.blocks[3]!.id, ""), snapshot, { gate: "none" });
		expect(result.accepted).toBe(true);
		expect(result.messages).toHaveLength(messages.length - 1);
		expect(result.editTrace?.sources[3]).toEqual({ sourceIndex: 3, kind: "removed" });
	});

	test("an edited tool result stays a tool result paired with its call", () => {
		const messages = openCodeStep();
		const snapshot = stable(messages);
		const edited = replaceBody(snapshot.text, blockId(snapshot, "toolResult", 0), "[summary: big output was 400 x's]");
		const result = applyContextDocument(edited, snapshot, { ...clm, gate: "shrink", estimate: characters });
		expect(result.accepted).toBe(true);
		expect(result.changed).toBe(true);
		expect(hasOrphanToolMessages(result.messages)).toBe(false);
		expect(result.messages[0]).toBe(messages[0]!);
		expect(result.messages[2]).toBe(messages[2]!);
		expect(result.messages[3]).toBe(messages[3]!);
		const changed = result.messages[1]!;
		expect(changed.role).toBe("toolResult");
		expect(changed.toolCallId).toBe("call_1");
		expect(changed.ocMessageID).toBe("msg_a1");
		expect(changed.content).toEqual([{ type: "text", text: "[summary: big output was 400 x's]" }]);
		// The source message is not mutated.
		expect(JSON.stringify(messages[1]!.content)).toContain("big output");
	});

	test("a new- block becomes a plugin note at its written position", () => {
		const snapshot = stable();
		const noteHeader = snapshot.blocks[0]!.header.replace(/role=\S+/, "role=notes").replace(/id=\S+/, "id=new-tracker");
		const sections = snapshot.text.split("\n\n");
		sections.splice(2, 0, `${noteHeader}\nTRACKER: next step is X`); // after metadata and hint
		const result = applyContextDocument(sections.join("\n\n"), snapshot, { ...clm, limit: 100_000 });
		expect(result.accepted).toBe(true);
		const note = result.messages[0]!;
		expect(note.role).toBe("custom");
		expect(note.customType).toBe(NOTE_TYPE);
		expect(note.content).toBe("[context role=notes]\nTRACKER: next step is X");
		expect(note.details).toEqual({ contextRole: "notes" });
		expect(result.editTrace?.additions).toEqual([{ outputIndex: 0, kind: "added" }]);
	});

	test("text above the first block becomes a leading context note", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages, { revision: 1 });
		const metadataEnd = snapshot.text.indexOf("\n\n");
		const shrunk = replaceBody(snapshot.text, snapshot.blocks[2]!.id, "[summary: parser files listed]");
		const edited = `${shrunk.slice(0, metadataEnd)}\n\nLead note about the whole transcript.${shrunk.slice(metadataEnd)}`;
		const result = applyContextDocument(edited, snapshot);
		expect(result.accepted).toBe(true);
		expect(result.messages[0]!.customType).toBe(NOTE_TYPE);
		expect(String(result.messages[0]!.content)).toContain("Lead note");
		expect(result.messages[1]).toBe(messages[0]!);
	});

	test("protected blocks survive deleted headers and are restored", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages, { protectedIndexes: new Set([0, 4]) });
		const edited = deleteBlock(deleteBlock(snapshot.text, snapshot.blocks[0]!.id), snapshot.blocks[4]!.id);
		const result = applyContextDocument(edited, snapshot, { gate: "none" });
		expect(result.accepted).toBe(true);
		expect(result.messages[0]).toBe(messages[0]!);
		expect(result.messages.at(-1)).toBe(messages.at(-1)!);
		expect(result.diagnostics).toHaveLength(2);
		expect(result.editTrace?.sources[0]?.kind).toBe("restored");
		expect(result.editTrace?.sources.at(-1)?.kind).toBe("restored");
	});

	test("without protected indexes every block is editable", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages);
		expect(snapshot.blocks.every((block) => !block.protected)).toBe(true);
		const result = applyContextDocument(deleteBlock(snapshot.text, snapshot.blocks[0]!.id), snapshot);
		expect(result.accepted).toBe(true);
		expect(result.messages).not.toContain(messages[0]!);
	});
});

describe("CLM editing mode", () => {
	const raw: LiveContextMessage[] = [
		{ role: "user", content: "original task", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: 2 },
		{ role: "user", content: "latest batch", timestamp: 3 },
	];
	const base = () => renderContextDocument(raw, { protectedIndexes: new Set() });
	const envelope = (text: string) => text.slice(0, text.indexOf("[[CTX_TURN"));

	test("ungated CLM accepts growth and same-size edits, user turns included", () => {
		for (const replacement of ["ORIGINAL TASK", "a much longer replacement task and scratchpad"]) {
			const snapshot = base();
			const edited = snapshot.text.replace("original task", replacement).replace("latest batch", "updated batch");
			expect(applyContextDocument(edited, snapshot, { ...clm, gate: "none" }).accepted).toBe(true);
		}
	});

	test("CLM defaults to the fit gate, which needs a limit to refuse growth", () => {
		const snapshot = base();
		const grown = snapshot.text.replace("old answer", "long answer ".repeat(30));
		expect(applyContextDocument(grown, snapshot, { ...clm, limit: 50 }).accepted).toBe(false);
		expect(applyContextDocument(grown, snapshot, { ...clm, limit: 100_000 }).accepted).toBe(true);
		expect(applyContextDocument(grown, snapshot, clm).accepted).toBe(true);
		expect(applyContextDocument(grown, snapshot, { ...clm, limit: Number.NaN }).accepted).toBe(true);
	});

	test("follows document order and records removed originals", () => {
		const snapshot = base();
		const reordered = envelope(snapshot.text) + [snapshot.blocks[2]!, snapshot.blocks[0]!].map((b) => `${b.header}\n${b.body}`).join("\n\n");
		const result = applyContextDocument(reordered, snapshot, clm);
		expect(result.accepted).toBe(true);
		expect(result.messages).toEqual([raw[2]!, raw[0]!]);
		expect(result.editTrace?.sources.some((s) => s.sourceIndex === 1 && s.kind === "removed")).toBe(true);
	});

	test("new role labels stay plugin notes and survive a re-render", () => {
		for (const role of ["notes", "scoreboard", "system", "assistant"]) {
			const snapshot = base();
			const inserted = `${snapshot.text}\n\n[[CTX_TURN document=${snapshot.documentId} index=4 role=${role} id=new-tracker protected=false]]\nscore=7`;
			const result = applyContextDocument(inserted, snapshot, { ...clm, gate: "none" });
			expect(result.accepted).toBe(true);
			expect(result.messages.at(-1)?.role).toBe("custom");
			expect(result.messages.at(-1)?.customType).toBe(NOTE_TYPE);
			const rendered = renderContextDocument(result.messages, { protectedIndexes: new Set() });
			expect(rendered.blocks.at(-1)?.role).toBe(role);
			expect(rendered.blocks.at(-1)?.body).toBe("score=7");
			const again = applyContextDocument(rendered.text.replace("score=7", "score=8"), rendered, clm);
			expect(renderMessage(again.messages.at(-1)!)).toBe("score=8");
		}
	});

	test("typos in existing IDs, duplicate new IDs, and stale headers still reject", () => {
		const snapshot = base();
		expect(applyContextDocument(snapshot.text.replace(snapshot.blocks[0]!.id, "typo-id"), snapshot, clm).accepted).toBe(false);
		const note = `[[CTX_TURN document=${snapshot.documentId} index=4 role=notes id=new-x protected=false]]\nx`;
		expect(applyContextDocument(`${snapshot.text}\n\n${note}\n\n${note}`, snapshot, clm).accepted).toBe(false);
		expect(applyContextDocument(snapshot.text.replace("revision=0", "revision=1"), snapshot, clm).accepted).toBe(false);
	});

	test("conservative mode rejects growth and restores protected user messages", () => {
		const snapshot = renderContextDocument(raw, { protectedIndexes: new Set([0, 2]) });
		expect(applyContextDocument(snapshot.text.replace("old answer", "long answer".repeat(30)), snapshot).accepted).toBe(false);
		expect(applyContextDocument(snapshot.text.replace("original task", "X"), snapshot).messages[0]).toBe(raw[0]!);
	});
});

describe("rejections", () => {
	test("a net-growing edit is rejected under the default conservative gate", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages);
		const result = applyContextDocument(replaceBody(snapshot.text, snapshot.blocks[3]!.id, "x".repeat(20_000)), snapshot);
		expect(result.accepted).toBe(false);
		expect(result.reason).toContain("Edit refused");
		expect(result.messages).toEqual(messages);
	});

	test("unknown and duplicate block IDs are rejected", () => {
		const snapshot = renderContextDocument(conversation());
		const unknown = snapshot.text.replace(`id=${snapshot.blocks[2]!.id}`, "id=unknown-id");
		expect(applyContextDocument(unknown, snapshot).reason).toContain("unknown block IDs");
		const duplicate = `${snapshot.text}\n\n${header(snapshot, snapshot.blocks[1]!.id)}\nagain`;
		expect(applyContextDocument(duplicate, snapshot).reason).toContain("duplicate");
	});

	test("damaged revision metadata is rejected", () => {
		const snapshot = renderContextDocument(conversation(), { revision: 4 });
		const result = applyContextDocument(snapshot.text.replace("revision=4", "revision=3"), snapshot);
		expect(result.accepted).toBe(false);
		expect(result.reason).toContain("metadata");
	});

	test("a malformed header carrying the current document nonce is rejected", () => {
		const snapshot = renderContextDocument(conversation());
		const malformed = snapshot.text.replace(" role=assistant ", " role=assistant missing=true ");
		const result = applyContextDocument(malformed, snapshot, { gate: "none" });
		expect(result.accepted).toBe(false);
		expect(result.reason).toContain("malformed headers");
	});
});

describe("injected estimate gate", () => {
	// One unit per message: deleting a block saves one unit, editing a body in place none.
	const countMessages = (messages: LiveContextMessage[]) => messages.length;

	test("acceptance and savings use the injected estimator", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages);
		const result = applyContextDocument(deleteBlock(snapshot.text, snapshot.blocks[3]!.id), snapshot, {
			estimate: countMessages,
			estimateUnit: "tokens",
		});
		expect(result.accepted).toBe(true);
		expect(result.beforeEstimate).toBe(messages.length);
		expect(result.afterEstimate).toBe(messages.length - 1);
		expect(result.savingsEstimate).toBe(1);
	});

	test("an estimate-flat edit passes the shrink gate; growth names the injected unit", () => {
		const snapshot = renderContextDocument(conversation());
		const flat = applyContextDocument(replaceBody(snapshot.text, snapshot.blocks[3]!.id, "shorter body"), snapshot, {
			estimate: countMessages,
		});
		expect(flat.accepted).toBe(true);
		expect(flat.savingsEstimate).toBe(0);
		const note = `[[CTX_TURN document=${snapshot.documentId} index=6 role=notes id=new-x protected=false]]\nx`;
		const grown = applyContextDocument(`${snapshot.text}\n\n${note}`, snapshot, {
			...clm,
			gate: "shrink",
			estimate: countMessages,
			estimateUnit: "tokens",
		});
		expect(grown.accepted).toBe(false);
		expect(grown.reason).toContain("Size 5 -> 6 tokens");
	});

	test("the default estimate measures rendered characters", () => {
		const snapshot = renderContextDocument(conversation());
		const result = applyContextDocument(replaceBody(snapshot.text, snapshot.blocks[2]!.id, "[summary: parser files listed]"), snapshot);
		expect(result.accepted).toBe(true);
		expect(result.savingsEstimate).toBeGreaterThan(100);
	});

	test("the fit gate applies inside applyContextDocument", () => {
		const snapshot = stable();
		const grown = replaceBody(snapshot.text, blockId(snapshot, "assistant", 1), "y".repeat(5000));
		const limited = applyContextDocument(grown, snapshot, { ...clm, gate: "fit", limit: 10, estimate: characters });
		expect(limited.accepted).toBe(false);
		expect(limited.reason).toContain("Edit refused");
		expect(limited.reason).toContain("limit 10 characters");
		const roomy = applyContextDocument(grown, snapshot, { ...clm, gate: "fit", limit: 1e6, estimate: characters });
		expect(roomy.accepted).toBe(true);
	});
});

describe("tool-call structure repair", () => {
	test("deleting an assistant tool call flattens its orphaned result", () => {
		const snapshot = renderContextDocument(conversation());
		const result = applyContextDocument(deleteBlock(snapshot.text, snapshot.blocks[1]!.id), snapshot, { gate: "none" });
		expect(result.accepted).toBe(true);
		expect(hasOrphanToolMessages(result.messages)).toBe(false);
		expect(result.messages.some((message) => message.role === "toolResult")).toBe(false);
	});

	test("deleting a tool result flattens the assistant call", () => {
		const snapshot = renderContextDocument(conversation());
		const result = applyContextDocument(deleteBlock(snapshot.text, snapshot.blocks[2]!.id), snapshot, { gate: "none" });
		expect(result.accepted).toBe(true);
		expect(hasOrphanToolMessages(result.messages)).toBe(false);
		const hasCall = result.messages.some(
			(message) =>
				message.role === "assistant" &&
				Array.isArray(message.content) &&
				message.content.some((part) => (part as { type?: string }).type === "toolCall"),
		);
		expect(hasCall).toBe(false);
	});

	test("parallel tool-call groups stay structured when complete and flatten when incomplete", () => {
		const messages: LiveContextMessage[] = [
			{ role: "user", content: "Inspect both files.", timestamp: 1 },
			{ role: "assistant", content: [toolCall("a", "cat a"), toolCall("b", "cat b")], stopReason: "toolUse", timestamp: 2 },
			{ role: "toolResult", toolCallId: "a", toolName: "bash", content: [{ type: "text", text: "A" }], isError: false, timestamp: 3 },
			{ role: "toolResult", toolCallId: "b", toolName: "bash", content: [{ type: "text", text: "B" }], isError: false, timestamp: 4 },
		];
		const snapshot = renderContextDocument(messages);
		const identity = applyContextDocument(snapshot.text, snapshot);
		expect(hasOrphanToolMessages(identity.messages)).toBe(false);
		expect(identity.messages[1]).toBe(messages[1]!);

		const incomplete = applyContextDocument(deleteBlock(snapshot.text, snapshot.blocks[3]!.id), snapshot, { gate: "none" });
		expect(incomplete.accepted).toBe(true);
		expect(hasOrphanToolMessages(incomplete.messages)).toBe(false);
		expect(incomplete.messages.some((message) => message.role === "toolResult")).toBe(false);
		expect(incomplete.editTrace?.sources[1]?.kind).toBe("normalized");
	});

	test("a CLM reorder that moves a tool result away from its call flattens the group", () => {
		const snapshot = stable();
		const [call, first, second, answer] = snapshot.blocks;
		const order = [call!, second!, answer!, first!];
		const text = snapshot.text.slice(0, snapshot.text.indexOf("[[CTX_TURN")) + order.map((b) => `${b.header}\n${b.body}`).join("\n\n");
		const result = applyContextDocument(text, snapshot, clm);
		expect(result.accepted).toBe(true);
		expect(hasOrphanToolMessages(result.messages)).toBe(false);
		expect(result.messages.map((message) => message.role)).toEqual(["custom", "custom", "assistant", "custom"]);
		expect(String(result.messages[3]!.content)).toContain("big output");
	});

	test("a tool result relabelled to another role becomes a note and flattens its call", () => {
		const snapshot = stable();
		const id = blockId(snapshot, "toolResult", 1);
		const relabelled = snapshot.text.replace(header(snapshot, id), header(snapshot, id).replace("role=toolResult", "role=notes"));
		const result = applyContextDocument(relabelled, snapshot, clm);
		expect(result.accepted).toBe(true);
		expect(hasOrphanToolMessages(result.messages)).toBe(false);
		expect(result.messages[2]!.customType).toBe(NOTE_TYPE);
		expect(result.messages[2]!.details).toEqual({ contextRole: "notes" });
		expect(result.messages.some((message) => message.role === "toolResult")).toBe(false);
		expect(result.messages[0]!.role).toBe("custom");
	});

	test("deleting one result of a two-call step turns the step into notes", () => {
		const snapshot = stable();
		const result = applyContextDocument(deleteBlock(snapshot.text, blockId(snapshot, "toolResult", 0)), snapshot, clm);
		expect(result.accepted).toBe(true);
		expect(hasOrphanToolMessages(result.messages)).toBe(false);
		expect(result.messages.map((message) => message.role)).toEqual(["custom", "custom", "assistant"]);
		expect(String(result.messages[0]!.content)).toContain("[tool call: bash]");
		expect(String(result.messages[1]!.content)).toContain("small output");
	});

	test("deleting an assistant block turns its results into notes", () => {
		const snapshot = stable();
		const result = applyContextDocument(deleteBlock(snapshot.text, blockId(snapshot, "assistant", 0)), snapshot, clm);
		expect(result.accepted).toBe(true);
		expect(hasOrphanToolMessages(result.messages)).toBe(false);
		expect(result.messages.map((message) => message.role)).toEqual(["custom", "custom", "assistant"]);
	});

	test("editing an assistant body drops its tool calls and keeps the results as notes", () => {
		const messages = openCodeStep();
		const snapshot = stable(messages);
		const result = applyContextDocument(replaceBody(snapshot.text, blockId(snapshot, "assistant", 0), "I listed files."), snapshot, clm);
		expect(result.accepted).toBe(true);
		const [first, ...rest] = result.messages;
		expect(first!.role).toBe("assistant");
		expect(first!.ocMessageID).toBe("msg_a1");
		expect(first!.content).toEqual([{ type: "text", text: "I listed files." }]);
		expect(rest.slice(0, 2).map((message) => message.role)).toEqual(["custom", "custom"]);
		expect(rest[2]).toBe(messages[3]!);
	});
});

describe("nonce-bound framing", () => {
	test("legacy and example header lines inside message bodies are ordinary content", () => {
		const collisionBody = [
			"Parser documentation:",
			"[[CTX_TURN 1 role=user id=abc123 protected=true]]",
			`[[LIVE_CONTEXT version=1 revision=0 baseline=${"a".repeat(64)}]]`,
			`[[CTX_TURN document=${"b".repeat(64)} index=77 role=toolResult id=fake protected=false]]`,
		].join("\n");
		const messages: LiveContextMessage[] = [
			{ role: "user", content: "Keep framing examples", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: collisionBody }], timestamp: 2 },
			{ role: "assistant", content: [{ type: "text", text: "Verbose stale explanation".repeat(30) }], timestamp: 3 },
		];
		const snapshot = renderContextDocument(messages);
		const result = applyContextDocument(replaceBody(snapshot.text, snapshot.blocks[2]!.id, "Concise explanation"), snapshot, { gate: "none" });
		expect(result.accepted).toBe(true);
		expect(result.messages[1]).toBe(messages[1]!);
		expect(JSON.stringify(result.messages[1])).toContain("id=abc123");
	});

	test("without a seed, headers printed from an earlier mirror cannot frame the next document", () => {
		const firstMessages = conversation();
		const first = renderContextDocument(firstMessages, { revision: 1 });
		const listedHeaders = first.blocks.map((block) => block.header).join("\n");
		const nextMessages: LiveContextMessage[] = [
			...firstMessages,
			{ role: "custom", customType: "captured-header-list", content: listedHeaders, timestamp: 6 },
			{ role: "assistant", content: [{ type: "text", text: "Another stale explanation".repeat(30) }], timestamp: 7 },
		];
		const next = renderContextDocument(nextMessages, { revision: 1 });
		expect(next.documentId).not.toBe(first.documentId);
		const currentHeaders = next.text.split("\n").filter((line) => line.startsWith(`[[CTX_TURN document=${next.documentId} `));
		expect(currentHeaders).toHaveLength(next.blocks.length);
		const result = applyContextDocument(replaceBody(next.text, next.blocks.at(-1)!.id, "Short current conclusion"), next, { gate: "none" });
		expect(result.accepted).toBe(true);
		expect(result.messages.at(-2)).toBe(nextMessages.at(-2)!);
		expect(JSON.stringify(result.messages.at(-2))).toContain(first.documentId);
	});
});

describe("stable document nonce", () => {
	const base: LiveContextMessage[] = [
		{ role: "user", content: "task", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "working" }], timestamp: 2 },
	];
	const grown = [...base, { role: "user", content: "more", timestamp: 3 }];
	const seeded = (messages: LiveContextMessage[], seed: string, revision = 0) =>
		renderContextDocument(messages, { revision, protectedIndexes: new Set(), documentSeed: seed });

	test("the nonce stays constant across renders with new messages until the seed changes", () => {
		const a = seeded(base, "s:raw");
		const b = seeded(grown, "s:raw");
		expect(a.documentId).toBe(b.documentId);
		expect(a.baselineDigest).not.toBe(b.baselineDigest);
		expect(a.blocks[0]!.header).toBe(b.blocks[0]!.header);
		expect(seeded(grown, "s:digest-after-edit", 1).documentId).not.toBe(b.documentId);
		expect(renderContextDocument(grown, { revision: 0, protectedIndexes: new Set() }).documentId).not.toBe(b.documentId);
	});

	test("a document whose metadata line carries an older baseline is still accepted", () => {
		const first = seeded(base, "s");
		const current = seeded(grown, "s");
		const staleMeta = current.text.replace(current.text.split("\n")[0]!, first.text.split("\n")[0]!).replace("working", "done");
		const result = applyContextDocument(staleMeta, current, clm);
		expect(result.accepted).toBe(true);
		expect(result.messages[1]!.content).toEqual([{ type: "text", text: "done" }]);
	});

	test("rejections name the expected revision and nonce", () => {
		const current = seeded(base, "s", 2);
		const wrong = applyContextDocument(current.text.replace("revision=2", "revision=1"), current, clm);
		expect(wrong.accepted).toBe(false);
		expect(wrong.reason).toContain(`expected revision 2, document ${current.documentId.slice(0, 12)}`);
		const unknown = current.text.replace(/id=1-[a-f0-9]+/, "id=1-deadbeef0000");
		expect(applyContextDocument(unknown, current, clm).reason).toContain("prefix a new block's id with new-");
	});

	test("metadata rejections quote the exact first line to paste back", () => {
		const current = seeded(base, "s", 1);
		const result = applyContextDocument(current.text.replace("revision=1", "revision=0"), current, clm);
		expect(result.accepted).toBe(false);
		expect(result.reason).toEndWith(`The first line must be exactly: ${current.text.split("\n")[0]}`);
	});

	test("live headers quoted inside a tool result are escaped and never parsed as blocks", () => {
		const first = seeded(base, "s");
		const quoted = `$ head -3 LIVE_CONTEXT.md\n${first.text.split("\n").slice(0, 3).join("\n")}\n${first.blocks[0]!.header}`;
		const withTool: LiveContextMessage[] = [
			...base,
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }], timestamp: 3 },
			{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: quoted }], isError: false, timestamp: 4 },
		];
		const snapshot = seeded(withTool, "s");
		expect(snapshot.blocks).toHaveLength(4);
		expect(snapshot.blocks[3]!.body).toMatch(/\\\[\[LIVE_CONTEXT /);
		expect(snapshot.blocks[3]!.body).toMatch(/\\\[\[CTX_TURN /);
		const identity = applyContextDocument(snapshot.text, snapshot, clm);
		expect(identity.accepted).toBe(true);
		expect(identity.messages[3]).toBe(withTool[3]!);
		const edited = snapshot.text.replace("$ head -3 LIVE_CONTEXT.md", "$ head -3 (trimmed)");
		const result = applyContextDocument(edited, snapshot, clm);
		expect(result.accepted).toBe(true);
		const text = JSON.stringify(result.messages[3]!.content);
		expect(text).toMatch(/\[\[CTX_TURN document=/);
		expect(text).not.toMatch(/\\\\\[\[CTX_TURN/);
	});

	test("an edited body keeps a quoted header escaped in the mirror and restored in the message", () => {
		const messages: LiveContextMessage[] = [
			{ role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }], timestamp: 1 },
			{ role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "[[CTX_TURN fake]]\nmore" }], timestamp: 2 },
		];
		const snapshot = seeded(messages, "s");
		expect(snapshot.text).toContain("\\[[CTX_TURN fake]]");
		const edited = replaceBody(snapshot.text, blockId(snapshot, "toolResult"), "\\[[CTX_TURN fake]]\nshorter");
		const result = applyContextDocument(edited, snapshot, { ...clm, gate: "none" });
		expect(result.accepted).toBe(true);
		expect(result.messages[1]!.content).toEqual([{ type: "text", text: "[[CTX_TURN fake]]\nshorter" }]);
	});

	test("escape/unescape round-trip, including already-escaped lines", () => {
		const body = "[[CTX_TURN document=x]]\n\\[[LIVE_CONTEXT v]]\nplain [[CTX_TURN not at line start";
		const escaped = escapeStructuralLines(body);
		expect(escaped).toBe("\\[[CTX_TURN document=x]]\n\\\\[[LIVE_CONTEXT v]]\nplain [[CTX_TURN not at line start");
		expect(unescapeStructuralLines(escaped)).toBe(body);
	});
});

describe("headerless rewrite", () => {
	const withTool: LiveContextMessage[] = [
		{ role: "user", content: "find the secrets", timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }], timestamp: 2 },
		{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "SECRET=42" }], isError: false, timestamp: 3 },
		{ role: "user", content: "continue", timestamp: 4 },
	];
	const summary = "# Context Summary\n## Found so far\n- f01: SECRET=42\n<!-- Budget: 20000/20000 -->";
	const snapshot = () => renderContextDocument(withTool, { revision: 0, protectedIndexes: new Set(), documentSeed: "s" });

	test("is accepted as one notes block after the first user turn", () => {
		const current = snapshot();
		const result = applyContextDocument(summary, current, { ...clm, gate: "none" });
		expect(result.accepted).toBe(true);
		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]).toBe(withTool[0]!);
		expect(result.messages[1]!.role).toBe("custom");
		expect(String(result.messages[1]!.content)).toMatch(/\[context role=notes\]\n# Context Summary/);
		expect(result.diagnostics.join(" ")).toContain("Accepted a headerless rewrite");
		expect(result.editTrace?.sources.filter((s) => s.kind === "removed").map((s) => s.sourceIndex)).toEqual([1, 2, 3]);
		expect(applyContextDocument(`${current.text.split("\n")[0]}\n\n${summary}`, current, { ...clm, gate: "none" }).accepted).toBe(true);
	});

	test("replaces every block when the task is pinned outside the mirror", () => {
		const result = applyContextDocument(summary, snapshot(), { ...clm, gate: "none", taskPinned: true });
		expect(result.accepted).toBe(true);
		expect(result.messages).toHaveLength(1);
		expect(String(result.messages[0]!.content)).toContain("# Context Summary");
	});

	test("a stale full mirror is rejected as stale metadata, not taken as a rewrite", () => {
		const old = renderContextDocument(withTool.slice(0, 2), { revision: 0, protectedIndexes: new Set(), documentSeed: "old" });
		const current = snapshot();
		const stale = applyContextDocument(old.text, current, clm);
		expect(stale.accepted).toBe(false);
		expect(stale.reason).toContain("Mirror metadata does not match");
		// Old block headers without any metadata line are stale too.
		const headersOnly = old.text.slice(old.text.indexOf("[[CTX_TURN"));
		expect(applyContextDocument(headersOnly, current, clm).reason).toContain("Mirror metadata does not match");
		// So is a summary under an older revision's metadata line.
		const previous = renderContextDocument(withTool, { revision: 1, protectedIndexes: new Set(), documentSeed: "s" });
		const underOldMeta = `${current.text.split("\n")[0]}\n\n${summary}`;
		expect(applyContextDocument(underOldMeta, previous, clm).reason).toContain("Mirror metadata does not match");
	});

	test("is rejected outside CLM mode, and whitespace is not a rewrite", () => {
		expect(applyContextDocument(summary, renderContextDocument(withTool, { revision: 0 }), {}).accepted).toBe(false);
		expect(applyContextDocument("   \n", snapshot(), clm).accepted).toBe(false);
	});
});
