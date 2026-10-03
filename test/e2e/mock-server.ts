/**
 * Scripted OpenAI-compatible server for the integration tests. CPU only, no model.
 *
 * Each test passes a `Script`: a function from the recorded request to the reply. `steps()`
 * builds the common case, one reply per main-agent request in order. Requests are
 * classified by their system prompt:
 *   main:       carries the plugin's `## Editable context` section;
 *   compaction: OpenCode's compaction agent ("context summarization agent");
 *   helper:     anything else (title generator and the like).
 * Non-main requests get a default one-line answer unless the script answers them.
 *
 * For main requests the server also snapshots the mirror file named in the system prompt
 * at the moment the request arrives: the plugin renders it right before the request goes
 * out, so the snapshot is the mirror that request was built from.
 */
import { existsSync, readFileSync } from "node:fs";

export const MODEL_ID = "mock-clm";
export const HELPER_ANSWER = "CLM e2e";
export const COMPACTION_SUMMARY = "E2E_COMPACTION_SUMMARY";
/** What `steps()` answers once its script is used up; tests assert it never appears. */
export const SCRIPT_EXHAUSTED = "E2E_SCRIPT_EXHAUSTED";

export type ChatMessage = { role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string };
export type Kind = "main" | "compaction" | "helper";

export interface Usage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens?: number;
}

export interface ToolCall {
	name: string;
	args: Record<string, unknown>;
}

export type Reply = { text: string; usage?: Usage } | { tools: ToolCall[]; usage?: Usage };

export interface RecordedRequest {
	/** 1-based position among all requests. */
	n: number;
	kind: Kind;
	body: any;
	messages: ChatMessage[];
	system: string;
	/** Tool-result messages in this request. */
	toolResults: number;
	/** Mirror path from the system prompt (main requests). */
	mirrorPath?: string;
	/** Mirror file content when the request arrived (main requests). */
	mirrorText?: string;
}

export type Script = (request: RecordedRequest, mainIndex: number) => Reply | undefined;
export type Step = Reply | ((request: RecordedRequest) => Reply);

export interface MockServer {
	url: string;
	requests: RecordedRequest[];
	main(): RecordedRequest[];
	ofKind(kind: Kind): RecordedRequest[];
	stop(): void;
}

export const DEFAULT_USAGE: Usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("");
	return "";
}

/** The mirror path named in the CLM system-prompt section. */
export function mirrorPathFrom(system: string): string | undefined {
	return system.match(/`([^`\s]+\/LIVE_CONTEXT\.md)`/)?.[1];
}

export function text(value: string, usage?: Usage): Reply {
	return { text: value, usage };
}

export function bash(command: string, description = "e2e step", usage?: Usage): Reply {
	return { tools: [{ name: "bash", args: { command, description } }], usage };
}

/** Reply `script[i]` to the i-th main request; other requests get the default answer. */
export function steps(...script: Step[]): Script {
	return (request, mainIndex) => {
		if (request.kind !== "main") return undefined;
		const step = script[mainIndex];
		if (step === undefined) return text(SCRIPT_EXHAUSTED);
		return typeof step === "function" ? step(request) : step;
	};
}

function chunk(id: string, delta: object, finish: string | null = null): string {
	const payload = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish }] };
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function usageChunk(id: string, usage: Usage): string {
	const full = { ...usage, total_tokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens };
	const payload = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL_ID, choices: [], usage: full };
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function stream(id: string, reply: Reply): string {
	const usage = usageChunk(id, reply.usage ?? DEFAULT_USAGE);
	if ("text" in reply) {
		return chunk(id, { role: "assistant", content: "" }) + chunk(id, { content: reply.text }) + chunk(id, {}, "stop") + usage + "data: [DONE]\n\n";
	}
	const calls = reply.tools.map((call, index) => ({
		index,
		id: `call_${id}_${index}`,
		type: "function",
		function: { name: call.name, arguments: JSON.stringify(call.args) },
	}));
	return chunk(id, { role: "assistant", content: null, tool_calls: calls }) + chunk(id, {}, "tool_calls") + usage + "data: [DONE]\n\n";
}

function classify(system: string): Kind {
	if (system.includes("## Editable context")) return "main";
	if (/context summarization agent/i.test(system)) return "compaction";
	return "helper";
}

export function startMockServer(script: Script): MockServer {
	const requests: RecordedRequest[] = [];
	let mainCount = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path.endsWith("/models")) return Response.json({ object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: "e2e" }] });
			if (!path.endsWith("/chat/completions") || request.method !== "POST") return new Response("not found", { status: 404 });
			const body = await request.json();
			const messages = (body.messages ?? []) as ChatMessage[];
			const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
			const kind = classify(system);
			const recorded: RecordedRequest = {
				n: requests.length + 1,
				kind,
				body,
				messages,
				system,
				toolResults: messages.filter((m) => m.role === "tool").length,
			};
			if (kind === "main") {
				recorded.mirrorPath = mirrorPathFrom(system);
				if (recorded.mirrorPath && existsSync(recorded.mirrorPath)) recorded.mirrorText = readFileSync(recorded.mirrorPath, "utf8");
			}
			requests.push(recorded);
			// opencode 1.18.34 always streams; a non-streaming request means its behaviour changed.
			if (body.stream !== true) return new Response("mock serves streaming requests only", { status: 400 });
			const mainIndex = kind === "main" ? mainCount++ : -1;
			let reply: Reply | undefined;
			try {
				reply = script(recorded, mainIndex);
			} catch (error) {
				reply = text(`E2E_SCRIPT_ERROR ${error instanceof Error ? error.message : String(error)}`);
			}
			reply ??= text(kind === "compaction" ? COMPACTION_SUMMARY : HELPER_ANSWER);
			return new Response(stream(`chatcmpl-${recorded.n}`, reply), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/v1`,
		requests,
		main: () => requests.filter((r) => r.kind === "main"),
		ofKind: (kind) => requests.filter((r) => r.kind === kind),
		stop: () => server.stop(true),
	};
}
