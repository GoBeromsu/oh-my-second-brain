---
title: "Self-owned 검색 엔진 설계 레퍼런스 — qmd·gbrain 흡수 및 pgvector 아키텍처 옵션 조사"
slug: retrieval-engine-design-references
status: draft
date: 2026-06-13
created_by: claude-code
type: research
relates_to:
  - docs/decisions/ADR-002-vector-embedding-backend.md
  - docs/decisions/ADR-004-config-secrets-access-topology.md
  - docs/decisions/ADR-005-graph-access-model.md
  - docs/exec-plan/active/self-owned-second-brain/spec.md §6
---

# Self-owned 검색 엔진 설계 레퍼런스 — qmd · gbrain 흡수 및 pgvector 아키텍처 옵션 조사

> 목적: 자체 소유 검색 + 그래프 엔진 구축을 위해 qmd와 gbrain의 설계를 흡수하는 과정에서 도출된 사실과 옵션을 정리한다.
> 이 문서는 **사실 · 옵션 · 트레이드오프**를 제시하며, 결정을 선언하지 않는다.
> 결정은 [ADR-002](../decisions/ADR-002-vector-embedding-backend.md), [ADR-004](../decisions/ADR-004-config-secrets-access-topology.md), [ADR-005](../decisions/ADR-005-graph-access-model.md)에 기록한다.

---

## Summary

qmd(로컬 하이브리드 검색 스택)와 gbrain(pgvector 기반 증분 sync 아키텍처)의 설계를 분석해 자체 소유 second-brain 검색 엔진 구축을 위한 사실을 수집했다. 현재 oms 내장 임베더의 세 가지 치명적 약점(64-dim SHA1 해시 · 청킹 없음 · 전체 재작성 sync)을 코드 감사로 확인했으며, Upstage Solar 4,096-dim과 pgvector HNSW `halfvec` 4,000-dim 한계의 충돌이 임베더 선택 설계의 핵심 제약으로 확인됐다.

---

## Background

약 20,000개 Obsidian 노트(Ataraxia vault)를 의미 검색하는 엔진이 필요하다. spec §6이 임베딩 백엔드 요건을 최초로 기술한다. 두 가지 외부 구현체가 이 조사의 주요 참조다:

- **qmd**: 사용자 vault에서 22,474개 문서로 실증 운영 중인 로컬 하이브리드 검색 스택.
- **gbrain**: pgvector HNSW 스키마 + atomic-state + advisory-lock 증분 sync 아키텍처. 도구 자체는 미사용이며 로직만 흡수한다([ACKNOWLEDGMENTS.md](../../ACKNOWLEDGMENTS.md) 참조).

---

## Findings

### A. qmd 설계 (DB 검사로 확인)

| 항목 | 값 |
|------|-----|
| 임베딩 모델 | Qwen3-Embedding-0.6B |
| 벡터 차원 | 1,024-dim |
| 유사도 메트릭 | cosine |
| 청킹 단위 | ~1,300자 |
| 어휘 검색 엔진 | BM25 FTS5 (porter + CJK 토크나이저) |
| 벡터 인덱스 | sqlite-vec (vec0) |
| 검색 모드 | lex(BM25) / vec(벡터) / hyde(가상 문서) |
| reranker | Qwen3-Reranker |
| 증분 sync 방식 | content-hash 기반 변경분만 처리 |
| 실행 환경 | 100% 로컬 (llama.cpp) |

qmd는 단일 SQLite 파일로 FTS5 BM25 어휘 검색, 1,024-dim 벡터 검색, HyDE 가상 문서 확장 검색을 하이브리드로 제공한다. MCP 전역 검색 표면(`lex`/`vec`/`hyde` sub-query 조합)이 22,474개 문서 규모에서 실증됐다.

### B. oms 현재 임베더 약점 (코드 감사로 확인)

파일: `src/search/semantic-embedding-hash.ts`, `src/search/semantic-sync.ts`

| 약점 | 상세 |
|------|------|
| **64-dim SHA1 해시 임베더** | neural embedding이 아닌 결정론적 해시. 의미 유사도를 포착하지 못한다. |
| **청킹 없음** | 노트 전체를 단일 벡터로 처리. 긴 노트(수천 자)에서 임베딩 품질이 저하된다. |
| **전체 재작성 sync** | `semantic-sync.ts`는 매 sync마다 전체 색인을 재생성한다. 20k 노트 규모에서 비용이 과다하다. |
| **스케일-불일치 퓨전 가중치** | `lexical * 0.52 + vector * 0.48` 선형 혼합. BM25와 코사인 유사도는 스케일이 달라 결과 편향 가능성이 있다. |

> `TODO(verify)`: `semantic-embedding-hash.ts` 코드를 재확인해 정확한 해시 알고리즘과 차원 수를 재검증할 것.

### C. gbrain 로직 흡수 대상

gbrain 도구 자체는 사용하지 않는다([ACKNOWLEDGMENTS.md](../../ACKNOWLEDGMENTS.md), [ADR-002](../decisions/ADR-002-vector-embedding-backend.md) 탈종속 단서 참조). 아키텍처 로직만 흡수한다.

| 흡수 항목 | 내용 |
|-----------|------|
| pgvector HNSW 스키마 | `documents` / `chunks` / `chunk_embeddings` 3-테이블 구조 |
| atomic-state sync | 색인 상태를 단일 원자값으로 추적하는 증분 색인 패턴 |
| pg advisory lock | `pg_advisory_lock()` — crash 시 자동 해제, concurrent sync 방지 |
| 3-stage 파이프라인 | 파싱 → 청킹 → 임베딩 각 단계 분리 |
| 상용 임베딩 API 통합 | env 기반 API 키 관리 + ignore glob 제외 |

> `TODO(verify)`: gbrain 원 저자 및 repo URL 미확인([ACKNOWLEDGMENTS.md](../../ACKNOWLEDGMENTS.md) `TODO(verify)` 목록 참조).

### D. pgvector HNSW 차원 제한

상세 수치 원문: [`references/pgvector-hnsw-dimension-limits.md`](./references/pgvector-hnsw-dimension-limits.md)

| 타입 | HNSW 인덱스 최대 차원 | 스토리지 전용 최대 차원 |
|------|--------------------|---------------------|
| `vector` | **2,000** | 16,000 |
| `halfvec` | **4,000** | 16,000 |
| `bit` | **64,000** | — |
| `sparsevec` | 1,000 (비-zero 원소 수) | — |

HNSW 기본 파라미터: `m=16`, `ef_construction=64`, `ef_search=40`.
이론적 근거: [`references/hnsw-paper-malkov-yashunin.md`](./references/hnsw-paper-malkov-yashunin.md) — 로그 복잡도 스케일링, 지수 감소 확률 레이어 배정(Malkov & Yashunin, IEEE TPAMI 2020).

### E. Upstage Solar 비대칭 임베딩과 차원 충돌

상세 수치 원문: [`references/upstage-solar-embedding-api.md`](./references/upstage-solar-embedding-api.md)

| 항목 | 값 |
|------|-----|
| 인덱싱(문서) 모델 | `solar-embedding-1-large-passage` |
| 쿼리 모델 | `solar-embedding-1-large-query` |
| 벡터 차원 | **4,096** |
| 최대 컨텍스트 | 4k tokens |
| 권장 입력 길이 | ≤512 tokens (soft 권장; hard limit은 4k) |
| 유사도 메트릭 | cosine |

**충돌**: Solar 4,096-dim **>** `halfvec` HNSW 한계 4,000-dim **>** `vector` HNSW 한계 2,000-dim.
Solar 벡터는 `vector` 타입도, `halfvec` 타입도 HNSW 인덱싱이 불가하다.

**비대칭 구조**: 인덱스 시점에는 `passage` 모델, 쿼리 시점에는 `query` 모델을 호출해야 한다. 동일 벡터 공간 내에서 동작하지만 두 모델은 분리된 API 엔드포인트를 사용한다. 임베더 인터페이스가 `embedDocument()` / `embedQuery()` 두 경로를 독립적으로 지원해야 한다.

### F. HNSW 불가 모델의 옵션 공간

pgvector FAQ 원문 참조([`references/pgvector-hnsw-dimension-limits.md`](./references/pgvector-hnsw-dimension-limits.md)):

| 옵션 | 원리 | Solar 4,096 적용 가능성 | 비고 |
|------|------|----------------------|------|
| **Binary quantization** | `bit` 타입으로 변환 → HNSW 최대 64,000-dim | 적용 가능 | 정밀도 손실. 속도 대폭 향상. |
| **Dimensionality reduction** | PCA/UMAP 등으로 차원 축소 후 인덱싱 | ≤2,000으로 축소 시 `vector` HNSW 가능 | 정보 손실. 전처리 비용. |
| **Subvector indexing** | 모델이 subvector를 지원할 경우 분할 인덱싱 | Solar subvector 지원 여부 미확인 `TODO(verify)` | — |
| **Exact scan + reranker** | 인덱스 없이 전체 스캔 → reranker 재순위 | 적용 가능 | 수만 건 규모에서 실용적. 스케일 제한. |
| **IVFFlat** | 클러스터 기반 ANN 인덱스 | 차원 제한 없음 | build 전 데이터 필요. HNSW 대비 recall 낮음. |

**사용자 실증 워크어라운드**: Solar 4,096 + exact scan + Qwen3-Reranker 조합. 현 vault 규모(~20k 노트)에서 검색 품질을 확인함.

### G. 스토리지 백엔드 옵션

#### G1. PGLite (`@electric-sql/pglite`)

WASM으로 컴파일된 PostgreSQL을 Node.js/브라우저 내 in-process로 실행한다. 서버 불필요. pgvector 내장. 단일 디렉토리에 파일 기반으로 저장. 크로스머신 sync 불가. latency는 in-process로 최저. pgvector HNSW 차원 제한은 표준 pgvector와 동일.

> `TODO(verify)`: PGLite WASM 빌드에서 HNSW 인덱스 성능 실측 데이터 없음.

#### G2. Supabase pgvector

관리형 클라우드 Postgres + pgvector. PGLite와 SQL 문법이 동일하므로 `OMS_PGVECTOR_URL` 환경변수 하나로 전환 가능. 크로스머신 sync 기본 제공. 비용 발생(free tier 있음).

#### G3. sqlite-vec (vec0)

qmd가 사용하는 방식. SQLite FTS5 + vec0 하이브리드. 단일 파일. Postgres 없이 운영. Postgres SQL 쿼리 의미론(JOIN/WHERE/서브쿼리) 제한.

> `TODO(verify)`: sqlite-vec(vec0)의 정확한 최대 차원 수 미확인.

### H. 임베더 티어 옵션

| 티어 | 대표 모델 | 차원 | HNSW 가능 | 비용 | 프라이버시 |
|------|---------|------|-----------|------|----------|
| 경량 로컬 (default 후보) | Qwen3-Embedding-0.6B | 1,024 | `halfvec` 가능 | 무료 | 완전 로컬 |
| 고품질 로컬 | EmbeddingGemma-300M | 미확인 `TODO(verify)` | 미확인 | 무료 | 완전 로컬 |
| 상용 — 비대칭 | Upstage Solar (`passage`/`query`) | 4,096 | **불가** (> 4,000) | 유료 | 텍스트 외부 전송 |
| 상용 — 대칭 | Voyage `voyage-3` | 1,024 | `halfvec` 가능 | 유료 | 텍스트 외부 전송 |
| 상용 — 대칭 | OpenAI `text-embedding-3-small` | 1,536 | `vector` 가능 | 유료 | 텍스트 외부 전송 |
| 상용 — 대칭 | OpenAI `text-embedding-3-large` | 3,072 | `halfvec` 가능 | 유료 | 텍스트 외부 전송 |

상용 모델 사용 시 노트 텍스트가 임베딩 API 서버로 전송된다. 민감 영역(일기, 주소, 연락처 등)은 `ignore_for_external_apis` glob으로 **청킹 이전 단계에서** 제외해야 한다.

### I. 검색 퓨전: 선형 혼합 vs. RRF

현재 oms의 `lexical * 0.52 + vector * 0.48`는 BM25 스코어와 코사인 유사도의 스케일이 일치한다는 가정에 의존한다. 두 스케일은 다르며 이 가정은 불안정하다.

**RRF (Reciprocal Rank Fusion, k=60)**:

```
RRF_score(d) = Σ_i  1 / (k + rank_i(d))
```

순위 기반이므로 스코어 스케일 불일치 문제가 없다. qmd, gbrain 양 구현체에서 검증된 패턴.

### J. 증분 Sync 전략 비교

| 전략 | 방식 | 문제점 |
|------|------|--------|
| 현재 oms (전체 재작성) | 매 sync마다 전체 재색인 | 20k 노트 규모에서 비용 과다 |
| content-hash 증분 (qmd 방식) | SHA256으로 변경분만 처리 | 구현 필요 |
| atomic-state + advisory-lock (gbrain 방식) | `pg_advisory_lock()` + 상태 원자 추적 | 구현 필요. crash-safe. |
| 결합 (권장) | SHA256 확인 → lock 획득 → 변경분만 임베딩 | 두 방식의 장점 결합 |

---

## Comparison

### 스토리지 백엔드 비교

| 차원 | PGLite + pgvector | Supabase + pgvector | sqlite-vec (vec0) |
|------|------------------|-------------------|-----------------|
| HNSW 차원 한계 | ≤ 4,000 (`halfvec`) | 동일 | 미확인 `TODO(verify)` |
| 풀 SQL 쿼리 (JOIN/WHERE) | 가능 | 가능 | 제한적 |
| 로컬-only 운영 | 가능 | 불가 | 가능 |
| 크로스머신 sync | 불가 | 기본 제공 | 불가 |
| 운영 복잡도 | 낮음 | 낮음 | 최저 |
| pgvector SQL 이식성 | `OMS_PGVECTOR_URL`로 전환 가능 | 동일 | 해당 없음 |

### 임베더 티어 선택 트레이드오프

| 선택 | 비용 | 프라이버시 | 품질 | HNSW 직접 인덱싱 |
|------|------|----------|------|----------------|
| 경량 로컬 (Qwen3-0.6B, 1,024-dim) | 무료 | 완전 | 중 | 가능 |
| 상용 비대칭 (Solar, 4,096-dim) | 유료 | 텍스트 외부 전송 | 최상 | 불가 |
| 상용 대칭 (Voyage/OpenAI) | 유료 | 텍스트 외부 전송 | 상 | 가능 |

---

## Open questions

- sqlite-vec(vec0)의 정확한 최대 차원 수 `TODO(verify)`
- EmbeddingGemma-300M의 정확한 차원 수 `TODO(verify)`
- Upstage Solar의 subvector indexing 지원 여부 `TODO(verify)`
- PGLite WASM 빌드에서 HNSW 인덱스 성능 실측 데이터 `TODO(verify)`
- Solar 4,096-dim을 PCA 등으로 1,024까지 축소 시 의미 검색 품질 저하 수준 `TODO(verify)`
- qmd, gbrain 원 저자 및 repo URL([ACKNOWLEDGMENTS.md](../../ACKNOWLEDGMENTS.md) `TODO(verify)` 목록 참조)
- `semantic-embedding-hash.ts` 정확한 해시 알고리즘 및 차원 수 재확인 `TODO(verify)`

---

## References

- pgvector HNSW 차원 제한 원문: [`references/pgvector-hnsw-dimension-limits.md`](./references/pgvector-hnsw-dimension-limits.md)
- HNSW 알고리즘 원논문: [`references/hnsw-paper-malkov-yashunin.md`](./references/hnsw-paper-malkov-yashunin.md) — Malkov & Yashunin, IEEE TPAMI 2020, arXiv:1603.09320
- Upstage Solar Embedding API: [`references/upstage-solar-embedding-api.md`](./references/upstage-solar-embedding-api.md)
- 외부 기여자 감사 및 흡수 출처: [`ACKNOWLEDGMENTS.md`](../../ACKNOWLEDGMENTS.md)
- ADR-002 (벡터 임베딩 백엔드 결정): [`../decisions/ADR-002-vector-embedding-backend.md`](../decisions/ADR-002-vector-embedding-backend.md)
