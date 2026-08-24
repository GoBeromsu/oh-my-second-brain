# CLI Changelog

Changes to the `oms` command surface belong here.

## [Unreleased]

### Changed

- An unrecognised command now exits 1 instead of printing usage and exiting 0. Silent success on a typo made a removed command indistinguishable from a working one.

### Removed

- The top-level qmd-compatible aliases `oms query`, `oms vsearch`, `oms get`, `oms multi-get` and `oms status` are gone, with ADR-009's D2. The canonical nested commands — `oms semantic query|status|get|multi-get|vsearch` — are unaffected and remain the supported surface.
