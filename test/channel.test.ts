// The turn-free TUI ↔ server channel: message encoding (src/channel.ts) and the server
// plugin's handler for it (index.ts `event` hook), driven as opencode 1.18.34 delivers bus events.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import { server } from "../index.ts";
import {
	ChannelTimeout,
	COMMAND_EVENT,
	commandOf,
	createChannelClient,
	decodeReply,
	decodeRequest,
	encodeReply,
	encodeRequest,
	REQUEST_PREFIX,
	type ChannelOperation,
	type ChannelReply,
	type ChannelRequest,
} from "../src/channel.ts";
import { assistant, conversation, SESSION, tempDir } from "./fixtures.ts";

describe("channel messages", () => {
	test("requests and replies round-trip and carry no whitespace", () => {
		const requests: ChannelRequest[] = [
			{ v: 1, id: "a", session: SESSION, op: "locate" },
			{ v: 1, id: "b", session: SESSION, op: "set", setting: "budget", value: "20k with spaces" },
			{ v: 1, id: "c", session: SESSION, op: "settings-reset" },
			{ v: 1, id: "d", session: SESSION, op: "reset" },
			{ v: 1, id: "e", session: SESSION, op: "read", path: "revisions/r1.json" },
			{ v: 1, id: "f", session: SESSION, op: "list", path: "" },
		];
		for (const request of requests) {
			const command = encodeRequest(request);
			expect(command).toStartWith(REQUEST_PREFIX);
			expect(command).not.toMatch(/\s/);
			expect(decodeRequest(command)).toEqual(request);
			expect(decodeReply(command)).toBeUndefined();
		}
		const reply: ChannelReply = { v: 1, id: "a", ok: true, text: "", directory: "/p/.opencode/clm/clm-x", root: "/p" };
		expect(decodeReply(encodeReply(reply))).toEqual(reply);
		const content: ChannelReply = { v: 1, id: "b", ok: true, text: "", content: "{\"a\": 1}\n", names: ["r1.json"] };
		expect(decodeReply(encodeReply(content))).toEqual(content);
		expect(decodeRequest(encodeReply(reply))).toBeUndefined();
	});

	test("foreign and malformed commands decode to nothing", () => {
		for (const command of ["session.list", "", REQUEST_PREFIX, `${REQUEST_PREFIX}!!`, `${REQUEST_PREFIX}${Buffer.from("[1]").toString("base64url")}`, undefined, 42]) {
			expect(decodeRequest(command)).toBeUndefined();
		}
		const encoded = (value: unknown) => REQUEST_PREFIX + Buffer.from(JSON.stringify(value)).toString("base64url");
		expect(decodeRequest(encoded({ v: 2, id: "a", session: SESSION, op: "reset" }))).toBeUndefined();
		expect(decodeRequest(encoded({ v: 1, id: "a", session: SESSION, op: "delete" }))).toBeUndefined();
		expect(decodeRequest(encoded({ v: 1, id: "a", session: SESSION, op: "set", setting: "budget" }))).toBeUndefined();
		expect(decodeRequest(encoded({ v: 1, id: "", session: SESSION, op: "reset" }))).toBeUndefined();
		expect(decodeRequest(encoded({ v: 1, id: "a", op: "reset" }))).toBeUndefined();
		expect(commandOf({ type: COMMAND_EVENT, properties: { command: "x" } })).toBe("x");
		expect(commandOf({ type: "session.idle", properties: { command: "x" } })).toBeUndefined();
	});

	test("the client matches replies by id and times out", async () => {
		let listener: (command: string) => void = () => undefined;
		const sent: string[] = [];
		let next = 0;
		const client = createChannelClient({
			publish: async (command) => { sent.push(command); },
			subscribe: (handler) => { listener = handler; return () => { listener = () => undefined; }; },
			newId: () => `id${++next}`,
			timeoutMs: 50,
		});
		const pending = client.request(SESSION, { op: "reset" });
		expect(decodeRequest(sent[0])).toEqual({ v: 1, id: "id1", session: SESSION, op: "reset" });
		listener(encodeReply({ v: 1, id: "other", ok: false, text: "not mine" }));
		listener("session.list");
		listener(encodeReply({ v: 1, id: "id1", ok: true, text: "done" }));
		expect(await pending).toEqual({ v: 1, id: "id1", ok: true, text: "done" });
		await expect(client.request(SESSION, { op: "locate" })).rejects.toBeInstanceOf(ChannelTimeout);
		client.dispose();
	});

	test("a failed publish rejects at once", async () => {
		const client = createChannelClient({ publish: async () => { throw new Error("offline"); }, subscribe: () => () => undefined, timeoutMs: 10_000 });
		await expect(client.request(SESSION, { op: "reset" })).rejects.toThrow("offline");
	});
});

interface Harness {
	hooks: Hooks;
	directory: string;
	mirror: string;
	toasts: string[];
	replies: ChannelReply[];
	published: string[];
}

async function load(knownSessions: string[] = [SESSION]): Promise<Harness> {
	const directory = tempDir("clm-channel-");
	const mirror = join(directory, "mirrors");
	const harness: Harness = { hooks: {} as Hooks, directory, mirror, toasts: [], replies: [], published: [] };
	const input = {
		directory,
		worktree: directory,
		client: {
			tui: {
				showToast: async ({ body }: { body: { message: string } }) => harness.toasts.push(body.message),
				publish: async ({ body }: { body: { type: string; properties: { command: string } } }) => {
					harness.published.push(body.properties.command);
					const reply = decodeReply(body.properties.command);
					if (reply) harness.replies.push(reply);
				},
			},
			app: { log: async () => undefined },
			session: {
				get: async ({ path }: { path: { id: string } }) =>
					knownSessions.includes(path.id) ? { data: { id: path.id } } : { error: { name: "NotFoundError" } },
			},
		},
	} as unknown as PluginInput;
	harness.hooks = await server(input, { mirrorDir: mirror });
	return harness;
}

async function send(harness: Harness, request: (ChannelOperation & { id: string; session: string }) | string): Promise<void> {
	const command = typeof request === "string" ? request : encodeRequest({ ...request, v: 1 } as ChannelRequest);
	await harness.hooks.event!({ event: { type: COMMAND_EVENT, properties: { command } } as never });
	// The reply is published on a later microtask.
	await Bun.sleep(5);
}

const overrides = (harness: Harness, sessionID = SESSION) => {
	const path = join(harness.mirror, `clm-${sessionID}`, "overrides.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
};

describe("server channel handler", () => {
	test("locate names the session directory and the server root", async () => {
		const h = await load();
		await send(h, { id: "1", session: SESSION, op: "locate" });
		expect(h.replies).toEqual([{ v: 1, id: "1", ok: true, text: "", directory: join(h.mirror, `clm-${SESSION}`), root: h.directory }]);
	});

	test("set validates, writes overrides.json and confirms with a toast", async () => {
		const h = await load();
		await send(h, { id: "1", session: SESSION, op: "set", setting: "budget", value: "20k" });
		expect(h.replies).toEqual([{ v: 1, id: "1", ok: true, text: "Budget: 20k" }]);
		expect(overrides(h)).toEqual({ version: 1, overrides: { budget: 20_000 } });
		expect(h.toasts).toContain("CLM Budget: 20k.");

		await send(h, { id: "2", session: SESSION, op: "set", setting: "budget", value: "lots" });
		expect(h.replies[1]).toMatchObject({ id: "2", ok: false });
		expect(overrides(h)).toEqual({ version: 1, overrides: { budget: 20_000 } });

		await send(h, { id: "3", session: SESSION, op: "settings-reset" });
		expect(h.replies[2]).toMatchObject({ id: "3", ok: true });
		expect(overrides(h)).toEqual({ version: 1, overrides: {} });
	});

	test("reset drops the accepted revision", async () => {
		const h = await load();
		// One request so the session has state to reset.
		const messages = conversation();
		messages.push(assistant("a9", "done"));
		const output = { messages } as never;
		await h.hooks["experimental.chat.messages.transform"]!({}, output);
		await send(h, { id: "1", session: SESSION, op: "reset" });
		expect(h.replies).toEqual([{ v: 1, id: "1", ok: true, text: "CLM revision dropped" }]);
		const state = JSON.parse(readFileSync(join(h.mirror, `clm-${SESSION}`, "state.json"), "utf8"));
		expect(state.lastOutcome).toMatchObject({ kind: "reset", message: "/clm reset" });
		expect(h.toasts).toContain("CLM revision dropped");
	});

	test("read and list answer from the session directory only", async () => {
		const h = await load();
		await send(h, { id: "0", session: SESSION, op: "set", setting: "budget", value: "20k" });
		await send(h, { id: "1", session: SESSION, op: "list", path: "" });
		await send(h, { id: "2", session: SESSION, op: "read", path: "overrides.json" });
		await send(h, { id: "3", session: SESSION, op: "read", path: "missing.json" });
		await send(h, { id: "4", session: SESSION, op: "list", path: "revisions" });
		await send(h, { id: "5", session: SESSION, op: "read", path: "../../opencode.json" });
		await send(h, { id: "6", session: SESSION, op: "read", path: "/etc/hostname" });
		const byId = Object.fromEntries(h.replies.map((reply) => [reply.id, reply]));
		expect(byId["1"]!.names).toContain("overrides.json");
		expect(JSON.parse(byId["2"]!.content!)).toEqual({ version: 1, overrides: { budget: 20_000 } });
		expect(byId["3"]).toEqual({ v: 1, id: "3", ok: true, text: "" });
		expect(byId["4"]).toEqual({ v: 1, id: "4", ok: true, text: "" });
		expect([byId["5"]!.ok, byId["6"]!.ok]).toEqual([false, false]);
		expect(byId["5"]!.text).toContain("outside the session directory");
	});

	test("ignores foreign commands and refuses foreign sessions", async () => {
		const h = await load();
		await send(h, "session.list");
		await send(h, encodeReply({ v: 1, id: "1", ok: true, text: "echo" }));
		await send(h, `${REQUEST_PREFIX}garbage`);
		expect(h.published).toEqual([]);

		await send(h, { id: "2", session: "ses_elsewhere", op: "set", setting: "budget", value: "20k" });
		await send(h, { id: "3", session: "ses_elsewhere", op: "reset" });
		await send(h, { id: "4", session: "../escape", op: "reset" });
		expect(h.replies.map((reply) => [reply.id, reply.ok])).toEqual([["2", false], ["3", false], ["4", false]]);
		expect(existsSync(join(h.mirror, "clm-ses_elsewhere"))).toBe(false);
		expect(overrides(h)).toBeUndefined();
	});
});
