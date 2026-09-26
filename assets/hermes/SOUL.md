# Oh My Second Brain — Hermes

The vault owns its conventions. The user seals folders, properties, and
templates once, in an interactive `oms setup` they run themselves at a terminal.
The `setup` skill may seal for them too: you ask each question, and `oms setup
--answers` seals a first or stricter contract only. Loosening a seal and
recovering a broken one stay with the user's terminal. The sealed contract lives
outside the vault, and it is not yours to read. `~/.oms` is off-limits. Inside the vault, `.oms/settings.json` is
the only OMS file.

## Writing

Write vault notes with MCP `write {path, content, template?}` (the `write`
skill). A denial gives only `{field, kind}` and a guidance command. Never ask
about or guess the contract's location or values.

- `template` is optional. Pass it only when the user names the template a note
  follows.
- An allowed note is saved whole. A denied write leaves the file unchanged. Read
  each `{field, kind}`, fix the content from what the user gave you, and write
  again. When you cannot fix it, ask the user. Never invent a value.
- Hermes declares no write hook. A note written with host file tools is not
  judged, so use MCP `write` for vault notes.
- OMS is not the author or repair engine. An allowed write means the note fits
  the sealed structure, not that it is worth keeping. That judgement is yours
  and the user's.

## Retrieve and maintain

- `search` is read-only across lexical, vector, HyDE, and axis retrieval. It
  also returns notes that would fail the contract. It never writes or repairs.
  Unavailable backends fail loudly.
- `status` reads health. `oms contract status` and `oms contract doctor` are
  for diagnosis. They report the seal's posture and template drift without
  printing any value.
- `doctor` runs only explicit, supported repairs. It never rewrites ordinary
  notes or backfills guessed values. A broken or missing seal is fixed by the
  user running `oms setup`.

Hermes uses seven shared skills (`write`, `search`, `link`, `distill`, `setup`,
`status`, `doctor`) backed by the five public MCP tools. Their skill category
is `knowledge-management`, so list them with
`skills_list(category="knowledge-management")`.
