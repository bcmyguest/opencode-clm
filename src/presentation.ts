/**
 * Model-facing protocol text and user-facing status.
 *
 * The protocol section is written for this package from the behaviour of
 * src/context-document.ts (file layout, what each kind of change does, what is refused).
 * Its scope follows pi-clm src/presentation.ts (MIT, Copyright 2026 Emanuel Casco): it
 * states the editing protocol only; context-management strategy belongs in a steering
 * document.
 */

import { budgetFitLine, budgetSummaryLine, formatTokens, type BudgetFit, type BudgetReading } from "./budget.ts";
import type { EditGate } from "./policy.ts";
import { steeringStatusLine, type SteeringDocument } from "./steering.ts";

/** System-prompt section that teaches the mirror protocol. */
export function systemGuidance(path: string, budget: number | undefined): string {
	const limit = budget
		? `\nThe configured limit is ${formatTokens(budget)} tokens; [CLM BUDGET] notes carry the running estimate.`
		: "";
	return `## Editable context

\`${path}\` holds this conversation as text: every message after the first user message.
The plugin regenerates it before each model request. The system prompt and the first user
message are not in it. When your step ends, the file's content takes the place of those
messages on your next request; OpenCode's saved session keeps the originals.${limit}

Layout: line 1 is \`[[LIVE_CONTEXT ...]]\` and names the revision and the document id.
Each message follows as a block: a header line
\`[[CTX_TURN document=<id> index=<n> role=<role> id=<block id> protected=<true|false>]]\`,
then the message text. \`grep -n '^\\[\\[CTX_TURN' ${path}\` prints every header with its
line number.

Effect of each change:
- Header and text deleted, or text emptied: the message is dropped.
- New text under a tool result header: it replaces that output; the tool call stays.
- New text under an assistant header: the reply becomes that text with no tool calls, and
  the tool results it called become plain notes.
- Blocks marked \`protected=true\` come back unchanged if you alter them; a deleted one
  returns at the end of the file.
- A block whose header you copied with \`id=new-NAME\` (NAME: letters, digits, hyphens;
  unique) and a role label such as \`notes\` is inserted as a note where it stands. Notes are
  context, with no system-prompt authority.
- Text above the first header is kept as a note at the top.
- A file with no headers at all, only text: everything becomes one notes block.

Refused outright (the context stays as it was):
- a line 1 that no longer parses or names a different document;
- a duplicated block id, an id absent from the current headers that lacks the \`new-\`
  prefix, or a malformed header carrying the current document id;
- growth beyond what the size gate allows.

Tools: change the file through the bash tool (python3, sed -i). The edit or write tools
keep a copy that goes stale when the file is regenerated, so leave them off this file.

Receipts: a bash command that writes the file returns a verdict (accepted, or the reason
it is not); a [CLM] note on the next request reports what was applied. After a refusal,
correct the file and write it again.

Example: put a short note in place of block 4's text. Headers quoted inside message text
can look like real ones, so the script matches on the document id from line 1:

\`\`\`bash
python3 - <<'PY'
import re
path = "${path}"
text = open(path).read()
doc = re.match(r"\\[\\[LIVE_CONTEXT [^\\n]*?document=([0-9a-f]+)", text).group(1)
header = re.compile(r"^\\[\\[CTX_TURN document=" + doc + r" index=(\\d+) [^\\n]*$", re.M)
heads = list(header.finditer(text))
pos = next(i for i, h in enumerate(heads) if h.group(1) == "4")
stop = heads[pos + 1].start() if pos + 1 < len(heads) else len(text)
text = text[:heads[pos].end()] + "\\n[note: what block 4 established]\\n\\n" + text[stop:]
open(path, "w").write(text)
PY
\`\`\``;
}

/** Inputs for the `/clm` status text; block 8 fills these from the session. */
export interface ClmStatus {
	sessionID: string;
	mirrorPath: string;
	revision: number;
	accepted: number;
	rejected: number;
	gate: EditGate;
	guard: "withhold" | "off";
	/** Latest budget reading; undefined before the first request. */
	reading?: BudgetReading;
	/** Fixed overhead, usable and effective budget (`budgetFit`); undefined while the budget is unknown. */
	fit?: BudgetFit;
	/** Model context window in tokens, when known. */
	modelWindow?: number;
	/** The accepted revision now in effect, if any. */
	checkpoint?: { revision: number; anchorCount: number; beforeEstimate: number; afterEstimate: number };
	lastRequest?: { rawMessages: number; sentMessages: number; mirrorBlocks: number };
	steering?: SteeringDocument;
	/** Settings changed for this session (`budget 20k, guard off`); absent when none. */
	changed?: string;
	/** Saved settings that could not be used. */
	settingsWarning?: string;
}

/** One line for a toast. */
export function statusLine(status: ClmStatus): string {
	const size = status.reading
		? ` · ${formatTokens(status.reading.estimated)} of ${formatTokens(status.reading.budget)} tok`
		: "";
	return `CLM r${status.revision} · ${status.accepted} accepted / ${status.rejected} rejected${size}`;
}

/** Multi-line status for `/clm`. */
export function statusText(status: ClmStatus): string {
	const lines = [
		`CLM status for session ${status.sessionID}`,
		`mirror: ${status.mirrorPath}`,
		`revision ${status.revision} · edits accepted ${status.accepted} · rejected ${status.rejected} · gate ${status.gate} · guard ${status.guard}`,
		status.reading
			? `${budgetSummaryLine(status.reading)} · model window ${status.modelWindow ? formatTokens(status.modelWindow) : "unknown"}`
			: "budget: unknown until the first request",
	];
	if (status.fit) lines.push(budgetFitLine(status.fit));
	const checkpoint = status.checkpoint;
	lines.push(
		checkpoint
			? `active revision ${checkpoint.revision}: covers ${checkpoint.anchorCount} raw messages; ~${formatTokens(checkpoint.beforeEstimate)}→${formatTokens(checkpoint.afterEstimate)} tokens when accepted`
			: "no accepted edit: the model sees the raw history",
	);
	if (status.lastRequest) {
		const request = status.lastRequest;
		lines.push(`last request: ${request.rawMessages} raw messages → ${request.sentMessages} sent, ${request.mirrorBlocks} mirror blocks`);
	}
	lines.push(steeringStatusLine(status.steering));
	if (status.changed) lines.push(`Changed: ${status.changed}`);
	if (status.settingsWarning) lines.push(`settings warning: ${status.settingsWarning}`);
	return lines.join("\n");
}
