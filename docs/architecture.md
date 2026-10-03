# Architecture

The system as implemented, for OpenCode 1.18.34. [PORTING.md](../PORTING.md) maps each
module to its pi-clm source.

## 1. Two plugins in one package

OpenCode runs server plugins and TUI plugins in separate runtimes and reads them from
separate config lists.

| target | entry | `package.json` | config list | does |
|---|---|---|---|---|
| server | `index.ts`, default export `{ id: "opencode-clm", server }` | `exports["./server"]` (and `"."`, `main`) | `plugin` in `opencode.json` | hooks, mirror, edits, budget, tools, `/clm` and `/clm-compact` commands |
| TUI | `tui.ts`, default export `{ id: "opencode-clm", tui }` | `exports["./tui"]` | `plugin` in `tui.json` | the `/clm` panel, typed `/clm …` lines |

The two talk only through the session directory: the server writes it, the TUI reads it.
`@opentui/core` is an optional peer dependency; OpenCode provides it to TUI plugins at
runtime. The TUI code uses no JSX, because OpenCode's Solid compile step skips
`node_modules`; it builds opentui renderables directly.

## 2. One request

OpenCode calls `experimental.chat.messages.transform` before every model request. For the
session, `ClmSession` (`src/clm.ts`) then:

1. re-reads `overrides.json` if it changed and activates the new settings;
2. commits the mirror if the model changed it (parse, gate, new revision);
3. measures the newest provider-reported input size (calibration, and the fixed overhead
   until it is measured);
4. applies the active checkpoint, or drops it when the stored prefix no longer matches,
   or rebases after a compaction;
5. strips reasoning if configured, applies the observation cap and the overflow guard;
6. renders the mirror, computes the budget reading and queues notices;
7. writes the request back into OpenCode's array in place, replaces `snapshot.json`, and
   logs a `request` event.

`experimental.chat.system.transform` adds the protocol section and steering document;
`tool.definition` records tool schema sizes; `tool.execute.after` appends the edit verdict
to tool output; `experimental.session.compacting` feeds the revision and annotations into
OpenCode's compaction; `command.execute.before` answers `/clm` and `/clm-compact`.

## 3. Session files

Each session has a directory `<mirrorDir>/clm-<session id>/` (mode 0700; files 0600):

| file | written by | content |
|---|---|---|
| `LIVE_CONTEXT.md` | server | the mirror |
| `state.json` | server | enabled flag (`/clm on|off` before 0.2.0; from 0.2.0 the `editing` override wins), revision, active checkpoint, last outcome, measured fixed overhead and budget decision |
| `annotations.jsonl` | server | continuity annotations |
| `events.jsonl` | server | one JSON line per request, edit, rejection, reset, compaction, notice and error; from 0.2.0, `request` events also carry `users` (user messages in the history) and `observedMessage` (the message that reported `observedPrevious`) |
| `revisions/rN.md` | server | the mirror text of each accepted revision |
| `revisions/rN.json` | server | each accepted revision row by row (kind, source and output index, role, before/after roles when they differ, tokens, and the full text: `before` and `after`, or one `text` for an unchanged row), written at accept; 0.2.0 on |
| `snapshot.json` | server | replaced atomically on every request: request number, revision, enabled, configured budget, reserve and guard limit, calibration, steering, sizes, the effective input with a preview (≤ 120 characters) per message, and `base`: the server's base settings in `overrides.json` form; 0.2.0 on |
| `overrides.json` | TUI and server | per-session setting changes, `{ "version": 1, "overrides": { … } }`, only values that differ from the base; written atomically by `/clm config`, `/clm on|off` and the settings page; 0.2.0 on |
| `withheld/` | server | tool outputs held back by the overflow guard |
| `requests/nN.json` | server | transformed requests, with `dumpRequests` only |

The plugin deletes session directories untouched for 7 days when it opens another session.
`src/session-files.ts` reads the directory for the panel: missing files are normal (a 0.1
session has only the server's 0.1 files), torn lines are skipped, revision files are
cached by mtime and size.

## 4. Module map

| module | role |
|---|---|
| `index.ts` | server entry: hook registration, commands, tools, skill path |
| `tui.ts` | TUI entry |
| `src/clm.ts` | `ClmSession`: the per-request pipeline, state queue, events |
| `src/opencode.ts` | OpenCode `{ info, parts }` messages ⇄ flat messages |
| `src/context-document.ts` | mirror render, parse and apply; edit traces |
| `src/policy.ts` | edit gate (`fit`, `shrink`, `none`) |
| `src/projection.ts` | checkpoints: digest, prefix validation, projection |
| `src/state.ts` | `state.json` shape, validation, atomic save |
| `src/mirror-store.ts` | session directory, atomic mirror writes, stale-directory sweep |
| `src/mirror-guard.ts` | classifies tool calls that touch the mirror |
| `src/budget.ts` | budget resolution, tiers, notices, `budgetFit`, calibration |
| `src/overflow.ts` | overflow guard |
| `src/observation.ts` | observation cap |
| `src/continuity.ts` | annotations and recall |
| `src/compact.ts` | `/clm-compact` prompt |
| `src/steering.ts` | steering document load |
| `src/presentation.ts` | system-prompt protocol section, status text |
| `src/settings.ts` | options → env → defaults |
| `src/settings-table.ts` | the ten `/clm config` settings: names, aliases, choices, format, parse; merge, sanitize, compare overrides |
| `src/overrides.ts` | `overrides.json` read, check (stage), change, reset |
| `src/atomic.ts` | atomic 0600 writes (temp file + rename) |
| `src/commands.ts` | command names and templates shared by server and TUI |
| `src/session-files.ts` | read-only access to a session directory |
| `src/panel/files.ts` | shapes of the session files |
| `src/panel/model.ts` | `buildPanelModel`: timeline points and markers, revisions, input, budget |
| `src/panel/timeline.ts` | chart layout (fit, requests, turns) and rendering |
| `src/panel/diff.ts` | line and word diff, side-by-side and unified layouts |
| `src/panel/lines.ts` | styled spans, width, wrap and clip |
| `src/panel/view.ts` | `renderPanel`: frame and the four pages |
| `src/panel/keys.ts` | key reducer |
| `src/panel/command.ts` | `parseClmCommand` |
| `src/tui/panel.ts` | opentui adapter: styled text, key layer, dialogs |
| `src/tui/plugin.ts` | route, slash row, command handling, reloads |
| `src/tui/intercept.ts` | the Enter intercept for typed `/clm …` lines |
| `src/tui/data.ts` | host data: server options, newest usage, model limits, settings rows |

Everything under `src/panel/` is pure TypeScript with no opentui import and no file
access; `src/tui/` is the only code that touches the TUI host.

## 5. The panel

`buildPanelModel` turns the session files into one model: points from `request` events
(a request's size is the next request's `observedPrevious` unless that came from the same
message as its own, or for the newest the host's count of a reply completed after it,
else the estimate), markers from `accepted`, `rejected`,
`reset`, `projection-reset` and `compacted` events, revisions from `revisions/rN.json`,
input from `snapshot.json`, and the budget recomputed with `budgetFit`. `renderPanel` draws
it as lines of styled spans (tones such as `muted`, `edit`, `diffAdd`); the adapter maps
tones to the theme and sets one `StyledText`.

The panel is a plugin route with its own key mode, so the host's prompt and key bindings
are inactive while it is open. A key interceptor at priority 100 sees Enter before
autocomplete and prompt submit. For a prompt line matching `/clm…` it handles the line in
the TUI and clears the prompt (a usage error keeps the text so it can be fixed); only
`/clm reset` reaches the server command. When the config's `/clm` is not this package's (a
user-defined command, or `commands: false`), the intercept lets every line through.

Settings changes take one path from both sides: `changeSetting` (`src/overrides.ts`)
parses the value, merges it, drops base-equal keys, checks the result strictly and writes
`overrides.json`. The base is the server's: the server uses its load-time settings, and
the TUI reads them from `snapshot.json` (`base`), falling back to its own resolution of
the server options before the first 0.2.0 request; the `editing` base is `state.json`'s
`enabled`. Before each transform, system transform and `/clm` command the server
compares the file's mtime, size and inode with the last read; on a change it re-reads,
sanitizes, checks non-strictly and activates the new settings, keeping a warning for
`/clm status`.

## 6. Design notes

- **Commit at the next request.** OpenCode has no end-of-turn hook, so edits apply when the
  next request starts. The verdict reaches the model earlier, appended to the tool output.
- **First user message pinned.** The task statement stays outside the mirror, so the model
  cannot delete it.
- **One estimator.** chars/4 × `estimateFactor` × calibration, in tokens, for the gate,
  tiers, guard and notices.
- **Checkpoints survive prune.** The digest excludes tool-result content.
- **Separate overrides file.** `state.json` belongs to the server's save queue; the TUI
  never writes it.

## 7. Known limitations

- Model limits and the system-prompt size reach the plugin one request late. On the first
  request of a process the model window does not yet cap the budget and the estimate omits
  the system prompt; with `budget: "window"` that request has no budget reading.
  `/clm-compact` before the first request reports about 0 tokens.
- Built-in tool descriptions are measured, but not their parameter schemas, so
  calibration attributes that size to undercounting.
- A checkpoint ignores changes to stored tool output inside the prefix it covers. An output
  rewritten by another plugin or an SDK client goes out with the new text, while the mirror
  and estimate keep the revision's.
- The calibration factor lives in memory and restarts at 1 with each process.
- A subagent (task) session gets its own mirror and state.
- The fixed overhead is measured once per session.
- Panel sizes rely on the next request's `observedPrevious`. For a session logged before
  0.2.0 (no `observedMessage`), an equal count on consecutive requests is read as a
  repeat after an errored reply, and the panel shows the estimate.
- A setting changed while a request runs applies from the next request.
- Duplicate `/clm` rows appear in autocomplete (the server command and the TUI slash row);
  Enter is handled by the TUI either way.
- `opencode attach` to a remote server: the session files are not local, so the panel
  shows no data.
- Not ported from pi-clm: branch-aware restore, the `max_tokens` clamp lift, cancelling
  Pi's own compaction, and the `oneToolPerTurn` and `sizeTrailer` switches.
