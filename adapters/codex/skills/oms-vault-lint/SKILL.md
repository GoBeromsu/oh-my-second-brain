---
name: oms-vault-lint
description: Checker-lane-only vault linter — enforces the Layer 1 CONTRACT (taxonomy.yaml + concepts/*.yaml) via five checks. Never mutates vault files.
---

# oms-vault-lint

Thin pointer to `core/skills/vault-lint`. Read-only by default.

Rules:

1. Load ontology: `await loadOntology(path.join(vaultRoot, ".oms/ontology"))`.
2. Call `lintVault(vaultRoot, ontology)`.
3. Surface `report.violations` to the user if `report.clean` is false. Do NOT autofix without explicit approval.
4. Re-call with `{ autofixEnabled: true }` only after explicit user confirmation (no-op in v0.1.0).

Five checks: allowlist, required, type, enum, routing-law.

NOTE: Wiki mirror deferred — depends on M3.
