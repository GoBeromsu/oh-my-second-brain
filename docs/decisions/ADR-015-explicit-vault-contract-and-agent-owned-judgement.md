---
slug: ADR-015-explicit-vault-contract-and-agent-owned-judgement
title: "명시적 저장소 계약과 에이전트가 소유하는 판단 — 완료 하네스 철회"
status: Accepted
date: 2026-09-24
created_by: gjc
deciders: [beomsu]
relates_to:
  - ./ADR-003-oms-vault-convention-asset.md
  - ./ADR-006-oms-governance-contract-separation.md
  - ./ADR-007-no-fake-embedder-fallback-native-dim-integrity.md
  - ./ADR-014-user-owned-contract-completion-harness.md
---

# ADR-015: 명시적 저장소 계약과 에이전트가 소유하는 판단 — 완료 하네스 철회

## Status

Accepted. ADR-014를 대체한다. ADR-014의 사용자 소유 권위 원칙은 유지하고,
그 문서가 정의한 완료 판정 하네스와 별도 reviewer 프로토콜은 철회한다.

ADR-003과 ADR-006도 함께 대체한다. 두 문서는 `.oms/taxonomy.yaml`,
`concepts/*.yaml`, 그리고 Ataraxia 구조에서 추출한 default 온톨로지를 제품이
제공하는 전제 위에 서 있다. 현재 런타임은 `.oms/taxonomy.json`을 읽고, 어떤
필드·폴더·페르소나도 하드코딩하지 않으며, 번들 note shape을 배포하지 않는다.
`core/ontology/`는 npm 산출물에 포함되지 않는 저장소 내부 참조 스키마로만
남는다.

## Context

ADR-014는 OMS가 기계 검사와 의미 평가를 구분해 "해당 작업의 완료 여부를
판정한다"고 정했고, 호스트의 별도 reviewer가 승인된 의미 기준으로 평가하도록
요구했다. 그 설계는 세 가지 비용을 만들었다.

첫째, OMS가 판정할 수 없는 것을 판정하겠다고 약속했다. 노트가 쓸 만한지는
사용자의 의도에 달린 문제이고, 승인된 rubric·evidence manifest·request digest를
주고받는 프로토콜은 그 판단을 기계적 왕복으로 바꾸려는 시도였다. 실제로 그
프로토콜은 어떤 호스트에서도 신뢰할 수 있게 완결되지 않았다.

둘째, reviewer 역할 정의를 저장소가 설치하면서 "격리가 강제되지 않는다"는
경고를 같은 문서에 함께 실어야 했다. 강제할 수 없는 경계를 설치물로 표현하면,
사용자는 보증이 있다고 읽고 우리는 없다고 쓰는 상태가 유지된다.

셋째, 계약 저장 방식이 이 판정 흐름에 묶여 있었다. 승인된 Markdown 스냅샷,
`.oms/templates/` 관리 초안, 파생 `.oms/types.json` projection은 모두 "무엇을
기준으로 완료를 판정했는가"를 재현하기 위한 구조였고, 사용자의 원본 템플릿
파일을 복제해 두 번째 권위를 만들었다.

## Decision

### 계약은 하나의 명시적 문서다

`.oms/template-policy.json` version 5가 게시된 계약이며 유일한 구조 권위다.
property pool, 항상 적용되는 common 계약, 명시적으로 등록된 각 템플릿을
담는다. common 계약은 자기 Markdown 파일을 갖지 않는다. OMS는 common 필드를
스스로 선언하지 않으므로, common 계약은 게시된 문서가 적은 것만 담는다.
사용자가 필드를 적지 않으면 비어 있고, 첫 게시부터 적으면 그 필드가 곧
common 계약이다. 제품이 기본 필드를 채워 넣는 일은 없다.

등록은 사용자의 원본 Markdown 파일 경로와 내용 해시만 기록한다. OMS는 그
원본을 다시 쓰거나 복제하거나 스냅샷으로 보관하지 않는다. 관리 초안과
승인된 Markdown 바이트는 없다. `.oms/types.json`은 version 4 시절의 파생
파일이며 version 5는 그것을 만들지도 읽지도 않는다.

등록은 common 계약을 상속하고, 사용자가 그 템플릿에 대해 승인한 범위에서
추가·강화뿐 아니라 완화도 할 수 있다. ADR-014의 "추가 전용" 합성 규칙은
이 지점에서 철회한다. 닫힌 값 집합은 `valuePolicy: "closed"`를 선언할 때만
성립하고, allowed values 목록만으로는 제안에 머문다.

게시는 디스크에 있는 정확한 바이트를 대상으로 compare-and-swap한다. 유효한
손편집 정책도 계속 개정할 수 있어야 하고, 동시 변경은 거절되어야 한다.
출력은 정책과 한 건의 history 기록뿐이다.

### 판단은 에이전트와 사용자가 소유한다

OMS에 완료 호출은 없다. `check`는 저장된 바이트에서 선언된 속성과 heading을
읽어 보고하고 `semantic: "not-evaluated"`를 돌려준다. 의미 평가는 연기된
것이며, 평가하지 않았다는 사실을 그대로 보고한다.

별도 reviewer 프로토콜과 설치되는 reviewer 역할 정의는 철회한다. 강제할 수
없는 격리를 설치물로 약속하지 않는다. 에이전트가 필요하다고 판단해 별도
대화에서 검토하는 것은 호스트의 자유이며, OMS가 그 결과를 수집하거나
판정에 사용하지 않는다.

retry budget은 계약에서 사라진다. OMS는 시도 횟수를 세지 않는다.
자동 보정 설정(`agentRepair`)은 계약이 아니라 이동 가능한
`.oms/settings.json`에 있다.

### 변경된 원본은 증거이고 승인이 아니다

기록된 해시와 디스크의 해시가 다르면 그 등록에 대한 drift로 보고한다.
해시 변화는 승인도, 신원도, 인증도 아니다. 승인은 사용자가 현재 digest를
확인할 때만 진행되고 기록된 해시만 전진시킨다. 재연결은 원본이 실제로
사라졌고 사용자가 후보 경로를 정확히 지정할 때만 허용한다.

읽을 수 없는 control은 없는 것도 빈 것도 아닌 고유한 관측 상태로 보고하며,
빈 계약으로 대체하지 않는다.

### 역사적 정책은 의미를 보존하며 이전한다

version 3·4 정책은 계속 읽을 수 있다. 값을 바꾸는 선택이 일어날 때만 제자리
이전하고, 기록된 의미를 보존한다. 증거가 증명되지 않거나 표현할 수 없는
역사적 계약은 덮어쓰지 않고 `review-required`로 보고한다.

## Alternatives Considered

**ADR-014 하네스를 유지하고 프로토콜만 보강한다.** 거부했다. 보강할 대상이
OMS가 판정할 권한이 없는 영역이고, 승인 rubric을 기계 계약으로 만들면
사용자의 의도를 우리가 대신 선언하게 된다.

**reviewer 역할 정의를 선택 자산으로 남긴다.** 거부했다. 그 정의는 request
digest, 승인된 rubric, evidence manifest를 전제하므로 완료 프로토콜 없이는
에이전트가 사용할 수 없다. 사용 불가능한 설치물은 지침과 모순된다.

**승인된 Markdown 스냅샷을 유지한다.** 거부했다. 사용자의 원본 파일이 이미
권위이고, 복제본은 두 번째 권위를 만들어 어느 쪽이 진짜인지 묻게 만든다.

**호환 alias를 남긴다.** 거부했다. 철회한 경로는 삭제하고 거절한다.

## Consequences

`write { op: "complete" }`, `oms note complete`, interview ledger(`interview-next`,
`interview-answer`, `commit-contracts`), `oms template review|answer|commit`,
`doctor regenerate-types`, 그리고 reviewer 역할 자산은 alias 없이 사라진다.
이전 버전이 설치한 Codex 역할 파일은 OMS가 기록한 provenance로 소유를 증명할
때만 `oms host remove`가 정리한다.

MCP 도구 5개, 스킬 8개, CLI family 14개라는 공개 표면은 그대로다. 변경은
표면의 개수가 아니라 그 표면이 무엇을 약속하는지에 있다.

ADR-007의 명시적 실패 원칙은 유지된다. 계약이 없거나 읽을 수 없어도 검색은
이유를 밝히며 계속 동작하고, 빈 결과로 위장하지 않는다.

ADR-014의 사용자 소유 권위, 하드코딩 금지, Obsidian 타입의 읽기 전용 관측
지위는 이 문서에서도 유지된다.
