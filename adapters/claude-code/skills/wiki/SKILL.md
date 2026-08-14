---
name: oms-wiki
description: Two-path wiki skill — Path A: promote compiled concepts from processed/ into the wiki/ query surface; Path B (human authoring): build interlinked terminology notes in vault taxonomy folders via capture safety rails.
---

# Skill: oms-wiki (Claude Code)

Two-path skill — thin pointer to `core/skills/wiki`. Requires `OMS_VAULT`.

## Invocation

```
/wiki
```

## Which path?

Check **before acting**:
- **Path A:** you have compiled `processed/<concept>.md` output → promote into `wiki/`.
- **Path B (human authoring):** you have only a topic + terms, no compile output → use MCP `write`, writes to vault taxonomy folders.

These paths are **mutually exclusive**.

---

## Path A — promotion

*(Only when `processed/<concept>.md` exists.)*

### Agent-guided steps

1. Verify `processed/<concept>.md` exists.
2. Load the staleness ledger from `.llmwiki/staleness.json`.
3. Promote `processed/→wiki/`, update the ledger, flip cascade backlinks,
   and detect stubs and orphans.
4. Regenerate `wiki/index.md` and append an entry to `wiki/log.md`.
5. Lint — auto-fix index consistency, broken `[[wikilinks]]`, and See-Also
   sections; report conflicts, orphans, and outdated refs.

### Staleness states

| State | Meaning |
|-------|---------|
| `CLEAN` | Compile output matches current sources |
| `DIRTY` | Source SHA changed; needs recompile |
| `STUB` | Referenced by wikilinks but no compile output exists |
| `ORPHAN` | No incoming wikilinks from any other wiki page |
| `CONFLICT` | Two compile sources produced conflicting content |

Full-rebuild escape hatch: delete `.llmwiki/staleness.json` — every page resets to DIRTY.

`processed/` is internal — NEVER synced to the Obsidian vault.
A wiki run never triggers compile; compile never writes `wiki/` directly.

---

## Path B — Human authoring

*(Only when no compiled `processed/` output exists.)*

Build a hub/MOC note plus one standalone note per coined term, cross-linked with
`[[wikilinks]]` and committed via MCP `write`.
Writes to vault taxonomy folders — **never to `wiki/`**.

### Admission gate

Apply before any MCP `write` call:
- **Coined/proper term** (only ever means one specific technical thing) → standalone note.
- **General noun** (meaning shifts by domain) → `## Term` section inside the hub note.

K8s example: `Pod`, `Service`, `Deployment`, `Ingress` → hub sections;
`ReplicaSet`, `StatefulSet`, `DaemonSet`, `CronJob` → standalone notes.

### Agent-guided steps

1. Ask for the **topic** and **term list**.
2. Resolve the **target concept/folder** from `vault/.oms/taxonomy.yaml`.
3. Apply the admission gate to every term.
4. **Deduplicate**: MCP `write` `mode: "create"` per coined term; if the note already exists, reuse the `[[wikilink]]`.
5. Draft coined-term notes (definition + `## See Also` back-link to hub). Commit terms first.
6. Draft hub/MOC note (general-noun `## Term` sections + `## See Also` coined-term links). Commit hub last.
7. Run `oms doctor` (non-blocking, exits 0).
