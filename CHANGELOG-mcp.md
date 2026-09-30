# MCP Changelog

MCP server tools and resources belong here.

## [Unreleased]

- **`write`'s receipt carries `next`.** It is the command for the receipt's first warning (`oms interview` for an open contract) and is left out when there are no warnings.

## [0.20.0] - 2026-09-30

- **The `status` write posture is chosen by a plain `if` chain.** `writePosture` in `src/mcp/tools/status.ts` replaces a nested ternary and returns the same four strings.
- **The MCP server's schema validator no longer pulls a vulnerable `fast-uri`.** The lockfile moves the transitive `fast-uri` (via `@modelcontextprotocol/sdk` → `ajv`) from 4.1.4 to 4.2.1, fixing GHSA-hrr3-gc8f-f4qj and GHSA-jvvf-x445-j334. No behaviour changes.
- **`doctor` gains `op: "evolve"`, `"evolve-verdict"`, `"revert-propose"` and `"reclaim-evolution-lock"`.** They are repair ops, so each requires a verified target and returns a receipt whose postcondition is read back from the store. `evolve` requires `makerSessionId` in its schema (`EVOLUTION_MAKER_SESSION_REQUIRED` without it) and returns the request id, nonce, digests and evaluator slots; `evolve-verdict` takes `requestId`, `nonce`, `slotToken`, `candidateDigest`, `parentDigest`, `evaluatorSessionId`, `verdict` (`approve` or `reject`), `rubricScores` and `reasons`; `revert-propose` takes `targetDigest`, and a revert always requires owner approval, so `evolve-verdict` on it is refused with `EVOLUTION_REQUEST_CLOSED`. `reclaim-evolution-lock` and `lineage-reanchor` need the owner at a terminal and are refused over MCP with `EVOLUTION_RECLAIM_REQUIRES_TTY` and `LINEAGE_REANCHOR_REQUIRES_TTY`. No tool is added. `status` carries an `evolution` field, `null` for an unsealed vault and `{unavailable}` when it cannot be read.
- **`interview` `op: "seal"` reports dropped templates as a warning instead of refusing.** Resealing an older contract generation seals and returns `CONTRACT_LEGACY_TEMPLATES_DROPPED: N ...` under `result.warnings` rather than refusing the removal as loosening. A template-only issue no longer refuses the seal or asks an unsafe-pattern question.
- **`interview` covers folders and properties only.** The `interpretations` parameter and the `interpretation-required` status are removed, no question asks about a template, and a sealed result carries no `templates` or `removedTemplates`. `write` scaffolds a new note from the live template in the vault's template folder (the named one, or the one matching the target folder) and reports a named template that does not exist as a `template-missing` conform entry; `search` `op: "templates"` lists the live templates.
- **The `oms_doctor` contract status payload reports `legacyTemplates` instead of `templates`.** The count is the number of template constraints an older contract generation still carries, which the write judge no longer enforces; a non-zero count also appears as the finding `legacy-template-constraints-ignored: N`.
- **`write` saves with warnings instead of dropping keys or drafting.** A write with an unknown key or an out-of-rule value is saved as written, and its receipt lists the finding under `warnings`. `fixes` now means lossless value fixes, each as `{field, kind}`: a number or checkbox written as a string, a scalar for a list, a midnight datetime for a date, a number for text whose source is exactly that number, an allowed value that differs only in spelling, and a missing value whose rule fixes it. A fix changes only that value's bytes. No key is ever dropped, and only frontmatter that does not parse is drafted.
- **`search {path}` accepts echoed schema defaults.** Some clients send every field with its default on each call. A path read now accepts `limit: 10`, `rerank: false` and `minScore: 0` alongside `path`, and the tool schema advertises them in the path branch. Any other value, and any field without a default such as `mode`, is still refused with the same `SEARCH_ARGS_INVALID` error.
- **`doctor` gains `op: "gaps"`, and `write` saves a repaired form instead of refusing a gap.** `op: gaps` is read-only. It reports the sealed contract revision, the open gaps in the ledger by id, note path, axis, kind and field (never the wanted value), whether each gap is drafted or stale, the corrupt ledger lines, and the contradictions in the sealed contract. It creates no store, state directory or ledger. A `write` that only misses the frame is now saved, with lossless fixes applied and every other finding kept as written. The receipt lists each finding; a gap the ledger could not record has no `id` and the receipt carries `gapLedger: "failed"` or `"unavailable"`. A denied write whose note was kept as a draft carries an opaque `draftRef`. `check: true` adds `resolution: {action, gaps, wouldDraft, precondition?}`, the same resolution the write would apply, and still writes nothing; `precondition` names a missing or stale `ifMatch` that would stop the write first. `op: gaps` reports `ledger: "truncated"` when the ledger outgrew the read window.
- **`write` denies only on a safety refusal, and a kept draft is no longer an error.** A denied write returns `{ok: false, status: "denied", refusals, violations, reason}`, and only control paths, unsafe paths, paths outside the vault, unsupported input, a tampered contract or a stale `ifMatch` deny it. Other findings ride on the result as `warnings`: a saved note's receipt carries the saved note's `warnings` and, as `fixes`, the `{field, kind}` of each lossless fix applied. In a sealed vault, only a note whose frontmatter does not parse is kept as a draft and returns `{ok: false, status: "drafted", draftRef, warnings}` without `isError`; every other write, including a contradiction and a draft that cannot be kept, is saved. `check: true` reports `refusals`, `warnings` and `fixes`. `status` reports `writeTools` as `write-disabled-contract-tampered` for a tampered contract and `write-unverified-contract` for a broken one, and `contract.reason` says which.
- **`doctor` gains `op: "lineage-recover"` and `op: "lineage-reanchor"`.** They are repair ops, so both require a verified target and reject a `cwd`-inferred vault. Each runs under the seal lock. It snapshots the retained generations the lineage is missing and appends the events the chain can account for: a seal that crashed before its event, a lost `<id>` link, or a store sealed before the lineage existed. `lineage-recover` refuses a gap it cannot explain with `CONTRACT_LINEAGE_GAP` and writes nothing. `lineage-reanchor` records that gap as a `gap-anchor` event, so the chain continues from the linked generation. Both return the anchors they recorded and a receipt. The receipt's postcondition gives the event and snapshot counts read back after the write. A vault that is not sealed returns `CONTRACT_NOT_SEALED`, and an unsafe state directory returns `STATE_DIR_UNSAFE` without touching it. On a vault whose first seal lost its lineage append, so it reads as `store-without-index` or `vault-moved`, `lineage-recover` also writes the vault's `index.json` entry, even when the lineage itself is already current, and the receipt lists `index.json`. A `vault-moved` vault whose original path still exists is a copy, and recovery refuses it with `CONTRACT_VAULT_ID_SHARED`. On an indexed vault with a current lineage, either op writes nothing.
- **A retried `interview` `op: "seal"` saves a template folder the first seal did not.** The seal records the template folder in `.oms/settings.json` after it seals the generation. When a seal stopped between the two and the retry found the contract already sealed, the folder was lost. The retry now saves the folder recorded with the confirmed proposal if the settings do not name one. The logged folder is checked as an interview answer is checked (it must be an existing, visible folder inside the vault) and is not saved otherwise. A folder that fails that check, or a settings write that fails, is returned as the warning `INTERVIEW_TEMPLATE_FOLDER_UNRECORDED` under `result.warnings`, and the seal is still reported. Settings that already name a folder are left as they are, and a vault with no settings is not treated as already sealed. Declined templates need no repair, because they are stored in the sealed generation.

## [0.19.0] - 2026-09-28

- **Breaking: `write` refuses to overwrite an existing note without `ifMatch`.** The input is `{path, content, template?, ifMatch?, check?}`. Replacing a note needs `ifMatch`, the `sha256:` revision from the previous receipt or a `check`; without it the call returns `WRITE_IF_MATCH_REQUIRED` and the file is unchanged, and a stale revision returns the retryable `WRITE_TARGET_CHANGED` (or `WRITE_TARGET_VANISHED`); an `ifMatch` for a note that does not exist returns the retryable `WRITE_TARGET_ABSENT`, and retrying without `ifMatch` creates it. `check: true` judges the note and returns `status: "checked"` with the frame, the current revision and any violations, writing nothing. A written note now returns the receipt `{ok, path, revision, contractRevision, index: {keyword, vector}, conformed, missingDefaults}` instead of `{ok, path, missingDefaults}`; when the vault has an engine store the note is keyword-searchable in the next call.

- **The `interview` tool runs the interview over several calls and can seal a first or non-loosening contract.** `op: "questions"` (the default) lists what is still unanswered and writes nothing. `op: "answer"` logs answers keyed by question id and, once nothing is left, returns `status: "proposed"` with the proposal digest and its preview. `op: "confirm"` records the owner's yes to that exact digest, and `op: "seal"` seals only when the log holds a confirmation of the latest proposal and the interview, replayed from the log, still proposes it; a confirmation of an older proposal is refused. Nothing is written into a vault that was never sealed before its seal: answers are logged under a pending key outside the vault. Retrying `seal` after the contract was sealed returns `sealed` without a new generation and appends the missing `sealed` event, and a seal whose log record failed still reports `sealed` with a `warnings` entry. `doctor` `op: "validate"` includes `interviewLog`, the corrupt interview log lines by line number, read-only. `answer`, `confirm` and `seal` require a verified target vault, and a vault inferred from the working directory may only list questions. Refusals are returned as data, `{ok: false, status: "rejected", rejection}`, not as tool errors. The tool never reclaims a stale seal lock: `CONTRACT_SEAL_LOCK_STALE` is returned as `INTERVIEW_SEAL_LOCK_STALE` with the terminal command that can reclaim it, while `CONTRACT_SEAL_BUSY` passes through as retryable. Loosening a sealed contract still belongs to the owner's terminal.

- **Breaking: the MCP server exposes four tools: `write`, `search`, `interview`, and `doctor`.** The `link` tool is removed; suggest links with `search` `op: "link"` and check them with `doctor` `op: "link-check"`. The `status` tool is removed; `doctor` `op: "status"` reports the same health read-only and creates no engine store. The new `interview` tool lists the questions the owner would be asked now, with the seal state, and seals nothing: answers still go through `oms setup --answers`, and loosening stays with the owner's terminal. Annotations are per tool, so `readTools` is now `[search]`. Hosts display `oms_write`, `oms_search`, `oms_interview`, and `oms_doctor`.

- **`search` accepts `{path}` with no `op` for an engine-free exact read of one note.** The call returns the same document shape as `oms search --path`, never opens the engine store or a model, and is refused when combined with `op` or any other argument. A path the caller got wrong returns `available: false`, while an I/O failure such as a missing vault root returns the same `Oh My Second Brain MCP error` result as every other tool; the tool schema advertises it as its own `oneOf` branch, so `op` is no longer top-level required for `search`.

## [0.18.3] - 2026-09-26

## [0.18.2] - 2026-09-26

## [0.18.1] - 2026-09-26

- `status` `readTools` lists only the read-only tools (`search`, `link`, `status`); it is now derived from each tool's `readOnlyHint`, so `write` no longer appears there. Writes stay described by `writeTools`.

## [0.18.0] - 2026-09-25

- The five MCP tools are unchanged. Agent-driven setup is a tool-less skill over the CLI, not an MCP operation, so no tool can publish, edit, or read the contract.
- `doctor` `validate` output carries the contract doctor's `unsafePatterns` (`{field, kind}` only, no values). The `note-write.ts` header now notes that a crash between `link()` and removing the temp name leaves a second hard link to the new note, which nothing sweeps.

## [0.17.0] - 2026-09-25

- **Breaking: `write` takes `{path, content, template?}` with no `op`.** The whole note is judged against the sealed contract and saved atomically only when allowed; a denial returns `{field, kind}` violations and one guidance command. The `guide`, `check`, and `template` operations and the `folderIntents` input are removed. `search` `templates` returns the sealed folders, property names and types, and templates; `doctor` `validate` diagnoses the seal, and `doctor` `regenerate-types` is removed with no alias.
- **Breaking: retrieval metadata reads the sealed folder contract.** Search responses rename `taxonomyIntents` to `folderIntents`, semantic status reports `folderContext` instead of the taxonomy context, and `projectionSource` names `folders.json` (the sealed contract) instead of `.oms/template-policy.json`. A vault without a sealed contract reports `vault-invalid` and its remediation points at `oms setup`.
- **An unreachable search fallback is gone.** Every `oms_semantic_query` path returns inside its own block, so the later ephemeral-lexical branch keyed on that tool name could never run. Search's model-free lexical path stays where it actually executes.
- Tool schemas expose operation names and arguments at the top level so hosts can discover them without unpacking branch schemas. Strict operation-specific validation and approval requirements remain enforced. (#144)

## [0.16.0] - 2026-09-23
- Host-facing docs no longer show a copyable `interview-next` call without `proposals`. Confirming the template notice still starts that mode, but the same proposals array must reach review, answer, and commit.
- The machine template notice `next` field is a mode hint (`skill: interview`, `mode: interview-next`), not a replayable CallToolRequest. OMS still does not invent proposals; `확인하기` enters `/interview`.

## [0.15.0] - 2026-09-19

- The bundled MCP SDK now resolves `hono` 4.13.8, clearing the moderate advisory group that affected its HTTP transport's body and query parsing. Only the lockfile moves; no declared dependency is added or changed.
- Pending body contracts and incomplete fresh projection coverage also surface the generic template notice when no new raw source diff exists, so successful source authoring cannot hide the remaining contract confirmation.

- **Template review now uses exactly `interview-next`, `interview-answer`, and `commit-contracts` under `write { op: "template" }`, with a minimal notice and long-lived carrier.** Selected-folder census changes preserve source bytes and publish only user-confirmed controls through the guarded flow; an affected template is pending without blocking unrelated templates, while shared-authority drift still fails closed vault-wide. The initial display is exactly `템플릿에 변경이 있습니다` with exactly `확인하기` and `나중에`; `나중에` is host-only with no server call or ledger mutation, and `templateNotice` is surfaced on tool results even when boot instructions are stale. The five-tool surface is unchanged.

## [0.14.0] - 2026-09-05

### Changed

- Conflicting index mutations are serialized within each MCP server through engine disposal, so repair cannot move a store still owned by another request. A failed close returns `ENGINE_LIFECYCLE_FAILED` and blocks further index mutations until server restart; read-only requests remain independent. (#125)
- `status { op: "graph" }` returns graph-only health, while omitted `op` retains aggregate health. Doctor `sync-embeddings` repair mode requires `repairMode: "rebuild"` or `"drop"`, matching CLI store repair rather than silently forcing embeddings. (#125)
- **MCP detail capabilities have exclusive operation and mode boundaries.** (#125) Document lookup, index views, template inspection and embedding synchronization no longer overlap through duplicate operations or booleans. All capabilities remain under the same five tools, with schema and dispatch validated together.
- Template operations include guarded `register-folder`, `remove`, and `default` modes, with current signatures derived by the server. Update move strategies are validated consistently; note creation may omit its ID only when a default binding is declared. No additional MCP tool is introduced. (#124)
- Status and template listings expose local runtime observation history separately from the vault contract. Missing observations are reported as gaps, not inactivity; reading history never creates a vault store. (#123)
- Template writes respect renderer and Obsidian-filled field contracts, rejecting external bodies and unresolved values without copying raw Templater tags. The five-tool surface and digest-approved transaction boundary are unchanged. (#122)
- The search receipt field `drift` was renamed to `indexDrift`; no compatibility alias is retained.
- **`write { op: "template", mode: "register-existing" }` now requires `sourceFolder` together with `sourcePath`.** The folder must be a registered v3 template source folder containing the existing Markdown file. This keeps template source identity distinct from taxonomy note placement while retaining the existing dry-run, approval-digest, and compare-and-swap flow. The MCP surface remains exactly five public tools.

## [0.13.0] - 2026-09-05

### Added

- **`write { op: "template", mode: "register-existing" }` registers a template that already lives in your vault.** Point it at a vault-relative Markdown path with an explicit stable `templateId`, the contract you authored, and a naming rule; the server reads the file as the shape authority and derives every control and source signature itself, so you no longer hand-assemble four expected digests and re-send the template's own bytes to register a file that is already on disk. The dry-run → `approvalDigest` → apply contract and its CAS checks are unchanged, and the source template is verified in place — never copied, rewritten, moved, or renamed. Re-registering an identical binding is refused as `TEMPLATE_ALREADY_REGISTERED` rather than a bare identity collision.

### Changed

- **`status.writeTools` response values were renamed from `oms_write-*` to `write-*` with the capability-only tool surface.** Raw MCP clients that consume this diagnostic field must migrate those response strings alongside the five public tool names.
- **MCP local tool names are now capability-only.** The `oms` server advertises `write`, `search`, `link`, `status`, and `doctor`, so qualifying hosts display `oms_write`, `oms_search`, `oms_link`, `oms_status`, and `oms_doctor` rather than `oms_oms_*`. Raw MCP callers must migrate `oms_write` → `write`, `oms_search` → `search`, `oms_link` → `link`, `oms_status` → `status`, and `oms_doctor` → `doctor`.

## [0.12.2] - 2026-09-01

## [0.12.1] - 2026-09-01

## [0.12.0] - 2026-09-01

## [0.11.1] - 2026-09-01

## [0.11.0] - 2026-09-01

### Fixed

- **A missing or unknown `op` now names the supported operations.** (#65) Instead of a bare unknown-operation error, every public tool lists its supported operations in deterministic order; `oms_status` remains the only op-free direct route, and supplying an operation to it is rejected explicitly.

## [0.10.1] - 2026-09-01

## [0.10.0] - 2026-09-01

### Changed

- **`oms_search` query now accepts the closed `strategy`, `maxQueries`, `rerank`, and `candidateLimit` controls.** Query budgets are strict integers, expansion is not advertised on context retrieval, and these controls remain on the existing tool; no additional public search tool was added.

## [0.9.0] - 2026-08-31

### Changed

- **The five-tool MCP surface now uses stable templates for every note-shaped operation.** `oms_write` has strict create/append/update branches: create derives placement from `templateId`, while append/update resolve the persisted note identity; guarded template operations remain on the same tool. `oms_search` advertises template/field/folder/link axes; `oms_status` reports projection signatures; and `oms_doctor` adds template diagnosis, approved projection regeneration, and exact one-note backfill without adding public tools.
- **Graph, link, and search paths share one resolved convention.** Typed retrieval omits and reports unresolved note identities instead of failing the whole index, stale projections fail loudly, managed template sources are excluded, and every advertised search operation remains byte-identical read-only.
- **Doctor and template mutation use exact public operations and durable recovery.** Doctor exposes `validate`, `regenerate-types`, and `backfill-defaults`; interrupted template transactions resume by persisted transaction ID and the original approved digest instead of reconstructing mutable caller state.

## [0.8.4] - 2026-08-30

## [0.8.3] - 2026-08-29

## [0.8.2] - 2026-08-29

## [0.8.1] - 2026-08-29

## [0.8.0] - 2026-08-29

## [0.7.0] - 2026-08-27

### Breaking

- An MCP host that launches `oms mcp` with no `--vault` argument and no `OMS_VAULT` in its env block no longer resolves a vault from the global registry. Such a server resolves to its launch directory and rejects writes with `target-unverified`; host configurations must pass the vault explicitly. The Claude installer now does this on your behalf (see the vendors changelog); other hosts need the configuration updated by hand.

## [0.6.2] - 2026-08-27

## [0.6.1] - 2026-08-27

## [0.6.0] - 2026-08-27

### Changed

- MCP semantic retrieval now forwards explicit rerank and candidate-limit requests through ephemeral lexical fallback paths without downloading models or silently dropping rerank behavior.
- **Breaking:** `oms_search` folds axis retrieval into the `query` operation. The retired `axis` and `semantic-query` operation names now fail loudly; collection, context, and status operations likewise drop their `semantic-` prefixes. Query responses expose `hits`, `totalCount`, `facets`, a cursor, and a deterministic receipt.
- **Breaking:** `oms_doctor` uses `op: "cleanup"` instead of the removed `semantic-cleanup` spelling. No compatibility aliases are retained.

## [0.3.0] - 2026-08-24

### Changed

- `oms_search` is genuinely read-only and is now annotated as such. It previously advertised `readOnlyHint: false`, and truthfully so: searching a vault with no index silently created `.oms/` and initialised an SQLite store, and the `embeddingSyncBeforeSearch` family of parameters let any caller turn a search into a write by passing a flag. Neither is possible now. This matters beyond tidiness, because MCP hosts may auto-approve tools that declare themselves read-only.

  Searching an unindexed vault still returns results. Rather than refusing until you run a command, the server builds the lexical index in memory for the life of the session and answers from that, so a first search on a fresh vault behaves as it always did while leaving the vault byte-identical. Once a persistent index exists it is used as-is and a search never rewrites it; refreshing it is `oms semantic sync`'s job.

  Preparing lexical or embedding data on disk is now exclusively `oms_doctor { op: "sync-embeddings" }`, which is annotated as writing and routes through the verified-target kernel. Asking for vector retrieval on a vault with no vectors still fails loudly rather than quietly degrading to lexical.
- `oms_search` advertises `limit` (default 10), `minScore` (default 0) and `rerank` (default false). The first two are applied at the normalizer, so an options-free query is bounded rather than unlimited. `rerank` is opt-in per ADR-011: `true` reranks only when startup was given a real reranker and otherwise fails loudly with configuration guidance, rather than silently returning unreranked results as if the request had been honoured.

- The public MCP surface is now five tools — `oms_write`, `oms_search`, `oms_link`, `oms_status`, `oms_doctor` — down from twenty-three. The eighteen detail tools are reachable through an `op` parameter on the tool that owns them; nothing was deleted, so no capability is lost, but any client calling a detail tool by its old name must switch to the owning tool plus `op`.
- `oms_search` routes through the `SearchBackend` seam. A plain `query` now expands to lexical retrieval and returns results on a vault with no embedding provider, where it previously failed. Asking explicitly for vector retrieval — through a typed `vec` or `hyde` sub-search, the `vec`/`hyde` shorthands, or `mode: "vsearch"` — still fails loudly naming `OMS_EMBEDDING_PROVIDER` and `OMS_EMBEDDING_MODEL`. Lexical is a default for callers who did not choose a strategy, never a substitute for one that was asked for.
- Supplying an explicit `mode` together with explicit `searches` is refused as contradictory rather than resolved by discarding one of them.
- `oms_write` refuses a request that addresses the note both ways at once. `notePath` and `folder`/`filename` are alternatives; supplying both used to write one form while reporting the other's implications.
- Every mutating `oms_doctor` repair returns a typed receipt whose postcondition the server verified by reading persisted state back. Repairs are admitted through the verified-target kernel before anything touches disk, so a `cwd`-inferred target is rejected while diagnosis still works.

### Removed

- The qmd-compatible aliases `query`, `get`, `multi_get` and `status`, and the `qmd://` resource, are gone. ADR-009's D2 is superseded by ADR-010; D1 remains in force.
