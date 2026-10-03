// Parses a typed `/clm …` line into what the TUI should do with it. Pure; written for
// this package (the subcommands follow pi-clm's `/clm` and `/clm config`).

export type Page = "overview" | "input" | "edits" | "settings";
export const PAGES: readonly Page[] = ["overview", "input", "edits", "settings"];

export type ClmCommand =
	/** Open the panel on a page. */
	| { kind: "open"; page: Page }
	/** `/clm config <setting>`: show one setting. */
	| { kind: "config-show"; setting: string }
	/** `/clm config <setting> <value…>`: change one setting. */
	| { kind: "config-set"; setting: string; value: string }
	| { kind: "config-reset" }
	| { kind: "status" }
	| { kind: "path" }
	| { kind: "enable"; enabled: boolean }
	/** Must reach the server command (it rewrites state.json): let the line through. */
	| { kind: "server"; args: string }
	| { kind: "usage"; text: string };

export const CLM_USAGE = "Usage: /clm [overview | input | edits | settings | status | path | on | off | reset | config [setting [value]]]";

/** Page names and the short forms pi accepts. */
const PAGE_ALIASES: Record<string, Page> = {
	overview: "overview",
	timeline: "overview",
	input: "input",
	edits: "edits",
	edit: "edits",
	settings: "settings",
};

/**
 * `undefined` when the text is not a `/clm` line (e.g. `/clm-compact` or plain text);
 * otherwise the action. Leading and trailing whitespace is ignored; subcommand names are
 * case-insensitive, values keep their case (paths).
 */
export function parseClmCommand(text: string): ClmCommand | undefined {
	const match = /^\/clm(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match) return undefined;
	const args = (match[1] ?? "").trim();
	if (args === "") return { kind: "open", page: "overview" };
	const [head = "", ...rest] = args.split(/\s+/);
	const word = head.toLowerCase();
	const page = PAGE_ALIASES[word];
	if (page && rest.length === 0) return { kind: "open", page };
	switch (word) {
		case "status":
			return rest.length === 0 ? { kind: "status" } : { kind: "usage", text: CLM_USAGE };
		case "path":
			return rest.length === 0 ? { kind: "path" } : { kind: "usage", text: CLM_USAGE };
		case "on":
		case "off":
			return rest.length === 0 ? { kind: "enable", enabled: word === "on" } : { kind: "usage", text: CLM_USAGE };
		case "reset":
			return { kind: "server", args };
		case "config": {
			if (rest.length === 0) return { kind: "open", page: "settings" };
			const setting = rest[0]!.toLowerCase();
			if (setting === "reset" && rest.length === 1) return { kind: "config-reset" };
			// The value is the rest of the line as typed, inner spaces kept.
			const value = args.replace(/^\S+\s+\S+\s*/, "");
			return value === "" ? { kind: "config-show", setting } : { kind: "config-set", setting, value };
		}
		default:
			return { kind: "usage", text: CLM_USAGE };
	}
}
