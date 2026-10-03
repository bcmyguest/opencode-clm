# Configuration

## Where settings come from

Pass options as the second element of the server plugin's tuple in `opencode.json`:

```json
{ "plugin": [["opencode-clm", { "budget": "64k", "gate": "shrink" }]] }
```

Each option falls back to its environment variable, then to the default. The plugin reads
them once at load; an invalid value fails the plugin load with an error that names the
option. Booleans accept `true/false`, `1/0`, `on/off` and `yes/no`.

The TUI plugin reads the same options from the server plugin's entry, so the panel finds
the session directory under your `mirrorDir`. It recognises `opencode-clm`,
`opencode-clm@<version or source>` (including `opencode-clm@file:…`), and `file://` URLs
or paths naming this package or its `index.ts`. When no entry matches, the panel falls
back to the options of its own `tui.json` entry, then to the defaults.

`/clm config` changes settings for one session; see [below](#per-session-changes-clm-config).

## Options

| option | env | default | values |
|---|---|---|---|
| `enabled` | `CLM_ENABLED` | `true` | `false` registers no hooks |
| `budget` | `CLM_BUDGET` | `32000` | tokens (`32000`, `32k`, `1.5m`, `32_000`), or `window` for the model's context window. The model window minus its output limit caps the value |
| `reserve` | `CLM_RESERVE` | `2048` | tokens held back below the budget for generation |
| `remindAt` | `CLM_REMIND_AT` | `0.25,0.5,0.75` | fractions (`0.25,0.5`) or percentages (`25/50%`) strictly between 0 and 1; `off` disables all reminders, the budget − reserve reminder included |
| `gate` | `CLM_EDIT_GATE` | `fit` | `fit`, `shrink` or `none` |
| `guard` | `CLM_OVERFLOW` | `withhold` | `withhold` (or `on`) or `off` |
| `observationCap` | `CLM_OBSERVATION_CAP` | off | `characters[:head fraction]`, e.g. `10000:0.5`; at least 200; head fraction defaults to 0.8; `off` or `0` disables |
| `mirrorDir` | `CLM_MIRROR_DIR` | `<project>/.opencode/clm` | parent of the per-session directories; relative paths resolve against the project |
| `steering` | `CLM_STEERING` | none | path to a steering document, or `house` for the bundled `steering/house-brief.md`; `none` or `off` disables |
| `compactPrompt` | `CLM_COMPACT_PROMPT` | built-in | path to a `/clm-compact` template; `default`, `none` or `off` mean the built-in prompt |
| `estimateFactor` | `CLM_ESTIMATE_FACTOR` | `1` | 1 to 4; multiplies the chars/4 token estimate (1.5–2 for dense content) |
| `reasoning` | `CLM_REASONING` | `true` | render assistant reasoning in the mirror |
| `dumpRequests` | `CLM_DUMP_REQUESTS` | `false` | write each transformed request to `<session dir>/requests/nN.json` |
| `skill` | — | `true` | register the `clm-context` skill; `false` matches pi-clm's CLM mode, which offers no skill |
| `commands` | — | `true` | register `/clm` and `/clm-compact` |

The default `mirrorDir` lies inside the project. The plugin writes a `.gitignore` of `*`
into the mirror parent when it creates it, so git ignores the session directories.

## Sizing the budget

The budget counts the whole request, OpenCode's system prompt and tool schemas included.
With OpenCode 1.18 and its default tools those take about 17,000 to 19,000 tokens of every
request (measured with provider counts), before the conversation starts. MCP servers,
other plugins and a steering document add to that.

A budget must hold that fixed overhead, the `reserve`, and a working margin for the
conversation. The plugin uses a margin of 8,000 tokens: room for the task, a few tool
results and edits. With the default reserve:

```
minimum ≈ 19,000 (overhead) + 2,048 (reserve) + 8,000 (margin) ≈ 29,000 tokens
```

The default budget of 32,000 clears it.

**When the budget is too small, the session raises it.**

1. On the first request that follows a measured reply, the plugin takes the provider's
   input count minus its own conversation estimate as the fixed overhead. It measures only
   while the conversation is at most a quarter of that count, so the estimate's error stays
   small; a session resumed with a long history is measured once its context is short. If
   the provider reports no usage, the plugin's own size estimate stands in until a provider
   count arrives.
2. If budget − reserve leaves less than 8,000 tokens after the overhead, the effective
   budget becomes overhead + 8,000 + reserve. It never exceeds the model window minus its
   output limit (uncapped while the window is unknown).
3. The plugin logs a `budget-too-small` event, shows a warning toast and tells the model
   once. When the window cap leaves less than the margin, the notice says so: lower
   `reserve` or use a model with a larger window.

The overhead is stored in `state.json`, so the raise holds after a restart. It is measured
once per session: switching agent or model, or adding an MCP server, later does not update
it.

`/clm` shows the fixed overhead and the usable budget (budget − reserve − overhead). When
the budget was raised, it also shows the effective budget and what that leaves for the
conversation. The panel computes these figures with the same function as the server
(`budgetFit` in `src/budget.ts`).

## Steering and the compact prompt

A steering document carries context-management strategy (when to compact, what to keep);
the plugin itself states only the editing protocol. The plugin reads the document once at
load and appends it to the system prompt; `/clm status` shows its name and SHA-256 prefix.
`steering: "house"` uses the bundled `steering/house-brief.md`, a copy of pi-clm's.

A `compactPrompt` template may use `{{mirror}}`, `{{current}}`, `{{budget}}` and
`{{instructions}}`. The plugin rereads it on every use.

## Per-session changes: `/clm config`

The options above are the base settings. `/clm config` changes ten of them for one
session, from the TUI or the server command:

- `/clm config` opens the settings page in the TUI (the server command prints every
  setting with its value);
- `/clm config <setting>` shows `Label: value — description`;
- `/clm config <setting> <value…>` changes it; the value is the rest of the line, case
  kept (paths);
- `/clm config reset` drops every change for the session.

Setting names are case-insensitive and accept the aliases below. The settings page offers
the same settings: `Enter` cycles through the choices, or opens a text prompt for settings
without choices.

| setting | aliases | values | choices on the page |
|---|---|---|---|
| `editing` | `enabled` | `on`, `off`; same as `/clm on` and `/clm off`. With the plugin option `enabled: false` it shows `off (plugin disabled)`, and no override turns it on | `on`, `off` |
| `budget` | | tokens (`32k`, `1.5m`, `32000`), or `window` (or `model`) for the model's window | text prompt |
| `reserve` | | tokens (`2048`, `2k`) | text prompt |
| `reminders` | `remind`, `remind-at`, `remindat` | percentages (`25/50/75`, `25/50/75%`) or fractions, or `off`, which also drops the budget − reserve reminder | `25/50/75%`, `50/75/90%`, `75/90%`, `90%`, `off` |
| `gate` | `edit-gate` | `fit`, `shrink`, `none` | the same |
| `guard` | `overflow` | `on` (or `withhold`), `off` | `on`, `off` |
| `cap` | `observation`, `observation-cap`, `observationcap` | `off`, or characters with an optional head fraction (`10k`, `10k:0.5`), at least 200 | `off`, `5k chars`, `10k chars`, `20k chars`, `50k chars`; other values by typing `/clm config cap <value>` |
| `steering` | | a path, `house` for the bundled brief, or `none` | `none`, `house-brief.md` |
| `compact-prompt` | `compactprompt` | a path, or `default` | text prompt |
| `reasoning` | | `on`, `off` | `on`, `off` |

Values parse with the same functions as plugin options and environment variables, so all
three accept the same text. Relative paths resolve against the project directory.
`mirrorDir`, `skill`, `commands`, `dumpRequests` and `estimateFactor` stay load-time only.

How a change is applied:

1. The value is parsed and merged with the session's earlier changes; a change back to the
   base value removes it, so only real differences are stored. The base is the server's
   load-time settings (options, environment, defaults); the TUI reads it from
   `snapshot.json`, so both sides compare against the same values. For `editing` the base
   is the session's on/off state in `state.json`.
2. The result is checked like plugin options; a steering document or compact prompt must
   load. A change that fails is reported (`⚠ <reason>` in the panel, a warning toast or
   text otherwise) and nothing is saved.
3. The changes are written atomically to `overrides.json` in the session directory as
   `{ "version": 1, "overrides": { … } }`. If saving fails, the message starts with
   "Settings unchanged".
4. The server checks the file before every request and every `/clm` command and applies a
   new version from the next request; a request already in flight keeps the old settings.
   A budget, reserve or reminders change restarts the reminder tiers.

The server never fails a request over `overrides.json`. It ignores invalid entries and
keeps the rest; an unreadable file means no changes; if the remaining changes together
are invalid, the session runs on the base settings; a steering document that no longer
loads leaves the session with the protocol only. Each case shows as a `settings warning:`
line in `/clm status`. `/clm status` also lists the changes, e.g.
`Changed: budget 20k, guard off`.
