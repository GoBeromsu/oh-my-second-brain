# CLI Changelog

Changes to the `oms` command surface belong here.

## [Unreleased]

## [0.9.0] - 2026-08-31

### Changed

- **`setup`, `doctor`, `audit`, and `linkify` now expose the template contract directly.** Setup uses dry-run plus `--approved-digest`, doctor reports template/projection health and renames the report cap to `--max-per-template`, audit fails closed against resolved template identities, and linkify uses the same stable identities as write/search. Retired Concept authoring and `--suggest-fields` are no longer accepted.
- **Host lifecycle commands now maintain a strict signed XDG vault pointer.** `install`, `update`, public `reconcile`, and `uninstall` compare-and-swap host stamps without affecting runtime vault resolution; `--template-folder` is also bound into setup discovery and its approval digest.

## [0.8.4] - 2026-08-30

## [0.8.3] - 2026-08-29

## [0.8.2] - 2026-08-29

## [0.8.1] - 2026-08-29

## [0.8.0] - 2026-08-29

### Added

- **`oms setup --embedding-default` installs a working local embedding model in one step.** It downloads the pinned EmbeddingGemma-300M model, verifies it against the shipped SHA-256, and publishes it to the user-level cache. After that, `oms embed` and vector search work without setting `OMS_EMBEDDING_PROVIDER` or `OMS_EMBEDDING_MODEL` at all — the gap that previously forced anyone wanting native semantic search to hand-author a descriptor JSON or export a matching environment pair. Nothing changes for a vault that does not run it: with no model installed, lexical search keeps working and vector requests still fail loudly naming both variables, and the guidance now names this command as the one-step remedy.
- The three setup embedding options are mutually exclusive and now say so. Passing more than one of `--embedding-default`, `--embedding-descriptor`, or `--embedding-no-default` exits with an error naming the conflicting flags instead of silently letting one win.

### Changed

- `oms --help` documents the setup embedding options. All three existed only in source before this; `--embedding-descriptor` and `--embedding-no-default` shipped undocumented.

## [0.7.0] - 2026-08-27

### Breaking

- `oms setup` and `oms install --vault` no longer register the vault in `~/.oms/config.yaml`. The write-back and its `OMS_VAULT` migration backfill are removed entirely.

## [0.6.2] - 2026-08-27

## [0.6.1] - 2026-08-27

## [0.6.0] - 2026-08-27

### Changed

- `oms update` now requires confirmation before mutating from a TTY, refuses to mutate without `--yes` in non-TTY environments, and keeps `--dry-run`/`--check` read-only.
- Update reconciliation now propagates host installation failures to a non-zero exit status and resolves implicit vault targets through the verified vault chain, refusing an unverified current-directory target.

## [0.3.0] - 2026-08-24

### Changed

- An unrecognised command now exits 1 instead of printing usage and exiting 0. Silent success on a typo made a removed command indistinguishable from a working one.

### Removed

- The top-level qmd-compatible aliases `oms query`, `oms vsearch`, `oms get`, `oms multi-get` and `oms status` are gone, with ADR-009's D2. The canonical nested commands — `oms semantic query|status|get|multi-get|vsearch` — are unaffected and remain the supported surface.
