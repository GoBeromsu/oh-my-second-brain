# vault-scaffold — CHANGELOG

## 0.1.0 — 2026-06-13

Initial release (M5 governance skills, step 4).

### Added

- `core/skills/vault-scaffold/SKILL.md` — /skillify recipe for seeding a vault with the
  engine DEFAULT taxonomy, decisions/ zone, .oms/governance/architecture.md stub, and
  .oms/taxonomy.yaml override path.

### Attribution

- **Taxonomy seeder pattern**: self-authored (bstack second-brain design); no external source.
- **decisions/ zone generalisation**: derived from the Ataraxia vault "95. Decisions" folder
  convention — CONCEPT-ONLY, no verbatim content. Self-contained reimplementation.
- **Override-path convention (.oms/taxonomy.yaml)**: self-authored; extends the existing
  `oms_capture_prepare` vault-confinement pattern already present in `src/capture/safe.ts`.
- **Architecture stub format**: self-authored; follows the sub-dir README convention
  established at R21 in the compile engine (`src/engine/compile/README.md`).
