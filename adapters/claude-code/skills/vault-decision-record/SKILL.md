---
name: oms-vault-decision-record
description: Records vault structural changes as ADR markdown in .oms/governance/decisions/. Update rule is SUPERSEDE-ONLY — new ADRs supersede old ones; existing ADRs are never deleted.
---

# Skill: oms-vault-decision-record (Claude Code)

Record a vault structural decision as an Architecture Decision Record (ADR).

## Invocation

```
/oms-vault-decision-record
```

## What this skill does

Thin pointer to `core/skills/vault-decision-record`. Writes append-only ADR
files to `vaultRoot/.oms/governance/decisions/`. History is permanent — ADRs
are never deleted or renamed.

## Agent-guided steps (v0)

1. Scan `vaultRoot/.oms/governance/decisions/` for existing `ADR-NNNN-*.md` files
   to determine the next sequential number. Create the directory if it does not exist.
2. Slugify `title` (lowercase, hyphens, no special characters).
3. Write `ADR-{NNNN}-{slug}.md` with the required frontmatter and three body sections:
   **Context**, **Decision**, **Consequences**.
4. If `supersedes` is provided, open the referenced ADR and set its `superseded_by`
   field to the new ADR id. Never delete or rename the old file.
5. Return `adrPath`, `adrId`, and `supersededPath` (or `null`).

## Update rule — SUPERSEDE-ONLY

- Never delete an existing ADR.
- Never edit the `decision` or `consequences` body of an existing ADR.
- To revise a decision, write a new ADR with `supersedes: ADR-{old}`.
- `superseded_by` in the old ADR is the only mutation allowed on existing files.

## Layer 1 CONTRACT guard

Never read, write, or modify `core/ontology/taxonomy.yaml`,
`core/ontology/concepts/*.yaml`, or `vaultRoot/.oms/taxonomy.yaml`.

## Runtime

No MCP tool required — this is a pure TypeScript call against the filesystem.

## NOTES

Wiki mirror deferred — the `wiki` skill is built by a parallel milestone (M3)
and its adapter mirror is intentionally deferred until that milestone lands.
