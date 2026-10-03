// The slash commands the server plugin defines, shared with the TUI so its Enter intercept
// can tell this package's `/clm` from a user's own. Written for this package.

export const STATUS_COMMAND = "clm";
export const COMPACT_COMMAND = "clm-compact";
export const STATUS_TEMPLATE = "Show the CLM status. $ARGUMENTS";
export const COMPACT_TEMPLATE = "Compact your context. $ARGUMENTS";

/**
 * True when the config's `command.clm` is not this package's: a user-defined `/clm` keeps
 * its owner, as the server's config hook leaves it alone. Absent → ours (or none yet).
 */
export function userOwnsStatusCommand(commands: unknown): boolean {
	if (!commands || typeof commands !== "object") return false;
	const entry = (commands as Record<string, unknown>)[STATUS_COMMAND];
	if (entry === undefined) return false;
	return !(entry && typeof entry === "object" && (entry as { template?: unknown }).template === STATUS_TEMPLATE);
}
