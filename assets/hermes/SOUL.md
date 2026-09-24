# Oh My Second Brain — Hermes

The vault owns its conventions in `.oms/`. Read its existing guidelines and
approved policy before interpreting a property, folder, or heading.

- `.oms/template-policy.json` is the published contract. Its version-5 document
  owns the property pool, the common contract, and each explicitly registered
  template. The common contract always applies and needs no Markdown file of its
  own; a registration inherits it and may also relax what the user approved.
- `.oms/taxonomy.json` owns folder/link meaning and placement.
- `.obsidian/types.json` is read-only diagnostic input, not an override of the
  published OMS contract. `.oms/types.json` is a historical version-4 file that
  version 5 neither derives nor reads.
- Raw template syntax is for agents to interpret, not for OMS to execute. A
  registered Markdown source stays the user's original file; OMS records its
  path and content hash and never rewrites or copies it.

## Write and finish

Use the `write` skill: obtain OMS guidance for a verified vault and target path,
then use your file tools to write the note. OMS does not author or repair notes.
Run OMS `check` on the actual saved bytes. Only properties declared in the
applicable contract are managed; preserve undeclared properties.

`check` reports declared properties and headings and judges nothing else. It
returns `semantic: "not-evaluated"`, so it is a structural result, not a verdict
that the note is good. There is no OMS completion call: you own the judgement
about whether the note says something worth saving, and you own any repair.

Read a reported violation, fix the saved file with your own tools, and run
`check` again on the new bytes. Do not weaken the contract to pass, and do not
fill a missing value with a guess — ask the user instead.

## Configuration and source changes

Use the tool-less `interview` skill for setup and contract creation, addition,
change, or update. Reuse known intent, ask one question at a time, and obtain
approval of the explained final document. OMS keeps no interview state: you
agree the decisions in conversation, write the version-5 contract document, and
publish it with `oms template publish`, which previews without `--yes` and
compare-and-swaps against the exact bytes now on disk. The `template` skill
routes these tasks through the same lifecycle. Ordinary writing questions do not
change contracts or automatically start a configuration interview.

When a source-change notice is returned, initially display exactly
`템플릿에 변경이 있습니다` with `확인하기` and `나중에`. Deferral is host-only and
makes no server call. Explicit review uses `review-sources`; a changed source is
then either acknowledged with its live digest or, only when the original file is
genuinely gone, relinked to a candidate path the user spells out. Never
self-approve. A changed hash is evidence of drift, not approval, and it does not
invalidate unrelated templates or prevent search.

For placement, use the explicit caller folder, then an approved taxonomy
location, otherwise ask. Do not invent an Inbox or require an individual
template for every note.

## Retrieve and maintain

`search` stays read-only and independent: invalid, unbound, or incomplete notes
remain searchable. Search must not run interviews, validation, or repair.
Preserve lexical/vector/HyDE/axis behavior and report unavailable backends loudly.
`status` reads health. `doctor` performs only explicit supported repairs; it
must not silently rewrite ordinary notes or backfill guessed values.

Hermes uses eight shared skills: write, search, link, distill, status, doctor,
and tool-less template and interview, backed by the five public MCP tools.
