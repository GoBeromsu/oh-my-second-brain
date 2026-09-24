# Oh My Second Brain for Codex

Use the vault's own guidelines and the published `.oms/template-policy.json`
contract. Its version-5 document owns the property pool, the always-on common
contract that needs no Markdown file, and each explicitly registered template. A
registration inherits the common contract and may also relax it where the user
approved that. `.oms/taxonomy.json` owns placement meaning. `.obsidian/types.json`
is read-only diagnostic input; `.oms/types.json` is a historical version-4 file
that version 5 neither derives nor reads.

| User intent | Preferred surface |
|---|---|
| setup or change contracts | tool-less `$oms-interview`, with an explained diff and user approval |
| inspect templates | `$oms-template` |
| install host integration | `oms host install --runtime codex --vault <path> --yes`, only when authorized |
| write a note | `$oms-write`: guide → agent file write → check on the saved bytes |
| retrieve knowledge | `$oms-search`; no validation or repair side effects |
| inspect health | `$oms-status` |
| explicit supported control/index repair | `$oms-doctor` |

## Boundaries

- Agents write and repair notes; OMS checks the actual saved bytes.
  Do not use retired OMS note-write, link-apply, backfill, or complete operations.
- `check` reports declared properties and headings and returns
  `semantic: "not-evaluated"`. There is no OMS completion call and no reviewer
  handshake: you judge whether the note is worth keeping and you own the repair.
- Read a reported violation, fix the file with your own tools, and check again.
  Never weaken the contract to pass, and never invent a missing value.
- Automatic repair defaults off and stays within explicit scope and the user's
  finite retry budget. Contract changes require approval, not an automatic fix.
- Search/status stay read-only; invalid, unbound and incomplete notes remain
  searchable. Preserve requested backend failure semantics without substitutes.
- Use approved placement or ask; do not invent a folder or template requirement.
- Uninstall removes only owned integration assets, never vault notes or `.oms/`.

A returned source-change notice initially reads exactly `템플릿에 변경이 있습니다`
with `확인하기` and `나중에`. Deferral has no server-side effect. Explicit review
runs `review-sources`; a changed source is acknowledged with its live digest, or
relinked only when the original is genuinely gone and the user spells out the
candidate path. A changed hash is drift evidence, never approval, and you never
self-approve a publication. Ordinary writing questions and search do not
automatically start the interview.
