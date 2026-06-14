# compile — CHANGELOG

## 0.1.0 — 2026-06-13

Initial release (M2 compile engine).

### Attribution

- **SHA-incremental pattern (Steps 2-4)**: bstack `terminology` skill — self-authored, no external restriction.
- **2-step Chain-of-Thought (analysis → synthesis)**: nashsu/llm_wiki — GPL-3.0, IDEA-ONLY. No verbatim code. Algorithm description absorbed and reimplemented from scratch. See `src/engine/compile/ACKNOWLEDGMENTS.partial.md`.
- **2-phase separation (extract-without-writing → generate)**: atomicstrata — license TBD, CONCEPT-ONLY. No verbatim code.
- **Cascade return (write → affected_backlinks)**: lucasastorian/llmwiki — terminology absorbed, concept-only.
- **Provenance grading**: self-authored (bstack second-brain design).

### Files

- `src/engine/compile/types.ts` — local compile types
- `src/engine/compile/sha-cache.ts` — SHA-256 fingerprint + disk cache
- `src/engine/compile/provenance.ts` — grade resolution + synthesis weighting
- `src/engine/compile/cot.ts` — nashsu 2-step CoT (GPL idea-only reimplementation)
- `src/engine/compile/phases.ts` — atomicstrata 2-phase separation (concept-only)
- `src/engine/compile/cascade.ts` — lucasastorian cascade backlink return
- `src/engine/compile/worker.ts` — stateless compile worker (entry point)
- `src/engine/compile/*.test.ts` — co-located vitest suites
