# Configuration

Everything is optional; with no configuration, the budget is 32,000 tokens, the edit gate
is `fit`, and the overflow guard and the reminders (at 25, 50 and 75% and at
budget − reserve) are on.

Plugin options in `opencode.json` set the defaults for every session; an environment
variable applies where the option is absent. The **settings** page of the panel
(`/clm config`) and `/clm config <setting> <value>` change them for the current session.
Those changes are saved in `overrides.json` in the session directory
(`<mirrorDir>/clm-<session id>/`), so they survive a restart; they apply from the next
request, and `/clm config reset` drops them.

```json
{ "plugin": [["opencode-clm", { "budget": "64k", "gate": "shrink" }]] }
```

## Settings

`/clm config <setting> <value>` changes one setting; `/clm config <setting>` shows it;
`/clm budget [value]` is short for `/clm config budget [value]`, and `/clm on|off` for
`/clm config editing on|off`.
Values keep their case (paths), names do not. Relative paths resolve against the project.

| setting          | what it controls                                                                                         | `/clm config` values                                          | default     |
|------------------|----------------------------------------------------------------------------------------------------------|---------------------------------------------------------------|-------------|
| `editing`        | whether the session renders the mirror and applies the model's edits; same as `/clm on` and `/clm off`   | `on`, `off`                                                   | `on`        |
| `budget`         | token budget the reminders, the edit gate and the overflow guard measure against, system prompt and tool schemas included | `32k`, `1.5m`, `32000`, or `window`                | `32k`       |
| `reserve`        | generation headroom kept below the budget; the last reminder and the guard act at budget − reserve       | `2048`, `2k`                                                  | `2048`      |
| `reminders`      | budget fractions at which a `[CLM BUDGET]` note reaches the model; `off` also drops the budget − reserve one | `25/50/75%`, `50/75/90%`, `75/90%`, `90%`, `off`           | `25/50/75%` |
| `gate`           | edits that grow the context: `fit` accepts them within budget − reserve, `shrink` never, `none` without a check | `fit`, `shrink`, `none`                                  | `fit`       |
| `guard`          | overflow guard: above budget − reserve, withhold the oldest tool results                                 | `on`, `off`                                                   | `on`        |
| `compaction`     | OpenCode's automatic compaction: `off` turns it off; `auto` pauses it while the guard enforces a budget; `on` keeps your `compaction.auto` (see Notes) | `auto`, `off`, `on`                                       | `auto`      |
| `cap`            | max characters kept per tool result (head + tail), at least 200                                          | `10k`, `10000`, `10k:0.5` (head fraction), `off`              | off         |
| `steering`       | markdown file with your context-management strategy, appended to the system prompt                      | `house` (the bundled `steering/house-brief.md`), a path, `none` | none      |
| `one-tool`       | run only the first tool call of each model response; later ones fail with a note to repeat them          | `on`, `off`                                                   | `off`       |
| `trailer`        | end each successful tool result with `[context: ~N of B tokens after this result]`                      | `on`, `off`                                                   | `off`       |
| `compact-prompt` | markdown template `/clm-compact` sends instead of the built-in prompt                                    | a path, `default`                                             | built in    |
| `reasoning`      | show the assistant's reasoning in the mirror                                                             | `on`, `off`                                                   | `on`        |

## Plugin options and environment variables

These are read once, when the plugin loads. A plugin option wins over its environment
variable; an empty variable counts as unset. A value the parser does not accept stops the
plugin from loading, with a message naming the setting. Flags accept `true`/`false`,
`1`/`0`, `on`/`off` and `yes`/`no`.

| option           | variable              | accepted values                                                                                      | sets             |
|------------------|-----------------------|------------------------------------------------------------------------------------------------------|------------------|
| `enabled`        | `CLM_ENABLED`         | a flag (default on); `false` registers no hooks, and `/clm config editing on` cannot override it     | —                |
| `budget`         | `CLM_BUDGET`          | tokens, e.g. `32000`, `32k`, `1.5m`; `window` for the model window                                   | `budget`         |
| `reserve`        | `CLM_RESERVE`         | tokens, e.g. `2048` or `2k`                                                                          | `reserve`        |
| `remindAt`       | `CLM_REMIND_AT`       | fractions or percentages separated by commas, spaces or `/`, e.g. `0.25,0.5,0.75` or `25/50/75%`; `off` or `none` for no reminders | `reminders` |
| `gate`           | `CLM_EDIT_GATE`       | `fit`, `shrink` or `none`                                                                            | `gate`           |
| `guard`          | `CLM_OVERFLOW`        | `withhold`, `on` or `true`; `off` or `false`                                                         | `guard`          |
| `compaction`     | `CLM_NATIVE_COMPACTION` | `auto`, `off` or `on`                                                                              | `compaction`     |
| `oneTool`        | `CLM_ONE_TOOL_PER_TURN` | a flag (default off)                                                                               | `one-tool`       |
| `trailer`        | `CLM_SIZE_TRAILER`    | a flag (default off)                                                                                 | `trailer`        |
| `observationCap` | `CLM_OBSERVATION_CAP` | a number of characters, e.g. `10000` (no `k`), or `10000:0.5` with the head fraction (default 0.8); `off` or `0` | `cap` |
| `steering`       | `CLM_STEERING`        | a path to a markdown file, or `house`; `none` or `off`                                               | `steering`       |
| `compactPrompt`  | `CLM_COMPACT_PROMPT`  | a path to a markdown template; `default`, `none` or `off` for the built-in prompt                    | `compact-prompt` |
| `reasoning`      | `CLM_REASONING`       | a flag (default on)                                                                                  | `reasoning`      |
| `mirrorDir`      | `CLM_MIRROR_DIR`      | parent of the session directories (default `<project>/.opencode/clm`)                                | —                |
| `estimateFactor` | `CLM_ESTIMATE_FACTOR` | a number from 1 to 4 (default 1): a multiplier on the size estimate (dense data: `2`)                | —                |
| `dumpRequests`   | `CLM_DUMP_REQUESTS`   | a flag (default off): write each transformed request to `<session dir>/requests/nN.json`             | —                |
| `skill`          | —                     | a flag (default on): register the `clm-context` skill                                                | —                |
| `commands`       | —                     | a flag (default on): register `/clm` and `/clm-compact`                                              | —                |

## Notes

- **Budget.** The budget counts the whole request, OpenCode's system prompt and tool
  schemas included; `/clm status` shows their measured size. The model window minus its
  output limit caps the budget. When budget − reserve leaves less than 8,000 tokens after
  the measured overhead, the session raises its effective budget to make room, warns with
  a toast and tells the model once.
- **Calibration.** Sizes are estimated at four characters per token, then corrected with
  the provider's own count of each request. Dense content (code, random strings) can be
  twice as many tokens as the estimate; for a run that starts with such data,
  `CLM_ESTIMATE_FACTOR=2` avoids one oversized first request.
- **Steering.** The harness text stays protocol-only; a steering document is the one place
  for strategy. `/clm status` shows the document's name and SHA-256 prefix, so an
  experiment can record which brief was used.
- **Compaction.** OpenCode has one instance-wide flag, `compaction.auto`, for threshold
  compaction and for recovery from a provider overflow error. Before each request the
  plugin sets it from that session's setting, so sessions served by one OpenCode process at
  the same time overwrite each other's value. `off` also turns off overflow recovery: the
  error is shown and the model is told to shrink its context. `auto`, as in pi, pauses
  threshold compaction while the guard enforces a budget: the flag is off for each request
  whose estimate plus the model's output cap reaches OpenCode's threshold (context − output
  cap, or `limit.input` − `compaction.reserved`, which defaults to the smaller of 20,000
  and the output cap), and your value otherwise. A paused request also gets no overflow
  recovery. A subagent's requests set the flag too; the parent's value returns after each
  of its tool calls. When a step's count crossed the threshold under the paused flag, a
  toast says so, once per crossing; under `off` the model also gets a notice. `on` changes nothing. Manual `/compact` always works.
- **Compact prompt.** A template may use `{{mirror}}`, `{{current}}`, `{{budget}}` and
  `{{instructions}}`; unknown placeholders stay as written, and text typed after
  `/clm-compact` is always included. The plugin rereads the template on every use.
- **Session changes.** A change back to the base value is dropped, and a change that fails
  (an invalid value, a steering file that does not load) is reported and not saved. The
  server never fails a request over `overrides.json`: it skips bad entries and shows a
  `settings warning:` line in `/clm status`.
- **Mirror directory.** The default lies inside the project; the plugin writes a
  `.gitignore` of `*` into it when it creates it. When a configured `mirrorDir`
  cannot be created, the session uses the project default `.opencode/clm` instead and a
  toast names both.
- **No usable mirror directory.** When the default fails too, the session runs without a
  mirror, as pi-clm does: no protocol prompt and no edits; requests carry the raw history
  plus the continuity annotations and their size notice. `/clm-compact` refuses, the tool
  output size line is off, and the `compaction` setting is not applied (OpenCode's
  compaction is the only way to shrink). The session's files go to a private directory
  under the OS temp directory, removed when the server exits normally; `state.json`,
  `overrides.json` and `annotations.jsonl` still readable in the failed session directory
  are copied there first. The annotations are also kept in OpenCode's session metadata
  (at most 64 KiB of UTF-8 JSON, open ones first) after each change, and restored when the
  session runs without a mirror again; a session that has its mirror back drops that copy,
  and a fork keeps only the annotations made up to the fork point. One error toast names the directories that failed. Only when
  the temp directory fails too do requests carry the bare raw history.
- **TUI panel.** The panel reads `mirrorDir` from the server plugin's entry in
  `opencode.json`, falling back to its own `tui.json` entry.
