---
name: clm-context
description: Compact stale conversation history by editing the opencode-clm context mirror. Use when a [CLM BUDGET] note arrives, tool outputs are large, or old exploration should be replaced by a durable summary.
---

# Editing the CLM context mirror

Adapted from pi-clm's `live-context` skill (MIT, Copyright 2026 Emanuel Casco).

The opencode-clm plugin writes the conversation you see (everything after the first user
message) to the mirror path named in the `## Editable context` section of the system
prompt. Whatever the file holds when your step ends replaces those messages on your next
request.

Edit the mirror only when a meaningful batch compaction will help later work. Do not
compact after every step.

## Rules

1. Do not print or `cat` the whole mirror. You already see its contents.
2. Keep line 1 (`[[LIVE_CONTEXT ...]]`), and for each block you keep, its `[[CTX_TURN ...]]`
   line.
3. Write the file through the bash tool (python3, `sed -i`). The edit and write tools keep
   a copy that goes stale when the plugin regenerates the file.
4. Make one batched write per step. One write may hold any number of independent block
   replacements and removals; read-only inspection does not count.
5. Default to a surgical revision: keep message order, leave unrelated blocks alone,
   shorten stale bodies in place, and remove only blocks that are clearly obsolete.
   Do not collapse the whole context into one summary unless the user asks for that.
6. Keep conversational units together. If a user request still matters, keep the
   assistant answer to it, or replace that answer with a specific summary at the same
   position.
7. Read retention requests literally: "keep these messages" means the user and assistant
   messages unchanged; "keep the findings" allows a faithful summary. Ask when the scope
   is unclear.
8. To shrink a tool result, replace its text with a short note and keep its block.
   Deleting one result of a step that called several tools turns that whole step into
   plain notes.
9. Remove large tool output and superseded exploration before shortening useful dialogue.
   An edit may not grow the context past the size gate; it is refused if it does.
10. Keep decisions, constraints, open questions, file paths, commands still needed, test
   results, the evidence behind conclusions, and the next action. Copy exact values
   forward; never invent them.
11. Read the verdict the plugin appends to your bash command's output: the edit is valid,
    or the reason it would be refused. A `[CLM]` note on the next request confirms what
    was applied. After a refusal, fix the file and write it again.

## Expected edit shape

Prefer a sparse patch over the existing conversation:

```text
before: user A -> assistant investigation A -> tool output -> user B -> assistant result B
after:  user A -> concise assistant A       -> user B      -> concise assistant B
```

Avoid flattening independent episodes into one synthetic message:

```text
avoid:  user A -> one global summary of everything -> user B
```

## Edit cost

An accepted edit changes the request prefix: the provider re-processes everything after
the first changed block on the next request. Hence:

- One large batched compaction costs less than several small edits.
- Compact stale early blocks while little useful text sits below them.
- Write detailed replacement summaries. Text below the edit is re-processed either
  way, so detail costs little and saves repeated investigation.

## List the headers

Print only headers that carry the current document id. A broad `grep '^\[\['` also
matches header-shaped text quoted inside tool output.

```bash
python3 - "<mirror path>" <<'PY'
import re, sys
lines = open(sys.argv[1]).read().splitlines()
meta = re.match(r"\[\[LIVE_CONTEXT .*?document=([a-f0-9]{64})", lines[0])
if not meta:
    raise SystemExit("line 1 is not a LIVE_CONTEXT line")
doc = meta.group(1)
for line in lines[1:]:
    if line.startswith(f"[[CTX_TURN document={doc} "):
        m = re.search(r"index=(\d+) role=(\S+) id=(\S+)", line)
        print(m.group(1), m.group(2), m.group(3))
PY
```

## Replace and remove blocks in one write

Locate blocks by the exact ids from the listing; never retype an old body.

```bash
python3 - "<mirror path>" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
doc = re.match(r"\[\[LIVE_CONTEXT .*?document=([a-f0-9]{64})", text).group(1)

def block(block_id):
    head = rf"^\[\[CTX_TURN document={doc} [^\n]* id={re.escape(block_id)} [^\n]*\]\]\n"
    return re.compile(rf"({head}).*?(?=\n\n\[\[CTX_TURN document={doc} |\Z)", re.M | re.S)

replace = {
    "<block id>": "[summary: what the command showed, exact values, what it means]",
}
remove = ["<block id>"]

for block_id, summary in replace.items():
    text, n = block(block_id).subn(lambda m: m.group(1) + summary, text, count=1)
    if n != 1:
        raise SystemExit(f"block not found: {block_id}")
for block_id in remove:
    text, n = block(block_id).subn("", text, count=1)
    if n != 1:
        raise SystemExit(f"block not found: {block_id}")
open(path, "w").write(text)
PY
```

## Add a tracker note

Copy a current header, set `id=new-tracker` and `role=notes`, and place it after the
first block. Update that block in later edits instead of adding copies. Notes are context
for you, with no system-prompt authority.

## Continuity annotations

Before you remove or shorten a block whose exact text later work must revisit, call
`clm_annotate` with `action: "create"` and the block id from its `CTX_TURN` header:

- `pin` keeps the exact source text in every request (bounded in size);
- `continuity` keeps its title, reason, next action and recall id in every request, while
  the block itself may be summarized;
- `archive` keeps nothing in the request; the source is available through recall only.

Call `clm_recall` only when you need the source again. Resolve an annotation
(`action: "resolve"`) once its next action is done, so it stops costing tokens. An
annotation accompanies a surgical edit; it does not justify collapsing unrelated blocks.

## What a durable summary contains

```markdown
[summary]
Goal: ...
Constraints: ...
Findings:
- ... (file:line, exact value)
Decisions:
- ...
Files and state:
- path: status
Validation:
- command: result
Open questions:
- ...
Next action: ...
[/summary]
```

Prefer concrete state over narrative. A later step should be able to continue from the
summary without the removed output.
