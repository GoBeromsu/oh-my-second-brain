---
name: vault-decision-record
version: 0.1.0
description: Records vault structural changes as ADR markdown in .oms/governance/decisions/. Update rule is SUPERSEDE-ONLY — new ADRs supersede old ones via superseded_by; existing ADRs are never deleted. Never modifies Layer 1 CONTRACT files (taxonomy.yaml / concepts/*.yaml).
trigger: /vault-decision-record
tags: [adr, decision-record, governance, vault, supersede, oms]
---

## vault-decision-record

Record a vault structural decision as an Architecture Decision Record (ADR) in
`.oms/governance/decisions/`.

### When to use

Use `vault-decision-record` whenever a structural change is made to a vault — adding
a new zone, changing a taxonomy folder intent, renaming a concept, or altering a
governance policy. Every decision that could be questioned later deserves a record.

### Inputs

- `vaultRoot` — absolute path to the target vault directory
- `title` — short human-readable decision title (used in filename slug and heading)
- `context` — what situation or question prompted this decision
- `decision` — what was decided and why
- `consequences` — what changes as a result; trade-offs accepted
- `status` — `Proposed | Accepted | Superseded` (default: `Accepted`)
- `supersedes` — ADR id this record replaces (e.g., `ADR-0001`); omit when not applicable

### Recipe

1. Scan `vaultRoot/.oms/governance/decisions/` for existing files matching
   `ADR-NNNN-*.md` to determine the next sequential number.
   Create the directory if it does not exist.
2. Slugify `title` (lowercase, hyphens, no special characters).
3. Write `vaultRoot/.oms/governance/decisions/ADR-{NNNN}-{slug}.md` with the
   following structure:

   ```markdown
   ---
   id: ADR-{NNNN}
   title: "{title}"
   date: YYYY-MM-DD
   status: Accepted
   supersedes: ~          # fill if this replaces an earlier ADR
   superseded_by: ~       # filled by a future ADR; never set manually
   ---

   ## Context

   {context}

   ## Decision

   {decision}

   ## Consequences

   {consequences}
   ```

4. If `supersedes` is provided, open the referenced ADR file and set its
   `superseded_by` field to the new ADR id. Never delete or rename the old file.
5. Confirm the written file exists at the expected path and return the path.

### Update rule — SUPERSEDE-ONLY

- **Never delete** an existing ADR. Decisions are append-only; history is permanent.
- **Never edit** the `decision` or `consequences` body of an existing ADR.
- To revise a decision, write a new ADR with `supersedes: ADR-{old}`.
- The `superseded_by` field in the old ADR is the sole mutation allowed on existing files.
- Renaming an ADR file is prohibited; ids are stable.

### Layer 1 CONTRACT guard

This skill operates exclusively in the AUTHOR lane (Layer 2+).
It MUST NEVER read, write, or otherwise modify:

- `core/ontology/taxonomy.yaml`
- `core/ontology/concepts/*.yaml`
- `vaultRoot/.oms/taxonomy.yaml` (vault override of Layer 1)

These are Layer 1 CONTRACT files. Any structural decision that requires changing
a contract file must go through a separate human-gated contract-amendment process;
a `vault-decision-record` documents the intent but does not execute the contract change.

### Output

Returns a decision report:

- `adrPath` — absolute path of the newly written ADR
- `adrId` — assigned id (e.g., `ADR-0003`)
- `supersededPath` — path of the old ADR updated with `superseded_by`, or `null`
