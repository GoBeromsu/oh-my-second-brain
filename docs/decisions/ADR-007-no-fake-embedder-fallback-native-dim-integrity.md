---
title: 임베딩 무결성 불변 — 네이티브 차원 보존 & 가짜 임베더 폴백 금지
status: Accepted
date: 2026-06-14
created_by: claude-code
deciders: [beomsu]
relates_to:
  - docs/decisions/ADR-002-vector-embedding-backend.md
  - docs/exec-plan/archived/self-owned-second-brain/plan.md §Principles 3
  - docs/exec-plan/archived/self-owned-second-brain/plan.md §Alternatives Considered ~line 353
---

# ADR 0007: 임베딩 무결성 불변 — 네이티브 차원 보존 & 가짜 임베더 폴백 금지

## Status

Accepted

## Context

신규 엔진 병렬 모듈 구축(ADR-002, R18 교체 전략) 과정에서 두 가지 영구 불변 원칙이 명시적으로 잠금됐다. 이 ADR은 그 두 원칙을 공식 결정으로 기록한다.

> **Corrected on 2026-08-24:** The former `OMS_MODEL_PATH` error-contract description was inaccurate. With no embedding provider configured and no setup-installed default, the core engine still serves lexical-only queries; a `vec` or `hyde` sub-query returns `available: false` and guidance naming `OMS_EMBEDDING_PROVIDER` + `OMS_EMBEDDING_MODEL` (and provider auth env vars, e.g. `UPSTAGE_API_KEY`). A setup-written installed-default descriptor can point to a real model without being provider auto-detection. The two principles below are unchanged.

**배경 — 기존 회귀 층의 한계:**

기존 `src/search/semantic-embedding-provider.ts`에는 768→64 모듈로 폴드(modulo fold) 로직이 존재한다. 이는 초기 oms 해시 임베더의 **레거시 회귀 층(legacy regression floor)**으로, plan.md §Alternatives Considered(~line 353)의 교체 대상 표기("the existing layer's architecture … requires replacement, not extension")와 ADR-002 §oms 64-dim 해시 임베더 마이그레이션 절차에 따라 `#5 swap` 시점에 완전 제거된다. 신규 엔진 코드에는 일절 복사하지 않는다.

**P-A — 네이티브 차원 무결성 (no-projection / native-dim integrity):**

qmd와 gbrain은 임베딩 벡터를 절대 투영·폴딩·절단하지 않는다. oms 신규 엔진도 마찬가지다. 임베딩 모델이 생성하는 차원이 그대로 저장·조회에 사용된다(`native-dim-in == stored-dim-out`). 신규 엔진은 EmbeddingGemma-300M을 **전체 768d**로, Upstage Solar를 **전체 4096d**로 임베딩한다. 기존 `src/search/`의 768→64 모듈로 폴드는 레거시 회귀 층 전용이며, `#5 swap`에서 제거된다. 신규 코드에 복사하지 않는다.

**P-B — 프로덕션 경로의 가짜 임베더 폴백 금지 (no fake stub as unintended fallback in production):**

실제 모델/키가 없을 때 가짜·스텁 임베더를 묵시적으로 사용하는 것은 의도치 않은 폴백(unintended fallback)이다. 이 경우 실제 임베딩 없이 색인이 생성되는 심각한 결함이 야기된다. 검증은 TEST 코드로 수행하며, 테스트 전용 스텁은 `*.test-helper.ts` / `*.test.ts`에만 존재하고 프로덕션 모듈에서 임포트할 수 없다. 폐기 표시된 데드 코드(decommission-marked dead code)는 즉시 제거한다. provider가 없으면 vec sub-query는 `available: false`와 `OMS_EMBEDDING_PROVIDER` + `OMS_EMBEDDING_MODEL` 설정 안내를 반환하며, 가짜 임베더로 대체하지 않는다. 해시-투영 임베더(hash-projection embedder)는 계획에 없었으며 프로덕션에서 제거하여 테스트-헬퍼로 이동됐다.
실제 모델/키가 없을 때 가짜·스텁 임베더를 묵시적으로 사용하는 것은 의도치 않은 폴백(unintended fallback)이다. 이 경우 실제 임베딩 없이 색인이 생성되는 심각한 결함이 야기된다. 검증은 TEST 코드로 수행하며, 테스트 전용 스텁은 `*.test-helper.ts` / `*.test.ts`에만 존재하고 프로덕션 모듈에서 임포트할 수 없다. 폐기 표시된 데드 코드(decommission-marked dead code)는 즉시 제거한다. provider가 없고 setup-installed default도 없으면 **lex-only는 계속 성공하지만** vec/HyDE sub-query는 `available: false`와 `OMS_EMBEDDING_PROVIDER` + `OMS_EMBEDDING_MODEL` 설정 안내를 반환하며, 가짜 임베더로 대체하지 않는다. 해시-투영 임베더(hash-projection embedder)는 계획에 없었으며 프로덕션에서 제거하여 테스트-헬퍼로 이동됐다.

## Decision

다음 두 원칙을 영구 불변으로 잠금한다.

### P-A — 네이티브 차원 무결성

**임베딩 차원은 절대 투영·폴딩·절단하지 않는다. (`native-dim-in == stored-dim-out`)**

- 프로덕션 임베딩은 provider가 반환한 native dimension을 유지한다.
- 차원 축소를 위한 production fallback은 두지 않는다.
- 이 원칙은 현재 `src/kernel/engine/embed/` 구현에 적용된다.
- ADR-002의 pgvector HNSW 세부사항은 stale이며 현재 구현 계약이 아니다.

### P-B — 프로덕션 경로 가짜 임베더 폴백 금지

**실제 모델/키가 없을 때 가짜·스텁 임베더를 묵시적 폴백으로 사용하는 것은 허용되지 않는다.**

- 테스트 전용 스텁은 `*.test-helper.ts` / `*.test.ts`에만 위치한다. 프로덕션 모듈은 이 파일을 임포트할 수 없다.
- 폐기 표시된 데드 코드는 즉시 삭제한다. 코드베이스에 남겨두지 않는다.
- provider가 설정되지 않았을 때 core assembly의 lex-only sub-query는 계속 성공한다. vec/HyDE sub-query는 `available: false`와 `OMS_EMBEDDING_PROVIDER` + `OMS_EMBEDDING_MODEL` 및 provider 인증 환경변수 안내를 반환한다. 가짜 임베더로 묵시적 대체는 없다.
- 해시-투영 임베더는 원래 계획에 없었다. 프로덕션 코드에서 제거하고 테스트-헬퍼로 이동됐다.
- 런타임은 인증 키만으로 provider/model을 추론하거나 MCP 경로에서 모델을 다운로드하지 않는다. 명시적 setup이 작성한 installed-default descriptor는 resolver의 명시적 입력으로 사용할 수 있고, canonical 환경 쌍으로도 같은 모델을 선택할 수 있다. **측정과 명시적 설치로 선택된 실제 기본 모델(real default model)은 P-B가 금지하는 가짜 폴백이 아니다.**

## Consequences

**긍정적 결과:**

- 임베딩 품질 보장: 저장된 벡터가 항상 모델 원본 차원을 유지하므로 유사도 계산이 정확하다.
- 프로덕션 색인 무결성: 실제 임베더 없이 색인이 생성되는 사고(가짜 폴백으로 인한 silent degradation)를 구조적으로 방지한다.
- 테스트 신뢰성: 스텁이 테스트 경계 밖으로 유출되지 않으므로 테스트가 실제 동작을 반영한다.
- 신규 임베더 추가 시 명확한 규칙: 차원 변환 없이 원본 차원을 그대로 사용한다는 단일 원칙을 따르면 된다.

**트레이드오프 및 제약:**

- provider가 없으면 core assembly의 lexical/graph 경로는 계속 사용할 수 있고 vec/HyDE sub-query는 `available: false`를 반환한다. vector semantic ops에는 `OMS_EMBEDDING_PROVIDER` + `OMS_EMBEDDING_MODEL` 및 해당 provider 인증 환경변수가 필요하다.

## Links

- [ADR-002 Vector Embedding Backend](./ADR-002-vector-embedding-backend.md) — 임베더 티어(768d/4096d), HNSW 차원 제한 정책, `#5 swap` 교체 절차, 64-dim 해시 임베더 마이그레이션의 원본 결정
- [plan.md Principle 3 — Parity-or-Better before Swap](../exec-plan/archived/self-owned-second-brain/plan.md) — `src/search/`(레거시 회귀 층, 768→64 모듈로 폴드 포함)을 교체 대상·회귀 층으로 명시
- [plan.md §Alternatives Considered ~line 353](../exec-plan/archived/self-owned-second-brain/plan.md) — "the existing layer's architecture (no chunking, no graph integration, SHA1 hash embedder) requires replacement, not extension"
- [deep-interview-record.md R22](../exec-plan/archived/self-owned-second-brain/deep-interview-record.md) — P-A / P-B 원칙 잠금 라운드 기록
