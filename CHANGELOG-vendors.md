# Vendors Changelog

Per-host adapter and installer changes belong here.

## [Unreleased]

## [0.6.0] - 2026-08-27

## [0.3.0] - 2026-08-24

### Changed

- Plugin roots moved to the repository root. `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` now reference `./assets/skills/` as an in-root path, which is what makes a single authored skill source possible; each host keeps its own manifest shape and its own MCP config. Hermes is deliberately asymmetric: it has no repo plugin manifest because `~/.hermes/skills/` is its native surface, and its installer reads the same shared source.

### Removed

- The `adapters/` tree is gone. Its skills were four copies that had drifted to thirteen, fourteen, twelve and eleven entries; hooks, rules and guidance moved under `assets/`.

## [0.1.6] - 2026-06-02

### Changed
- The project is published to npm as `oh-my-second-brain`, while `oms` stays the CLI, MCP, skill, and repo slug.
- The installer defaults to the published npm package instead of `npx` against GitHub release URLs.
- Host MCP registration now points at the installed `oms mcp --vault ...` command.
