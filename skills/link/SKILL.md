---
name: link
description: Suggest or check vault wikilinks. The agent applies accepted links in the note; link has no apply operation.
mcp_tool: link
mcp_args:
  op: "suggest"
  notePath: "$1"
---

# link

Suggest and check `[[wikilinks]]`. `link` does not write notes. There is no `op: "apply"`.

```text
/link suggest <vault-relative-note-path>
/link check
```

- `link { op: "suggest", notePath }` returns candidates. Optional `folder` limits the target scope. The call is read-only.
- `link { op: "check", notePath }` validates one note's links without writing. `oms link check` is the CLI counterpart, and it is the form that can check the whole vault without a path.

Suggestions are surface-anchored to a term note's basename or alias, cover the first occurrence of each target only, and report an ambiguous span instead of resolving it. A suggestion is not consent. Show the candidates and insert only the links the user accepts, using the host's file tools at the reported span. If the note changed after the suggestion, suggest again rather than patching a stale span. Do not infer consent, and do not expose private note text beyond the span the user is accepting.

After the edit, run `link` check. When the edit belongs to a note task, also run `write` check on the saved file. Neither call grants repair rights.

`oms bridge add|remove|status` manages repository bridges and has no `link` operation. Do not route bridge work through `link`.

## Surface

Link is read-only: `op: "suggest"` and `op: "check"`. There is no `apply` and no `candidateIds` input. A suggestion does return `baseContentHash` and a stable `id` per candidate so you can tell which note state they describe, but neither is an input to anything: applying a suggested link is the agent's own edit to the note.
