# Repository notes

`opencode-clm` ports [pi-clm](https://github.com/lolipopshock/pi-clm) to OpenCode.
`PORTING.md` maps upstream modules to this repository and records intentional differences.

`.agents/skills/sync-pi-clm/SKILL.md` guides upstream syncs. Its `upstream.sha` file records
the last incorporated pi-clm commit. A local weekly timer invokes the skill through
the ChatGPT-signed-in Codex CLI with a Luna orchestrator and builder plus a Sol reviewer;
the timer itself is not in this repo.
