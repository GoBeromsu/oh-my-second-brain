---
name: oms-link
description: Two-path note-linking skill — Path A (pre-write): compose a new note body that already carries [[wikilinks]] to existing term notes; Path B (retrofit): add missing links to existing notes via oms linkify or oms_link_apply.
---

# Skill: oms-link (Claude Code)

Two-path skill — thin pointer to `core/skills/link`. Requires `OMS_VAULT`.

## Invocation

```
/link
```

## Which path?

Check **before acting**:
- **Path A (pre-write):** you are about to write the note → learn the term
  vocabulary first, then draft a body that already contains `[[wikilinks]]`.
- **Path B (retrofit):** the note already exists → `oms linkify` or
  MCP `oms_link_suggest` → `oms_link_apply`.

These paths are **mutually exclusive**.

## The link universe

Only notes bound to the `term` concept in `vault/.oms/taxonomy.yaml` are link
targets; their surface forms are the basename and the frontmatter `aliases`.
`0 term note(s) available as link targets` means the vault has no term layer —
build one with the `wiki` skill first.

Three engine rules, not negotiable:
- **Surface-anchored** — a link exists only where the term literally appears.
- **First occurrence only** — one link per target note per body.
- **Ambiguity is reported, never resolved** — `ambiguous: true` plus `rivalPaths`
  means ask the user or skip the span.

Frontmatter, code, existing links, headings, URLs, and tags are masked out; a
"missing" link inside any of them is correct.

---

## Path A — pre-write linking

*(Only while drafting, so no retrofit pass is ever needed for this note.)*

### Agent-guided steps

1. Call MCP `oms_link_suggest` on an existing note in the same folder (or
   `oms linkify --folder <folder>` in report mode) and read the `targetPath`
   list — that is the vault's current term vocabulary.
2. Draft the body with those exact surface forms, writing `[[wikilinks]]` inline
   at the first mention of each term.
3. Commit via MCP `write`. Host `Write`/`Edit` never touches vault `.md`.
4. Re-check with `oms_link_suggest`; zero candidates means the draft was already
   fully linked.

---

## Path B — retrofit existing notes

*(Only when the note is already on disk. Report first, always.)*

### Batch

```bash
oms linkify --folder notes                  # report only, writes nothing
oms linkify --folder notes --apply --yes    # rewrite in place
```

`--apply` without `--yes` refuses before reading any note and writes nothing.
Show the report and get agreement before adding `--yes`. Writes go through the
capture kernel, so path safety and the concept contract hold.

### Single note

1. `oms_link_suggest { notePath, folder? }` → candidates + `baseContentHash`.
2. Present the candidates; drop ambiguous ones the user does not resolve.
3. `oms_link_apply { notePath, baseContentHash, candidateIds, folder? }` — pass
   back the same `baseContentHash` and the same `folder` scope.

`oms_link_apply` refuses without writing on `note-changed`, `candidate-drift`,
or overlapping candidates. Re-run `oms_link_suggest` for fresh offsets instead
of retrying stale ids.

After a retrofit run, run `oms doctor` (non-blocking, exits 0).
