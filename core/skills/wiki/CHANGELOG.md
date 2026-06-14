# wiki skill — Changelog

## [0.1.0] — 2024-01-15 — M3 initial implementation

### Added

- `src/engine/wiki/ledger.ts` — 5-state staleness FSM (`CLEAN | DIRTY | STUB | ORPHAN | CONFLICT`) persisted as `.llmwiki/staleness.json`. Pure/injectable: dir passed in, no hardcoded paths. Full-rebuild escape hatch: delete `staleness.json` → all pages reset to DIRTY.
- `src/engine/wiki/collection.ts` — Collection owner with five responsibilities: namespace/identity, link-graph closure, ledger delegation, navigation delegation, processed→wiki promotion. Enforces nvk 3-phase hard separation: wiki query never triggers compile; compile never writes `wiki/` directly; promotion is the sole entry point.
- `src/engine/wiki/navigation.ts` — Karpathy navigation surfaces: `wiki/index.md` global catalog regenerated after every compile run; `wiki/log.md` append-only log (`## [YYYY-MM-DD] compile | ConceptName`). Clock injected via `NowFn` for deterministic tests.
- `src/engine/wiki/lint.ts` — Astro-Han 2-tier lint. Auto-fix tier: index consistency, broken-link flagging, See-Also section insertion. Report-only tier: factual contradictions (`> **Conflict:** … Unresolved.`), orphan pages, outdated refs. Report-only tier never auto-fixes without explicit `forceHumanGate` flag.
- `src/engine/wiki/types.ts` — Local type definitions: `StalenessState`, `LedgerEntry`, `StalenessLedger`, `LintFinding`, `LintResult`, `NowFn`, etc.
- `src/engine/wiki/wiki.test.ts` — 42 co-located vitest tests covering all completion-gate requirements: 5-state FSM + all transitions; delete-to-reset escape hatch; index.md/log.md generation; processed→wiki promotion via real fs inspection; dangling link detection; cascade backlink flip; full M2→M3 integration using real `compile()` + `createDeterministicStub()` (zero network calls).
- `src/engine/wiki/README.md` — Sub-dir README per R21 convention.
- `src/engine/wiki/ACKNOWLEDGMENTS.partial.md` — Local attribution fragment for orchestrator merge at M5.

### Attribution

| Source | License | Absorption |
|--------|---------|------------|
| Karpathy wiki gist | No license | IDEA-ONLY — navigation conventions (index.md catalog, log.md append-only format) |
| Astro-Han SKILL.md | MIT | IDEA-ONLY — collection owner five-responsibility pattern |
| nvk/llm-wiki | Apache-2.0 | IDEA-ONLY — 3-phase hard separation (Research → Compile → Wiki read-only) |
| lucasastorian/llmwiki | Terminology only | CONCEPT-ONLY — cascade consumption terminology (`affected_backlinks`) |
