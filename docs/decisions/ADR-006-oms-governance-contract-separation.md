---
title: .oms 거버넌스 — 기계검증 계약(yaml) ↔ 의도 기록(documents)의 명시적 분리
status: Accepted
date: 2026-06-13
created_by: claude-code
deciders: [beomsu]
relates_to:
  - ./ADR-003-oms-vault-convention-asset.md
  - ../exec-plan/active/self-owned-second-brain/spec.md §10
  - ../exec-plan/active/self-owned-second-brain/spec.md §11
  - ../exec-plan/active/self-owned-second-brain/deep-interview-record.md R17
  - craft-skills `documents` 스킬 (ADR/research/spec/rule 규율 대칭)
---

# ADR 006: `.oms` 거버넌스 — 기계검증 계약(yaml) ↔ 의도 기록(documents)의 명시적 분리

## Status

Accepted

ADR-003("oms = Vault-Convention 자산")의 *거버넌스* 개념을 **두 개의 명시적으로 분리된 레이어**로 정련(refine)한다. ADR-003을 대체(supersede)하지 않고 그 위에 구조를 부여한다.

## Context

ADR-003은 oms가 vault에 대해 craft-skills `documents` 스킬과 대칭적인 규율을 제공한다고 결정했다(default taxonomy + vault-ADR 투명성 + vault-scaffold/vault-decision-record 스킬). 그러나 ADR-003은 "거버넌스"를 단일 개념으로 다뤘고, 그 안에 **성격이 근본적으로 다른 두 종류의 산출물**이 뒤섞여 있었다.

설계 논의 중 사용자가 이 혼선을 직접 교정했다(verbatim):

> "yaml의 의도는 기계적으로 이름 검증하려는 것이고, documents 스킬 구조를 oms에 두는 것은 우리 obsidian vault의 정책과 폴더 구조 등의 구조가 바뀔 때 의도적으로 기록해두기 위함이야."

> "기계적 검증을 위한 yaml과 의도가 섞여있는 documents는 명시적으로 분리가 되어야 한다고 생각함."

즉 `.oms/` 아래에는 성격이 다른 두 자산이 공존하며, 이를 한 덩어리("거버넌스")로 부르면 lint의 enforcement 대상과 사람의 의사결정 기록이 섞여 양쪽 다 오염된다:

- `taxonomy.yaml` / frontmatter 스키마 / `concepts/*.yaml` = **기계가 읽고 강제하는 계약**. 현재형. 값이 맞나 틀리나만 판정. 역사 없음.
- `documents` 온톨로지(decisions/rules/architecture) = **사람이 읽는 의도·이유 기록**. 역사형. *왜* 이 구조이고 *언제* 무엇이 바뀌었나. supersede로만 갱신.

기존 현실(Ataraxia `.oms/`)에도 이미 둘이 물리적으로 같은 폴더에 있으나(taxonomy.yaml + concepts/ + cache/), 경계가 명문화되지 않아 "taxonomy.yaml = 거버넌스 씨앗"같은 잘못된 프레이밍이 발생했다.

## Decision

`.oms/`(vault·repo 양쪽)는 **명시적으로 분리된 두 레이어**를 보유한다. 한 레이어의 변경이 다른 레이어를 오염시키지 않도록 디렉토리·작성 주체·작성 시점을 분리한다.

### Layer 1 — 기계검증 CONTRACT (lint enforcement 대상)

```
.oms/
├── taxonomy.yaml          # 폴더→intent→concept 맵 (이름 검증의 SSOT)
├── concepts/*.yaml        # note-type별 frontmatter 키/타입/enum/required 선언
└── schemas/               # frontmatter 스키마 (있을 경우)
```

- **성격**: 현재형 계약. "의도한 키만 올바른 값으로 생존하는가"를 기계가 판정하는 enforcement target.
- **소비자**: `vault-lint`(R9) + `oms_validate_contract`(capture 게이트). 사람이 산문으로 읽는 문서가 아니라 파서가 읽는 선언.
- **작성 lane**: checker lane. 변경은 스키마 편집(선언 갱신)이며, *왜* 바꿨는지의 산문은 여기 두지 않는다.

### Layer 2 — 의도 GOVERNANCE (documents 온톨로지)

```
.oms/governance/           # = craft-skills documents 스킬 구조의 vault 적용
├── decisions/ADR-NNN-*.md # 폴더 구조·정책 변경의 cross-cutting 결정 (왜)
├── rules/*.md             # 살아있는 운영 규약 (무엇을)
└── architecture.md        # vault 구조 지도 (살아있는 맵)
```

- **성격**: 역사형 기록. vault의 정책·폴더 구조가 *왜·언제* 이 모양이고 무엇이 바뀌었는지. supersede로만 갱신, 삭제 없음.
- **소비자**: 사람(소유자 포함). self-owned second-brain의 핵심 가치 — 자기 지식 구조의 완전한 이해.
- **작성 lane**: author lane. `vault-decision-record`(ADR-003) 계열 거버넌스 스킬이 의도 ADR을 기록.

### 두 lane은 절대 같은 lane이 아니다 (a+b 병행 = skillify lane 분리)

사용자 sanction: 거버넌스 능력은 **a(author)와 b(checker)가 병행**이어야 한다.

| 레이어 | 스킬 lane | 산출 | 시제 |
|--------|----------|------|------|
| CONTRACT (yaml) | **checker** — `vault-lint` | 정합성 위반 리포트 | 현재형 |
| GOVERNANCE (documents) | **author** — `vault-decision-record` 계열 | 의도 ADR/rule | 역사형 |

작성(author)과 검증(checker)을 같은 active context에서 섞지 않는다(글로벌 규율과 동일). lint가 ADR을 쓰지 않고, 거버넌스 스킬이 taxonomy를 강제하지 않는다.

### `.oms/`는 git에 커밋된다 (omc/omx/omo와 정반대)

- `.omc/` · `.omx/` · `.omo/`는 **gitignore로 은닉**(외부 유출 금지, 사용자 verbatim 규율).
- `.oms/`는 **우리 자신의 자산** → **커밋된다.** 단 `.oms/cache/`(graph.json 등 265MB급 파생물)만 gitignore.
- 함의: repo `.gitignore`에 `.oms/cache/`만 추가. `.oms/` 전체 제외 금지.

### Non-Sticky (ADR-003 / R14와 합류)

- Ataraxia `.oms/`(taxonomy + 95.Decisions)는 **레퍼런스 디폴트(dogfood)** 일 뿐, 하드코딩 금지.
- 설치되는 vault마다 setup-time 인터뷰로 두 레이어를 확립. 두 레이어의 *경계*는 불변, *내용*은 vault별.

## Alternatives Considered

### (A) 단일 "거버넌스" 덩어리 유지 — 기각

taxonomy.yaml과 documents ADR을 한 개념으로 묶는 방식. 사용자가 직접 교정한 혼선의 원천. 기계 enforcement 대상(파서가 읽음, 현재형)과 사람 의사결정 기록(산문, 역사형)을 섞으면 lint가 산문을 파싱하려 하거나 ADR이 스키마로 오해되어 양쪽 다 오염. 기각.

### (B) yaml만 두고 documents 기록은 생략 — 기각

기계 검증만으로 충분하다는 방식. vault 구조가 *왜* 이 모양인지가 침묵 속에 남아 self-owned("자기 지식의 완전한 이해·소유") 핵심 가치에 반함. ADR-003 (A) 기각 논리와 동일. 기각.

### (C) documents를 vault 1급 폴더(예: 95.Decisions)에 직접 두고 `.oms/`는 캐시만 — 기각

거버넌스 산문을 visible vault 폴더에 두는 방식. 사용자가 "명시적인 폴더 대신 `.oms/` 아래에 둬도 되겠다, 우리 oms는 그렇게 구성되어 있지 않나, repo에도 `.oms`가 있도록"이라고 명시 → 거버넌스 substrate는 `.oms/`에 귀속(vault·repo 대칭). 단 Layer 2를 `.oms/governance/`로 분리해 Layer 1(contract)과 디렉토리 레벨에서 갈라놓는다. 기각(혼합형 채택).

## Consequences

**구현 요구사항:**

- `.oms/` 내부를 두 디렉토리 영역으로 분리: contract(taxonomy.yaml/concepts/schemas) ↔ `governance/`(decisions/rules/architecture).
- repo `.gitignore`: `.oms/cache/`만 추가(`.oms/` 전체 제외 아님). `.omc/.omx/.omo`는 기존대로 전체 은닉.
- `vault-lint`(checker lane)는 Layer 1만 enforcement 대상으로 삼음. Layer 2 산문은 lint 대상 아님.
- `vault-decision-record` 계열(author lane)은 Layer 2에만 기록. 두 스킬은 anti-proliferation 비위반(사용자 명시 sanction).
- setup-time 인터뷰가 두 레이어를 vault별로 확립(Non-Sticky).

**긍정적 결과:**

- lint enforcement 대상이 깨끗하게 한정됨 — 파서가 산문을 만나지 않음.
- vault 정책 변경 이력이 역사형 ADR로 추적 가능 — 기계 계약과 분리되어 supersede 규율 유지.
- author/checker lane 분리로 글로벌 "작성과 검증을 같은 context에서 섞지 마라" 규율과 일관.

**트레이드오프:**

- `.oms/` 내부 구조가 2영역으로 늘어남 → setup/scaffold가 두 영역을 모두 시드해야 함.
- 거버넌스 산문이 `.oms/governance/`(dotfolder)에 있어 vault 브라우징에서 덜 보임 → 필요 시 visible MOC에서 링크.

## Notes

- ADR-003을 정련하되 supersede 아님 — ADR-003의 vault-convention 자산 결정은 유효, 본 ADR은 그 "거버넌스"를 두 레이어로 쪼갬.
- Ataraxia `.oms/`(taxonomy.yaml + concepts/ + cache/graph.json 265MB) + `95.Decisions`가 이 분리의 proof-of-concept: 기계 substrate와 사람 ADR이 이미 공존, 본 ADR이 경계를 명문화.
- R17(deep-interview-record)이 이 결정의 인터뷰 잠금 대응.
- 사용자 verbatim 교정이 직접 근거: "기계적 검증을 위한 yaml과 의도가 섞여있는 documents는 명시적으로 분리가 되어야 한다."
