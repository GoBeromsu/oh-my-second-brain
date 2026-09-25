---
slug: ADR-009-cross-cutting-principles
title: "공통 원칙 — 보고형 결과, 사용자 권위, 읽기 무생성, 은퇴 경로 거부"
status: Accepted
date: 2026-09-24
created_by: claude
deciders: [beomsu]
supersedes:
  - 구 ADR-0001
supersedes_in_part:
  - 구 ADR-015#Consequences
  - 구 ADR-006#Non-Sticky
  - 구 ADR-003#D2
  - 구 ADR-003#D3
relates_to:
  - ./ADR-001-vault-resolution-link-note-identity.md
  - ./ADR-002-config-secrets-host-state-roots.md
  - ./ADR-003-local-index-storage-and-fusion.md
  - ./ADR-004-search-backend-and-reranking.md
  - ./ADR-005-embedding-model-contract-integrity-lifecycle.md
  - ./ADR-006-graph-access.md
  - ./ADR-007-template-contract-sealed-two-layer.md
  - ./ADR-008-taxonomy.md
---

# ADR-009: 공통 원칙

## Status

Accepted (2026-09-24). 구 ADR-0001을 대체한다. 구 ADR-015 Consequences(구 ADR-007 명시적 실패 유지, 사용자 권위·하드코딩 금지·Obsidian 타입 읽기 전용)와 구 ADR-006 Non-Sticky를 흡수한다. ADR-001–008의 모든 ADR은 이 원칙을 인용만 하고 다시 서술하지 않는다.

## Context

같은 원칙이 여러 ADR에 반복돼 있었고, 일부는 코드와 달라졌다.

- 구 ADR-0001은 `validateFrontmatter`가 `ValidationResult`를 반환하고 doctor는 항상 exit 0이라고 했지만, 구현에는 `validateFrontmatter`가 없다. `oms doctor`는 은퇴했고 exit 1과 대체 안내를 낸다(`src/cli/oms.ts:38-50,286-300`). 검사 명령은 finding이 있으면 exit 1이다(`src/cli/template-command.ts:59-66`, `src/cli/link-command.ts:238`).
- 구 ADR-006 Non-Sticky는 setup interview가 contract와 governance 두 레이어를 확립한다고 했지만, 구현에는 `.oms/governance/`도 governance 레이어도 없다. setup은 control 파일을 만들어 내지 않는다(`src/cli/setup.e2e.test.ts:18,143`).
- 구 ADR-003 D2/D3는 `95. Decisions` vault-ADR과 skill `vault-scaffold`/`vault-decision-record`라고 했지만, 구현된 skill은 distill, doctor, interview, link, search, status, template, write뿐이다(`skills/`).

## Decision

### 1. 판정은 보고로 돌려준다; throw는 경계와 오용에만

- 검사와 판정 함수는 결과 값을 반환한다. 예: `evaluateContractV5`는 `{valid, structural, semantic, violations}`를 반환한다(`src/kernel/templates/contract-check.ts:161`).
- reader는 diagnostic을 반환한다(`src/kernel/engine/retrieval/template-source.ts`, `src/kernel/conventions/note-exclude.ts`).
- 상태 조회는 오류가 나도 null status를 반환한다(`src/kernel/engine/mcp/facade.ts:1113-1125`).
- throw는 다음 세 경우로 한정한다.
  - 안전 경계 위반: vault confinement(`ensureInside`, `src/kernel/graph/cache.ts`), `assertExternalCachePath`
  - 프로그래머 오용: 예를 들어 body가 문자열이 아니면 `TypeError`(`contract-check.ts:153`)
  - 조용한 오작동을 막는 fail-loud: `NOTE_EXCLUSION_RESOLUTION_FAILED`
- CLI는 보고를 exit code로 옮긴다. finding이나 blocked 상태가 있으면 exit 1이다.

### 2. 명시적 실패 — 빈 결과로 위장하지 않는다

권위 파일이 없거나 읽을 수 없으면 그 이유를 상태로 드러낸다. 빈 계약이나 빈 결과로 대신하지 않는다.
- 검색 경로의 오류는 `queryResultUnavailable`에 warnings를 담아 반환한다(`facade.ts:675-681`).
- taxonomy를 읽을 수 없으면 `TEMPLATE_TAXONOMY_UNREADABLE`을 보고한다(`template-source.ts:141-174`).

임베딩 모델에 관한 구체 사항은 → ADR-005이 소유한다.

### 3. 사용자 소유 권위, 하드코딩 금지

vault의 폴더·필드·persona·taxonomy·템플릿은 사용자가 작성한 파일이 권위다. oms 코드와 setup은 이를 발명하거나 기본값으로 심지 않는다(`src/cli/setup.e2e.test.ts:18,143`). 특정 vault(Ataraxia)의 구조는 repo 안의 참고 자료일 뿐이며 배포물에 들어가지 않는다(`scripts/release-pack.mjs:58-64`). 적용 사례는 → ADR-007(템플릿)과 ADR-008(taxonomy)에 있다.

### 4. 읽기 경로는 아무것도 만들지 않는다

조회·검색·해석 경로는 vault나 파생 상태를 쓰지 않는다. 쓰기는 명시적 명령으로만 한다.
- path 해석은 "Creates nothing"이다(`src/kernel/templates/paths.ts`).
- 본문 lazy-load는 파생 상태를 만들지 않는다(`src/kernel/graph/cache.ts`).
- 그래프 cache는 explicit build만 저장한다(→ ADR-006 §6).
- taxonomy 문맥 모듈은 쓰기를 하지 않는다(`test/architecture/taxonomy-context-ssot.test.ts`).

### 5. 결정적 순서

사용자에게 보이는 목록과 digest 입력은 locale과 무관한 code-point 순서로 정렬한다. 근거:
- `src/cli/setup-command.ts:666`
- `completion-contract.ts:170`
- `note-exclude.ts:78`
- `axes.ts:58`
- `src/kernel/engine/retrieval/taxonomy-context.ts`

### 6. Obsidian 타입은 읽기 전용 관측

`.obsidian/types.json`은 단일 read-only authority adapter로만 읽고, oms는 쓰지 않는다(`src/kernel/contracts/index.ts:66-94`). 이 정보를 계약에 어떻게 반영하는지는 → ADR-007이 소유한다.

### 7. 의미 판정은 agent·사용자의 몫

코드는 구조만 판정한다. 의미 판정은 `semantic: "not-evaluated"`로 남겨 agent와 사용자에게 넘긴다(`contract-check.ts:161`). note body 수정도 oms가 하지 않는다. 예를 들어 `linkify`는 은퇴했다(`src/cli/oms.ts:42`).

### 8. 은퇴한 경로는 거부한다, alias하지 않는다

은퇴한 명령은 대체 명령을 안내하고 exit 1로 끝난다. alias로 동작을 유지하지 않는다(`src/cli/oms.ts:38-50,286-300`). 은퇴한 hook leaf도 같은 방식으로 거부한다(`oms.ts:146`). 은퇴한 파일 형식(taxonomy.yaml)은 이전하지 않고 무시한다(→ ADR-008).

### 9. Vault confinement

oms가 읽고 쓰는 모든 노트 경로는 vault 안으로 해석돼야 한다. 벗어나면 거부한다(§1의 경계 throw). 파생 cache와 host state는 vault 밖에 둔다(→ ADR-002/ADR-003).

### 미결

- 그래프 모듈(`src/kernel/engine/graph/*`)은 `localeCompare`로 정렬한다. §5와 어긋나지만, 이것이 의도인지 확인하지 못했다.
- frontmatter 엣지 키 `sources`/`relations`가 코드에 고정돼 있다(→ ADR-006 미결). §3의 예외인지 결정되지 않았다.
- Result 타입을 공용 타입으로 통일하지 않았다. 모듈마다 결과 형태가 다르다.

## Alternatives Considered

- **판정 실패 시 throw(구 ADR-0001의 기각안)**: 계속 기각한다. 호출자가 보고를 받아 사용자·agent에게 넘겨야 하기 때문이다.
- **doctor exit 0 유지**: 기각했다. CI와 agent가 finding을 exit code로 감지할 수 없다.
- **은퇴 명령 alias 유지**: 기각했다. 공개 표면의 약속이 흐려진다.

## Consequences

- 새 ADR과 새 코드는 이 절을 인용해 throw, 쓰기, 기본값 도입 여부를 판단한다.
- 새 예외를 만들려면(읽기 경로의 쓰기, 하드코딩 키 등) 해당 주제 ADR에 근거를 남겨야 한다.

## 흡수 내역

| 기존 조항 | 이 ADR |
|---|---|
| 구 ADR-0001 validate는 Result 반환, no-throw | §1 (일반화; `validateFrontmatter`는 사라짐) |
| 구 ADR-0001 doctor always exit 0 | 폐기: doctor 은퇴, 검사는 exit 1(§1·§8) |
| 구 ADR-0001 Rejected: throw on violation | Alternatives |
| 구 ADR-015 Consequences: 구 ADR-007 명시적 실패 유지 | §2 |
| 구 ADR-015 Consequences: 사용자 권위·하드코딩 금지 | §3 |
| 구 ADR-015 Consequences: Obsidian 타입 읽기 전용 | §6 |
| 구 ADR-006 Non-Sticky: Ataraxia 하드코딩 금지 | §3 |
| 구 ADR-006 Non-Sticky: setup interview로 두 레이어 확립 | 폐기: governance 레이어 없음, setup은 발명하지 않음 |
| 구 ADR-006 Layer 2 governance·author/checker lane | 폐기: 구현 없음 |
| 구 ADR-003 D2 vault-ADR(`95. Decisions`) 투명성 | 폐기: 구현 없음 |
| 구 ADR-003 D3 skill vault-scaffold/vault-decision-record | 폐기: 해당 skill 없음 |
