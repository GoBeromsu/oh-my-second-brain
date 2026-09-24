# Oh My Second Brain Convention Shim — Codex

<!-- Append this block to a project's AGENTS.md to activate Oh My Second Brain conventions in Codex. -->

## Vault authority

The vault owns its guidelines and `.oms/` policy. Reuse that intent rather than
assigning product-wide meaning to a field, folder, or heading.

- `.oms/template-policy.json` is the published contract. Its version-5 document
  owns the shared property pool, the always-on common contract (which needs no
  Markdown file of its own), and each explicitly registered template. A
  registration is optional, inherits the common contract, and may also relax it
  where the user approved that relaxation.
- `.oms/taxonomy.json` owns folder/link meaning and placement.
- `.obsidian/types.json` is read-only diagnostic input; the published contract
  governs checks. `.oms/types.json` is a historical version-4 projection that
  version 5 neither derives nor reads.
- Agents interpret template syntax. OMS neither renders templates nor writes
  ordinary notes. A registered source stays the user's own Markdown file: OMS
  records its path and content hash and never rewrites or snapshots it.

## Write and check

Use `$oms-write`: obtain OMS `guide` for the verified target, write with host
file tools, then run `check` on the saved bytes through the returned session
locator. Preserve undeclared properties; ask rather than invent unknown values.
Choose placement explicitly or from approved taxonomy, otherwise ask. Never
invent an Inbox or require template registration for every note.

`check` reports declared properties and headings and returns
`semantic: "not-evaluated"`. It is structural evidence, not a verdict that the
note is worth keeping. There is no OMS completion call and no reviewer
handshake: you judge the note and you own the repair. Read a reported violation,
fix the file with your own tools, and run `check` again on the new bytes.

Never weaken the contract to pass. Automatic repair defaults off, and an enabled
repair remains agent-owned, context-scoped and bounded by the user's retry
budget. Ordinary note questions must not silently change the contract.

## Configuration and read-only work

Use tool-less `$oms-interview` for setup and contract creation/addition/change/
update. `$oms-template` routes these tasks through the same lifecycle. Read known
intent first, ask one question at a time, and obtain explicit approval of the
explained final document. OMS keeps no interview state: agree the decisions,
write the version-5 contract document, and publish it with `oms template
publish`, which previews without `--yes` and compare-and-swaps against the exact
bytes now on disk. Never self-approve.

Initially display a returned source-change notice exactly as
`템플릿에 변경이 있습니다` with `확인하기` and `나중에`. Deferral is host-only,
with no server call. Explicit review runs `review-sources`; a changed source is
acknowledged with its live digest, or relinked only when the original file is
genuinely gone and the user spells out the candidate path. A changed hash is
drift evidence, never approval, and unrelated templates and search stay
available.

`$oms-search` is read-only and includes invalid, unbound and incomplete notes;
it must not start validation, repair or interview. Preserve lexical/vector/HyDE/
axis behavior and fail loudly when the requested backend is unavailable.
`$oms-status` reads health; `$oms-doctor` handles explicit supported control/index
repairs, not ordinary-note backfill. Codex installs eight shared skills: write,
search, link, distill, status, doctor, and tool-less template and interview.
