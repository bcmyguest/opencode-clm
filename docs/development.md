# Development

## Setup

```sh
bun install
```

Bun 1.2 or later runs the plugin and the tests; the TUI integration test needs Bun 1.3.14
or later (`Bun.spawn` with a pseudo-terminal). `@opentui/core`, `@opentui/keymap` and
`@opentui/solid` 0.4.5 (the versions OpenCode 1.18.34 ships) and `@xterm/headless` are dev
dependencies for the TUI tests.

To run a checkout in OpenCode, point both config lists at it:

```jsonc
// opencode.json
{ "plugin": ["file:///path/to/opencode-clm/index.ts"] }
// tui.json
{ "plugin": ["file:///path/to/opencode-clm/tui.ts"] }
```

## Checks

- `bun test`: unit tests, including the panel (`test/panel`) and a component test that
  renders the panel in opentui's test renderer with a fake host (`test/tui`).
- `bun run typecheck`: `tsc --noEmit`.
- `bun run check`: both.
- `scripts/smoke.sh`: offline, no model. Checks the `npm pack` file list, that OpenCode
  loads the plugin from `file://` and registers `/clm`, `/clm-compact` and the skills path
  with no plugin error in its logs, and how `@opencode-ai/plugin` resolves from the repo, a
  bare tarball and an offline `npm install`. `--strict` turns skips into failures. It
  loads the server entry only; the TUI entry is covered by the TUI integration test.
- `bun run test:e2e`: the integration suites in `test/e2e` against the real `opencode`
  binary (`OPENCODE_BIN` overrides it; `OPENCODE_CLM_E2E_KEEP=1` keeps the temp tree). Each
  case gets temporary HOME and XDG directories and a scripted OpenAI-compatible mock on an
  OS-assigned port, so your own OpenCode config is untouched. OpenCode installs
  `@opencode-ai/plugin` into the temporary config directory on first start, so the suite
  needs npm registry access.
  - `clm.e2e.test.ts` (10 tests): plugin load and command registration (`debug config`,
    `/clm path`, `/clm-compact`); the mirror written and re-rendered each turn; an accepted
    edit whose text reaches the next request; a `shrink` gate refusal and the note the
    model sees; budget nudges at 50% and at budget − reserve; auto-compaction (the summary
    carries the edited text and the summarizer gets the pin instruction; the next request
    rebases onto the summary with no drop note, and a pin survives); receipts from
    `tool.execute.after`; the observation cap; and a second `opencode run --session`
    resuming the revision and mirror. Not covered: the overflow guard, the continuity tools
    and a manual `/compact`.
  - `tui.e2e.test.ts` (1 test): one `opencode run` with an accepted edit, then the TUI on
    that session in a pseudo-terminal (`tui-driver.ts`, screen read through
    `@xterm/headless`): `/clm` opens the panel; the edits page shows exact recorded
    provenance and `j` + `Enter` expands the edited row's diff; `2`, `4` and `Tab` switch
    pages; the budget changed from the settings page (`✓ Budget: 20k`) lands in
    `overrides.json`; `q` and `Esc` return to the session; typed `/clm input` and
    `/clm config guard off` are handled in the TUI with no model request; a following
    `opencode run --command clm status` reports `Changed: budget 20k, guard off`.

## Reproducing the screenshots

The README shows `.github/images/overview.png`, `edits.png` and `settings.png`. They are
captured by hand from a real session with a real model and at least one accepted edit.

1. In a scratch project, configure the model you use and both plugins, and turn
   OpenCode's auto-compaction off so only CLM edits appear:

   ```jsonc
   // opencode.json
   {
     "plugin": [["file:///path/to/opencode-clm/index.ts", { "budget": "32k" }]],
     "compaction": { "auto": false }
   }
   // tui.json
   { "plugin": ["file:///path/to/opencode-clm/tui.ts"] }
   ```

2. Use a terminal of at least 120 × 34 cells (the edits page switches to a one-column
   diff when the diff area is narrower than 60 columns). Start `opencode` in the project.
3. Give a task that produces long tool output, for example "Read README.md and
   docs/how-it-works.md and summarise the install steps". After the reply, type
   `/clm-compact keep only the install steps` and let the model edit its mirror. Repeat
   the task-then-compact cycle once more so the chart shows two edits.
4. Check that an edit was accepted: `/clm status` shows a toast with `revision 1` or
   higher and `last: applied`. If it says `rejected`, compact again.
5. **overview.png**: type `/clm` and press Enter. The overview opens with `now` selected.
   Press `←` until the newest edit row (`rN  hh:mm  X → Y  −NN%`) is selected: its column
   shows `▼` and the row expands with "Enter: before/after in edits". Capture.
6. **edits.png**: press `3`. The newest revision is shown. Press `j` until a row marked
   `~` (rewritten) is selected, then press Enter to expand its side-by-side diff. Capture.
7. **settings.png**: press `q`, type `/clm config reminders 50/75/90%` and press Enter, so
   one row is marked `•` as changed. Type `/clm config` and press Enter: the settings page
   opens with `CLM editing` selected and its description below. Capture, then type
   `/clm config reset` to undo the change.

## What has been tested

Automated tests are unit tests, a load smoke test and the mock-server integration suites
above; none of them calls a model. One manual run of 0.1.0 with a real model (Qwen3.8
Flash-Next on a local llama.cpp server, `opencode run`, budget 12k) showed the budget was
smaller than OpenCode's own system prompt and tool schemas; 0.1.1 raises the budget in
that case.

## CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`: frozen install,
typecheck, `bun test`, `npm pack --dry-run`, `scripts/smoke.sh --strict` and
`bun run test:e2e` against `opencode-ai@1.18.34`. CodeQL runs in `codeql.yml`.

## Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`, `fix:`, `docs:`, `ci:`, `test:`, `refactor:`, `chore:`; `!` for breaking
changes). `pre-commit install` adds a commit-msg hook that checks them.

## Releasing

Releases come from Conventional Commits through [git-cliff](https://git-cliff.org)
(`cliff.toml`). `feat` bumps minor; `fix` and any commit except `chore` and `style` bump
patch; a breaking change bumps minor below 1.0.0.

1. Actions → "Prepare release" → Run workflow on `main` (tick `dry_run` to preview). It
   computes the version (`git-cliff --bumped-version`), bumps `package.json` if needed,
   commits `chore(release): vX.Y.Z`, tags, pushes and dispatches "Release".
2. "Release" checks the tag against `package.json`, runs CI on the tag, publishes to npm
   through trusted publishing (OIDC, provenance, no token), then creates the GitHub Release
   with git-cliff notes.

Preview locally: `git-cliff --bumped-version` and `git-cliff --unreleased --strip header`.
Notes for 0.1.1 and later live in GitHub Releases; CHANGELOG.md holds 0.1.0.
