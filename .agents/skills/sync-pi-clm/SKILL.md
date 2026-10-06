---
name: sync-pi-clm
description: Port recent commits from lolipopshock/pi-clm into opencode-clm with a Luna builder and Sol reviewer. Use for upstream parity checks and syncs.
---

# Sync pi-clm

This repository ports [pi-clm](https://github.com/lolipopshock/pi-clm) to OpenCode.
`PORTING.md` maps upstream files and records intentional differences. `upstream.sha`
contains the last upstream commit incorporated on this branch.

Fetch upstream and inspect every commit in `upstream.sha..HEAD`, including its diff.
Record which commits need a port and why any Pi-only changes do not apply.

Use separate model passes with an explicit orchestrator:

1. **Orchestrator: `gpt-6-luna`, read-only.** Inspect every upstream commit, map each
   change through `PORTING.md`, and write a concrete build plan. Identify Pi-only work
   and the tests that would prove the port. Hand that plan to the builder.
2. **Builder: `gpt-6-luna`.** Port the applicable behavior, tests, and documentation.
   Match upstream semantics while respecting OpenCode's architecture and MIT-only
   wording. Keep the change focused; avoid generic abstractions, speculative features,
   duplicated helpers, filler comments, and docs unsupported by the code.
3. Run `bun run check`.
4. **Reviewer: `gpt-6-sol`, read-only.** Independently compare every upstream commit
   with the port and review the local diff. Look for missed behavior, regressions,
   weak tests, needless code, and inaccurate documentation. Report concrete findings
   with file and line references. Approve only when the port is faithful and focused.
5. Give findings to Luna for one repair pass, rerun `bun run check`, and have Sol review
   the result again. If material findings remain, leave the worktree for review and do
   not advance the baseline.
6. **Orchestrator: `gpt-6-luna`, read-only.** Reconcile the plan, tests, and Sol's final
   review. Advance the baseline only if every upstream commit has an explained outcome
   and Sol approved. Summarize the result for the human reviewer.

Update `PORTING.md`, `README.md`, and `CLAUDE.md` when their facts change. Advance
`upstream.sha` only after checks and Sol's review pass. Leave the result for human
review; do not publish or merge automatically. If separate model passes are unavailable,
say so and do not mark the sync complete.
