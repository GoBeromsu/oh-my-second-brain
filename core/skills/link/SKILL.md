---
name: link
version: 0.1.0
description: Two-path note-linking skill — Path A (pre-write): compose a new note body that already carries [[wikilinks]] to existing term notes; Path B (retrofit): add missing links to notes that already exist, via oms linkify or oms_link_apply.
trigger: /link
tags: [link, wikilink, linkify, term, backlink, second-brain, oms]
---

## link

Keep the vault interlinked. There is no autolink daemon — follow this recipe as
the agent. Requires `OMS_VAULT` (or a resolved vault target).

## Which path?

Determine which path applies **before acting**:

| | Path A — pre-write | Path B — retrofit |
|---|---|---|
| **When to use** | You are about to write or rewrite a note | The note already exists on disk |
| **Entry point** | MCP `oms_link_suggest` on a sibling note, then MCP `write` | `oms linkify` (report) → `oms linkify --apply --yes`, or MCP `oms_link_suggest` → `oms_link_apply` |
| **Writes to** | The new note only | Existing notes in scope |
| **Prerequisite** | Term notes exist to link at | Term notes exist to link at |

These paths are **mutually exclusive and never combined in a single invocation.**

---

## The link universe — term notes only

A link target is a note bound to the `term` concept in `vault/.oms/taxonomy.yaml`.
Notes bound to any other concept are never proposed as targets, in either path.
Surface forms of a target are its **basename** and its frontmatter **`aliases`**.

If a run reports `0 term note(s) available as link targets`, the vault has no
term layer yet — build one with the `wiki` skill (Path B) first. Linking is not
the tool that creates vocabulary; it is the tool that connects it.

## Three rules the engine enforces — do not fight them

1. **Surface-anchored.** A candidate exists only because the term's basename or
   alias literally appears in the note. Retrieval never invents a link. Do not
   hand-add a `[[link]]` to a note whose title does not appear in the text —
   write the sentence that mentions it instead.
2. **First occurrence only.** One link per target note per body. A term linked
   ten times is noise, not navigation.
3. **Ambiguity is reported, never auto-resolved.** When 2+ notes claim one span,
   the candidate carries `ambiguous: true` and every `rivalPaths` entry. Ask the
   user which note is meant, or skip the span. Never guess.

Protected regions are masked out before matching: frontmatter, fenced and inline
code, existing wikilinks and markdown links, image embeds, HTML, headings, URLs,
block ids, and tags. A "missing" link inside any of those is correct behavior.

---

## Path A — pre-write linking

*(Use while drafting. The goal is that the body arrives on disk already linked,
so no retrofit pass is ever needed for this note.)*

### Agent-guided steps

1. Establish the vocabulary **before** drafting: call MCP `oms_link_suggest` on
   an existing note in the same folder (or run `oms linkify --folder <folder>`
   in report mode) and read the `targetPath` list. That list IS the vault's
   current term vocabulary.
2. Draft the body using those exact surface forms, and write `[[wikilinks]]`
   inline as you compose — first mention of each term only.
3. Commit through MCP `write`. Host `Write`/`Edit` never touches vault `.md`.
4. Re-check with `oms_link_suggest` on the committed note. Zero candidates means
   the draft was already fully linked; remaining candidates are terms you missed.

### Example agent steps (Path A)

```
User: "Write a note about our retrieval pipeline."

1. oms_link_suggest { notePath: "notes/software-engineering/indexing.md" }
   → targets: notes/terms/embedding.md, notes/terms/reranker.md, notes/terms/chunk.md
2. Draft body mentioning embedding / reranker / chunk, each first mention
   written as [[embedding]], [[reranker]], [[chunk]]
3. write { mode: "create", notePath: "notes/software-engineering/retrieval-pipeline.md", ... }
4. oms_link_suggest on the new note → 0 candidates ✓
```

---

## Path B — retrofit existing notes

*(Use when the note is already on disk. Report first, always.)*

### Batch — `oms linkify` (whole vault or one folder)

```bash
oms linkify --folder notes          # report only, writes nothing
oms linkify --folder notes --apply --yes   # rewrite in place
```

`--apply` without `--yes` refuses before reading a single note and writes
nothing. Show the user the report and get agreement before adding `--yes`.
Every write still goes through the capture kernel, so path safety and the
concept contract hold exactly as they do for MCP `write`.

### Single note — `oms_link_suggest` → `oms_link_apply`

Use when the user wants to accept some candidates and reject others:

1. `oms_link_suggest { notePath, folder? }` → candidates + `baseContentHash`.
2. Present the candidates; drop ambiguous ones the user does not resolve.
3. `oms_link_apply { notePath, baseContentHash, candidateIds, folder? }` —
   pass back the **same** `baseContentHash` and the **same** `folder` scope.

`oms_link_apply` refuses without writing when the note changed since the
suggest call (`note-changed`), when a candidate's text moved (`candidate-drift`),
or when accepted candidates overlap. A refusal is a correct outcome: re-run
`oms_link_suggest` for fresh offsets rather than retrying the stale ids.

### Example agent steps (Path B)

```
User: "Link up the notes I wrote last week."

1. oms linkify --folder notes            ← report only
   → 14 candidate(s) across 9 note(s); 2 marked ambiguous
2. Show the report; ask which note the 2 ambiguous spans mean
3. Accepted whole folder → oms linkify --folder notes --apply --yes
   Accepted per-note → oms_link_suggest → oms_link_apply with the chosen ids
4. Run `oms doctor` (non-blocking, exits 0)
```
