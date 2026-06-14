---
slug: external-attribution
date: 2026-06-13
created_by: claude-code
governing-adr: none
status: active
type: rule
---

# Rule: 외부 레퍼런스 출처 명시 및 감사 규칙 (External Attribution & Acknowledgment)

## Rule

이 프로젝트는 외부 오픈소스 repo/skill/tool의 설계·로직·코드·패턴을 적극적으로 흡수(distil/absorb)한다. 무언가를 흡수할 때마다 반드시 출처를 `ACKNOWLEDGMENTS.md`(repo 루트)에 등재하고 명시적 감사를 표한다. 출처가 기록되지 않은 흡수는 미완성이다.

### 7가지 세부 제약

**1. Attribution 의무**

외부 repo/skill/tool/gist의 설계·로직·코드·패턴을 흡수할 때마다, 그 출처를 `ACKNOWLEDGMENTS.md`(repo 루트)에 반드시 등재한다. 빠뜨린 흡수는 미완성으로 간주한다.

**2. 각 항목 필수 필드**

`ACKNOWLEDGMENTS.md`의 모든 항목에는 다음 필드를 포함한다:

- 프로젝트명
- 저자 / 조직
- URL
- 라이선스 (확인된 경우; 미확인이면 `license: unverified`로 표기)
- 우리가 무엇을 배웠/흡수했는지 한 줄 요약
- 명시적 감사 문구

**3. 흡수 종류 구분**

"아이디어/로직 흡수(absorbed logic)"와 "코드 직접 반영(vendored code)"를 구분해 표기한다. vendored code는 원 라이선스 텍스트·고지를 해당 파일 또는 별도 `LICENSE-THIRD-PARTY` 파일로 보존한다.

**4. 라이선스 존중**

라이선스가 요구하는 고지·copyleft 조건을 준수한다. 라이선스 불명 시 코드 vendoring 금지 — 아이디어 차용만 허용하며, 그 사실을 `ACKNOWLEDGMENTS.md`에 명시한다.

**5. distil 스킬 연동**

`distil`(외부 SKILL.md 흡수) 스킬은 흡수 산출물에 attribution 블록 생성을 강제 단계로 포함해야 한다. de-identify는 사용자 개인정보 대상이지, 원저자 크레딧을 지우는 것이 아니다 — 원저자 크레딧은 반드시 보존·표기한다.

**6. 설계 문서 내 인라인 인용**

`docs/research/`, `docs/decisions/` 등 설계 문서에서 특정 출처의 메커니즘을 인용할 때 해당 URL을 인라인으로 단다. `ACKNOWLEDGMENTS.md`는 그 전체 집계 명단이다 — 인라인 인용이 있다고 해서 `ACKNOWLEDGMENTS.md` 등재를 생략하지 않는다.

**7. 감사 톤**

단순 법적 고지를 넘어 진심 어린 감사(genuine thanks)를 표한다. 이들의 공개 작업이 우리 설계를 가능하게 했다.

## Rationale

오픈소스 생태계에서 아이디어와 코드를 자유롭게 배우고 흡수하는 것은 소프트웨어 개발의 핵심이다. 그러나 흡수한 출처를 명시하지 않으면:

- **윤리적 문제**: 타인의 지적 작업에 무임승차한다.
- **법적 위험**: 라이선스 조건(고지 의무, copyleft 등)을 위반할 수 있다.
- **신뢰 손상**: 설계의 지적 계보를 숨기면 프로젝트의 투명성이 낮아진다.
- **지식 손실**: 출처를 기록하지 않으면 나중에 원본으로 돌아가거나 업스트림 변경사항을 추적할 수 없다.

이 규칙은 이 프로젝트의 **1급 윤리·법적 의무**다. 기여자(인간이든 AI이든)가 무언가를 흡수할 때마다 자동으로 이 절차를 따른다.

## Scope

- 이 repo의 모든 코드, 스킬, 설계 문서, 아키텍처 결정에 적용된다.
- 기여자: 인간 개발자 및 AI agent(Claude Code 포함) 모두에게 적용된다.
- 특히 `distil` 스킬 워크플로우, ADR 작성, 설계 리서치 흡수 시 필수다.

## Examples

### Compliant

```markdown
<!-- ACKNOWLEDGMENTS.md 항목 예시 -->

### nvk/llm-wiki

- **저자**: nvk
- **URL**: https://github.com/nvk/llm-wiki
- **라이선스**: Apache-2.0
- **흡수 종류**: absorbed logic
- **흡수 내용**: 멀티에이전트 research fan-out 패턴, Research/Compile/Query 하드 분리, credibility gate.
- **감사**: 공개된 wiki 에이전트 설계 덕분에 컴파일 파이프라인의 분리 원칙을 명확히 세울 수 있었다. 감사드린다.
```

### Non-compliant

```markdown
<!-- 위반: 흡수 후 ACKNOWLEDGMENTS.md 미등재 -->
<!-- wiki.ts 파일 내에 nvk/llm-wiki의 compile 로직을 그대로 반영했으나
     ACKNOWLEDGMENTS.md에 아무 항목도 없음 → 미완성 흡수 -->
```

```markdown
<!-- 위반: 라이선스 불명 상태에서 코드 vendoring -->
<!-- 출처 불명의 gist에서 코드 블록을 복사해 src/에 추가 —
     라이선스 불명 시 아이디어 차용만 허용, 코드 vendoring 금지 -->
```

## Exceptions

없음. 모든 흡수에 예외 없이 적용된다.

단, 다음은 적용 범위 밖이다:
- 공식 npm 패키지 의존성 (package.json에 명시됨): `ACKNOWLEDGMENTS.md` 추가 등재 불필요. 단, 해당 패키지의 설계 패턴을 별도로 흡수했다면 그 사실은 등재한다.
- 일반적으로 알려진 알고리즘/관행(BFS, REST, etc.): 특정 구현체를 흡수한 것이 아닌 한 등재 불필요.

## Enforcement

현재(v0): 코드 리뷰 + convention-only 검증. PR 병합 전 다음 체크리스트를 확인한다.

향후: `distil` 스킬이 attribution 블록 생성 단계를 자동으로 포함하도록 강제한다.

## Verification Checklist

- [ ] 이번 작업에서 흡수한 모든 외부 출처가 `ACKNOWLEDGMENTS.md`에 등재됐는가?
- [ ] 각 항목의 라이선스가 확인됐는가? (미확인이면 `unverified` 표기 + `TODO(verify)` 마커)
- [ ] 각 항목이 "absorbed logic" vs "vendored code" 중 하나로 명확히 구분됐는가?
- [ ] vendored code라면 원 라이선스 고지가 보존됐는가?
- [ ] 라이선스 불명 항목에 코드 vendoring은 없는가?
- [ ] 각 항목에 진심 어린 감사 문구가 있는가?
- [ ] 설계 문서 내 인용에 해당 URL이 인라인으로 달려 있는가?
