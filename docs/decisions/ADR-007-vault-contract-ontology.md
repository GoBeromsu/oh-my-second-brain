---
slug: ADR-007-vault-contract-ontology
title: "Vault 계약 온톨로지 — 폴더·속성·템플릿 세 봉인 계약과 단일 판정자"
status: Accepted
date: 2026-09-25
created_by: claude
deciders: [beomsu]
supersedes:
  - 구 ADR-013
  - 구 ADR-014
  - 구 ADR-015
  - 구 ADR-016
  - ./ADR-008-taxonomy.md
revises:
  - ./ADR-002-config-secrets-host-state-roots.md#5
  - ./ADR-005-embedding-model-contract-integrity-lifecycle.md#1
relates_to:
  - ./ADR-001-vault-resolution-link-note-identity.md
  - ./ADR-006-graph-access.md
  - ./ADR-009-cross-cutting-principles.md
---

# ADR-007: Vault 계약 온톨로지 — 폴더·속성·템플릿 세 봉인 계약과 단일 판정자

## Status

Accepted (2026-09-25). 도메인 결정의 출처는 deep-interview R1–R24와 spec
`.omc/specs/deep-interview-oms-template-contract.md`이다. 구현 계획은
`.omc/plans/ralplan-oms-vault-contract.md`(v5)이고, 그 §6 수정 목록 (a)–(i)를 이 판에 반영했다.
이 판은 2026-09-25 초판 "템플릿 계약 — 전역·템플릿 두 층 봉인"을 개명·개정한 것이다.
아래 조항은 모두 현재 코드가 하는 일을 `file:line`으로 적는다.

**개정 (2026-09-25, setup 스킬).** §3에 "에이전트가 묻는 봉인"(`setup` 스킬, 두 단계
`--questions`/`--answers`, 단조 규칙)을 추가했다. 이전 판의 "에이전트 스킬로 두지 않는다"와
표 (d)의 "인터뷰 스킬 삭제"는 이 개정으로 바뀐다. 느슨하게 하는 권한은 여전히 터미널에만 있다.

## Context

의도는 단순하다. 사용자가 Obsidian 템플릿 폴더에 Markdown 템플릿을 저장한다. OMS는 볼트에서
계약을 뽑아 사용자와 함께 봉인하고, 에이전트가 쓰는 노트를 **판정만** 해서 볼트 convention을
지킨다.

이전 구현(구 ADR-015, 볼트 안 `template-policy.json` v5)은 이 의도와 두 군데서 어긋났다.

1. **계약이 없으면 모든 쓰기를 막았다.** v5 정책이 없으면 `setup-required`, legacy나 손상된
   정책이면 `review-required`를 냈다. 이 코드(`src/kernel/templates/`)는 삭제됐다.
2. **계약이 에이전트에게 보였다.** `write guide`가 계약 전문을 돌려줬고, 정책과
   `taxonomy.json`이 볼트 안의 평문 파일이었다.

기댈 선행 사례(거인의 어깨)는 셋이다.

- **Palantir Foundry Ontology.** Object Type(종류), Shared Property(한 번 정의하고 여러
  타입이 재사용), Action Type(쓰기 양식 + submission criteria). 이 ADR의 도메인 모델이다.
- **NASEM *Understanding Ontologies*.** 형식성은 목적에 맞춘다. 개인 볼트에는 최소한의
  계약이면 충분하다.
- **[Ouroboros](https://github.com/Q00/ouroboros).**
  - 사용자만 참여하는 인터뷰가 동결된 Seed를 만든다.
  - 작업 에이전트는 공개 요구사항만 받고, 검증 값은 `_HIDDEN_WORKER_KEYS`로 빠진다.
  - Seed는 `~/.ouroboros`에 0600/0700으로 저장된다.
  - 판정은 `orchestrator/policy.py` 하나가 한다. 런타임별 권한은 번역표가 옮긴다.

원칙: **사용자는 볼트를 그냥 쓰고, 에이전트는 계약을 강제당한다.**

## Decision

### 1. 도메인 모델: Palantir 온톨로지 매핑 (R17)

| Palantir | 뜻 | OMS |
|----------|----|-----|
| Object Type | 지식의 종류 | 폴더(폴더 계약의 의미). `type` frontmatter는 속성 사전의 평범한 속성이고, 폴더별 값 고정은 템플릿 `narrowedRules`로만 한다 (R22) |
| Shared Property | 한 번 정의하고 여러 타입이 재사용 | 속성 사전 `properties.json`의 항목 |
| Interface | 공통 모양 | 별도 파일 없음. 기본 속성(`default: true`) 집합이 이 역할을 한다 |
| Action Type + submission criteria | 쓰기 양식 + 쓰기 시점 검증 | 템플릿 계약 + 단일 judge |

- **기본 템플릿은 없다.** 모든 노트에 걸리는 convention은 기본 속성으로 표현한다.
- 템플릿은 종류(Class)가 아니라 쓰기 양식(Action)이다. 속성을 새로 정의하지 않고,
  속성 사전을 **참조하고 좁히기만** 한다.

### 2. 세 계약과 저장 배치 (R15, R18, R19)

```
<vault>/.oms/settings.json            # 공개·사용자 편집: vaultId, templateFolder, embedding, agentRepair
<vault>/.obsidian/types.json          # Obsidian 소유. OMS는 읽기만 (속성 타입)

~/.oms/vaults/                        # 저장소 루트 (store.ts:51-53 `storeRoot`). 환경변수 override 없음
  index.json                          # 볼트 realpath → vaultId 역색인
  .<vaultId>.lock                     # 봉인 잠금 (O_EXCL)
  <vaultId> -> .<vaultId>.<seq>       # 심볼릭 링크. 현재 세대를 가리킨다
  .<vaultId>.<seq>/                   # 0700 한 세대
    manifest.json                     # 0600 파일별 digest. 마지막에 쓴다
    folders.json                      # 0600 폴더 계약: 경로 → { meaning, searchExclude }
    properties.json                   # 0600 속성 사전: 이름 → { meaning, type, default, required, rules }
    templates/<template-name>.json    # 0600 템플릿 계약: { source, sourceHash, applyFolder?,
                                      #   requiredProperties[], narrowedRules, requiredHeadings[] }
~/.oms/guard-events.jsonl             # Claude guard 전달 실패 기록 (guard-events.ts:19 `guardEventsPath`)
```

- **속성 정의는 `properties.json` 한 곳뿐이다.**
  - `default: true` 속성은 템플릿을 고르지 않은 쓰기에도 적용된다.
  - `required`는 봉인할 때 속성마다 정한다.
- **폴더 계약**은 폴더의 의미와 검색 제외를 담는다. 구 `taxonomy.json`의 역할(검색 intent
  문맥, 그래프 `folder-ontology` 축, exclude)을 넘겨받는다. 검색 응답의 wire 이름은
  `folderIntents`다(`src/kernel/engine/mcp/types.ts:166`, `McpSemanticReceipt`).
- **템플릿 계약**의 `applyFolder`는 "이 템플릿이 어느 폴더의 노트를 만드는가"다.
  폴더에 딸린 템플릿 목록은 여기서 파생하고 `folders.json`에 중복 저장하지 않는다.
- 파일 이름은 사람이 읽을 수 있어야 한다. 무작위 seal ID 파일명은 쓰지 않는다.
- **원자 봉인** (`sealContract`, `src/kernel/contract/store.ts:524-595`)
  - `.<id>.lock`을 `wx`·0600으로 만든다(`createLock`, store.ts:478-493; `acquireLock`, store.ts:495-506). 이미 있으면
    `CONTRACT_SEAL_BUSY`다(`acquireLock`, store.ts:500, :505). 같은 host에서 pid가 죽었거나 10분
    (`SEAL_LOCK_STALE_MS`, store.ts:417)이 지난 잠금은 stale로 회수한다(`lockIsStale`, store.ts:454-476).
  - 봉인 시작 때 읽은 세대(`baseSeq`)가 그사이 바뀌었으면 `CONTRACT_SEAL_CHANGED`로 멈춘다(`sealContract`, store.ts:535).
  - 새 세대 디렉터리를 0700으로 만들고, 파일을 0600으로 쓰고, manifest를 마지막에 쓴 뒤
    디렉터리를 fsync한다. 임시 링크 `.<id>.link-tmp`를 만들어 `rename()` 한 번으로 `<id>`를
    교체한다. 교체 전에 실패하면 이전 계약이 그대로 남는다.
  - 교체 뒤 `index.json` 항목을 쓰고(`writeIndexEntry` 호출, store.ts:585) 세대는 N과 N-1만 남긴다(`retained`, store.ts:411-415).
- **볼트 `.oms/`에는 `settings.json` 하나만 둔다.**
  - 계약, 공개 JSON, 원본 해시는 볼트에 두지 않는다.
  - `models.json`은 `settings.json`의 `embedding`으로 합쳤다. 허용 키는
    `version`, `vaultId`, `templateFolder`, `embedding`, `agentRepair`다
    (`KEYS`, `src/kernel/vault/settings.ts:28`). 옛 `templateRoots`는 거부한다.
  - `vaultId`는 첫 봉인 때만 `randomUUID()`로 만들어 `settings.json`에 적는다
    (`ensureVaultId`, `src/kernel/contract/vault-id.ts:92-98`). 비밀이 아니다. 경로에서 파생하지 않으므로
    볼트를 옮겨도 계약이 유지된다.
  - `.oms/` 안의 다른 항목은 읽지 않는다. `oms contract doctor`가
    `unexpected-control-file`로 이름을 보여 준다(`unexpectedControlFiles`, `src/kernel/contract/status.ts:93-104`).

### 3. 계약은 추출하고, 질문지로 완성하고, 사용자가 봉인한다 (R1, R11, R14, R24)

- **원본과 추출**
  - 원본은 템플릿 폴더의 `.md`다. OMS는 원본을 고치거나 복제하지 않는다.
  - `oms contract extract --template <path>`는 frontmatter 속성, heading 후보, 고정 값
    후보를 결정적으로 뽑는다. 출력은 모양(이름, 타입, 변수 여부, 고정 값 존재 여부)만이고
    값은 찍지 않는다(`extract`, `src/cli/contract-command.ts:226-243`).
- **질문지와 봉인**
  - `oms setup`(= `oms contract setup`, `runSetup`, `src/cli/setup-command.ts:43-56`)이 볼트 전체
    (폴더, 속성, 템플릿)를 묻고 봉인한다. 결정적 CLI 질문지다. LLM이 묻지 않고, OMS가 설명
    문장을 만들지도 않는다.
  - 대화형 인터뷰는 터미널이 필요하다. TTY가 아니거나 `OMS_NON_INTERACTIVE=1`이면 거부하고,
    거부 문구가 아래 두 단계 경로를 안내한다(`setup`, contract-command.ts:211-215).
  - 현재 디렉터리에서 추론한 볼트에는 봉인하지 않는다(`runContractCommand`, contract-command.ts:295-298).
  - 템플릿 규칙과 속성 사전 규칙이 모순되면 질문지가 알리고 봉인하지 않는다.
- **재봉인은 변경분만 묻는다 (R24)**
  - 같은 명령을 다시 실행한다. 새 폴더, 새 속성, 원본 해시가 바뀐 템플릿만 묻고 기존 답은
    유지한다(`runInterview`, `src/kernel/contract/interview.ts:526-540`). 세 계약을 새 세대 하나로 봉인한다.
- **템플릿 변수** (`{{date}}`, `{{title}}`, Templater `<% %>`)
  - 추출할 때 타입을 추정하고, 쓸 때는 치환되지 않은 변수가 남으면
    `unsubstituted-variable`로 거부한다(`templateViolations`, `src/kernel/contract/judge.ts:183-186`).
  - OMS는 Templater를 실행하지 않고, 값을 대신 채우지도 않는다.
- **에이전트가 묻는 봉인: `setup` 스킬 (2026-09-25 개정)**
  - Ouroboros의 인터뷰처럼 **질문은 에이전트가 전달하고 답은 사용자가 한다.** 결정적 질문지는
    그대로이고, 에이전트는 질문을 옮기고 답을 받아 적는 통로다. 도구 없는 호스트 스킬
    `assets/skills/setup/SKILL.md`가 이 절차를 적는다. MCP 연산은 추가하지 않는다.
  - 두 단계다. 둘 다 같은 `runInterview`를 스크립트 IO로 돌린다(`scriptedSetup`, contract-command.ts:199-208).
    스킬은 `--questions`나 `--answers` 없이 `oms setup`이나 `oms contract setup`을 실행하지
    말라고 적는다. 대화형 인터뷰는 사용자가 직접 터미널에서 하는 것이다.
    1. `oms setup --questions`는 질문 목록(`{id, prompt, kind, choices?, default?}`)을 JSON으로
       찍고 아무것도 봉인하지 않는다(`scriptedSetup`, contract-command.ts:203-206;
       `publicQuestion`, `src/kernel/contract/scripted-interview.ts:22`).
    2. `oms setup --answers <file|->`는 질문 id → 답 JSON으로 같은 인터뷰를 돌려 봉인한다.
       답이 모자라면 `incomplete`와 남은 질문을 돌려준다. 무효한 답은
       `CONTRACT_ANSWER_INVALID`, 없는 id는 `CONTRACT_ANSWER_UNKNOWN`이고, exit 1이며
       봉인하지 않는다(`scriptedIO`, scripted-interview.ts:53-78). 답 파일은 숨은 값을 담으므로 볼트 안에
       두면 거부한다(`readAnswers`, contract-command.ts:182-196).
  - **단조 규칙.** 스크립트 경로는 `nonLoosening`으로 인터뷰를 돌린다(`runInterview`의 `nonLoosening`, interview.ts:490).
    - 첫 봉인(`never-sealed`, `synced-second-machine`)과 읽을 수 있는 봉인의 재봉인만
      받는다. 복구가 필요한 행은 `refused`다(interview.ts:503-507).
    - 재봉인은 봉인된 계약과 같거나 더 엄격해야 한다. 봉인 직전에 `looseningChanges`가 이전
      계약과 비교하고, 하나라도 느슨해지면 `loosening`으로 끝나 봉인하지 않는다
      (interview.ts:566-569; `looseningChanges`, `src/kernel/contract/loosening.ts:190-214`).
    - "추가"는 허용한다. 새 폴더·속성·템플릿을 등록하는 것은 닫힌 축에 새 항목을 올려 그 축을
      넓히는 일이지만, 이것이 "추가 또는 강화"의 추가다. 새 항목은 봉인된 계약이 거부하던 쓰기를
      받아들일 수 있다(예: 새로 등록한 폴더의 노트). 다만 기존 항목의 판정은 느슨해지지 않는다.
    - 느슨함의 종류(`LooseningKind`, loosening.ts:12-27): 축을 여는 것(`axis-opened`), 폴더·속성·템플릿 제거
      (`removed`), 검색 제외 해제, 속성 타입 변경, 필수 해제, 규칙 제거, allowed 확장,
      fixed 변경, pattern 변경(정규식이 글자 그대로 같아야 한다), range 확장(경계가 같은 타입이고
      더 넓지 않아야 한다), 필수 heading 해제, 템플릿 적용 폴더 변경, 적용 폴더 겹침
      (`apply-folder-overlap`), 오늘의 봉인 검사가 거부하는 봉인된 패턴(`pattern-unsafe`), 봉인된
      템플릿을 더 엄격하게 바꾸는 것(`template-tightened`).
    - 규칙은 같은 종류끼리만 대신한다. 판정은 목록 값의 모든 원소가 allowed에 있어야 하지만
      fixed는 한 원소만 맞으면 된다. 그래서 fixed와 allowed는 값이 늘 하나인 타입(목록 타입이
      아니고 사전에 등록된 속성)에서만 서로 대신한다. allowed를 그 안의 fixed 하나로 좁히는 것은
      그때만 엄격해지는 것이다(`implies`, loosening.ts:46-59).
    - 새로 적용 폴더를 얻는 템플릿이 봉인된 적용 폴더와 같거나, 감싸거나, 그 안에 있으면
      `apply-folder-overlap`이다. 판정은 수정에서 후보 템플릿 중 하나만 통과하면 받아들이므로,
      겹치는 새 후보가 봉인된 템플릿이 거부하던 수정을 통과시킬 수 있다(`overlapChanges`, loosening.ts:143-162).
      겹치지 않는 폴더에 처음으로 적용 폴더를 정하는 것은 느슨함이 아니다. 의미 문장과 기본값은
      비교하지 않는다.
    - 봉인된 템플릿은 더 엄격하게도 바꿀 수 없다. 판정은 수정에서 이전 내용이 통과하던 후보
      템플릿만 강제한다(`templateAxis`, judge.ts:206-214). 그래서 필수 heading·필수 속성·좁힌 규칙을 더하면
      기존 노트가 새 템플릿을 통과하지 못하고, 그 노트의 수정에서는 템플릿 검사가 통째로
      빠진다. 에이전트가 "강화"로 봉인된 템플릿의 강제를 끌 수 있으므로, `--answers`에서
      봉인된 템플릿의 `requiredHeadings`·`requiredProperties`·`narrowedRules`는 그대로여야
      한다. 더한 것은 `template-tightened`로 거부한다(`templateChanges`, loosening.ts:92-141). 예외는 값이 늘
      하나인 타입에서 같은 값 하나를 받는 fixed와 allowed뿐이고, heading은 NFC로 비교한다.
      좁힌 규칙은 속성 사전에 등록된 타입도 검사하므로, 그 속성이 새로 등록되어 타입이
      생기는 것도 강화다. 새 템플릿 추가는 계속 허용하고, 봉인된 템플릿을 바꾸는 일은 더
      엄격하게 하는 것이라도 사용자가 터미널에서 `oms setup`으로 한다. 폴더와 속성 규칙은
      이런 구멍이 없다. 판정은 바뀐 값만 새 규칙으로 검사하고, 이전에 채워져 있던 속성만
      빠졌을 때 거부하며, 이전 내용이 통과했는지에 기대지 않는다. 그래서 속성 규칙 강화는
      계속 허용한다.
    - 0.17.0이 봉인한 1000자 초과 패턴처럼 오늘의 봉인 검사(`patternRefusal`)가 거부하는 봉인된
      패턴은 판정에서 모든 값을 실패시키고, 어떤 대체도 더 느슨하다. 그래서 `--answers`는 이를
      `pattern-unsafe`로 거부하고(`unsafePatternChanges` 호출, interview.ts:516-518), 터미널 재봉인은 그 규칙만 다시 묻고
      나머지 규칙은 유지한다(`askUnsafePatterns`, interview.ts:413-436, 호출 :562). `oms contract doctor`는
      `unsafePatterns`에 `{field, kind}`만 보고하고 `oms setup`을 안내한다
      (`contractDoctor`, `src/kernel/contract/status.ts:121-123`).
    - 거부 결과는 `{field, kind}`만 담고 값은 담지 않는다. 사용자에게 터미널에서 직접
      `oms setup`을 실행하라고 안내한다(`printResult`, contract-command.ts:164-169).
  - **터미널은 전권을 유지한다.** TTY `oms setup`은 `nonLoosening` 없이 돌아 느슨하게 하는
    재봉인과 복구를 모두 할 수 있다(`setup`, contract-command.ts:210-223). 폐기된 setup 플래그는 계속
    거부한다(`RETIRED_SETUP_FLAGS`, setup-command.ts:7-23).
- **사용자 전용 표면.** 에이전트가 쓰는 MCP 표면에는 계약을 게시·수정·열람하는 연산이 없다.

### 4. 공개는 판정 결과만, 규칙 본문은 비공개 (R8, R9, R14)

- **거부 응답**은 `{field, kind}` 목록과 안내 명령 하나만 담는다.
  - 형식: `[oms] write denied: <[{field,kind}] JSON> Run: <guidance>`
    (`formatDenyReason`, `src/kernel/contract/types.ts:139`).
  - `field`는 `path`, `template`, `contract`, `content`, 속성 키, 입력 키 중 하나다. 값,
    패턴, 템플릿 이름은 싣지 않는다.
  - 안내 명령은 kind마다 정확히 하나로 고정돼 있다(`GUIDANCE_FOR`, types.ts:117-136). 쓸 수 있는 명령은
    `oms contract doctor`, `oms contract doctor --fix`, `oms status`, `oms host sync`,
    `oms setup` 다섯 개다(`GUIDANCE`, types.ts:107-113).
- **status**는 계약 상태(`none`/`sealed`/`unreadable`), 고정 문구의 findings, 템플릿 이름별
  drift 상태만 돌려준다(`contractStatus`, status.ts:49-62). 규칙 값, vaultId, 저장소 경로는 싣지 않는다.
- **검색**이 계약에서 가져가는 것은 폴더 경로·의미·검색 제외, 속성 이름·타입·필수 여부,
  템플릿 이름과 참조 속성까지다(`publicProjection`, `src/kernel/engine/retrieval/template-source.ts:67-81`).
- **가림(redaction)**은 봉인 인터뷰 출력에만 건다(`buildRedactor`,
  `src/kernel/contract/redact.ts:39`; `sealGuard`, interview.ts:442-458). 도구 응답은 애초에 값을 담지 않는
  구조로 막는다.
- 노트를 어떻게 쓸지는 에이전트가 템플릿 `.md`를 직접 읽고 판단한다.
- **저장소 열람 차단.** Claude의 네이티브 Read/Grep/Glob과 Write/Edit/MultiEdit/NotebookEdit가
  `~/.oms/**`를 향하면 guard가 `control-path`로 거부한다
  (`main`, `assets/claude/hooks/oms-guard.mjs:360`). Grep/Glob은 조상 경로에서 `.oms`를 가리키는
  패턴도 거부한다(`searchCanReach`, oms-guard.mjs:206-231, 호출 :364). 잔여는 §6과 Consequences (i)에 적는다.

### 5. 판정: 에이전트 쓰기만, 쓸 때만 (R3, R4, R5, R13, R18, R21, R23)

- **MCP `write {path, content, template?}`는 OMS가 판정한 뒤 직접 쓴다**
  (`writeNote`, `src/mcp/server.ts:289-306`).
  - 다른 입력 키나 문자열이 아닌 `template`은 `unsupported-input`, `path`·`content` 누락은
    `missing`이다.
  - 현재 디렉터리에서 추론한 볼트에는 쓰지 않는다.
  - 거부되면 파일은 바이트 단위로 그대로다. 통과하면 원자적으로 쓰고 `{ok: true, path}`만
    돌려준다.
- **계약이 없으면 기본 규칙만 적용한다.** 볼트 경계, 경로 안전, YAML 문법, 그리고 `.oms`
  제어 경로(`control-path`, `basePathKind`, judge.ts:135-144)다.
- **계약이 있으면 닫힌 세계다 (R21).** 계약마다 독립적으로 적용한다(`sealedJudge`,
  judge.ts:232-269).
  - 등록되지 않은 폴더 쓰기는 `unregistered-folder`다. 하위 폴더는 가장 가까운 등록 부모
    폴더를 따르고, 볼트 루트는 등록 폴더가 아니다(`registered`, judge.ts:147-153).
  - 사전에 없는 속성은 `unknown-property`다.
  - 확장은 사용자가 `oms setup`으로 다시 봉인할 때만 한다. 에이전트는 계약을 넓힐 수 없다.
- **속성 사전은 모든 에이전트 쓰기에 적용된다.**
  - 노트에 있는 속성은 봉인된 값 규칙으로 판정한다(`type`, `not-allowed`, `not-fixed`,
    `pattern`, `range`).
  - `required: true` 속성이 빠지면 `missing`으로 거부한다.
  - `default: true`이면서 `required: false`인 속성이 빠지면 쓰기는 성공한다. judge가
    `missingDefaults`를 계산하고(`Verdict`, types.ts:103) MCP `write` 성공 응답이 이를
    `missingDefaults: [{field}]`로 싣는다(`writeNote`, server.ts:305). 값은 싣지 않는다. 채울지는
    에이전트가 판단한다. 누락 장부는 없다.
- **템플릿 축은 후보 집합 판정이며 템플릿을 적용하지 않는다** (`templateAxis`,
  judge.ts:201-221).
  - 템플릿을 고르면 그 템플릿 계약(필수 속성, 좁힌 규칙, 필수 heading)을 통과해야 한다.
    heading은 있는지만 보고 순서와 내용은 자유다.
  - 고른 템플릿의 `applyFolder`와 쓰기 경로가 다르면 `folder-mismatch`다(R23). 하위
    폴더는 상속한다.
  - 템플릿을 고르지 않은 편집은 이전 내용이 통과했던 템플릿만 강제한다. 새 파일은 기본
    규칙과 속성·폴더 계약만 받는다. 이전 내용이 통과한 템플릿을 새 내용이 하나도 통과하지
    못하면 `template-mismatch`다(`templateAxis`, judge.ts:216-219). 편집 이력은 기록하지 않는다.
- **사용자 노트.** Obsidian에서 사용자가 직접 쓴 노트는 검사·차단·수정하지 않는다. 배경
  스캔도 사후 감사도 없다.

### 6. 판정자는 엔진 하나, 런타임 어댑터는 번역만 한다 (R20)

- **판정자는 엔진 judge 하나다** (`judge`, judge.ts:272-286; `judgeWrite`,
  `src/kernel/contract/judge-write.ts:113`). MCP `write`와 `oms hook pre`가 같은 입력
  모양으로 부른다.
- **Claude PreToolUse** (`HOOK_MATCHER`, `READ_MATCHER`, `src/vendors/claude/claude-hooks.ts:8-9`)
  - 쓰기 matcher `Write|Edit|MultiEdit|NotebookEdit`, 읽기 matcher `Read|Grep|Glob`.
  - 둘 다 `oms-guard.mjs`를 부른다. guard는 `~/.oms/**`를 먼저 거부하고, 읽기는 경로만 보고
    끝낸다(`oms` spawn 없음).
  - `OMS_VAULT`·`OMS_AGENT_VAULT`의 realpath 안을 향한 쓰기만
    `oms hook pre --vault <vault>`로 넘긴다(`configuredVaults`, oms-guard.mjs:233-240; `main`, :373-380). 그 밖은 판정 없이
    허용한다.
  - `oms hook pre`는 Edit·MultiEdit의 결과 본문을 재구성해 같은 judge에 넣는다
    (`reconstruct`, `src/vendors/claude/hook/pre-tool-use.ts:74-87`). 네이티브 `.md` 쓰기는 허용하되 판정한다(W-A).
  - 거부는 `hookSpecificOutput.permissionDecision: "deny"`와 §4의 문구로 낸다.
- **전달 실패는 Option A: 허용 + 경고 + 기록** (`TRANSPORT_FAILURE_POLICY = "allow-warn"`,
  oms-guard.mjs:36).
  - spawn 실패, 0이 아닌 종료, 10초 타임아웃, 빈 출력, 잘못된 출력, 내부 오류일 때
    쓰기를 허용한다. stderr에
    `[oms] guard could not reach the judge; write allowed. Run: oms contract doctor`를 한 줄
    쓰고, `~/.oms/guard-events.jsonl`에 `{ts, kind}`를 남긴다(`recordGuardEvent`, `transportFailure`, oms-guard.mjs:156-178).
  - `oms contract doctor`만 이 기록을 읽고 kind별 개수를 보여 준다
    (`readTransportFailures`, `src/kernel/contract/guard-events.ts:24`). judge는 읽지 않는다.
- **fail-closed는 엔진 증거에만 한다.** 이 머신의 봉인 증거와 현재 상태가 어긋나면 그 볼트의
  쓰기를 `contract-unreadable`로 거부한다(`judge`, judge.ts:280-282). 규칙 본문은 싣지 않고, 빈
  계약으로 대체하지 않는다. 봉인 상태는 settings의 `vaultId`(S)와 index 항목(I)으로 정한다
  (`resolveSealState`, vault-id.ts:57-82).

  | 행 | 조건 | 계약 | doctor 안내 (`ROW_FINDING`, status.ts:34-43) |
  |----|------|------|------------------------------|
  | never-sealed | S 없음, I 없음 | 없음(기본 규칙) | `oms setup` |
  | synced-second-machine | S 있음, 이 머신에 저장소 없음 | 없음(기본 규칙) | `oms setup` |
  | store-without-index | S 저장소 있음, I 없음 | S로 적재 | `oms contract doctor --fix` |
  | vault-moved | 위와 같고 다른 경로가 같은 id를 가리킴 | S로 적재 | `oms contract doctor --fix` |
  | sealed | I = S, 저장소 있음 | 적재 | — |
  | index-without-store | I 있음, 저장소 없음 | **unreadable** | `oms setup` |
  | vault-id-tampered | I ≠ S | **unreadable** | `oms contract doctor` |
  | index-corrupt | index 파싱 실패 | S가 있으면 적재, 없으면 없음 | `oms contract doctor --fix` |

  - 적재한 세대의 링크가 끊겼거나, manifest digest가 다르거나, 스키마가 틀리면
    (`link-dangling`, `manifest-mismatch`, `schema-invalid`; `StoreCause`, store.ts:241) 역시 unreadable이다.
  - 복구는 재봉인(`oms setup`)이다. `oms contract doctor --fix`는 store-without-index,
    vault-moved, index-corrupt에서 index만 다시 쓴다(`doctorFix`, status.ts:133-140).
  - MCP `status`는 unreadable이면 `writeTools: "write-disabled-contract-unreadable"`를 보고한다
    (`oms_graph_status` 분기, server.ts:576-598).
- **쓰기 hook이 없거나 확인되지 않은 런타임**(Codex, Hermes, GJC)은 규칙 파일, SOUL, 스킬이
  "볼트 노트 쓰기는 MCP `write`로"를 안내한다. 안내문에는 계약 위치도 값 규칙도 적지 않는다.

### 7. 점진적 공개: 요구사항 → 실패 시 힌트 (R8)

- 거부 응답은 `{field, kind}`와 안내 명령만 담는다. 정확한 규칙은 실패해도 공개하지 않는다.
- 시도 횟수를 세지 않는다. OMS는 노트를 자동 보정하지 않는다. 고치는 일은 에이전트가 한다.
  `settings.json`의 `agentRepair` 키는 형식만 검증하는 사용자 설정이며(`agentRepair` 검증, settings.ts:77-83)
  judge와 `write`는 이를 읽지 않는다.

### 8. drift (R16)

- 템플릿 원본 해시가 봉인 때와 다르면 `drift`, 원본이 없으면 `missing`이다
  (`templateDrift`, `src/kernel/contract/drift.ts:8`).
- drift여도 봉인된 계약으로 계속 판정하고, 쓰기는 막지 않는다.
- `oms contract status`와 MCP `status`가 템플릿 이름별 상태를 보고한다. 자동 재봉인은 하지
  않는다. 재봉인은 §3대로 변경분만 묻는다.
- 이름 변경은 삭제 후 새 템플릿으로 다룬다.

### 9. OMS는 의미를 판정하지 않는다

- 완료 판정 호출도, reviewer 프로토콜도 없다.
- 노트가 쓸 만한지는 에이전트와 사용자가 판단한다.

### 10. 기존 구조는 통째 폐기한다 (R10)

- **폐기한 것**
  - v5 `template-policy.json`과 version 3·4 이전 로직, `src/kernel/templates/`
  - `oms template` CLI, `write guide`·`write check`, `/interview`·`/template` 스킬
  - `.oms/taxonomy.json`, `.oms/models.json`, `.oms/types.json`, `.oms/templates/`
  - Claude PostToolUse 설치와 `oms-post-guard` bin, 선택 세션 바인딩, `OMS_GUARD` 우회 변수
  - 저장소 루트 override 환경변수
- 호환 reader, 자동 변환, alias는 두지 않는다.
- 이전 파일은 읽지 않는다. `oms contract doctor`가 `unexpected-control-file`로 목록을 보여 주고,
  사용자가 백업 위치로 옮긴 뒤 `oms setup`으로 다시 봉인한다.

## 성공 기준

spec의 AC1–AC20과 같다. 요약하면 다음과 같다.

1. 계약이 없는 볼트에서 에이전트가 `write`로 바로 쓴다.
2. 봉인한 뒤에는 규칙을 어긴 노트가 `{field, kind}`와 안내 명령만 받고 거부된다. 고치면
   통과한다.
3. 숨은 값이 볼트 `.oms/`와 모든 도구·CLI 응답에 나타나지 않는다. sentinel 값으로 검증한다.
4. 기본 속성이 빠지면 쓰기는 성공한다. 필수 속성이 빠지면 거부된다.
5. `oms hook pre`와 MCP `write`가 같은 입력에 같은 판정을 낸다. guard 전달 실패는 허용 +
   경고 + 기록이다.
6. 봉인 증거와 현재 상태가 어긋나거나 저장소가 손상되면 `contract-unreadable`로 거부된다.
   봉인 증거가 없으면 기본 규칙만 적용된다.
7. 볼트 `.oms/`에는 `settings.json`만 있다.
8. 사용자가 Obsidian에서 직접 쓴 노트는 어떤 경로로도 수정되거나 차단되지 않는다.

## Alternatives Considered

- **MCP 전용 쓰기(W-B).** 판정 경로 하나, Edit 재구성 불필요.
  - 기각 이유: Bash·외부 편집기는 어차피 막지 못해 보안 이득이 작고, 네 런타임의 네이티브
    편집 경험을 깬다.
- **스냅샷 디렉터리 + `current` 포인터 파일 + 3세대 보존 GC.**
  - 기각 이유: spec 경로 `~/.oms/vaults/<vaultId>/folders.json`이 바뀌고, GC와 reader의
    경합 창이 더 넓다.
- **전달 실패도 막는다(Option B).**
  - 기각 이유: 설치 손상·PATH 문제만으로 봉인 볼트의 네이티브 편집 전체가 멈춘다. 이 우회는
    Bash 권한을 전제하므로 (f)와 같은 부류이고, 막아도 추가 보안 이득이 작다.
- **기본 템플릿으로 공통 convention을 표현한다.**
  - 기각 이유: 템플릿은 Action이지 Class가 아니다. 기본 속성이 같은 일을 흩어지지 않게 한다.
- **기본 속성이 빠지면 모두 거부한다.**
  - 기각 이유: 다시 "아무것도 못 쓰는" 상태가 된다. 필수 여부는 속성마다 사용자가 정한다.
- **속성 규칙을 템플릿 계약마다 따로 정의한다.**
  - 기각 이유: 같은 속성의 규칙이 여러 곳에 흩어져 서로 어긋난다.
- **hook이 계약을 직접 읽고 판정한다.**
  - 기각 이유: 판정자가 둘이 되고, hook이 없는 런타임과 결과가 달라진다.
- **볼트 `.oms/`에 계약이나 공개 JSON을 두고 redaction만 한다.**
  - 기각 이유: 에이전트가 파일을 그대로 읽거나 편집할 수 있다.
- **실패하면 정확한 규칙을 공개한다.**
  - 기각 이유: 한 번 실패하면 규칙을 얻으므로 숨김이 무의미해진다.
- **에이전트 봉인을 금지하고 TTY만 허용한다 (이전 판).**
  - 기각 이유: 에이전트 안에서 일하는 사용자가 터미널로 빠져나가야 첫 봉인을 할 수 있다.
    질문과 답이 사용자의 것이라면 전달 통로가 에이전트여도 봉인의 주인은 바뀌지 않는다.
    위험한 쪽(느슨하게 하기)만 터미널에 남기면 첫 봉인의 문턱이 낮아지고 보호는 줄지 않는다.
- **확인 코드로 재봉인한다.** `--answers`가 터미널에 코드를 찍고, 사용자가 그 코드를 에이전트에
  전하면 느슨한 재봉인도 허용한다.
  - 기각 이유: 코드는 에이전트가 같은 셸에서 읽을 수 있어 사람의 확인을 증명하지 못한다. 결국
    에이전트가 계약을 풀 수 있는 경로가 되고, 느슨하게 하기는 드물어 터미널로 보내도 비용이
    작다.
- 그 밖: 전면 유지, 백지 재작성, 옛 `reissue` 재사용, 단기 선택 기록(쓰기 가능한 상태 채널),
  `taxonomyIntents` 이름 유지, 로컬 토큰 publish, 1.0.0 공개.

## Consequences

- **Breaking 전환이다.**
  - 옛 `.oms/*` 파일은 무시한다. `settings.json`의 `templateRoots`는 거부한다.
  - `oms template`, `/interview`·`/template` 스킬을 삭제했다.
  - MCP `write` 입력은 `{path, content, template?}`뿐이다.
  - 검색 응답의 `taxonomyIntents`는 `folderIntents`가 됐다.
  - Claude PostToolUse 항목, `oms-post-guard` bin, `OMS_GUARD`를 제거했다.
  - hook 거부 출력 형식이 바뀌었고, 쓰기 matcher에 `MultiEdit`, 읽기 matcher
    `Read|Grep|Glob`이 추가됐다.
  - 엔진 증거 기반 fail-closed가 생겼다.
- 사용자는 `oms setup`을 한 번 실행하고 `settings.json`을 정리해야 한다.
- Option A이므로 봉인 볼트에서 `oms` 실행 파일이 깨지면 네이티브 쓰기가 판정 없이 허용되고
  stderr와 doctor로만 드러난다.
- 모든 Read/Grep/Glob에 guard 프로세스 하나가 붙는다(`oms` spawn 없음, 경로 검사만).
- 링크 교체는 POSIX `rename` 원자성에 의존한다. Windows 링크 전략은 미결(OQ16)이다. macOS
  `fsync`는 `F_FULLFSYNC`가 아니며 이를 수용한다.
- **잔여 위험 (f).** Bash로 `~/.oms/vaults`(저장소와 index)를 함께 지우면 봉인 증거가 사라져
  기본 규칙만 적용된다. doctor로만 드러난다.
- **잔여 위험 (i).** Bash `cat`, 패턴에 `.oms`가 없는 조상 경로 검색, Codex·Hermes·GJC의
  네이티브 읽기로 저장소를 열람할 수 있다. "에이전트가 규칙 본문을 보지 않는다"는 출력
  경로(MCP, hook, CLI)에 대해서는 보장하고, 파일시스템 직접 열람에 대해서는 Claude 네이티브
  도구까지만 보장한다. 비공개 보호는 암호학적 보증이 아니다.
- **잔여 위험 (setup TTY).** `oms setup`의 대화형 게이트는 `process.stdin.isTTY`만 본다
  (`setup`, contract-command.ts:211). 에이전트가 `script(1)`이나 `expect(1)` 같은 pty 래퍼로 실행하면
  게이트를 통과해 느슨하게 하는 재봉인까지 전권을 얻을 수 있다. 게이트는 사람의 확인을 요구하는
  관례이지 인증이 아니다. `setup` 스킬은 pty 래퍼와 `--questions`/`--answers` 없는 setup 실행을
  금지한다고 적지만, 이것도 관례다.
- **잔여 위험 (setup 스킬).** 사용자가 답한 숨은 값(allowed 값, 패턴, 범위)은 답을 옮기는
  에이전트의 문맥과 임시 답 파일을 지난다. 스킬은 파일을 볼트 밖에 두고 끝나면 지우며 값을
  옮겨 적지 말라고 적지만, 이는 관례다. `--answers`로 쓸 수 있는 것은 첫 봉인과 더 엄격한
  재봉인뿐이므로, 에이전트가 사용자의 답을 지어내도 기존 봉인을 풀 수는 없다.
- **잔여 위험 (setup 스킬, 새 첫 봉인).** 단조 규칙은 볼트 id에 묶인 봉인에만 걸린다. 에이전트가
  Bash로 볼트를 옮기거나 `.oms/settings.json`을 지우거나 볼트 id를 바꾸면 그 볼트는
  `never-sealed`로 보이고, `--answers`로 새 첫 봉인을 할 수 있다. 이 새 봉인은 이전 봉인과
  비교하지 않는다. guard는 Bash 쓰기를 막지 않으며(잔여 위험 (f)와 같은 부류), 스킬이 이런
  조작을 금지한다고 적는 것이 전부다.
- **잔여 위험 (setup 스킬, 추가 등록).** `unregistered-folder`나 `unknown-property`로 거부된
  에이전트는 폴더를 만들거나 `.obsidian/types.json`에 타입을 넣은 뒤, `--answers`의 "추가"로
  그 폴더나 속성을 등록할 수 있다. 추가는 느슨함이 아니므로 단조 검사가 잡지 않는다. 닫힌
  축은 사용자가 직접 답한다는 전제에 기대며, 이를 기술적으로 강제하지 않는다. 스킬은 새 폴더·속성
  등록을 사용자에게 묻고 에이전트가 스스로 답하지 말라고 적지만, 이것도 관례다.
- **잔여 위험 (동기화된 두 번째 기기).** 볼트가 동기화됐지만 이 기기에 저장소가 없으면
  `synced-second-machine`이고, `--answers`로 첫 봉인을 할 수 있다. 이 봉인은 다른 기기의
  봉인과 비교하지 않는다. 두 기기의 계약은 따로 봉인된다.
- **잔여 위험 (템플릿 강화).** 봉인된 템플릿은 더 엄격하게 바꾸는 것도 사용자의 터미널
  `oms setup`으로만 한다(§3). 사용자가 터미널을 쓸 수 없으면 템플릿은 봉인된 그대로 남는다.
- **잔여 위험 (hook 설정).** guard는 hook이 등록된 Claude 설정 파일(`~/.claude`,
  `$CLAUDE_CONFIG_DIR`, `$OMS_CLAUDE_HOME`, 설정된 볼트의 `.claude/` 아래 `settings.json`,
  `settings.local.json`)에 대한 Write/Edit 계열 쓰기를 거부한다(`hostConfigDirs`…`isHostConfig`, oms-guard.mjs:258-289; `main`, :370). hook
  matcher에 없는 Bash는 guard에 닿지 않으므로, Bash로 이 파일에서 guard hook 항목을 지우면
  이후 네이티브 쓰기·읽기에 판정이 붙지 않는다. 이것은 막지 않는 문서화된 잔여 한계다.
  호스트 점검은 hook 등록이 빠진 것을 보고할 뿐 막지 않는다(host-probe.ts).
- **Grep/Glob deny는 glob을 해석한다.** 검색 경로뿐 아니라 Grep의 `glob`, Glob의
  `pattern`이 절대 경로, `~`, `..`로 `~/.oms`에 닿을 수 있으면 거부한다(`searchCanReach`,
  oms-guard.mjs:206-231). 패턴이 닿지 않는 조상 경로 검색은 (i)에 남는다.
- **ADR 연쇄 변경**
  - ADR-008: Superseded. 역할 A–D(검색 문맥, `folder-ontology` 축, exclude, write guard)는
    폴더 계약과 §6으로 옮겼다.
  - ADR-002 §5, ADR-005 §1: `models.json`을 `settings.json`의 `embedding`으로 바꿨다.
  - ADR-006, ADR-009: taxonomy 인용을 폴더 계약으로 바꿨다.

## 스펙·이전 판 대비 수정 (a)–(i)

| 항목 | 이전 판·spec | 이 판 | 근거 |
|------|--------------|-------|------|
| (a) | 저장소 루트 override 환경변수 | 제거. 테스트는 임시 `HOME`으로 격리 | 우회 환경변수 금지, store.ts:51-53 (`storeRoot`) |
| (b) | 봉인 계약이 걸린 쓰기만 손상 시 거부, 나머지 fail-open | 봉인 증거와 현재 상태가 어긋난 명확한 변조·손상에서도 `contract-unreadable` | vault-id.ts:57-82 (`resolveSealState`) |
| (c) | 전달 실패 fail-open | Option A: 허용 + stderr 경고 + `guard-events.jsonl` 기록 | oms-guard.mjs:36 (`TRANSPORT_FAILURE_POLICY`), :156-178 (`recordGuardEvent`, `transportFailure`) |
| (d) | 인터뷰·템플릿 스킬 | 삭제. 봉인은 사람이 `oms setup`으로 하는 대화형 CLI. 2026-09-25 개정: `setup` 스킬이 사용자에게 묻고 `--answers`로 첫 봉인·더 엄격한 재봉인만 한다 | contract-command.ts:199-223 (`scriptedSetup`, `setup`), loosening.ts:190 (`looseningChanges`) |
| (e) | `taxonomyIntents` | `folderIntents` | engine/mcp/types.ts:166 (`McpSemanticReceipt`) |
| (f) | 언급 없음 | Bash로 저장소·index를 지우는 경로를 잔여 위험으로 수용 | Consequences |
| (g) | 저장 배치만 | `index.json`과 진리표, `.<id>.lock`과 stale 규칙, `manifest.json`, N-1 보존 | store.ts:411-595 (`retained`…`sealContract`) |
| (h) | `templateRoots`, kind 목록, 안내 문구 | `templateFolder`, kind 추가(`control-path`, `template-mismatch`, `unsupported-input`), 템플릿 축은 적용 없이 판정만, deny 형식, 안내 명령 고정 | `src/kernel/vault/settings.ts:12` (`VaultSettings`), :28 (`KEYS`); types.ts:62 (`ViolationKind`), :107-143 (`GUIDANCE`…`formatDenyReason`) |
| (i) | `~/.oms` 읽기는 막지 않음 | Claude Read/Grep/Glob은 guard로 막고, 나머지 읽기 경로는 잔여 위험으로 수용 | oms-guard.mjs:360, :364 (`main`, `searchCanReach`) |
| — | `write`가 `missingDefaults`를 응답 | judge가 계산하고 `write` 성공 응답이 `{ok, path, missingDefaults: [{field}]}`로 싣는다 | server.ts:305 (`writeNote`) |
| — | 도구 응답을 반환 직전 redaction | 응답은 구조상 값을 담지 않음. redaction은 인터뷰 출력에만 | redact.ts:39 (`buildRedactor`) |

## Follow-ups

- GJC·Codex·Hermes의 pre-write·read-side hook 지점이 확인되면 번역층을 추가해 (i)를 줄인다.
- `guard-events.jsonl` 누적이 잦으면 Option A를 재검토한다.
- 봉인 저장소 백업·이전 가이드.
- Windows 링크 전략(OQ16).
- 1.0 안정화 기준.

## 흡수 내역

| 기존 조항 | 이 ADR | 비고 |
|-----------|--------|------|
| 013 폴더 원본·인터뷰 파생 controls | §3 | CAS·ledger·anchor는 폐기 |
| 014 사용자 소유 권위 | §3, ADR-009 | 완료 하네스·reviewer는 폐기 |
| 015 v5 정책·CAS 게시·history, version 3·4 이전 | — | 폐기: §10 |
| 015 common 계약, 완화 허용 합성 | §2 속성 사전 | 좁히기만 허용 |
| 015 완료 호출 없음, retry 미집계 | §7, §9 | |
| 015 drift는 승인이 아님 | §8 | |
| 015 읽을 수 없는 control은 고유 상태 | §6 `contract-unreadable` | |
| 016 전체 | §1–§10 | |
| ADR-008 역할 A–D | §2 폴더 계약, §6 | ADR-008 Superseded |
