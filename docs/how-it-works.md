# How it works

opencode-clm turns a model's conversation into a file the model can edit. This page covers
what happens on each request, what the model and the user can do, and what protects the
session when something goes wrong. Settings are in [configuration.md](configuration.md);
modules and files in [architecture.md](architecture.md).

## The mirror

Before each model request, the server plugin writes every message after the first user
message to `LIVE_CONTEXT.md` in the session directory. Line 1 is a `[[LIVE_CONTEXT ...]]`
header with the revision and the document id. Each message follows as a block headed
`[[CTX_TURN document=<id> index=<n> role=<role> id=<block id> protected=<bool>]]`. The
system prompt and the first user message stay outside the mirror and are always sent. A
system-prompt section, `## Editable context`, teaches the model the format.

## Editing

The model edits the mirror with the bash tool (python3, `sed -i`). The edit and write tools
keep a copy that goes stale when the plugin regenerates the file, so the protocol tells the
model to avoid them on the mirror.

- Deleting a block drops the message.
- New text under a tool result replaces its output and keeps the call.
- New text under an assistant header replaces the reply and turns its tool results into
  notes.
- A header copied with `id=new-NAME` inserts a note.
- Replacing the whole file with text that has no block headers replaces everything after
  the first user message with one notes block.

When a bash, edit, write or apply_patch call writes the mirror, the plugin appends a
verdict to that call's output: accepted, or the reason for refusal. A heuristic detects
bash writes. A `[CLM]` note on the next request reports what was applied.

## Commit

OpenCode has no end-of-turn hook, so the plugin reads the mirror at the start of the next
request. If the file differs from the last render, the plugin parses it and applies it. It
refuses a file whose line 1 no longer parses or names another document, a file with
duplicate or unknown block ids, and a file the edit gate rejects; the context then stays as
it was.

## Edit gate

Every gate accepts an edit that keeps the context the same size or smaller. For growth:

- `fit` accepts it while the editable context stays within budget − reserve, minus the
  system prompt, tool schemas, pinned text and continuity notes. While the budget is
  unknown, `fit` accepts everything.
- `shrink` rejects it.
- `none` applies no size check.

## Revisions and checkpoints

An accepted edit becomes a revision. The checkpoint stores the number of flattened raw
messages it replaces, their OpenCode message ids, and a SHA-256 digest of them. The digest
leaves tool-result content out, so OpenCode's prune does not invalidate it; a pruned tool
output inside an accepted revision goes out with the revision's text. Each later request
sends the projected messages plus the raw messages added since.

When the stored prefix no longer matches (after a revert, for example), the plugin drops
the revision, sends the raw history, and tells the model. Compaction is the exception (see
below).

## Budget

The budget counts the whole request: OpenCode's system prompt and tool schemas, the pinned
task, the editable context, continuity text and notices. [configuration.md](configuration.md#sizing-the-budget)
explains how to size it and how the plugin raises a budget that is too small.

Token estimates are chars/4 × `estimateFactor` × a calibration factor learned from the
provider's reported input sizes (never below 1). Until the system-prompt and tool sizes are
known, the `[CLM BUDGET]` note names what the estimate leaves out. Reminders fire once per
tier, as `[CLM BUDGET]` notes, at each `remindAt` fraction and at budget − reserve. Requests
are never blocked.

## Observation cap

When set, each tool result in the sent context keeps at most `characters` characters (the
head fraction from the start, the rest from the end) plus a marker that states how much
was cut. The stored output stays complete.

## Overflow guard

When the estimated request exceeds budget − reserve, the guard replaces new tool results,
oldest first, with a note naming the tool, call id, size and a file in `withheld/` that
holds the full output, until the estimate fits. If saving the file fails, the note points
to the session history instead. User and assistant messages stay untouched, and no tool
runs again. `guard: "off"` disables it.

## Continuity tools

Annotations let the model shorten or delete a block while a pin, a continuity note or a
recall copy keeps what later work needs.

- `clm_annotate`: `action` is `create`, `resolve` or `list`. `create` takes a mirror block
  id (`source`), `title`, `reason`, `futureAction` and `retention`:
  - `pin` keeps the exact source text in every request (up to 8,000 tokens);
  - `continuity` keeps the title, reason, next action and recall id in every request;
  - `archive` keeps nothing in the request; the source is available through recall.
- `clm_recall`: returns an annotation's saved source; `maxTokens` 128–8,000, default 2,000.

The plugin sends active annotations as a user-role note after the conversation, and warns
the model when they exceed 8,000 tokens.

## Skill and steering

`skills/clm-context/SKILL.md`, adapted from pi-clm's `live-context` skill, tells the model
when and how to edit the mirror: batched surgical edits, keeping conversational units
together, durable summaries, and Python scripts that list headers and replace or remove
blocks by id. The plugin adds the `skills` directory to OpenCode's `skills.paths`.

A steering document carries context-management strategy (when to compact, what to keep);
the plugin itself states only the editing protocol. See
[configuration.md](configuration.md#steering-and-the-compact-prompt).

## Compaction

CLM replaces compaction: the model shrinks its own context by editing the mirror. Set
`"compaction": { "auto": false }` in `opencode.json` while CLM is on, and keep
auto-compaction only as a fallback for a session that outgrows the window anyway.

When OpenCode compacts:

1. The plugin applies the accepted revision to the history OpenCode summarizes, so the
   summary reflects the edited context. It makes no commit or render.
2. It appends an instruction to the compaction prompt: copy every pin and continuity
   annotation, listed after it, into the summary verbatim.
3. When a revision is active and OpenCode reports the finished compaction (the
   `session.compacted` event or the `experimental.compaction.autocontinue` hook), the next
   request rebases: the summary becomes the new baseline, the revision number moves on, and
   the model gets no dropped-revision note. Pins and continuity annotations carry over
   unchanged, and `events.jsonl` records a `compacted` event.

OpenCode's title, summary and compaction agents get no protocol text.

## Commands

With the TUI plugin loaded, a typed `/clm …` line is caught before the prompt submits and
handled in the TUI, at no model turn:

- `/clm` and `/clm overview|input|edits|settings` open the panel on that page;
- `/clm status` and `/clm path` answer with a toast (the path is the session directory);
- `/clm config` opens the settings page; `/clm config <setting>` shows one setting,
  `/clm config <setting> <value>` changes it and `/clm config reset` drops every change
  (see [configuration.md](configuration.md#per-session-changes-clm-config));
- `/clm on` and `/clm off` set the session's `editing` setting.

`/clm reset` goes to the server command: it drops the accepted revision, so the next
request carries the stored history, and the mirror is rewritten from it. A server command
costs one model turn: OpenCode cannot cancel a command, so the model receives the text and
repeats it.

Without the TUI plugin, and in `opencode run --command clm …`, the server command answers
every `/clm` line as text:

- `status` (the default) prints the mirror path, revision, accepted and rejected edits,
  gate, guard, budget reading, active revision, the changed settings and any settings
  warning, and shows a toast;
- `path` prints the mirror path;
- `overview`, `input` and `edits` print that panel page as plain text, 72 columns wide,
  as pi-clm does outside its TUI;
- `config` prints every setting with its value; `config <setting>`, `config <setting>
  <value>` and `config reset` work as above;
- `on`, `off` and `reset` as above.

`/clm-compact [instructions]` asks the model to compact its context now by editing the
mirror. Text after the command is appended to the prompt.

If your config already defines `clm` or `clm-compact`, the plugin keeps your command, logs
a warning and leaves it alone; the TUI then lets typed `/clm` lines through as well, as it
does with `commands: false`. A failing command prints `[CLM] /<name> failed: <reason>` and
shows an error toast.

## The panel

The TUI plugin (`tui.ts`) adds a full-screen route with four pages. It reads the session
directory, writes only `overrides.json`, and never writes `state.json`.

- **overview**: a notice line when CLM is off or the last edit was rejected; the title
  `Context size · N requests · now X · peak Y · budget Z`; a budget line with the fixed
  overhead and the usable budget; a bar chart with one column per request (or per bucket,
  or per user turn: `z` cycles the zoom). Columns followed by an accepted edit use `▓` with
  a marker above. The list below has one row per edit, rejection, reset or compaction, and
  a final `now` row. `Enter` on an edit opens it on the edits page; on `now`, the input
  page.
- **input**: what the next request will contain: the share removed, raw and effective
  token and message counts, and one line per message. Read from `snapshot.json`, which the
  server rewrites on every request; before that the page says "No input snapshot yet".
- **edits**: one tab per revision (`← →`). Each message row shows what happened to it
  (`=` kept, `~` rewritten, `−` removed, `+` added, `↺` restored); `Enter` expands a
  side-by-side diff (unified below 60 columns), `a` expands all. Read from
  `revisions/rN.json`, written when the edit is accepted; a revision from a 0.1 server
  has only `revisions/rN.md`, and the page shows that mirror text instead.
- **settings**: a summary of sizes and files, then every setting `/clm config` knows with
  its value in force; changed ones are marked `•`. `Enter` cycles a choice or opens a text
  prompt; the change is checked, saved to `overrides.json` and confirmed with `✓ Label:
  value`, or refused with `⚠ <reason>`. It applies from the next request.

Bar sizes are the provider's input count (input + cache read + cache write) for the reply
to that request when known, else the plugin's estimate, marked `~`. The panel reloads on
open, on `r`, and while open whenever the session goes idle or a message updates.

## Safety

- OpenCode's stored history is never rewritten; every change applies to what is sent.
- Hooks fail open: if the transform throws, the request goes out with the raw history and
  an error toast.
- Session files are private: the directory is mode 0700, files 0600.
- The plugin reads its base options once at load; an invalid option fails the load with
  an error that names it. Per-session changes in `overrides.json` are re-read before every
  request and never fail a request (see
  [configuration.md](configuration.md#per-session-changes-clm-config)).
