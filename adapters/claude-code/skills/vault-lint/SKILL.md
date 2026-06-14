---
name: oms-vault-lint
description: Checker-lane-only vault linter — enforces the Layer 1 CONTRACT (taxonomy.yaml + concepts/*.yaml) across all notes in a vault via five checks. Never mutates vault files.
---

# Skill: oms-vault-lint (Claude Code)

Verify that every markdown note in a vault conforms to its declared ontology.

## Invocation

```
/oms-vault-lint
```

## What this skill does

Thin pointer to `core/skills/vault-lint`. Runs five CONTRACT checks
(allowlist, required, type, enum, routing-law) across all notes. Read-only by
default; autofix requires explicit human-gate approval.

## Agent-guided steps (v0)

1. Load the ontology: `await loadOntology(path.join(vaultRoot, ".oms/ontology"))`.
2. Call `lintVault(vaultRoot, ontology)`.
3. If `report.clean` is false, surface `report.violations` to the user.
   **Do NOT autofix without explicit user approval.**
4. If autofix is explicitly approved, re-call with `{ autofixEnabled: true }`.
   (Autofix is a no-op in v0.1.0 — reserved for a future human-gate protocol.)

## Five checks

1. **allowlist** — no frontmatter key outside the concept's declared field list.
2. **required** — required fields must be present and non-empty.
3. **type** — values must match the declared `FieldType` (string / url / date / list / number / boolean).
4. **enum** — string fields with an `enum` array must use a listed value.
5. **routing-law** — notes in agent-writable taxonomy zones must carry `created_by`.

## Runtime

`lintVault` returns a `VaultLintReport`: `violations`, `scannedNotes`, `clean`.
No MCP tool is required — this is a pure TypeScript call against the filesystem.

## NOTES

Wiki mirror deferred — the `wiki` skill is built by a parallel milestone (M3)
and its adapter mirror is intentionally deferred until that milestone lands.
