# Vendors Changelog

Per-host adapter and installer changes belong here.

## [Unreleased]

- **Shipped host instructions stop bounding repair by a retry budget.** The Claude and Codex guidance still told agents their repairs were limited by the user's finite retry budget. Version 5 declares no budget and counts no attempts, and `agentRepair` lives in the portable `.oms/settings.json`; both now say to ask the user rather than retry blindly.
- **The installed Hermes adapter README no longer claims OMS judges completion.** It described a fresh delegated semantic reviewer with approved criteria and an evidence requirement, contradicting both the corrected Hermes role guidance and the runtime, which returns `semantic: "not-evaluated"`. It now describes contract selection, the agent's own write, and the structural check.
- **The `oms-reviewer` host role is retired.** It was built entirely around the deleted completion protocol: it demanded a supplied request digest, an approved semantic rubric, an evidence manifest, and it ended by saying OMS would recheck the note and evidence snapshots before judging completion. No surface can produce that request or consume its result, so an agent could not use the role at all, and shipping it contradicted the corrected host guidance. The Claude plugin agent, the Codex custom-agent role and its shipped asset, the harness reviewer registry, and the reviewer asset-health lane are gone with no alias. `oms host remove` still deletes a role and provenance sidecar an earlier version installed, and only when the OMS-written provenance record proves ownership; a foreign agent file is still left in place and reported.
- **The shipped Codex rule teaches the published version-5 contract.** It named the version-4 policy with an additive-only default, routed writing through `guide → check → separate reviewer → complete`, and required review evidence for completion. It now names the published document, the common contract that needs no Markdown file, per-registration relaxation the user approved, a structural `check` that returns `semantic: "not-evaluated"`, and `review-sources` for a changed source.
- **Shipped host instructions describe the published version-5 contract.** The vault-authority block named the version-4 policy with its always-on additive default; it now names the published document, the common contract that needs no Markdown file, per-registration relaxation the user approved, and `.oms/types.json` as a historical artifact version 5 neither derives nor reads.
- **The Claude PostToolUse hook reads the published V5 contract.** After a save it composes the common contract or the named registration from `.oms/template-policy.json` and reports the observed frontmatter and heading violations. On a V5 vault the hook previously failed its read and printed a misleading "cannot read the approved contract" line after every write; it also now points a changed registered source at `oms template review-sources`.
## [0.16.0] - 2026-09-23

- Codex installs an optional provenance-owned reviewer role while preserving unowned collisions; a genuine generic separate subagent remains valid without custom-role discovery. Dry-run skill paths now match the eight installed shared skills.
- Hermes guidance uses its native fresh-conversation delegation with inherited tools and explicit non-modification instructions, without claiming unavailable sandbox enforcement.

## [0.15.0] - 2026-09-19

- **Claude, Codex, and Hermes guidance now aligns with folder-sourced template contracts.** Each native host surface explains selected-folder census without per-file registration or folder modes, the exact minimal notice and host-only `나중에`, and the resumable `interview-next` → `interview-answer` → `commit-contracts` flow. Review preserves source bytes and publishes only user-confirmed controls; affected-template pending remains scoped while shared-authority failures stay fail-closed globally. Note creation uses explicit folder, taxonomy default, then `ask`, without changing the host-specific skill/tool asymmetry.

## [0.14.0] - 2026-09-05

- Native host launch manifests use `oms serve mcp`; registrations retain seven shared skills and exactly five MCP tools. Host synchronization updates OMS assets independently of package installation and never upgrades the host application. (#125)
## [0.13.0] - 2026-09-05

- **The shipped GJC skills mirror is now checked file-for-file against authored skills, with drift failures directing contributors to `npm run sync:skills`.**

### Changed

- **Supported host guidance now names the single-qualified OMS tools.** Hermes, Claude, and Codex users see `oms_write`, `oms_search`, `oms_link`, `oms_status`, and `oms_doctor`, never `oms_oms_*`; raw MCP integrations must replace local calls `oms_write`/`oms_search`/`oms_link`/`oms_status`/`oms_doctor` with `write`/`search`/`link`/`status`/`doctor`.

### Added

- **Gajae-Code now has a marketplace-plugin skill channel at the package-root `skills/` convention path; previously it installed OMS successfully while silently discovering zero skills.**

## [0.12.2] - 2026-09-01

## [0.12.1] - 2026-09-01

## [0.12.0] - 2026-09-01

## [0.11.1] - 2026-09-01

### Changed

- **Hermes provenance uses the canonical `oms-provenance.json` filename and `skillTreeDigest` field.** The former dot-file name is never read or specially handled; adapter-directory replacement owns cleanup. Legacy adoption requires a genuine older-version handoff: a parseable manifest whose semver is strictly lower than the running package, exactly seven canonical skill directories, and a `SKILL.md` in each — a same-version manifest without provenance is rejected as forged. Fault-injection and vault-reconcile matrices run on both the default and `profiles/xia` roots.

## [0.11.0] - 2026-09-01

### Changed

- **Hermes installation is provenance-aware and one-root.** (#90) Each install targets exactly the resolved `OMS_HERMES_HOME` root (Sari: `~/.hermes`; Xia: `~/.hermes/profiles/xia`), records npm provenance (version + deterministic skill-tree digest) under `adapters/oms/`, no-ops on three-way identity while still reconciling a changed vault registration, replaces owned drift atomically, fails closed on foreign or tampered trees with explicit resolution guidance, adopts only the exact legacy layout, and keeps uninstall symmetric — foreign trees are never blind-deleted.

## [0.10.1] - 2026-09-01

### Fixed

- **Codex managed-marker rewrites fail closed on ambiguity.** (#54) The greedy regex span removal is replaced by a line scanner: exactly one ordered `BEGIN`/`END` pair enclosing `[mcp_servers.oms]` is rewritten in place; orphan, duplicate, reversed, or nested markers refuse to write a single byte and report the config path with 1-based marker line numbers plus manual removal steps. Marker-free legacy tables continue to be cleaned up normally.
- **Hermes install/uninstall is now a guarded transaction.** (#89) `Prepare → Admission → Apply → Verify`: all sources, symlink targets, and the YAML edit are validated before any write; OMS-owned adapter/skill files commit first and `config.yaml` commits last via a pre-imaged atomic temp→rename write; verification reparses the config, any failure restores the config byte-for-byte, and a rollback failure preserves both errors. Registration failures are no longer downgraded to warnings.

## [0.10.0] - 2026-09-01

## [0.9.0] - 2026-08-31

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
