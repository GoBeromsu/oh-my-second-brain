# Vendors Changelog

Per-host adapter and installer changes belong here.

## [Unreleased]

### Changed

- **Claude, Codex, and Hermes host guidance and hooks now describe the template/ontology coexistence contract.** Templates own note shape, user-owned policy/taxonomy intent owns meaning, taxonomy owns placement, and Obsidian owns types. A signed XDG host-maintenance pointer lets install, update, public reconcile, and uninstall compare-and-swap every managed MCP/hook vault stamp while remaining completely outside runtime target resolution. Claude post-write checks resolve templates without rebuilding caches.

## [0.8.4] - 2026-08-30

## [0.8.3] - 2026-08-29

## [0.8.2] - 2026-08-29

## [0.8.1] - 2026-08-29

## [0.8.0] - 2026-08-29

## [0.7.0] - 2026-08-27

### Changed

- The Claude adapter registers the resolved vault itself instead of depending on the removed global registry. `installClaude` writes a user-scope `oms` MCP server entry into `~/.claude.json` built from the shared `mcpServerEntry()` helper — the same helper and the same `["mcp", "--vault", <absolute path>]` shape the Codex and Hermes adapters already use — and `uninstallClaude` removes it. The write is a byte-preserving JSON splice, so unrelated `mcpServers` entries and unmanaged formatting in that file survive untouched, and re-installing is idempotent. The npm-owned plugin `.mcp.json` is deliberately left as a bare `args: ["mcp"]` fallback; a user-scope entry shadows it, since Claude resolves scopes Local > Project > User > Plugin-provided without merging fields.
- This does not close issue #56, which asks for a plugin-owned, `plugin:<id>:<server>`-namespaced MCP surface with no separate user registration. A plugin-owned manifest is rewritten by npm on every update and cannot carry a per-machine vault path, so the user-scope entry is currently the only place the vault can live. What changes here is that the registration is no longer vault-less.

## [0.6.2] - 2026-08-27

## [0.6.1] - 2026-08-27

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
