// The TUI's Enter intercept for typed `/clm …` lines: handled in the TUI with no model turn,
// except `/clm reset` (the server owns state.json). Host-free so it can be unit-tested with
// a fake key context and focused prompt. Written for this package.

import { parseClmCommand, type ClmCommand } from "../panel/command.ts";

/** The parts of the host's key-intercept context this uses. */
export interface InterceptContext {
	event: { name?: string; shift?: boolean; ctrl?: boolean; meta?: boolean };
	consume(): void;
}

/** The focused prompt: host internals (textarea `plainText` / `setText`), checked at runtime. */
export interface FocusedPrompt {
	plainText?: unknown;
	setText?: (text: string) => void;
}

export interface InterceptDeps {
	focused(): FocusedPrompt | null | undefined;
	/** False when `/clm` is not this package's to handle (`commands: false`, or a user-defined `/clm`). */
	owned(): boolean;
	/** Runs a command the TUI handles. */
	handle(command: Exclude<ClmCommand, { kind: "server" }>): Promise<void>;
	/** Shows an error from `handle`. */
	report(message: string): void;
}

/**
 * Called for every key. Consumes Enter (no modifiers) on a `/clm …` prompt line the TUI
 * handles; everything else passes through untouched: other text, `/clm-compact`, `/clm
 * reset`, modified Enter, a prompt without the expected internals, and every `/clm` line
 * when the command belongs to someone else. A usage error keeps the typed text so it can be
 * fixed. Returns the command handled, for tests.
 */
export function interceptEnter(context: InterceptContext, deps: InterceptDeps): ClmCommand | undefined {
	const event = context.event;
	if (event.name !== "return" || event.shift || event.ctrl || event.meta) return undefined;
	const focused = deps.focused();
	if (!focused || typeof focused.plainText !== "string" || typeof focused.setText !== "function") return undefined;
	const command = parseClmCommand(focused.plainText);
	if (!command || command.kind === "server") return undefined;
	// A throw here would land in the host's key handling: fail open, let the line through.
	let owned: boolean;
	try {
		owned = deps.owned();
	} catch (error) {
		deps.report(`CLM: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	if (!owned) return undefined;
	context.consume();
	if (command.kind !== "usage") focused.setText("");
	void Promise.resolve().then(() => deps.handle(command)).catch((error: unknown) => deps.report(`CLM: ${error instanceof Error ? error.message : String(error)}`));
	return command;
}
