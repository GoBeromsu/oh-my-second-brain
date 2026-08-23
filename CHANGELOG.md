# Changelog

This aggregate changelog contains changes that span multiple layers.

- [Kernel changelog](./CHANGELOG-kernel.md) — domain logic
- [CLI changelog](./CHANGELOG-cli.md) — the `oms` command surface
- [MCP changelog](./CHANGELOG-mcp.md) — MCP server tools and resources
- [Vendors changelog](./CHANGELOG-vendors.md) — per-host adapters and installers
- [Assets changelog](./CHANGELOG-assets.md) — skills, agents, and ontology data

## [Unreleased]

## [0.2.0] - 2026-08-19

### Added
- The npm package now ships `CHANGELOG.md`, so release notes are available offline and in version control.
- Releases are published by CI from `oms-v*` tags with npm provenance and an auto-generated GitHub Release whose notes come from the CHANGELOG.
- Maintainers release with a single command: `npm run release -- <X.Y.Z>` rolls the `[Unreleased]` section into a versioned entry, bumps all version carriers (package.json, plugin manifests), commits, tags, and pushes atomically.

#### Note linking

- `term` is now a first-class concept in the core ontology, bound to a `terms/` folder. A term note is the one place you define a piece of vocabulary, and its new `aliases` frontmatter field lists every other way you write that word.
- Two MCP tools turn those terms into links. `oms_link_suggest` is read-only: it ranks the spans in a note that could point at a term note and hands back a hash of the content it looked at. `oms_link_apply` writes, but only the candidates you accepted, and only while that hash still matches, so a note you edited in the meantime is never overwritten by a stale suggestion.
- `oms linkify [--folder <f>] [--apply] [--yes]` does the same job in bulk over notes you already have. It reports and changes nothing by default; mutation needs both `--apply` and `--yes`.
- Matching understands Korean josa, so `아타락시아를` links as `[[ataraxia|아타락시아]]를` instead of being skipped for not matching the bare term.
- A note-linking skill ships to Claude, Codex, and Hermes, so each host knows the suggest-review-apply loop without you explaining it every session.

#### Updates and install

- A root `.claude-plugin/marketplace.json` makes OMS discoverable through Claude Code's native plugin marketplace. Claude installs now go through `claude plugin marketplace add` plus `claude plugin install oms@oms`, and fall back to the local plugin path when the marketplace flow can't complete, so offline and dev checkouts still work.
- The MCP server tells you when a newer version exists. It reads a 24-hour cache at boot and appends one line to its `instructions`; the registry lookup happens in a bounded background refresh, never on the startup path. `OMS_UPDATE_NOTICE=0` turns it off.
- A test and a CI release-tag guard now check that `marketplace.json` and `package.json` agree on the version, so a release can't ship a marketplace manifest pointing at the wrong build.

### Changed

- Wikilinks resolve through frontmatter `aliases`. `[[some-alias]]` used to resolve to nothing; it now finds the note that claims that alias, which means alias links count as real graph edges during retrieval.
- Installing several hosts at once no longer stops at the first failure. Each runtime is isolated, so a broken Codex config can't cost you your Claude and Hermes install.
- Hermes config writes are an upsert instead of a full overwrite: your comments and key ordering in `~/.hermes/config.yaml` survive an install or update.
- Claude's third-party marketplace auto-update stays off unless you turn it on. Install prints how to enable `extraKnownMarketplaces.<name>.autoUpdate` in `~/.claude/settings.json` rather than flipping it for you; the `claude` CLI owns that setting.

### Fixed

- The MCP server reports its real package version instead of a hardcoded `0.0.0`, so host-side version checks and bug reports show what you're actually running.

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

## [0.1.5] - 2026-06-02

### Changed
- Oh My Second Brain is the project and display name; `oms` remains the short technical slug for the package, CLI, MCP server, skills, and release assets.
- Human-facing docs, adapter manifests, host shims, skills, CLI output, MCP tool titles, and installer text all use the Oh My Second Brain name.
- Release package URLs point at `oms-v0.1.5` / `oms-0.1.5.tgz`.
