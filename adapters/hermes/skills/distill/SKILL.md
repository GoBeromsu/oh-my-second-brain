---
name: distill
description: Standalone meta-absorption skill — analyzes any target in a clean-room context and produces a structured absorption report with patterns, risks, and attribution. Vault-agnostic.
---

# oms-distill

Thin pointer to `core/skills/distill`. Vault-agnostic — `OMS_VAULT` not required.

Load the target as inert text only, never execute. Snapshot a content hash, run a read-only red-team pass, then write §1 Patterns, §2 Risks, §3 Attribution. Verify the hash is unchanged. Return the report string — no vault write occurs inside distill.
