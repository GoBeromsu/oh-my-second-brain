---
name: oms-link
description: Two-path note-linking skill — Path A (pre-write): compose a new note body that already carries [[wikilinks]] to existing term notes; Path B (retrofit): add missing links to existing notes via oms linkify or oms_link_apply.
---

# oms-link

Thin pointer to `core/skills/link`. Requires `OMS_VAULT`.

Determine which path applies before acting. These paths are **mutually exclusive**.

Link targets are ONLY notes bound to the `term` concept in `vault/.oms/taxonomy.yaml`; their surface forms are the basename and the frontmatter `aliases`. Three engine rules hold in both paths: a link exists only where the term literally appears (surface-anchored, never invented by retrieval); first occurrence per target note only; ambiguity (`ambiguous: true` + `rivalPaths`) is reported and never auto-resolved — ask the user or skip the span. Frontmatter, code, existing links, headings, URLs, and tags are masked out, so a "missing" link inside any of them is correct.

## Path A — pre-write linking

*(Use while drafting, so the note lands already linked and needs no retrofit.)*

1. Call MCP `oms_link_suggest` on an existing note in the same folder (or run `oms linkify --folder <folder>` in report mode) and read the `targetPath` list — that is the vault's current term vocabulary.
2. Draft the body with those exact surface forms, writing `[[wikilinks]]` inline at the first mention of each term.
3. Commit via MCP `write`. Host file edits never touch vault `.md`.
4. Re-check with `oms_link_suggest`: zero candidates means the draft was already fully linked.

NOTE: `0 term note(s) available as link targets` means the vault has no term layer yet — build one with the `oms-wiki` skill first.

## Path B — retrofit existing notes

*(Use when the note is already on disk. Report first, always.)*

1. `oms linkify --folder <folder>` — report only, writes nothing.
2. Show the report and get agreement before mutating anything.
3. Whole folder → `oms linkify --folder <folder> --apply --yes`. `--apply` without `--yes` refuses before reading any note and writes nothing.
4. Per-note acceptance → `oms_link_suggest { notePath, folder? }` returns candidates plus `baseContentHash`; drop unresolved ambiguous ones; then `oms_link_apply { notePath, baseContentHash, candidateIds, folder? }` with the SAME `baseContentHash` and the SAME `folder` scope.
5. Run `oms doctor` after a retrofit run (non-blocking, exits 0).

NOTE: `oms_link_apply` refuses without writing on `note-changed`, `candidate-drift`, or overlapping candidates. Re-run `oms_link_suggest` for fresh offsets instead of retrying stale ids. Every write — CLI or MCP — goes through the capture kernel, so path safety and the concept contract hold.
