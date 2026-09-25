---
slug: ADR-004-search-backend-and-reranking
title: "검색 백엔드·리랭킹 — 좁은 SearchBackend seam, 단일 정규화, opt-in 리랭크"
status: Accepted
date: 2026-09-24
created_by: claude
deciders: [beomsu]
supersedes:
  - 구 ADR-010
  - 구 ADR-011
supersedes_in_part:
  - 구 ADR-012#D4
  - 구 ADR-012#D5
relates_to:
  - ./ADR-001-vault-resolution-link-note-identity.md
  - ./ADR-003-local-index-storage-and-fusion.md
  - ./ADR-005-embedding-model-contract-integrity-lifecycle.md
  - ./ADR-006-graph-access.md
  - ./ADR-009-cross-cutting-principles.md
---

# ADR-004: 검색 백엔드·리랭킹

## Status

Accepted (2026-09-24). 구 ADR-010과 구 ADR-011 전체를 대체한다. 구 ADR-012 D4 전체와 D5의 HyDE·Passthrough 부분도 흡수한다.

## Context

MCP `search`는 한 개의 backend 인터페이스 뒤에서 in-repo 엔진을 호출한다. 리랭킹은 비싸고 모델이 필요하므로 명시적으로 요청할 때만 돈다. 세 ADR에 흩어진 규칙을 현재 코드 기준으로 하나로 모은다.

- 구 ADR-010 D3은 qmd backend를 선택적·명시적으로 고를 수 있다고 했지만, 구현에는 `EngineSearchBackend` 하나뿐이다. qmd backend 구현도 backend 선택 env/config도 없다 (`src/kernel/searchbackend/engine-search-backend.ts:39`, `src/mcp/server.ts:503,793,826`).
- 구 ADR-011은 production 시작 시 Reranker를 조립하지 않는다고 했지만, 구현의 assembly는 항상 lazy owned reranker를 만든다. 실제 모델은 첫 리랭크 요청 때 rerank capability를 해석해 만든다 (`src/kernel/engine/assemble.ts:317-345`).

## Decision

### 1. 좁은 seam: `SearchBackend.search(request)` 하나 (`src/kernel/searchbackend/search-backend.ts`)

- 인터페이스는 `search(request): Promise<McpSemanticQueryResult>` 한 메서드다 (`search-backend.ts:234-236`).
- 유일한 구현은 `EngineSearchBackend`이고, MCP 서버가 직접 생성한다 (`engine-search-backend.ts:39`, `server.ts:503,793,826`).
- backend 교체는 이 seam에 새 구현을 추가하는 것으로만 한다. 암묵적 fallback 선택은 없다.

### 2. 요청 정규화는 `normalizeSearchRequest` 한 곳에서만 (`search-backend.ts:70-223`)

- 기본값과 검증을 이 함수가 단독으로 결정한다.
- expand 전략 profile은 `qmd-v2.8.3`만 받는다. `maxQueries`는 1~32다.
- `rerank`의 기본값은 `false`다 (`search-backend.ts:221`). MCP schema도 같은 기본값을 선언한다 (`server.ts:166`).
- 임베딩이 필요한 요청인지는 `requiresEmbeddings` 한 곳에서 판정한다 (`engine-search-backend.ts:24-37`).

### 3. modality 실패는 조용히 대체하지 않는다 (`src/kernel/engine/retrieval/dispatcher.ts:250-340`)

- lex는 `queryLex`를 호출한다. vec는 query를 임베딩한 뒤 `queryVec`를 호출한다.
- HyDE는 expand가 준 문서를 그대로 쓰거나 generator가 있어야 한다. 둘 다 없으면 generate·embed env pair와 `.oms/settings.json`의 `embedding.model`을 안내하며 throw한다 (`dispatcher.ts:294-303`). generator 출력이 비었거나 query를 그대로 반복하면 거부한다 (`dispatcher.ts:155-169`).
- graph sub-query는 traversal이 연결되지 않았으면 throw한다. depth 기본값은 2다 (→ ADR-006).
- expand 전략에서 vec 불가나 expander 부재는 capability guidance가 담긴 unavailable 결과가 된다 (`src/kernel/engine/mcp/facade.ts:650-683`).

### 4. 리랭킹은 opt-in이고, 요청했는데 못 하면 실패다 (`facade.ts`)

- `rerank:true`인데 reranker가 없으면 `capabilityGuidance("rerank")`로 unavailable을 돌려준다. 자연어 query가 비어 있어도 unavailable이다 (`facade.ts:549-556`, `:744-760`).
- lazy reranker가 모델 해석에 실패하면 `retrieve` 안에서 throw한다. facade의 catch가 이를 unavailable로 바꾼다 (`facade.ts:764`, `:812`). 결과 계약은 → ADR-009.
- 순서는 후보 → rerank → minScore → facets → pagination이다 (`facade.ts:575-577`). lexical 경로의 리랭크는 각 파일 앞 16,384자를 읽는다 (`facade.ts:557-573`).
- 결과의 `rerankApplied`는 실제 적용 여부를 반영한다 (`engine-search-backend.ts:~184-209`).

### 5. assembly가 production reranker 수명을 소유한다 (`assemble.ts`, `src/kernel/engine/retrieval/reranker.ts`)

- 주입받은 `reranker`는 호출자가 소유한다. assembly는 자신이 만든 것만 소유한다. `reranker`와 test seam인 `rerankerFactory`는 동시에 줄 수 없다 (`assemble.ts:114-121`).
- owned reranker는 `LazyOwnedReranker`다. 첫 non-empty 요청 때 rerank capability를 해석해 `createLlamaReranker({modelPath})`를 만든다. 해석이 안 되면 guidance로 throw한다 (`assemble.ts:317-345`, `reranker.ts:270-373`).
- dispose는 generator → reranker → provider → store close 순서로 정확히 한 번 한다 (`assemble.ts:523-541`, `reranker.ts:193-208`, `:342-346`).
- rerank 모델 해석 우선순위는 → ADR-005.

### 6. `LlamaReranker` 동작 (`reranker.ts`)

- 후보는 `DEFAULT_RERANKER_CANDIDATE_CAP=50`개로 자른다 (`reranker.ts:70`, `:215-258`).
- chunk text가 필수다. path만 있는 후보는 거부한다. score 개수가 후보 수와 같은지, 모든 score가 finite인지 검사한다.
- 반환은 cap 안의 후보를 정렬한 것만이다.

### 7. 가짜 성공 금지: Passthrough는 production에 없다 (`reranker.ts:380-388`, `src/kernel/engine/retrieval/index.ts:12-30`)

- production barrel은 Passthrough를 export하지 않는다. no-op reranker는 `passthrough.test-helper.ts`에만 있다.
- identity HyDE(query를 그대로 쓰는 기본 generator)도 없다 (§3).

### 8. 도입하지 않는 것 (구 ADR-010 D4 유지)

versioned backend schema, trust store, lockfile, firewall, backend registry는 두지 않는다. 코드에도 없다.

### 미결

- qmd backend를 다시 제공할지, 제공한다면 어떤 명시적 선택 표면(env/config)을 쓸지는 정하지 않았다. 현재 코드에는 선택 메커니즘이 없다.
- cap 50을 넘는 후보를 버리는 동작(§6)이 페이지네이션 기대와 맞는지는 검토하지 않았다.

## Alternatives Considered

- **qmd를 기본 backend로** (구 ADR-010 원안 대안) — 기각했다. in-repo 엔진이 유일한 구현이다.
- **rerank 기본 on** — 기각했다. 모델 로딩 비용이 크고, 모델이 없으면 묵시적 degradation이 생긴다.
- **reranker 없으면 fused 순서를 그대로 성공으로 반환(Passthrough)** — 기각했다. 요청한 기능이 적용되지 않았는데 성공으로 보고하게 된다.
- **startup에서 reranker eager 로딩** — 기각했다. lazy 생성만 허용한다.

## Consequences

- `rerank:true`는 모델이 없으면 항상 unavailable이 되고, 이유가 명시된다. 호출자가 결과가 좋아졌다고 오인하지 않는다.
- 리랭크 결과는 최대 50개다. 51위 이하 후보는 결과에서 빠진다.
- backend가 하나뿐이라 seam 테스트는 `EngineSearchBackend`만 대상으로 한다.

## 흡수 내역

| 기존 조항 | 처리 |
|---|---|
| 구 ADR-010 D1 좁은 seam | §1 |
| 구 ADR-010 D2 in-repo 엔진 기본 | §1 (유일 구현) |
| 구 ADR-010 D3 qmd optional·명시적·loud failure | 원칙은 §1 "암묵적 fallback 없음"에 유지. qmd 구현 부재 → 미결 |
| 구 ADR-010 D4 제외 목록 | §8 |
| 구 ADR-010 fallback 순서 서술(vault 해석) | → ADR-001 |
| 구 ADR-010 Alternatives (A)~(D) | Alternatives Considered |
| 구 ADR-011 rerank 기본 false | §2, §4 |
| 구 ADR-011 reranker 없이 rerank:true는 실패 | §4 |
| 구 ADR-011 MCP schema·정규화가 기본값 적용 | §2 |
| 구 ADR-011 Context "production은 Reranker 미조립" | 폐기: lazy owned reranker로 대체 → §5 |
| 구 ADR-012 D4 assembly의 reranker 수명 소유 | §5 |
| 구 ADR-012 D5 Identity HyDE 제거 | §3, §7 |
| 구 ADR-012 D5 Passthrough-as-success 제거 | §7 |
| 구 ADR-012 D5 runtime 다운로드 금지·lexical 기본 | → ADR-005 |
