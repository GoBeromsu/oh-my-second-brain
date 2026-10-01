# Oh My Second Brain — Claude Code

The vault owns its conventions. The user seals folders, properties, and
templates once, in an interactive `oms setup` they run themselves at a terminal.
The `setup` skill may seal for them too: you ask each question, and `oms setup
--answers` seals a first or stricter contract only. Loosening a seal and
recovering a broken one stay with the user's terminal. The sealed contract lives
outside the vault, and it is not yours to read.

## Writing

Write vault notes with MCP `write {path, content, template?, ifMatch?, check?}` (the `/write`
skill). A note that breaks the contract is saved, with each finding as a
`{field, kind}` warning; only a safety refusal denies a write. A saved note
with warnings, or a denial, comes with one guidance command. Never ask about or
guess the contract's location or values.

- `template` is optional. Pass it only when the user names the template a note
  follows.
- A note is saved whole, even with warnings. A safety refusal (a path outside
  the vault, a control or unsafe path, unsupported input, a tampered contract),
  a missing or stale `ifMatch`, or an unverified target leaves the file
  unchanged. In a sealed vault, frontmatter that does not parse may be kept as
  a draft (through MCP or `oms write`) instead of saved; otherwise it is saved
  with a `yaml-syntax` warning. Read each `{field, kind}`, fix the content from
  what the user gave you, and write again. When you cannot fix it, ask the
  user. Never invent a value.
- Native Write, Edit, MultiEdit, and NotebookEdit inside the vault reach the
  same judge through the Claude write hook. The hook denies only a safety
  refusal; it allows a write with contract findings and returns them as a
  warning. When the hook itself cannot run, it allows the write and prints a
  warning.
- `~/.oms` is off-limits. The hook denies reads, searches, and writes there as
  `control-path`. Inside the vault, `.oms/settings.json` is the only OMS file.
- OMS is not the author or repair engine. An allowed write with no warnings
  means the note fits the sealed structure, not that it is worth keeping. That
  judgement is yours and the user's.

## Retrieval and health

- `/search` is read-only across lexical, vector, HyDE, and axis retrieval. It
  also returns notes that would fail the contract. It never writes or repairs.
  Unavailable backends fail loudly and are never replaced with a fake match.
- `/doctor status` reads health, and `/doctor link-check` checks a note's
  wikilinks; both are read-only. `oms doctor status`, `oms setup status`, and
  `oms doctor contract` are for diagnosis. They report the seal's posture and
  template drift without printing any value.
- `/search link` suggests wikilinks for a note; you apply only the ones the
  user accepts.
- `/interview` continues the vault interview: it lists open questions, records
  the user's answers, and seals only a proposal the user confirmed.
- `/doctor` runs explicit, supported index and control repairs. It never
  backfills notes. A missing seal is sealed by the user running `oms interview`;
  a broken one is checked with `oms doctor contract`.

Six skills share four MCP tools: `write`, `search`, `interview`, `distill`,
`setup`, and `doctor`. `distill` and `setup` have no tool.
