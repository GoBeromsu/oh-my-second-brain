# setup — CHANGELOG

## 0.2.0 — 2026-06-13

Rewrote skill to embed the Socratic setup interview methodology (M5 step 2).

### What changed

- Added 5-key frontmatter (name, version, description, trigger, tags) per compile skill convention.
- Embedded Socratic clarity loop with configurable ambiguity threshold (default 0.20),
  dimension scoring across Goal / Constraint / Criteria / Context, a Round-0 topology gate,
  and three challenge modes: Contrarian, Simplifier, Ontologist.
- Defined exactly 6 binding dimensions: tier folder mapping, provenance grade mapping,
  lint schema SSOT, embedder selection, ignore_for_external_apis glob, agent-writable zone
  + write routing law.
- Added Non-Sticky Guard (HARD): output written ONLY to `vault/.oms/taxonomy.yaml`.
  Engine default `core/ontology/taxonomy.yaml` is never modified.
- Added output shape YAML spec and executable helper reference.
- Created `src/engine/setup/` with pure stateless helpers + co-located vitest tests.

### Attribution

- **omc deep-interview methodology** (self-reimplemented — method only, no code copied):
  Socratic clarity loop structure, ambiguity scoring formula (1 − mean of sub-dimension scores),
  Round-0 topology gate pattern, and Contrarian / Simplifier / Ontologist challenge modes
  are reimplemented from the omc deep-interview skill methodology.
  No source code was copied. The implementation is original TypeScript.

### Files created or modified

- `core/skills/setup/SKILL.md` — rewritten (this milestone)
- `core/skills/setup/CHANGELOG.md` — created
- `core/skills/setup/ACKNOWLEDGMENTS.partial.md` — created
- `src/engine/setup/types.ts` — local types (DimensionScore, InterviewConfig, TaxonomyOutput)
- `src/engine/setup/ambiguity.ts` — ambiguity scoring (computeAmbiguity, meetsThreshold, validateScores)
- `src/engine/setup/writer.ts` — Non-Sticky Guard writer (writeTaxonomyToVaultOverride)
- `src/engine/setup/ambiguity.test.ts` — vitest suite for ambiguity functions
- `src/engine/setup/writer.test.ts` — vitest suite for Non-Sticky Guard enforcement

---

## 0.1.0 — 2026-06-01

Initial release (M0 setup CLI, `oms setup`).

- Scanned existing top-level vault folders.
- Asked intent and concept binding per folder.
- Wrote `vault/.oms/taxonomy.yaml` with `version: 0`.
- Copied shipped default concepts into `vault/.oms/concepts/`.
