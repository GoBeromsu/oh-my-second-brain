---
slug: ADR-005-graph-access-model
title: "그래프 접근 모델 — 엣지 계층 · 운영 모드 · MCP tools"
status: Proposed
date: 2026-06-13
created_by: claude-code
deciders: [beomsu]
relates_to:
  - ./ADR-002-vector-embedding-backend.md
  - ./ADR-003-oms-vault-convention-asset.md
  - ../exec-plan/active/self-owned-second-brain/spec.md §10
---

# ADR-005: 그래프 접근 모델 — 엣지 계층 · 운영 모드 · MCP tools

## Status

Proposed

## Date

2026-06-13

## Context

현재 oms 그래프 레이어의 확인된 결함:

`src/graph/cache.ts`는 wikilink 값을 가진 frontmatter 필드(`up`, `moc`, `related`, `project`, `author`, `participants`, `source`, `index`, `review` 등)를 `axis:up:value:[[note-title]]` 형태의 opaque 문자열로 저장한다. 이 값들은 실제 노트-투-노트 엣지로 해석(resolve)되지 않는다. 그 결과:

- frontmatter에 `up: [[ParentNote]]`가 있어도 그래프에서 `ParentNote`로 가는 엣지가 생성되지 않는다.
- 그래프는 `[[wikilink]]` 본문 링크와 backlink만 포함하며, frontmatter가 표현하는 계층·맥락 관계는 누락된다.
- `oms_graph_build`는 이 frontmatter relation을 무시한 채 그래프를 빌드한다.

이는 vault의 핵심 구조 정보를 그래프에서 잃는 결함이다. 단일 최대 임팩트 수정이다.

또한 그래프 접근에는 두 가지 서로 다른 UX 요구가 있다: (a) 전체 vault를 분석하는 캐싱 모드, (b) 특정 노트 주변을 빠르게 탐색하는 실시간 모드. 기존 구현은 (a)만 지원한다.

spec §10의 온톨로지 3층 전략은 L-fine(emergent) 층이 그래프 커뮤니티 감지를 통해 드러나야 한다고 명시한다. 이를 위해서는 신뢰할 수 있는 엣지 모델이 선행되어야 한다.

## Decision

### 1. Frontmatter Relation — 실제 엣지로 해석

wikilink 값을 가진 frontmatter 필드를 실제 노트-투-노트 엣지(`frontmatter-relation` type)로 해석(resolve)한다.

대상 필드: `up`, `moc`, `related`, `project`, `author`, `participants`, `source`, `index`, `review` 및 `[[...]]` 패턴을 값으로 갖는 모든 frontmatter 필드.

구현 변경 대상: `src/graph/cache.ts` — opaque 문자열 저장에서 resolve된 엣지 생성으로 교체.

### 2. 4-tier 가중 엣지 모델

| Tier | 엣지 타입 | 가중치 | 설명 |
|------|---------|--------|------|
| **T1** | `frontmatter-relation` | 1.0 | `up`/`moc`/`related` 등 frontmatter wikilink resolve. 명시적 계층·맥락 관계. |
| **T2** | `shared-property-cohesion` | 0.7 | 동일 `moc`/`project`/`tags` 값 공유. cohesion 신호. |
| **T3** | `body-wikilink` + `backlink` | 1.0 | 본문 `[[wikilink]]` 및 backlink. 직접 인용 참조. |
| **T4** | `semantic-similarity` | cosine 스코어 기반 | 벡터 코사인 > 0.8인 크로스-폴더 non-redundant 쌍. optional. |

T4(시맨틱 유사도)는 ADR-002 벡터 엔진이 구축된 이후에 추가한다. T1–T3는 벡터 엔진 없이 구축 가능하다.

### 3. 두 가지 운영 모드

#### 모드 (a) — Cached Full-Graph

- **빌드 시점**: `embed`/`sync` 실행 시 벡터 인덱스와 **동시에** 빌드. 단일 content-hash 스캔에서 두 인덱스를 함께 생성한다(ADR-002 통합 embed 결정 참조).
- **저장 위치**: pgvector DB 내 graph 테이블
- **용도**: 커뮤니티 감지, god-node 분석, 전체 vault 클러스터링, 경로 탐색
- **특성**: 빌드 비용 있음. 대규모 분석에 적합.

#### 모드 (b) — Live Sparse Local-Graph

- **빌드 시점**: MCP 쿼리 시 on-demand 계산. 빌드 단계 없음.
- **범위**: 요청 노트를 기점으로 1–2 hop — backlinks + inline wikilinks + frontmatter links + 노트 이름 매칭
- **용도**: Obsidian-style 실시간 그래프 탐색, 단일 노트 컨텍스트 확인, 최신 상태 필요 시
- **특성**: 항상 최신. 구현 대상: `src/graph/explore.ts`.

두 모드는 동등한 1급 기능이다. "실시간 그래프 쿼리"는 모드 (b)가 답하고, "vault 전체 분석"은 모드 (a)가 답한다.

### 4. MCP Tools (additive — oms server 기존 도구 보존)

`src/mcp/server.ts`에 다음 도구를 추가한다. 모두 cwd-독립, `OMS_VAULT` 기준 동작.

| Tool | 설명 |
|------|------|
| `oms_graph_neighbors(depth)` | 지정 노트의 N-hop 이웃 노드 반환 |
| `oms_graph_traverse` | BFS/DFS 그래프 순회 |
| `oms_graph_subgraph` | 노드 집합의 induced subgraph 반환 |
| `oms_graph_shortest_path` | 두 노트 사이의 최단 경로 |
| `oms_graph_cluster` | Louvain community detection (진단 전용) |
| `oms_graph_god_nodes` | 고 연결도 허브 노드 식별 |
| `oms_graph_explain` | 두 노트의 연결 관계 자연어 설명 |

`oms_graph_cluster`는 **진단·시각화 전용**이다. vault 구조 자동 변경이나 페이지 자동 생성에 사용하지 않는다.

### 5. 온톨로지 mid-layer 및 커뮤니티

T1/T2/T3 엣지 위의 Louvain community detection이 spec §10 L-fine(emergent) 층을 드러낸다. 커뮤니티 경계가 taxonomy.yaml L-coarse 폴더 경계와 교차하는 지점이 새로운 연결 패턴의 신호다. 이 신호는 사람이 읽고 판단하며, 자동 재구성에 사용하지 않는다.

## Alternatives considered

### (A) Frontmatter를 opaque 문자열로 유지 — 기각

현재 상태. frontmatter가 표현하는 계층·맥락 관계가 그래프에서 누락된다. vault 핵심 구조 정보를 잃는 명백한 결함. 기각.

### (B) Cached Full-Graph만 지원 — 기각

on-demand live-graph 없이 빌드 결과만 제공하는 방식. 단일 노트 주변을 빠르게 탐색하는 UX 요구를 충족하지 못한다. 빌드 없이 최신 정보가 필요한 경우(노트 작성 직후 확인 등)에 대응 불가. 기각.

### (C) 4-tier를 단일 가중치로 단순화 — 보류

모든 엣지를 동일 가중치로 처리. 구현은 단순하지만 frontmatter 관계(T1)와 본문 wikilink(T3)의 의미 차이가 사라진다. 초기 구현에서는 허용하되, 설계 목표는 tier 분리 유지다.

## Consequences

### Enables

- frontmatter 계층(`up`, `moc` 등)이 그래프 탐색에 반영됨 — vault 구조의 완전한 그래프 표현
- on-demand 실시간 탐색으로 Obsidian-style 노트 컨텍스트 즉시 확인
- community detection으로 spec §10 L-fine emergent 온톨로지 층 실현
- 벡터 인덱스와 그래프가 단일 `embed` 명령으로 동기화 유지 (ADR-002)

### Costs / trade-offs

- `src/graph/cache.ts` 리팩토링 필요 — wikilink resolve 로직 추가
- T4(시맨틱 유사도) 엣지는 ADR-002 벡터 엔진 구축 이후에 추가 가능
- `oms_graph_cluster` 진단 전용 제한으로 자동화 활용 범위가 좁음 (의도적)

### New constraints

- `oms_graph_cluster`는 진단 전용이다. vault 구조 자동 변경에 사용하지 않는다.
- T4 엣지는 코사인 유사도 > 0.8 **and** 크로스-폴더 조건을 모두 만족해야 추가한다.
- 모드 (b) live local-graph는 1–2 hop 이내로 제한한다. 깊은 탐색은 모드 (a)를 사용한다.
- 변경 대상 파일: `src/graph/cache.ts`, `src/graph/explore.ts`, `src/mcp/server.ts`.

---

## 리서치 검증 (보강: 2026-06-13)

출처: [docs/research/graph-retrieval-accuracy-design.md](../research/graph-retrieval-accuracy-design.md) — 105-agent / 2.6M-token adversarial deep-research.

### 검증된 정당화

- **Frontmatter/wikilink 메타데이터 엣지의 고정밀 근거**: LightRAG(GitHub issue 2025-08)와 HippoRAG 모두 wikilink·frontmatter 같은 pre-existing 메타데이터를 native하게 ingest하지 않는다. 이들은 raw text에서 LLM OpenIE 파이프라인으로만 그래프를 구축한다. Obsidian vault의 wikilink·frontmatter는 이미 고정밀 엣지이므로, LLM 추출 없이 이를 typed high-confidence link로 직접 사용하는 우리 frontmatter-first·무LLM-추출 전략은 비용 면에서 정당하다(vote 3-0).

- **그래프 레이어의 핵심 가치 — Multi-hop**: Personalized PageRank(PPR)와 spreading activation 메커니즘은 lexical/semantic으로는 가깝지 않지만 topically 연결된 문서를 surface한다(vote 3-0). 이것이 그래프 레이어를 vector 검색 위에 추가하는 핵심 근거다.

- **RRF(k=60) graph+vector 융합 외부 검증**: 2025-07 practical-scale GraphRAG에서 1-hop graph traversal 결과와 dense vector 검색을 RRF k=60으로 병합하는 패턴이 독립적으로 확인됐다(vote 3-0). ADR-002의 RRF(k=60) 결정이 graph 결과 융합까지 그대로 확장된다.

### 수정 필요 사항

**(a) Community detection 알고리즘**: §4 `oms_graph_cluster`의 Louvain을 **hierarchical Leiden(Traag 2019)**으로 업그레이드하는 경로를 명시한다. Leiden은 Louvain과 달리 well-connected community를 수학적으로 보장(MECE partition)한다. 진단 전용 제한은 유지한다.

**(b) 4-tier 엣지 가중치는 휴리스틱**: §2의 가중치 테이블(T1: 1.0 / T2: 0.7 / T3: 1.0 / T4: cosine > 0.8)은 검증된 closed-form 공식이 아닌 초기 휴리스틱이다. 이종 엣지 타입의 최적 가중·정규화 공식은 미해결 설계 문제([open question #1](../research/graph-retrieval-accuracy-design.md))이며, ablation으로 보정해야 한다.

### 추가 설계 입력

**Information overload가 multi-hop의 #1 실패모드**: 이웃이 지수적으로 팽창해 무관 콘텐츠가 대량 유입된다(vote 3-0). 모드 (b) live sparse local-graph의 1–2 hop 제한이 이를 억제하지만, multi-hop 확장 시 active pruning 정책이 필요하다. 확인된 전략: PathRAG flow-based path filtering, MS GraphRAG LLM-rated subtree pruning. pruning 정책은 graph traversal 깊이를 늘리기 전에 먼저 설계해야 한다.
