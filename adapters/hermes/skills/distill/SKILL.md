---
name: distill
description: Standalone meta-absorption skill — analyzes any target in a clean-room context and produces a structured absorption report with patterns, risks, and attribution. Vault-agnostic.
---

# oms-distill

Thin pointer to `core/skills/distill`. Vault-agnostic — `OMS_VAULT` not required.

Load target via `prepareCleanRoom(target)` — inert text only, never execute. Snapshot SHA, run `runAnalysis(spec, provider)`, generate report via `generateReport(result, targetName)`. Report has exactly three sections: §1 Patterns, §2 Risks, §3 Attribution. Verify mutation detector after: SHA must be unchanged. Return the report string — no vault write occurs inside distill. Use `createStubAnalyzerProvider()` for offline/test runs.

NOTE: Wiki mirror deferred — depends on M3.
