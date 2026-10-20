// Plugin wiring tests for OpenCode 2: `setup` driven the way OpenCode 2.1.1 calls it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import plugin, { server } from "../index.ts";
import { COMPACT_COMMAND, STATUS_COMMAND } from "../src/commands.ts";
import type { V2Message } from "../src/opencode-v2.ts";
import { setup, type V2Context } from "../src/v2.ts";
import { SESSION, tempDir } from "./fixtures.ts";
import { replaceBody } from "./helpers.ts";

type Callback = (event: any) => Promise<void> | void;

interface Harness {
	directory: string;
	hooks: Map<string, Callback>;
	commands: Map<string, { execute(input: any): Promise<void> }>;
	tools: Map<string, any>;
	skills: any[];
	synthetic: Array<{ sessionID: string; text: string; resume?: boolean }>;
	prompts: Array<Record<string, unknown>>;
	metadata: Map<string, Record<string, unknown>>;
	emit(event: { type: string; data: Record<string, unknown> }): Promise<void>;
	cleanup: (() => void) | void;
}

async function load(options: Record<string, unknown> = {}): Promise<Harness> {
	const directory = tempDir("clm-v2-");
	const hooks = new Map<string, Callback>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const skills: any[] = [];
	const synthetic: Harness["synthetic"] = [];
	const prompts: Harness["prompts"] = [];
	const metadata = new Map<string, Record<string, unknown>>();
	const queue: Array<{ type: string; data: Record<string, unknown> }> = [];
	let wake: (() => void) | undefined;
	let posted = 0;
	const registration = { dispose: async () => undefined };
	const ctx: V2Context = {
		location: { directory },
		options: { mirrorDir: join(directory, "mirrors"), ...options },
		session: {
			get: async ({ sessionID }) => ({ id: sessionID, time: { created: 1 }, metadata: metadata.get(sessionID) ?? {} }),
			update: async ({ sessionID, metadata: next }) => void metadata.set(sessionID, next ?? {}),
			prompt: async (input) => void prompts.push(input),
			synthetic: async (input) => {
				synthetic.push(input);
				return { id: `msg_display${++posted}` };
			},
			hook: async (name, callback) => (hooks.set(name, callback), registration),
		},
		tool: {
			transform: async (callback) => (callback({ add: (definition) => tools.set(String(definition.name), definition) }), registration),
			hook: (async (name: string, callback: Callback) => (hooks.set(`tool.${name}`, callback), registration)) as never,
		},
		command: {
			transform: async (callback) => (callback({ add: (definition) => commands.set(definition.name, definition) }), registration),
		},
		skill: {
			transform: async (callback) => (callback({ add: (skill) => skills.push(skill), get: () => undefined }), registration),
		},
		model: { list: async () => ({ data: [{ providerID: "p", id: "m", limit: { context: 100_000, output: 8_000 } }] }) },
		event: {
			subscribe: ({ signal }) => ({
				async *[Symbol.asyncIterator]() {
					while (!signal.aborted) {
						while (queue.length > 0) yield queue.shift()!;
						await new Promise<void>((resolve) => (wake = resolve));
					}
				},
			}),
		},
	};
	const cleanup = await setup(ctx);
	const emit = async (event: { type: string; data: Record<string, unknown> }) => {
		queue.push(event);
		wake?.();
		await Bun.sleep(5);
	};
	return { directory, hooks, commands, tools, skills, synthetic, prompts, metadata, emit, cleanup };
}

function conversation(big = "x".repeat(400)): V2Message[] {
	return [
		{ id: "msg_u1", role: "user", content: [{ type: "text", text: "Inspect the repository and report." }] },
		{
			id: "msg_a1",
			role: "assistant",
			content: [
				{ type: "text", text: "Looking at files." },
				{ type: "tool-call", id: "call_1", name: "read", input: { path: "/repo/big.txt" } },
			],
		},
		{ role: "tool", content: [{ type: "tool-result", id: "call_1", name: "read", result: { type: "text", value: `big output\n${big}` } }] },
		{ id: "msg_a2", role: "assistant", content: [{ type: "text", text: "Found what I need." }] },
	];
}

async function request(h: Harness, messages: V2Message[], name = "context") {
	const event = {
		sessionID: SESSION,
		agent: "build",
		model: { providerID: "p", id: "m" },
		system: [{ type: "text" as const, text: "You are OpenCode." }],
		messages,
		tools: { read: { description: "Read a file", input: { type: "object" } } },
	};
	await h.hooks.get(name)!(event);
	return event;
}

const mirrorPath = (h: Harness) => join(h.directory, "mirrors", `clm-${SESSION}`, "LIVE_CONTEXT.md");

describe("module shape", () => {
	test("one default export serves OpenCode 1 (server) and OpenCode 2 (id + setup)", () => {
		expect(plugin.id).toBe("opencode-clm");
		expect(plugin.server).toBe(server);
		expect(plugin.setup).toBe(setup);
	});

	test("enabled: false registers nothing", async () => {
		const h = await load({ enabled: false });
		expect(h.hooks.size).toBe(0);
		expect(h.commands.size).toBe(0);
	});

	test("registers /clm, /clm-compact, the continuity tools and the bundled skill", async () => {
		const h = await load();
		expect([...h.commands.keys()]).toEqual([STATUS_COMMAND, COMPACT_COMMAND]);
		expect([...h.tools.keys()]).toEqual(["clm_annotate", "clm_recall"]);
		expect(h.skills.map((skill) => skill.id)).toEqual(["clm-context"]);
		expect(h.skills[0].content).toContain("Editing the CLM context mirror");
		expect([...h.hooks.keys()]).toEqual(expect.arrayContaining(["context", "compaction", "tool.execute.before", "tool.execute.after"]));
	});
});

describe("context hook", () => {
	test("adds the protocol section, renders the mirror, and applies the model's edit on the next request", async () => {
		const h = await load();
		const first = await request(h, conversation());
		expect(first.system.at(-1)!.text).toContain(mirrorPath(h));
		expect(first.messages).toEqual(conversation());
		const mirror = readFileSync(mirrorPath(h), "utf8");
		expect(mirror).toContain("big output");

		const block = /role=toolResult id=(\S+)/.exec(mirror)?.[1];
		expect(block).toBeDefined();
		writeFileSync(mirrorPath(h), replaceBody(mirror, block!, "[summary: 400 x's]"));
		const after = { tool: "edit", sessionID: SESSION, id: "call_e", input: { path: mirrorPath(h) }, status: "completed", result: { content: "Edited." } };
		await h.hooks.get("tool.execute.after")!(after);
		expect(after.result.content).toContain("[CLM] Mirror edit valid");

		const next = await request(h, [...conversation(), { id: "msg_a3", role: "assistant", content: [{ type: "text", text: "Next." }] }]);
		const result = next.messages.find((message) => message.role === "tool")!;
		expect(result.content[0]!.result.value).toBe("[summary: 400 x's]");
		expect(JSON.stringify(next.messages.at(-1))).toContain("Applied revision 1");
	});

	test("compaction auto keeps a window budget under OpenCode's compaction threshold; on does not", async () => {
		// Model window 100k, output 8k: OpenCode compacts at 100k − 16k (15% = 15k < 16k) = 84k.
		const auto = await load({ budget: "window" });
		await request(auto, conversation());
		await auto.commands.get(STATUS_COMMAND)!.execute({ sessionID: SESSION, prompt: { text: "" }, delivery: "steer" });
		expect(auto.synthetic.at(-1)!.text).toContain("84,000");
		const on = await load({ budget: "window", compaction: "on" });
		await request(on, conversation());
		await on.commands.get(STATUS_COMMAND)!.execute({ sessionID: SESSION, prompt: { text: "" }, delivery: "steer" });
		expect(on.synthetic.at(-1)!.text).toContain("92,000");
	});

	test("the compaction hook adds the CLM instruction and leaves the history as sent", async () => {
		const h = await load();
		await request(h, conversation());
		const event = await request(h, conversation(), "compaction");
		expect(event.system.at(-1)!.text).toContain("CLM note for the summary");
		expect(event.messages).toEqual(conversation());
	});

	test("after a compaction the accepted revision rebases onto the checkpoint instead of being dropped", async () => {
		const h = await load();
		await request(h, conversation());
		const mirror = readFileSync(mirrorPath(h), "utf8");
		writeFileSync(mirrorPath(h), replaceBody(mirror, /role=toolResult id=(\S+)/.exec(mirror)![1]!, "short"));
		const edited = await request(h, [...conversation(), { id: "msg_a3", role: "assistant", content: [{ type: "text", text: "Next." }] }]);
		expect(JSON.stringify(edited.messages.at(-1))).toContain("Applied revision 1");
		await request(h, [...conversation(), { id: "msg_a3", role: "assistant", content: [{ type: "text", text: "Next." }] }], "compaction");
		// The follow-up request comes before `session.compaction.ended` reaches the event stream.
		const checkpoint: V2Message = {
			id: "msg_c1",
			role: "user",
			content: [{ type: "text", text: "<conversation-checkpoint>\nThe following is a summary...\n<summary>\nRead big.txt.\n</summary>\n</conversation-checkpoint>" }],
		};
		const after = await request(h, [checkpoint, { id: "msg_u2", role: "user", content: [{ type: "text", text: "continue" }] }]);
		const sent = JSON.stringify(after.messages);
		expect(sent).not.toContain("was dropped");
		const events = readFileSync(join(h.directory, "mirrors", `clm-${SESSION}`, "events.jsonl"), "utf8");
		expect(events).toContain('"event":"compacted"');
		expect(events).not.toContain('"event":"projection-reset"');
	});

	test("an automatic compaction by OpenCode shows in /clm status and plugin.log", async () => {
		const h = await load();
		await request(h, conversation());
		await h.emit({ type: "session.compaction.started", data: { sessionID: SESSION, reason: "auto" } });
		await h.emit({ type: "session.compaction.ended", data: { sessionID: SESSION } });
		await h.commands.get(STATUS_COMMAND)!.execute({ sessionID: SESSION, prompt: { text: "" }, delivery: "steer" });
		expect(h.synthetic.at(-1)!.text).toMatch(/last compaction: OpenCode, automatic, at \d\d:\d\d/);
		expect(readFileSync(join(h.directory, "mirrors", "plugin.log"), "utf8")).toContain(`OpenCode compacted session ${SESSION} (automatic)`);
		await h.emit({ type: "session.compaction.started", data: { sessionID: SESSION, reason: "manual" } });
		await h.emit({ type: "session.compaction.ended", data: { sessionID: SESSION } });
		await h.commands.get(STATUS_COMMAND)!.execute({ sessionID: SESSION, prompt: { text: "" }, delivery: "steer" });
		expect(h.synthetic.at(-1)!.text).toContain("last compaction: OpenCode, /compact");
	});

	test("session.step.ended usage reaches the core as the provider count", async () => {
		const h = await load();
		await h.emit({ type: "session.step.ended", data: { sessionID: SESSION, assistantMessageID: "msg_a2", tokens: { input: 5000, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } } });
		await request(h, conversation());
		await request(h, [...conversation(), { id: "msg_a3", role: "assistant", content: [{ type: "text", text: "Next." }] }]);
		if (typeof h.cleanup === "function") h.cleanup();
	});
});

describe("commands", () => {
	test("/clm posts its text without starting a model turn", async () => {
		const h = await load();
		await request(h, conversation());
		await h.commands.get(STATUS_COMMAND)!.execute({ sessionID: SESSION, prompt: { text: "path" }, delivery: "steer" });
		expect(h.synthetic).toHaveLength(1);
		expect(h.synthetic[0]).toMatchObject({ sessionID: SESSION, resume: false });
		expect(h.synthetic[0]!.text).toContain("CLM mirror:");
		expect(h.prompts).toHaveLength(0);
	});

	test("/clm-compact sends the compaction prompt as a user prompt; a second one waits", async () => {
		const h = await load();
		await request(h, conversation());
		await h.commands.get(COMPACT_COMMAND)!.execute({ sessionID: SESSION, prompt: { text: "keep the plan" }, delivery: "steer" });
		expect(h.prompts).toHaveLength(1);
		expect(String(h.prompts[0]!.text)).toStartWith("Compact your live context now.");
		expect(String(h.prompts[0]!.text)).toContain("keep the plan");
		await h.commands.get(COMPACT_COMMAND)!.execute({ sessionID: SESSION, prompt: { text: "" }, delivery: "steer" });
		expect(h.prompts).toHaveLength(1);
		expect(h.synthetic.at(-1)!.text).toContain("already queued");
	});
});
