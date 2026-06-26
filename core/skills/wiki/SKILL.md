---
name: wiki
version: 0.1.0
description: Two-path wiki skill — Path A (M3 engine): promote compiled concepts from processed/ into the wiki/ query surface, maintain the staleness ledger, and run lint; Path B (human authoring): build interlinked terminology notes directly in vault taxonomy folders via capture safety rails.
trigger: /wiki
tags: [wiki, collection, staleness, navigation, lint, second-brain, oms]
---

## wiki

Manage the wiki collection (M3 engine) and author interlinked vault notes (human authoring).

## Which path?

Determine which path applies **before acting**:

| | Path A — M3 promotion engine | Path B — Human authoring |
|---|---|---|
| **When to use** | You have compiled `processed/<concept>.md` output (M1→M2 done) | You have only a topic + terms; no compile output exists |
| **Entry point** | `runCollection()` / `promoteToWiki()` | `oms_capture_prepare` / `oms_capture_commit` |
| **Writes to** | `wiki/` (engine-managed query surface) | Vault taxonomy folders (`vault/.oms/taxonomy.yaml`) |
| **Prerequisite** | `processed/<concept>.md` must exist | None — user provides topic and term list |

These paths are **mutually exclusive and never combined in a single invocation.**

---

## Path A — M3 promotion engine

*(Use only when `processed/<concept>.md` already exists.)*

### What this skill does

1. Verify the M2 compile output exists in `processed/` for the target concept.
2. Check the staleness ledger (`.llmwiki/staleness.json`) for current state.
3. Run `runCollection()` to promote `processed/→wiki/`, update the ledger, flip cascade backlinks, detect stubs and orphans, and regenerate navigation surfaces.
4. Regenerate `wiki/index.md` (global catalog) and append an entry to `wiki/log.md`.
5. Run `runLint()` — apply auto-fixes (index consistency, broken links, See-Also) and report findings (conflicts, orphans, outdated refs) to stdout.

### 3-phase hard separation

```
Research (M1) → Compile (M2, sequential) → Wiki (read-only query surface)
```

A wiki query never triggers compile. Compile never writes `wiki/` directly.
`promoteToWiki()` in `collection.ts` is the sole entry point into `wiki/`.

**Sync boundary:** `processed/` is internal compile state and is **NEVER synced to the Obsidian vault** — only `wiki/` crosses the Obsidian sync boundary. `processed/` stays non-synced (engine-internal); `wiki/` is the synced, user-visible surface.

### Staleness states

| State | Meaning |
|-------|---------|
| `CLEAN` | Compile output matches current sources |
| `DIRTY` | Source SHA changed; needs recompile |
| `STUB` | Referenced by wikilinks but no compile output exists |
| `ORPHAN` | No incoming wikilinks from any other wiki page |
| `CONFLICT` | Two compile sources produced conflicting content |

Full-rebuild escape hatch: delete `.llmwiki/staleness.json` — every page resets to DIRTY on the next collection run.

### Lint tiers

**Auto-fix** (runs automatically, mutates `wiki/` files):
- Index consistency — page in `wiki/` but absent from `index.md`
- Internal-link correctness — broken `[[wikilinks]]` flagged
- See-Also sections — added if missing

**Report-only** (never auto-fixed without explicit `forceHumanGate` flag):
- Factual contradictions: `> **Conflict:** A claims X; B claims Y. Unresolved.`
- Orphan pages
- Outdated refs (DIRTY pages in the ledger)

### Engine

Implemented in `src/engine/wiki/`:

- `collection.ts` — `runCollection()` orchestrates the full cycle
- `ledger.ts` — 5-state FSM, `loadLedger()` / `saveLedger()` / `resetLedger()`
- `navigation.ts` — `regenerateIndex()` + `appendLog()`
- `lint.ts` — `runLint()`
- `types.ts` — local type definitions

### Example agent steps (Path A)

```
User: "Promote the Alpha concept into the wiki after compile."

1. Verify processed/alpha.md exists (Phase-B compile output)
2. Load ledger from .llmwiki/staleness.json
3. runCollection({ conceptId: "concepts/alpha.md", conceptName: "Alpha", ... })
   → promotes processed/alpha.md → wiki/alpha.md
   → marks concepts/alpha.md CLEAN in ledger
   → flips CLEAN backlinks to DIRTY
   → detects stubs (dangling wikilinks) and orphans
   → regenerates wiki/index.md and appends to wiki/log.md
4. runLint({ wikiDir, ledger }) → apply auto-fixes, print report-only findings
```

---

## Path B — Human authoring

*(Use when you have only a topic + terms and no compiled `processed/` output.)*

Build an interlinked cluster of vault notes: one hub/MOC note plus one standalone note
per coined term, cross-linked with Obsidian `[[wikilinks]]` and committed through
`oms_capture_prepare` / `oms_capture_commit`. Writes to vault taxonomy folders declared
in `vault/.oms/taxonomy.yaml` — **never to `wiki/`**.

Implements [#43](https://github.com/GoBeromsu/oh-my-second-brain/issues/43).

### Admission gate — coined terms vs general nouns

Before creating any note, apply this test to every candidate term:

> **Does the word exist in ordinary language and shift meaning by domain?**
> → Explain it as a `## Term` section inside the hub note (the hub supplies the context).
>
> **Does it only ever mean one specific technical thing — a coined or proper term?**
> → Give it its own standalone terminology note.

**Kubernetes example:**

| Term | Classification | Placement |
|------|---------------|-----------|
| `Pod` | General noun (grouping in many domains) | Section in the Kubernetes hub note |
| `Service` | General noun (a service in many domains) | Section in the Kubernetes hub note |
| `Deployment` | General noun (deploying software anywhere) | Section in the Kubernetes hub note |
| `Ingress` | General noun (network ingress is domain-agnostic) | Section in the Kubernetes hub note |
| `ReplicaSet` | Coined Kubernetes term, no prior meaning | Standalone note → `[[ReplicaSet]]` |
| `StatefulSet` | Coined Kubernetes term, no prior meaning | Standalone note → `[[StatefulSet]]` |
| `DaemonSet` | Coined Kubernetes term, no prior meaning | Standalone note → `[[DaemonSet]]` |
| `CronJob` | Coined compound, specific k8s resource type | Standalone note → `[[CronJob]]` |

Apply this gate **before** calling `oms_capture_prepare`. General-noun terms never become standalone notes.

### Agent-guided steps (Path B, v0)

1. Ask the user for the **topic** and **term list** (or extract terms from freeform source text).
2. Resolve the **target concept/folder** from `vault/.oms/taxonomy.yaml`.
3. Apply the **admission gate** to every term.
4. **Deduplicate**: call `oms_capture_prepare` per coined term; if `exists: true`, reuse the existing `[[wikilink]]` and skip creation.
5. Draft one note per coined term — frontmatter from the concept's required fields + definition + `## See Also` back-link to the hub.
6. Draft the hub/MOC note — general-noun `## Term` sections + `## See Also` listing all coined-term `[[wikilinks]]`.
7. Commit terms first, hub last, via `oms_capture_commit`.
8. Run `oms doctor` (non-blocking, exits 0).

### Example agent steps (Path B)

```
User: "Build a Kubernetes wiki: Pod, Service, Deployment, Ingress, ReplicaSet, StatefulSet, DaemonSet, CronJob"

Admission gate:
  Pod, Service, Deployment, Ingress → general nouns → hub sections
  ReplicaSet, StatefulSet, DaemonSet, CronJob → coined terms → own notes

Dedup check: oms_capture_prepare per coined term → all exist: false → proceed

→ vault/notes/software-engineering/replicaset.md    (coined, committed first)
→ vault/notes/software-engineering/statefulset.md   (coined, committed first)
→ vault/notes/software-engineering/daemonset.md     (coined, committed first)
→ vault/notes/software-engineering/cronjob.md       (coined, committed first)
→ vault/notes/software-engineering/kubernetes.md    (hub: Pod/Service/Deployment/Ingress as
                                                      sections; See Also: [[ReplicaSet]] etc.)

oms doctor  ← verify (exits 0, non-blocking)
```
