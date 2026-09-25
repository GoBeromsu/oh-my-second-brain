---
slug: ADR-006-graph-access
title: "그래프 접근 — axis-seed 1-hop 로컬 이웃, cache 또는 headless scan"
status: Accepted
date: 2026-09-24
created_by: claude
deciders: [beomsu]
supersedes:
  - 구 ADR-005
supersedes_in_part: []
relates_to:
  - ./ADR-001-vault-resolution-link-note-identity.md
  - ./ADR-002-config-secrets-host-state-roots.md
  - ./ADR-003-local-index-storage-and-fusion.md
  - ./ADR-004-search-backend-and-reranking.md
  - ./ADR-007-template-contract-sealed-two-layer.md
  - ./ADR-008-taxonomy.md
  - ./ADR-009-cross-cutting-principles.md
---

# ADR-006: 그래프 접근

## Status

Accepted (2026-09-24). 구 ADR-005(Proposed)를 대체한다. 이 문서가 그래프 접근의 유일한 기준이다.

## Context

그래프 접근은 기존에 구 ADR-005 하나만 다뤘고, 그마저 Proposed 상태였다. 이후 구현은 구 ADR-005와 다른 방향으로 갔다. 아래는 현재 코드 기준이다.

- 구 ADR-005는 pgvector 기반 semantic cosine 엣지를 포함한 4-tier(T1–T4) 가중 엣지라고 했지만, 구현은 pgvector도 semantic 엣지도 없다. 엣지는 `wikilink`/`frontmatter`/`unknown-ref`/`adamic-adar`/`type-affinity` 다섯 종류다(`src/kernel/engine/graph/builder.ts`).
- 구 ADR-005는 "cached full-graph"와 "live 1–2 hop" 두 운영 모드라고 했지만, 구현은 단일 mode `axis-seed-local-neighborhood` 하나이고, 이것이 cache 또는 headless scan으로 동작한다(`src/kernel/graph/explore.ts`).
- 구 ADR-005는 7개의 additive MCP graph tool(neighbors, traverse, subgraph, shortest_path, cluster, god_nodes, explain)이라고 했지만, 구현에 그런 도구는 없다. 공개 표면은 graph build/status와 `search {op:"context"}` 뿐이다(`src/mcp/server.ts:175-178`).
- 구 ADR-005는 Louvain/Leiden 커뮤니티와 taxonomy.yaml L-coarse 계층이라고 했지만, 구현에는 클러스터링이 없고 taxonomy.yaml은 읽히지 않는다(→ ADR-008).

## Decision

### 1. 단일 탐색 모드: axis-seed local neighborhood

`exploreLocalGraph`는 항상 `mode: "axis-seed-local-neighborhood"`와 `bodyPolicy: "lazy-load"`를 반환한다(`src/kernel/graph/explore.ts:88-120`). 전체 그래프 순회 API는 공개하지 않는다.

### 2. Seed 선택

Seed는 axis 필터(template, folder, property/value, wikilink)로 고른다(`filterNodesByAxis`). 정렬은 query lexical overlap(`searchScore`)이 먼저이고, 동점이면 path 순이다. 개수는 `clamp(limit ?? 5, 1, 50)`이다(`src/kernel/engine/graph/explore.ts`). axis 값의 의미는 → ADR-007(템플릿 계약)과 ADR-008(taxonomy global axis)가 소유한다.

### 3. 이웃은 정확히 1-hop, 세 가지 reason

이웃이 되는 reason은 세 가지다: `property-value`(axis 값 공유), `wikilink`(outgoing), `backlink`(incoming). 탐색에는 `kind === "wikilink"`이고 `weight > 0`인 엣지만 쓴다. 이웃 정렬은 reason 수, score, path 순이다. 개수는 `clamp(maxNeighbors ?? 10, 0, 100)`이다(`src/kernel/engine/graph/explore.ts`).

### 4. 그래프 빌드와 엣지 종류

`buildGraphWithWarnings`가 만드는 엣지는 다음과 같다(`src/kernel/engine/graph/builder.ts:240-300`).
- `wikilink`: weight 3, 본문 링크에서 온다.
- `frontmatter`: weight 4, `sources`/`relations` 키에서만 온다.
- `unknown-ref`: weight 0, 해석되지 않은 링크다.
- `adamic-adar`: score×1.5다.
- `type-affinity`: weight 1이다. 같은 template 그룹에서 생기며, 그룹 크기 상한은 `TYPE_AFFINITY_MAX_GROUP=64`이고 넘으면 warning을 낸다. `OMS_TYPE_AFFINITY_UNBOUNDED=1`로 상한을 해제한다.

소스 노트는 managed-source exclusion을 적용하고 `ensureInside`로 vault confinement를 적용한 뒤 읽는다. 링크 해석과 노트 identity는 → ADR-001이 소유한다.

### 5. Cache는 파생물이며 vault 밖에 둔다

graph와 node cache의 위치는 다음과 같다(`src/kernel/engine/paths.ts:137-143`).
- `<vaultCacheRoot>/engine/graph.json`
- `<vaultCacheRoot>/engine/node-index.json`

`assertExternalCachePath`가 vault 밖 경로임을 보장한다. cache root 위치 자체는 → ADR-002/ADR-003가 소유한다. cache는 `CACHE_VERSION=3`/`NODE_CACHE_VERSION=4`와 projection digest(`meta.digest`)로 무효화된다. digest에는 taxonomy bytes가 포함된다(→ ADR-008).

### 6. Cache를 쓰는 곳은 명시적 build 하나

cache를 쓰는 곳은 `buildGraph`(`src/kernel/engine/mcp/facade.ts:1097-1103`)뿐이다. 도달 경로는 다음 두 가지다.
- CLI `oms graph build` (`src/cli/graph-command.ts`)
- MCP `doctor {op:"build-graph"}` (`src/mcp/server.ts:178`)

`exploreLocalGraph`는 두 cache가 모두 hit일 때만 `provider: "cache"`를 반환한다. 하나라도 miss이거나 `useCache: false`이면 메모리에서 `headless-scan`으로 빌드하고, cache를 저장하지 않는다(`src/kernel/graph/explore.ts:88-120`).

### 7. 본문은 lazy-load, 읽기 전용

`lazyLoadNoteBody`는 vault 안 노트 본문만 읽는다. vault 밖으로 해석되는 경로는 throw한다. 파생 상태는 만들지 않는다(`src/kernel/graph/cache.ts`).

### 8. 공개 표면

| 기능 | MCP | CLI |
|---|---|---|
| 탐색 | `search {op:"context"}` → `retrieveMorningContext`가 seed(`oms-seed`)·neighbor(`oms-neighbor`)·semantic hit를 합친다(`src/kernel/search/morning.ts:263-275`, `src/mcp/server.ts:728-761`) | `oms search context --max-neighbors --[no-]use-cache` (`src/cli/search.ts:156-158`) |
| 상태 | `status {op:"graph"}` → `graphStatus`. 오류 시 null status를 반환하고 throw하지 않는다(`facade.ts:1113-1125`) | `oms graph status` |
| 빌드 | `doctor {op:"build-graph"}` | `oms graph build` |

semantic hit와 검색 융합은 → ADR-003/ADR-004이 소유한다.

### 미결

- `src/kernel/engine/graph/traverse.ts`의 BFS/DFS 순회(default depth 2, score `1/(1+d)`)는 `runTracer`(`src/kernel/engine/tracer.ts:177-250`)만 사용한다. 이 순회의 "community" mode는 BFS로 fallback한다(line 137). `runTracer`를 부르는 비테스트 코드는 없다. 유지할지 제거할지 결정되지 않았다.
- `frontmatter`/`adamic-adar`/`type-affinity` 엣지는 빌드되지만 explore(§3)에서는 쓰이지 않는다. 이 엣지들의 소비처가 정해지지 않았다.
- frontmatter 엣지 키 `sources`/`relations`가 코드에 고정돼 있다. 이는 ADR-009 §3(하드코딩 금지)과 긴장 관계다.
- 그래프 모듈은 정렬에 `localeCompare`를 쓰고, 다른 모듈은 code-point 순서를 쓴다(ADR-009 §5). 둘을 통일할지 정해지지 않았다.
- explore가 miss 때 cache를 저장하지 않는 것(§6)이 의도된 설계인지 문서화된 근거가 없다.

## Alternatives Considered

- **구 ADR-005의 full-graph 7-tool 표면**: 기각했다. 구현되지 않았고, agent가 필요한 것은 axis로 좁힌 이웃 문맥이었다.
- **pgvector semantic 엣지**: 기각했다. 로컬 인덱스는 sqlite-vec이며(→ ADR-003), semantic 근접은 그래프 엣지가 아니라 검색 hit로 합친다.
- **explore 중 cache 자동 저장**: 채택하지 않았다. 쓰기는 명시적 build로 한정한다. 조회 경로는 파생 상태를 만들지 않는다(ADR-009 §4).

## Consequences

- 그래프는 조회 시점에 cache가 없어도 headless scan으로 항상 동작한다. 대신 큰 vault에서는 매 호출마다 빌드 비용이 든다.
- 템플릿 계약이나 taxonomy가 바뀌면 digest가 달라지고, 이전 cache는 자동으로 miss 처리된다.
- 새 graph MCP 도구를 추가하려면 새 ADR이 필요하다.

## 흡수 내역

| 기존 조항 | 이 ADR |
|---|---|
| 구 ADR-005 §1 Frontmatter relation → 실제 엣지 | §4 (`sources`/`relations`만, weight 4). 일반화는 미결 |
| 구 ADR-005 §2 4-tier 가중 엣지 | §4로 대체. 폐기: semantic cosine T4는 구현 없음 |
| 구 ADR-005 §3 두 운영 모드 | §1·§6으로 대체(단일 mode, cache 또는 headless) |
| 구 ADR-005 §4 MCP tools 7종 | 폐기: 구현 없음. 실제 표면은 §8 |
| 구 ADR-005 §5 온톨로지 mid-layer·커뮤니티 | 폐기: 클러스터링 없음. taxonomy는 → ADR-008 |
| 구 ADR-005 Alternatives (A)/(B)/(C) | 폐기: 전제(두 모드·4-tier)가 사라짐 |
| 구 ADR-005 리서치 검증 절 | 폐기: pgvector 전제 기반 |
