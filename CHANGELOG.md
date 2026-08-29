# Changelog

This aggregate changelog contains changes that span multiple layers.

- [Kernel changelog](./CHANGELOG-kernel.md) — domain logic
- [CLI changelog](./CHANGELOG-cli.md) — the `oms` command surface
- [MCP changelog](./CHANGELOG-mcp.md) — MCP server tools and resources
- [Vendors changelog](./CHANGELOG-vendors.md) — per-host adapters and installers
- [Assets changelog](./CHANGELOG-assets.md) — skills, agents, and ontology data

## [Unreleased]

### Fixed

- **The Korean README documented an MCP surface that no longer exists.** It listed eleven tools — `oms_graph_status`, `oms_retrieve_by_axis`, `oms_lazy_load_note`, and eight more — as what `oms mcp` exposes. Those are the retired detail operations, which now route through the five public tools by an `op` parameter. It also named the write tool `write` rather than `oms_write`. Anyone wiring an MCP client from that list would have called tools the server does not advertise — `ListTools` returns exactly the five. It now states the same five tools the English README does: `oms_write`, `oms_search`, `oms_link`, `oms_status`, `oms_doctor`.
- **The Korean README credited `oms doctor` with `oms lint`'s job and omitted `lint` entirely.** `doctor` was described as broken-link and orphan detection, which is what `lint` does; `doctor` validates note frontmatter against the ontology. Both commands are now listed with their actual responsibilities.

## [0.8.2] - 2026-08-29

### Fixed

- **The Korean README told you to set an environment variable that does nothing.** It documented `OMS_MODEL_PATH` as the way to point OMS at a local GGUF model, but that name was retired and is read nowhere in the codebase — anyone following those instructions got no embeddings and no explanation why. It also never mentioned `oms setup --embedding-default`, so the one-step path that has shipped since 0.8.0 was invisible to Korean readers. Both READMEs now describe the same setup, and both name `OMS_EMBEDDING_PROVIDER` + `OMS_EMBEDDING_MODEL` as the way to choose your own model.

### Documentation

- **Both READMEs now say the default embedding model is unmeasured.** `--embedding-default` installs the same model and prompt format qmd resolves by default, and its ranking quality here rests on that equivalence — not on a measured comparison in this project's own retrieval harness. That caveat existed only in a repository decision record, which npm users never see. It is now stated where the feature is recommended, alongside a link explaining why the measurement is not simply pending.

## [0.8.1] - 2026-08-29

### Fixed

- **A note could be given the wrong title, degrading semantic search across that whole note.** 0.8.0 started mixing each note's title into every one of its chunks when embedding, which is what makes a mid-note passage findable by what the note is *about*. But the title was picked from the first `#` line anywhere in the file, and `#` means "comment" in frontmatter and "heading" in Markdown. So a frontmatter comment like `# rewrite this later`, or an `# Example` heading shown inside a fenced code block, could be adopted as the note's title and then mixed into every chunk of it — pulling the entire note toward the wrong topic. Titles are now read only from frontmatter `title` or a real heading in the note body, with code fences skipped. A note affected by either case had no real title to begin with, so it is now correctly untitled.

  To be clear about what this does and does not change: frontmatter text has always been part of what gets indexed, and still is. This fixes which text is treated as the *title*, not what is stored.

  **If you ran `oms embed` on 0.8.0, re-run it.** Affected notes are corrected automatically, but only once you sync again.

### Changed

- **This release re-embeds your vault once, for the last time in this series.** Fixing the title bug above required changing how OMS fingerprints a chunk, which invalidates the fingerprints written by 0.8.0. Combined with 0.8.0's own one-time reindex, that is two full re-embeds across two consecutive releases — not a pattern, and worth taking now while the affected code is one release old rather than carrying a known-wrong fingerprint forward.

### Documentation

- **The limits of the 0.8.0 vector-search fix are now stated where users read.** That release described vector search as fixed without noting the ceiling it works under: results come from at most 4096 candidates, so on a vault larger than that a vector-derived result count and any deep page are bounded by it, and a collection-scoped vector search can miss matches whose documents rank outside that band globally. This is a property of how the vector index ranks before filtering, not something the fix introduced — but it belonged in the release note and was only in the kernel changelog.
- The pinned default model's decision record now documents why an explicit, opt-in `--embedding-default` command is not the automatic default-model acquisition that `docs/measurements/model-default-deferral.md` withholds, and states plainly that the model's retrieval quality rests on matching the reference toolchain rather than on a measurement in this project's own harness.

## [0.8.0] - 2026-08-29

### Added

- **Semantic search now has a one-step setup.** `oms setup --embedding-default` downloads EmbeddingGemma-300M, verifies it against a pinned SHA-256, and installs it under your user cache — not in the vault. After that, `oms embed` and vector search work with no environment variables at all:

  ```bash
  oms setup --embedding-default
  oms embed
  oms semantic vsearch "what should I retrieve?"
  ```

  Until now, native semantic search worked only if you hand-authored a model descriptor JSON or exported a matching `OMS_EMBEDDING_PROVIDER` + `OMS_EMBEDDING_MODEL` pair. The model runs locally through `node-llama-cpp`, needs no API key, and embeds at its full 768 dimensions with no folding.

  Choosing your own model is unchanged: set both environment variables, or pass `oms setup --embedding-descriptor <path>`. Setting only one of the pair is still an error naming both, never a silent fallback. Installing no model is still fine — lexical search, graph retrieval, and convention validation all keep working, and only vector and HyDE requests are refused.

### Changed

- **Note titles now inform semantic search results.** A chunk from the middle of a note is often ambiguous on its own, so each chunk's embedding now includes its document title (frontmatter `title`, else the first `# heading`). A note titled "Kubernetes Pod Scheduling" whose body only says "the controller assigns each pending item to the best-fit node" is now findable by searching for Kubernetes.

  **One-time cost when you upgrade:** because the title is part of what gets embedded, it is also part of how OMS detects changes — otherwise renaming a note would leave most of its chunks holding vectors that still encode the old title. That changes the change-detection digest, so the first `oms embed` after upgrading re-embeds your vault once. Subsequent runs are incremental again.

### Fixed

- **Vector search was completely broken and now works.** Every vector or HyDE query failed with `k value in knn query too large`, because the search layer asks for an unbounded candidate set and the vector index rejects any request above its own 4096-result ceiling. Collection-scoped vector queries had the same defect from the other direction, failing on any vault with more than 4096 chunks. This affected anyone who had configured an embedding model; without one, queries never reached the vector path at all. No reindex is needed for this fix.

## [0.7.0] - 2026-08-27

### Breaking

- **The global vault registry at `~/.oms/config.yaml` is gone.** OMS no longer reads or writes a machine-wide vault pointer, and `oms setup` / `oms install` no longer create one. A command run outside a vault, with no bridge and no `OMS_VAULT`, now resolves to the current directory and refuses to write, instead of silently falling back to whatever vault happened to be registered once. Run the command from inside your vault, pass `--vault`, set `OMS_VAULT`, or bridge the directory with `oms link`. An existing `~/.oms/config.yaml` is ignored and can be deleted.

  **If you use an MCP host, check its server configuration.** Any host that launches `oms mcp` with no `--vault` and no `OMS_VAULT` in its env block was relying on the registry and will stop resolving a vault. Claude is handled for you — see below — but hand-written host configurations need the vault passed explicitly.

### Changed

- **The Claude installer now records your vault, the way the Codex and Hermes installers always have.** `oms install --runtime claude` registers `oms` as a user-scope MCP server in `~/.claude.json` with the resolved vault baked in as an absolute `--vault` argument, and `oms uninstall` removes it again. Claude was the one adapter that shipped no vault of its own: its plugin `.mcp.json` is owned and rewritten by npm on every update, so it can never hold a per-machine path, and it leaned on the global registry to cover the difference. That file is left untouched as a fallback for anyone who prefers to set `OMS_VAULT` themselves, and unrelated entries already in `~/.claude.json` are preserved byte for byte.

### Fixed

- **Running this repository's test suite or release smoke script no longer writes into your real home directory.** Both spawned the packaged `oms` CLI with the developer's own `HOME` inherited, so `oms setup` wrote a global vault registry pointing at a temporary directory that the run then deleted — leaving the next real `oms` command to fail on a vault path that no longer existed. Child processes now run against a throwaway home, and the suites assert that real home state is untouched. Installed users were never affected; this only ever hit people running the repository's own tests.

## [0.6.2] - 2026-08-27

### Fixed

- **A single unparseable note no longer disables the entire vault.** Two independent whole-vault aborts meant that one bad file anywhere made `oms_search` return no results and `oms_status` report `ontologySource: "vault-invalid"` with write tools disabled. Both are fixed: `taxonomy.yaml: exclude` is now honoured by the walkers that feed retrieval, and a frontmatter field set to an empty string is treated as unset rather than as an error. Vaults that hit this will start returning results again with no configuration change.

- **A search for a kind of note now reaches that kind.** Asking for a person, a meeting, or a project matched only notes whose text happened to repeat the word, because the `search` skill described a text query and never mentioned the axes the engine already supports. The skill now routes a named kind onto a frontmatter axis and discovers the available axis keys from the response itself, so the vault's own declared structure is used instead of guessed at.

## [0.6.1] - 2026-08-27

### Fixed

- **0.6.1 is the first published build of the 0.6.0 changes.** The `oms-v0.6.0` tag was cut but its release job failed before publishing, so that version reached neither npm nor a GitHub Release. Tags are immutable here, so the fix ships forward rather than by retagging. Everything listed under 0.6.0 below is delivered by this release.
- **Measurement configuration no longer misreads an unset CI variable.** An unset GitHub Actions variable expands to an empty string, so the release job supplied an empty preregistered qrels digest and the evaluation harness rejected it as malformed. Empty and whitespace-only measurement environment values now mean not configured; a non-empty malformed value still fails loudly. The measurement test suites also read that ambient job configuration instead of the case under test, and are now isolated from it.

## [0.6.0] - 2026-08-27

### Breaking

- **MCP search and doctor operation names have changed.** Use `oms_search` with `op: "query"` for axis retrieval; the retired `axis` and `semantic-query` names now fail loudly. Collection, context, and status operations have likewise dropped their `semantic-` prefixes, and `oms_doctor` cleanup is now `op: "cleanup"` rather than `semantic-cleanup`. There are no compatibility aliases, so update MCP clients to these names. Every query response now includes `hits`, `totalCount`, `facets`, a cursor, and a receipt.
- **Existing vector indexes must be rebuilt.** The embedding metadata version is now `oms-embed-meta-v2`, and the index identity includes dimensions, context length, MRL dimension, normalization, and prefix scheme. OMS rejects an index whose metadata or identity does not match rather than using vectors produced under a different contract. Rebuild it with `oms semantic sync --force`.

### Added

- **Frontmatter axes are now typed and queryable.** The user-owned JSON contract lives at `.oms/types.json`; `.obsidian/types.json` is read as a read-only type authority. Legacy YAML is ignored without migration. Search can filter typed frontmatter axes, return their facets, and page results with a cursor.

### Changed

- **Released ranking stays evidence-backed.** The default remains the v0.3.0 additive provenance baseline, with no unmeasured ranking change in this release. The `boost-k-scale`, `boost-per-list`, and `boost-zero` arms remain candidates pending the C040 experiment.
- **Embedding setup remains explicit.** Default model acquisition is still deferred: configure `OMS_EMBEDDING_PROVIDER` and `OMS_EMBEDDING_MODEL` as before. To install an operator-supplied model, use `oms setup --embedding-descriptor <path>`; OMS verifies its SHA-256 before accepting it.

### Fixed

- **`oms update` is safer in interactive and automated use.** It asks for confirmation from a TTY, requires `--yes` without one, and keeps `--dry-run` and `--check` read-only. Version comparison now follows SemVer precedence, failed host reconciliation returns a non-zero exit status, and an unverified current-directory target is refused rather than updated.

## [0.3.0] - 2026-08-24

### Breaking

- **The MCP surface is five tools.** `oms_write`, `oms_search`, `oms_link`, `oms_status` and `oms_doctor` replace the previous twenty-three. The eighteen detail tools were not deleted: each is reachable through an `op` parameter on the tool that owns it, so no capability was lost. A client that calls a detail tool by its old name must switch to the owning tool plus `op`. See [CHANGELOG-mcp.md](./CHANGELOG-mcp.md) for the operation map.
- **The qmd-compatible aliases are gone.** The `query`, `get`, `multi_get` and `status` commands and the `qmd://` resource were retired; ADR-009's D2 is superseded by ADR-010, while D1 remains in force. The canonical nested commands `oms semantic query|status|get|multi-get|vsearch` are unaffected.
- **`oms_search` no longer accepts sync parameters.** `embeddingSyncBeforeSearch` and its siblings let a caller turn a search into a write, which is incompatible with the read-only guarantee the tool now makes. Preparing index data on disk is `oms_doctor { op: "sync-embeddings" }`, which is annotated as writing.

### Changed

- **`src/` is five role layers.** `kernel`, `cli`, `mcp`, `vendors` and `assets` replace twenty-one top-level entries, and `adapters/` is dissolved. The domain library is the kernel; the CLI and MCP server are thin entrypoints over it. Three import-direction, module-size and surface-parity gates enforce the boundaries, and all of them fail closed rather than passing on an empty scan.
- **Skills exist once.** `assets/skills/` holds exactly six — `write`, `search`, `link`, `distill`, `status`, `doctor` — replacing near-duplicate copies that had drifted across four vendor trees. This works because the plugin root is the repository root, so every host manifest points at the same directory; there is no copy step and no generated manifest.
- **`oms_search` is genuinely read-only** and is annotated as such. It previously created `.oms/` and an SQLite store on a plain search. Searching an unindexed vault still returns results, now from an index built in memory for the session, so the vault is left byte-identical. This matters because MCP hosts may auto-approve tools that declare themselves read-only.
- The published package now ships `ACKNOWLEDGMENTS.md`, because the licence section links to it and shipping the note without its target left a dangling reference in the artifact.
- `docs/release.md` no longer ships. It documents how to release this package, which an installed consumer cannot do; the READMEs link to the repository copy instead.

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
