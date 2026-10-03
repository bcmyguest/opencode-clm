# opencode-clm

An [OpenCode](https://opencode.ai) plugin that runs a model as a Context Language Model
(CLM): the model edits a text mirror of its own conversation, and the edited mirror
becomes its input on the next request. OpenCode's stored session stays unchanged.

It ports [pi-clm](https://github.com/lolipopshock/pi-clm) 1.0.0, the Pi extension that
accompanies the CLM paper ([arXiv 2609.37725](https://arxiv.org/abs/2609.37725)).
[PORTING.md](PORTING.md) maps each pi-clm file to its counterpart here.

## Install

Tested with OpenCode 1.18.34.

From npm, once published, in `opencode.json`:

```json
{ "plugin": ["opencode-clm"] }
```

From a local clone:

```json
{ "plugin": ["file:///path/to/opencode-clm/index.ts"] }
```

## Configuration

Pass options as the second element of a plugin tuple:

```json
{ "plugin": [["opencode-clm", { "budget": "64k", "gate": "shrink" }]] }
```

Each option falls back to its environment variable, then to the default. The plugin reads
them once at load; an invalid value fails the plugin load with an error that names the
option.

| option | env | default | values |
|---|---|---|---|
| `enabled` | `CLM_ENABLED` | `true` | `false` registers no hooks |
| `budget` | `CLM_BUDGET` | `32000` | tokens (`32000`, `32k`, `1.5m`, `32_000`), or `window` for the model's context window. The model window minus its output limit caps the value |
| `reserve` | `CLM_RESERVE` | `2048` | tokens held back below the budget for generation |
| `remindAt` | `CLM_REMIND_AT` | `0.25,0.5,0.75` | fractions (`0.25,0.5`) or percentages (`25/50%`) strictly between 0 and 1; `off` disables all reminders, the budget − reserve reminder included |
| `gate` | `CLM_EDIT_GATE` | `fit` | `fit`, `shrink` or `none` |
| `guard` | `CLM_OVERFLOW` | `withhold` | `withhold` or `off` |
| `observationCap` | `CLM_OBSERVATION_CAP` | off | `characters[:head fraction]`, e.g. `10000:0.5`; at least 200; head fraction defaults to 0.8; `off` or `0` disables |
| `mirrorDir` | `CLM_MIRROR_DIR` | `<project>/.opencode/clm` | parent of the per-session directories; relative paths resolve against the project |
| `steering` | `CLM_STEERING` | none | path to a steering document, or `house` for the bundled `steering/house-brief.md`; `none` or `off` disables |
| `compactPrompt` | `CLM_COMPACT_PROMPT` | built-in | path to a `/clm-compact` template; `default`, `none` or `off` mean the built-in prompt |
| `estimateFactor` | `CLM_ESTIMATE_FACTOR` | `1` | 1 to 4; multiplies the chars/4 token estimate (1.5–2 for dense content) |
| `reasoning` | `CLM_REASONING` | `true` | render assistant reasoning in the mirror |
| `dumpRequests` | `CLM_DUMP_REQUESTS` | `false` | write each transformed request to `<session dir>/requests/nN.json` |
| `skill` | — | `true` | register the `clm-context` skill; `false` matches pi-clm's CLM mode, which offers no skill |
| `commands` | — | `true` | register `/clm` and `/clm-compact` |

Booleans accept `true/false`, `1/0`, `on/off` and `yes/no`.

A steering document carries context-management strategy (when to compact, what to keep);
the plugin itself states only the editing protocol. The plugin reads the document once at
load and appends it to the system prompt; `/clm` shows its name and SHA-256 prefix.

A `compactPrompt` template may use `{{mirror}}`, `{{current}}`, `{{budget}}` and
`{{instructions}}`. The plugin rereads it on every use.

## Commands

- `/clm [status | path | on | off | reset]`: `status` (the default) prints the session's
  mirror path, revision, accepted and rejected edits, gate, guard, budget reading and
  active revision, and shows a toast. `path` prints the mirror path. `on` and `off` switch
  CLM for the session. `reset` drops the accepted revision, so the next request carries
  the stored history. The command costs one model turn: OpenCode cannot cancel a command,
  so the model receives the text and repeats it.
- `/clm-compact [instructions]`: asks the model to compact its context now by editing the
  mirror. Text after the command is appended to the prompt.

If your config already defines `clm` or `clm-compact`, the plugin keeps your command,
logs a warning and leaves it alone. A failing command prints `[CLM] /<name> failed:
<reason>` and shows an error toast.

## Tools

- `clm_annotate`: `action` is `create`, `resolve` or `list`. `create` takes a mirror block
  id (`source`), `title`, `reason`, `futureAction` and `retention`:
  - `pin` keeps the exact source text in every request (up to 8,000 tokens);
  - `continuity` keeps the title, reason, next action and recall id in every request;
  - `archive` keeps nothing in the request; the source is available through recall.
- `clm_recall`: returns an annotation's saved source; `maxTokens` 128–8,000, default 2,000.

## Skill

`skills/clm-context/SKILL.md`, adapted from pi-clm's `live-context` skill, tells the model
when and how to edit the mirror: batched surgical edits, keeping conversational units
together, durable summaries, and Python scripts that list headers and replace or remove
blocks by id. The plugin adds the `skills` directory to OpenCode's `skills.paths`.

## How it works

**Mirror.** Before each model request, the plugin writes every message after the first
user message to `LIVE_CONTEXT.md` in the session directory. Line 1 is a `[[LIVE_CONTEXT
...]]` header with the revision and document id; each message follows as a block headed
`[[CTX_TURN document=<id> index=<n> role=<role> id=<block id> protected=<bool>]]`. The
system prompt and the first user message stay outside the mirror and are always sent. A
system-prompt section, `## Editable context`, teaches the model the format.

**Editing.** The model edits the mirror with the bash tool (python3, `sed -i`). The edit
and write tools keep a copy that goes stale when the plugin regenerates the file, so the
protocol tells the model to avoid them on the mirror. Deleting a block drops the message.
New text under a tool result replaces its output and keeps the call. New text under an
assistant header replaces the reply and turns its tool results into notes. A header copied
with `id=new-NAME` inserts a note. Replacing the whole file with text that has no block
headers replaces everything after the first user message with one notes block. When a
bash, edit, write or apply_patch call writes the mirror, the plugin appends a verdict to
its output (accepted, or the reason for refusal); a heuristic detects bash writes. A
`[CLM]` note on the next request reports what was applied.

**Commit.** OpenCode has no end-of-turn hook, so the plugin reads the mirror at the start
of the next request. If the file differs from the last render, the plugin parses it and
applies it. It refuses a file whose line 1 no longer parses or names another document, a
file with duplicate or unknown block ids, and a file the edit gate rejects; the context
then stays as it was.

**Edit gate.** Every gate accepts an edit that keeps the context the same size or smaller.
For growth: `fit` accepts it while the editable context stays within budget − reserve
minus the system prompt, tool schemas, pinned text and continuity notes, and accepts everything while the budget is
unknown; `shrink` rejects it; `none` applies no size check.

**Projection checkpoints.** An accepted edit becomes a revision. The checkpoint stores the
number of flattened raw messages it replaces, their OpenCode message ids, and a SHA-256
digest of them, with tool-result content excluded so OpenCode's prune does not invalidate
it. A pruned tool output inside an accepted revision goes out with the revision's text.
Each later request sends the projected messages plus the raw messages added since.
When the stored prefix no longer matches (a revert, for example), the plugin drops the
revision, sends the raw history, and tells the model. Compaction is the exception (see
Compaction).

**Budget tiers.** Token estimates are chars/4 × `estimateFactor` × a calibration factor
learned from the provider's reported input sizes (never below 1). The estimate covers the
system prompt, tool schemas, pinned task, editable context, continuity text and notices.
Until a size is known, the `[CLM BUDGET]` note names what the estimate leaves out. Reminders fire once per tier, as `[CLM BUDGET]` notes, at each
`remindAt` fraction and at budget − reserve. Requests are never blocked.

**Observation cap.** When set, each tool result in the sent context keeps at most
`characters` characters (the head fraction from the start, the rest from the end) plus a
marker stating how much was cut. The stored output stays complete.

**Overflow guard.** When the estimated request exceeds budget − reserve, the guard
replaces new tool results, oldest first, with a note naming the tool, call id, size and a
file in `withheld/` that holds the full output (or, if saving fails, a pointer to the
session history), until the estimate fits. User and
assistant messages stay untouched, and no tool runs again. `guard: "off"` disables it.

**Continuity.** Annotations (see Tools) let the model shorten or delete a block while a
pin, a continuity note or a recall copy keeps what later work needs. The plugin sends
active annotations as a user-role note after the conversation, and warns the model when they exceed
8,000 tokens.

**Compaction.** CLM replaces compaction: the model shrinks its own context by editing the
mirror. Set `"compaction": { "auto": false }` in `opencode.json` while CLM is on, and keep
auto-compaction only as a fallback for a session that outgrows the window anyway.

When OpenCode compacts:
1. The plugin applies the accepted revision to the history OpenCode summarizes, so the
   summary reflects the edited context. It makes no commit or render.
2. It appends an instruction to the compaction prompt: copy every pin and continuity
   annotation, listed after it, into the summary verbatim.
3. When a revision is active and OpenCode reports the finished compaction (the `session.compacted` event or the
   `experimental.compaction.autocontinue` hook), the next request rebases: the summary
   becomes the new baseline, the revision number moves on, and the model gets no
   dropped-revision note. Pins and continuity annotations carry over unchanged, and
   `events.jsonl` records a `compacted` event.

OpenCode's title, summary and compaction agents get no protocol text.

## State

Each session has a directory `<mirrorDir>/clm-<session id>/` (mode 0700; files 0600):

| file | content |
|---|---|
| `LIVE_CONTEXT.md` | the mirror |
| `state.json` | enabled flag, revision, active checkpoint |
| `annotations.jsonl` | continuity annotations |
| `events.jsonl` | one line per request, edit, reset, notice and error |
| `revisions/rN.md` | the mirror text of each accepted revision |
| `withheld/` | tool outputs held back by the overflow guard |
| `requests/nN.json` | transformed requests, with `dumpRequests` only |

The plugin deletes session directories untouched for 7 days when it opens another
session. The default `mirrorDir` lies inside the project; add `.opencode/clm/` to
`.gitignore`.

## Limitations

- Status, budget and edit outcomes appear as text, toasts and `events.jsonl`. pi-clm's
  TUI viewer, timeline and diff are not ported: OpenCode server plugins cannot draw panels.
- No per-session settings panel; `/clm on|off|reset` are the only per-session switches.
- Model limits and the system-prompt size reach the plugin one request late. On the
  first request of a process the model window does not yet cap the budget and the
  estimate omits the system prompt; with `budget: "window"` that request has no budget
  reading. `/clm-compact` before the first request reports about 0 tokens.
- Built-in tool descriptions are measured, but not their parameter schemas, so
  calibration attributes that size to undercounting.
- A checkpoint ignores changes to stored tool output inside the prefix it covers. An
  output rewritten by another plugin or an SDK client goes out with the new text, while
  the mirror and estimate keep the revision's.
- Hooks fail open: if the transform throws, the request goes out with the raw history and
  an error toast.
- The calibration factor lives in memory and restarts at 1 with each process.
- A subagent (task) session gets its own mirror and state.
- Not ported from pi-clm: branch-aware restore, the `max_tokens` clamp lift, cancelling
  Pi's own compaction, and the `oneToolPerTurn` and `sizeTrailer` switches.

## Testing

No model has run through this package. Its tests are unit tests, a load smoke test and a
mock-server end-to-end test (see Development).

The integration suite (`test/e2e`, 10 tests) drives the real OpenCode binary
(1.18.34, pinned in CI) against a scripted OpenAI-compatible mock, with temporary HOME
and XDG directories. It covers: plugin load and command registration (`debug config`,
`/clm path`, `/clm-compact`); the mirror written and re-rendered each turn; an accepted
edit whose text reaches the next request; a `shrink` gate refusal and the note the model
sees; budget nudges at 50% and at budget − reserve; auto-compaction (the summary carries
the edited text and the summarizer gets the pin instruction; the next request rebases onto
the summary with no drop note, and a pin survives); receipts
from `tool.execute.after`; the observation cap; and a second `opencode run --session`
resuming the revision and mirror. Not covered: the overflow guard, the continuity tools
and a manual `/compact`.

The server-side suffix-cache work is experimental and unreleased.

## Development

- `bun test`: unit tests.
- `bun run typecheck`: `tsc --noEmit`.
- `scripts/smoke.sh`: offline, no model. Checks the `npm pack` file list, that OpenCode
  loads the plugin from `file://` and registers `/clm`, `/clm-compact` and the skills
  path with no plugin error in its logs, and how `@opencode-ai/plugin` resolves from the
  repo, a bare tarball and an offline `npm install`.
- `bun run test:e2e`: the integration suite above (about 30-55 s). Needs the `opencode`
  binary (`OPENCODE_BIN` overrides it; `OPENCODE_CLM_E2E_KEEP=1` keeps the temp tree) and
  npm registry access, because OpenCode installs `@opencode-ai/plugin` into its temporary
  config directory.
- CI (`.github/workflows/ci.yml`) runs on pull requests and pushes to `main`: frozen
  install, typecheck, `bun test`, `npm pack --dry-run`, `scripts/smoke.sh --strict` and the
  integration suite against `opencode-ai@1.18.34`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org)
  (`feat:`, `fix:`, `docs:`, `ci:`, `test:`, `refactor:`, `chore:`; `!` for breaking
  changes). `pre-commit install` adds a commit-msg hook that checks them.

## Releasing

Releases come from Conventional Commits through [git-cliff](https://git-cliff.org)
(`cliff.toml`). `feat` bumps minor; `fix` and any commit except `chore` and `style` bump
patch; a breaking change bumps minor below 1.0.0. v0.1.0 is a single commit,
`feat: initial release`.

1. Actions → "Prepare release" → Run workflow on `main` (tick `dry_run` to preview).
   It computes the version (`git-cliff --bumped-version`), bumps `package.json` if needed,
   commits `chore(release): vX.Y.Z`, tags, pushes and dispatches "Release".
2. "Release" checks the tag against `package.json`, runs CI on the tag, publishes to npm
   through trusted publishing (OIDC, provenance, no token), then creates the GitHub
   Release with git-cliff notes.

Preview locally: `git-cliff --bumped-version` and `git-cliff --unreleased --strip header`.
Notes for 0.1.1 and later live in GitHub Releases; CHANGELOG.md holds 0.1.0.

## Credits

- [pi-clm](https://github.com/lolipopshock/pi-clm) 1.0.0 (MIT, Copyright 2026 Emanuel
  Casco): the design and most of the code derive from it. Model-facing text taken from
  pi-clm, adapted: the compaction prompt (`src/compact.ts`), the `clm-context` skill, the
  budget notices, the mirror rejection and receipt messages, and the overflow and
  observation notes. `steering/house-brief.md` is byte-identical to pi-clm's. Written for
  this package: the system-prompt protocol section (`src/presentation.ts`), the edit-gate
  refusal note, and the plugin's own receipts, commands and tool descriptions.
  [NOTICE](NOTICE) lists the files; [LICENSE](LICENSE) carries pi-clm's notice.
- Context Language Models, [arXiv 2609.37725](https://arxiv.org/abs/2609.37725), and
  [facebookresearch/context-language-models](https://github.com/facebookresearch/context-language-models)
  (CC BY-NC 4.0). This package copies no text from that repository (normalized 5-gram
  check: no shared span over 6 tokens). The `fit` / `shrink` edit gate and the default
  25/50/75% reminder steps follow its harness design, and the edit-cost advice in the
  skill, inherited from pi-clm, covers the same points as the harness prompt in different
  words. This package is not licensed under CC BY-NC and is not endorsed by its authors.

## AI assistance

Claude Code (Claude Opus) wrote the code and documentation in this repository. The
maintainer has not hand-reviewed them.

## License

MIT. See [LICENSE](LICENSE), which includes the pi-clm notice, and [NOTICE](NOTICE).
