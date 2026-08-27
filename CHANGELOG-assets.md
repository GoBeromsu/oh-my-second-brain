# Assets Changelog

Skills, agents, and ontology data changes belong here.

## [Unreleased]

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
