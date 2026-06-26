---
name: oms-glossary
description: Build an interlinked glossary in the vault — hub/MOC note plus one note per coined term, cross-linked with [[wikilinks]], routed through capture safety rails.
---

# Skill: oms-glossary (Claude Code)

Build a cluster of interlinked vault notes from a topic + term list.

## Invocation

```
/oms-glossary
```

## What this skill does

Thin pointer to `core/skills/glossary`. Requires `OMS_VAULT`.

Apply the **admission gate** before any `oms_capture_prepare` call:
general nouns (meaning shifts by domain) → explain as sections in the hub note;
coined/proper terms (only ever mean one thing) → standalone note with `[[wikilink]]`.

## Agent-guided steps (v0)

1. Ask the user for the **topic** and **term list** (or extract terms from freeform text).
2. Resolve the **target concept/folder** from `vault/.oms/taxonomy.yaml`.
3. Classify each term with the admission gate: coined term → own note; general noun → hub section.
4. **Deduplicate**: call `oms_capture_prepare` per coined term; if `exists: true`, reuse the
   existing `[[wikilink]]` and skip creation.
5. Draft the **hub/MOC note** — general-noun sections + `## See Also` links to coined-term notes.
6. Draft one note per coined term — definition + `## See Also` back-link to the hub.
7. Commit each note through `oms_capture_commit` (terms first, hub last).
8. Shell out: `oms doctor` (non-blocking, exits 0).

## Example

```
Input: "Kubernetes glossary — Pod, Service, ReplicaSet, StatefulSet"

Admission gate:
  Pod, Service → general nouns → hub sections
  ReplicaSet, StatefulSet → coined terms → own notes

→ vault/notes/software-engineering/replicaset.md        (coined)
→ vault/notes/software-engineering/statefulset.md       (coined)
→ vault/notes/software-engineering/kubernetes.md        (hub + Pod/Service sections)
```

## Runtime

Reuses `oms_capture_prepare` / `oms_capture_commit` from `src/capture/safe.ts`.
No new engine paths. See `core/skills/glossary/SKILL.md` for the full admission-gate
table and example agent steps.
