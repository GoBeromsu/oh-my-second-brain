---
name: vault-lint
version: 0.1.0
description: Checker-lane-only vault linter — enforces the Layer 1 CONTRACT (taxonomy.yaml + concepts/*.yaml) across all notes in a vault. Runs five checks (allowlist, required, type, enum, routing-law) and returns a report. Never mutates vault files; autofix requires an explicit human-gate flag.
trigger: /vault-lint
tags: [vault-lint, conventions, contract, checker, oms, routing-law, frontmatter]
---

## vault-lint

Run all five Layer 1 CONTRACT checks against every markdown note in a vault.

### When to use

Use `vault-lint` whenever you need to verify that a vault's frontmatter
conforms to its declared ontology (taxonomy.yaml + concepts/*.yaml). The
checker is safe to call at any time — it is read-only by default.

### Inputs

- `vaultRoot` — absolute path to the vault root directory
- `ontology` — loaded `Ontology` object (use `loadOntology(ontologyDir)` from `src/ontology/loader.ts`)
- `options.autofixEnabled` — optional human-gate flag (default `false`); set `true` ONLY after explicit user confirmation; currently a no-op reserved for future implementation

### Output

Returns `VaultLintReport`:

- `violations` — array of `VaultLintViolation` (field, rule, message, notePath)
- `scannedNotes` — count of notes with frontmatter evaluated
- `clean` — true when violations is empty

### Five checks

1. **allowlist** — no frontmatter key outside the concept's declared field list
2. **required** — required fields must be present and non-empty
3. **type** — values must match the declared `FieldType` (string / url / date / list / number / boolean)
4. **enum** — string fields with an `enum` array in the concept YAML must use a listed value
5. **routing-law** — notes in agent-writable taxonomy zones must carry `created_by`

### Recipe

1. Load the ontology: `const ontology = await loadOntology(path.join(vaultRoot, ".oms/ontology"))`.
2. Call `lintVault(vaultRoot, ontology)`.
3. If `report.clean` is false, surface `report.violations` to the user — do NOT autofix without explicit approval.
4. If autofix is explicitly approved by the user, re-call with `{ autofixEnabled: true }` (autofix is reserved for a future M5 human-gate protocol; the flag is a no-op in v0.1.0).

### Checker-lane constraint

This skill is checker-lane only. It NEVER authors or mutates vault content.
Any suggestion to fix a violation must be reviewed and approved by the user
before any write occurs.

### Agent-writable zones

A folder is agent-writable when its taxonomy binding declares a non-null
concept with at least one field. Raw-capture inbox folders (zero declared
fields) are excluded from the routing-law check.
