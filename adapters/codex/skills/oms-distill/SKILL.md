---
name: oms-distill
description: Standalone meta-absorption skill — analyzes any target in a clean-room context and produces a structured absorption report with patterns, risks, and attribution. Vault-agnostic.
---

# oms-distill

Thin pointer to `core/skills/distill`. Vault-agnostic — `OMS_VAULT` not required.

1. Load the target as inert read-only text; never execute it.
2. Snapshot a content hash before analysis. Run a read-only red-team pass.
3. Write the report: §1 Patterns, §2 Risks, §3 Attribution.
4. Verify the hash is unchanged. Stop if anything mutated.
5. Return the report string. No vault write occurs inside distill.
