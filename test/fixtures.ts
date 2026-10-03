// OpenCode `{ info, parts }` message builders for session and flatten tests.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OcMessage, OcPart } from "../src/opencode.ts";
import { resolveSettings } from "../src/settings.ts";

export const SESSION = "ses_test";
let counter = 0;

export function part(messageID: string, fields: Record<string, unknown>): OcPart {
	counter += 1;
	return { id: `prt_${String(counter).padStart(4, "0")}`, sessionID: SESSION, messageID, ...fields } as unknown as OcPart;
}

export function user(id: string, text: string): OcMessage {
	return {
		info: { id, sessionID: SESSION, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } },
		parts: [part(id, { type: "text", text })],
	};
}

export interface ToolSpec {
	callID: string;
	tool?: string;
	input?: Record<string, unknown>;
	output: string;
}

export function toolPart(messageID: string, spec: ToolSpec): OcPart {
	return part(messageID, {
		type: "tool",
		callID: spec.callID,
		tool: spec.tool ?? "bash",
		state: {
			status: "completed",
			input: spec.input ?? { command: `cmd ${spec.callID}` },
			output: spec.output,
			title: spec.callID,
			metadata: {},
			time: { start: 1, end: 2 },
		},
	});
}

export function assistant(id: string, text: string, tools: ToolSpec[] = [], tokens = 0): OcMessage {
	return {
		info: {
			id,
			sessionID: SESSION,
			role: "assistant",
			time: { created: 2, completed: 3 },
			parentID: "msg_u1",
			modelID: "m",
			providerID: "p",
			mode: "build",
			agent: "build",
			path: { cwd: "/", root: "/" },
			cost: 0,
			tokens: { input: tokens, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
			finish: tools.length ? "tool-calls" : "stop",
		},
		parts: [
			part(id, { type: "step-start" }),
			...(text ? [part(id, { type: "text", text })] : []),
			...tools.map((spec) => toolPart(id, spec)),
		],
	};
}

/** Task, then one assistant step with two tool calls, then a final text answer. */
export function conversation(bigOutput = "x".repeat(400)): OcMessage[] {
	return [
		user("msg_u1", "Inspect the repository and report."),
		assistant("msg_a1", "Looking at files.", [
			{ callID: "call_1", output: `big output\n${bigOutput}` },
			{ callID: "call_2", output: "small output" },
		]),
		assistant("msg_a2", "Found what I need."),
	];
}

export function tempDir(prefix = "clm-session-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Settings rooted in a fresh temp project; `mirrorDir` defaults to `<project>/.opencode/clm`. */
export function settings(extra: Record<string, unknown> = {}) {
	return resolveSettings({ ...extra }, {}, tempDir());
}

export function toolOutput(message: OcMessage | undefined, callID: string): unknown {
	return message?.parts.find((candidate) => candidate.callID === callID)?.state?.output;
}
