---
slug: ADR-007-template-contract-sealed-two-layer
title: "Vault 계약 — 폴더·속성·템플릿 세 계약, 사용자 봉인, 단일 판정자"
status: Proposed
date: 2026-09-25
created_by: claude
deciders: [beomsu]
supersedes:
  - 구 ADR-013
  - 구 ADR-014
  - 구 ADR-015
  - 구 ADR-016
supersedes_on_implementation:
  - ./ADR-008-taxonomy.md
revises_on_implementation:
  - ./ADR-002-config-secrets-host-state-roots.md#5
  - ./ADR-005-embedding-model-contract-integrity-lifecycle.md#1
relates_to:
  - ./ADR-001-vault-resolution-link-note-identity.md
  - ./ADR-006-graph-access.md
  - ./ADR-009-cross-cutting-principles.md
---

# ADR-007: Vault 계약 — 폴더·속성·템플릿 세 계약, 사용자 봉인, 단일 판정자

## Status

Proposed (2026-09-25). 도메인 결정은 사용자가 모두 확정했다. deep-interview R1–R20,
ambiguity 0.03, spec은 `.omc/specs/deep-interview-oms-template-contract.md`에 있다.
구현은 ralplan과 승인 뒤에 한다. 구현이 끝나면 Accepted로 바꾸고 ADR-008을 Superseded로
돌린다. 그때까지 코드는 구 ADR-015의 v5 정책과 ADR-008의 taxonomy대로 동작한다.

이 판은 2026-09-24판("전역·템플릿 두 층")을 대체한다. 바뀐 점은 끝의 `개정 내역`에 적었다.

## Context

의도는 단순하다. 사용자가 Obsidian 템플릿 폴더에 Markdown 템플릿을 저장한다. OMS는
그 폴더에서 계약을 뽑아 사용자와 함께 봉인하고, 에이전트가 쓰는 노트를 **검증만** 해서
볼트 convention을 지킨다.

현재 구현(구 ADR-015)은 이 의도와 두 군데서 어긋난다.

1. **계약이 없으면 모든 쓰기를 막는다.**
   - `selectContract`(`src/kernel/templates/service.ts:511-535`)는 v5 정책이 없으면
     `setup-required`를 낸다. legacy 정책이나 손상된 정책이면 `review-required`를 낸다.
2. **계약이 에이전트에게 보인다.**
   - `write guide`는 계약 전문을 돌려준다.
   - `.oms/template-policy.json`과 `.oms/taxonomy.json`은 볼트 안의 평문 파일이다.
     에이전트가 `.oms`를 읽으면 검증이 무의미해진다.

기댈 선행 사례(거인의 어깨)는 셋이다.

- **Palantir Foundry Ontology.** Object Type(종류), Shared Property(한 번 정의하고 여러
  타입이 재사용), Action Type(쓰기 양식 + submission criteria). 이 ADR의 도메인 모델이다.
- **NASEM *Understanding Ontologies*.** 형식성은 목적에 맞춘다. 개인 볼트에는 최소한의
  계약이면 충분하다.
- **[Ouroboros](https://github.com/Q00/ouroboros).**
  - 사용자만 참여하는 인터뷰가 동결된 Seed를 만든다.
  - 작업 에이전트는 공개 요구사항만 받고, 검증 값은 `_HIDDEN_WORKER_KEYS`로 빠진다.
  - Seed는 `~/.ouroboros`에 0600/0700으로 저장된다.
  - `OntologyField.required`가 필드마다 필수 여부를 선언한다.
  - 판정은 `orchestrator/policy.py` 하나가 한다. 런타임별 권한은 번역표
    (`claude_permissions.py`, `codex_permissions.py`)가 옮긴다.
  - `core/ontology_aspect.py`는 `strict_mode=True`(fail-closed)가 기본이다.

원칙: **사용자는 볼트를 그냥 쓰고, 에이전트는 계약을 강제당한다.**

## Decision

### 1. 도메인 모델: Palantir 온톨로지 매핑 (R17)

| Palantir | 뜻 | OMS |
|----------|----|-----|
| Object Type | 지식의 종류 | 폴더(폴더 계약의 의미). `type` frontmatter는 속성 사전의 평범한 속성이고, 폴더별 값 고정은 템플릿 `narrowedRules`로만 한다 (R22) |
| Shared Property | 한 번 정의하고 여러 타입이 재사용 | 속성 사전 `properties.json`의 항목 |
| Interface | 공통 모양 | 별도 파일 없음. 기본 속성(`default: true`) 집합이 이 역할을 한다 |
| Action Type + submission criteria | 쓰기 양식 + 쓰기 시점 검증 | 템플릿 계약 + MCP `write` 판정 |

- **기본 템플릿은 없다.** 모든 노트에 걸리는 convention은 기본 속성으로 표현한다.
- 템플릿은 종류(Class)가 아니라 쓰기 양식(Action)이다. 속성을 새로 정의하지 않고,
  속성 사전을 **참조하고 좁히기만** 한다.

### 2. 세 계약과 저장 배치 (R15, R18, R19)

```
<vault>/.oms/settings.json            # 공개·사용자 편집: templateFolder, 임베딩 모델, vaultId
<vault>/.obsidian/types.json          # Obsidian 소유. OMS는 읽기만 (속성 타입)

~/.oms/vaults/<vaultId>/              # 0700
  folders.json                        # 0600 폴더 계약: 경로 → { meaning, searchExclude }
  properties.json                     # 0600 속성 사전: 이름 → { meaning, type, default, required, rules }
  templates/<template-name>.json      # 0600 템플릿 계약: { source, sourceHash, applyFolder?,
                                      #   requiredProperties[], narrowedRules, requiredHeadings[] }
```

- **속성 정의는 `properties.json` 한 곳뿐이다.** 계약이 흩어지지 않게 하기 위해서다.
  - `default: true` 속성은 템플릿을 고르지 않은 쓰기에도 적용된다.
  - `required`는 봉인할 때 속성마다 정한다. 질문지의 기본값은 `false`다.
- **폴더 계약**은 폴더의 의미와 검색 제외를 담는다. 구 `taxonomy.json`의 역할(검색 intent
  문맥, 그래프 `folder-ontology` 축, exclude)을 넘겨받는다.
- **템플릿 계약**의 `applyFolder`는 "이 템플릿이 어느 폴더의 노트를 만드는가"다.
  Action이 만들 Object Type을 선언하는 것과 같다.
  - 폴더에 딸린 템플릿 목록은 여기서 파생한다. `folders.json`에 중복 저장하지 않는다.
  - 판정 입력이기도 하다(R23, §5). `applyFolder`가 없는 템플릿은 어느 폴더에서나 쓸 수 있다.
- 파일 이름은 사람이 읽을 수 있어야 한다. 무작위 seal ID 파일명은 쓰지 않는다.
- 저장 루트는 `OMS_CONTRACT_STORE_ROOT`로 바꿀 수 있다. 호스트 상태 루트는 ADR-002가 정한다.
- **볼트 `.oms/`에는 `settings.json` 하나만 둔다.**
  - 계약, 공개부 JSON, 원본 해시는 볼트에 두지 않는다.
  - `models.json`은 `settings.json`으로 합친다.
  - `vaultId`는 첫 봉인 때 무작위로 만들어 `settings.json`에 적는다. 비밀이 아니다.
    경로에서 파생하지 않으므로 볼트를 옮겨도 계약이 유지된다.

### 3. 계약은 추출하고, 질문지로 완성하고, 사용자가 봉인한다 (R1, R11, R14)

- **원본과 추출**
  - 원본은 템플릿 폴더의 `.md`다. OMS는 원본을 고치거나 복제하지 않는다.
  - `oms contract extract`는 frontmatter 속성, 필수 heading 후보, 고정 값 후보를
    결정적으로 뽑는다. 같은 입력이면 같은 출력이 나온다.
- **질문지**
  - 결정적 CLI 질문지다. LLM이 묻지 않고, OMS가 설명 문장을 만들지도 않는다.
  - 사용자가 폴더 의미, 속성 의미·타입·기본 여부·필수 여부·값 규칙을 적는다.
  - 템플릿에 고정 값이 있으면 필드마다 "반드시 이 값 / 허용값 중 하나 / 예시"를 묻는다.
  - 템플릿 계약의 규칙과 속성 사전의 규칙이 모순되면 질문지가 알리고 봉인하지 않는다.
- **템플릿 변수** (`{{date}}`, `{{title}}`, Templater `<% %>`)
  - 추출할 때 타입을 추정하고, 쓸 때는 타입만 검사한다.
  - 치환되지 않은 변수가 남은 쓰기는 거부한다.
  - OMS는 Templater를 실행하지 않고, 값을 대신 채우지도 않는다.
- **사용자 전용 표면**
  - 추출, 질문지, 봉인은 CLI에서만 한다.
  - 에이전트가 쓰는 MCP 표면에는 계약을 게시·수정·열람하는 연산이 없다.

### 4. 공개는 구조만, 값 규칙은 비공개 (R9, R14)

| 계약 | 공개 (MCP 응답으로만) | 비공개 (봉인 저장소) |
|------|------------------------|----------------------|
| 폴더 | 경로, 의미, 적용 가능한 템플릿(파생) | — |
| 속성 | 이름, 타입, 기본 여부, 필수 여부, 의미 | 값 규칙(허용값·패턴·고정값) |
| 템플릿 | 이름, 참조 속성, 필수 heading | 좁혀진 값 규칙, 원본 해시 |

- 공개부는 MCP `write`·`status` 응답으로만 전달한다. 볼트 안에 공개 JSON 파일은 없다.
- 노트를 어떻게 쓸지는 에이전트가 템플릿 `.md`를 직접 읽고 판단한다.
- 도구 응답과 거부 메시지는 반환 직전에 숨은 값을 검사해 가린다. 원문뿐 아니라
  따옴표·escape 변형도 검사한다.
- **한계:** 같은 사용자 권한으로 `~/.oms`를 읽는 에이전트는 막지 못한다. sandbox로 막지
  않는다(Ouroboros도 없다). 볼트 밖 저장, 권한, 비공개 응답까지만 보장한다고 적는다.

### 5. 판정: 에이전트 쓰기만, 쓸 때만 (R3, R4, R5, R13, R18)

- **OMS가 대신 쓴다.** 에이전트가 경로와 내용을 `write`에 넘기면 OMS가 판정하고, 통과할
  때만 쓴다. 쓰고 나서 check하는 흐름은 없다.
- **계약이 없으면 기본 규칙만 적용한다.** 기본 규칙은 볼트 경계, 경로 안전, YAML 문법이다.
- **계약이 있으면 닫힌 세계다 (R21).** 계약마다 독립적으로 적용한다.
  - `folders.json`이 봉인돼 있으면 등록되지 않은 폴더 쓰기를 `{field: <경로>, kind: "unregistered-folder"}`로
    거부한다. 하위 폴더는 가장 가까운 등록 부모 폴더의 계약을 따른다.
  - `properties.json`이 봉인돼 있으면 사전에 없는 속성을 `{field: <이름>, kind: "unknown-property"}`로 거부한다.
  - 확장은 사용자가 CLI로 다시 봉인할 때만 한다. 에이전트는 계약을 넓힐 수 없다.
  - 근거: Ouroboros plugin manifest는 `additionalProperties: false`로 모르는 키를 거부하고, 예상 밖
    키만 JSON pointer로 가리킨다(`plugin/manifest.py:1009`). 온톨로지 확장은 Reflect의
    `ontology_mutations`가 새 Seed 세대로 봉인될 때만 일어난다(`evolution/reflect.py:40-60`).
  - 이전의 `setup-required`와 다른 점: 등록된 폴더와 속성 이름은 공개 구조라서 `status`로 볼 수
    있다. 에이전트가 거부 응답을 보고 스스로 고칠 수 있다.
  `setup-required`·`review-required` 기본 거부는 없앤다.
- **선택한 템플릿은 자기 폴더에서만 쓴다 (R23).** 템플릿의 `applyFolder`와 쓰기 경로가 다르면
  `{field: "path", kind: "folder-mismatch"}`로 거부한다. 하위 폴더는 상속하므로
  `applyFolder: Projects`인 템플릿으로 `Projects/A/b.md`에 쓰면 통과한다. 근거: Palantir Action
  Type은 대상 Object Type이 정해져 있어 다른 타입에 제출할 수 없다.
- **속성 사전은 모든 에이전트 쓰기에 적용된다.**
  - 노트에 있는 속성은 봉인된 값 규칙으로 판정한다.
  - `required: true` 속성이 빠지면 `{field, kind: "missing"}`로 거부한다.
  - `default: true`이면서 `required: false`인 속성이 빠지면 쓰기는 성공한다. 응답에는
    `missingDefaults: [이름]`만 담는다. 채울지는 에이전트가 판단한다.
  - 누락을 기록하는 TODO 장부는 없다.
- **템플릿 계약은 에이전트가 템플릿을 고를 때만 적용된다.**
  - 폴더가 템플릿을 강제하지 않는다. 폴더 강제가 "아무 노트도 못 쓰는" 원인이었다.
  - 템플릿을 고른 쓰기는 속성 사전과 템플릿 계약을 모두 통과해야 한다.
  - 템플릿 본문은 필수 heading이 있는지만 본다. 순서와 내용은 자유다.
  - 템플릿에 없는 추가 속성은 속성 사전에 있으면 허용한다.
- **편집**
  - 이전 내용이 템플릿 계약 X를 통과했다면 새 내용도 X를 통과해야 한다.
  - 그렇지 않은 노트는 속성 사전과 기본 규칙만 적용한다.
  - 편집 이력은 기록하지 않는다.
- **사용자 노트**
  - Obsidian에서 사용자가 직접 쓴 노트는 검사·차단·수정하지 않는다.
  - 배경 스캔도 사후 감사도 없다.

### 6. 판정자는 엔진 하나, 런타임 어댑터는 번역만 한다 (R20)

- **판정자는 MCP `write`의 judge 함수 하나다.**
- **Claude PreToolUse hook**(`oms hook pre`)은 얇은 전달자다.
  - 같은 judge 함수를 부른다. 같은 입력이면 같은 판정이 나온다.
  - 규칙을 따로 갖지 않고, 계약 파일을 직접 읽지 않는다.
  - 전달이 실패하면 fail-open한다(크래시, 타임아웃, 잘못된 JSON).
- **쓰기 hook이 없거나 확인되지 않은 런타임**(Codex, Hermes, GJC)
  - 각 런타임의 규칙 파일, SOUL, 스킬이 "볼트 쓰기는 MCP `write`로"를 안내한다.
  - 안내문에는 계약 파일 위치도 값 규칙도 적지 않는다.
- **fail-closed는 엔진에만, 봉인 계약이 손상됐을 때만 한다.**
  - 봉인 계약이 없으면 기본 규칙만 적용한다.
  - 봉인 계약 파일이 있는데 파싱이나 스키마 검증에 실패하면, 그 계약이 걸리는 쓰기를
    `{kind: "contract-unreadable"}`로 거부한다. 규칙 본문은 싣지 않는다.
  - 빈 계약으로 대체하지 않는다. 에이전트가 저장소를 망가뜨려 검증을 우회하지 못하게
    하기 위해서다.
  - `doctor`가 원인과 복구 방법(재봉인)을 알린다.

### 7. 점진적 공개: 요구사항 → 실패 시 힌트 (R8)

- 거부 응답은 `{field, kind}`만 담는다. 예: "`status` 값이 허용 범위 밖입니다."
- 정확한 규칙은 실패해도 공개하지 않는다.
- 시도 횟수를 세지 않는다. 자동 보정(`agentRepair`)도 없다. 고치는 일은 에이전트가 한다.

### 8. drift (R16)

- 템플릿 원본 해시가 봉인 때와 다르면 drift다.
- drift여도 봉인된 계약으로 계속 판정하고, 쓰기는 막지 않는다.
- `status`와 `doctor`가 drift를 보고하고 CLI 재봉인을 안내한다. 자동 재봉인은 하지 않는다.
- 재봉인은 새로 생기거나 바뀐 부분만 묻고, 기존 답변은 유지한다.
- 폴더·속성 추가도 같은 방식이다 (R24). 사용자는 처음 계약을 만든 명령 하나를 다시 실행한다. OMS는
  볼트와 봉인 계약을 비교해 새 폴더, 새 속성, 바뀐 템플릿만 묻는다. 그다음 세 계약을 새 스냅샷
  하나로 원자적으로 봉인한다. 버전 이력은 남기지 않고, 항목별 추가 명령은 두지 않는다. 근거:
  Ouroboros는 Seed를 고치지 않고 `ontology_mutations`를 반영한 새 세대를 봉인한다.
- 템플릿이 삭제되면 `missing`으로 보고한다. 재봉인이나 폐기 전까지는 이전 계약을 유지한다.
  이름 변경은 삭제 후 새 템플릿으로 다룬다.

### 9. OMS는 의미를 판정하지 않는다

- 완료 판정 호출도, reviewer 프로토콜도 없다.
- 노트가 쓸 만한지는 에이전트와 사용자가 판단한다.

### 10. 기존 구조는 통째 폐기한다 (R10)

- **폐기 대상**
  - v5 `template-policy.json`과 version 3·4 이전 로직(`f399f9f9` 포함)
  - `publish-contract`, 계약 전문을 돌려주는 `write guide`, 선택 사항인 `write check`,
    `agentRepair`
  - `.oms/taxonomy.json`, `.oms/models.json`
  - `src/kernel/templates/paths.ts`의 CONTROLS와 관련 경로(transaction, backfill,
    migration, interview, `history/contracts/`, `.template-transactions/`, `.oms/templates/*.md`)
- 호환 reader, 자동 변환, alias는 두지 않는다.
- 이전 파일은 읽지 않는다. `doctor`가 삭제해도 된다고 안내하고, 사용자는 다시 추출하고
  질문지에 답한다.

## 성공 기준

spec의 AC1–AC18과 같다. 요약하면 다음과 같다.

1. 계약이 없는 볼트에서 에이전트가 `write`로 바로 쓴다.
2. 봉인한 뒤에는 규칙을 어긴 노트가 `{field, kind}`만 받고 거부된다. 고치면 통과한다.
3. 숨은 값이 볼트 `.oms/`와 모든 도구 응답에 나타나지 않는다. sentinel 값으로 검증한다.
4. 기본 속성이 빠지면 쓰기는 성공하고 `missingDefaults`로 알린다. 필수 속성이 빠지면
   거부된다.
5. `oms hook pre`와 MCP `write`가 같은 입력에 같은 판정을 낸다. hook 전달 실패는 fail-open이다.
6. 봉인 계약 파일을 손상시키면 `contract-unreadable`로 거부된다. 파일이 없으면 기본 규칙만
   적용된다.
7. 볼트 `.oms/`에는 `settings.json`만 있다.
8. 사용자가 Obsidian에서 직접 쓴 노트는 어떤 경로로도 수정되거나 차단되지 않는다.

## Alternatives Considered

- **기본 템플릿으로 공통 convention을 표현한다.**
  - 기각 이유: 템플릿은 Action이지 Class가 아니다. 선택하지 않은 쓰기에 적용할 근거가 없다.
    기본 속성이 같은 일을 흩어지지 않게 한다.
- **기본 속성이 빠지면 모두 거부한다.**
  - 기각 이유: 다시 "아무것도 못 쓰는" 상태가 된다. 필수 여부는 속성마다 사용자가 정한다.
- **속성 규칙을 템플릿 계약마다 따로 정의한다.**
  - 기각 이유: 같은 속성의 규칙이 여러 곳에 흩어져 서로 어긋난다.
- **폴더 계약에 템플릿 목록을 둔다.**
  - 기각 이유: `applyFolder`와 중복 저장된다.
- **hook이 폴더 계약을 직접 읽고 판정한다.**
  - 기각 이유: 판정자가 둘이 되고, 런타임마다 규칙이 갈라진다. hook이 없는 런타임과 결과가
    달라진다.
- **hook·전달 실패도 fail-closed로 한다.**
  - 기각 이유: 전달 계층의 고장이 사용자의 노트 작성을 막는다. 봉인 계약 자체가 손상된
    경우만 fail-closed가 필요하다.
- **볼트 `.oms/`에 계약이나 공개 JSON을 두고 redaction만 한다.**
  - 기각 이유: 에이전트가 파일을 그대로 읽거나 편집할 수 있다.
- **SQL catalog(schema/table/domain) 비유를 기준으로 삼는다.**
  - 기각 이유: 사용자가 기준으로 삼은 자료는 Palantir 온톨로지다.
- **실패하면 정확한 규칙을 공개한다.**
  - 기각 이유: 한 번 실패하면 규칙을 얻으므로 숨김이 무의미해진다.
- **`~/.oms` 읽기를 sandbox나 hook으로 막는다.**
  - 기각 이유: 특정 런타임에 의존한다. Ouroboros도 하지 않는다.

## Consequences

- **breaking 전환이다.** v5 정책, taxonomy, models 파일 사용자는 한 번 다시 추출하고
  질문지에 답해야 한다.
- **쓰기 경로가 "OMS가 판정한 뒤 쓴다"로 바뀐다.**
  - 에이전트가 파일 도구로 볼트에 직접 쓰는 것은 Claude hook만 가로챈다.
  - 다른 런타임에서는 안내문에 의존한다.
- **ADR 연쇄 변경**(구현 시점)
  - ADR-008: Superseded. 역할 A–D(검색 문맥, `folder-ontology` 축, exclude, write guard)는
    폴더 계약과 §6으로 옮긴다.
  - ADR-002 §5, ADR-005 §1: `models.json`을 `settings.json`으로 바꾼다.
  - ADR-006, ADR-009: taxonomy 인용을 폴더 계약으로 바꾼다.
- 비공개 보호는 암호학적 보증이 아니다. 사용자 안내에 그대로 적는다.
- GJC의 쓰기 hook 지원 여부는 확인하지 못했다. ralplan에서 확인한다.
- 미리 만든 `src/kernel/contract/*`와 `src/cli/contract-command.ts`(untracked)를 유지할지,
  고칠지, 버릴지는 ralplan에서 정한다.
  - 이 ADR과 충돌하는 부분: 무작위 seal ID 파일명, `PublicField.description`,
    `.oms/contract-public.json`.
- 구현한 뒤 simplify와 code-review를 별도 패스로 진행한다.

## 개정 내역 (2026-09-24판 대비)

| 2026-09-24판 | 이 판 | 근거 |
|--------------|-------|------|
| 전역·템플릿 두 층, "공통 규칙" | 세 계약(폴더·속성·템플릿). 공통 convention은 속성 사전의 기본 속성 | R15, R17, R18 |
| 공개부 설명 문장을 OMS가 초안 작성 | 설명 생성 없음. 의미는 사용자가 적고, 에이전트는 템플릿을 직접 읽음 | R14 |
| 볼트 `.oms/`에 `vault-id`, 공개부, 원본 해시 | `.oms/`에는 `settings.json`만. `vaultId`는 그 안에 | R14, R15 |
| taxonomy는 ADR-008이 소유 | 폴더 계약으로 흡수 | R15 |
| hook은 taxonomy 기준 가드. 확장은 Claude 전용 옵션 | hook은 같은 judge를 부르는 전달자. 다른 런타임은 안내문 | R20 |
| `unreadable`에 "맞는 저장소 없음"도 포함 | 계약 없음 = 기본 규칙. 파일이 있는데 손상된 경우만 거부 | R4, R20 |
| 편집 규칙 미정 | 이전 내용이 통과한 템플릿 계약을 유지, 기록 없음 | R13 |
| 계약에 없는 폴더·속성은 암묵 허용 | 봉인된 축은 닫힌 세계, 계약별 독립, 하위 폴더 상속 | R21 |
| `type`이 폴더 종류를 정함 | `type`은 속성 사전의 평범한 속성 | R22 |
| `applyFolder`는 공개 구조일 뿐 | 판정 입력. 다른 폴더에 쓰면 `folder-mismatch` | R23 |
| 확장 방법 미정 | 같은 명령 재실행, 변경분만 설문, 스냅샷 원자 봉인 | R24 |

## 흡수 내역

| 기존 조항 | 이 ADR | 비고 |
|-----------|--------|------|
| 013 폴더 원본·인터뷰 파생 controls | §3 | CAS·ledger·anchor는 폐기 |
| 014 사용자 소유 권위 | §3, ADR-009 | 완료 하네스·reviewer는 폐기 |
| 015 v5 정책·CAS 게시·history, version 3·4 이전, `agentRepair` | — | 폐기: §7, §10 |
| 015 common 계약, 완화 허용 합성 | §2 속성 사전 | 좁히기만 허용 |
| 015 완료 호출 없음, retry 미집계 | §7, §9 | |
| 015 drift는 승인이 아님 | §8 | |
| 015 읽을 수 없는 control은 고유 상태 | §6 `contract-unreadable` | |
| 016 전체 | §1–§10 | |
| ADR-008 역할 A–D | §2 폴더 계약, §6 | 구현 시 ADR-008 Superseded |
