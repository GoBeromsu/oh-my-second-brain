# CLI Changelog

Changes to the `oms` command surface belong here.

## [Unreleased]

- **`oms doctor` now verifies Claude hook events plus the managed Codex and Hermes MCP registrations, preserving unreadable or syntactically malformed registration evidence as explicit inspection errors.**
- **`oms doctor` now reports structured and text install-asset health, naming dangling Claude hook symlinks with the reinstall command instead of allowing a silent command-not-found failure at tool time.**

## [0.12.2] - 2026-09-01

## [0.12.1] - 2026-09-01

## [0.12.0] - 2026-09-01

- **Breaking: `oms doctor` no longer accepts `.oms/taxonomy.yaml`.** It reports one conversion error for a YAML-only vault (or fail-closed cleanup guidance when both files remain); run `oms setup` and approve the returned digest to publish `.oms/taxonomy.json`.

## [0.11.1] - 2026-09-01

### Changed

- **`oms doctor` includes one computed Hermes provenance status in both text and JSON output.** The resolved root is reported as `not-installed`, `match`, or `drift`, with package version, recorded version, and digest-match evidence.

## [0.11.0] - 2026-09-01

### Added

- **`oms index repair --mode rebuild|drop [--dry-run]`.** (#88) Repairs run before any engine session opens, so corrupt stores never block their own recovery; `oms index status` cites the exact repair command when it detects a corrupt or incompatible store; dry-run prints the plan with zero file changes.
- **`oms doctor` reports Hermes install provenance in one read-only line.** (#90) Not-installed, match, or drift between the package version and the installed provenance for the resolved `OMS_HERMES_HOME` root.

### Changed

- **`oms update` refuses ambiguous install topologies and always reconciles.** (#64) Mismatched running-binary and `npm prefix -g` locations are reported with both paths and exact manual commands instead of silently updating the wrong copy.

## [0.10.1] - 2026-09-01

### Fixed

- **`--help` is now a first-class, side-effect-free path.** (#55) Every recognized command plus the bare `oms --help`/`-h` prints usage and exits 0 before any vault resolution, host-config access, MCP server start, or update notice; `--help` never lands in unknown-flag handling, and an unknown command with `--help` still fails so typos are not hidden.
- **Setup dry-run reports blocked proposals instead of aborting.** (#67) `oms setup --dry-run` on a vault with unresolved notes prints a deterministic blocked diagnosis without composing a manifest and issues no approval digest; apply requests are clearly rejected before composition.

## [0.10.0] - 2026-09-01

### Breaking

- **OMS now has one search taxonomy.** `oms semantic` and the old top-level collection, context, cleanup, and HTTP aliases are removed; use `oms search`, `oms doc get|multi-get`, `oms embed`, and `oms serve`. `oms index` contains exactly `sync|status|cleanup|collections|contexts`; embedding remains the compact top-level `oms embed` command.
- **Setup model options have changed.** `--embedding-*` is replaced by `--models-default`, `--models-descriptor`, and `--models-no-default`.
- **The embedding runtime is local-only.** The former Upstage provider path is removed; configured model identities must resolve to verified local GGUF artifacts.

### Added

- **Search now uses an explicit closed qmd-v2.8.3 expansion strategy.** `--max-queries` is strict, reranking is opt-in, and local model-set descriptors are supported.
- **`oms serve` exposes only the canonical HTTP endpoints.** `/health`, `/search`, `/get`, and `/multi-get` remain; no query alias or second MCP tool surface is advertised.

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
