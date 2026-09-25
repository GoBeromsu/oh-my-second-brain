# Oh My Second Brain — Claude Code

The vault owns its conventions. The user seals folders, properties, and
templates once, in an interactive `oms setup` they run themselves at a terminal.
The `setup` skill may seal for them too: you ask each question, and `oms setup
--answers` seals a first or stricter contract only. Loosening a seal and
recovering a broken one stay with the user's terminal. The sealed contract lives
outside the vault, and it is not yours to read.

## Writing

Write vault notes with MCP `write {path, content, template?}` (the `/write`
skill). A denial gives only `{field, kind}` and a guidance command. Never ask
about or guess the contract's location or values.

- `template` is optional. Pass it only when the user names the template a note
  follows.
- An allowed note is saved whole. A denied write leaves the file unchanged. Read
  each `{field, kind}`, fix the content from what the user gave you, and write
  again. When you cannot fix it, ask the user. Never invent a value.
- Native Write, Edit, MultiEdit, and NotebookEdit inside the vault reach the
  same judge through the Claude write hook. The hook denies a write that breaks
  the contract. When the hook itself cannot run, it allows the write and prints
  a warning.
- `~/.oms` is off-limits. The hook denies reads, searches, and writes there as
  `control-path`. Inside the vault, `.oms/settings.json` is the only OMS file.
- OMS is not the author or repair engine. An allowed write means the note fits
  the sealed structure, not that it is worth keeping. That judgement is yours
  and the user's.

## Retrieval and health

- `/search` is read-only across lexical, vector, HyDE, and axis retrieval. It
  also returns notes that would fail the contract. It never writes or repairs.
  Unavailable backends fail loudly and are never replaced with a fake match.
- `/status` reads health. `oms contract status` and `oms contract doctor` are
  for diagnosis. They report the seal's posture and template drift without
  printing any value.
- `/doctor` runs explicit, supported index and control repairs. It never
  backfills notes. A broken or missing seal is fixed by the user running
  `oms setup`.

Seven skills share five MCP tools: `write`, `search`, `link`, `distill`,
`setup`, `status`, and `doctor`. `distill` and `setup` have no tool.
