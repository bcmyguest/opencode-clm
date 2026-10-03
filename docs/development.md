# Development

Bun 1.2 or later; the TUI integration test needs Bun 1.3.14 or later (`Bun.spawn` with a
pseudo-terminal). `@opencode-ai/plugin` is a dependency. `@opentui/*` and
`@xterm/headless` are dev dependencies for the TUI tests; OpenCode provides
`@opentui/core` to TUI plugins at runtime.

```sh
bun install --frozen-lockfile
bun run check      # tsc --noEmit + bun test
```

## Checks

- `bun test`: unit tests, including the panel (`test/panel`) and a component test that
  renders the panel in opentui's test renderer with a fake host (`test/tui`).
- `bun run typecheck`: `tsc --noEmit`.
- `scripts/smoke.sh`: offline, no model. Checks the `npm pack` file list, that OpenCode
  loads the plugin from `file://` and registers `/clm`, `/clm-compact` and the skills path,
  and how `@opencode-ai/plugin` resolves from the repo, a bare tarball and an offline
  `npm install`. `--strict` turns skips into failures. It loads the server entry only.
- `bun run test:e2e`: `test/e2e` against the real `opencode` binary (`OPENCODE_BIN`
  overrides it; `OPENCODE_CLM_E2E_KEEP=1` keeps the temp tree). Each case gets temporary
  HOME and XDG directories and a scripted OpenAI-compatible mock server, so your OpenCode
  config stays untouched. OpenCode installs `@opencode-ai/plugin` on first start, so the
  suite needs npm registry access.
  - `clm.e2e.test.ts`: command registration, the mirror re-rendered each turn, an
    accepted edit reaching the next request, a `shrink` gate refusal, budget nudges,
    auto-compaction with pins, receipts, the observation cap, and resuming a session with
    `opencode run --session`. Not covered: the overflow guard, the continuity tools and a
    manual `/compact`.
  - `tui.e2e.test.ts`: the TUI in a pseudo-terminal on a session with an accepted edit:
    `/clm` opens the panel, page switching, the edits page diff, a budget change from the
    settings page landing in `overrides.json`, and typed `/clm` subcommands handled with no
    model request.

No automated test calls a model.

## Running a checkout in OpenCode

Point both plugin lists at the checkout; edits apply on the next OpenCode start:

```jsonc
// opencode.json
{ "plugin": ["file:///path/to/opencode-clm/index.ts"] }
// tui.json
{ "plugin": ["file:///path/to/opencode-clm/tui.ts"] }
```

## Reproducing the screenshots

The README shows `.github/images/overview.png`, `edits.png` and `settings.png`.
`scripts/screenshots.ts` captures them from the real OpenCode TUI with both plugins loaded,
driven against the e2e mock server (`test/e2e/`): no model, temporary HOME and XDG
directories, mock on an OS-assigned port. The pty byte stream is replayed into xterm.js in
headless Chromium and the terminal element is saved as PNG.

The renderer needs `@xterm/xterm` and `playwright-core`, kept out of `package.json`:

```sh
mkdir -p /tmp/oc-shots-deps && cd /tmp/oc-shots-deps
echo '{"private":true}' > package.json
bun add @xterm/xterm@6.0.0 playwright-core
npx playwright-core install chromium   # the build this playwright-core expects; no-op if cached
cd -
SHOTS_DEPS=/tmp/oc-shots-deps OPENCODE_BIN=$(command -v opencode) bun scripts/screenshots.ts
```

The script:

1. Writes `opencode.json` with the plugin (`budget: "32k"`), `compaction.auto: false` and
   the mock provider, and `tui.json` with `tui.ts`. The terminal is 120 × 34 cells.
2. Runs four `opencode run` turns in one session: a task that `cat`s two long source files,
   `/clm-compact` (the mock replies with a scripted mirror edit replacing both outputs with
   notes), a second long-output task, and a second `/clm-compact`. It stops unless
   `state.json` shows revision 2. The mock reports provider usage as request characters / 4.
3. Opens the TUI on that session and captures:
   - **overview.png**: `/clm`, then `←` until the newest edit row (`r2`) is selected and
     expanded with "Enter: before/after in edits".
   - **edits.png**: `3`, `j` until a `~` (rewritten) row is selected, Enter.
   - **settings.png**: `q`, `/clm config reminders 50/75/90%`, then `/clm config`.

The first start needs network: OpenCode installs `@opencode-ai/plugin` into the temporary
config directory. `SHOTS_DEBUG=1` also writes each screen's text to `/tmp/shot-<name>.txt`.

## CI

`ci.yml` runs on pull requests and pushes to `main`: frozen install, typecheck,
`bun test`, `npm pack --dry-run`, `scripts/smoke.sh --strict` and `bun run test:e2e`
against `opencode-ai@1.18.34`. `codeql.yml` runs CodeQL.

## Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`, `fix:`, `docs:`, `ci:`, `test:`, `refactor:`, `chore:`; `!` for breaking
changes). `pre-commit install` adds a commit-msg hook that checks them.

## Releasing

[git-cliff](https://git-cliff.org) (`cliff.toml`) derives the version from the commits
since the last tag: `feat` bumps minor, other commits except `chore` and `style` bump
patch, and a breaking change bumps minor below 1.0.0.

1. Actions → "Prepare release" → Run workflow on `main` (tick `dry_run` to preview). It
   bumps `package.json` if needed, commits `chore(release): vX.Y.Z`, tags, pushes and
   dispatches "Release".
2. "Release" checks the tag against `package.json`, runs CI on the tag, publishes to npm
   through trusted publishing (OIDC with provenance, no token), then creates the GitHub
   Release with git-cliff notes.

Preview locally with `git-cliff --bumped-version` and `git-cliff --unreleased --strip header`.
Users then install with `opencode plugin opencode-clm`; the tarball holds the TypeScript
sources (OpenCode loads them directly), the skills, the steering brief, the README and
CHANGELOG.md. Release notes from 0.1.1 on live in GitHub Releases; CHANGELOG.md holds 0.1.0.
