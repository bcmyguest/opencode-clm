---
name: sync-pi-clm
description: Port recent commits from lolipopshock/pi-clm into opencode-clm. Use when checking upstream parity or updating this OpenCode port.
---

# Sync pi-clm

This repository ports [pi-clm](https://github.com/lolipopshock/pi-clm) to OpenCode.
`PORTING.md` maps upstream files to this port and records intentional differences.
`upstream.sha` contains the last upstream commit incorporated on this branch.

Fetch upstream and compare `upstream.sha..HEAD`. Port relevant behavior and tests,
preserving OpenCode-specific implementation choices and MIT-only wording. Do not copy
Pi integration code where OpenCode requires a different approach. Explain any upstream
changes that do not apply.

Update `PORTING.md`, `README.md`, and `CLAUDE.md` when their facts change. Run
`bun run check` and resolve failures. Advance `upstream.sha` only after the port passes
the checks. Leave the result for review; do not publish or merge it automatically.
