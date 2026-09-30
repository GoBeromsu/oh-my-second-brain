# Assets Changelog

Skills, agents, templates, and host guidance changes belong here.

## [Unreleased]

## [0.20.3] - 2026-09-30

- **The doctor skill names the reseal command for a broken seal.** It said a tampered or unreadable contract store is diagnosed with `oms doctor contract` and then resealed at a terminal, without naming `oms interview`, while the `contract-unreadable` write warning names `oms interview`. The skill now names both steps: `oms doctor contract` diagnoses, and the user reseals with `oms interview`.

## [0.20.2] - 2026-09-30

- **The doctor skill names `oms interview` for a missing seal.** It still sent every broken or missing seal to `oms setup`, while the `contract-open` write warning and `oms doctor status` name `oms interview` for a missing contract, and `oms doctor status` names `oms doctor contract` for a tampered or unreadable store. A Hermes trial on 0.20.1 read the two routes as conflicting; the skill now matches the receipt.

## [0.20.1] - 2026-09-30

- **Host guidance names `oms interview` for a missing seal.** The Claude, Codex and Hermes guidance used to send the user to `oms setup` for a broken or missing seal. A missing seal is now sealed with `oms interview`, the command the write warning names, and a broken one is checked with `oms doctor contract`.
- **The write skill lists the full receipt and tells the agent to relay `next`.** The receipt is described with `warnings`, `fixes` and `next?`, and the denial with its real `status`, `refusals` and `violations` shape. It no longer says an unreadable contract denies writes: an unsealed or unreadable contract saves the note with a warning that names `oms interview`, and only a tampered contract is denied, pending `oms doctor contract`.

## [0.20.0] - 2026-09-30

- **The doctor skill covers contract evolution.** It describes `evolve`, `evolve-verdict` and `revert-propose`, requires the maker's session on `evolve` and keeps the maker from judging its own request, explains the stage-2 refusal of an overlapping or drifting candidate, says a revert always requires owner approval, says the quorum is host-attested and cannot be verified by OMS, which is why autonomy is off by default, tells a host without independent evaluator subagents to stop and send the owner to `oms setup`, and sends `reclaim-evolution-lock` and `lineage-reanchor` to the owner's terminal.
- **The setup and interview skills cover folders and properties only.** The setup skill drops the template-interpretation steps (`--interpretations`, `observedHash`, `interpretation-required`, `interpretation-rejected`) and describes `oms setup extract --template <name>` as a scaffold preview; the interview skill drops the `interpretations` parameter. The write, search and doctor skills describe templates as live files in the template folder that scaffold new notes and are never judged.
- **The setup skill no longer describes a `template-tightened` refusal.** Reseal no longer refuses a template answered more strictly, because the judge never reads a template.

## [0.19.0] - 2026-09-28

- **Breaking: six shared skills.** `write`, `search`, `interview`, `distill`, `setup`, and `doctor`. The `link` skill is folded into `search` (suggest) and `doctor` (check), the `status` skill into `doctor` `op: "status"`, and the new `interview` skill reads the pending questions without sealing. Every skill and host guidance file uses the 0.19 command spellings.

- Refresh the English and Korean README with an original, self-contained constellation SVG inspired by beomsukoh.com, compact feature cards, a four-step quickstart, and navigable reference sections. Keep contract and host enforcement boundaries explicit, and align the setup skill count with the current seven-skill registry. Runtime behavior is unchanged.

- **The `setup` skill reads each template itself before asking anything.** It now submits `{source, observedHash, fields, headings}` per template with `--interpretations`, handles the `interpretation-required` and `interpretation-rejected` results, and is told plainly that a field left out of an interpretation is a question the owner is never asked, and that `observedHash` must come from reading the bytes rather than from copying the hash OMS printed.

## [0.18.3] - 2026-09-26

## [0.18.2] - 2026-09-26

## [0.18.1] - 2026-09-26

- The Hermes README and SOUL name the skill category `knowledge-management`: filter with `skills_list(category="knowledge-management")`, since `knowledge-management/oms` matches nothing. The `status` skill describes `readTools` and `writeTools` separately.

## [0.18.0] - 2026-09-25

- **The `setup` skill is added (seven skills).** It walks the owner through `oms setup --questions` and `oms setup --answers`, asking each question with the recommended option first, keeping the answers file outside the vault and deleting it afterwards, and sending any loosening reseal or seal recovery to the owner's terminal. Host guidance and the `doctor`, `status`, and `write` skills no longer say the agent never runs setup; they name the skill for a first or stricter seal and keep recovery and loosening with the terminal.
- **The `setup` skill spells out what it must never do.** It never runs `oms setup` or `oms contract setup` without `--questions` or `--answers`, never runs setup under a pty wrapper (`script`, `expect`, `unbuffer`), and never moves the vault or deletes, edits, or re-IDs `.oms/settings.json`. It notes that adding a folder, property, or template widens a closed axis, and sends a `pattern-unsafe` change to the owner's terminal. It says the skill path may add new entries, but changing a sealed template, even to make it stricter, is `template-tightened` and needs `oms setup` in the owner's terminal.

## [0.17.0] - 2026-09-25

- **Breaking: host guidance describes the sealed contract.** The `interview` and `template` skills are deleted, leaving six skills. Guidance tells agents to write whole notes through `write {path, content, template?}`, to stay inside the sealed property pool, never to read or write `~/.oms/`, and to ask the user to run `oms setup` on `contract-unreadable`.
- **The `link` skill describes the payload it returns.** A suggestion carries a `baseContentHash` and a stable `id` per candidate, and `link { op: "check" }` requires `notePath`.

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
