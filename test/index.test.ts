// Plugin wiring tests: the hooks of index.ts driven the way opencode 1.18.34 calls them.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Hooks, PluginInput, ToolContext } from "@opencode-ai/plugin";

import plugin, { checkSessionID, COMPACT_COMMAND, PLUGIN_ID, server, STATUS_COMMAND } from "../index.ts";
import { ClmSession } from "../src/clm.ts";
import type { OcMessage } from "../src/opencode.ts";
import { SKILLS_DIR } from "../src/settings.ts";
import { assistant, conversation, SESSION, tempDir, toolOutput, user } from "./fixtures.ts";
import { replaceBody } from "./helpers.ts";

const SKILL_FILE = join(SKILLS_DIR, "clm-context", "SKILL.md");

interface Harness {
	hooks: Hooks;
	directory: string;
	toasts: Array<{ message: string; variant: string }>;
	logs: string[];
}

/** Load the plugin and, as OpenCode does at startup, run its config hook once. */
async function load(options: Record<string, unknown> = {}, config: Record<string, unknown> | false = {}): Promise<Harness> {
	const directory = tempDir("clm-plugin-");
	const toasts: Harness["toasts"] = [];
	const logs: string[] = [];
	const input = {
		directory,
		worktree: directory,
		client: {
			tui: { showToast: async ({ body }: { body: { message: string; variant: string } }) => toasts.push(body) },
			app: { log: async ({ body }: { body: { message: string } }) => logs.push(body.message) },
		},
	} as unknown as PluginInput;
	const hooks = await server(input, { mirrorDir: join(directory, "mirrors"), ...options });
	if (config !== false && hooks.config) await hooks.config(config as never);
	return { hooks, directory, toasts, logs };
}

function mirrorPath(harness: Harness, sessionID = SESSION): string {
	return join(harness.directory, "mirrors", `clm-${sessionID}`, "LIVE_CONTEXT.md");
}

async function transform(hooks: Hooks, messages: OcMessage[]): Promise<OcMessage[]> {
	const output = { messages } as unknown as Parameters<NonNullable<Hooks["experimental.chat.messages.transform"]>>[1];
	await hooks["experimental.chat.messages.transform"]!({}, output);
	return output.messages as unknown as OcMessage[];
}

async function system(hooks: Hooks, sessionID: string | undefined, prompt: string[], limit = { context: 100_000, output: 8_000 }) {
	const output = { system: prompt };
	await hooks["experimental.chat.system.transform"]!({ sessionID, model: { limit } as never }, output);
	return output.system;
}

function toolContext(sessionID: string): ToolContext {
	return {
		sessionID,
		messageID: "msg_x",
		agent: "build",
		directory: "/",
		worktree: "/",
		abort: new AbortController().signal,
		metadata: () => undefined,
		ask: async () => undefined,
	};
}

async function command(hooks: Hooks, name: string, args = "", sessionID = SESSION): Promise<string> {
	const output = { parts: [{ type: "text", text: "template" }] } as never as { parts: Array<{ type: string; text: string }> };
	await hooks["command.execute.before"]!({ command: name, sessionID, arguments: args }, output as never);
	return output.parts[0]!.text;
}

async function afterTool(hooks: Hooks, tool: string, args: Record<string, unknown>, text = "ok\n") {
	const output = { title: "", output: text, metadata: {} };
	await hooks["tool.execute.after"]!({ tool, sessionID: SESSION, callID: "call_x", args }, output);
	return output.output;
}

const partsText = (message: OcMessage | undefined) =>
	message?.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";

describe("module shape", () => {
	test("default export is an OpenCode 1.18 server plugin module", () => {
		expect(plugin.id).toBe(PLUGIN_ID);
		expect(plugin.server).toBe(server);
		expect("tui" in plugin).toBe(false);
	});

	test("enabled: false loads no hooks", async () => {
		const { hooks } = await load({ enabled: false });
		expect(Object.keys(hooks)).toEqual([]);
	});

	test("an unreadable steering file fails the plugin load with its path", async () => {
		await expect(load({ steering: "/nonexistent/brief.md" })).rejects.toThrow("/nonexistent/brief.md");
	});
});

describe("config", () => {
	test("registers /clm, /clm-compact and the skill directory; a user's /clm stays theirs", async () => {
		const { hooks, logs } = await load({}, false);
		const config: Record<string, any> = { command: { [STATUS_COMMAND]: { template: "mine" } }, skills: { paths: ["/x"] } };
		await hooks.config!(config as never);
		await hooks.config!(config as never); // a second call adds nothing twice
		expect(config.command[STATUS_COMMAND]).toEqual({ template: "mine" }); // the user's definition wins
		expect(logs.filter((line) => line.includes("/clm;"))).not.toHaveLength(0);
		expect(await command(hooks, STATUS_COMMAND)).toBe("template"); // and is not rewritten
		expect(await command(hooks, COMPACT_COMMAND)).toStartWith("Compact your live context now.");
		expect(config.command[COMPACT_COMMAND].template).toContain("$ARGUMENTS");
		expect(config.skills.paths).toEqual(["/x", SKILLS_DIR]);
		expect(existsSync(SKILL_FILE)).toBe(true);
	});

	test("commands: false and skill: false register nothing", async () => {
		const { hooks } = await load({ commands: false, skill: false }, false);
		const config: Record<string, any> = {};
		await hooks.config!(config as never);
		expect(config).toEqual({});
		expect(await command(hooks, STATUS_COMMAND)).toBe("template");
	});
});

describe("experimental.chat.messages.transform", () => {
	test("writes the result into OpenCode's own array and refreshes the mirror", async () => {
		const harness = await load();
		const raw = conversation();
		const array = structuredClone(raw);
		const result = await transform(harness.hooks, array);
		expect(result).toBe(array);
		expect(array.map((message) => message.info.id)).toEqual(["msg_u1", "msg_a1", "msg_a2"]);
		expect(readFileSync(mirrorPath(harness), "utf8")).toContain("big output");

		// The model's edit applies to the next request, again in place.
		const mirror = readFileSync(mirrorPath(harness), "utf8");
		const id = /^\[\[CTX_TURN [^\n]* role=toolResult id=(\S+) /m.exec(mirror)![1]!;
		writeFileSync(mirrorPath(harness), replaceBody(mirror, id, "[short]"));
		const next = [...structuredClone(raw), assistant("msg_a3", "Next.")];
		await transform(harness.hooks, next);
		expect(toolOutput(next[1], "call_1")).toBe("[short]");
		expect(partsText(next.at(-1))).toContain("Applied revision 1");
		expect(next.at(-1)!.info.role).toBe("user");
	});

	test("an empty array or a hostile session id leaves the request untouched", async () => {
		const harness = await load();
		const empty: OcMessage[] = [];
		await transform(harness.hooks, empty);
		expect(empty).toEqual([]);
		const raw = conversation().map((message) => ({ ...message, info: { ...message.info, sessionID: "../escape" } }));
		const copy = structuredClone(raw);
		await transform(harness.hooks, copy);
		expect(copy).toEqual(raw);
		expect(existsSync(join(harness.directory, "mirrors", "escape"))).toBe(false);
		expect(harness.toasts.at(-1)?.variant).toBe("error");
	});
});

describe("experimental.chat.system.transform", () => {
	test("appends the protocol and records the model limits and system size", async () => {
		const harness = await load({ budget: 20_000 });
		const prompt = await system(harness.hooks, SESSION, ["You are the build agent."]);
		expect(prompt).toHaveLength(2);
		expect(prompt[1]).toContain("## Editable context");
		expect(prompt[1]).toContain(mirrorPath(harness));
		expect(prompt[1]).toContain("20,000 tokens");
	});

	test("helper agents and calls without a session get nothing", async () => {
		const { hooks } = await load();
		for (const first of ["You are a title generator. You output ONLY a thread title.", "You are a context summarization agent. ..."]) {
			expect(await system(hooks, SESSION, [first])).toEqual([first]);
		}
		expect(await system(hooks, undefined, ["agent generator"])).toEqual(["agent generator"]);
	});

	test("a session switched off gets no protocol", async () => {
		const { hooks } = await load();
		await command(hooks, STATUS_COMMAND, "off");
		expect(await system(hooks, SESSION, ["base"])).toEqual(["base"]);
	});
});

describe("compaction", () => {
	test("the compaction's transform neither renders nor notifies; a leftover flag is cleared", async () => {
		const harness = await load();
		await transform(harness.hooks, structuredClone(conversation()));
		const before = readFileSync(mirrorPath(harness), "utf8");
		await harness.hooks["experimental.session.compacting"]!({ sessionID: SESSION }, { context: [] });
		const head = structuredClone(conversation()).slice(0, 2);
		await transform(harness.hooks, head);
		expect(head.map((message) => message.info.id)).toEqual(["msg_u1", "msg_a1"]);
		expect(readFileSync(mirrorPath(harness), "utf8")).toBe(before);

		// A flag the compaction's transform never consumed must not swallow the next request.
		await harness.hooks["experimental.session.compacting"]!({ sessionID: SESSION }, { context: [] });
		await system(harness.hooks, SESSION, ["You are a context summarization agent."]);
		const longer = [...structuredClone(conversation()), assistant("msg_a3", "fresh output here")];
		await transform(harness.hooks, longer);
		expect(readFileSync(mirrorPath(harness), "utf8")).toContain("fresh output here");
	});

	test("the compacting hook adds the summary instruction; both completion signals mark the session", async () => {
		const harness = await load();
		await transform(harness.hooks, structuredClone(conversation()));
		const output = { context: [] as string[] };
		await harness.hooks["experimental.session.compacting"]!({ sessionID: SESSION }, output);
		expect(output.context).toHaveLength(1);
		expect(output.context[0]).toStartWith("CLM note for the summary:");

		// Each completion signal turns the next post-compaction transform into a quiet rebase.
		const signals = [
			(hooks: Hooks) => hooks.event!({ event: { type: "session.compacted", properties: { sessionID: SESSION } } as never }),
			(hooks: Hooks) => hooks["experimental.compaction.autocontinue"]!({ sessionID: SESSION } as never, { enabled: true }),
		];
		for (const signal of signals) {
			const run = await load();
			await transform(run.hooks, structuredClone(conversation()));
			const mirror = readFileSync(mirrorPath(run), "utf8");
			const id = /^\[\[CTX_TURN [^\n]* role=toolResult id=(\S+) /m.exec(mirror)![1]!;
			writeFileSync(mirrorPath(run), replaceBody(mirror, id, "[short]"));
			await transform(run.hooks, structuredClone(conversation()));
			await signal(run.hooks);
			const summary = assistant("msg_c2", "Summary of work.");
			summary.info.summary = true;
			const after = [user("msg_c1", "What did we do so far?"), summary];
			await transform(run.hooks, after);
			expect(after.map(partsText).join("\n")).not.toContain("dropped");
			const events = readFileSync(join(run.directory, "mirrors", `clm-${SESSION}`, "events.jsonl"), "utf8");
			expect(events).toContain('"event":"compacted"');
		}
	});
});

describe("tool.execute.after receipts", () => {
	test("a bash write to the mirror gets a verdict; reads and other tools do not", async () => {
		const harness = await load();
		const path = mirrorPath(harness);
		expect(await afterTool(harness.hooks, "bash", { command: `sed -i s/a/b/ ${path}` })).toBe("ok\n"); // no session yet
		await transform(harness.hooks, structuredClone(conversation()));
		const mirror = readFileSync(path, "utf8");
		const id = /^\[\[CTX_TURN [^\n]* role=toolResult id=(\S+) /m.exec(mirror)![1]!;
		writeFileSync(path, replaceBody(mirror, id, "[short]"));
		const accepted = await afterTool(harness.hooks, "bash", { command: `python3 edit.py > ${path}` });
		expect(accepted).toStartWith("ok\n\n[CLM] Mirror edit valid");
		expect(await afterTool(harness.hooks, "bash", { command: `grep -n CTX_TURN ${path}` })).toBe("ok\n");
		expect(await afterTool(harness.hooks, "bash", { command: "ls /tmp" })).toBe("ok\n");

		writeFileSync(path, mirror.replace(/^\[\[LIVE_CONTEXT [^\n]*/, "[[LIVE_CONTEXT broken]]"));
		expect(await afterTool(harness.hooks, "bash", { command: `sed -i x ${path}` }, "")).toStartWith("[CLM] Mirror edit would be refused");
	});
});

describe("command.execute.before", () => {
	test("/clm shows the status, /clm off and on switch the session, /clm reset drops the revision", async () => {
		const harness = await load();
		await transform(harness.hooks, structuredClone(conversation()));
		const status = await command(harness.hooks, STATUS_COMMAND);
		expect(status).toContain(`CLM status for session ${SESSION}`);
		expect(status).toContain("exactly as written");
		expect(harness.toasts.some((toast) => toast.message.includes("CLM status"))).toBe(true);
		expect(await command(harness.hooks, STATUS_COMMAND, "path")).toContain(mirrorPath(harness));

		expect(await command(harness.hooks, STATUS_COMMAND, "off")).toContain("CLM is off");
		const base = conversation();
		expect(await transform(harness.hooks, structuredClone(base))).toEqual(base); // raw history, no notes
		expect(await command(harness.hooks, STATUS_COMMAND, "on")).toContain("CLM is on");
		expect(await command(harness.hooks, STATUS_COMMAND, "reset")).toContain("dropped");
		expect(await command(harness.hooks, STATUS_COMMAND, "bogus")).toContain("Usage: /clm");
		expect(await command(harness.hooks, "other")).toBe("template");
	});

	test("/clm-compact sends the compaction prompt with the mirror path and the typed instructions", async () => {
		const harness = await load({ budget: 20_000 });
		await system(harness.hooks, SESSION, ["base"]);
		await transform(harness.hooks, structuredClone(conversation()));
		const prompt = await command(harness.hooks, COMPACT_COMMAND, "keep the test results");
		expect(prompt).toStartWith("Compact your live context now.");
		expect(prompt).toContain(mirrorPath(harness));
		expect(prompt).toContain("(budget 20,000)");
		expect(prompt).toContain("Also: keep the test results");
	});
});

describe("continuity tools", () => {
	test("annotations go to one store per session and ride as a user-role note", async () => {
		const harness = await load();
		const tools = harness.hooks.tool!;
		expect(Object.keys(tools).sort()).toEqual(["clm_annotate", "clm_recall"]);
		await transform(harness.hooks, structuredClone(conversation()));
		const mirror = readFileSync(mirrorPath(harness), "utf8");
		const id = /^\[\[CTX_TURN [^\n]* role=toolResult id=(\S+) /m.exec(mirror)![1]!;
		const created = await tools.clm_annotate!.execute(
			{ action: "create", source: id, title: "big output", reason: "needed", futureAction: "quote it", retention: "pin" } as never,
			toolContext(SESSION),
		);
		const annotationId = /lc-[0-9a-f]+/.exec(typeof created === "string" ? created : created.output)![0];
		expect(existsSync(join(harness.directory, "mirrors", `clm-${SESSION}`, "annotations.jsonl"))).toBe(true);

		const next = structuredClone(conversation());
		await transform(harness.hooks, next);
		const note = next.find((message) => partsText(message).includes("[CLM CONTINUITY"));
		expect(note?.info.role).toBe("user");
		expect(partsText(note)).toContain(annotationId);
		expect(next.indexOf(note!)).toBeGreaterThan(2); // after the conversation

		const recalled = await tools.clm_recall!.execute({ id: annotationId } as never, toolContext(SESSION));
		expect(typeof recalled === "string" ? recalled : recalled.output).toContain("big output");
		// Another session sees none of it.
		await expect(tools.clm_recall!.execute({ id: annotationId } as never, toolContext("ses_other"))).rejects.toThrow("does not exist");
	});

	test("session ids with a separator or .. are refused before any file is touched", async () => {
		const harness = await load();
		const tools = harness.hooks.tool!;
		for (const bad of ["../x", "a/b", "a\\b", "..", ""]) {
			expect(() => checkSessionID(bad)).toThrow("CLM refuses session id");
			await expect(tools.clm_annotate!.execute({ action: "list" } as never, toolContext(bad))).rejects.toThrow();
		}
		expect(checkSessionID("ses_ABC123")).toBe("ses_ABC123");
		expect(existsSync(join(harness.directory, "x"))).toBe(false);
	});
});

describe("tool.definition", () => {
	/** Calibration factor of the second request, whose predecessor the provider measured. */
	async function calibrationAfterMeasurement(defineTools: boolean): Promise<number> {
		const harness = await load();
		if (defineTools) {
			await harness.hooks["tool.definition"]!({ toolID: "bash" }, { description: "d".repeat(400), parameters: {} });
			await harness.hooks["tool.definition"]!({ toolID: "mcp_x" }, { description: "", parameters: {}, jsonSchema: { a: "b" } } as never);
		}
		await system(harness.hooks, SESSION, ["base"]);
		await transform(harness.hooks, structuredClone(conversation()));
		await transform(harness.hooks, [...structuredClone(conversation()), assistant("msg_a3", "measured", [], 100_000)]);
		const events = readFileSync(join(harness.directory, "mirrors", `clm-${SESSION}`, "events.jsonl"), "utf8")
			.trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.event === "request");
		return events.at(-1).calibration;
	}

	test("tool schema sizes complete the calibration scope; without them the estimator is not calibrated", async () => {
		expect(await calibrationAfterMeasurement(true)).toBeGreaterThan(1);
		expect(await calibrationAfterMeasurement(false)).toBe(1);
	});
});

describe("skills/clm-context/SKILL.md", () => {
	const skill = readFileSync(SKILL_FILE, "utf8");

	test("front matter names the skill and its trigger", () => {
		expect(skill).toStartWith("---\nname: clm-context\ndescription: ");
		expect(skill).toContain("clm_annotate");
		expect(skill).toContain("clm_recall");
		expect(skill).toContain("pi-clm");
	});

	const python = spawnSync("python3", ["--version"]).status === 0;
	test.skipIf(!python)("its scripts list headers and apply an edit the plugin accepts", async () => {
		const scripts = [...skill.matchAll(/```bash\npython3 - "<mirror path>" <<'PY'\n([\s\S]*?)\nPY\n```/g)].map((match) => match[1]!);
		expect(scripts).toHaveLength(2);
		const harness = await load();
		const path = mirrorPath(harness);
		const raw = conversation();
		await transform(harness.hooks, structuredClone(raw));
		const listing = spawnSync("python3", ["-", path], { input: scripts[0], encoding: "utf8" });
		expect(listing.status).toBe(0);
		const rows = listing.stdout.trim().split("\n").map((line) => line.split(" "));
		expect(rows.map((row) => row[1])).toEqual(["assistant", "toolResult", "toolResult", "assistant"]);

		const edit = scripts[1]!
			.replace('"<block id>": "[summary: what the command showed, exact values, what it means]"', `"${rows[1]![2]}": "[summary: big output, 400 x]"`)
			.replace('remove = ["<block id>"]', `remove = ["${rows[3]![2]}"]`);
		const applied = spawnSync("python3", ["-", path], { input: edit, encoding: "utf8" });
		expect(applied.stderr).toBe("");
		expect(await afterTool(harness.hooks, "bash", { command: `python3 - "${path}" <<'PY'\nopen(p, "w")\nPY` })).toContain("Mirror edit valid");
		const next = [...structuredClone(raw), assistant("msg_a3", "Next.")];
		await transform(harness.hooks, next);
		expect(partsText(next.at(-1))).toContain("Applied revision 1");
		expect(toolOutput(next[1], "call_1")).toBe("[summary: big output, 400 x]");
		expect(toolOutput(next[1], "call_2")).toBe("small output");
		expect(next.map((message) => message.info.id)).not.toContain("msg_a2");
	});
});

describe("fail open", () => {
	test("a throwing transform leaves OpenCode's array as built and toasts the error", async () => {
		const harness = await load();
		const original = ClmSession.prototype.transform;
		ClmSession.prototype.transform = () => Promise.reject(new Error("boom"));
		try {
			const base = conversation();
			const array = structuredClone(base);
			await transform(harness.hooks, array);
			expect(array).toEqual(base);
			expect(harness.toasts.at(-1)).toMatchObject({ variant: "error" });
			expect(harness.toasts.at(-1)!.message).toContain("boom");
		} finally {
			ClmSession.prototype.transform = original;
		}
	});

	test("a throwing receipt leaves the tool output untouched", async () => {
		const harness = await load();
		await transform(harness.hooks, structuredClone(conversation()));
		const original = ClmSession.prototype.receipt;
		ClmSession.prototype.receipt = () => {
			throw new Error("receipt boom");
		};
		try {
			expect(await afterTool(harness.hooks, "bash", { command: `sed -i x ${mirrorPath(harness)}` })).toBe("ok\n");
		} finally {
			ClmSession.prototype.receipt = original;
		}
		const events = readFileSync(join(harness.directory, "mirrors", `clm-${SESSION}`, "events.jsonl"), "utf8");
		expect(events).toContain("receipt boom");
	});

	test("/clm-compact with a missing template file reports the error instead of failing the command", async () => {
		const harness = await load({ compactPrompt: "/nonexistent/compact.md" });
		const text = await command(harness.hooks, COMPACT_COMMAND, "now");
		expect(text).toContain("[CLM] /clm-compact failed: compactPrompt: cannot read /nonexistent/compact.md");
		expect(harness.toasts.at(-1)?.variant).toBe("error");
	});

	test.skipIf(process.getuid?.() === 0)("/clm off whose state cannot be saved reports the error", async () => {
		const harness = await load();
		await transform(harness.hooks, structuredClone(conversation()));
		const directory = join(harness.directory, "mirrors", `clm-${SESSION}`);
		chmodSync(directory, 0o500);
		try {
			const text = await command(harness.hooks, STATUS_COMMAND, "off");
			expect(text).toContain("[CLM] /clm failed:");
			expect(harness.toasts.at(-1)?.variant).toBe("error");
		} finally {
			chmodSync(directory, 0o700);
		}
	});

	test("/clm for a refused session id reports the error", async () => {
		const harness = await load();
		expect(await command(harness.hooks, STATUS_COMMAND, "", "../x")).toContain("CLM refuses session id");
	});
});

describe("budget-too-small", () => {
	test("a budget below OpenCode's fixed overhead toasts one warning and /clm shows the overhead", async () => {
		const harness = await load({ budget: "12k" });
		await system(harness.hooks, SESSION, ["base"]);
		await transform(harness.hooks, structuredClone(conversation()));
		const measured = [...structuredClone(conversation()), assistant("msg_a3", "ok", [], 18_000)];
		await transform(harness.hooks, structuredClone(measured));
		await transform(harness.hooks, [...structuredClone(measured), assistant("msg_a4", "more", [], 18_500)]);
		await Bun.sleep(0);
		const warnings = harness.toasts.filter((toast) => toast.message.includes("is too small"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]!.variant).toBe("warning");
		const status = await command(harness.hooks, STATUS_COMMAND);
		expect(status).toContain("fixed overhead (system prompt + tool schemas)");
		expect(status).toContain("effective budget");
	});
});

describe("/clm config", () => {
	const overrides = (harness: Harness) =>
		JSON.parse(readFileSync(join(harness.directory, "mirrors", `clm-${SESSION}`, "overrides.json"), "utf8"));

	test("prints, shows, changes and resets settings; status lists the changes; on/off write the override", async () => {
		const harness = await load({ budget: "16k" });
		await transform(harness.hooks, structuredClone(conversation()));
		const page = await command(harness.hooks, STATUS_COMMAND, "config");
		expect(page).toContain("CLM settings for this session");
		expect(page).toMatch(/Budget +16k/);
		expect(await command(harness.hooks, STATUS_COMMAND, "config Overflow")).toContain("Overflow guard: on — ");
		expect(await command(harness.hooks, STATUS_COMMAND, "config budget 20k")).toContain("CLM Budget: 20k. It applies from the next request.");
		expect(await command(harness.hooks, STATUS_COMMAND, "config guard off")).toContain("CLM Overflow guard: off.");
		expect(overrides(harness)).toEqual({ version: 1, overrides: { budget: 20_000, guard: "off" } });
		expect(await command(harness.hooks, STATUS_COMMAND, "config budget lots")).toContain("[CLM] /clm failed: budget must be a number of tokens");
		expect(await command(harness.hooks, STATUS_COMMAND, "config bogus 1")).toContain('Unknown setting "bogus"');
		expect(await command(harness.hooks, STATUS_COMMAND)).toContain("Changed: budget 20k, guard off");

		expect(await command(harness.hooks, STATUS_COMMAND, "off")).toContain("CLM is off");
		expect(overrides(harness).overrides.editing).toBe(false);
		const base = conversation();
		expect(await transform(harness.hooks, structuredClone(base))).toEqual(base);
		expect(await command(harness.hooks, STATUS_COMMAND, "on")).toContain("CLM is on");
		expect(overrides(harness).overrides.editing).toBeUndefined();

		expect(await command(harness.hooks, STATUS_COMMAND, "config reset")).toContain("reset to the defaults");
		expect(overrides(harness)).toEqual({ version: 1, overrides: {} });
		expect(await command(harness.hooks, STATUS_COMMAND)).not.toContain("Changed:");
	});

	test("a steering override reaches this session's system prompt", async () => {
		const harness = await load();
		writeFileSync(join(harness.directory, "brief.md"), "BRIEF_TEXT");
		await transform(harness.hooks, structuredClone(conversation()));
		await command(harness.hooks, STATUS_COMMAND, `config steering ${join(harness.directory, "brief.md")}`);
		expect((await system(harness.hooks, SESSION, ["base"])).join("\n")).toContain("BRIEF_TEXT");
		expect((await system(harness.hooks, "ses_other", ["base"])).join("\n")).not.toContain("BRIEF_TEXT");
	});
});

describe("/clm pages as text", () => {
	test("overview, input, edits and settings print the panel page; no argument keeps the status", async () => {
		const harness = await load({ budget: "16k" });
		await transform(harness.hooks, structuredClone(conversation()));
		const overview = await command(harness.hooks, STATUS_COMMAND, "overview");
		expect(overview).toContain("CLM overview · r0");
		expect(overview).toContain("Context size · 1 request");
		expect(await command(harness.hooks, STATUS_COMMAND, "input")).toContain("Current input");
		expect(await command(harness.hooks, STATUS_COMMAND, "edits")).toContain("CLM edits");
		const settingsPage = await command(harness.hooks, STATUS_COMMAND, "Settings");
		expect(settingsPage).toMatch(/Budget +16k/);
		expect(await command(harness.hooks, STATUS_COMMAND)).toContain(`CLM status for session ${SESSION}`);
	});
});
