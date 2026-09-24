# Assets Changelog

Skills, agents, templates, and host guidance changes belong here.

## [Unreleased]

- **The `write` skill documents the source review lane.** A changed registered source does not change the contract; acknowledgment records the reviewed bytes, relocation needs a genuinely missing original and an explicit candidate, and matching bytes are evidence rather than permission.
- **The `write` skill documents contract selection.** Guide requires an explicit note path and returns a session locator; check passes that locator instead of repeating a task binding, and the skill states that a changed contract or moved source ends the selection.
- **The `write` skill no longer instructs a reviewer handoff.** Its review and complete sections are gone; the skill guides, tells the agent to write the file, and checks the saved bytes. The `status` skill no longer contrasts a health report with a completion call.
## [0.16.0] - 2026-09-23
- Live host-facing docs no longer show a copyable `interview-next` call without `proposals`. Confirming the template notice still starts that mode, but the same proposals array must reach review, answer, and commit.
- Search, status, and write skills now say `templateNotice.next` is a mode hint, not a replayable `interview-next` CallToolRequest.

- Eight shared skills now include a tool-less contract interview. Guidance separates agent-owned note writing from OMS guidance, saved-file checks, and completion using a separate reviewer; search and ordinary note errors do not start configuration interviews. Generated GJC mirrors share the authored skill bytes.
- Reviewer guidance distinguishes host claims, agent transcription, and OMS-computed digests. Matching role-definition bytes is not proof of a separate launch, enforced tool restrictions, or whole-vault immutability.

## [0.15.0] - 2026-09-19

- **Host guidance now teaches selected-folder template sources instead of per-file registration or folder modes.** It documents the exact `템플릿에 변경이 있습니다` / `확인하기` / `나중에` notice, host-only deferral, long-lived `templateNotice` results, and the resumable `interview-next` → `interview-answer` → `commit-contracts` flow that publishes only user-confirmed controls. Placement is write-time only (explicit destination, then taxonomy default, then `ask`); source review preserves Markdown bytes and does not invent a registration prerequisite, widget, or host configuration.

## [0.14.0] - 2026-09-05

- Shared skills and runtime guidance use the final command families and exclusive MCP operations, with no obsolete command aliases. Authored assets and the shipped root skill mirror remain byte-identical. (#125)
- Template and write guidance share the guarded CLI/MCP verbs and distinguish default note bindings from source-folder creation defaults. (#124)
- Status guidance distinguishes permanent external observation history from vault-owned convention files and avoids claiming inactivity from missing events. (#123)
- **Template and write skills distinguish external renderers from OMS note creation.** (#122) Hosts propose converted copies or observed contracts for user approval; the kernel validates them without executing scripts. Guidance explains missing Obsidian-filled values, external-body refusals, and unobserved contracts.
## [0.13.0] - 2026-09-05

- **The npm package now ships a generated root `skills/` mirror of the single authored `assets/skills/` source for Gajae-Code, whose convention scan previously found zero OMS skills silently.**

## [0.12.2] - 2026-09-01

## [0.12.1] - 2026-09-01

## [0.12.0] - 2026-09-01

- **Guidance now identifies `.oms/taxonomy.json` as the user-owned folder/link authority.**

## [0.11.1] - 2026-09-01

## [0.11.0] - 2026-09-01

## [0.10.1] - 2026-09-01

## [0.10.0] - 2026-09-01

### Changed

- **The `/search` skill now documents an explicit `strategy` in `oms_search` calls with `op: "query"`.** Its frontmatter is unchanged.

## [0.9.0] - 2026-08-31

### Changed

- **The seven shared skills, including the tool-less template authoring workflow, now teach stable template IDs, derived axes, explicit repair approval, and template/ontology coexistence.** Claude, Codex, and Hermes guidance separates template-owned shape from user-owned note/field/folder/link meaning. It no longer describes `concept` identity, personas, retrieval lenses, hand-edited projection state, or bundled note-type defaults.

## [0.8.4] - 2026-08-30

## [0.8.3] - 2026-08-29

## [0.8.2] - 2026-08-29

## [0.8.1] - 2026-08-29

## [0.8.0] - 2026-08-29

## [0.7.0] - 2026-08-27

## [0.6.2] - 2026-08-27

### Changed

- The `search` skill now documents axes, so a request that names a kind reaches the right notes. `query` matches text only; a note whose body never restates its own subject was unreachable by the bare query the skill described, even though the vault declares the kind as a frontmatter axis. The skill now says to put a named kind, declared property, or relationship on `axes.field.<key>`, `axes.folder`, or `axes.link`, to discover the available keys from the `facets` in every response and from `op: "concepts"` rather than guessing them, and to treat a refused axis — which returns `available: false` with a `reason`, not an error — as a signal to read `facets`. It also records the two constraints that silently return nothing when missed: an axis query matches lexically, so pairing it with explicit `vec`/`hyde` retrieval is refused, and `concept` is folder-derived rather than a property, so it is scoped with `axes.folder` or `op: "context"`. An axis filter with `query` omitted enumerates a whole kind.

## [0.6.1] - 2026-08-27

## [0.6.0] - 2026-08-27

## [0.3.0] - 2026-08-24

### Fixed

- Packaged host guidance names the invocations each host actually installs. Codex namespaces every skill under an `oms-` prefix, so its guidance now says `$oms-write` rather than `$write`, which would fail on a real install. A reference to `core/agents/retriever.md` was also removed: that path never shipped in the npm artifact, so it was broken for every installed user while resolving fine in the repository.

### Added

- `assets/skills/` is the single authored source for all six skills — `write`, `search`, `link`, `distill`, `status`, `doctor` — replacing four drifted copies. Frontmatter is restricted to `name`, `description`, `aliases`, `mcp_tool` and `mcp_args`; the five skills that declare a tool are validated against that tool's advertised schema, so a skill cannot ship arguments its tool would reject.

### Removed

- `skills-manifest.yaml`. It declared itself generated while no generator existed, had no consumer anywhere in the source, scripts or CI, and never shipped in the package.
