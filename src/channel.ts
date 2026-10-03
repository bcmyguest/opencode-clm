// The turn-free channel between the TUI plugin and the server plugin. Both sides speak
// through OpenCode's `tui.command.execute` bus event: `POST /tui/publish` accepts any
// command string, the server publishes it on the instance bus, and every listener sees it:
// the server plugin's `event` hook, each TUI's own `api.event` and the TUI app, which
// dispatches the string as a keymap command (an unknown name is a no-op). Requests and
// replies are prefixed, base64url-encoded JSON, so they carry no spaces and never collide
// with a real keymap command. Written for this package. Verified against opencode 1.18.34:
// publish handler server/routes/instance/httpapi/handlers/tui.ts:84-93; command schema
// packages/schema/src/tui-event.ts:13-37; plugin `event` hook plugin/index.ts:255-260 (events
// of the plugin's own directory only); TUI app dispatch packages/tui/src/app.tsx:987-990.

/** `tui.command.execute` event type (opencode packages/schema/src/tui-event.ts). */
export const COMMAND_EVENT = "tui.command.execute";
export const REQUEST_PREFIX = "opencode-clm.request:";
export const REPLY_PREFIX = "opencode-clm.reply:";
export const CHANNEL_VERSION = 1;

export type ChannelOperation =
	/** Where the server keeps the session's files. Answer: `directory` and `root`. */
	| { op: "locate" }
	/** `/clm config <setting> <value>`, `/clm on|off` and the panel's apply. */
	| { op: "set"; setting: string; value: string }
	/** `/clm config reset`. */
	| { op: "settings-reset" }
	/** `/clm reset`: drop the accepted revision. */
	| { op: "reset" }
	/** A file of the session directory (`path` relative to it). Answer: `content`, absent when missing. */
	| { op: "read"; path: string }
	/** A directory of the session directory (`""` = itself). Answer: `names`, absent when missing. */
	| { op: "list"; path: string };

/** Largest file a `read` reply carries; replies travel on the instance bus to every client. */
export const MAX_READ_BYTES = 4 * 1024 * 1024;

export type ChannelRequest = ChannelOperation & { v: typeof CHANNEL_VERSION; id: string; session: string };

export interface ChannelReply {
	v: typeof CHANNEL_VERSION;
	id: string;
	ok: boolean;
	/** User-facing result or error. */
	text: string;
	/** `locate`: the session directory on the server. */
	directory?: string;
	/** `locate`: the server's instance directory, the root `file.read` paths are relative to. */
	root?: string;
	/** `read`: the file text. */
	content?: string;
	/** `list`: the entry names. */
	names?: string[];
}

function encode(prefix: string, value: unknown): string {
	return prefix + Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(prefix: string, command: unknown): Record<string, unknown> | undefined {
	if (typeof command !== "string" || !command.startsWith(prefix)) return undefined;
	try {
		const value: unknown = JSON.parse(Buffer.from(command.slice(prefix.length), "base64url").toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		if (record.v !== CHANNEL_VERSION || typeof record.id !== "string" || record.id === "") return undefined;
		return record;
	} catch {
		return undefined;
	}
}

export function encodeRequest(request: ChannelRequest): string {
	return encode(REQUEST_PREFIX, request);
}

/** The request in a command string; undefined for anything else (foreign or malformed). */
export function decodeRequest(command: unknown): ChannelRequest | undefined {
	const record = decode(REQUEST_PREFIX, command);
	if (!record || typeof record.session !== "string" || record.session === "") return undefined;
	switch (record.op) {
		case "locate":
		case "settings-reset":
		case "reset":
			return { v: CHANNEL_VERSION, id: record.id as string, session: record.session, op: record.op };
		case "read":
		case "list":
			if (typeof record.path !== "string") return undefined;
			return { v: CHANNEL_VERSION, id: record.id as string, session: record.session, op: record.op, path: record.path };
		case "set":
			if (typeof record.setting !== "string" || typeof record.value !== "string") return undefined;
			return { v: CHANNEL_VERSION, id: record.id as string, session: record.session, op: "set", setting: record.setting, value: record.value };
		default:
			return undefined;
	}
}

export function encodeReply(reply: ChannelReply): string {
	return encode(REPLY_PREFIX, reply);
}

export function decodeReply(command: unknown): ChannelReply | undefined {
	const record = decode(REPLY_PREFIX, command);
	if (!record || typeof record.ok !== "boolean" || typeof record.text !== "string") return undefined;
	return {
		v: CHANNEL_VERSION,
		id: record.id as string,
		ok: record.ok,
		text: record.text,
		...(typeof record.directory === "string" ? { directory: record.directory } : {}),
		...(typeof record.root === "string" ? { root: record.root } : {}),
		...(typeof record.content === "string" ? { content: record.content } : {}),
		...(Array.isArray(record.names) && record.names.every((name) => typeof name === "string") ? { names: record.names as string[] } : {}),
	};
}

/** The command string of a `tui.command.execute` event, if the value is one. */
export function commandOf(event: unknown): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const { type, properties } = event as { type?: unknown; properties?: { command?: unknown } };
	if (type !== COMMAND_EVENT) return undefined;
	return typeof properties?.command === "string" ? properties.command : undefined;
}

/** The TUI side: send a request, wait for the reply with the same id. */
export interface ChannelClientDeps {
	/** Publishes a `tui.command.execute` event with this command string. */
	publish(command: string): Promise<void>;
	/** Subscribes to `tui.command.execute` command strings; returns the unsubscribe. */
	subscribe(handler: (command: string) => void): () => void;
	timeoutMs?: number;
	/** Request ids; random by default. */
	newId?: () => string;
}

export interface ChannelClient {
	/** `timeoutMs` overrides the client's default for this request. */
	request(session: string, operation: ChannelOperation, timeoutMs?: number): Promise<ChannelReply>;
	dispose(): void;
}

export class ChannelTimeout extends Error {
	constructor(readonly timeoutMs: number) {
		super(
			`the opencode-clm server plugin did not answer within ${Math.round(timeoutMs / 100) / 10} s: the server does not load ` +
				"opencode-clm, loads an older version without the TUI channel, or has CLM disabled (enabled: false)",
		);
	}
}

export const CHANNEL_TIMEOUT_MS = 5_000;
/** `locate` is asked on panel loads; a short wait keeps a missing server plugin from stalling them. */
export const LOCATE_TIMEOUT_MS = 1_000;

export function createChannelClient(deps: ChannelClientDeps): ChannelClient {
	const pending = new Map<string, (reply: ChannelReply) => void>();
	const unsubscribe = deps.subscribe((command) => {
		const reply = decodeReply(command);
		if (!reply) return;
		pending.get(reply.id)?.(reply);
	});
	const newId = deps.newId ?? (() => crypto.randomUUID());
	const defaultTimeoutMs = deps.timeoutMs ?? CHANNEL_TIMEOUT_MS;
	return {
		request(session, operation, timeoutMs = defaultTimeoutMs) {
			const id = newId();
			const request = { ...operation, v: CHANNEL_VERSION, id, session } as ChannelRequest;
			return new Promise<ChannelReply>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new ChannelTimeout(timeoutMs));
				}, timeoutMs);
				pending.set(id, (reply) => {
					clearTimeout(timer);
					pending.delete(id);
					resolve(reply);
				});
				deps.publish(encodeRequest(request)).catch((error: unknown) => {
					clearTimeout(timer);
					pending.delete(id);
					reject(error instanceof Error ? error : new Error(String(error)));
				});
			});
		},
		dispose() {
			unsubscribe();
			pending.clear();
		},
	};
}
