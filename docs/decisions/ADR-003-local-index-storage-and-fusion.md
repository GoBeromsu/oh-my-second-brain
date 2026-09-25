---
slug: ADR-003-local-index-storage-and-fusion
title: "로컬 인덱스 저장·융합 — 외부 캐시 SQLite(FTS5 + sqlite-vec), 증분 sync, RRF"
status: Accepted
date: 2026-09-24
created_by: claude
deciders: [beomsu]
supersedes:
  - 구 ADR-002
relates_to:
  - ./ADR-001-vault-resolution-link-note-identity.md
  - ./ADR-002-config-secrets-host-state-roots.md
  - ./ADR-004-search-backend-and-reranking.md
  - ./ADR-005-embedding-model-contract-integrity-lifecycle.md
  - ./ADR-006-graph-access.md
  - ./ADR-009-cross-cutting-principles.md
---

# ADR-003: 로컬 인덱스 저장·융합

## Status

Accepted (2026-09-24). 구 ADR-002 전체를 대체한다. 결정 내용은 현재 `src/kernel/engine/**` 구현을 그대로 기록한 것이다.

## Context

vault 검색 인덱스를 어디에 두고 어떤 스키마로 채우는지, lexical·vector 결과를 어떻게 합치는지를 정한 ADR이 없었다. 구 ADR-002는 계획 문서였고 구현은 다른 길로 갔다.

- 구 ADR-002는 pgvector/PGLite + HNSW + 상용 임베딩 API를 쓴다고 했지만, 구현은 better-sqlite3 위의 sqlite-vec `vec0`(brute-force knn) + FTS5 bm25 + 로컬 GGUF다 (`src/kernel/engine/embed/store.ts:30`, `:279-362`).
- 구 ADR-002는 `documents/chunks/chunk_embeddings` 스키마라고 했지만, 구현은 `engine_meta`·`engine_chunk_meta`·`engine_chunk_fts`·vec0 테이블이다 (`store.ts:279-362`).
- 구 ADR-002는 `pg_advisory_lock`으로 동시 sync를 막는다고 했지만, 구현은 파일 기반 `.lock` writer lock이다 (`src/kernel/engine/embed/sync.ts:246-378`).
- 구 ADR-002는 약 1300자 청크라고 했지만, 구현은 900 token 예산에 overlap 비율 0.15다 (`src/kernel/engine/embed/chunker.ts:14-15`).
- 구 ADR-002는 embed 한 번의 스캔에서 frontmatter 그래프 엣지도 만든다고 했지만, 구현된 `sync.ts`에는 그래프·엣지 생성 코드가 없다 (→ ADR-006).
- RRF k=60은 구 ADR-002와 구현이 같다 (`src/kernel/engine/retrieval/rrf.ts:71`).

## Decision

### 1. 인덱스는 vault 밖 외부 캐시의 단일 SQLite 파일이다 (`src/kernel/engine/paths.ts`)

- 위치는 `<cache>/oms/vaults/v1/<sha256(vault realpath)>/engine-store.sqlite`다. `<cache>`는 `$XDG_CACHE_HOME`이 있으면 그 값, 없으면 `~/.cache`다 (`paths.ts:6`, `:71-77`, `:120-131`).
- 캐시 경로가 vault 안에 있거나 hard link이면 거부한다 (`paths.ts:84-118`).
- `-wal`·`-shm`·`-journal`·`.lock` 동반 파일은 symlink이면 안 된다 (`paths.ts:149-189`).
- 호스트 상태 루트 `~/.oms`와는 별개다 (→ ADR-002). vault 경로 해석은 → ADR-001.

### 2. 저장 엔진: SQLite WAL + FTS5 + sqlite-vec (`src/kernel/engine/embed/store.ts`)

- core 스키마는 WAL 모드이며 `engine_meta`, `engine_chunk_meta`, FTS5 테이블로 구성된다 (`store.ts:279-357`). vec0 테이블은 provider의 native 차원으로 만든다 (`store.ts:359-362`, `src/kernel/engine/assemble.ts:573`).
- sqlite-vec를 로드하지 못하면 `vecAvailable=false`로 열고 lexical만 제공한다 (`store.ts:581-615`). core 전용 open 경로도 있다 (`store.ts:378`). 읽기 전용 open은 `store.ts:1099`다.
- better-sqlite3 ABI가 맞지 않으면 `npm rebuild better-sqlite3`을 안내하고 끝낸다. 자동 rebuild는 하지 않는다 (`store.ts:38-48`).
- `engine_meta`의 meta version은 정확히 일치해야 한다 (`store.ts:241-243`, `:325-329`). version 값과 fingerprint 규칙은 → ADR-005.

### 3. 질의: bm25 lexical, 클램프된 knn vector (`store.ts`)

- lexical 질의는 `makeFtsQuery`로 `a-z0-9가-힣`만 남긴다. 2자 미만 term은 버리고 최대 32 term을 `term*` OR로 묶는다.
- vector knn의 k는 `SQLITE_VEC_MAX_K=4096`으로 클램프한다 (`store.ts:162`, `:191-220`). score는 `1/(1+distance)`다 (`store.ts:686-691`, `:804`). non-finite 벡터는 거부한다 (`store.ts:191-220`).

### 4. 청킹 (`src/kernel/engine/embed/chunker.ts`)

- heading을 인식하고, `maxTokens`를 넘으면 줄 단위로 나눈다 (`chunker.ts:163`). 기본값은 900 token, overlap 0.15다 (`chunker.ts:14-15`). overlap 줄 수는 `max(1, round(10*ratio))`다 (`chunker.ts:171`).
- 청크 sha는 title+text의 SHA-256이다 (`chunker.ts:74`).

### 5. 증분 sync와 대상 파일 (`src/kernel/engine/embed/sync.ts`)

- `.md`만 색인한다 (`sync.ts:149-168`). `SKIP_DIRS`와 모든 dot-디렉터리를 건너뛴다 (`sync.ts:138-147`). managed 영역도 제외한다 (`sync.ts:772`).
- 명시한 파일도 vault 안이어야 하고, 무시 디렉터리 밖이어야 한다 (`sync.ts:170-197`).
- 청크 sha가 같으면 재임베딩을 건너뛴다 (`sync.ts:479-556`). 임베딩은 worker pool로 돌린다 (`sync.ts:571-604`).
- `embed=false`이면 lexical 인덱스만 갱신하고 "no vectors generated" 경고를 낸다 (`sync.ts:798-834`).

### 6. 단일 writer lock과 원자적 세대 교체 (`sync.ts`)

- writer는 `.lock` 파일 lock을 얻은 뒤에야 쓰기 handle을 연다 (`sync.ts:902`). lock은 O_EXCL 임시파일 + hard link로 잡는다. 살아 있는 owner는 기다리지 않고 실패하며, stale lock은 PID로 회수한다 (`sync.ts:246-378`).
- `force` 재구축은 소유한 store에서만 허용하고, 범위를 좁힌 force는 거부한다. 새 세대를 shadow로 만든 뒤 원자적으로 교체한다 (`sync.ts:606-742`, `:964-1024`).
- 오류는 `available:false`로 돌려주고, `finally`에서 dispose와 unlock을 한다 (`sync.ts:1068-1090`). 반환 규약 자체는 → ADR-009.

### 7. 융합: RRF k=60 + provenance boost (`src/kernel/engine/retrieval/`)

- `fuseRRF(lists, k=60)`는 `1/(k+rank)`를 합산한다. tie는 `docPath\0ordinal`로 결정적으로 푼다. 잘못된 hit이 입력되면 throw한다 (`rrf.ts:71`).
- `dispatch`는 기본 k=10, rrfK=60이다(`deps.rrfK`로 override 가능). sub-query를 병렬 실행하고, `perTypeScores`를 모은 뒤 융합·정책 점수·정렬 순으로 처리한다 (`dispatcher.ts:372-465`).
- provenance boost는 authored 0.02, curated 0.01, external-raw 0이다 (`dispatcher.ts:175-179`). 정책은 `boost-additive`(기본), `boost-k-scale`, `boost-per-list`, `boost-zero`다 (`dispatcher.ts:206-213`).
- sub-query 실행은 2회 시도, 50ms backoff로 재시도한다 (`dispatcher.ts:86-100`).
- 리랭킹은 융합 뒤 선택 단계다 (→ ADR-004).

### 미결

- `SKIP_DIRS`의 정확한 목록과 managed 제외 범위가 vault 규약 문서와 일치하는지는 확인하지 않았다.
- provenance(authored/curated/external-raw)를 어느 단계가 부여하는지는 이번에 추적하지 않았다.
- boost 정책을 사용자가 바꾸는 공개 설정 표면이 있는지 확인하지 못했다.

## Alternatives Considered

- **pgvector/PGLite + HNSW (구 ADR-002 원안)** — 채택하지 않았다. 구현에 없고, HNSW 차원 제한 때문에 차원 축소 압력이 생긴다. 이는 native 차원 원칙과 충돌한다 (→ ADR-005).
- **vault 안 `.oms/` 아래에 인덱스 두기** — 기각했다. 경로 검사가 vault 내부 캐시를 명시적으로 거부한다 (`paths.ts:84-118`).
- **동시 writer를 기다리는 blocking lock** — 기각했다. 살아 있는 owner가 있으면 즉시 실패하는 쪽을 택했다 (`sync.ts:246-378`).
- **fingerprint가 바뀌면 in-place로 섞어 갱신** — 기각했다. `force` + shadow 세대 교체만 허용한다.

## Consequences

- 외부 서비스가 필요 없다. 네이티브 의존성은 better-sqlite3와 sqlite-vec뿐이다. ABI가 어긋나면 사용자가 rebuild해야 한다.
- sqlite-vec가 없는 환경도 lexical 검색은 계속 된다. vector 경로는 unavailable이 된다.
- brute-force knn이므로 문서 수가 늘면 선형으로 느려지고, k 상한은 4096이다.
- vault를 옮기면(realpath 변경) 캐시 키가 바뀌어 재색인이 필요하다.
- 동시 sync 두 개는 하나가 실패로 끝난다. 재시도는 호출자 책임이다.

## 흡수 내역

| 기존 조항 | 처리 |
|---|---|
| 구 ADR-002 Decision: 임베딩 백엔드 선택(상용 API) | 폐기: 로컬 GGUF로 대체 → ADR-005 |
| 구 ADR-002 탈종속 논제·단서 | §1, §2 (외부 서비스 없는 로컬 SQLite) |
| 구 ADR-002 스토리지 계층(pgvector/PGLite) | 폐기: 구현은 sqlite-vec + FTS5 → §2 |
| 구 ADR-002 스키마(documents/chunks/chunk_embeddings) | 폐기: 실제 스키마로 대체 → §2 |
| 구 ADR-002 플러그어블 임베더·임베더 티어 | → ADR-005 |
| 구 ADR-002 HNSW 차원 제한 정책 | 폐기: HNSW 미사용, knn 클램프로 대체 → §3 |
| 구 ADR-002 검색 퓨전 RRF(k=60) | §7 |
| 구 ADR-002 증분 Sync(SHA256) | §5 |
| 구 ADR-002 pg advisory lock | 폐기: 파일 writer lock → §6 |
| 구 ADR-002 통합 Embed(그래프 동시 빌드) | 폐기: sync에 그래프 빌드 없음 → ADR-006 |
| 구 ADR-002 CLI 명령 표면 메모 | 폐기: 메모 수준, CLI 표면은 이 ADR의 결정 대상 아님 |
| 구 ADR-002 64-dim 해시 임베더 마이그레이션 | 폐기: 해시 임베더 제거 완료 → ADR-005 |
| 구 ADR-002 Alternatives (A)/(C) | Alternatives Considered에 반영 |
