# Vendors Changelog

Per-host adapter and installer changes belong here.

## [Unreleased]

## [0.1.6] - 2026-06-02

### Changed
- The project is published to npm as `oh-my-second-brain`, while `oms` stays the CLI, MCP, skill, and repo slug.
- The installer defaults to the published npm package instead of `npx` against GitHub release URLs.
- Host MCP registration now points at the installed `oms mcp --vault ...` command.
