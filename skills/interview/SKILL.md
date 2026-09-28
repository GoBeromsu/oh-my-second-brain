---
name: interview
description: Show the vault interview questions and the seal state without sealing anything. The owner answers; sealing goes through the setup skill or the owner's terminal.
mcp_tool: interview
mcp_args: {}
---

# interview

See what the vault interview would ask right now, and where the seal stands. `interview` is read-only: it seals nothing, writes nothing, and never answers a question for the owner.

```text
/interview [--reask]
```

MCP `interview { reask? }` runs the interview with no answers and returns the vault, the contract posture, and a `status`:

- `questions`: `questions` lists `{id, prompt, kind, choices?, default?}` and `notes` holds interview lines worth showing the owner. Ask the owner, then seal through the `setup` skill (`oms setup --answers <file>`).
- `interpretation-required`: the vault has templates. `sources` lists each one with its `sourceHash`. The `setup` skill covers reading each template and submitting its interpretation.
- `loosening`: the sealed contract would loosen. `changes` names each field and kind of change, never a value. Only the owner can loosen a contract, by running `oms interview` in a terminal.
- `refused`: `reasons` names why the interview cannot run. Tell the owner to run `oms doctor contract`, then `oms interview` in a terminal.

`reask: true` asks again about items declined at an earlier seal.

`oms interview` is the owner's interactive terminal interview. It needs a real terminal, refuses `OMS_NON_INTERACTIVE=1`, and has full authority, including loosening. Never run it on the owner's behalf.

Never read, list, or edit `~/.oms` or any sealed contract file. The values the owner gives are part of the hidden contract; do not repeat them into notes, messages to others, or memory.

The surface is four MCP tools (write, search, interview, doctor) and six skills.
