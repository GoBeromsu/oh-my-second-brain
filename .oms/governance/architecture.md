---
slug: governance-architecture
date: 2026-06-13
created_by: claude-code
governing-adr: ADR-006-oms-governance-contract-separation
status: active
type: architecture
---

# .oms Governance — Living Architecture Map

This document is the living structure map of the `.oms/` dotfolder.
It describes *what* exists here and *why* the two-layer separation is maintained.
Update it (supersede entries, never delete) whenever the vault structure changes.

## Two-Layer Topology (ADR-006)

The `.oms/` dotfolder holds two fundamentally different asset types.
They must never be mixed: one is parsed by machines, the other is read by humans.

```
.oms/
├── taxonomy.yaml              # Layer 1 CONTRACT — folder→intent→concept map (SSOT for name validation)
├── concepts/*.yaml            # Layer 1 CONTRACT — per-note-type frontmatter field declarations
├── schemas/                   # Layer 1 CONTRACT — frontmatter schemas (machine-parsed enforcement targets)
├── cache/                     # GITIGNORED — derived graph.json / embedding artifacts (never committed)
└── governance/                # Layer 2 GOVERNANCE — human intent records (this subtree)
    ├── architecture.md        # This file — living vault structure map
    ├── decisions/             # Vault-scoped ADRs: why this folder structure, when it changed
    └── rules/                 # Living operational rules: what is enforced, how
```

## Layer 1 — Machine-Validated CONTRACT

**Character**: Present-tense declarations. The machine asks "is only the intended key present with the correct value?" Enforcement target for `vault-lint` (R9) and `oms_validate_contract` (capture gate).

**Contents**:
- `taxonomy.yaml` — maps vault folders to intent strings and concept names. The SSOT for folder-name validation. Changing a folder name requires editing this file first.
- `concepts/*.yaml` — per-note-type field declarations (name, type, required, enum, intent). The schema that `vault-lint` runs against every note's frontmatter.
- `schemas/` — JSON-Schema-compatible YAML schemas (see `core/ontology/schemas/` for the repo-level authoring source; vault installs a copy here at setup time).

**Authoring lane**: checker lane. A change here is a schema edit (declarative update). Prose rationale for *why* the schema changed belongs in Layer 2, not here.

## Layer 2 — Human Intent GOVERNANCE

**Character**: Historical records. Answers *why* this structure exists and *when* it changed. Updated by supersede only — no deletions.

**Contents**:
- `governance/architecture.md` (this file) — vault structure map. Edited in-place as the vault evolves; old structure descriptions are annotated rather than erased.
- `governance/decisions/ADR-NNN-*.md` — cross-cutting vault decisions (folder changes, policy shifts, concept additions with rationale). Modelled on the `craft-skills documents` ADR convention. Each decision is recorded once and superseded by a later ADR if overridden.
- `governance/rules/*.md` — living operational rules (what is enforced, how). May be amended but never silently deleted.

**Authoring lane**: author lane. The `vault-decision-record` skill family writes here. `vault-lint` never touches this subtree.

## Separation Invariants

1. Layer 1 files are YAML parsed by code. They contain no prose, no rationale, no history.
2. Layer 2 files are Markdown read by humans. They contain no machine-enforced declarations.
3. `vault-lint` enforces Layer 1 only. It does not parse or validate Layer 2 prose.
4. `vault-decision-record` writes to Layer 2 only. It does not edit taxonomy or concept schemas.
5. `.oms/cache/` is gitignored unconditionally. No cache artifact is ever committed.
6. Everything else under `.oms/` is committed (ADR-006 §Decision).

## Vault Installation Note

At setup time, `vault-scaffold` seeds both layers for a specific vault:
- Copies `core/ontology/schemas/` → vault `.oms/schemas/`
- Generates `taxonomy.yaml` and `concepts/*.yaml` from the setup interview answers
- Creates `governance/architecture.md` (vault-specific version of this file)
- Leaves `governance/decisions/` and `governance/rules/` empty (populated as the vault evolves)

The *boundary* between the two layers is fixed. The *contents* are vault-specific (Non-Sticky, ADR-006 §Non-Sticky).
