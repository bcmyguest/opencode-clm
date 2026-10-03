// TUI-side helpers around the channel (src/channel.ts) that need no opentui: the per-session
// `locate` cache and `/clm reset` with its fallback. Written for this package.

import { ChannelTimeout, LOCATE_TIMEOUT_MS, type ChannelOperation, type ChannelReply } from "../channel.ts";

export interface Location {
	directory: string;
	root: string;
}

/** How long a failed `locate` (no answering server plugin) is remembered. */
export const LOCATE_RETRY_MS = 60_000;
/** How long a `locate` answer is trusted (a restarted server may use another mirrorDir). */
export const LOCATE_TTL_MS = 5 * 60_000;

export interface Locator {
	/** The cached answer, or a new `locate` (short timeout); undefined when the server did not answer. */
	locate(sessionID: string): Promise<Location | undefined>;
	/** The cached answer if still fresh, without asking. */
	fresh(sessionID: string): Location | undefined;
	/** Drop the cached answer (reading through it failed). */
	forget(sessionID: string): void;
	/** `locate` in the background, once at a time per session; `onAnswer` gets a new answer. */
	relocate(sessionID: string, onAnswer: (location: Location) => void): void;
}

export function createLocator(deps: {
	ask(sessionID: string, operation: ChannelOperation, timeoutMs?: number): Promise<ChannelReply>;
	now?: () => number;
	ttlMs?: number;
	retryMs?: number;
}): Locator {
	const now = deps.now ?? Date.now;
	const ttl = deps.ttlMs ?? LOCATE_TTL_MS;
	const retry = deps.retryMs ?? LOCATE_RETRY_MS;
	const cache = new Map<string, { at: number; value?: Location }>();
	const running = new Set<string>();
	const entry = (sessionID: string) => {
		const known = cache.get(sessionID);
		if (!known) return undefined;
		return now() - known.at < (known.value ? ttl : retry) ? known : undefined;
	};
	const locate = async (sessionID: string): Promise<Location | undefined> => {
		const known = entry(sessionID);
		if (known) return known.value;
		let value: Location | undefined;
		try {
			const reply = await deps.ask(sessionID, { op: "locate" }, LOCATE_TIMEOUT_MS);
			if (reply.directory && reply.root) value = { directory: reply.directory, root: reply.root };
		} catch {
			value = undefined;
		}
		cache.set(sessionID, { at: now(), ...(value ? { value } : {}) });
		return value;
	};
	return {
		locate,
		fresh: (sessionID) => entry(sessionID)?.value,
		forget: (sessionID) => {
			cache.delete(sessionID);
		},
		relocate(sessionID, onAnswer) {
			if (running.has(sessionID)) return;
			running.add(sessionID);
			void locate(sessionID)
				.then((value) => {
					if (value) onAnswer(value);
				})
				.finally(() => running.delete(sessionID));
		},
	};
}

/**
 * `/clm reset` from the TUI: over the channel (no model turn). When the server plugin does not
 * answer (not loaded there, an older version, or CLM disabled), fall back to the server
 * command, as before the channel: it costs one model turn, and the toast says so.
 */
export async function resetSession(deps: {
	sessionID: string;
	ask(sessionID: string, operation: ChannelOperation): Promise<ChannelReply>;
	/** `api.client.session.command`, flat v2 parameters. */
	command(parameters: { sessionID: string; command: string; arguments: string }): Promise<{ error?: unknown } | undefined>;
	toast(message: string, variant?: "info" | "warning"): void;
}): Promise<"channel" | "command"> {
	try {
		await deps.ask(deps.sessionID, { op: "reset" });
		return "channel";
	} catch (error) {
		if (!(error instanceof ChannelTimeout)) throw error;
		deps.toast(`${error.message}. Sent /clm reset as a command instead; it costs one model turn.`, "warning");
		// The command runs a model turn; do not wait for it.
		void Promise.resolve()
			.then(() => deps.command({ sessionID: deps.sessionID, command: "clm", arguments: "reset" }))
			.then((result) => {
				if (result?.error !== undefined) deps.toast(`/clm reset failed: ${JSON.stringify(result.error)}`, "warning");
			})
			.catch((failure: unknown) => deps.toast(`/clm reset failed: ${failure instanceof Error ? failure.message : String(failure)}`, "warning"));
		return "command";
	}
}
