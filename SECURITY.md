# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/bcmyguest/opencode-clm/security/advisories/new).
Do not open a public issue. Expect a first reply within 14 days.

## Supported versions

Only the latest release receives fixes.

## Scope notes

- The mirror file and the session directory hold conversation data. The plugin creates
  them with mode `0700` (directories) and `0600` (files) under `<project>/.opencode/clm`
  by default.
- The model edits its own context. Text that enters the context (tool output, web pages)
  can induce the model to remove its own instructions or constraints. The system prompt
  stays outside the mirror, and model-written notes reach the model as user-role text,
  never as system text; the plugin does not stop a model from dropping context it needs.
