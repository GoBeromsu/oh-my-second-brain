# Changelog

## [Unreleased]

## [0.1.9] - 2026-08-14

### Added
- MCP `write` is now the single vault write window, with `mode: create | append | update`, returning `ask`, `inbox`, `written`, or `rejected` so the agent always knows what happened to a note (#52).
- A contract gate validates required fields, types, enums, and routing law before anything touches the vault. Extra keys survive the round trip (`additionalProperties: preserve`).
- Thin write skills for each host: `/oms-write` on Claude, `$oms-write` on Codex, and `write` on Hermes.

### Changed
- **Breaking:** capture skills are gone (`/oms-capture`, `$oms-capture`, Hermes `capture`), along with the MCP aliases `oms_capture_prepare` and `oms_capture_commit`. After upgrading, reinstall the host adapters with `oms update --yes` or `oms install --runtime <host> --vault <path> --yes`.

### Fixed
- Transitive production advisories cleared through same-major overrides for `hono`, `@hono/node-server`, `body-parser`, `fast-uri`, `ip-address`, `nanoid`, and `tar`. No new runtime dependencies were added.

## [0.1.8] - 2026-06-17

### Fixed
- Upstage Solar embeddings work again: the model id `solar-embedding-1-passage` didn't exist, so every embedding call returned HTTP 400. It's now `embedding-passage` (4096d).
- `embed()` guards its inputs. Empty input becomes a zero vector, and input over 4000 tokens is shrunk and retried, so one oversized or empty chunk no longer fails a whole vault sync.
- Transitive high-severity advisory in `hono` (pulled in by `@modelcontextprotocol/sdk`) resolved via `overrides: hono ^4.12.25`.

### Changed
- Claude Code, Codex, and Hermes adapter manifests are synced to 0.1.8.

## [0.1.7] - 2026-06-05

> No GitHub Release was published for the `oms-v0.1.7` tag. This section is reconstructed from the commits between `oms-v0.1.6` and `oms-v0.1.7`.

### Added
- Live graph retrieval plus fail-soft qmd fusion, so retrieval keeps working when the optional qmd side is unavailable.
- MCP retrieval context surfaced to hosts.

### Changed
- The npm package root is the runtime asset root: built releases resolve `core/` and `adapters/` from the package root, matching the source layout.
- `oh-my-second-brain` becomes the canonical repository, npm package, and installed command, with `oms` kept as a compatibility alias for existing MCP, skill, and vault `.oms` surfaces.
- Install docs point at 0.1.7 so the one-line and npm install examples resolve to the published version.
- The release workflow no longer requires an `NPM_TOKEN` preflight, allowing npm trusted publishing over OIDC while still using `NODE_AUTH_TOKEN` when the secret exists.

### Fixed
- Frontmatter diagnostics are tolerant: malformed frontmatter no longer blocks retrieve or build paths.

## [0.1.6] - 2026-06-02

### Changed
- The project is published to npm as `oh-my-second-brain`, while `oms` stays the CLI, MCP, skill, and repo slug.
- The installer defaults to the published npm package instead of `npx` against GitHub release URLs.
- Host MCP registration now points at the installed `oms mcp --vault ...` command.

## [0.1.5] - 2026-06-02

### Changed
- Oh My Second Brain is the project and display name; `oms` remains the short technical slug for the package, CLI, MCP server, skills, and release assets.
- Human-facing docs, adapter manifests, host shims, skills, CLI output, MCP tool titles, and installer text all use the Oh My Second Brain name.
- Release package URLs point at `oms-v0.1.5` / `oms-0.1.5.tgz`.
