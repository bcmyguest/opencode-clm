// Server side of the channel (index.ts): symlinks cannot lead a read out of the session
// directory, large files are refused, and confirmed session ids are not asked for again.
import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import { server } from "../index.ts";
import { COMMAND_EVENT, decodeReply, encodeRequest, MAX_READ_BYTES, type ChannelOperation, type ChannelReply, type ChannelRequest } from "../src/channel.ts";
import { SESSION, tempDir } from "./fixtures.ts";

async function load() {
	const directory = tempDir("clm-channel-guard-");
	const mirror = join(directory, "mirrors");
	const replies: ChannelReply[] = [];
	let gets = 0;
	const input = {
		directory,
		worktree: directory,
		client: {
			tui: {
				showToast: async () => undefined,
				publish: async ({ body }: { body: { properties: { command: string } } }) => {
					const reply = decodeReply(body.properties.command);
					if (reply) replies.push(reply);
				},
			},
			app: { log: async () => undefined },
			session: {
				get: async ({ path }: { path: { id: string } }) => {
					gets++;
					return path.id === SESSION ? { data: { id: path.id } } : { error: { name: "NotFoundError" } };
				},
			},
		},
	} as unknown as PluginInput;
	const hooks: Hooks = await server(input, { mirrorDir: mirror });
	const sessionDir = join(mirror, `clm-${SESSION}`);
	mkdirSync(sessionDir, { recursive: true });
	const send = async (id: string, operation: ChannelOperation, session = SESSION) => {
		const command = encodeRequest({ ...operation, v: 1, id, session } as ChannelRequest);
		await hooks.event!({ event: { type: COMMAND_EVENT, properties: { command } } as never });
		await Bun.sleep(5);
		return replies.find((reply) => reply.id === id)!;
	};
	return { directory, sessionDir, send, gets: () => gets };
}

describe("channel read guard", () => {
	test("a symlink in the session directory cannot reach a file outside it", async () => {
		const h = await load();
		const secret = join(h.directory, "secret.txt");
		writeFileSync(secret, "SECRET");
		symlinkSync(secret, join(h.sessionDir, "link.json"));
		symlinkSync(h.directory, join(h.sessionDir, "linkdir"));
		const read = await h.send("1", { op: "read", path: "link.json" });
		expect(read.ok).toBe(false);
		expect(read.text).toContain("outside the session directory");
		expect(read.content).toBeUndefined();
		const list = await h.send("2", { op: "list", path: "linkdir" });
		expect([list.ok, list.names]).toEqual([false, undefined]);
		// A link that stays inside is fine.
		writeFileSync(join(h.sessionDir, "state.json"), "{}");
		symlinkSync(join(h.sessionDir, "state.json"), join(h.sessionDir, "alias.json"));
		expect(await h.send("3", { op: "read", path: "alias.json" })).toMatchObject({ ok: true, content: "{}" });
		// A dangling link reads as missing.
		symlinkSync(join(h.sessionDir, "gone.json"), join(h.sessionDir, "dangling.json"));
		expect(await h.send("4", { op: "read", path: "dangling.json" })).toEqual({ v: 1, id: "4", ok: true, text: "" });
	});

	test("a file over the reply cap is refused, not sent", async () => {
		const h = await load();
		writeFileSync(join(h.sessionDir, "events.jsonl"), "x".repeat(MAX_READ_BYTES + 1));
		const reply = await h.send("1", { op: "read", path: "events.jsonl" });
		expect(reply.ok).toBe(false);
		expect(reply.text).toContain(`${MAX_READ_BYTES + 1} bytes`);
		expect(reply.content).toBeUndefined();
		writeFileSync(join(h.sessionDir, "events.jsonl"), "x".repeat(MAX_READ_BYTES));
		expect((await h.send("2", { op: "read", path: "events.jsonl" })).content).toHaveLength(MAX_READ_BYTES);
	});

	test("a confirmed session id is not looked up again; an unknown one is, every time", async () => {
		const h = await load();
		for (const id of ["1", "2", "3"]) expect((await h.send(id, { op: "list", path: "" })).ok).toBe(true);
		expect(h.gets()).toBe(1);
		await h.send("4", { op: "locate" }, "ses_other");
		await h.send("5", { op: "locate" }, "ses_other");
		expect(h.gets()).toBe(3);
	});
});
