# CLI Changelog

Changes to the `oms` command surface belong here.

## [Unreleased]

- **`oms setup` / `oms interview` seal folders and properties only.** Neither lists, asks about, previews or seals templates any more; templates in the `templateFolder` scaffold new notes and are never judged. A sealed result's JSON carries `warnings` when the seal raised any, such as `CONTRACT_LEGACY_TEMPLATES_DROPPED` for a reseal that drops an older generation's templates, and no longer has a `templates` field. `--interpretations` is removed and is now an unknown argument (`CONTRACT_ARGS_INVALID`), and the `interpretation-required` and `interpretation-rejected` statuses are gone. `oms setup extract --template <name>` now previews what a live template would scaffold, printing `{status: "scaffold", name, source, folder, properties, headings}`, or `{status: "missing", template, remediation}` with exit 1 for an unknown name; it no longer prints a source hash.
- **`oms doctor contract` reports `legacyTemplates` instead of `templates`.** The status payload's `templates` field is replaced by `legacyTemplates`, the number of template constraints an older (version 1 or 2) contract generation still carries and the judge now ignores; a new contract generation reports `0`. A non-zero count is also listed as the finding `legacy-template-constraints-ignored: N` with `oms setup` as guidance.
- **`oms write` prints warnings and fixes.** After the JSON result, a saved write prints `[oms] warnings: [{field, kind}]` and `[oms] fixed: [{field, kind}]` to stderr when either is non-empty, and the receipt's `fixes` now lists the lossless fixes the write applied instead of dropped keys. A write with an unknown key or an out-of-rule value is saved as written rather than drafted; only unparseable frontmatter is drafted.
- **`oms search` stops looking for `--vault` after a `--` terminator.** A query such as `oms search --vault notes -- --vault elsewhere` searches `notes` for the text `--vault elsewhere` instead of reading the second `--vault` as the flag. `oms search --link <note>` refuses a `--` terminator with `SEARCH_ARGS_INVALID` rather than forwarding the tokens after it to link suggestion as flags.
- **`oms doctor gaps` reports open contract gaps and contradictions.** It prints the same read-only report as the MCP `doctor` `op: gaps`. It exits 1 only when the contract contradicts itself, the ledger cannot be read, or a ledger line is corrupt; open gaps are the ledger doing its job, and `ledger: "truncated"` is a warning that leaves the exit code alone. `oms write` follows the new write pipeline, so a write that only adds keys the frame has no place for is saved without them and reports the dropped fields in its receipt. `oms write --check` prints the `resolution` the write would apply.
- **`oms write` saves or drafts where it used to refuse.** Only a safety refusal denies a write, reported as `status: "denied"` with `refusals`. In a sealed vault, only a note whose frontmatter does not parse is kept as a draft and printed as `status: "drafted"` with a `draftRef`; like a denial it exits 1. Every other write is saved, with lossless fixes applied and the rest kept as written. A saved note's receipt lists the saved note's `warnings` and, as `fixes`, the `{field, kind}` of each lossless fix it applied, and `--check` prints `refusals`, `warnings` and `fixes`. `oms doctor contract` prints a `hint` with a transport failure when the installed guard needs `oms setup host sync`.
- **`oms doctor lineage-recover` and `oms doctor lineage-reanchor` repair the contract lineage.** They print the same result as the MCP `doctor` ops of the same name, and they take `--vault <path>` or resolve the vault the usual way. A `cwd`-inferred vault is rejected. A refused gap, a vault that is not sealed, or bad arguments exit 1. `oms doctor contract` now reports a `lineage` field: events, snapshots, snapshot bytes, and findings, each naming the repair it needs. It exits 1 when a finding needs attention. A store sealed before the lineage existed, a snapshot kept from a crashed seal, and a cut-short last line are reported but do not fail the check.
- **Lineage repair failures no longer leak paths or unknown codes.** When `oms doctor lineage-recover` or `oms doctor lineage-reanchor` fails, a diagnostic keeps the error's code only when it is a real `CODE:` prefix; any other failure, including a thrown non-Error value, reports `CONTRACT_LINEAGE_REPAIR_FAILED`. Absolute paths in the message, quoted ones with spaces included, are printed as `<path>`.
- **`oms search --context` refuses a `--` terminator.** Context retrieval takes only flags, and the terminator used to reach its flag parser as the token `--`, which failed with the unclear `unknown context flag --`. It now fails with `--context does not accept a -- terminator`, the same way `--link` does.

## [0.19.0] - 2026-09-28

- **`oms write` takes `--if-match sha256:<rev>` and `--check`.** Overwriting an existing note without `--if-match` exits 1 with `WRITE_IF_MATCH_REQUIRED` and leaves the file unchanged; a stale revision reports the retryable `WRITE_TARGET_CHANGED`, and `--if-match` for a note that does not exist reports the retryable `WRITE_TARGET_ABSENT`. `--check` prints the frame, the note's current revision and any violations and writes nothing, not even an index row. Each flag may be given once, and `--if-match` requires a value. The receipt is the one MCP `write` returns.

- **`oms interview` continues an interrupted interview, and `--restart` starts over.** Every answer is logged beside the contract store, so closing the terminal mid-interview no longer loses the answers already given: the next `oms interview` replays them, says how many it continued with, asks only what is left, and reports any logged answer it dropped because its question changed. `--restart` logs the earlier run as abandoned and asks everything again. It still refuses without a TTY or under `OMS_NON_INTERACTIVE=1`, and a refused run logs nothing. A vault that was never sealed gets no `.oms/settings.json` until the seal; its answers are logged under a pending key outside the vault. `--vault --restart` is refused as a missing `--vault` value rather than read as a restart. `oms doctor contract` reports corrupt interview log lines by line number under `interviewLog`, exits 1, and repairs nothing. An unsafe entry in the state directory is reported as `STATE_DIR_UNSAFE` without echoing its path.

- **Breaking: the `oms` command surface is seven families.** `search`, `interview`, `write`, `setup`, `doctor`, `serve`, and the hidden `hook` replace the fourteen 0.18 families. A removed family (`note`, `link`, `status`, `contract`, `index`, `graph`, `host`, `model`, `package`, `bridge`) is not an alias: it exits 1, runs nothing, and prints its 0.19 spelling, for example ``[oms] Command `index` was removed in 0.19. Use `oms doctor sync-embeddings --mode sync|embed|repair`, `oms doctor cleanup`, or `oms doctor status`.`` `oms search <text>` takes `--mode`, `--context`, `--path`, and `--link`; `oms doctor` owns `status` (read-only), `contract`, `audit`, `link-check`, `sync-embeddings --mode sync|embed|repair`, `cleanup`, and `build-graph`; `oms setup` keeps the interview and gains the `extract`, `status`, `host`, `model`, `package`, and `bridge` leaves. `docs/migration-0.19.md` maps every 0.18 spelling, and `test/architecture/migration-table.test.ts` dispatches each row against the built CLI.
- **`oms doctor status --view status|collections|contexts` reaches the search-index views.** The 0.18 `oms index status` views were unreachable after the family was removed. `oms doctor status` now routes to them when `--view`, `--index` or `--collection` is given, stays read-only, and reports `No engine store` instead of creating one; an unknown view exits 1 with the usage line. Without those flags it still prints the vault health report. The dead `graph status` verb is gone: graph health is the `graph` section of `oms doctor status`.
- **`oms search --link` honours the resolved arguments.** The note path and `--json` are read from the resolved argv, so `oms search --link <note>` behaves the same wherever `--vault` appears.
- **`oms write <path>` writes a note from stdin through the same judge as MCP `write`.** It runs the same write pipeline, so a `cwd`-inferred target is refused, a violation exits 1 with `{field, kind}` violations and one guidance command and leaves the file untouched, and an allowed write prints the same receipt as the MCP tool.
- **`oms interview` runs the interactive interview.** Like `oms setup`, it refuses without a TTY or under `OMS_NON_INTERACTIVE=1`.

- **`oms search --path <rel>` reads one note exactly, without opening the index or loading a model.** It is the normalization-insensitive answer to the `oms note get` gap: an NFC request finds an NFD-named note on macOS and Linux alike. The output is the document shape `{available, documents: [{target, path, content, revision}]}`; a missing, ambiguous or escaping path prints `available: false` with a reason and exits 1. `--path` must come first and is mutually exclusive with `query`, `context`, `--mode` and every other search argument; a `--path` later in the arguments is refused. `oms search query` now accepts a `--` terminator, after which every token is query text, so `oms search query -- "--path"` searches for the literal text.

- **Every `oms` command starts faster, because the entrypoint loads only the command that runs.** `oms` used to import every command module, the MCP and HTTP servers, and the search engine with its native SQLite modules before it dispatched, so even `oms --version` paid about 400 ms. Each command family is now imported when it is dispatched, and `search` loads the engine only for `query`, `context` and `index`. `oms search --path` loads 12 modules and no native dependency; on the measurement machine its p50 fell to about 88 ms, `oms --version` fell from about 410 ms to 90 ms, and `note get` and `search query` fell by roughly 300-400 ms and 100-200 ms. Output and exit codes are unchanged. See `docs/measurements/latency-search-path.md`.

- **`oms setup` takes the template interpretations an agent read.** A vault with templates now ends `interpretation-required`, listing every template source with the `sourceHash` OMS computed, until `--interpretations <file|->` supplies what each one declares; the file stays outside the vault like the answers file. `interpretation-rejected` reports the templates whose interpretation the owner did not confirm, and it is not a refusal — a corrected interpretation may be submitted. `oms contract extract --template <path>` no longer prints fields and headings, since OMS does not parse template text; it reports the source and the hash an interpretation must match.

## [0.18.3] - 2026-09-26

## [0.18.2] - 2026-09-26

## [0.18.1] - 2026-09-26

- **`oms --version` and `oms -v` print the installed package version.** Hosts and agents can now confirm the release from the CLI. An unknown flag or extra argument still exits 1 with `[oms] Unknown command:`.

## [0.18.0] - 2026-09-25

- **`oms setup` and `oms contract setup` take `--questions` and `--answers <file|->`.** `--questions` prints the interview questions as JSON and seals nothing; `--answers` runs the same interview from a JSON object of answers by question id (`-` reads stdin) and seals. Missing answers return `incomplete` with the follow-up questions; an invalid, unknown, or malformed answer, an answers file inside the vault, or both flags together exit 1 and seal nothing. A reseal through `--answers` must be equal or stricter; loosening exits 1 with `status: loosening`, `{field, kind}` changes and no values, and points at `oms setup` in a terminal. The interactive setup is unchanged and keeps full authority, and the non-TTY refusal now names the two-step path.
- **`oms contract doctor` reports `unsafePatterns`.** Each entry is `{field, kind: "pattern-unsafe"}` for a sealed pattern the seal screen now refuses; the report is unhealthy and recovery is `oms setup` in a terminal. `--answers` now accepts an answers file whose name merely starts with two dots (such as `..answers.json`) only when it is actually outside the vault; one inside the vault is refused.

## [0.17.0] - 2026-09-25

- **Breaking: `oms template` is removed; the contract lives under `oms setup` and `oms contract setup|extract|status|doctor`.** `oms setup` is interactive only and refuses to run without a TTY or under `OMS_NON_INTERACTIVE=1`. `oms note guide` and `oms note check` are removed; `oms note audit` judges existing notes against the seal. `oms hook pre` replaces the retired hook leaves. Older `.oms/*` files are ignored and a `templateRoots` settings key is rejected. Upgrade order: (1) install this release and run `oms host sync`; (2) back up `.oms/settings.json` and keep only `version`, `vaultId`, `templateFolder` (formerly `templateRoots`), `embedding`, and `agentRepair`; (3) run `oms setup` at a terminal to seal the vault; (4) run `oms contract doctor` and review the unexpected control files it lists under `.oms/`; (5) keep those backups while a rollback to 0.16.0 is still possible.
- **Breaking: `oms setup` is the interactive vault-contract seal, the same as `oms contract setup`.** It needs an interactive terminal and refuses `--dry-run`, `--yes`, `--approval-token`, `--approved-digest`, `--install-claude`, `--models-default`, `--models-descriptor`, `--models-no-default`, and `--template-folder`, naming the command that now owns each concern (`oms host install`, `oms model install --default`, `oms model install --descriptor`, `oms model waive --yes`). Embedding remedies point at `oms model install` and `oms model select` rather than `.oms/models.json`.
- **`oms --help` describes real vault resolution.** It said an omitted `--vault` defaults to the current directory, hiding that resolution checks local vault controls, a bridge link, and `OMS_VAULT` first and treats the current directory as a read-only fallback that cannot admit a mutation.
- **`oms note` drops an empty repeatable-flag branch.** The set was permanently empty, so its accumulation path could never execute and the option type promised arrays the parser never produced.
- **`oms bridge` reports the stage that actually blocked.** Vault publication, global registry, reservation, and project projection each report their own bounded code and reason; stages that were never attempted are reported as unattempted rather than as failures, and malformed registry bytes are preserved exactly as found.

## [0.16.0] - 2026-09-23

- Host discovery reports the eight actual Codex skill paths and installed reviewer-definition health instead of the retired setup skill. Discovery and installation now resolve relative host-home overrides consistently; definition health is not reviewer execution proof.

## [0.15.0] - 2026-09-19

- **Breaking: the template CLI now exposes a selected-folder census and linear review flow.** The exact leaves are `scan|list|show|add|update|move|remove|default|check|regenerate-types|review|answer|commit`; `scan` is read-only, `add <folder>` selects source scope, and `add --id <id> --from <file>` remains explicit source authoring rather than contract review. `answer <question-id> --answer <JSON> --census-digest <digest> --ledger-digest <digest|null>` forwards server-returned CAS fields, while `commit` adds the existing dry-run or `--yes --approved-digest` guard. This removes the per-file registration ritual without weakening verified-target writes; note creation considers `--folder <note-folder>` before a taxonomy default and then `ask`, with no template-creation target-folder form.

## [0.14.0] - 2026-09-05

- HTTP routes reject malformed bodies and fields instead of coercing them into empty queries. Status retains unaffected component evidence when convention, history, engine, or graph health is unavailable. (#125)
- **CLI operations now have explicit, non-overlapping families.** (#125) `note`, `template`, `link`, `bridge`, `search`, `index`, `graph`, `host`, `package`, `model`, `serve`, `hook`, and `status` retain real capabilities without retired aliases. Package updates no longer force host synchronization; read-only health and server startup do not create a vault store.
- **The template command family exposes guarded convention management.** (#124) Inspect, scan, register, create, update, move, remove, check, and select default bindings through shared kernel operations. Mutations require a reviewed dry-run digest rather than direct vault edits.

- **Breaking: `oms setup --template-folder <path>` is repeatable and template folders are always selected explicitly.** (#120) Repeated paths are registered in `auto` scan/proposal mode, with the first explicit path becoming the template-creation default (separate from the note `defaultTemplate`). Without flags, setup reuses saved v3 folder registrations only; Obsidian and Templater settings are displayed as numbered dry-run candidates but are never selected automatically. An unresolved selection is blocked with `TEMPLATE_FOLDER_SELECTION_REQUIRED` and no approval digest.
- **Setup dry-runs now expose `diagnostics` and `starterTemplates` instead of failing at the first incompatible file.** (#121) Each excluded template names its error, path, field when applicable, and remediation, while compatible files remain reviewable; an all-incompatible selection is blocked with `TEMPLATE_CANDIDATE_INCOMPATIBLE`. When the selected default folder is empty, `starterTemplates` shows the proposed `note.md`, which is written only by an approved apply.
- **Doctor now reports template drift one file at a time.** (#121) Every `TEMPLATE_SOURCE_DRIFT` result includes the path, expected and actual SHA-256 signatures, remediation, and the registered template ID when available, making `regenerate-types` review specific rather than generic.

## [0.13.0] - 2026-09-05

- **`oms doctor` now verifies Claude hook events plus the managed Codex and Hermes MCP registrations, preserving unreadable or syntactically malformed registration evidence as explicit inspection errors.**
- **`oms doctor` now reports structured and text install-asset health, naming dangling Claude hook symlinks with the reinstall command instead of allowing a silent command-not-found failure at tool time.**

## [0.12.2] - 2026-09-01

## [0.12.1] - 2026-09-01

## [0.12.0] - 2026-09-01

- **Breaking: `oms doctor` no longer accepts `.oms/taxonomy.yaml`.** It reports one conversion error for a YAML-only vault (or fail-closed cleanup guidance when both files remain); run `oms setup` and approve the returned digest to publish `.oms/taxonomy.json`.

## [0.11.1] - 2026-09-01

### Changed

- **`oms doctor` includes one computed Hermes provenance status in both text and JSON output.** The resolved root is reported as `not-installed`, `match`, or `drift`, with package version, recorded version, and digest-match evidence.

## [0.11.0] - 2026-09-01

### Added

- **`oms index repair --mode rebuild|drop [--dry-run]`.** (#88) Repairs run before any engine session opens, so corrupt stores never block their own recovery; `oms index status` cites the exact repair command when it detects a corrupt or incompatible store; dry-run prints the plan with zero file changes.
- **`oms doctor` reports Hermes install provenance in one read-only line.** (#90) Not-installed, match, or drift between the package version and the installed provenance for the resolved `OMS_HERMES_HOME` root.

### Changed

- **`oms update` refuses ambiguous install topologies and always reconciles.** (#64) Mismatched running-binary and `npm prefix -g` locations are reported with both paths and exact manual commands instead of silently updating the wrong copy.

## [0.10.1] - 2026-09-01

### Fixed

- **`--help` is now a first-class, side-effect-free path.** (#55) Every recognized command plus the bare `oms --help`/`-h` prints usage and exits 0 before any vault resolution, host-config access, MCP server start, or update notice; `--help` never lands in unknown-flag handling, and an unknown command with `--help` still fails so typos are not hidden.
- **Setup dry-run reports blocked proposals instead of aborting.** (#67) `oms setup --dry-run` on a vault with unresolved notes prints a deterministic blocked diagnosis without composing a manifest and issues no approval digest; apply requests are clearly rejected before composition.

## [0.10.0] - 2026-09-01

### Breaking

- **OMS now has one search taxonomy.** `oms semantic` and the old top-level collection, context, cleanup, and HTTP aliases are removed; use `oms search`, `oms doc get|multi-get`, `oms embed`, and `oms serve`. `oms index` contains exactly `sync|status|cleanup|collections|contexts`; embedding remains the compact top-level `oms embed` command.
- **Setup model options have changed.** `--embedding-*` is replaced by `--models-default`, `--models-descriptor`, and `--models-no-default`.
- **The embedding runtime is local-only.** The former Upstage provider path is removed; configured model identities must resolve to verified local GGUF artifacts.

### Added

- **Search now uses an explicit closed qmd-v2.8.3 expansion strategy.** `--max-queries` is strict, reranking is opt-in, and local model-set descriptors are supported.
- **`oms serve` exposes only the canonical HTTP endpoints.** `/health`, `/search`, `/get`, and `/multi-get` remain; no query alias or second MCP tool surface is advertised.

## [0.9.0] - 2026-08-31

### Changed

- **`setup`, `doctor`, `audit`, and `linkify` now expose the template contract directly.** Setup uses dry-run plus `--approved-digest`, doctor reports template/projection health and renames the report cap to `--max-per-template`, audit fails closed against resolved template identities, and linkify uses the same stable identities as write/search. Retired Concept authoring and `--suggest-fields` are no longer accepted.
- **Host lifecycle commands now maintain a strict signed XDG vault pointer.** `install`, `update`, public `reconcile`, and `uninstall` compare-and-swap host stamps without affecting runtime vault resolution; `--template-folder` is also bound into setup discovery and its approval digest.

## [0.8.4] - 2026-08-30

## [0.8.3] - 2026-08-29

## [0.8.2] - 2026-08-29

## [0.8.1] - 2026-08-29

## [0.8.0] - 2026-08-29

### Added

- **`oms setup --embedding-default` installs a working local embedding model in one step.** It downloads the pinned EmbeddingGemma-300M model, verifies it against the shipped SHA-256, and publishes it to the user-level cache. After that, `oms embed` and vector search work without setting `OMS_EMBEDDING_PROVIDER` or `OMS_EMBEDDING_MODEL` at all — the gap that previously forced anyone wanting native semantic search to hand-author a descriptor JSON or export a matching environment pair. Nothing changes for a vault that does not run it: with no model installed, lexical search keeps working and vector requests still fail loudly naming both variables, and the guidance now names this command as the one-step remedy.
- The three setup embedding options are mutually exclusive and now say so. Passing more than one of `--embedding-default`, `--embedding-descriptor`, or `--embedding-no-default` exits with an error naming the conflicting flags instead of silently letting one win.

### Changed

- `oms --help` documents the setup embedding options. All three existed only in source before this; `--embedding-descriptor` and `--embedding-no-default` shipped undocumented.

## [0.7.0] - 2026-08-27

### Breaking

- `oms setup` and `oms install --vault` no longer register the vault in `~/.oms/config.yaml`. The write-back and its `OMS_VAULT` migration backfill are removed entirely.

## [0.6.2] - 2026-08-27

## [0.6.1] - 2026-08-27

## [0.6.0] - 2026-08-27

### Changed

- `oms update` now requires confirmation before mutating from a TTY, refuses to mutate without `--yes` in non-TTY environments, and keeps `--dry-run`/`--check` read-only.
- Update reconciliation now propagates host installation failures to a non-zero exit status and resolves implicit vault targets through the verified vault chain, refusing an unverified current-directory target.

## [0.3.0] - 2026-08-24

### Changed

- An unrecognised command now exits 1 instead of printing usage and exiting 0. Silent success on a typo made a removed command indistinguishable from a working one.

### Removed

- The top-level qmd-compatible aliases `oms query`, `oms vsearch`, `oms get`, `oms multi-get` and `oms status` are gone, with ADR-009's D2. The canonical nested commands — `oms semantic query|status|get|multi-get|vsearch` — are unaffected and remain the supported surface.
