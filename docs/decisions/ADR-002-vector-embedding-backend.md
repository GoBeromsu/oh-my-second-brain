---
title: Vector Embedding Backend — pgvector + 상용 임베딩
status: Accepted
date: 2026-06-13
created_by: claude-code
deciders: [beomsu]
relates_to: ../exec-plan/active/self-owned-second-brain/spec.md §6
---

# ADR 0002: Vector Embedding Backend — pgvector + 상용 임베딩

## Status

Accepted

## Context

약 20,000개 Obsidian 노트(Ataraxia vault)에 대한 의미검색(semantic search) 기능이 필요하다.

현재 oms 내장 임베더의 문제점(별도 audit 확인):

- **64-dim SHA1 해시**: neural embedding이 아니라 해시 기반 — 의미 유사도 포착 불가
- **청킹 없음**: 긴 노트를 통째로 처리 → 임베딩 품질 저하
- **sync마다 전체 재작성**: 증분 업데이트 없이 매번 전체 색인 재생성 → 20k 스케일에서 성능 부적합

두 가지 대안이 실질적으로 검토됐다.

**경로 A — Local-only (qmd 이식)**

- sqlite-vec + 로컬 EmbeddingGemma-300M (예: Google Gemma 300M embedding 모델)
- 100% 무네트워크, 프라이버시 최상
- 사용자 vault(qmd 컬렉션)에서 이미 실증됨
- 단점: 임베딩 품질이 상용 모델 대비 낮고, pgvector의 HNSW 스케일·SQL 쿼리 의미론 부재

**경로 B — pgvector + 상용 임베딩**

- PGLite(로컬 서버리스) 또는 Supabase(크로스머신 sync)로 pgvector 운영
- 임베딩 provider: Voyage voyage-3 또는 OpenAI text-embedding-3-* 계열
- 선택적으로 gbrain 런타임의 atomic-state + lock 증분 sync 패턴 활용
- 장점: HNSW 인덱스 스케일(수백만 벡터까지 안정적 지연), 풀 SQL 쿼리(WHERE/JOIN/메타데이터 필터), 미래 확장성

## Decision

**경로 B 채택 — pgvector + 상용 임베딩 아키텍처.**

사용자는 상용 API 사용에 열려 있으며, pgvector가 제공하는 HNSW 스케일·풀 SQL 쿼리 의미론·미래 확장성을 무네트워크 순수성보다 우선한다고 판단했다.

### 탈종속(self-owned) 논제와의 정합성

임베딩은 **파생 인덱스**다. 원본 노트는 사용자 소유 Obsidian vault에 그대로 남는다. 상용 API가 생성한 임베딩은 재생성 가능한 파생물일 뿐이며, omc-wiki처럼 intent 데이터나 워크플로우 로직이 vendor에 종속되는 HIGH lock-in 시나리오와 범주가 다르다. 따라서 "자기소유 second brain" 논제와 모순되지 않는다.

### 탈종속 단서 (구현 시 반드시 준수)

- **채택 대상은 아키텍처**: `pgvector + 상용 임베딩` 아키텍처를 채택하는 것이며 특정 런타임(gbrain 등)을 채택하는 것이 아니다. Postgres/pgvector는 open standard로 이식 가능하다.
- **gbrain 도구는 사용하지 않는다**: gbrain 도구는 사용하지 않는다. gbrain의 **로직만 흡수**(atomic-state+lock 증분 sync, pgvector 스키마, 3-stage 파이프라인)하여 자체 pgvector 엔진을 구축한다.
- **머신을 떠나는 것은 노트 텍스트뿐**: 외부로 전송되는 데이터는 임베딩 API로 가는 노트 텍스트가 전부다.
- **통제 수단**: env의 API 키 + 색인 제외 glob 설정으로 사용자가 전송 범위를 제어한다.

## Alternatives Considered

### (A) Local EmbeddingGemma/qmd 이식 — 보류

qmd 컬렉션에서 실증된 sqlite-vec + 로컬 Gemma 경로. 거부가 아니라 **보류**: 사용자가 현 시점에서 임베딩 품질과 pgvector 스케일/쿼리력을 무네트워크 순수성보다 우선하므로 채택하지 않는다. 미래 프라이버시 요건이 강화될 경우 회귀(fallback) 경로로 보존한다.

### (C) oms 64-dim 해시 유지 — 기각

의미 유사도를 포착하지 못하고, 청킹이 없으며, 20k 스케일에서 재작성 비용이 과도하다. audit에서 확인된 부적합으로 기각.

## Consequences

**긍정적 결과:**

- HNSW 인덱스로 수백만 벡터 스케일까지 안정적 쿼리 지연 확보
- 메타데이터 WHERE/JOIN/필터를 포함한 풀 SQL 쿼리 의미론 사용 가능
- Voyage voyage-3 / OpenAI 임베딩 품질로 의미검색 정확도 대폭 향상
- PGLite로 로컬 운영 시 서버 없이 파일 기반 DB 유지 가능
- Supabase 선택 시 크로스머신 sync 획득

**트레이드오프 및 리스크:**

- **API 키 의존**: Voyage 또는 OpenAI 임베딩 API 키가 env에 필요
- **노트 텍스트 외부 전송**: 색인 시 노트 텍스트가 임베딩 provider 서버로 전송됨 — 사용자 수용 완료
  - 완화책: env에서 민감 zone(예: `70. People/`, 일기 폴더 등)을 ignore glob으로 색인 제외
- **gbrain 런타임 결합**: gbrain 사용 시 gstack third-party 의존이 발생함. 위 탈종속 단서를 엄수해 교체 가능성을 보존해야 함
- **증분 sync 구현 필요**: gbrain의 atomic-state + lock 패턴을 채택하거나, 이와 동등한 증분 색인 메커니즘을 직접 구현해야 함

## Notes

- `spec.md §6`에서 임베딩 백엔드 요건 최초 기술
- 프라이버시 경계 재검토 시점: vault 규모 30k 돌파 또는 로컬 Gemma 모델 품질이 상용 대비 95% 수준 도달 시 경로 A 재평가
- ignore glob 예시: `70. People/**`, `Private/**`, `diary/**`

---

## 아키텍처 세부 결정 (보강: 2026-06-13)

고수준 결정(경로 B — pgvector + 상용 임베딩)을 확정한 이후, 구현에 필요한 아키텍처 세부 결정을 추가로 기록한다. 각 항목은 독립된 결정이며 MECE하다.

배경 조사 전문: [`docs/research/retrieval-engine-design-references.md`](../research/retrieval-engine-design-references.md)

### 스토리지 계층

- **Primary**: PGLite (`@electric-sql/pglite`) — WASM PostgreSQL, 로컬 파일 기반, 서버 없음
- **Opt-in**: Supabase pgvector — `OMS_PGVECTOR_URL` 환경변수 하나로 전환. SQL이 PGLite와 동일하므로 코드 변경 없음.
- **Fallback**: sqlite-vec (vec0) — storage interface 뒤에 위치. PGLite/Supabase 사용 불가 시.

세 옵션 모두 동일 SQL 추상화(storage interface)를 구현한다.

### 스키마

```sql
-- 노트 문서 테이블
documents (id, path, content_hash, metadata JSONB, updated_at)

-- 청크 테이블 (~1,300자 단위)
chunks (id, document_id, chunk_index, content, token_count)

-- 임베딩 테이블 — 모델별 키
chunk_embeddings (id, chunk_id, model_id, embedding vector/halfvec, created_at)
```

`chunk_embeddings`를 `model_id`로 분리하면 임베더 교체 시 다른 모델의 임베딩을 보존한 채 대상 모델만 재임베딩할 수 있다.

**인덱스**:

```sql
-- HNSW 벡터 인덱스 (기본 파라미터)
CREATE INDEX ON chunk_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- BM25용 GIN 인덱스
CREATE INDEX ON chunks USING gin(to_tsvector('simple', content));
```

### 플러그어블 임베더 — 비대칭 인터페이스

모든 임베더는 다음 인터페이스를 구현한다:

```typescript
interface Embedder {
  embedDocument(text: string): Promise<number[]>;  // 인덱스 시점
  embedQuery(text: string): Promise<number[]>;      // 쿼리 시점
  dimension: number;
  modelId: string;
}
```

Upstage Solar처럼 `passage` / `query` 모델이 분리된 비대칭 임베더는 두 메서드가 다른 모델을 호출한다. Voyage/OpenAI 같은 대칭 임베더는 두 메서드가 동일 호출을 수행한다. 호출 코드는 비대칭 여부를 알 필요가 없다.

### 임베더 티어

| Tier | 대표 모델 | 차원 | 기본값 | 비고 |
|------|---------|------|-------|------|
| 1 — 경량 로컬 (default) | Qwen3-Embedding-0.6B | 1,024 | O | llama.cpp 로컬 실행. 무비용. |
| 2 — 고품질 로컬 | EmbeddingGemma-300M | 미확인 `TODO(verify)` | — | 로컬. 무비용. |
| 3 — 상용 opt-in | Upstage Solar (`passage`/`query`) | 4,096 | — | 비대칭. HNSW 불가(> 4,000). 아래 정책 참조. |
| 3 — 상용 opt-in | Voyage `voyage-3` | 1,024 | — | 대칭. API 키 필요. |
| 3 — 상용 opt-in | OpenAI `text-embedding-3-small` | 1,536 | — | 대칭. API 키 필요. |

**`ignore_for_external_apis` glob**: `~/.config/vault-search/config.yml`에 정의하며, 청킹 이전 단계에서 검사한다. 이 glob에 매칭되는 경로의 노트는 어떤 외부 임베딩 API에도 전송되지 않는다. Tier 1/2 로컬 임베더에는 적용되지 않는다.

API 키 저장 위치: ADR-004 참조.

### HNSW 차원 제한 정책

원문 수치 출처: [`docs/research/references/pgvector-hnsw-dimension-limits.md`](../research/references/pgvector-hnsw-dimension-limits.md)

| 차원 범위 | 사용 타입 | HNSW 인덱싱 |
|---------|---------|------------|
| ≤ 2,000 | `vector` | 가능 |
| ≤ 4,000 | `halfvec` | 가능 |
| > 4,000 (예: Solar 4,096) | — | **불가** |

**> 4,000차원 모델(Solar)의 선택지**:

| 옵션 | 설명 |
|------|------|
| Binary quantization | `bit` 타입 변환 → HNSW 최대 64,000-dim. 정밀도 손실. |
| Dimensionality reduction | ≤ 2,000으로 축소 후 `vector` HNSW. 정보 손실. |
| Subvector indexing | 모델 지원 필요 (Solar 미확인 `TODO(verify)`). |
| **Exact scan + reranker** | 인덱스 없이 전체 스캔 후 Qwen3-Reranker 재순위. **Solar 권장.** |

**Solar 4,096에 대한 결정**: Exact scan + Qwen3-Reranker 조합. `halfvec` 4,000-dim HNSW 한계를 Solar 4,096이 초과하므로 HNSW 경로를 사용하지 않는다. 사용자가 현 vault 규모(~20k 노트)에서 직접 실증한 워크어라운드다.

### 검색 퓨전 — RRF(k=60)

현재 oms의 `lexical * 0.52 + vector * 0.48` 선형 혼합을 RRF(k=60)로 대체한다.

```
RRF_score(d) = Σ_i  1 / (60 + rank_i(d))
```

순위 기반이므로 BM25와 코사인 유사도의 스케일 불일치 문제가 없다. optional rerank(Qwen3-Reranker) + metadata filtering(WHERE/JOIN)을 RRF 이후에 적용한다.

### 증분 Sync

현재 oms의 전체 재작성 sync를 두 메커니즘의 결합으로 대체한다:

1. **SHA256 content-hash**: 각 노트의 내용 해시를 저장하고, hash 변경분만 재임베딩한다 (qmd 방식).
2. **pg advisory lock**: `pg_advisory_lock()`으로 concurrent sync를 방지하고, crash 시 자동 해제한다 (gbrain 방식).

### 통합 Embed

사용자가 실행하는 명령은 단일 `embed`/`sync`다. 이 명령은 한 번의 content-hash 스캔에서:

1. 변경된 청크를 벡터 인덱스(`chunk_embeddings`)에 기록하고
2. frontmatter 그래프(ADR-005) 엣지를 동시에 빌드한다.

벡터 인덱스와 그래프는 별도 명령으로 분리되지 않는다. 두 인덱스는 항상 동일한 content-hash 스캔에서 동기화된다.

### CLI 명령 표면 + alias (메모)

> 이 메모는 별도 스킬/아티팩트를 만들지 않는다(anti-proliferation 원칙). CLI 표면 결정만 여기에 기록한다.

자주 치는 명령은 짧은 alias를 가진다. 정식 명령과 alias를 1:1로 고정한다:

| 정식 | alias | 동작 |
|------|-------|------|
| `retrieve` | `rtv` | 하이브리드 조회(lex+vec+RRF). `rt`는 리트윗 연상이라 기각, `rtv` 채택 |
| `query` | `q` | 단발 검색 표면(qmd 쿼리 표면 따름) |
| `embed` | `emb` | 통합 embed(벡터+그래프 동시 빌드) |
| `graph` | `gph` | 그래프 조회(cached full / live sparse, ADR-005) |
| `status` | `st` | 엔진/인덱스 상태 |

`graph`·`status`는 **MCP tool / CLI 서브커맨드**이지 독립 스킬이 아니다. alias는 CLI 진입점 매핑일 뿐, 새 스킬을 추가하지 않는다.

### oms 64-dim 해시 임베더 마이그레이션

1. **Parallel boot**: 새 pgvector 엔진을 기존 oms 엔진과 병렬로 시작
2. **Full sync**: 새 엔진에서 전체 vault를 최초 1회 임베딩
3. **MCP soft-switch**: `OMS_SEARCH_ENGINE` 환경변수로 쿼리 라우팅을 새 엔진으로 전환
4. **Decommission**: 구 64-dim 해시 임베더 및 관련 코드(`semantic-embedding-hash.ts`, `semantic-sync.ts`) 제거
