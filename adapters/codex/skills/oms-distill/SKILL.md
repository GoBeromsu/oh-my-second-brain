---
name: oms-distill
description: Standalone meta-absorption skill — analyzes any target in a clean-room context and produces a structured absorption report with patterns, risks, and attribution. Vault-agnostic.
---

# oms-distill

Thin pointer to `core/skills/distill`. Vault-agnostic — `OMS_VAULT` not required.

Rules:

1. Load target via `prepareCleanRoom(target)` — inert read-only text only; never execute it.
2. Snapshot SHA before analysis. Run `runAnalysis(spec, provider)`.
3. Generate report via `generateReport(result, targetName)`: §1 Patterns, §2 Risks, §3 Attribution.
4. Verify mutation detector: SHA after must equal SHA before. Throw if mutated.
5. Return the report string. No vault write occurs inside distill.
6. Use `createStubAnalyzerProvider()` for offline/test runs.

NOTE: Wiki mirror deferred — depends on M3.
