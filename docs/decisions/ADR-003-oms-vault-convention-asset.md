---
title: oms = Vault-Convention 자산 — Default 온톨로지 + Vault-ADR 투명성
status: Accepted
date: 2026-06-13
created_by: claude-code
deciders: [beomsu]
relates_to:
  - ../exec-plan/active/self-owned-second-brain/spec.md §10
  - ../exec-plan/active/self-owned-second-brain/spec.md §11
  - craft-skills `documents` 스킬 (ADR/research/spec/rule 규율 대칭)
---

# ADR 003: oms = Vault-Convention 자산 — Default 온톨로지 + Vault-ADR 투명성

## Status

Accepted

## Context

oms는 단순 검색·임베딩 엔진에서 self-owned second-brain **convention 시스템**으로 진화 중이다.

craft-skills의 `documents` 스킬은 코드 repo에 ADR/research/spec/rule 규율을 부여한다. 동일 규율을 **vault 구축**에 적용하면, vault의 조직 전략이 암묵지(tribal knowledge)에서 *읽을 수 있는 결정문서*로 전환된다.

oms는 이미 다음을 보유한다:

- ontology defaults: `concepts/*.yaml` 16개 + `taxonomy.yaml`
- host로 publish되는 skill 메커니즘

그러나 사용자(소유자 포함)는 자신의 vault가 *왜* 이 구조이고 *어떤 전략*으로 구성되는지 현재 명시적으로 알 수 없다. 구조적 결정이 침묵 속에 이뤄진다.

### craft-skills `documents` 스킬과의 대칭

`documents` 스킬은 코드 repo에서 ADR/spec/rule을 1급 자산으로 다룬다. oms가 vault에 대해 동일 역할을 수행해야 한다는 논리적 대칭이 성립한다:

| 대상 | 규율 도구 |
|------|----------|
| 코드 repo | craft-skills `documents` 스킬 |
| **Vault (지식 repo)** | **oms vault-convention 자산** ← 이 ADR |

### spec §10/§11과의 연결

- §10 (Ontology 3층 전략): L-coarse 폴더 온톨로지를 `taxonomy.yaml`로 시드한다고 명시하지만, 그 default를 *누가 어디서 제공하는지* 불명확
- §11 (Access Model): `.oms` 마커가 권한·provenance를 공급하지만, vault 안에 전략 결정을 기록하는 메커니즘이 없음

## Decision

oms는 다음 세 항목을 **1급 자산(shipped asset)**으로 제공한다.

### 1. 의견 있는 Default vault 폴더 온톨로지

spec §10 L-coarse 층에 해당하는 default `taxonomy.yaml`을 **Ataraxia 구조를 레퍼런스 구현(dogfood)으로 삼아 추출**해 제공한다.

- Ataraxia가 reference implementation: 실증된 번호폴더(00 Inbox·10 Time·30 Literature·40 Permanent·50 AI·70 Collections·80 References·95 Decisions 등)을 default로 추출
- 신규 사용자는 이 검증된 구조에서 출발, 시행착오 없이 vault를 시작 가능
- 사용자는 `vault/.oms/` config로 override 가능 — opinionated이되 강제 아님

### 2. Vault-ADR / 전략 투명성 메커니즘

oms가 vault를 scaffold·재구성할 때 침묵하지 않고, **사람이 읽는 결정/전략 노트를 vault 안에 기록**한다.

- Ataraxia의 기존 `95. Decisions` zone을 일반화한 패턴
- 모든 구조 변경 = vault 내 읽을 수 있는 ADR
- 에이전트가 만든 결정도 vault Routing Law(`created_by` + agent-writable zone) 준수 아래 기록됨

### 3. oms 소유 skill 2개

위 두 항목을 작동시키는 oms-owned 스킬:

| 스킬 | 역할 |
|------|------|
| `vault-init` / `vault-scaffold` | default taxonomy를 기반으로 vault 초기 구조 생성 |
| `vault-decision-record` | 구조 변경 시 vault 안에 ADR 자동 기록 |

ADR 규율 자체를 내부 dev 관행이 아니라 *제품이 shipping하는 자산*으로 취급한다.

## Alternatives Considered

### (A) 암묵적/침묵 convention — 기각

구조 결정을 기록하지 않고 Ataraxia 형태를 그대로 유지하는 방식. 유저에게 불투명하고, oms가 왜 이 구조를 만들었는지 알 수 없다. self-owned second-brain의 핵심 가치(자기 지식의 완전한 이해·소유)에 반한다.

### (B) 완전 generic — default 없음 — 기각

사용자가 온톨로지를 맨바닥부터 설계해야 하는 방식. §10 "위에서 설계하지 마라" 원칙(과설계 실패모드)과 모순되며, 출발점 없는 신규 사용자에게 진입장벽이 된다. 기각.

### (C) per-user 전용(공유 불가) — 기각

Ataraxia 구조를 비공개 설정으로만 유지하는 방식. oms가 shipping하는 공유 가능한 default 자산이 되지 못한다. 커뮤니티에 이익을 줄 수 있는 검증된 구조를 사장시킨다. 기각.

## Consequences

**구현 요구사항:**

- Ataraxia `taxonomy.yaml`을 추출·정제해 oms shipped default로 제공해야 함
- vault에 decisions/strategy zone 필요(Ataraxia `95. Decisions` 일반화)
- override 경로(`vault/.oms/taxonomy.yaml`) 구현 필수 — opinionated default이므로 탈출구 보장
- 투명성 노트는 vault write surface 증가 → vault Routing Law 준수 필수(`created_by` 필드 + agent-writable zone)
- 새 oms 스킬 2개 추가(`vault-scaffold`, `vault-decision-record`)

**긍정적 결과:**

- 신규 사용자가 검증된 vault 구조에서 출발 가능
- vault 구조 변경 히스토리를 vault 자체에서 추적 가능
- oms가 단순 도구에서 convention을 제공하는 플랫폼으로 격상
- craft-skills `documents` 스킬과 대칭적 규율 — 코드 repo와 vault repo 동일 원칙 적용

**트레이드오프:**

- default가 opinionated → 다른 vault 구조 사용자에게 마찰 가능성. override 경로로 완화.
- vault write 증가 → 에이전트 write zone 설계 신중 필요

## Notes

- Ataraxia `95. Decisions` zone이 이 ADR의 proof-of-concept: vault 안 ADR이 이미 작동함을 실증
- craft-skills `documents` 스킬과의 대칭은 의도적 설계 원칙 — "코드 repo에 하는 것을 vault에도"
- `vault-scaffold` 스킬 구현 시 §11의 `.oms` 마커 write zone 설계와 통합해야 함
- spec §12에서 이 결정을 3-5 bullet 요약으로 참조
