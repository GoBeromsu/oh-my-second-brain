# 해석물을 일급 입력으로 승격했을 때의 계약 안전성 (LANE 1)

`origin/main` = 0.18.3 (`59e96ef`) 기준. 코드 변경 없음. 근거는 전부 이 커밋의 파일·라인 인용이며,
분류 결과는 `test/contract-loosening-scope.test.ts`가 고정한다.

승인된 계획: `.omh/plans/2026-09-26T164507392970Z-replace-oms-deterministic-template-pre-analysis-with-agent-inter-e2222e.md`

## 결론 요약

| 항목 | 판정 |
|---|---|
| `fix/oms-scoped-template-repair` 재사용 | **불가.** 그 브랜치가 고치는 파일은 main에서 전부 삭제됐다 |
| 봉인된 계약을 제출물이 넓힐 수 있는가 (reseal) | **넓힐 수 없다.** `looseningChanges`가 잡는다 (증거 있음) |
| 첫 봉인에서 제출물이 계약을 약하게 만들 수 있는가 | **만들 수 있다. 가드가 없다.** 아래 H-1 |
| `sourceHash`를 제출물이 들고 오는 경우 | **위험.** OMS가 직접 계산해야 한다. 아래 H-2 |
| template 식별에 scope를 넣으면 기존 봉인 계약은 | **깨진다.** `removed`로 분류된다 (증거 있음) |
| 해석 비용 위치 | **봉인 시 1회.** 쓰기 경로는 해석물을 읽지 않는다 |

전체 판정: **조건부 안전.** 아래 세 조건을 전부 구현하면 LANE 2를 진행할 수 있다. 조건 1과 조건 3이 빠지면
설계는 위험하고, 조건 3은 새 코드를 요구한다.

## 1. 기존 브랜치 중복 판정 — 재사용 불가

`fix/oms-scoped-template-repair`의 merge-base는 `9c0814b`(0.15.0)이고, 그 뒤 main에서
`e1f71c3 feat(contract)!: seal the vault contract outside the vault and judge every write`가
`src/kernel/templates/` 아래 50개 파일을 삭제했다. 브랜치가 건드리는 14개 소스 파일 중 11개가
main에 존재하지 않는다:

```
GONE-ON-MAIN  src/cli/template-command.ts
GONE-ON-MAIN  src/kernel/templates/{index,interview-service,pending-source,reconcile,review-scope,types}.ts
EXISTS        CHANGELOG-{cli,kernel,mcp}.md, src/mcp/server.ts, src/mcp/template-native.test.ts
```

그 브랜치의 신설 모듈은 우리 문제를 풀지 않는다.

- `pending-source.ts`는 `.oms/template-policy.json`·`.oms/taxonomy.json`·`.oms/types.json`을 CAS로 검증하며
  **템플릿 원본 바이트를 제자리에서 교체**한다(`repairPendingTemplateSource`). vault 안의 `.oms` 제어 파일 체제는
  `e1f71c3`이 폐기했고(계약은 vault 밖 `~/.oms`), 원본 수정은 우리 계획의 non-goal이다.
- `review-scope.ts`(`scopeTemplateReviewContext`)는 `TemplateReviewContext`를 template id 하나로 좁힌다.
  main에는 `TemplateReviewContext`도 `census`도 없다.

충돌도 아니고 기반도 아니다. 이미 은퇴한 코드 위에 쌓인 +902줄이다. 단 하나 가져올 값은 개념이다:
`TEMPLATE_IDENTITY_IMMUTABLE`(같은 원본 경로가 다른 식별자로 해석되면 거부) — 이건 아래 V-3에서 재현한다.

부수 사실: 그 브랜치는 `CHANGELOG-{cli,kernel,mcp}.md`의 `## [Unreleased]`에 main에 존재하지 않는
`template update`·`template review|answer|commit` CLI 표면을 설명하는 항목을 넣었다. 그대로 머지하면
출하되지 않는 표면을 릴리스 노트가 주장한다. 이 브랜치는 머지 대상이 아니라 폐기 대상이다.

## 2. 해석물 스키마

기존 `Extraction`(`src/kernel/contract/extract.ts:11-30`)을 그대로 쓴다. 새 개념을 만들지 않는다.
바뀌는 것은 **누가 채우는가**와 **무엇이 제출물에 포함되지 않는가**다.

```
TemplateInterpretation = {
  source: string                  // vault 상대 경로. 에이전트가 고르지 않는다 — OMS가 열거한 경로 중 하나여야 한다
  observedHash: Digest            // 에이전트가 읽은 시점의 원본 digest. 검증용이며 계약에 저장되지 않는다
  fields: ExtractedField[]        // { name, inferredType, literal, variable } — 기존 그대로
  headings: ExtractedHeading[]    // { title, level, variable } — 기존 그대로
}
```

`sourceHash`는 **제출물에 없다.** 아래 H-2.

frontmatter가 없는 템플릿: 표현 가능하고, 이미 그렇게 동작한다. `fields: []`, `headings: []`가
frontmatter 없음을 뜻한다. 기존 `extract.test.ts:111`(`accepts a template without frontmatter`)이
이미 이 형태를 고정하고 있고, `manual/meeting.template.md`처럼 파일 전체가 `<%* … %>` JS인 경우도
현재 코드가 `{ok:true, fields:[], headings:[]}`로 통과한다 — `VARIABLE` 정규식이 블록 전체를 치환하고
남은 텍스트에 frontmatter도 heading도 없기 때문이다. `test/contract-loosening-scope.test.ts`가 이걸 고정한다.

실제 두 파일을 vault 밖 임시 복사본으로 `extractTemplate`에 통과시켜 확인했다(vault 무변경):

```
manual/meeting.template.md  → {ok:true, fields:[], headings:[], sourceHash:"sha256:177c0ee0…"}
agent/mail.template.md      → {ok:false, diagnostics:[frontmatter-yaml-parse-error ×2
                                 "Implicit keys need to be on a single line"]}
```

즉 **JS 템플릿은 원래 refused가 아니었다.** 관측된 refused 4건은 `agent/*.template.md`의
구조 위치 placeholder에서만 나온다. 스키마에 "frontmatter 없음" 전용 표현을 추가할 이유가 없다.

여기서 `manual/meeting.template.md`의 실질적 의미가 드러난다. 그 파일은 JS 문자열로
`type`·`index`·`aliases`·`date_meet`·`date_created`·`date_modified`·`created_by`·`authorship`·`participants`·`up`
10개 필드와 `## Thinking`·`## Discussed`·`## Next Steps`·`## References` 4개 heading을 만든다.
현행 결정론 경로는 이 14개를 **전부 놓치고 조용히 통과한다.** 계약이 비어버리는 쪽이라 refused보다 나쁘다.
에이전트 해석이 실제로 얻는 것은 refused 회피가 아니라 이 14개다. 그게 이 계획의 진짜 가치다.

## 3. 제출물 검증 규칙

OMS가 거부해야 하는 것. 이것이 새 신뢰 경계다.

- **V-1 스키마 위반.** `fields`/`headings` 타입, `inferredType ∈ FieldType`, `variable ∈ VariableKind|null`,
  `literal`은 `JsonScalar | JsonScalar[] | null`. `name`은 비어 있지 않고, 같은 `name`이 두 번 오면 거부.
- **V-2 경로 위반.** `source`는 `discover()`가 `scanTemplateSources`로 열거한 경로 집합의 원소여야 한다.
  에이전트가 경로를 제시하는 것이 아니라 OMS가 낸 목록에 답하는 구조다. 목록 밖 경로는 거부.
- **V-3 집합 불완전.** 열거된 모든 원본에 제출물이 하나씩 있어야 한다. 누락은 거부.
  누락을 허용하면 에이전트가 템플릿 하나를 통째로 계약에서 빼는 무음 경로가 생긴다.
- **V-4 신선도 불일치.** `observedHash ≠ OMS가 지금 계산한 digest` → 거부. 에이전트가 읽은 뒤 파일이
  바뀐 경우(TOCTOU)를 잡는다. 재해석을 요구하고 봉인하지 않는다.
- **V-5 식별자 충돌.** 두 원본이 같은 template name으로 해석되면 거부. 현행
  `interview.ts:278-281`이 basename으로 이미 하는 일이며 scope 도입 후에도 유지해야 한다.
- **V-6 이름 안전성.** template name은 `isSafeName`(`store.ts:69-71`)을 통과해야 한다.
  `/`를 포함한 이름은 거부되고(`isSafeName("manual/meeting") === false`), 봉인 후
  `store.ts:291`의 읽기 검증에서 계약 전체가 `schema-invalid`가 된다. **scope 구분자로 `/`는 쓸 수 없다.**

## 4. loosening 안전성 논증

### (a) 제출물이 계약을 넓히는 데 쓰일 수 있는가

제출물이 계약에 도달하는 경로는 두 개뿐이다. 둘 다 `discover()`에서 시작한다.

1. `interview.ts:289-291` — `extraction.fields`의 `inferredType`이 `observedTypes`에 들어가고,
   `askProperties`(`interview.ts:346`)에서 `property:<name>:type` 질문의 **기본값**이 된다.
2. `interview.ts:549` — `askTemplate(asker, name, source, extraction)`가 `extraction`을 소비해
   질문을 만들고, 답변으로 `TemplateContract`를 조립한다(`interview.ts:357-402`).

`TemplateContract`의 모든 필드는 소유자 답변에서 나온다. `requiredProperties`는 confirm,
`narrowedRules`는 choice + text, `requiredHeadings`는 confirm, `applyFolder`는 text.
제출물은 **어떤 값도 계약에 직접 쓰지 못한다.** 요구 3은 형식적으로 유지된다.

이미 봉인된 vault의 재봉인(`nonLoosening: true`, `contract-command.ts:202`)에서는
`looseningChanges`(`interview.ts:566-569`)가 최종 관문이다. 조작된 제출물이 계약을 약하게 만들면 잡힌다:

```
required/heading 누락 → [{templates.meeting.requiredProperties.status, required-dropped},
                        {templates.meeting.requiredHeadings.Agenda,   heading-dropped}]
```

(`test/contract-loosening-scope.test.ts`, `loosening.ts:105-138`)

`applyFolder`는 제출물과 무관한 소유자 text 답변이고, 봉인된 scoped 템플릿과 겹치는 새 scoped 템플릿은
`overlapChanges`(`loosening.ts:152-162`)가 `apply-folder-overlap`으로 잡는다. 반면 **scope 없는** 새 템플릿은
아무리 느슨해도 변경이 아니다 — `judge.ts:203-204`가 `applyFolder !== undefined`인 템플릿만 후보로 만들므로
scope 없는 템플릿은 다른 노트의 판정에 끼어들 수 없다. 둘 다 테스트로 고정했다.

여기까지는 안전하다. 문제는 두 곳이다.

#### H-1 (신규 구멍) 첫 봉인에서 질문 집합 자체가 에이전트 통제 하에 놓인다 — 가드 없음

`askTemplate`은 `extraction.fields`를 순회한다(`interview.ts:363`). 제출물에서 필드 하나를 빼면
그 필드에 대한 질문이 **생성되지 않는다.** 소유자는 묻힌 적이 없고, 답한 것만 계약에 들어가므로
계약은 조용히 약해진다. LANE 2 이후 OMS는 원본을 파싱하지 않으므로 누락을 알 방법이 없다.
`sealGuard`(`interview.ts:442-459`)는 계약 내부 정합성만 본다 — 원본과 대조하지 않는다.
`looseningChanges`는 계약 대 계약 비교이므로 `previous === null`인 첫 봉인에서는 아예 호출되지 않는다
(`interview.ts:566`은 `previous !== null`로 가드된다).

정리하면 신뢰 경계가 이동한다. 현행은 **답변만** 에이전트를 통과한다. 변경 후에는 **무엇을 물을지**도
에이전트를 통과한다. V-3이 템플릿 단위 누락은 막지만 필드·heading 단위 누락은 막지 못한다.
그리고 이 감시 구멍을 결정론적 대조로 막는 건 요구 1·2 위반이다(파서를 되살리는 일이다).

따라서 유일하게 남는 정당한 게이트는 소유자다. **제출된 해석물을 소유자에게 보여주고 그 자체를
질문으로 만들어야 한다.** `template:<name>:interpretation` 같은 confirm 하나 + 해석물 표시. 그러면
질문 집합의 게이트도 소유자가 된다. 이건 새 코드이며 LANE 2의 범위다.

이 때문에 LANE 3(`preview`)의 우선순위가 올라간다. 해석물이 입력이 되면 `preview`는 제출물과 봉인 대상
계약 사이의 **유일한** 소유자 가시 통로다. 현행 `preview`(`interview.ts:461-472`)는 폴더·속성·템플릿의
required 목록만 출력하고 해석물은 출력하지 않는다. LANE 3은 선택 사항이 아니라 H-1의 완화 수단의 일부다.

#### H-2 (필수 수정) `sourceHash`를 제출물이 들고 오면 안 된다

지금 `sourceHash`는 OMS가 원본에서 계산한다(`extract.ts:127`, `source.rawDigest`). 세 곳이 이 값을 신뢰한다.

- `interview.ts:529` — `changedTemplates`: 봉인된 해시와 같으면 **그 템플릿은 질문되지 않는다.**
- `interview.ts:532,552,588` — declined 추적.
- `drift.ts:8-20` — `templateDrift`: 해시가 다르면 `drift`, 같으면 `active`.

제출물이 `sourceHash`를 들고 오면 에이전트가 봉인된 해시를 그대로 다시 제출해 **원본이 바뀐 템플릿을
"변경 없음"으로 위장**할 수 있고, `contract status`가 `drift`인 템플릿을 `active`로 보고한다.
계약 객체 자체가 느슨해지는 건 아니지만(옛 계약이 계속 집행된다) 신선도와 drift 보고가 무력화된다.
`looseningChanges`는 `sourceHash` 차이를 보지 않으므로 여기서 잡히지 않는다 — 테스트로 고정했다
(`sourceHash alone is invisible to the loosening check`).

수정은 간단하고 타협 대상이 아니다. **`sourceHash`는 OMS가 `scanTemplateSources`로 읽은 바이트에서
계산한다. 제출물은 `observedHash`만 싣고, 불일치는 V-4로 거부한다.** 이건 파싱이 아니라 digest다 —
요구 1이 거부한 "기계적 선분석"에 해당하지 않는다.

### (b) template 식별에 scope를 넣으면 기존 봉인 계약은 어떻게 분류되는가

**오분류된다. 추측이 아니라 관측이다.**

`looseningChanges`의 템플릿 비교 키는 계약의 `templates` 레코드 키다(`loosening.ts:210-211`).
봉인된 vault에서 `meeting`을 `manual__meeting`으로 다시 키를 매기면:

```
looseningChanges(sealed{meeting}, next{manual__meeting})
  → [{ field: "templates.meeting", kind: "removed" }]
```

`removed`는 loosening이다(`loosening.ts:101`). 결과:

- 에이전트 경로(`oms setup --answers`, `nonLoosening: true`)는 `{state:"loosening"}`으로 끝나고
  **아무것도 봉인하지 못한다.** 소유자가 터미널에서 직접 `oms setup`을 돌려야 한다.
- 터미널 경로에도 결함이 있다. `goneTemplates`(`interview.ts:533`)가 `meeting`을 "원본이 사라진
  봉인 템플릿"으로 판정해 `The source of the sealed template "meeting" is gone. Remove it?`를 묻고,
  같은 실행에서 `manual__meeting`을 신규 등록으로 처음부터 다시 묻는다. 원본 파일은 그대로 있는데
  사라졌다고 말한다. 그 템플릿의 봉인 답변은 전부 버려진다.

Ataraxia는 `never-sealed`이므로 봄수 vault는 무해하다. 봉인된 다른 vault는 위 경로를 그대로 탄다.
LANE 2가 scope를 도입하려면 **저장소 읽기 시점의 rekey 마이그레이션**(옛 basename 키를 새 scoped 키로
승격하고 `source` 경로로 대조)이 같이 와야 한다. 마이그레이션 없는 scope 도입은 기존 봉인 계약을 깬다.

한편 scope는 선택 사항이 아니다. Ataraxia의 템플릿 폴더 71개 `.md` 중 basename이 겹치는 것은
`meeting.template` 하나이고(`agent/`와 `manual/`), 이 충돌은 `interview.ts:278-281`에서
`Two templates share the name "meeting"; rename one.`이라는 **refused를 독립적으로 발생시킨다.**
즉 LANE 4의 수락 기준("refused 4건이 사라진다")은 해석물 입력만으로는 성립하지 않는다.
해석물 입력은 파싱 실패 4건을 없애고, 이름 충돌 1건은 scope만이 없앤다. 그리고 scope는 마이그레이션을
요구한다. 이 세 개는 하나의 묶음이다 — 계획이 LANE 2에서 같이 묶은 것이 맞다.

### (c) 해석 비용 위치

**봉인 시 1회다.** 쓰기 경로는 해석물을 읽지 않는다.

`extractTemplate` 호출자는 두 곳뿐이다: `cli/contract-command.ts:227`(`oms contract extract`, 진단용)과
`interview.ts:283`(`discover`). 판정기 `judge.ts`는 `extract.js`를 import하지 않는다 — 계약 객체와
`scanContractHeadings`만 쓴다. 노트 쓰기는 봉인된 `TemplateContract`(이미 계산된 `sourceHash` 포함)만
읽는다. 따라서 22,075 노트 vault의 쓰기 성능에 해석 비용이 새지 않는다.

단 `oms contract status`/`doctor`의 `detectDrift`(`drift.ts:23-27`)는 봉인된 템플릿마다 원본을 다시 읽고
digest한다 — 템플릿 수(71) 규모이고 노트 수와 무관하다. V-4의 해시 재계산도 같은 규모다. 문제없다.

## LANE 2 진행 조건

1. **`sourceHash`는 OMS가 계산한다.** 제출물의 `observedHash`는 검증용이고 불일치는 거부(H-2, V-4).
2. **scope 도입은 sealed-contract rekey 마이그레이션과 같은 패치에 온다.** 없으면 봉인된 vault가 깨진다(4b).
3. **제출된 해석물이 소유자에게 보이고, 그 자체가 질문이 된다.** 없으면 첫 봉인에서 질문 집합이
   에이전트 통제 하에 놓이고 아무 가드도 없다(H-1). LANE 3과 함께 설계해야 한다.

세 조건을 지키면 봉인된 계약을 제출물이 넓힐 수 없고, 첫 봉인의 질문 집합은 소유자가 게이트한다.
조건 1이나 3이 빠진 채 LANE 2를 진행하면 설계는 위험하다.

## 이 카드가 남긴 것

- 이 문서.
- `test/contract-loosening-scope.test.ts` — 위 분류 결과 8건을 고정한다. 새 동작이 아니라 논증이
  인용한 관측을 고정하는 것이므로 `src/`는 건드리지 않았고 changelog 항목도 없다(사용자 표면 무변경).
  `npm test`의 두 실패(`doc-mapping`, `vendor-discovery`, 16건)는 `origin/main` 무수정 상태에서도
  재현되며 이 작업과 무관하다 — 워크트리에서 `npm pack --dry-run --json`이 배열 대신 객체를 돌려주는
  Node 24 / npm 동작 때문이다.
