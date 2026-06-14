# vault-decision-record — CHANGELOG

## 0.1.0 — 2026-06-13

Initial release (M5 governance skills, step 5).

### Added

- `core/skills/vault-decision-record/SKILL.md` — /skillify recipe for recording vault
  structural changes as ADR markdown under .oms/governance/decisions/, with SUPERSEDE-ONLY
  update semantics and an explicit Layer 1 CONTRACT guard.

### Attribution

- **ADR format (id / title / date / status / supersedes / superseded_by / context /
  decision / consequences)**: derived from Michael Nygard's original ADR template
  (https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) —
  IDEA-ONLY, no verbatim text, format reimplemented independently.
- **SUPERSEDE-ONLY immutability rule**: self-authored; extends the append-only ledger
  convention established in `src/engine/wiki/ledger.ts` (M3 staleness FSM).
- **Layer 1 CONTRACT guard**: self-authored; mirrors the vault-confinement guard already
  present in `src/capture/safe.ts` (`oms_capture_commit` rejects writes to `.oms/`).
- **decisions/ zone**: generalised from the Ataraxia "95. Decisions" folder convention —
  CONCEPT-ONLY, no verbatim content. Paired with `vault-scaffold` skill.
