# Oh My Second Brain Convention Shim — Codex

<!-- Append this block to a project's AGENTS.md to activate Oh My Second Brain conventions in Codex. -->

## Vault authority

The vault owns its conventions. The user seals folders, properties, and
templates once, in an interactive `oms setup` they run themselves at a terminal.
The `setup` skill may seal for them too: you ask each question, and `oms setup
--answers` seals a first or stricter contract only. Loosening a seal and
recovering a broken one stay with the user's terminal. The sealed contract lives
outside the vault, and it is not yours to read. `~/.oms` is off-limits. Inside the vault, `.oms/settings.json` is
the only OMS file.

## Writing

Write vault notes with MCP `write {path, content, template?, ifMatch?, check?}` (`$oms-write`). A
note that breaks the contract is saved, with each finding as a `{field, kind}`
warning; only a safety refusal denies a write. A saved note with warnings, or a
denial, comes with one guidance command. Never ask about or guess the
contract's location or values.

- `template` is optional. Pass it only when the user names the template a note
  follows.
- A note is saved whole, even with warnings. A safety refusal (a path outside
  the vault, a control or unsafe path, unsupported input, a tampered contract),
  a missing or stale `ifMatch`, or an unverified target leaves the file
  unchanged. In a sealed vault, frontmatter that does not parse may be kept as
  a draft instead of saved; otherwise it is saved with a `yaml-syntax`
  warning. Read each `{field, kind}`, fix the content from
  what the user gave you, and write again. When you cannot fix it, ask the
  user. Never invent a value.
- Codex declares no write hook. A note written with host file tools is not
  judged, so use MCP `write` for vault notes.
- OMS is not the author or repair engine. An allowed write with no warnings
  means the note fits the sealed structure, not that it is worth keeping. That
  judgement is yours and the user's.

## Read-only work and health

- `$oms-search` is read-only across lexical, vector, HyDE, and axis retrieval.
  It also returns notes that would fail the contract. It never writes or
  repairs. Unavailable backends fail loudly and are never replaced with a fake
  match.
- `$oms-doctor` reads health (`op: status`) and checks wikilinks
  (`op: link-check`). `oms setup status` and `oms doctor contract`
  are for diagnosis. They report the seal's posture and template drift without
  printing any value.
- `$oms-doctor` runs explicit, supported index and control repairs. It never
  backfills notes. A missing seal is sealed by the user running `oms interview`;
  a broken one is checked with `oms doctor contract`.

Codex installs six shared skills (`write`, `search`, `interview`, `distill`,
`setup`, `doctor`) backed by the four public MCP tools.
