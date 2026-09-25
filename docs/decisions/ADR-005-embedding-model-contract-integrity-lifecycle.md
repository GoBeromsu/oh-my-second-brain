---
slug: ADR-005-embedding-model-contract-integrity-lifecycle
title: "임베딩 모델 계약·무결성·수명주기 — identity-only 선언, 검증된 로컬 설치, 불변 lineage, 가짜 폴백 금지"
status: Accepted
date: 2026-09-24
created_by: claude
deciders: [beomsu]
supersedes:
  - 구 ADR-007
supersedes_in_part:
  - 구 ADR-012#D1
  - 구 ADR-012#D2
  - 구 ADR-012#D3
  - 구 ADR-012#D5
relates_to:
  - ./ADR-002-config-secrets-host-state-roots.md
  - ./ADR-003-local-index-storage-and-fusion.md
  - ./ADR-004-search-backend-and-reranking.md
  - ./ADR-009-cross-cutting-principles.md
---

# ADR-005: 임베딩 모델 계약·무결성·수명주기

## Status

Accepted (2026-09-24). 구 ADR-007 전체와 구 ADR-012 D1·D2·D3·D5를 대체한다. 구 ADR-012 D4(reranker 수명)와 D5의 HyDE·Passthrough 부분은 → ADR-004.

## Context

embed·rerank·generate 모델은 세 가지를 보장해야 한다. vault 사이에 옮길 수 있어야 하고, 호스트에서 실제로 검증되어야 하며, 인덱스와의 호환성을 증명할 수 있어야 한다. 모델이 없을 때 가짜로 채우는 경로는 검색 품질을 조용히 망가뜨린다. 구 ADR-007과 구 ADR-012가 각자 이 원칙을 나눠 가졌고, 다운로드 금지 규칙은 두 ADR에 중복되어 있었다.

- 구 ADR-012 D3은 prompt scheme이 "data-driven"이라고 했지만, 구현은 이름으로 버전 관리하는 닫힌 집합이다. `switch`로 분기한다 (`src/kernel/engine/embed/provider.ts:108-139`, `src/kernel/engine/embed/model.ts:109`, `:120`, `:300-305`).
- 구 ADR-007은 vec/HyDE 불가 안내에 provider 인증 환경변수를 포함한다고 했지만, 구현은 로컬 GGUF 전용이다. guidance는 env pair, embed일 때 `.oms/settings.json`의 `embedding.model`, 설치 명령만 안내한다 (`src/kernel/engine/embed/config.ts:331-338`, `provider.ts:479-523`).
- 구 ADR-007/구 ADR-002가 언급한 `src/search`의 768→64 fold는 코드에서 제거되었다. 남은 차원 변환은 없다 (`provider.ts:72-92`).

## Decision

### 1. vault 선언은 `.oms/settings.json`의 `embedding.model` 하나다 (`src/kernel/engine/embed/config.ts`)

- 볼트가 선언하는 모델은 embed 하나뿐이며, `settings.json`의 `embedding.model` 문자열이다 (`src/kernel/vault/settings.ts:13`, `:72-75`). 볼트 파일 `models.json`은 없다. rerank와 generate는 볼트 선언이 없다 (`config.ts:370`).
- 값은 `readVaultEmbeddingModel`/`readVaultEmbeddingModelSync`가 읽는다. 파일이 없으면 오류가 아니라 볼트 선언 없음이다 (`config.ts:39-54`).
- 모델 이름은 설치된 embed artifact 하나와 정확히 일치해야 한다 (`config.ts:254-267`).
- mutable revision(`latest`, `main`, `master`, `head`)은 거부한다 (`config.ts:100`, `:140-141`; `model.ts:142`, `:213`).
- 선택 변경은 `oms model select`의 propose/apply와 approval digest를 거친다 (`model.ts:738-788`; `src/cli/model-command.ts:128-141`). `settings.json`이 없으면 `VAULT_SETTINGS_MISSING`으로 거부하고 `oms setup`을 먼저 안내한다 (`model.ts:732-736`). 쓰기는 `publishEmbeddingModel`이 기존 설정에 합친 뒤 원자적으로 쓰고 다시 읽어 확인한다 (`src/kernel/install/vault-settings-publish.ts:6-22`).
- `oms model waive`는 볼트에 아무것도 쓰지 않는다.
- `.oms/` 설정 위치의 일반 규칙은 → ADR-002.

### 2. 호스트 설치 증거는 `installed-models.json` receipt이며 매번 재검증한다 (`model.ts`)

- receipt는 `installed-models.json`, schema version 1이다 (`model.ts:22-23`). 모델 캐시는 `$XDG_CACHE_HOME` 또는 `~/.cache` 아래 `oms/models`다 (`model.ts:501-505`).
- receipt를 로드할 때마다 파일 sha256을 다시 계산한다 (`model.ts:486-499`). 빈 목록으로 취급하는 것은 receipt가 없을 때뿐이다 (`model.ts:507-531`).
- acquisition source는 url과 local path 중 하나만 허용한다 (`model.ts:394-401`). local path는 절대·정규화 경로여야 하며 참조로 등록한다 (`model.ts:336-352`).
- 캐시 경로와 파일 realpath가 vault 안이면 거부한다 (`model.ts:598`, `:635-640`). url일 때만 다운로드하고 sha256을 확인한다 (`model.ts:660-677`). receipt는 원자적으로 쓴다 (`model.ts:568-571`, `:688`).

### 3. 해석 순서는 고정되고 fail-closed다 (`config.ts:352-388`)

- 순서는 request → environment → vault(embed의 `embedding.model`만) → setup-default → unavailable이다 (`config.ts:61`, `:358-374`).
- 가장 높은 후보가 선택된다. 그 후보가 잘못되었거나 설치되지 않았으면 throw하고, 아래 tier로 내려가지 않는다. 결과에는 `equivalentSources`와 `shadowedSources`가 함께 보고된다.
- 환경변수 pair는 `OMS_EMBEDDING_PROVIDER`/`OMS_EMBEDDING_MODEL`, `OMS_RERANK_PROVIDER`/`OMS_RERANK_MODEL`, `OMS_GENERATE_PROVIDER`/`OMS_GENERATE_MODEL`이다 (`config.ts:55-59`). pair 중 하나만 있으면 오류다. 앞뒤 공백도 거부한다 (`config.ts:297-303`). 환경변수 provider는 `gguf`만 허용한다 (`config.ts:250`).
- 불가 안내 문구는 `capabilityGuidance` 한 곳에서 만든다. embed 안내에만 `embedding.model`이 들어간다 (`config.ts:331-338`).

### 4. 임베딩 lineage는 불변이고 정확히 일치해야 한다 (`src/kernel/engine/embed/identity.ts`)

- meta version은 `oms-embed-meta-v3`다 (`identity.ts:4`).
- fingerprint는 meta version과 provider·model·revision·sha256·dimensions·contextLength·mrlDim·normalization·prefixScheme을 `\0`으로 이은 SHA-256이다 (`identity.ts:58-74`). identity를 검증할 때 fingerprint를 다시 계산한다 (`identity.ts:34-55`, `:77-86`).
- store meta version이 다르거나 fingerprint가 다르면 `force` 없이 쓰지 않는다. `--force`를 안내하는 `available:false`로 끝난다. migration이나 dual-read는 없다 (`src/kernel/engine/embed/sync.ts:922-962`). 재구축 절차는 → ADR-003.
- 차원이 맞지 않으면 throw한다 (`sync.ts:882-887`). descriptor override는 거부한다 (`sync.ts:836-870`).

### 5. native 차원 무결성: 투영·폴딩·절단 없음 (`provider.ts`)

- provider 출력에는 L2 정규화만 한다. non-finite 값이 있으면 throw한다 (`provider.ts:72-92`).
- vec0 테이블은 provider의 차원 그대로 만든다 (`src/kernel/engine/assemble.ts:573`, → ADR-003).

### 6. 가짜 임베더 없음, 테스트 스텁은 test-helper에만 (`provider.ts`, `sync.ts`)

- production provider는 GGUF/node-llama-cpp 하나뿐이다. hash stub은 `hash-stub.test-helper.ts`에만 있다 (`provider.ts:4-7`).
- `requireRealEmbeddingProvider`는 provider나 model이 없으면 guidance로 throw하고, `gguf`만 받는다 (`provider.ts:479-523`, `sync.ts:~872`).
- `embed=false`는 lexical 전용이다. 해시 fallback 벡터는 만들지 않는다 (`sync.ts:1-8`, `:798-834`).
- provider는 lazy 로드하고, idle이면 unload하며, dispose는 한 번만 한다 (`provider.ts:229`).

### 7. 런타임은 다운로드하지 않는다 (`model.ts:551-561`)

- `resolveEmbeddingModel`은 다운로드하지 않는다. `acquireModelSet`을 부르는 CLI는 `oms model install` 하나다 (`src/cli/model-command.ts:124`). `oms setup`은 모델을 설치하지 않는다.
- plain query는 lexical이다. 임베딩 필요 여부는 → ADR-004 §2.

### 8. 기본 모델과 prompt scheme (`model.ts`, `provider.ts`)

- setup 기본 embed 모델은 `embeddinggemma-300M-Q8_0.gguf`다. revision과 sha256이 고정되어 있고, 768차원, context 2048, l2 정규화, https URL이다 (`model.ts:144-158`, `provider.ts:29-32`). 명시적 setup으로 설치한 실제 모델이므로 가짜 폴백이 아니다.
- embed scheme은 `embeddinggemma-v1`, `qwen3-embedding-v1`이다. generate scheme은 `qmd-query-expansion-v2.8.3`이다. capability마다 허용 scheme을 강제한다 (`model.ts:34`, `:98`, `:109`, `:220-222`, `provider.ts:108-139`).

### 미결

- 테스트 스텁을 production이 import하지 못하게 막는 architecture gate(구 ADR-012 D5)의 위치와 동작은 이번에 확인하지 않았다.
- 새 prompt scheme을 추가하는 절차(코드 변경 + meta version 증가 여부)는 문서화된 규칙이 없다.
- rerank/generate 모델 파일의 무결성도 embed와 같은 receipt 재검증을 거치는지는 `verifyArtifact` 공통 경로로 추정되지만 capability별 호출 경로는 확인하지 않았다.

## Alternatives Considered

- **vault descriptor에 절대 weight 경로 저장** — 기각했다. 호스트마다 경로가 달라 이식할 수 없다.
- **느슨한 descriptor·모델 alias 허용** — 기각했다. lineage를 검증할 수 없다.
- **잘못된 설정이나 불가 시 하위 tier·해시 임베더로 묵시적 대체** — 기각했다. 실제로 어떤 모델이 쓰였는지 숨긴다.
- **차원 축소(fold/projection)로 인덱스 제약 맞추기** — 기각했다. 유사도가 왜곡된다.
- **기존 meta의 migration/dual-read** — 기각했다. 재임베딩을 명시적 경계로 둔다.
- **eager 모델 로딩** — 기각했다. 쓰지 않는 capability의 비용을 시작 시점에 치르게 된다.

## Consequences

- 모델을 쓰려면 `oms model install`로 설치하고, 볼트 선언이 필요하면 `oms setup` 뒤 `oms model select`로 `embedding.model`을 쓴다. 오프라인 런타임은 이미 설치된 모델만 쓴다.
- 상위 tier 설정이 잘못되면 하위 기본값으로 대체하지 않고 해석 자체가 막힌다.
- 모델·revision·scheme이 바뀌면 `--force` 재임베딩이 필수다.
- receipt를 로드할 때마다 해시를 다시 계산하므로 큰 GGUF는 로드 비용이 든다.

## 흡수 내역

| 기존 조항 | 처리 |
|---|---|
| 구 ADR-007 P-A native 차원 무결성 | §5 |
| 구 ADR-007 P-A "구 ADR-002 HNSW stale" | → ADR-003 (구 ADR-002 대체) |
| 구 ADR-007 P-B 가짜 임베더 폴백 금지, 스텁은 test-helper | §6 |
| 구 ADR-007 P-B 데드 코드 즉시 삭제 | → ADR-009 (횡단 원칙) |
| 구 ADR-007 P-B provider 없을 때 lex 성공·vec unavailable | §6, → ADR-004 §3 |
| 구 ADR-007 P-B provider 인증 환경변수 안내 | 폐기: 로컬 GGUF 전용, 인증 없음 |
| 구 ADR-007 P-B 런타임 다운로드 금지·실제 기본 모델은 폴백 아님 | §7, §8 |
| 구 ADR-012 D1 tracked identity vs 호스트 검증 분리 | §1, §2 |
| 구 ADR-012 D2 해석 순서·fail-closed·원격 Upstage 제거 | §3 |
| 구 ADR-012 D3 불변 lineage, meta v3, migration 없음 | §4 |
| 구 ADR-012 D3 data-driven prompt scheme | §8 (닫힌 집합으로 정정) |
| 구 ADR-012 D4 reranker 수명 | → ADR-004 §5 |
| 구 ADR-012 D5 lexical 기본·다운로드 금지·가짜 금지 | §6, §7 |
| 구 ADR-012 D5 Identity HyDE / Passthrough 제거 | → ADR-004 §3, §7 |
| 구 ADR-012 Alternatives | Alternatives Considered |
| 구 ADR-012 Follow-ups (벤치마크, qmd 비교 없음) | 폐기: 결정 아님, 후속 작업 메모 |
