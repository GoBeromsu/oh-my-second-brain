---
slug: ADR-008-taxonomy
title: "Taxonomy — 사용자 소유 .oms/taxonomy.json 단일 권위"
status: Superseded
date: 2026-09-24
created_by: claude
deciders: [beomsu]
supersedes: []
superseded_by: ./ADR-007-vault-contract-ontology.md
supersedes_in_part:
  - 구 ADR-003#D1
  - 구 ADR-006#Layer1
relates_to:
  - ./ADR-001-vault-resolution-link-note-identity.md
  - ./ADR-004-search-backend-and-reranking.md
  - ./ADR-006-graph-access.md
  - ./ADR-007-vault-contract-ontology.md
  - ./ADR-009-cross-cutting-principles.md
---

# ADR-008: Taxonomy

## Status

Superseded (2026-09-25) by [ADR-007](./ADR-007-vault-contract-ontology.md). `.oms/taxonomy.json`은 더 이상 읽지 않는다. 역할 A–C(검색 문맥, `folder-ontology` 축, exclusion)는 봉인된 폴더 계약 `folders.json`이 넘겨받았고(`src/kernel/engine/retrieval/template-source.ts:63-72`, :96), 역할 D(write guard)는 ADR-007 §5–§6의 단일 판정자로 옮겼다. 검색 응답 필드 `taxonomyIntents`는 `folderIntents`가 됐다. 아래 본문은 대체 전 기록이며 현재 코드를 설명하지 않는다.

원래 상태: Accepted (2026-09-24). taxonomy를 전담한 ADR은 이제까지 없었다. 구 ADR-003 D1과 구 ADR-006 Layer 1의 taxonomy 부분(두 ADR 모두 이미 구 ADR-015가 Superseded 처리함)을 흡수한다.

## Context

taxonomy는 여러 모듈이 읽는다. 하지만 그 역할을 정한 문서는 없었다. 기존 서술과 코드는 다음과 같이 다르다.

- 구 ADR-003은 oms가 Ataraxia 기반의 의견 있는 default `taxonomy.yaml`을 제공한다고 했지만, 구현은 setup이 taxonomy 파일을 만들지 않는다(`src/cli/setup.e2e.test.ts:18,143`).
- 구 ADR-006은 `taxonomy.yaml`을 vault-lint가 강제하는 기계검증 contract라고 했지만, 구현에는 vault-lint가 없다. taxonomy는 `.oms/taxonomy.json`(JSON)이고, retrieval 문맥·global axis·exclusion·write guard에 쓰인다.
- 구 ADR-003/006의 `taxonomy.yaml`은 구현에서 무시된다. 읽지도, 이전하지도, 보고하지도 않는다(`src/cli/oms-dispatch.test.ts:303-372`). `.oms/taxonomy.yaml`은 control path로도 거부된다(`src/kernel/templates/paths.test.ts:83`).

## Decision

### 1. 권위: 사용자 소유 JSON 파일 하나

taxonomy의 유일한 권위는 vault의 `.oms/taxonomy.json`이다. 이 파일은 사용자가 작성하고, oms는 만들거나 기본값을 심지 않는다(`src/cli/setup.e2e.test.ts:18,143`). 파일이 없으면(ENOENT) 빈 projection이 되고 axis도 비어 있다(`src/kernel/engine/retrieval/taxonomy-context.ts`, `src/kernel/engine/retrieval/template-source.ts:141-174`).

### 2. 역할 A — 검색 문맥(folder intent)

`folders.<path>.intent`는 모델에 주는 폴더 의도 문맥이다.
- `projectTaxonomyIntents`는 순수 함수이며 code-point 순서로 정렬한다. 반환값은 `matched`, `indexedWithoutIntent`, `taxonomyWithoutIndexed`, `warnings`, `promptContext`(`- folder: intent`)다(`src/kernel/engine/retrieval/taxonomy-context.ts`).
- 이 문맥은 query expansion prompt("authoritative taxonomy context", `src/kernel/engine/retrieval/generator.ts:85-90`)와 rerank query(`facade.ts:760`)에 들어간다. `listContexts`(`facade.ts:997-1010`)는 이 문맥을 별도 저장소 없이 노출한다.
- taxonomy는 모델 문맥의 유일한 출처다. 이 모듈은 템플릿 해석도, YAML 파싱도, 쓰기도 하지 않는다. 이 조건은 `test/architecture/taxonomy-context-ssot.test.ts`가 강제한다.
- expansion과 rerank 자체는 → ADR-004이 소유한다.

### 3. 역할 B — global axis `folder-ontology`

`deriveFolderOntologyAxis`는 `folders.<path>.intent`(NFC, trim)로부터 GlobalAxis `folder`를 만든다(`src/kernel/templates/resolver.ts:77-98`). `taxonomyRouting`은 `globalAxes`/`axes`를 읽고, `folder-ontology` 키는 예약한다(`resolver.ts:100-165`). 이 axis는 그래프 seed 필터가 사용한다(→ ADR-006).

### 4. 역할 C — 노트 exclusion

taxonomy의 `exclude` glob 문자열은 vault 안을 가리켜야 한다. 형식이 틀리면 `SOURCE_TAXONOMY_INVALID`, vault 밖을 가리키면 `SOURCE_TAXONOMY_UNSAFE`를 낸다. `DEFAULT_EXCLUDE_GLOBS`는 taxonomy와 무관하게 항상 적용된다. lexical 채널은 exclusion 해석에 실패하면 필터 없이 스캔하지 않고 `NOTE_EXCLUSION_RESOLUTION_FAILED`로 실패한다(`src/kernel/conventions/note-exclude.ts`).

### 5. 역할 D — write guard의 폴더 등록부

Claude pre-tool-use guard(`oms hook pre`)는 taxonomy의 `folders` 키를 등록된 폴더 목록으로 쓴다(`src/vendors/claude/hook/pre-tool-use.ts`).
- 대상은 Write와 Edit뿐이다. 등록되지 않은 최상위 폴더에 쓰면 "run oms setup" 안내와 함께 차단한다.
- 다음 경우에는 fail-open한다: stdin·JSON·taxonomy 오류, taxonomy가 비었을 때, vault 밖 경로.
- `OMS_GUARD=off`이면 guard를 끈다.

### 6. 역할 E — 템플릿 배치 라우팅 (→ ADR-007)

`templates.<id>.templateFolder`와 `folders.<f>.templateId|template|templates`는 템플릿 배치에 쓰인다(`resolver.ts:100-165`). taxonomy가 control file이라는 점과 approval manifest의 `ControlKind "taxonomy"`, `controlGenerationDigest(policy, taxonomy)`(`resolver.ts:280`)는 모두 → ADR-007이 소유한다.

### 7. 실패 보고와 무효화

- taxonomy는 template-source에서 독립 채널이다. 읽을 수 없거나 형식이 틀리면 diagnostic `TEMPLATE_TAXONOMY_UNREADABLE`과 `globalAxes=null`을 보고한다. 빈 계약으로 위장하지 않는다(`template-source.ts:141-174`).
- 검색 경로에서는 오류를 `queryResultUnavailable`로 바꾸고, 그 결과에 taxonomyIntents와 warnings를 담는다(`facade.ts:675-681`). 원칙은 → ADR-009에 있다.
- digest에 taxonomy bytes가 들어가므로, taxonomy가 바뀌면 그래프 cache가 무효화된다(→ ADR-006).
- status 출력에는 `taxonomyContext`가 포함된다(`facade.ts:933-948`). MCP `sourceOfTruth`에는 `.oms/taxonomy.json`과 globalAxes 수가 표시된다(`src/mcp/server.ts:598-602`).
- 링크 해석에서 taxonomy.json을 vault evidence로 쓰는 것은 → ADR-001이 소유한다(`src/kernel/link/link.ts:160-163`).

### 미결

- `scripts/release-artifact-smoke.mjs:165`는 setup이 taxonomy.json을 만들고 YAML을 제거한다고 단언한다. 이는 §1과 e2e 테스트에 어긋난다. 스크립트가 낡은 것으로 보이지만 확인하지 못했다.
- repo 안의 `core/ontology/taxonomy.yaml`(14줄)은 tarball에서 금지 대상이다(`scripts/release-pack.mjs:58-64`). 하지만 파일은 남아 있고, 이 파일의 지위(참고 예시인지 삭제 대상인지)가 정해지지 않았다.
- guard(§5)는 최상위 폴더만 검사한다. 하위 폴더 등록을 검사할지는 결정되지 않았다.
- taxonomy.json의 전체 JSON schema를 문서화한 단일 정의가 없다. 각 소비자가 필요한 필드만 읽는다.

## Alternatives Considered

- **setup이 opinionated default taxonomy를 심는 방식(구 ADR-003 D1)**: 기각했다. 사용자 권위와 하드코딩 금지(ADR-009 §2·§3)에 어긋난다.
- **YAML 유지 또는 자동 migration**: 기각했다. 권위를 JSON 하나로 두고, 은퇴한 형식은 조용히 무시한다(ADR-009 §6).
- **taxonomy를 lint contract로 강제(구 ADR-006 Layer 1)**: 기각했다. 쓰기 검증은 템플릿 계약(→ ADR-007)이 담당하고, taxonomy는 문맥·axis·exclusion·guard만 맡는다.

## Consequences

- taxonomy가 없는 vault에서도 검색과 그래프는 동작한다. 폴더 intent 문맥과 guard만 비활성화된다.
- taxonomy를 바꾸면 모델 문맥, axis, exclusion, cache가 한꺼번에 영향을 받는다.
- 사용자는 폴더 의도를 한 곳에만 쓰면 된다. 별도 context 저장소는 없다.

## 흡수 내역

| 기존 조항 | 이 ADR |
|---|---|
| 구 ADR-003 D1 의견 있는 default 폴더 온톨로지 | 폐기: setup은 만들지 않음. 사용자 소유는 §1 |
| 구 ADR-003 override `vault/.oms/taxonomy.yaml` | §1로 대체(`.oms/taxonomy.json`). YAML은 무시 |
| 구 ADR-006 Layer 1 taxonomy.yaml (lint contract) | 폐기: vault-lint 없음. 역할은 §2–§5 |
| 구 ADR-006 Layer 1 concepts/schemas | → ADR-007 |
| 구 ADR-006 `.oms/` 커밋, `.oms/cache/` 제외 | → ADR-002 |
| 구 ADR-005 §5 taxonomy L-coarse 커뮤니티 | 폐기: 클러스터링 없음(→ ADR-006) |
| 구 ADR-015 runtime은 `.oms/taxonomy.json`을 읽음 | §1 |
