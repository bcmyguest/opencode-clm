# Repository notes

`opencode-clm` ports [pi-clm](https://github.com/lolipopshock/pi-clm) to OpenCode.
`PORTING.md` maps upstream modules to this repository and records intentional differences.

`skills/sync-pi-clm/SKILL.md` guides upstream syncs. Its `upstream.sha` file records
the last incorporated pi-clm commit. A local weekly timer invokes the skill through
the ChatGPT-signed-in Codex CLI with `gpt-6-luna`; the timer itself is not in this repo.
