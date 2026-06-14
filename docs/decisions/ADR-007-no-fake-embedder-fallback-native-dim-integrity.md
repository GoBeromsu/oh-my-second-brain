---
title: 임베딩 무결성 불변 — 네이티브 차원 보존 & 가짜 임베더 폴백 금지
status: Accepted
date: 2026-06-14
created_by: claude-code
deciders: [beomsu]
relates_to:
  - docs/decisions/ADR-002-vector-embedding-backend.md
  - docs/exec-plan/active/self-owned-second-brain/plan.md §Principles 3
  - docs/exec-plan/active/self-owned-second-brain/plan.md §Alternatives Considered ~line 353
---

# ADR 0007: 임베딩 무결성 불변 — 네이티브 차원 보존 & 가짜 임베더 폴백 금지

## Status

Accepted

## Context

신규 `src/engine/` 병렬 모듈 구축(ADR-002, R18 교체 전략) 과정에서 두 가지 영구 불변 원칙이 명시적으로 잠금됐다. 이 ADR은 그 두 원칙을 공식 결정으로 기록한다.

**배경 — 기존 회귀 층의 한계:**

기존 `src/search/semantic-embedding-provider.ts`에는 768→64 모듈로 폴드(modulo fold) 로직이 존재한다. 이는 초기 oms 해시 임베더의 **레거시 회귀 층(legacy regression floor)**으로, plan.md §Alternatives Considered(~line 353)의 교체 대상 표기("the existing layer's architecture … requires replacement, not extension")와 ADR-002 §oms 64-dim 해시 임베더 마이그레이션 절차에 따라 `#5 swap` 시점에 완전 제거된다. 신규 엔진 코드에는 일절 복사하지 않는다.

**P-A — 네이티브 차원 무결성 (no-projection / native-dim integrity):**

qmd와 gbrain은 임베딩 벡터를 절대 투영·폴딩·절단하지 않는다. oms 신규 엔진도 마찬가지다. 임베딩 모델이 생성하는 차원이 그대로 저장·조회에 사용된다(`native-dim-in == stored-dim-out`). 신규 엔진은 EmbeddingGemma-300M을 **전체 768d**로, Upstage Solar를 **전체 4096d**로 임베딩한다. 기존 `src/search/`의 768→64 모듈로 폴드는 레거시 회귀 층 전용이며, `#5 swap`에서 제거된다. 신규 코드에 복사하지 않는다.

**P-B — 프로덕션 경로의 가짜 임베더 폴백 금지 (no fake stub as unintended fallback in production):**

실제 모델/키가 없을 때 가짜·스텁 임베더를 묵시적으로 사용하는 것은 의도치 않은 폴백(unintended fallback)이다. 이 경우 실제 임베딩 없이 색인이 생성되는 심각한 결함이 야기된다. 검증은 TEST 코드로 수행하며, 테스트 전용 스텁은 `*.test-helper.ts` / `*.test.ts`에만 존재하고 프로덕션 모듈에서 임포트할 수 없다. 폐기 표시된 데드 코드(decommission-marked dead code)는 즉시 제거한다. 프로덕션 임베딩 팩토리 `requireRealEmbeddingProvider`는 실제 모델 또는 API 키가 설정되지 않은 경우 **예외를 던진다**(`OMS_MODEL_PATH` 미설정 메시지 포함). 해시-투영 임베더(hash-projection embedder)는 계획에 없었으며 프로덕션에서 제거하여 테스트-헬퍼로 이동됐다.

## Decision

다음 두 원칙을 영구 불변으로 잠금한다.

### P-A — 네이티브 차원 무결성

**임베딩 차원은 절대 투영·폴딩·절단하지 않는다. (`native-dim-in == stored-dim-out`)**

- 신규 엔진의 임베딩 차원: EmbeddingGemma-300M = **768d**(전체), Upstage Solar = **4096d**(전체).
- 기존 `src/search/semantic-embedding-provider.ts`의 768→64 모듈로 폴드는 **레거시 회귀 층 전용**이다. `#5 swap` 시점에 완전 제거되며 `src/engine/`에는 일절 복사하지 않는다.
- qmd / gbrain 레퍼런스 구현도 이 불변을 준수한다. 흡수하는 패턴 중 차원 변환을 수행하는 것은 없다.
- Solar 4096d가 pgvector HNSW 한계(halfvec ≤ 4000)를 초과하는 것은 P-A의 직접적 귀결이다. 차원을 줄여 HNSW를 쓰는 대신, **전체 차원으로 exact scan + Qwen3-Reranker** 경로를 택한다(ADR-002 §HNSW 차원 제한 정책).

### P-B — 프로덕션 경로 가짜 임베더 폴백 금지

**실제 모델/키가 없을 때 가짜·스텁 임베더를 묵시적 폴백으로 사용하는 것은 허용되지 않는다.**

- 테스트 전용 스텁은 `*.test-helper.ts` / `*.test.ts`에만 위치한다. 프로덕션 모듈은 이 파일을 임포트할 수 없다.
- 폐기 표시된 데드 코드는 즉시 삭제한다. 코드베이스에 남겨두지 않는다.
- 프로덕션 임베딩 팩토리 `requireRealEmbeddingProvider`는 실제 모델 또는 API 키가 설정되지 않았을 때 **예외를 던진다**(`OMS_MODEL_PATH` 미설정 메시지 포함). 가짜 임베더로 묵시적 대체는 없다.
- 해시-투영 임베더는 원래 계획에 없었다. 프로덕션 코드에서 제거하고 테스트-헬퍼로 이동됐다.

## Consequences

**긍정적 결과:**

- 임베딩 품질 보장: 저장된 벡터가 항상 모델 원본 차원을 유지하므로 유사도 계산이 정확하다.
- 프로덕션 색인 무결성: 실제 임베더 없이 색인이 생성되는 사고(가짜 폴백으로 인한 silent degradation)를 구조적으로 방지한다.
- 테스트 신뢰성: 스텁이 테스트 경계 밖으로 유출되지 않으므로 테스트가 실제 동작을 반영한다.
- 신규 임베더 추가 시 명확한 규칙: 차원 변환 없이 원본 차원을 그대로 사용한다는 단일 원칙을 따르면 된다.

**트레이드오프 및 제약:**

- `requireRealEmbeddingProvider`가 예외를 던지므로 모델/키 없이 엔진을 초기화할 수 없다. CI 환경에서는 실제 모델 경로(`OMS_MODEL_PATH`) 또는 API 키가 반드시 필요하다.
- Solar 4096d는 HNSW 인덱스 없이 exact scan으로만 동작한다(P-A 귀결). 사용자가 현 vault 규모(~20k 노트)에서 직접 실증한 워크어라운드다(ADR-002).

## Links

- [ADR-002 Vector Embedding Backend](./ADR-002-vector-embedding-backend.md) — 임베더 티어(768d/4096d), HNSW 차원 제한 정책, `#5 swap` 교체 절차, 64-dim 해시 임베더 마이그레이션의 원본 결정
- [plan.md Principle 3 — Parity-or-Better before Swap](../exec-plan/active/self-owned-second-brain/plan.md) — `src/search/`(레거시 회귀 층, 768→64 모듈로 폴드 포함)을 교체 대상·회귀 층으로 명시
- [plan.md §Alternatives Considered ~line 353](../exec-plan/active/self-owned-second-brain/plan.md) — "the existing layer's architecture (no chunking, no graph integration, SHA1 hash embedder) requires replacement, not extension"
- [deep-interview-record.md R22](../exec-plan/active/self-owned-second-brain/deep-interview-record.md) — P-A / P-B 원칙 잠금 라운드 기록
