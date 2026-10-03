// TUI helpers around the channel (src/tui/locator.ts) and the channel client's timeouts.
import { describe, expect, test } from "bun:test";

import { ChannelTimeout, createChannelClient, LOCATE_TIMEOUT_MS, type ChannelOperation, type ChannelReply } from "../../src/channel.ts";
import { createLocator, LOCATE_RETRY_MS, LOCATE_TTL_MS, resetSession } from "../../src/tui/locator.ts";

const SESSION = "ses_tui";
const HERE = { directory: "/srv/p/.opencode/clm/clm-ses_tui", root: "/srv/p" };

function fakeAsk(answers: Array<ChannelReply | Error>) {
	const calls: Array<{ op: string; timeoutMs?: number }> = [];
	const ask = async (_session: string, operation: ChannelOperation, timeoutMs?: number) => {
		calls.push({ op: operation.op, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
		const next = answers.shift();
		if (!next || next instanceof Error) throw next ?? new Error("no answer");
		return next;
	};
	return { ask, calls };
}

const located = (value = HERE): ChannelReply => ({ v: 1, id: "x", ok: true, text: "", ...value });

describe("locate cache", () => {
	test("an answer is reused until its TTL, with the short locate timeout", async () => {
		let now = 0;
		const { ask, calls } = fakeAsk([located(), located({ directory: "/elsewhere/clm-ses_tui", root: "/srv/p" })]);
		const locator = createLocator({ ask, now: () => now });
		expect(await locator.locate(SESSION)).toEqual(HERE);
		now = LOCATE_TTL_MS - 1;
		expect(await locator.locate(SESSION)).toEqual(HERE);
		expect(calls).toEqual([{ op: "locate", timeoutMs: LOCATE_TIMEOUT_MS }]);
		now = LOCATE_TTL_MS;
		expect(locator.fresh(SESSION)).toBeUndefined();
		expect((await locator.locate(SESSION))?.directory).toBe("/elsewhere/clm-ses_tui");
	});

	test("a failure is retried after the retry interval; forget re-asks at once", async () => {
		let now = 0;
		const { ask, calls } = fakeAsk([new ChannelTimeout(1000), located(), located()]);
		const locator = createLocator({ ask, now: () => now });
		expect(await locator.locate(SESSION)).toBeUndefined();
		expect(await locator.locate(SESSION)).toBeUndefined();
		expect(calls).toHaveLength(1);
		now = LOCATE_RETRY_MS;
		expect(await locator.locate(SESSION)).toEqual(HERE);
		locator.forget(SESSION);
		expect(locator.fresh(SESSION)).toBeUndefined();
		expect(await locator.locate(SESSION)).toEqual(HERE);
		expect(calls).toHaveLength(3);
	});

	test("relocate runs once at a time and reports the answer", async () => {
		const { ask, calls } = fakeAsk([located()]);
		const locator = createLocator({ ask });
		const answers: unknown[] = [];
		locator.relocate(SESSION, (value) => answers.push(value));
		locator.relocate(SESSION, (value) => answers.push(value));
		await Bun.sleep(5);
		expect(calls).toHaveLength(1);
		expect(answers).toEqual([HERE]);
		expect(locator.fresh(SESSION)).toEqual(HERE);
	});
});

describe("/clm reset from the TUI", () => {
	const deps = (ask: (s: string, o: ChannelOperation) => Promise<ChannelReply>) => {
		const toasts: string[] = [];
		const commands: unknown[] = [];
		return {
			toasts,
			commands,
			deps: {
				sessionID: SESSION,
				ask,
				command: async (parameters: unknown) => {
					commands.push(parameters);
					return {};
				},
				toast: (message: string) => toasts.push(message),
			},
		};
	};

	test("over the channel: no command", async () => {
		const h = deps(async () => ({ v: 1, id: "x", ok: true, text: "CLM revision dropped" }));
		expect(await resetSession(h.deps)).toBe("channel");
		expect([h.commands, h.toasts]).toEqual([[], []]);
	});

	test("no answer: falls back to the server command and says it costs a turn", async () => {
		const h = deps(async () => { throw new ChannelTimeout(5000); });
		expect(await resetSession(h.deps)).toBe("command");
		await Bun.sleep(5);
		expect(h.commands).toEqual([{ sessionID: SESSION, command: "clm", arguments: "reset" }]);
		expect(h.toasts[0]).toContain("costs one model turn");
		expect(h.toasts[0]).toContain("CLM disabled");
		expect(h.toasts[0]).toContain("does not load opencode-clm");
	});

	test("a refusal from the server is not retried as a command", async () => {
		const h = deps(async () => { throw new Error("no session ses_tui on this server"); });
		await expect(resetSession(h.deps)).rejects.toThrow("no session");
		expect(h.commands).toEqual([]);
	});

	test("a failing fallback command is reported", async () => {
		const h = deps(async () => { throw new ChannelTimeout(5000); });
		h.deps.command = async () => ({ error: { name: "NotFound" } });
		await resetSession(h.deps);
		await Bun.sleep(5);
		expect(h.toasts[1]).toContain("/clm reset failed");
	});
});

describe("channel client timeouts", () => {
	test("a request can use a shorter timeout than the client's default", async () => {
		const client = createChannelClient({ publish: async () => undefined, subscribe: () => () => undefined, timeoutMs: 10_000 });
		const started = performance.now();
		await expect(client.request(SESSION, { op: "locate" }, 20)).rejects.toBeInstanceOf(ChannelTimeout);
		expect(performance.now() - started).toBeLessThan(2_000);
		client.dispose();
	});

	test("the timeout names every cause", () => {
		const message = new ChannelTimeout(5000).message;
		expect(message).toContain("5 s");
		expect(message).toContain("does not load opencode-clm");
		expect(message).toContain("older version");
		expect(message).toContain("enabled: false");
	});
});
