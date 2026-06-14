# ACKNOWLEDGMENTS

oh-my-secondbrain은 아래 공개 작업들의 아이디어와 구현에 빚지고 있다.
만들고 아낌없이 공개해주신 모든 분들께 진심으로 감사드린다.

> 우리가 무엇을 흡수했는지(설계 로직·근거)는 `docs/research/*` 에 기록한다.
> 관리 규칙: [`docs/rules/external-attribution.md`](./docs/rules/external-attribution.md)

## LLM-Wiki 패턴 & 구현체

- https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- https://github.com/Astro-Han/karpathy-llm-wiki
- https://github.com/nashsu/llm_wiki — GPL-3.0: **아이디어만 참조, 코드 미사용**
- https://github.com/nashsu/llm_wiki_skill — 무라이선스: 개념 참조만
- https://github.com/nvk/llm-wiki
- https://github.com/lucasastorian/llmwiki
- https://github.com/atomicstrata/llm-wiki-compiler
- https://github.com/shannhk/llm-wikid
- https://github.com/AgriciDaniel/claude-obsidian
- https://github.com/NicholasSpisak/second-brain
- 박제창(Dreamwalker) — https://medium.com/@aristojeff
- @aboutcorelab — https://www.threads.com/@aboutcorelab
- 패스트캠퍼스 — https://fastcampus.co.kr/biz_camp_llmwiki
- MindStudio — https://www.mindstudio.ai/blog/ai-second-brain-obsidian-vault-folder-architecture

## 검색 / 임베딩 엔진

- https://github.com/tobi/qmd
- gbrain — 원 repo URL 미확인 `TODO(verify)`
- https://github.com/pgvector/pgvector
- https://github.com/electric-sql/pglite

## 그래프 접근

- https://github.com/safishamsi/graphify  (후원: https://github.com/sponsors/safishamsi)

## Agent Skills 생태계

- https://github.com/anthropics/skills
- https://github.com/VoltAgent/awesome-agent-skills
- https://github.com/code-yeongyu/lazycodex — MIT, **vendored**: `programming` 스킬 직접 설치, LICENSE+저작권 고지 보존 (`~/.claude/skills/programming/`)
- https://github.com/Yeachan-Heo/oh-my-claudecode
- https://github.com/Yeachan-Heo/oh-my-codex

---

## M1 Retrieval Engine — Absorbed Patterns

아래 패턴들은 M1 엔진(src/engine/) 구현 과정에서 아이디어/알고리즘만 흡수한 목록이다.
**verbatim 코드 사용 없음** — 모든 구현은 독립적으로 작성되었다.

| Pattern | Source | License | Note |
|---------|--------|---------|------|
| Adamic-Adar co-link scoring: AA(u,v) = Σ_{w∈N(u)∩N(v)} 1/log(deg(w)). Implemented by iterating each node w, enumerating pairs of its neighbours, and accumulating 1/log(deg(w)) into a canonical pair key. | [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) | GPL-3.0 | **IDEA-ONLY — zero verbatim code** |
| Composite edge weight = weighted sum of per-tier contributions (wikilink×3.0, frontmatter×4.0, adamic-adar×1.5, type-affinity×1.0). Frontmatter relation extraction from `sources[]`/`relations[]` YAML keys. | [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) | GPL-3.0 | **IDEA-ONLY — zero verbatim code** |
| Stable community-detection interface (`detectCommunities` / `CommunityOptions` / `Community`) designed so Leiden-first/Louvain-fallback can replace the body without changing callers. M1 implementation is weighted label-propagation. | [graphify (Safi Shamsi)](https://github.com/safishamsi/graphify) | MIT | Interface pattern only |
| Reciprocal Rank Fusion weight schedule: score(d) = Σ 1/(k+rank_i(d)), k=60 default calibration | [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) + MS GraphRAG technical report | GPL-3.0 (idea-only) / public algorithm | Zero verbatim code |
| HyDE (Hypothetical Document Embeddings) — generate a hypothetical answer passage then embed it for retrieval | [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) | GPL-3.0 | **IDEA-ONLY — zero verbatim code** |
| P-08-style two-layer retry: inner immediate retry + outer 50 ms back-off, abort on CancelToken | P-08 resilience pattern (architecture concept) | idea-only | No external code |
| Lightweight cancel token: mutable boolean wrapped in a getter+cancel() object, threaded through every async call | gajae-code patterns | MIT | idea-only, implementation is original |
| Lazy-load + 5-minute idle unload guard (`src/engine/embed/provider.ts`): model/contexts not initialised until first `embed()` call; a `setTimeout` resets per call; no calls for 5 min → dispose pool; next `embed()` reloads lazily. The only permitted timer (plan.md:83, R2). | [qmd (tobi)](https://github.com/tobi/qmd) | MIT | **IDEA-ONLY — zero verbatim code** |
| Hardware-adaptive parallel embed pool (`src/engine/embed/provider.ts`): `poolSize = min(4, cpuCount-1)`, round-robin context selection across the pool, `Promise.all` parallel context init, 2-stage batch distribution. | [qmd (tobi)](https://github.com/tobi/qmd) | MIT | **IDEA-ONLY — zero verbatim code** |
| SHA-256 chunk-level incremental diff (`src/engine/embed/sync.ts`): compute SHA-256 of each chunk text; compare with stored SHA from `EngineStore.getShas()`; skip `embed()` call when SHA matches — only changed chunks are re-embedded. | [qmd (tobi)](https://github.com/tobi/qmd) | MIT | **IDEA-ONLY — zero verbatim code** |

> **⚠ License flag — gbrain**: The gbrain project was referenced for logic/architecture patterns only. The original repo URL and license are unconfirmed (`TODO(verify)`). No code was copied. Attribution will be updated once the license is confirmed.

---

## M2 Compile Engine — Absorbed Patterns

M2 엔진(src/engine/compile/) 구현 과정에서 아이디어/알고리즘만 흡수한 목록이다.
**verbatim 코드 사용 없음** — 모든 구현은 독립적으로 작성되었다.

| Pattern | Source | License | Note |
|---------|--------|---------|------|
| SHA-incremental per-compile-unit: fingerprint materials → diff SHA → skip or recompile → persist SHA (`.llmwiki/sha-cache.json`) | bstack `terminology` skill | Self-authored | Full idea absorption |
| 2-step Chain-of-Thought: Step 1 analysis (entity/concept/argument/contradiction/structure) → Step 2 synthesis (source summary + concept page + `[[wikilink]]`); Step 1 output is Step 2 context, always sequential | [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) | GPL-3.0 | **IDEA-ONLY — zero verbatim code** |
| 2-phase separation: Phase A extract-all-without-writing (pure read) / Phase B generate (writes to `processed/`, never `wiki/`); A·B never overlap in one execution context | atomicstrata | License TBD | **CONCEPT-ONLY — no code** |
| Cascade return: every compile write returns `{ affected_backlinks: string[] }` so the M3 caller schedules staleness updates | lucasastorian/llmwiki | Terminology only | **CONCEPT-ONLY — no code** |

---

## M4 Distill — Absorbed Patterns

M4 Distill 스킬(src/engine/distill/)은 standalone 흡수-분석기다.
**verbatim 코드 사용 없음** — 패턴 시그니처는 self-authored mining 문서에서 도출했다.

| Pattern | Source | License | Note |
|---------|--------|---------|------|
| Provider-injection seam (`AnalyzerProvider` mirrors `EmbeddingProvider`) — deterministic stub for tests, real LLM injected in production | oh-my-secondbrain M1 (self) | Internal | 코드베이스 1급 설계 패턴 |
| Red-team pattern signatures: parallel pool, SHA-256 fingerprint, sqlite-vec store, token chunker, retry, RRF fusion, typed sub-query | [qmd (tobi)](https://github.com/tobi/qmd) | MIT | mining doc 도출, verbatim 없음 |
| Red-team pattern signatures: 4-pass entity dedup, Leiden/Louvain community detection, grow-only build_merge, 3-tier edge confidence, pipeline-as-modules, 2-pass extraction | [graphify (Safi Shamsi)](https://github.com/safishamsi/graphify) | MIT | mining doc 도출, verbatim 없음 |
| Clean-room mechanism (pure data spec, caller spawns subagent) + mutation-detector SHA snapshot protocol | plan.md M4 / deep-interview R13·R16 | Internal | Self-authored |

---

## M3 Wiki Engine — Absorbed Patterns

M3 위키 컬렉션(src/engine/wiki/ + core/skills/wiki/) 구현 과정에서 아이디어/알고리즘만 흡수한 목록이다.
**verbatim 코드 사용 없음** — 모든 구현은 독립적으로 작성되었다.

| Pattern | Source | License | Note |
|---------|--------|---------|------|
| Navigation conventions: `wiki/index.md` global catalog regenerated after every compile run; `wiki/log.md` append-only compile log (`## [YYYY-MM-DD] compile \| ConceptName`) | [Karpathy wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) | No license declared | **IDEA-ONLY — no verbatim code** |
| Collection owner pattern: five responsibilities (namespace/identity, link-graph closure, staleness-ledger delegation, navigation delegation, processed→wiki promotion) | [Astro-Han/karpathy-llm-wiki](https://github.com/Astro-Han/karpathy-llm-wiki) | MIT | **IDEA-ONLY — no verbatim code** |
| 3-phase hard separation: Research→Compile(sequential)→Wiki(read-only query surface); compile never writes wiki/ directly, a wiki query never triggers compile, promotion is the sole path into wiki/ | [nvk/llm-wiki](https://github.com/nvk/llm-wiki) | Apache-2.0 | **IDEA-ONLY — no verbatim code** |
| Cascade consumption: consume `affected_backlinks` from the M2 compile result to schedule staleness flips (CLEAN→DIRTY) | [lucasastorian/llmwiki](https://github.com/lucasastorian/llmwiki) | Terminology only | **CONCEPT-ONLY — no code** |

---

## M5 Governance, Conventions, Setup & Adapters — Absorbed Patterns

M5 거버넌스/컨벤션/셋업/어댑터 레이어 구현 과정에서 아이디어/방법론만 흡수한 목록이다.
**verbatim 코드 사용 없음** — 모든 구현은 독립적으로 작성되었다.

**Conventions / vault-lint** (`src/engine/conventions/`)

| Pattern | Source | License | Note |
|---------|--------|---------|------|
| `validateFrontmatter()` + `parseNote()` delegated for required/type checks; wrapper adds checks 1/4/5 around them | `src/conventions/{validate,frontmatter}.ts` (self) | Self-authored | Direct import, read-only |
| Directory-walk pattern (SKIP_DIRS + recursive readdir generator) reimplemented independently to avoid coupling to link-issue logic | `src/conventions/lint.ts` (self) | Self-authored | Pattern absorbed, not imported |

**Setup interview** (`core/skills/setup/`)

| Pattern | Source | License | Note |
|---------|--------|---------|------|
| Socratic clarity loop; ambiguity scoring `1 − mean(goal, constraint, criteria, context)`; Round-0 topology gate; Contrarian / Simplifier / Ontologist challenge modes | omc deep-interview methodology | Self-reimplemented | **METHOD-ONLY — no source code copied**; loop, scoring, gate, modes independently authored in TypeScript |

**Governance skills** (`core/skills/vault-scaffold/`, `core/skills/vault-decision-record/`)

| Pattern | Source | License | Note |
|---------|--------|---------|------|
| decisions/ zone pattern — a dedicated top-level folder for structural decision artefacts | Ataraxia vault "95. Decisions" | Private vault, no external license | CONCEPT-ONLY — no verbatim content |
| Six-field ADR structure (context/decision/consequences/status/supersedes/superseded_by) | Michael Nygard ADR template (cognitect.com/blog/2011) | No license stated | IDEA-ONLY — format reimplemented |
| Taxonomy seeder (read engine DEFAULT → write per-vault override) + vault-confinement guard mirroring `src/capture/safe.ts` | bstack second-brain design (self) | Self-authored | Full idea absorption |
| Append-only/immutability → SUPERSEDE-ONLY ADR update rule; architecture.md stub follows the sub-dir README (R21) convention | M3 wiki ledger + `src/engine/compile/README.md` (self) | Self-authored | Internal reuse, same codebase |

**Governance scaffold & ontology schemas** (`.oms/governance/`, `core/ontology/schemas/`)

| Pattern | Source | License | Note |
|---------|--------|---------|------|
| Two-layer `.oms/governance/` (decisions/ + rules/ + architecture.md) mirroring document-ontology discipline | craft-skills `documents` skill | Internal skill, no external restriction | STRUCTURE-ONLY — all YAML independently authored (ADR-003 / ADR-006) |
| Thick-router (private) + generic-leaf (public) topology; monorepo + `private/` gitignore isolation | deep-interview R19 / R20 (self) | N/A — internal | No external code; user-ratified design decisions |
| Layer-1 CONTRACT / Layer-2 GOVERNANCE separation invariants | ADR-006 (self) | N/A — internal | User-ratified 2026-06-13 |

**Skill adapters** (`adapters/`)

| Work | Source | License | Note |
|------|--------|---------|------|
| Thin adapter mirrors for compile / distill / vault-lint / vault-scaffold / vault-decision-record / wiki across claude-code, codex, hermes; retrieve mirrors updated to surface the typed lex/vec/hyde/graph query interface + gph mode | core skill SKILL.md files (self, prior M5 steps) | Self-authored | No external sources absorbed |

---

공개적으로 작업하고 공유해주신 위 모든 분들께 다시 한번 진심으로 감사드린다.
새로운 흡수가 있을 때마다 이 목록을 갱신한다.
