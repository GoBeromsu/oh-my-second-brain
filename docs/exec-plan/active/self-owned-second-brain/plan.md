---
slug: self-owned-second-brain
date: 2026-06-13
author: oh-my-claudecode:planner
spec: self-owned-second-brain
status: active
---

# Plan: Self-Owned Second-Brain Engine

**Approach.** Build a complete six-component second-brain engine (C1 Vector/Index, C2 Graph, C3 Retrieval, C4 Config/Setup, C5 Wiki/Synthesis, C6 Distill) in a new parallel module at `src/engine/`, leaving the existing working vector layer (`src/search/`) untouched until a golden-set parity gate is cleared (R18). Build order is fixed by R8: start with the Retrieval vertical tracer (M1, C1+C2+C3) as the parity anchor, then compile (M2), wiki (M3), distill (M4), and governance+vault-lint+setup (M5). Every skill follows the `/skillify` structure (R17b). All vault bindings are resolved at setup-time via the engine's own deep-interview-methodology reimplementation (R16); no Ataraxia-specific values are hardcoded (Non-Sticky). The `.oms/` dotfolder enforces ADR-006 two-layer separation: Layer 1 CONTRACT (taxonomy.yaml / concepts / schemas, machine-validated) stays strictly separate from Layer 2 GOVERNANCE (.oms/governance/, intent records). Skills package as one **thick router** (private, env-injected personal recipes — R20) that routes to **generic public leaves** (retrieve / compile / wiki / vault-lint / vault-scaffold / vault-decision-record), with **distill** standing alone (R16); the project stays a single monorepo with personal content (recipes, vault paths, names) isolated behind `.gitignore` or a submodule (R19 — see *Skill Packaging & Repo Topology* below). After M5 completes and parity is confirmed, `src/search/` is retired in a dedicated swap commit.

---

## Execution Update — 2026-06-14 (M1 + swap + Phase 2 shipped; PR #33)

> Records execution-time reality where it diverges from the plan as written. Lifecycle rule: decisions **supersede**, never delete. M2 (compile) / M3 (wiki) / M4 (distill) / M5 (governance+setup) remain **future work** — this plan stays `active`. Only the retrieval vertical and the swap ceremony are addressed here.

**Shipped (PR #33, branch `feat/oms-engine`, 20 commits beyond `main`).**
- **M1 retrieval vertical + golden-set harness** — green; engine parity-or-better vs the qmd/src-search baseline (recall@10).
- **Swap executed in two rounds, not one:** Round 1 = **graph-only** model-free assembly wired live (`oms_retrieve_by_axis` engine-native; semantic stays on `src/search` behind ADR-007 deferred guards). Round 2 = **Phase 2 model-gated routing**: `oms_semantic_query/sync/status/collections/contexts/cleanup`, `oms_retrieve_context`'s semantic leg, `get`/`multi_get`, and the `qmd://` `ReadResource` route through the engine **iff** an embedding model is configured (`OMS_MODEL_PATH`/`UPSTAGE_API_KEY`), degrading to `src/search` otherwise. Engine `getDocument`/`multiGet` reached document-surface parity (`qmd://`/`oms://` schemes, `:FROM:COUNT` ranges, vault globs); semantic hits gained title + doc-head snippet (T2).

**SUPERSEDED — R18 swap ceremony step 7c (`src/search/` → `src/search.legacy/` rename).** The plan (M5 §7c, Files-Affected, ADR R21) assumed the swap *renames* `src/search/` to `.legacy/` and deletes it one release later. **This is reversed.** `src/search/` is **retained first-class as the model-free fallback tier** — it backs the morning default backend, the `get`/`multi_get`/`ReadResource` degradation path, the localhost semantic-HTTP CLI, and all 622 NO_MODEL tests. Renaming it `.legacy` would mislead and break every importer. Phase 2 made it the *gated fallback*, not dead code. **No `.legacy` rename will occur; no follow-up deletion PR is owed.** (Distill into a formal ADR during M5 execution.)

**Parity confirmation (qmd oracle, R7).** Beyond the standing golden harness: a bounded live cross-check took qmd's top-6 real notes for an agent-retrieval query + 2 unrelated distractors into a throwaway `/tmp` vault, synced the engine through the built MCP server with the real EmbeddingGemma GGUF, and ran the same lex/vec/intent — engine `#1` = qmd `#1` (`Retriever-Augmented Generation (RAG).md`); both distractors absent from the engine top-8; real-path docids confirm the engine backend served them; zero footprint on the real vault.

---

## Skill Packaging & Repo Topology (R19/R20)

> Reconciles the planner draft's flat-skill assumption with spec §3/§9 (deep-interview **R20**) and the monorepo decision (**R19**). The milestone skill paths below (`core/skills/compile`, `wiki`, …) are the **public leaves**; this section adds the private router on top of them — it does not move them.

**Packaging (R20 — thick router + generic leaf).**
- **Thick router (private).** One personal entry-point skill holds vault-operation recipes, workflow preferences, and env-injected personal config (vault paths, people names). Lives under the gitignored `private/` overlay. It is the *only* personally-shaped skill surface — it routes user intent to generic leaves.
- **Generic public leaves.** `retrieve`, `compile`, `wiki`, `vault-lint`, `vault-scaffold`, `vault-decision-record` carry no personal values → publishable. Personal config reaches them only via env / router injection (Non-Sticky — Principle 4, R16).
- **Distill stays standalone (R16).** Not a router leaf and not under the router — a first-class, target-agnostic skill (M4).

**Repo topology (R19 — monorepo + private isolation).**
- Single oms monorepo (matches the M1–M5 layout). Engine (`src/engine/`) + generic leaf skills are public-able.
- Personal content isolated behind **`.gitignore`** (default: a `private/` overlay dir), with an **upgrade path to a git submodule** if the private set later needs its own history/sharing. Real private *data* (vault, `.oms/cache`, `.env`) stays outside git regardless.
- Public/private boundary == router↔leaf boundary.

---

## RALPLAN-DR

### Principles

1. **탈종속 + Self-Owned** — All intent data and synthesis logic lives in oms-owned code. Third-party tools (qmd, graphify, gbrain, omc) contribute patterns only; their code is absorbed and acknowledged, never runtime-depended upon.
2. **Manual / Stateless** — No daemon, no watcher. Every command is user-triggered. Persistent state = disk index files + .oms dotfolder caches only. MCP server = stdio-spawn per session (R2, hard constraint).
3. **Parity-or-Better before Swap** — The existing working vector layer (`src/search/`) is the regression floor. The new engine must pass the golden-set harness (N≈20, k=10, stratified over lex/vec/hyde/graph) at parity-or-better versus qmd/gbrain before any production routing changes (R18, R7).
4. **Non-Sticky / Vault-Agnostic** — No vault path, folder name, or taxonomy value is hardcoded. All concrete vault bindings are resolved at setup-time via the engine's own Socratic interview (R16). Ataraxia values are reference defaults only.
5. **Two-Layer .oms Governance** — Layer 1 CONTRACT (lint-enforced yaml) and Layer 2 GOVERNANCE (human-readable intent records) are always explicitly separated. Author and checker lanes never run in the same active context (ADR-006, R17).
6. **Embedding Integrity** — `native-dim-in == stored-dim-out`; no projection/fold/truncation of embedding vectors; no fake/stub embedder on any production path (ADR-007, R22).

### Decision Drivers

1. **R18 replace strategy lock** — The dominant driver for all structural choices. New engine must be parallel, not in-place. This prevents regression in the existing working retrieval path during development.
2. **R8 build-order lock** — Retrieval vertical (C1+C2+C3) must be end-to-end runnable before any other milestone starts. This anchors scope negotiation and prevents premature complexity.
3. **R4/R7 success criteria** — Parity-or-better on the golden set is the only gate that matters. All intermediate design choices (embed model, RRF k, graph edge weights) are tunable until the gate passes.

### Viable Options

R18 already locks the replace strategy (parallel new module → golden-set gate → swap). R8 locks the milestone order (Retrieval first). The genuine remaining forks are at the level of (A) milestone parallelism and (B) validation harness placement.

#### Option A — Strictly Sequential Milestones (M1 → M2 → M3 → M4 → M5)

Each milestone completes and its gate clears before the next begins.

**Pros:** Simple dependency tracking; each milestone output is stable when the next uses it; lowest risk of integration surprise.  
**Cons:** M4 (Distill) has no dependency on M2/M3 and could run concurrently; sequential execution delays total calendar time unnecessarily.

#### Option B — Spine + Constrained Parallelism (CHOSEN)

M1 completes first (hard dependency anchor). After M1 gate clears: M2 (Compile) and M4 (Distill) may proceed in parallel — they share no code paths and have independent outputs. M3 (Wiki) waits for M2 to complete, since the wiki collection owner drives the compile worker. M5 (Governance/Setup) may be partially scaffolded during M1-M4 (skill SKILL.md stubs, `.oms/governance/` directory structure, `.gitignore` update) but its completion gate is last.

**Pros:** M4 independence is real — distill is a standalone skill with no compile/wiki coupling (R3: Capability axis is orthogonal to Content axis). Recovers calendar time with no regression risk.  
**Cons:** Two active development streams after M1; slightly more coordination.  
**Chosen because:** R3 MECE decomposition explicitly separates Content axis (M2/M3) from Capability axis (M4). Running them in parallel is architecturally correct, not just a shortcut.

**Invalidated alternatives for validation harness:**
- Embedding validation inside each milestone's test suite only (without a cross-cutting golden-set harness): rejected because R8 requires a breadth-first all-path verification strategy, and per-milestone unit tests cannot prove end-to-end parity.
- A separate "validation milestone" after M5: rejected because R8 requires M1 to be the parity anchor — the golden-set harness must be created inside M1 and run continuously through M2/M3 to detect regressions.

---

## Milestones

### M1 — Retrieval Vertical Tracer (Parity Anchor)

**Goal.** Build C1 (embed + index) + C2 (graph) + C3 (typed RRF retrieval) as the first end-to-end runnable vertical in `src/engine/`. Create the golden-set harness. This milestone proves the new engine can match or beat qmd/gbrain on all four query types before any other component is built.

**Components built:** C1 Vector/Index, C2 Graph, C3 Retrieval.

**Implementation steps:**

1. Scaffold `src/engine/` directory tree with sub-packages `embed/`, `graph/`, `retrieval/`. Add `.oms/cache/` to `.gitignore` (do NOT add `.oms/` itself). No changes to `src/search/`.
2. **C1 Embedder** (`src/engine/embed/`): Implement EmbeddingGemma-300M adapter (768d, hardware-adaptive parallel pool from qmd P-01 pattern), 900-token / 15%-overlap chunker with heading-boundary respect and code-fence protection, SHA-256 fingerprint for incremental diff (qmd SHA-256 pattern), sqlite-vec `vec0` store with content-addressable `content(hash, doc)` + `documents(collection, path, hash)` schema. Lazy-load + 5-minute unload guard (qmd lazy-load pattern). Upstage Solar 4096d as opt-in commercial path (ADR-002 tier model).
3. **C2 Graph** (`src/engine/graph/`): Implement frontmatter 4-tier weighted edge builder: wikilink `[[]]` ×3.0, frontmatter `sources[]`/relations ×4.0, Adamic-Adar common-neighbor ×1.5, type-affinity ×1.0 (nashsu composite, initial = weighted sum). Implement **wikilink resolver** (`src/engine/graph/resolver.ts`) — fixes the opaque-string wikilink in existing `src/graph/cache.ts` (new module; R18: do not touch `src/graph/cache.ts`). Leiden-first / Louvain-fallback community detection with cohesion-split (graphify 24-pattern set: 4-pass entity dedup, grow-only build_merge). Two-tier cache: full cached graph (`.oms/cache/graph.json`, 265 MB, gitignored) + on-demand sparse real-time graph.
4. **C3 Retrieval** (`src/engine/retrieval/`): Typed sub-query dispatcher accepting `{type: 'lex'|'vec'|'hyde'|'graph'}` array (qmd interface mirror). Separate `gph` mode for graphify-style traversal (BFS/DFS/community). RRF fusion k=60 (gbrain-parity, MS GraphRAG pattern). Opt-in cross-encoder rerank hook (`src/engine/retrieval/reranker.ts`, bge-reranker-v2-m3 or Qwen3-Reranker-0.6B, precision-mode only). Provenance-grade signal fed into RRF (authored > curated > external-raw, R15). Gajae-code P-08 two-layer retry + P-03 ContextVar cancel token.
5. **Golden-set harness** (`test/golden-set/`): Curate N≈20 queries, stratified across 4 types (≥4 lex, ≥4 vec, ≥4 hyde, ≥4 graph). Each query has expected-note list (top-k=10). Automated comparator: runs both new engine and qmd baseline, scores recall@10 per type, emits pass/fail per query. Loop-until-dry growth protocol: on failure, add queries until two consecutive rounds yield no new failures (R7).
6. Wire end-to-end tracer: vault slice → C1 embed → index → C3 typed query → RRF → result. Minimum C4 wiring: canonical vault path resolution from `OMS_VAULT` env var only (no full setup interview needed for M1).

**Completion gate:** Golden-set harness shows parity-or-better vs qmd/gbrain on all 4 sub-types (recall@10). Tracer runs end-to-end on Ataraxia vault slice with no errors. `src/search/` is unmodified. Gate verified by automated harness output, not manual inspection.

---

### M2 — Compile Engine (Stateless SHA Worker)

**Goal.** Build C5 compile layer: stateless per-concept SHA worker that takes `(concept, material, graph)` and produces a synthesized page body. Absorbs terminology Step2-4, nashsu 2-step CoT, atomicstrata 2-phase, lucasastorian cascade.

**Components built:** C5 Compile (content axis, middle tier).

**Implementation steps:**

1. **Stateless worker** (`src/engine/compile/worker.ts`): `compile(concept, material[], graph) → { body, sha, provenance }`. Fully stateless — no side effects. SHA-256 of input material fingerprint stored in `src/engine/compile/sha-cache.ts` (disk-persisted at `.llmwiki/sha-cache.json`). Changed material SHA triggers recompile; unchanged skips (R12 incremental).
2. **Nashsu 2-step CoT** (`src/engine/compile/cot.ts`): Step 1 — analysis pass (entity/concept/argument/contradiction/structure extraction). Step 2 — synthesis pass (source summary + concept page + `[[wikilink]]` insertion). The two passes are always sequential; Step 1 output is the context for Step 2.
3. **Atomicstrata 2-phase** (`src/engine/compile/phases.ts`): Phase A = extract-all-without-writing (pure read, no vault mutation). Phase B = generate (LLM synthesis to `processed/` folder, never to `wiki/` directly). Hard separation: Phase A and Phase B never overlap in the same execution context.
4. **Lucasastorian cascade return** (`src/engine/compile/cascade.ts`): Every compile write returns `{ affected_backlinks: string[] }` — the list of wiki pages that link to the just-compiled page. The caller uses this to schedule staleness updates (M3 picks this up).
5. **Provenance grading** (`src/engine/compile/provenance.ts`): Each material item carries a provenance grade (`authored | curated | external-raw`). Authored weight ↑ in synthesis prompt context (individual voice preservation). Grade derived from folder→grade mapping (setup-time, not hardcoded).
6. **Skill scaffold** (`core/skills/compile/SKILL.md` + `CHANGELOG.md`): /skillify structure, 5-key frontmatter (`name: compile`, `version: 0.1.0`, `description`, `trigger`, `tags`), present-tense recipe body only. History/attribution → CHANGELOG.md only.

**Completion gate:** Compile runs on 10 representative concepts; unchanged-SHA concepts skip deterministically; changed-SHA concepts recompile; output lands in `processed/` tier (not `wiki/` or `raw/`); provenance grades reflected in LLM context.

---

### M3 — Wiki Collection Owner (Staleness Ledger)

**Goal.** Build C5 wiki layer: stateful collection owner that manages the 5-state staleness ledger, drives compile, and owns the `wiki/` physical tier. Absorbs Karpathy index/log convention, Astro-Han cascade pass, nvk 3-phase separation.

**Components built:** C5 Wiki (content axis, top tier). Depends on M2.

**Implementation steps:**

1. **Staleness ledger** (`src/engine/wiki/ledger.ts`): 5-state FSM — `CLEAN | DIRTY | STUB | ORPHAN | CONFLICT`. State file at `.llmwiki/staleness.json` (never synced, dotfolder). Transitions: SHA change on source → DIRTY; compile produces page → CLEAN; referenced page has no compile output → STUB; page with no incoming links → ORPHAN; two compile sources produce conflicting content for same concept → CONFLICT. Full-rebuild escape hatch: delete `.llmwiki/staleness.json` → all pages reset to DIRTY.
2. **Collection owner** (`src/engine/wiki/collection.ts`): Five responsibilities: (1) namespace/identity management (concept ID → file path), (2) link-graph closure verification (no dangling wikilinks), (3) staleness ledger (delegates to ledger.ts), (4) navigation surfaces (MOC/index generation), (5) processed→wiki promotion (moves Phase B output from `processed/` to `wiki/` after cascade pass completes).
3. **Karpathy conventions** (`src/engine/wiki/navigation.ts`): `wiki/index.md` global catalog updated after every compile run. `wiki/log.md` append-only (`## [YYYY-MM-DD] compile | ConceptName`). These two files are always written before the wiki collection owner returns.
4. **Cascade pass integration**: Consume `affected_backlinks` from M2 compile cascade return. For each affected page: check staleness ledger → if CLEAN, mark DIRTY → queue for next compile run.
5. **Astro-Han lint 2-tier** (`src/engine/wiki/lint.ts`): Auto-fix tier: index consistency, internal link correctness, See Also sections. Report-only tier: factual contradictions (typed as `> **Conflict:** A claims X; B claims Y. Unresolved.`), outdated references, orphan pages. Lint report emitted to stdout; no autofix for report-only tier without human gate.
6. **Nvk 3-phase hard separation**: Research (parallel, M1 retrieval) → Compile (always sequential, M2) → Wiki (read-only query surface). Phase boundaries enforced in collection owner: wiki query never triggers compile; compile never writes to `wiki/` directly (promotion only via collection owner).
7. **Skill scaffold** (`core/skills/wiki/SKILL.md` + `CHANGELOG.md`): Same /skillify structure as M2.

**Completion gate:** Wiki runs on M2 compile output; staleness ledger correctly tracks all 5 states across a test scenario (source file SHA change → DIRTY → compile → CLEAN; orphan detection → ORPHAN); `wiki/index.md` and `wiki/log.md` updated; `processed/` is not routed to Obsidian sync (dotfolder-adjacent, non-synced); `wiki/` pages are navigable with correct wikilinks.

---

### M4 — Distill (Standalone Meta-Absorption Skill)

**Goal.** Build C6 as a standalone first-class skill. Target-agnostic (any repo/document/pattern). Clean-room throwaway subagent mechanism. Structured absorption report. Runs in parallel with M2 after M1 gate clears.

**Components built:** C6 Distill. Independent of M2/M3.

**Implementation steps:**

1. **Clean-room mechanism** (`src/engine/distill/clean-room.ts`): Launch a throwaway subagent context with target loaded as inert data only (no script execution, no live tool calls against the target). Red-team adversarial analysis runs inside the clean context. Main system state is never mutated (R2/R6 compliance). Implementation: subagent receives target content as read-only text, not as an executable environment.
2. **Red-team analysis** (`src/engine/distill/analyzer.ts`): Adversarial pass: identify (a) patterns/ideas with file:line evidence citations, (b) risks/red-flags (anti-patterns, fragile assumptions), (c) attribution memo (source identity for ACKNOWLEDGMENTS, not license flags — R13 license-check removal). Structured JSON output schema: `{ patterns: [{file, line, description, absorb_confidence}], risks: [{description, severity}], attribution: {repo, url, license_note} }`.
3. **Absorption report writer** (`src/engine/distill/report.ts`): Converts analyzer JSON to human-readable markdown report. Three sections: §1 Patterns (ranked by absorb_confidence), §2 Risks, §3 Attribution memo. Report is the only output; no vault write, no code mutation.
4. **Skill scaffold** (`core/skills/distill/SKILL.md` + `CHANGELOG.md`): Standalone skill — does not import from `src/engine/compile/` or `src/engine/wiki/`. Works on any target (repo, skill, document, concept). Vault-agnostic: `OMS_VAULT` env not required.
5. **Smoke-test on existing mined targets**: Run distill on two of the already-mined reference repos (qmd or graphify). Verify output matches the absorption ledger entries in `docs/exec-plan/active/self-owned-second-brain/deep-interview-record.md`.

**Completion gate:** Distill runs on 2 test targets (one repo, one document) without mutating any system state; absorption report contains all 3 required sections; red-team analysis identifies at least the known patterns from the existing mining docs.

---

### M5 — Governance + Vault-Lint + Setup Interview

**Goal.** Complete C4: setup interview with deep-interview methodology (self-reimplemented, no omc dependency), `.oms/` two-layer governance structure (ADR-006), vault-lint (Layer 1 CONTRACT enforcement), vault-scaffold and vault-decision-record skills (ADR-003). Then execute the R18 swap ceremony.

**Components built:** C4 Config/Setup, .oms governance layers, vault-convention skill set.

**Implementation steps:**

1. **`.oms/` two-layer scaffold** (vault side): Create `.oms/governance/decisions/`, `.oms/governance/rules/`, `.oms/governance/architecture.md`. Confirm `.oms/taxonomy.yaml` + `.oms/concepts/*.yaml` + `core/ontology/schemas/` exist as Layer 1 CONTRACT. Update `.gitignore`: add `.oms/cache/` only (`.oms/` itself stays committed per ADR-006).
2. **Setup interview** (`core/skills/setup/SKILL.md` — update): Integrate deep-interview methodology — Socratic clarity, configurable ambiguity threshold, dimension scoring (Goal/Constraint/Criteria/Context), Round 0 topology gate, challenge modes (Contrarian/Simplifier/Ontologist). Self-reimplemented: no import of omc deep-interview skill. Record attribution in ACKNOWLEDGMENTS.md. Interview outputs: tier folder mapping (raw/processed/wiki paths), provenance grade mapping (folder→grade), lint schema SSOT, embedder selection, ignore-for-external-apis glob, agent-writable zone/routing law.
3. **Vault-lint** (`src/engine/conventions/vault-lint.ts` + `core/skills/vault-lint/SKILL.md`): Checker lane only. Enforcement against Layer 1 CONTRACT (taxonomy.yaml + concepts/*.yaml). Five checks: (1) allowlist — no rogue keys, (2) required key presence, (3) value type validation, (4) enum value validation, (5) cross-field — `created_by` routing law (agent notes must have `created_by`, must be in agent-writable zone). Default: report-only. Autofix: requires human gate (routing law guard). Reuse `src/conventions/validate.ts` + `src/conventions/lint.ts` as integration base; new vault-level runner wraps them.
4. **Vault-scaffold skill** (`core/skills/vault-scaffold/SKILL.md` + `CHANGELOG.md`): Seeds vault with default taxonomy from `core/ontology/taxonomy.yaml`. Writes `decisions/` zone (Ataraxia `95. Decisions` generalization). Creates `.oms/governance/architecture.md` stub. Writes `.oms/taxonomy.yaml` override path.
5. **Vault-decision-record skill** (`core/skills/vault-decision-record/SKILL.md` + `CHANGELOG.md`): Author lane. Records vault structural changes as ADR markdown in `.oms/governance/decisions/`. Supersede-only update rule. Never modifies Layer 1 CONTRACT files.
6. **Adapter skill mirrors**: For each new core skill (compile, wiki, distill, vault-lint, vault-scaffold, vault-decision-record), create corresponding SKILL.md in `adapters/claude-code/skills/`, `adapters/codex/skills/`, `adapters/hermes/skills/`. Update existing retrieve skill mirrors to surface new typed query interface (lex/vec/hyde/graph + gph mode).
7. **R18 swap ceremony** (final step, separate commit): (a) Update `src/mcp/server.ts` to route semantic/retrieval tools to `src/engine/` paths. (b) Update `src/cli/semantic.ts` to use new engine. (c) Rename `src/search/` → `src/search.legacy/` (do not delete — archive for one release cycle). (d) Run full golden-set harness again post-swap. (e) Run full test suite (`vitest`). All green → swap commit is final. `src/search.legacy/` deletion in follow-up PR.

**Completion gate:** Setup skill runs deep-interview on a fresh vault config and produces `.oms/taxonomy.yaml` + `.oms/governance/architecture.md`; vault-lint reports rogue keys on a test fixture and passes clean fixtures; R18 swap ceremony executed: full golden-set harness green post-swap, full vitest suite green; `.gitignore` updated; adapter skill mirrors created.

---

## Files Affected

| Path | Action | Notes |
|------|--------|-------|
| `src/engine/` | create (new dir) | New parallel engine module — R18 parallel build |
| `src/engine/embed/embedder.ts` | create | EmbeddingGemma-300M adapter, hardware-adaptive pool |
| `src/engine/embed/chunker.ts` | create | 900-token/15%-overlap, heading-boundary, code-fence |
| `src/engine/embed/sha.ts` | create | SHA-256 fingerprint for incremental diff |
| `src/engine/embed/store.ts` | create | sqlite-vec vec0 store, content-addressable schema |
| `src/engine/graph/builder.ts` | create | 4-tier weighted edge builder |
| `src/engine/graph/resolver.ts` | create | Wikilink path resolver (fixes opaque-string in `src/graph/cache.ts` without touching it) |
| `src/engine/graph/community.ts` | create | Leiden-first/Louvain-fallback community detection |
| `src/engine/retrieval/dispatcher.ts` | create | Typed sub-query dispatcher (lex/vec/hyde/graph + gph mode) |
| `src/engine/retrieval/rrf.ts` | create | RRF fusion k=60 |
| `src/engine/retrieval/reranker.ts` | create | Opt-in cross-encoder rerank (precision mode) |
| `src/engine/compile/worker.ts` | create | Stateless per-concept SHA worker |
| `src/engine/compile/sha-cache.ts` | create | SHA cache, persists to `.llmwiki/sha-cache.json` |
| `src/engine/compile/cot.ts` | create | Nashsu 2-step CoT (analysis → synthesis) |
| `src/engine/compile/phases.ts` | create | Atomicstrata 2-phase (extract-all → generate) |
| `src/engine/compile/cascade.ts` | create | Lucasastorian cascade: write returns affected_backlinks |
| `src/engine/compile/provenance.ts` | create | Provenance grade application in synthesis context |
| `src/engine/wiki/ledger.ts` | create | 5-state staleness FSM + `.llmwiki/staleness.json` |
| `src/engine/wiki/collection.ts` | create | Collection owner (5 responsibilities) |
| `src/engine/wiki/navigation.ts` | create | Karpathy wiki/index.md + wiki/log.md |
| `src/engine/wiki/lint.ts` | create | Astro-Han 2-tier wiki lint |
| `src/engine/distill/clean-room.ts` | create | Throwaway subagent mechanism |
| `src/engine/distill/analyzer.ts` | create | Red-team adversarial analyzer |
| `src/engine/distill/report.ts` | create | Structured absorption report writer |
| `src/engine/conventions/vault-lint.ts` | create | Vault-level CONTRACT enforcement runner |
| `test/golden-set/queries.ts` | create | N≈20 stratified golden-set queries + expected notes |
| `test/golden-set/harness.ts` | create | Parity comparator vs qmd baseline, recall@10 scorer |
| `core/skills/compile/SKILL.md` | create | /skillify structure, semver 0.1.0 |
| `core/skills/compile/CHANGELOG.md` | create | Attribution + history |
| `core/skills/wiki/SKILL.md` | create | /skillify structure, semver 0.1.0 |
| `core/skills/wiki/CHANGELOG.md` | create | Attribution + history |
| `core/skills/distill/SKILL.md` | create | /skillify structure, standalone, semver 0.1.0 |
| `core/skills/distill/CHANGELOG.md` | create | Attribution + history |
| `core/skills/vault-lint/SKILL.md` | create | /skillify structure, checker lane only |
| `core/skills/vault-lint/CHANGELOG.md` | create | — |
| `core/skills/vault-scaffold/SKILL.md` | create | /skillify structure, default taxonomy seeder |
| `core/skills/vault-scaffold/CHANGELOG.md` | create | — |
| `core/skills/vault-decision-record/SKILL.md` | create | /skillify structure, author lane only |
| `core/skills/vault-decision-record/CHANGELOG.md` | create | — |
| `private/` | create (dir, **gitignored**) | R19/R20 personal overlay — thick router + local recipes + vault-path/people config. Never published. |
| `private/skills/router/SKILL.md` | create | **Thick router (private, R20)** — personal vault-operation recipes; routes intent to generic public leaves; env-injects personal config |
| `private/skills/router/CHANGELOG.md` | create | — |
| `private/config.local.json` | create (gitignored) | Vault paths, people names, `ignore_for_external_apis` globs — env-loaded, never embedded to external APIs |
| `core/ontology/schemas/` | create (dir) | Frontmatter schema files (type/enum/required per note-type) |
| `adapters/claude-code/skills/compile/SKILL.md` | create | Adapter mirror |
| `adapters/claude-code/skills/wiki/SKILL.md` | create | Adapter mirror |
| `adapters/claude-code/skills/distill/SKILL.md` | create | Adapter mirror |
| `adapters/claude-code/skills/vault-lint/SKILL.md` | create | Adapter mirror |
| `adapters/claude-code/skills/vault-scaffold/SKILL.md` | create | Adapter mirror |
| `adapters/claude-code/skills/vault-decision-record/SKILL.md` | create | Adapter mirror |
| `adapters/codex/skills/oms-compile/SKILL.md` | create | Codex adapter mirror |
| `adapters/codex/skills/oms-wiki/SKILL.md` | create | Codex adapter mirror |
| `adapters/codex/skills/oms-distill/SKILL.md` | create | Codex adapter mirror |
| `adapters/codex/skills/oms-vault-lint/SKILL.md` | create | Codex adapter mirror |
| `adapters/hermes/skills/compile/SKILL.md` | create | Hermes adapter mirror |
| `adapters/hermes/skills/wiki/SKILL.md` | create | Hermes adapter mirror |
| `adapters/hermes/skills/distill/SKILL.md` | create | Hermes adapter mirror |
| `core/skills/setup/SKILL.md` | modify | Add deep-interview methodology (Socratic/ambiguity/challenge modes) — R16 |
| `adapters/claude-code/skills/retrieve/SKILL.md` | modify | Add typed query surface (lex/vec/hyde/graph + gph mode) |
| `adapters/codex/skills/oms-retrieve/SKILL.md` | modify | Same |
| `adapters/hermes/skills/retrieve/SKILL.md` | modify | Same |
| `src/mcp/server.ts` | modify | Post-swap: route semantic/retrieval tools to `src/engine/` paths |
| `src/cli/semantic.ts` | modify | Post-swap: use new engine |
| `.gitignore` | modify | Add `.oms/cache/` and `private/` (R19 personal isolation). NOT `.oms/` itself (committed per ADR-006) |
| `ACKNOWLEDGMENTS.md` | modify | Add absorption attributions for qmd/graphify/gajae-code/nashsu/nvk/lucasastorian/atomicstrata/Karpathy/Astro-Han/gbrain |
| `src/search/` (all files) | NO CHANGE | R18 hard constraint — working layer untouched until swap ceremony |
| `src/graph/cache.ts` | NO CHANGE | R18 — wikilink resolve fix implemented in `src/engine/graph/resolver.ts` instead |
| `src/search.legacy/` | rename (post-swap) | `src/search/` archived here after swap ceremony; delete in follow-up PR |

---

## Absorbed-Pattern Mapping

| Component | Pattern Absorbed | Source | Research Doc |
|-----------|-----------------|--------|-------------|
| C1 `src/engine/embed/embedder.ts` | Hardware-adaptive parallel pool (P-01), Promise.all distributed embed, 2-stage batching | qmd (tobi, MIT) | `docs/research/embedding-pipeline-patterns-mining.md` |
| C1 `src/engine/embed/sha.ts` | SHA-256 incremental + fingerprint, success-counter retry | qmd | `docs/research/embedding-pipeline-patterns-mining.md` |
| C1 `src/engine/embed/store.ts` | sqlite-vec0, lazy-load + 5-min unload, 30-min guard | qmd | `docs/research/embedding-pipeline-patterns-mining.md` |
| C2 `src/engine/graph/builder.ts` | 4-pass entity dedup, Leiden-first/Louvain-fallback + cohesion-split, grow-only build_merge, 2-tier cache | graphify (Safi Shamsi, MIT) | `docs/research/graphify-graph-implementation-mining.md` |
| C2 `src/engine/graph/builder.ts` (edge weights) | 4-signal composite edge weight (wikilink×3, sources[]×4, Adamic-Adar×1.5, type-affinity×1.0) | nashsu/llm_wiki (GPL-3.0 — idea only, no verbatim code) | `docs/research/llm-wiki-ecosystem-design-references.md` |
| C3 `src/engine/retrieval/dispatcher.ts` | Typed sub-query surface (lex/vec/hyde) | qmd | `docs/research/retrieval-engine-design-references.md` |
| C3 `src/engine/retrieval/rrf.ts` | RRF k=60 fusion | gbrain (logic only; license unconfirmed — no verbatim code) + MS GraphRAG pattern | `docs/research/retrieval-engine-design-references.md` |
| C3 `src/engine/retrieval/dispatcher.ts` | P-03 ContextVar cancel token, P-08 2-layer retry, P-13 in-flight dedup | gajae-code (Can Bölük / Mario Zechner, MIT) | `docs/research/gajae-code-patterns-mining.md` |
| C5 `src/engine/compile/cot.ts` | 2-step CoT (Step1 analysis, Step2 synthesis with wikilink insertion) | nashsu/llm_wiki (GPL-3.0 — idea only) | `docs/research/compile-wiki-operation-references.md` |
| C5 `src/engine/compile/phases.ts` | 2-phase separation (extract-all-without-writing → generate) | atomicstrata (license TBD — idea-absorb, concept only) | `docs/research/compile-wiki-operation-references.md` |
| C5 `src/engine/compile/cascade.ts` | Write → backlink-return cascade (agent can self-schedule ripple updates) | lucasastorian/llmwiki | `docs/research/compile-wiki-operation-references.md` + `docs/research/llm-wiki-ecosystem-design-references.md` |
| C5 `src/engine/compile/worker.ts` | SHA-incremental per-compile-unit (Step2-4 of terminology self-authored pattern) | bstack `terminology` skill (self-authored, no external restriction) | `docs/research/compile-wiki-operation-references.md` |
| C5 `src/engine/wiki/navigation.ts` | wiki/index.md global catalog + wiki/log.md append-only, 3 operations (ingest/query/lint) | Karpathy gist (no license declared — idea only) + Astro-Han SKILL.md (MIT) | `docs/research/llm-wiki-ecosystem-design-references.md` |
| C5 `src/engine/wiki/collection.ts` | raw/wiki 2-folder structure, init-if-missing, cascade pass, 3-phase hard separation | Astro-Han SKILL.md (MIT) + nvk/llm-wiki (Apache 2.0) | `docs/research/llm-wiki-ecosystem-design-references.md` |
| C5 `src/engine/wiki/collection.ts` (fan-out) | Perspective-based fan-out (Academic/Technical/Applied/Contrarian), Thesis mode (Supporting vs Opposing) | nvk/llm-wiki (Apache 2.0) | `docs/research/llm-wiki-ecosystem-design-references.md` |
| C4 `core/skills/setup/` | Socratic clarity, ambiguity scoring, Round-0 topology gate, challenge modes | omc deep-interview methodology (self-reimplemented — no code copy, method only) | `docs/exec-plan/active/self-owned-second-brain/deep-interview-record.md` R16 |

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| EmbeddingGemma-300M quality insufficient for vault's specialized Korean + technical terminology — golden-set never reaches parity | Medium | High (M1 gate blocks all milestones) | Upstage Solar 4096d opt-in path wired in M1 embedder; if 768d fails parity, activate Solar path for vec/hyde sub-types only. ADR-002 tier model explicitly supports this. |
| Wikilink resolver (`src/engine/graph/resolver.ts`) scope creep — resolving opaque strings in 20k notes is a data quality problem, not just a code problem | Medium | Medium (M1 delay) | Resolver is best-effort: unresolvable wikilinks become typed `unknown-ref` edges (not errors). Ghost nodes from graphify gap #1283 handled by graceful degradation. R8 parity gate uses recall@10, so imperfect graph still yields passing gate. |
| SHA cache state corruption between Obsidian forced-sync and `.llmwiki/staleness.json` (M3) | Low | Medium (M3 consistency) | Full-rebuild escape hatch: delete `.llmwiki/staleness.json` → all states reset to DIRTY. Document in wiki skill SKILL.md. `.oms/cache/` gitignored prevents cross-machine cache conflicts. |
| Distill clean-room mechanism complexity (M4) — correct subagent isolation is harder than it looks; main state leaks possible | Medium | Low (M4 independent) | Initial implementation: clean-room = single-use Claude subagent with empty context, target loaded as read-only text blocks only. No tool calls against live vault. Verified by mutation-detector test (vault SHA snapshot before/after distill run). |
| R18 parallel module code duplication creates maintenance debt during M1-M5 development | High (certain) | Low (temporary) | Duplication is the design — explicit isolation until swap. Mitigated by swap ceremony in M5 which retires `src/search/` completely. `src/search.legacy/` archived one release cycle for rollback, then deleted. |
| Setup interview (M5) self-reimplementation of deep-interview methodology balloons into its own full-featured project | Medium | Medium (M5 delay) | Strictly time-box: implement only the 6 interview dimensions needed for vault binding (folder mapping, provenance grades, lint SSOT, embedder, ignore zones, write routing). No omc feature-parity goal. Socratic clarity pattern only, no full ambiguity scoring dashboard. |
| Golden-set query curation bias — 20 hand-curated queries reflect creator's vocabulary, not vault's diversity | Medium | Medium (false parity signal) | Stratified sampling required: at least 4 queries per type (lex/vec/hyde/graph); at least one cross-language query (Korean + English); at least one technical concept query; at least one personal-capture query. Loop-until-dry growth ensures coverage expansion on failure discovery. |
| GPL-3.0 contamination from nashsu/llm_wiki (idea absorption miscounted as code absorption) | Low | High (legal) | Hard rule: nashsu = idea-only. No file from nashsu is copied verbatim. All nash-derived logic (2-step CoT, edge weights) is implemented from scratch with only the algorithm described. Verified by grep for nashsu strings in `src/engine/`. |

### Pre-Mortem (3 Failure Scenarios)

1. **M1 never gates.** EmbeddingGemma-300M produces low-quality vectors for the vault's mixed Korean/English/technical content. The golden-set harness fails on vec and hyde sub-types even after Upstage Solar opt-in is activated. Root cause: embedding model tier choice was made without vault-specific benchmarking. Mitigation probe: before M1 step 5 (harness creation), run a 100-note pilot embedding comparison (EmbeddingGemma-300M vs Upstage Solar) on the vault's densest cluster. If Solar is needed as the default tier, revise M1 step 2 accordingly before full harness creation.

2. **M3 staleness ledger diverges from vault reality.** After several compile runs and Obsidian sync events, `.llmwiki/staleness.json` reflects a state inconsistent with the actual `wiki/` folder contents (e.g., pages marked CLEAN that were overwritten by a manual vault edit). Result: wiki pages are stale but not recompiled. Root cause: external vault mutations bypass the ledger. Mitigation: staleness ledger must perform a SHA spot-check of `wiki/` pages at collection-owner startup, not just on compile triggers. Inexpensive (only check modified-time delta, full SHA only on suspicion).

3. **M5 setup interview produces vault-specific config that breaks Non-Sticky guarantee.** A well-intentioned setup interview that "learns" Ataraxia's folder structure produces config outputs that only work for Ataraxia. Other vaults fail silently. Root cause: defaults are seeded from the local vault and not cleaned before being written as engine defaults. Mitigation: setup interview must output to `vault/.oms/taxonomy.yaml` (vault-local override), never to `core/ontology/taxonomy.yaml` (engine default). The engine default is extracted from Ataraxia manually and reviewed before shipping. Enforce this path separation in the vault-scaffold skill's write path.

---

## Verification

### Breadth-First All-Path Strategy (R8)

Verification is not sequential. After M1 completes, the golden-set harness becomes the continuous regression signal for all subsequent milestones. Four verticals are validated independently:

| Vertical | Validation Method | When |
|----------|-----------------|------|
| **C3 Retrieval** (all sub-paths) | Golden-set harness: lex/vec/hyde/graph × RRF × opt-in rerank × gph mode. Recall@10 per type vs qmd baseline. | M1 gate; re-run after every milestone commit |
| **C5 Wiki/Compile** | 10-concept compile pilot (SHA incremental), staleness state machine test fixture, wiki/index.md + wiki/log.md content verification | M2 gate, M3 gate |
| **C6 Distill** | Mutation-detector test (vault SHA snapshot before/after), absorption report section completeness check, smoke-test on 2 known targets | M4 gate |
| **C4 Access/Setup** | Setup interview dry-run on isolated vault fixture, vault-lint on known-bad + known-good frontmatter fixtures, `.oms/` two-layer structure verification | M5 gate |

### Retrieval Sub-Path Coverage

Every sub-path in C3 must be independently verified in the golden-set harness (R8 "all paths"):

| Sub-path | Verification |
|----------|-------------|
| lex only | At least 4 golden queries (exact term matching) |
| vec only | At least 4 golden queries (semantic meaning) |
| hyde only | At least 4 golden queries (hypothetical document) |
| graph only | At least 4 golden queries (graph traversal) |
| lex + vec RRF fusion | At least 2 fusion queries (hybrid) |
| all 4 types → RRF | At least 2 full-fusion queries |
| RRF → opt-in rerank | 1 precision-mode query (separate parity measurement) |
| gph mode (BFS/DFS/community) | 2 traversal queries |

### Golden-Set Parity Harness (R4/R7)

- N≈20 queries at start; grows loop-until-dry.
- k=10 for all measurements.
- Parity condition: recall@10 for new engine ≥ recall@10 for qmd baseline on each query type average, AND no single query type drops below 80% of qmd performance.
- Harness emits JSON report: `{ query, type, expected_notes, engine_top10, qmd_top10, engine_recall, qmd_recall, pass }`.
- Harness stored at `test/golden-set/` and wired into vitest as a named test suite (skipped in CI by default, requires vault fixture; manual run only per R2 stateless/manual constraint).

### Expanded Test Plan

- **Unit**: Per-module tests for embed chunker (boundary conditions), SHA diff (unchanged / changed / deleted), RRF scorer (k=60 numerical correctness), staleness FSM (all 5 states + transitions), clean-room isolation (no main-state mutation).
- **Integration**: C1+C2+C3 tracer end-to-end on a 100-note vault fixture (not full Ataraxia). Compile worker + wiki collection owner on a 10-concept fixture (M2+M3 integration). Vault-lint against known-bad and known-good frontmatter fixtures (M5 integration).
- **E2E / Golden-Set**: Full golden-set harness on Ataraxia vault slice (manual trigger, vitest named suite).
- **Observability**: Timing logs emitted to `.oms/cache/diagnostics/last-run.json` — per sub-query type latency, RRF score distributions, embed latency, compile SHA-skip rate. Not shipped as user-facing output; used during golden-set tuning.

---

## ADR Block

### Decision

Build the oms engine as a new parallel module at `src/engine/` alongside the existing working vector layer (`src/search/`). Prove parity-or-better on the golden-set harness (N≈20, k=10, stratified by query type). Only after parity is confirmed does the swap ceremony retire `src/search/` and route production traffic to `src/engine/`.

### Drivers

1. **R18 replace strategy** (locked spec constraint): "parallel NEW module → golden-set parity-or-better → then swap. Never in-place mutate the working layer."
2. **R8 build order** (locked spec constraint): Retrieval vertical tracer (C1+C2+C3) is the parity anchor. Must be end-to-end runnable first.
3. **R7 golden-set gate** (locked success criterion): N≈20 hand-curated queries, k=10, recall@10 parity-or-better vs qmd/gbrain.

### Alternatives Considered

| Alternative | Why Rejected |
|-------------|-------------|
| In-place refactor of `src/search/` — upgrade the existing embedder, add graph, add RRF, all in place | R18 explicit hard lock: "do NOT touch the working vector layer in place." Production regression risk unacceptable. |
| Incremental feature additions to `src/search/` (add one feature at a time, no parallel module) | Same R18 violation. Also: the existing layer's architecture (no chunking, no graph integration, SHA1 hash embedder) requires replacement, not extension. Incremental additions would accumulate against a structurally unsound base. |
| Separate repo for new engine, then copy over | Rejected: adds distribution complexity, breaks the existing MCP server wiring, and creates a multi-repo management burden incompatible with the manual/stateless ethos. Single-repo parallel module is the right isolation level. |
| Wait for all 6 components before any validation | Rejected: R8 requires M1 as a parity anchor specifically to prevent building M2-M5 on a retrieval layer that doesn't work. Golden-set must gate M1. |

### Why Chosen

The parallel-module + golden-set-gate strategy is the only approach that satisfies all three locked constraints simultaneously (R18 + R8 + R7). It gives a clear rollback path (swap never happens if parity isn't reached), zero regression risk during development, and an unambiguous "done" signal (harness passes = swap is safe).

### Consequences

**Positive:**
- Zero regression risk to existing retrieval during development.
- Parity gate is a binary, automated, evidence-backed signal.
- Rollback path is trivial (swap never executed; `src/search.legacy/` retained for one release cycle).

**Neutral / Tradeoffs:**
- Temporary code duplication (`src/search/` + `src/engine/` coexist during M1-M5).
- Two MCP routing paths during development (resolved at swap ceremony in M5).

**Follow-ups after swap:**
- Delete `src/search.legacy/` in a dedicated follow-up PR (not in the swap commit).
- **Decided (R21):** engine module dir convention = `src/engine/{embed,index,graph,retrieve,wiki,distill}/`, one sub-dir per component, README per sub-dir, no loose files at the module root; new capability = new named sub-dir.
- **Decided (R21):** staleness ledger persistence = JSON (`.llmwiki/staleness.json`, human-readable, delete-to-reset); revisit SQLite only if profiling proves JSON rewrite cost at concept-unit scale.

---

## Cross-Cutting Decisions to Distill

These decisions surfaced during planning. **All six were ratified in deep-interview R20/R21** (see `deep-interview-record.md`) and are now decided; each should still be distilled into a formal `docs/decisions/ADR-00N-*.md` during execution.

- [x] **engine module directory convention** — ✅ R21: `src/engine/{embed,index,graph,retrieve,wiki,distill}/`, one sub-dir per component, README per sub-dir, no loose files at the module root; new capability = new named sub-dir. (Prevents catch-all.)
- [x] **staleness ledger persistence format** — ✅ R21: **JSON** (`.llmwiki/staleness.json`) — human-readable, delete-to-reset escape hatch, gitignored·never-synced. Per-concept-unit count ≪ 20k notes, so JSON is sufficient; SQLite deferred unless profiling proves rewrite cost.
- [x] **golden-set harness tooling** — ✅ R21: **vitest named suite** at `test/golden-set/`, skipped in CI, manual-run only via `RUN_GOLDEN=1` env gate (encodes R2 manual-only / no-CI).
- [x] **R18 swap ceremony procedure** — ✅ R21: M5 step 7 — parity-green → rename `src/search/`→`src/search.legacy/` (swap commit) → flip MCP routing → delete `.legacy` in a separate follow-up PR after one release cycle. **⚠️ SUPERSEDED 2026-06-14 (see Execution Update):** swap shipped in two rounds (graph-only → Phase 2 model-gated) and the `.legacy` rename is *cancelled* — `src/search/` stays first-class as the model-gated fallback tier; no follow-up deletion PR is owed.
- [x] **setup interview self-reimplementation scope** — ✅ R21: exactly 6 binding dimensions (folder mapping, provenance grades, lint SSOT, embedder, `ignore_for_external_apis`, write routing). No full Ouroboros-level ambiguity engine. Output to `vault/.oms/taxonomy.yaml` only (Non-Sticky guard).
- [x] **skill packaging: thick-router/leaf split + private boundary** — ✅ R20/R21 (new): one private thick router routes to generic public leaves; distill standalone; public/private boundary == router↔leaf; personal overlay isolated behind `private/` (gitignore) or submodule (R19).
- [ ] **ACKNOWLEDGMENTS.md additions required** — before any code using absorbed patterns ships: qmd (tobi, MIT), graphify (Safi Shamsi, MIT), gajae-code (Can Bölük / Mario Zechner, MIT), Karpathy gist, Astro-Han (MIT), nvk/llm-wiki (Apache 2.0), lucasastorian (license TBD — note as unconfirmed), nashsu/llm_wiki (GPL-3.0 — idea-only, no code; attribution still required per standing rule), omc deep-interview methodology (self-reimplemented method, attribution in ACKNOWLEDGMENTS), terminology bstack self-authored (internal reference). gbrain license status remains TODO — flag as unresolved before any gbrain-derived logic ships.

---

## Build Sequencing / Dynamic Workflow (post-approval — DO NOT fire now)

> Execution harness for M1–M5, launched **only after this plan is approved**. The `Workflow` tool requires explicit opt-in; this section is the *design*, not a trigger. Mirrors RALPLAN Option B (spine + constrained parallelism) and R8 (breadth-first parity verification).

**Phasing (to the milestone dependency graph):**

1. **Phase M1 (spine, sequential).** One agent builds the Retrieval vertical tracer (C1+C2+C3) + golden-set harness in `src/engine/`. Hard gate: harness parity-or-better vs qmd on all 4 sub-types. No downstream phase starts until this returns green. (Sole writer → no worktree isolation needed.)
2. **Phase M2 ∥ M4 (constrained parallel).** After the M1 gate: Compile (C5 content) and Distill (C6 capability) share no code paths (R3 MECE) and run concurrently, **each in its own git worktree** (`isolation: 'worktree'`) so parallel writes never collide; worktrees merge back as each returns.
3. **Phase M3 (waits for M2).** Wiki collection owner + staleness ledger depend on M2 compile output → a pipeline stage *after* the Compile branch, not parallel to it.
4. **Phase M5 (terminal).** Governance + vault-lint + setup interview + **R18 swap ceremony**. Swap is the last step, gated on full golden-set + `vitest` green.

**Adversarial parity verification (R8 + critic pattern).** After each component phase a *separate* verifier agent re-runs the golden-set harness and tries to **refute** the completion gate before the phase counts as done — authoring and verification stay in separate lanes (never self-approve in the same context).

**Pseudo-shape:**

```js
phase('M1');
const m1 = await agent(buildTracer, { schema: GATE });            // spine — must gate green
if (!m1.parity) throw 'M1 parity gate failed — halt';
phase('M2∥M4');
const [m2, m4] = await parallel([
  () => agent(buildCompile, { isolation: 'worktree', schema: GATE }),
  () => agent(buildDistill, { isolation: 'worktree', schema: GATE }),
]);
phase('M3');
const m3 = await agent(buildWiki(m2), { isolation: 'worktree', schema: GATE });
phase('M5');
const m5 = await agent(buildGovernanceThenSwap, { schema: GATE }); // swap ceremony terminal
// each phase: a verifier agent adversarially re-runs the golden-set before the gate counts
```

**Guardrails carried in:** manual/stateless (R2) — user-launched, no daemon; parity-or-better (R7/R18) is the *only* swap trigger; `src/search/` untouched until the M5 swap; bulk writes (>50 files) and any deletion go through the routing-law guard.
