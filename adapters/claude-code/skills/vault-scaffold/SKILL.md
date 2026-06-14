---
name: oms-vault-scaffold
description: Seeds a vault with the default taxonomy, creates a decisions/ zone, writes governance stubs, and records the per-vault .oms/taxonomy.yaml override path. All writes are additive — existing files are never overwritten.
---

# Skill: oms-vault-scaffold (Claude Code)

Seed a fresh vault with the standard OMS folder structure and governance stubs.

## Invocation

```
/oms-vault-scaffold
```

## What this skill does

Thin pointer to `core/skills/vault-scaffold`. Safe to re-run on an existing
vault — all writes are additive; existing files are never overwritten.

## Agent-guided steps (v0)

1. Read `core/ontology/taxonomy.yaml` to load the engine DEFAULT folder→concept map.
2. For each folder declared in `taxonomy.yaml`, create the directory under `vaultRoot`
   if it does not already exist.
3. Create `vaultRoot/decisions/` for human-authored structural decision records.
4. Write `vaultRoot/.oms/taxonomy.yaml` as the per-vault override path
   (initial content is a verbatim copy of the engine DEFAULT).
5. Write `vaultRoot/.oms/governance/architecture.md` stub.
6. Return the scaffold report: `created`, `skipped`, and `taxonomyZones`.

## Constraints

- Never writes outside `vaultRoot`.
- Never modifies `core/ontology/taxonomy.yaml` or `core/ontology/concepts/*.yaml`
  (Layer 1 CONTRACT files — read-only from this skill).
- `mkdir -p` semantics — missing intermediate directories are created.

## Runtime

No MCP tool required — this is a pure TypeScript call against the filesystem.
Use `overwrite: false` (default) to preserve existing files on subsequent runs.

## NOTES

Wiki mirror deferred — the `wiki` skill is built by a parallel milestone (M3)
and its adapter mirror is intentionally deferred until that milestone lands.
