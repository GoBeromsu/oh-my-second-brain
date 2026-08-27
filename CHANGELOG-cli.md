# CLI Changelog

Changes to the `oms` command surface belong here.

## [Unreleased]

## [0.6.0] - 2026-08-27

### Changed

- `oms update` now requires confirmation before mutating from a TTY, refuses to mutate without `--yes` in non-TTY environments, and keeps `--dry-run`/`--check` read-only.
- Update reconciliation now propagates host installation failures to a non-zero exit status and resolves implicit vault targets through the verified vault chain, refusing an unverified current-directory target.

## [0.3.0] - 2026-08-24

### Changed

- An unrecognised command now exits 1 instead of printing usage and exiting 0. Silent success on a typo made a removed command indistinguishable from a working one.

### Removed

- The top-level qmd-compatible aliases `oms query`, `oms vsearch`, `oms get`, `oms multi-get` and `oms status` are gone, with ADR-009's D2. The canonical nested commands — `oms semantic query|status|get|multi-get|vsearch` — are unaffected and remain the supported surface.
