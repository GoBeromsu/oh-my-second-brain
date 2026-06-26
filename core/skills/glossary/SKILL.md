---
name: glossary
description: Build an interlinked glossary in the vault — a hub/MOC note plus one note per coined term, cross-linked with Obsidian [[wikilinks]] and routed through the capture safety rails.
---

# Skill: glossary

Build a cluster of interlinked vault notes from a topic + term list: one hub/MOC note
plus one standalone note per coined term, all cross-linked with `[[wikilinks]]` and
committed through `oms_capture_prepare` / `oms_capture_commit`.

Implements [#43](https://github.com/GoBeromsu/oh-my-second-brain/issues/43).

## Entry point

```bash
oms glossary
```

Roadmap: interactive runtime not yet implemented.
In v0, use `glossary` as **agent-guided term-set authoring** until the CLI ships.

## Admission gate — coined terms vs general nouns

Before creating any note, apply this test to every candidate term:

> **Does the word exist in ordinary language and shift meaning by domain?**
> → Explain it as a section inside the hub note (the hub supplies the context).
>
> **Does it only ever mean one specific technical thing — a coined or proper term?**
> → Give it its own standalone note.

**Kubernetes example:**

| Term | Type | Placement |
|------|------|-----------|
| `Pod` | General noun — a grouping in many domains | Section in the Kubernetes hub note |
| `Service` | General noun — a service in many domains | Section in the Kubernetes hub note |
| `Deployment` | General noun — deploying software anywhere | Section in the Kubernetes hub note |
| `Container` | General noun — containers exist outside k8s | Section in the Kubernetes hub note |
| `ReplicaSet` | Coined Kubernetes term, no prior meaning | Standalone note → `[[ReplicaSet]]` |
| `StatefulSet` | Coined Kubernetes term, no prior meaning | Standalone note → `[[StatefulSet]]` |
| `DaemonSet` | Coined Kubernetes term, no prior meaning | Standalone note → `[[DaemonSet]]` |
| `CronJob` | Coined compound, specific k8s resource type | Standalone note → `[[CronJob]]` |

Apply this gate **before** calling `oms_capture_prepare`. General-noun terms never become
top-level notes; they become `## Term` sections in the hub and may link to coined-term
notes where relevant.

## What this skill does (agent-guided, v0)

1. Ask the user: what **topic** is the glossary for? (e.g. `Kubernetes`, `Transformer Architecture`)
2. Ask: what is the **term list**? (explicit list, or extract from freeform source text)
3. Resolve the **target concept/folder** from `vault/.oms/taxonomy.yaml` — the folder
   whose declared `intent` matches this knowledge domain (e.g. `software-engineering`, `ai`).
4. Apply the **admission gate** to every term: classify each as coined-term (→ own note)
   or general-noun (→ hub section).
5. **Deduplicate**: for each coined term, call `oms_capture_prepare` and inspect the
   returned `exists` flag — if a note already exists at the target path, skip creation
   and reuse the existing `[[wikilink]]` instead.
6. Draft the **hub/MOC note**:
   - Frontmatter from the concept's declared fields (all `required: true` filled).
   - Body: one `## Term` section per general-noun term, with a brief definition.
   - A `## See Also` section listing `[[wikilinks]]` to all coined-term notes.
7. Draft **one note per coined term**:
   - Frontmatter from the concept's declared fields.
   - Body: definition + a `## See Also` section linking back to the hub and to
     related coined-term notes.
8. Route each note through `oms_capture_prepare` → review → `oms_capture_commit`
   (path confinement, vault-only, `.md`-only, contract validation).
9. Run `oms doctor` (non-blocking, exits 0) after all notes are committed.

## Engine

Reuses the existing capture engine in `src/capture/safe.ts` via two MCP tools:

- **`oms_capture_prepare`** — resolves the target path and constructs the proposed
  frontmatter/body without writing. Also returns an `exists` flag used for deduplication.
  Call once per note; review before committing.
- **`oms_capture_commit`** — writes to disk. Gated by vault confinement, non-`.md` rejection,
  `.oms/` exclusion, and warn-only frontmatter validation.

No new engine code is needed for v0 — `glossary` is a multi-call choreography of
`capture` primitives, guided by the admission-gate classification.

## Example agent steps

```
User: "Build a Kubernetes glossary for: Pod, Service, Deployment, ReplicaSet, StatefulSet, DaemonSet"

1. topic   = Kubernetes
2. terms   = [Pod, Service, Deployment, ReplicaSet, StatefulSet, DaemonSet]
3. concept = software-engineering  (matches folder: notes/software-engineering/)

4. Admission gate:
   - Pod, Service, Deployment → general nouns → hub sections
   - ReplicaSet, StatefulSet, DaemonSet → coined terms → own notes

5. Deduplicate:
   - oms_capture_prepare(path=".../replicaset.md") → exists: false → proceed
   - oms_capture_prepare(path=".../statefulset.md") → exists: false → proceed
   - oms_capture_prepare(path=".../daemonset.md") → exists: false → proceed

6. Hub note: kubernetes.md
     ---
     title: "Kubernetes"
     tags: [glossary, kubernetes, software-engineering]
     captured-at: "2026-06-26"
     ---
     ## Pod
     A Pod is the smallest deployable unit in Kubernetes...
     ## Service
     A Service exposes a set of Pods as a network endpoint...
     ## Deployment
     A Deployment manages a desired state for a set of Pods...
     ## See Also
     [[ReplicaSet]] · [[StatefulSet]] · [[DaemonSet]]

7. Term notes: replicaset.md, statefulset.md, daemonset.md
     Each contains definition + "## See Also" back-link to [[Kubernetes]]

8. Commit all notes via oms_capture_commit (hub last, after terms exist)

9. oms doctor  ← verify (exits 0, non-blocking)
```

## Persona

Use the **librarian** agent persona for this skill (`core/agents/librarian.md`).
