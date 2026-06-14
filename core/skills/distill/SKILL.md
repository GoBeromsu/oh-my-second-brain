---
name: distill
version: 0.1.0
description: >
  Standalone meta-absorption skill. Analyzes any target (repo, document, skill,
  concept) in a clean-room context and produces a structured absorption report
  with patterns, risks, and attribution. Vault-agnostic — OMS_VAULT not required.
trigger: /distill
tags:
  - absorption
  - red-team
  - clean-room
  - analysis
  - standalone
---

# Distill

Run adversarial absorption analysis on a target and produce a structured report.

## Usage

```
/distill <target-path-or-text>
```

## Steps

1. Load the target as inert read-only text via `prepareCleanRoom(target)`.
   The target is NEVER executed — it is treated as data only.
2. Snapshot system state SHA before analysis (`snapshotSha`).
3. Run red-team adversarial analysis via `runAnalysis(spec, provider)`.
   Inject an LLM provider for production; inject the stub for dry-runs.
4. Generate the absorption report via `generateReport(result, targetName)`.
   The report has exactly 3 sections: §1 Patterns, §2 Risks, §3 Attribution.
5. Verify mutation-detector: SHA after must equal SHA before (`detectMutation`).
   Throw if state was mutated — distill must be fully stateless.
6. Return the report string. Write it only if the caller explicitly requests it.
   No vault write, no code mutation happens inside distill.

## Target types

- **Repo mining doc** — load `docs/research/*-mining.md` as inert text.
- **Flat document** — any markdown, text, or code file loaded as a string.
- **Live repo** — read files from disk as text; do not execute them.

## Output

The report is the only output. It contains:

- **§1 Patterns** — ranked by absorb_confidence (highest first), with file:line citations.
- **§2 Risks** — ranked by severity (critical → high → medium → low).
- **§3 Attribution** — repo, URL, and license note for `ACKNOWLEDGMENTS.md`.

## Constraints

- Standalone: does not import from `src/engine/compile/` or `src/engine/wiki/`.
- Vault-agnostic: `OMS_VAULT` environment variable is NOT required.
- Stateless: no daemon, no watcher, no `setInterval` (R2).
- Clean-room: target content is inert text — never executed (R6).
- No vault write occurs inside distill — the caller decides what to do with the report.

## Provider injection

Inject an `AnalyzerProvider` to control the LLM backend:

```typescript
import { createStubAnalyzerProvider } from "src/engine/distill/analyzer.js";
// Deterministic stub — no network; use in tests and dry-runs.
const provider = createStubAnalyzerProvider();
```

For production, wrap a real LLM client in the `AnalyzerProvider` interface.
