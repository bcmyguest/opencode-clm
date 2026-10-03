# How opencode-clm works

opencode-clm lets the model manage its own context. The context the model will see on its
next request is mirrored to a file; the model edits that file with ordinary tools; the
edited version becomes its next context. OpenCode's stored session history is never
rewritten.

## The mirror

Before every request opencode-clm writes the model-visible conversation to
`LIVE_CONTEXT.md` in the session directory. The system prompt and the first user message
(the task) stay outside the mirror and are always sent.

```text
[[LIVE_CONTEXT version=1 revision=2 document=<nonce> baseline=<digest>]]

# Edit bodies or delete editable CTX_TURN blocks. Keep metadata/header lines intact.

[[CTX_TURN document=<nonce> index=1 role=assistant id=1-b1ba26e534cb protected=false]]
I'll count the lines of both commands.

[[CTX_TURN document=<nonce> index=2 role=notes id=new-tracker protected=false]]
TASK TRACKER
- ...
```

During its turn the model may rewrite that file however it likes, using the bash tool
(python3, `sed -i`): shorten stale tool output in place, delete or reorder blocks, insert
new ones (`id=new-…`, any role label), grow a scratchpad, or replace everything with plain
text (that becomes one `notes` block). OpenCode's edit and write tools keep a copy that goes
stale when the plugin rewrites the file, so the protocol steers the model away from them.
Each bash command that writes the mirror gets a verdict appended to its output: valid, or
the reason it would be refused.

OpenCode has no end-of-turn hook, so opencode-clm reads the mirror at the start of the next
request. It validates the file, keeps untouched messages as their original objects,
repairs tool-call pairs, saves the result as a revision, and sends it. The edit gate
(`fit` by default) refuses growth past budget − reserve. Nothing shrinks unless the model
shrinks it; the harness only guarantees the request is legal and tells the model how much
room it has.

## What runs without the model

Two things run on their own, because a single turn with many parallel tool calls can
outrun any reminder:

- **Overflow guard** — if the estimated request exceeds budget − reserve (by default
  32,000 − 2,048 tokens, OpenCode's system prompt and tool schemas included), the oldest
  tool results after the last accepted edit are swapped for one-line notes pointing at
  files in `withheld/` with the full text. No tool runs again.
- **Calibration** — the size estimate (chars/4) is corrected against the provider's own
  count of each request, so dense content (code, random strings) does not slip past the
  budget. The factor never drops below 1.

An optional observation cap (off by default) also trims each tool result in the sent
context to a set number of characters.

OpenCode's compaction summarizes the raw history with a separate model call; the
`compaction` setting (`/clm config compaction off`) turns its automatic compaction off. If
OpenCode compacts anyway, opencode-clm hands it the edited context, asks the summary to
carry pinned and continuity annotations verbatim, and rebases its revisions on the summary.
`/clm-compact [instructions]` instead asks the model to compact by editing its mirror, with
a fixed prompt you can replace.

## The panel

`/clm` opens the panel (with the TUI plugin); `/clm overview|input|edits|settings` opens a
page directly (without the TUI plugin it prints the page as text). `1–4` or `Tab` switch
pages, `r` reloads, `q` or `Esc` closes.

- **overview** — context size per request, the budget, and a marker for each accepted or
  rejected edit, reset and compaction. It opens on the latest request; `← →` step through
  the markers and back to now; `z` cycles the x axis between **all** (the whole history
  fitted into the width, the default), **detail** (one column per request, panning) and
  **turns** (one column per user turn); `Enter` opens an accepted edit in **edits** (or,
  at now, the current input).
- **input** — how much of the raw transcript the next request carries, and the effective
  message list.
- **edits** — per revision, every message before and after. `Enter` expands a message
  into a side-by-side diff (one column below 60 columns), `a` expands all, `↑ ↓` scroll,
  `← →` switch revisions.
- **settings** — sizes and files above the settings list; `↑ ↓` select and `Enter`
  changes a setting (cycles its choices, or asks for a value). Changes are saved to the
  session's `overrides.json` and apply from the next request; see
  [configuration.md](configuration.md).

## Model and server support

- A CLM edit changes the request at the edit point, so a plain prefix cache recomputes
  everything after it.
- Hosted APIs and vLLM/SGLang reuse only the unchanged prefix.
- llama.cpp `--cache-reuse` also reuses matching chunks after the edit, on plain-attention
  models.
- Hybrid Qwen models (`qwen35`, `qwen35moe`, `qwen4exp`) refuse `--cache-reuse`; they need
  a patched llama.cpp (experimental, unreleased).
- Models not trained to edit their own context make more edit mistakes. The gate and the
  verdicts catch malformed files, not poor choices of what to drop.

## Safety

The mirror holds conversation data. The session directory
(`.opencode/clm/clm-<session>/` in the project by default) is `0700`, its files `0600`, and
a `.gitignore` of `*` in `.opencode/clm/` keeps it out of git. It persists across restarts
so a resumed session finds its state; opening a session removes session directories
untouched for seven days. Model-editable memory is a prompt-injection surface: injected
text can induce the model to rewrite its own constraints. opencode-clm keeps the real system prompt out of the mirror and lowers
authored roles to plain text, but it cannot stop a model from dropping context it should
have kept. Hooks fail open: if the plugin throws, the request goes out with the raw
history.

## Further reading

[architecture.md](architecture.md) describes the system as implemented: the request
lifecycle, the mirror format, validation, persistence and compaction, the budget, the
overflow guard, settings, the panel, storage, the module map, and the design notes and
known limitations.
