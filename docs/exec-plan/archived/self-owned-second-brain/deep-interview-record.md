# Deep Interview Spec: Self-Owned Second-Brain Engine (전체 엔진 일괄 구현)

## Metadata
- Interview ID: deep-interview-self-owned-second-brain-engine
- Status: **THRESHOLD MET — compile/wiki 동작 잠금 완료, plan 진입 대기** (모든 컴포넌트+lint+tracer+폴더 토폴로지+ingest+provenance+setup+`.oms` 거버넌스 분리+compile/wiki 동작 잠금; 잔여 = plan.md 작성 go-ahead)
- Rounds completed: Round 0 (topology gate) + R1–R17 (R17=.oms 거버넌스 분리→ADR-006, R17b=compile/wiki 동작 설계)
- Current Ambiguity: **~3%** (threshold 0.05 통과 ✅)
- 위치 이전(2026-06-13): `.omc/specs/`(gitignored, omc 아티팩트)에서 repo-소유 `docs/exec-plan/active/self-owned-second-brain/deep-interview-record.md`로 이전. 유출 방지: `.omc/.omx/.omo`는 gitignore로 은닉(설계 rationale 텍스트는 유지).
- **RESOLVED(R17b)**: compile·wiki 스킬 동작 설계 잠금 완료 — `docs/research/compile-wiki-operation-references.md`(837줄, 10개 구현 마이닝) + 자기저작 레퍼런스 bstack `terminology` 흡수. Compile=stateless per-concept SHA worker, Wiki=stateful collection owner(staleness ledger 5-state CLEAN|DIRTY|STUB|ORPHAN|CONFLICT), 물리 3-tier에 sync 경계 횡단. 물리 폴더 분리(raw/processed/wiki)는 사용자 동의(R14).
- Type: brownfield (oms repo 존재, ADR-002/004/005 + research 입력)
- Generated: 2026-06-13
- Threshold: 0.05 (source: `~/.claude/settings.json` → `omc.deepInterview.ambiguityThreshold`)
- Brownfield weights: Goal 0.35 / Constraints 0.25 / Criteria 0.25 / Context 0.15
- 입력 문서: ADR-002(벡터/임베더 티어/RRF), ADR-004(설정/시크릿/접근), ADR-005(frontmatter 4-tier 그래프), `docs/exec-plan/active/self-owned-second-brain/spec.md`(living design doc), `docs/research/*-mining.md`
- 교차참조: 이 인터뷰는 **scoping 결정 + ambiguity 추적**을 소유. "무엇을 짓나"의 살아있는 설계는 design doc(`active/self-owned-second-brain/spec.md`)이 소유. 둘은 상보적, 중복 금지.

---

## Core Thesis (불변)
**탈종속 + self-owned 통합.** 내 의도-데이터를 third-party 도구(omc/omx/graphify/gbrain/qmd/devonthink/notebooklm)에 락인하지 않는다. 그들의 좋은 아이디어는 **내 도구로 흡수**한다. "검증된 것에 한해서"(merged PR/confirmed issue/shipped code)만 흡수하고, 흡수한 모든 repo는 `ACKNOWLEDGMENTS.md`에 레퍼런스+감사로 기록한다(필수 규율, verbatim 사용자 지시).

---

## 횡단 원칙 — Non-Sticky / Vault-Agnostic (사용자 명시, R14 직후)
사용자 verbatim: **"이것은 내 obsidian vault에 접합 되었다기보다는 oh my secondbrain을 만드는 계획이며 따라서 sticky하지 말아야 하는거지. 네가 방금 말한 wiki 생성 위치 이런 것은 오히려 인터뷰를 통해서 규칙을 정해야 한다고 생각해. setup 할 타이밍에라던가."**
- **oms = vault-독립 엔진/제품.** 특정 vault(Ataraxia)에 하드코딩 금지.
- **구체 vault 바인딩**(wiki 생성 위치, raw/processed tier 폴더, `.oms` 캐시 경로, lint 스키마 SSOT, taxonomy)은 **setup-time에 엔진 자신의 setup 인터뷰로 해소**. 코드/스펙에 박는 값이 아님.
- **Ataraxia 유래 값 = 레퍼런스 디폴트(reference implementation)일 뿐**, override 필수.
- 메타-우아함: oms는 deep-interview와 동일한 **인터뷰 패턴을 자기 setup에 내장** — 설치되는 vault마다 규칙을 인터뷰로 확립(§12 vault-scaffold / ADR-003과 합류).
- ⟹ 아래 R9/R10/R14의 Ataraxia 특정값은 "고정 잠금"이 아니라 **"setup-time 해소 가능한 디폴트"**로 읽을 것.

## 6-Component Engine Topology (Round 0 — 전부 in-scope 잠금)
사용자 답변: **"6개 전부 in-scope"** — 슬라이스 거부, 전체 엔진 일괄 구현.

| ID | Component | 책임 |
|----|-----------|------|
| C1 | Vector / Index | Store + Index + Embed |
| C2 | Graph | frontmatter 4-tier 가중 엣지, Leiden 커뮤니티 |
| C3 | Retrieval | typed sub-query + graph 융합 |
| C4 | Config / Secrets / Access | 3-tier 설정, env 시크릿, 전역 MCP 접근 |
| C5 | Wiki / Synthesis | Ingest→Compile→Wiki (사람이 읽는 페이지) |
| C6 | Distill | target-driven 전문 흡수 |

**용어 명확화 — Compile vs Wiki (R12 후 사용자 질문 해소):**
- **Ingest(수집)** = 여러 소스 → 정규화된 *재료(material)*. 입력 준비.
- **Compile(합성)** = 재료 + 그래프 → 개념당 일관된 페이지 *내용 생성*. **동사/프로세스**(LLM 합성). Karpathy LLM-wiki 핵심.
- **Wiki(위키)** = compile 산출 페이지들이 사는 *영속·연결된 컬렉션*. **명사/산출 표면**. wikilink·구조·사람 브라우징, Ataraxia 1급 폴더.
- 한 줄: **Compile=만드는 행위, Wiki=만들어진 것.** "Compile 단계가 Wiki 페이지를 생성한다"가 정확한 표현("wiki compile"은 부정확했음).

**MECE 2축 분해 (R3 잠금):**
- **Content 축** = Ingest → Compile → Wiki (C5 3단계, nvk "raw→compile→executable" 프레임). 산출물 = Ataraxia 1급 폴더의 사람이 읽는 페이지. 모든 wiki 레퍼런스 도구(Karpathy/nvk/nashsu/lucasastorian)가 가진 유일한 축.
- **Capability 축** = Distill (C6). 특정 **target** 기반으로 우리 시스템/내 자산에 흡수할 거리를 전문적으로 탐색. 우리 고유 축(skillify/craft-skills 계보). target은 repo/skill에 국한되지 않음(R6 참조).
  - **Distill = 독립 standalone 스킬 (사용자 명시, R16 시점)**: 엔진/thick-router에 융합된 leaf가 **아니라** 그 자체로 서는 1급 스킬. vault 종속 아님 — 어떤 target에도 작동하는 메타 흡수 스킬. (anti-proliferation 비위반: 명시 의도. R13 clean-room 메커니즘을 자체 보유.)

---

## Round-by-Round 잠금 결정

### R1 — C1 임베더 기본값 (잠금)
- **기본 임베더 = EmbeddingGemma-300M, 768d.** HNSW 2000-limit 안전, 기본 경로 양자화 없음.
- 상용(Upstage 4096d) opt-in only → exact/rerank 또는 양자화 트리거.
- qmd 임베딩 패턴 흡수(아래 ledger).

### R2 — C1 실행 모델 (잠금, 사용자 강한 교정)
사용자 verbatim: **"수동만 원해 우리 자체가 어떠한 상태를 가지고 있고 싶지는 않아."**
- **실행 = MANUAL only. STATELESS.** daemon/watcher 금지. 지속 상태 = 디스크 인덱스 파일뿐. MCP 서버는 세션당 stdio-spawn.
- ⚠️ 향후 daemon/stateful 패턴 제안 금지.

### R3 — C5/C6 MECE 경계 (잠금)
위 2축 모델. 사용자 verbatim: "ingest, compile, wiki로 나누는 프레임은 좋고 distill은 살짝 목적이 달라 특정 target을 토대로 우리 시스템이나 내 자산에 대해서 흡수할 거리를 전문적으로 찾는거니까."

### R4 — 성공 기준 (잠금)
사용자 답변: **"골드셋 회귀 + 기존도구 동등이상."**
- **골든셋 회귀**: N개 대표 질의 → 기대 노트가 top-k에 등장.
- **parity-or-better**: qmd/gbrain 대비 동등 이상.
- 수치 SLO(embed time, p95, recall@10)는 하위 메트릭.
- (열림: N/k 구체값 미확정)

### R5 — C3 Retrieval 융합 (잠금)
사용자 verbatim: "qmd가 타입별로 검색 지원하는게 좋았고 graphify가 그래프 쓰는게 좋았어. 이를 병합해보고 싶었고 임베딩은 gbrain과 qmd의 장점을 흡수."
- **qmd식 typed sub-query 표면**(`lex`/`vec`/`hyde`)에 **`graph`를 4번째 타입으로 추가** → 전부 **RRF(k=60, gbrain/MS-GraphRAG식) 융합** → optional rerank.
- 별도 **`gph` 모드**(graphify식 traversal/shortest_path/community) 병존.
- 거인 비교 근거: qmd typed array / graphify query_graph(BFS·DFS+IDF) / MS GraphRAG RRF k=60 / HippoRAG PPR.

### R17 — `.oms` 거버넌스: 기계검증 계약 ↔ 의도 기록 명시적 분리 (잠금) → ADR-006
사용자 verbatim: **"이거다 기록해 /documents 로 ... 단 이 경우 기계적 검증을 위한 yaml과 의도가 섞여있는 documents는 명시적으로 분리가 되어야 한다고 생각함."** (직전 교정: "yaml의 의도는 기계적으로 이름 검증하려는 것이고, documents 스킬 구조를 oms에 두는 것은 vault의 정책과 폴더 구조가 바뀔 때 의도적으로 기록해두기 위함이야.")
- **`.oms/`(vault·repo 양쪽)는 두 레이어를 명시적으로 분리 보유** (ADR-006으로 기록, ADR-003 정련·비-supersede):
  - **Layer 1 CONTRACT (기계검증)**: `taxonomy.yaml`/`concepts/*.yaml`/`schemas/` = 파서가 읽는 현재형 계약. `vault-lint`(R9)+`oms_validate_contract`의 enforcement 대상. "의도한 키만 올바른 값으로 생존하는가"만 판정, 역사 없음.
  - **Layer 2 GOVERNANCE (의도 기록)**: `.oms/governance/`(decisions/rules/architecture) = craft-skills `documents` 온톨로지의 vault 적용. vault 정책·폴더 구조가 *왜·언제* 바뀌었나의 산문. supersede로만 갱신, 삭제 없음.
- **a+b 병행 = lane 분리**: CONTRACT는 **checker lane**(`vault-lint`), GOVERNANCE는 **author lane**(`vault-decision-record` 계열). 작성과 검증을 같은 active context에 섞지 않음(글로벌 규율 정합). lint가 ADR을 쓰지 않고, 거버넌스 스킬이 taxonomy를 강제하지 않음. anti-proliferation 비위반(사용자 명시 sanction).
- **`.oms/`는 커밋된다 (omc/omx/omo와 정반대)**: `.omc/.omx/.omo`=gitignore 은닉(유출 금지), `.oms/`=우리 자산이라 커밋. 단 `.oms/cache/`(graph.json 265MB급 파생물)만 gitignore. repo `.gitignore`에 `.oms/cache/`만 추가.
- **Non-Sticky**: Ataraxia `.oms/`(taxonomy + 95.Decisions)=레퍼런스 디폴트(dogfood), 하드코딩 금지. 두 레이어의 *경계*는 불변, *내용*은 vault별 setup-time 인터뷰로 확립.

### R17b — compile/wiki 동작 설계 잠금 (레퍼런스 흡수 후 정련)
근거 문서: `docs/research/compile-wiki-operation-references.md`(837줄, 10개 구현 마이닝). 자기저작 레퍼런스: bstack `terminology` 스킬(= 손으로 돌리는 단일 compile-unit 프로토타입).
- **Compile = stateless per-concept SHA worker** (cc 컴파일러 비유): `(concept, material, graph) → page body`. 단위당 무상태, SHA 증분, oms-driven. terminology Step2-4(Research/Draft synthesis/Verify)가 이 합성 코어에 1:1 대응. 흡수: nashsu 2-step CoT + atomicstrata 2-phase 분리(extract-all-without-writing → generate) + lucasastorian write→backlink-return cascade.
- **Wiki = stateful collection owner** (make+linker 비유): 5책임 = (1) namespace/identity, (2) link-graph closure, (3) **staleness ledger**, (4) navigation surfaces(MOC/index), (5) processed→wiki promotion tier. compile을 구동하는 주체. terminology Step1(variant-scan)+Step5(publish/cleanup)가 이 collection-owner에 대응.
- **Staleness Ledger 5-state**: `CLEAN | DIRTY | STUB | ORPHAN | CONFLICT`. 소스파일 SHA 변경이 state 전이 구동(R12 SHA 증분과 합류). 상태 = 닷폴더(`.llmwiki/staleness.json`, `sha-cache.json`), **절대 sync 안 됨**.
- **물리 3-tier + sync 경계 횡단 (R14 정련)**: `raw/`(synced, in-vault) → `processed/`(non-synced 캐시, 기계 중간산물) → `wiki/`(synced, visible, navigable). sync 경계가 3-tier를 가로지름 — materialized ≠ synced. State 닷폴더는 never synced(Obsidian Sync 기본 닷폴더 제외 → 265MB graph.json 전파 방지).
- **모든 oms 스킬은 `/skillify` 구조 준수** (불변 제약): SKILL.md + CHANGELOG.md + optional references/scripts/tests/evals/agents; 5-key frontmatter; name==dir; semver. body=현재형 명령형 recipe ONLY — history/attribution 금지(→ CHANGELOG.md + ACKNOWLEDGMENTS). 이 분리는 attribution 규율과 **정합**(provenance는 ACK/CHANGELOG에, skill body는 순수 recipe — R17 두-레이어 분리와 동일 원리).

### R16 — oms setup 인터뷰 철학 (잠금)
사용자 답변: **"의견있는 디폴트 + 확인/override 인터뷰."**
- oms는 설치 vault마다 **자체 setup 인터뷰**로 Non-Sticky 바인딩 확립: tier 폴더 매핑, provenance 등급 매핑, lint 스키마 SSOT, 임베더 선택, 민감-zone(`ignore_for_external_apis`), agent-writable zone/routing law.
- **철학**: Ataraxia 유래 **의견있는 디폴트(taxonomy.yaml)** 제시 → 사용자가 각 바인딩 확인·override. 빠른 시작 + 완전 override.
- auto-detect(vault 스캔, graphify/qmd 재사용)가 default를 seed 가능(옵션).
- §12 vault-scaffold / ADR-003과 합류 — oms가 deep-interview 패턴을 자기 setup에 내장.
- **인터뷰 방식 = deep-interview 방법론 (사용자 명시)**: verbatim "그 setup의 인터뷰 방식은 우리 omc의 deep-interview 방식을 따르면 될거같아."
  - 흡수 대상 = Socratic clarity, ambiguity 임계(설정 가능), 차원별 스코어링(Goal/Constraint/Criteria/Context), Round 0 토폴로지 게이트, challenge 모드(Contrarian/Simplifier/Ontologist), 스펙 crystallize.
  - **탈종속 단서**: omc deep-interview 스킬에 *의존하지 않음*. 방법론만 **self-owned 재구현**(method 파쿠리, 구현 소유). ACKNOWLEDGMENTS에 deep-interview 방법론 참조·감사 기록.

### R15 — 입력 Provenance 1급 등급 (잠금)
사용자 답변: **"1급 provenance 등급 — compile/retrieval/distill에 흐름."** (00 Inbox=개인저작 vs 80 References=외부raw 구분의 일반화)
- 각 ingest 소스가 **provenance 등급** 선언: `authored`(직접 작성) > `curated`(수집·선별) > `external-raw`(외부 원자료).
- **흐름**: compile 합성 시 authored 가중↑(개성 보존), retrieval 랭킹의 신뢰 신호, distill의 흡수 판단 입력.
- **vault-독립**: 등급은 엔진 1급 개념, **폴더→등급 매핑은 setup-time 인터뷰**가 결정(Non-Sticky 원칙). Ataraxia 예: 80→external-raw, 00→authored/curated 혼재.
- 함의: ingest는 단일 스트림이 아니라 provenance-태깅된 멀티스트림. RRF/compile이 등급을 부가 신호로 사용.

### R14 — C5 content축 tier = 물리 폴더 (잠금)
사용자 답변: **"물리 폴더 tier (영상 방식 그대로)."** (참조: YouTube "LLM Wiki가 망하는 진짜 이유", Karpathy LLM-wiki 계열 — 폴더를 처리 계층으로 사용)
- content축(Ingest→Compile→Wiki)을 **Ataraxia 명시 폴더 tier**로 인코딩: `raw/`(공통 base) → `processed/`(compile 중간산출: 엔티티·요약) → `wiki/`(1급 개념 페이지).
- **Ingest 소스 2종 구분 (사용자 교정)**: verbatim "00 인박스는 정말 내가 작성하거나 수집한 것, 80 레퍼런스는 raw라고 볼 수도 있는 부분."
  - **`80. References`** = 외부 자료(클리핑·아티클·논문·github·영상) = **진짜 raw(중립 substrate)**, "공통"에 귀속. → `raw/` tier의 1차 소스.
  - **`00. Inbox`** = 네가 직접 작성/수집 = **intent-laden 개인 캡처**(provenance=사용자). 중립 raw 아님 → 별개 ingest 스트림, compile에 다른 intent 온도로 투입.
  - 함의: ingest는 단일 raw가 아니라 **{외부 raw(80) + 개인 캡처(00)}** 두 스트림을 구분 보존하며 compile. tier 모델의 "raw 공통"은 80에만 정확히 적용.
- **R12 정련**: compile은 과정이되 **중간 산출을 `processed/` 폴더에 물질화**(ephemeral .oms 캐시 아님). 파이프라인이 폴더로 가시화.
- **"raw 공통"의 의미**: raw 계층 = 의견 없는 **중립 substrate**(누구에게나 공통·이식가능). 개성·의도는 위층(compile/wiki 합성)에 존재 → 탈종속 철학과 정합(가치=내 합성 계층, raw는 락인 안 됨).
- §10 온톨로지(coarse→mid→synthesis→semantic)의 물리적 인코딩.
- created_by frontmatter는 모든 tier의 agent 산출물에 유지(routing law).

### R13 — C6 Distill clean-room 메커니즘 (잠금)
사용자 답변: **"Throwaway 서브에이전트 + 구조화 흡수리포트."**
- **clean-room = 깨끗한 throwaway 서브에이전트 컨텍스트**(본체 상태 불변, R2/R6 정합). 타깃을 **inert 데이터로만** 로드, 스크립트 미실행.
- 내부 = **레드팀 적대분석** → **구조화 흡수리포트** 산출: (1) 패턴/아이디어 file:line 근거, (2) 위험/red-flag, (3) 출처 attribution 메모(ACKNOWLEDGMENTS 감사·레퍼런스 규칙용 — 출처 기록만).
- **라이선스 고려 제외 (R13 정정, 사용자 지시 "distill에 라이센스 고려는 지우세요")**: distill 리포트는 라이선스 검증·GPL/verbatim 법적 플래그를 **포함하지 않음**. distill = 패턴/인사이트 흡수에 집중. (attribution=출처 감사 기록은 별개 standing 규칙으로 유지.)
- **사람 게이트 후 머지**(routing law guard 정합).
- **검증된 프로토타입**: 이번 세션의 graphify/qmd/gajae 마이너가 정확히 이 형태 — distill = 그 수동 마이닝을 반복 가능 capability로 체계화.

### R12 — C5 Wiki compile 단위·트리거 (잠금)
사용자 답변: **"개념단위 + SHA 증분 재컴파일."**
- 수동 `compile` 커맨드(R2 manual/stateless 강제). 단위 = **창발 개념/커뮤니티당 위키 페이지 하나**.
- **SHA 증분 재컴파일**: 소스 SHA 변경된 페이지만 재생성(qmd SHA 증분 패턴 재사용). 타깃 개념 지정 또는 전체 rebuild 모두 가능.
- 산출물 = Ataraxia 1급 폴더의 영속 마크다운 페이지(사람이 읽음, created_by frontmatter).

### R11 — rerank 정책: cross-encoder = opt-in 정밀 모드 (잠금)
사용자 verbatim: **"이 부분에 있어서는 gbrain처럼 가는게 좋지 않을까? reranker가 왜 필요하지."**
- **근거(검증)**: `docs/research/retrieval-engine-design-references.md:171` — "RRF는 순위 기반이라 스코어 스케일 불일치가 없고, **qmd·gbrain 양 구현체에서 검증된 패턴**." gbrain 검증 설계 = pgvector HNSW + advisory-lock 증분 sync + RRF 융합. **cross-encoder reranker는 gbrain 설계에 없음.**
- **결정**: **cross-encoder rerank 제거.** 기본·상용 경로 모두 **RRF(k=60)가 최종 랭커**(gbrain-parity 기준선).
- 어려운 질의 대응 우선순위: reranker가 아니라 **hyde/graph sub-query 추가**가 1순위.
- **R11 정련(사용자 재결정)**: verbatim **"reranker 포함하자, 대신 정밀하게 찾고 싶을 때 사용하도록."** → reranker는 **명시적 opt-in "정밀 모드"로 포함**.
  - **기본 경로(=gbrain-parity 기준선)**: 변함없이 RRF(k=60)가 최종, rerank 없음. 빠름·stateless.
  - **정밀 모드(opt-in)**: 사용자가 정밀 검색을 명시할 때만 RRF top 후보 위에 **로컬 cross-encoder rerank**(bge-reranker-v2-m3 또는 Qwen3-Reranker-0.6B) 발동. 매 쿼리 추가 지연 감수는 사용자 선택.
  - 골든셋 parity는 기본 경로로 측정(reranker 없이 gbrain 동등 이상). 정밀 모드는 상위 정밀도 부가 기능.
- **R5 정정**: C3 최종 = typed(lex/vec/hyde/graph) → RRF(k=60) → 기본 종료 / **정밀 모드 시 cross-encoder rerank**. 별도 `gph` 모드 병존 유지.

### R10 — C4 reconcile: 단일 vault + 인덱스 위치 (잠금)
사용자 답변: **"일단은 단일 vault만 지원, 인덱스는 해당 볼트에 있어야 하지 않나"** (+ "아까 이야기 나눴다" = design doc §11 `.oms` 마커/전역 MCP).
- **단일 vault만 지원**: canonical = Ataraxia. 다중 vault 레지스트리는 과잉(ADR-001 단일 vault 확정) → 미채택.
- **인덱스 = vault 귀속**: vault 안 **`Ataraxia/.oms/` 닷폴더**에 마커+캐시 통합. 분산 265MB 문제 해소.
- **Sync 위험 화해 메커니즘**: Obsidian Sync는 닷폴더(hidden)를 **기본 전파 안 함**(hidden-files sync opt-in, 기본 OFF) → "볼트 귀속"과 "265MB 전 기기 전파 방지" 동시 달성.
- **caveat(구현 노트)**: vault가 iCloud Drive/Dropbox 동기화 경로 위면 닷폴더도 전파됨 → 그 경우에만 캐시를 machine-local `~/.oms/{vault-id}`로 자동 이전. 현 동기화 = Obsidian Sync 채널 → 기본 안전.
- **oms 2-인스턴스 불일치 해소**: `mcp.json`(→`/01_Project/oms`)과 `settings.json` 훅(→`Ataraxia`)을 canonical=Ataraxia로 통일. 전역 MCP가 임의 cwd → canonical vault 해석.

### R8 — first-runnable tracer + 전경로 검증 전략 (잠금)
사용자 1차 답변: **"Retrieval 관통 (C1+C2+C3)."** → 직후 정련: **"모든 경로를 다 테스트해보는게 좋지 않을까, 우리는 이제 그것을 할 수 있는 computational 연산 능력이 있으니까."**
- **척추(parity anchor) = Retrieval 수직선**: vault 슬라이스 → EmbeddingGemma 임베드 → 인덱스 → typed(lex+vec+graph) → RRF → 결과. 골든셋 parity 기준과 직접 정렬. 최소 C4 배선(canonical 인덱스 로드) 강제.
- **검증 전략 = 전경로 병렬(breadth-first)**: 단일 tracer로 직렬화하지 않음. 멀티에이전트 연산력으로 **4개 수직선(C3 retrieval / C5 wiki / C6 distill / C4 access) 동시 e2e** + retrieval 내부 **모든 서브경로(lex/vec/hyde/graph × RRF융합 × optional rerank × 별도 gph 모드)** 전수 검증.
- 구현 함의: 검증 하네스는 fan-out 가능한 형태(워크플로/병렬 에이전트)로 설계. golden-set이 각 경로를 독립 통과해야 함(경로별 회귀).
- ⚠️ "compute 있으니 전수" = 비용보다 **완전성** 우선(사용자 ultracode 철학과 일치). 단 manual/stateless 제약은 유지 — 검증 실행도 수동 트리거, 본체 상태 불변.

### R7 — 골든셋 평가 하네스 (잠금)
사용자 답변: **"소형 수제출발 + loop-until-dry 성장."**
- **N≈20 수제 큐레이션 질의, k=10.** 4타입(lex/vec/hyde/graph) 골고루 포함(stratified).
- 실패 발견 시마다 질의 추가 → loop-until-dry 성장(연속 라운드 무수확까지). 사용자 research 스타일·manual/stateless ethos와 일치.
- parity-or-better(R4) = 이 골든셋에서 qmd/gbrain 대비 동등 이상.

### R6 — C6 Distill 안전모델 (잠금, Simplifier challenge)
사용자 verbatim: **"그 target이 repo나 스킬이 아닐 수도 있으니 나는 오히려 meta적인 성격을 가졌으면 좋겠어. ultracode 보면 레드팀 적대적 분석 등을 하잖아. 그리고 깨끗한 에이전트에서 테스트하거나. 이런 것을 쓰길 원한거지."**
- Distill은 **메타적**: target은 임의(repo/skill/문서/패턴/개념 무엇이든).
- 안전 메커니즘 = **ultracode식 레드팀 적대적 분석 + clean-room(깨끗한 throwaway) 에이전트에서 검증**. 실행/테스트는 버려지는 clean agent 컨텍스트에서만 발생 → **본체 시스템 상태는 불변**("우리 자체가 상태를 갖지 않는다"는 R2 제약과 화해).
- 이전 가정(inert-data only)은 **기각됨** — 단순 비실행 데이터가 아니라 적대적 분석+격리 검증이 핵심.

---

## Ambiguity 진행
R1 51% → R2 48% → R3 41% → R4 32% → R5 31% → R6 ~28% → **R7 ~24%**

| Dimension | Score | Weight | 가중 갭 | 잔여 갭 |
|-----------|-------|--------|--------|--------|
| Goal | 0.72 | 0.35 | 0.098 (최대) | build 순서/first-runnable tracer 미확정 |
| Constraints | ~0.70 | 0.25 | 0.075 | rerank 모델, graph 가중 휴리스틱(미증명), C4 reconcile |
| Success Criteria | 0.85 | 0.25 | 0.038 | (R7 해소) |
| Context | 0.80 | 0.15 | 0.030 | — |

---

## 신규 스코프 — Vault-Lint (frontmatter 정합성) [R9 도입, 사용자 명시 요청]
사용자 verbatim: **"lint 스킬이 있어서 obsidian vault의 프론트매터의 정합성 등을 판단했으면해. 정합성의 의미는 우리가 의도한 프론트매터만 살아있는지같은거지."**
- **위치**: oms-owned **vault-convention 자산군**(ADR-003 / design doc §12)에 `vault-lint` 추가 → vault-scaffold · vault-decision-record와 3종 세트. 새 top-level 엔진 컴포넌트 아님(C4 config/convention 위에 앉음). anti-proliferation 비위반(사용자 명시 의도).
- **정합성 정의(핵심)**: 각 note-type별 **선언된 frontmatter 키 집합(의도)** 과 실제 노트의 키 집합 일치 — "**의도한 키만 생존**"(rogue/예상외 키 탐지 + 필수 키 누락 탐지).
- **선언 스키마 SSOT**: vault 자신의 템플릿/가이드(`90. Settings/01 Guideline`, `taxonomy.yaml`) = intended frontmatter의 단일 출처. 별도 스키마 중복 금지.
- **재사용**: 기존 `oms_validate_contract`(capture 게이트) + `wiki_lint` 위에 구축. created_by routing law도 검사 대상(agent 노트 필수 필드).
- **안전**: 변경(키 제거/정규화)은 routing law상 guard 승인 필요 → 기본 **report-only**, autofix는 사람 게이트.
- **정합성 강도 (R9 잠금)**: **전체 스키마 검증**. (1) allowlist — 의도한 키만 생존(rogue 탐지), (2) 필수 키 누락 탐지, (3) **값 타입 검증**, (4) **enum 값 검증**, (5) **cross-field** — created_by routing law(agent 노트 필수, agent-writable zone 정합). "의도한 키가 올바른 값으로"까지 판정. 선언 SSOT(템플릿/taxonomy)에서 타입·enum·required를 파생.

## 잔존 Open Items (다음 라운드 대상)
1. **build 순서 / first-runnable tracer** (Goal 0.72 — 최대 가중 갭). 전체 일괄 빌드라도 첫 end-to-end 수직선(엔진을 증명하는 tracer bullet)이 비었음.
2. **rerank 모델 선택** (Qwen3-Reranker 등) + 언제 발동(상용 경로/exact 트리거).
3. **graph 4-tier 가중 휴리스틱** — ADR-005 명시적으로 "증명 안 됨". ablation 필요 vs 일단 휴리스틱 고정 후 골든셋으로 검증.
4. **wiki compile 트리거/정책** (C5 Compile 단계 발동 조건 — 수동? 임계?).
5. **config `.oms` 마커 포맷** + C4 reconcile: 전역 설치인데 stateless/no-daemon, stdio MCP. oms 인스턴스 2개 불일치(`mcp.json`→`/01_Project/oms` vs `settings.json` 훅→`Ataraxia`) + `.oms` 캐시 분산 정리.
6. **distill clean-room 구현 구체** — 어떤 에이전트 격리 메커니즘? 레드팀 분석 산출물 포맷?

## 다음 라운드 계획
- **R8**: Goal 최대 갭 → 전체 일괄 빌드 내 first-runnable tracer(수직선) 확정.
- **R9+**: Constraints 잔여(rerank/graph 가중/C4 reconcile). Ontologist challenge는 잔여>0.3 아닐 시 선택.
- 임계 도달 시 → 이 spec FINALIZE + 실행 브릿지(AskUserQuestion: execute now / plan first / refine).

---

## 흡수 Ledger (검증된 것만 — file:line 근거는 research 문서 소유)
| Repo | 라이선스 | 흡수 대상 | research 문서 |
|------|---------|----------|--------------|
| qmd (tobi) | MIT | 8 임베딩 패턴(하드웨어 적응 병렬풀, Promise.all 분산 임베드, 2단계 배치, success-counter 재시도, SHA-256 증분+fingerprint, lazy load+5min unload, sqlite-vec0, 30min 가드) + typed sub-query 표면 | `docs/research/embedding-pipeline-patterns-mining.md` |
| graphify (Safi Shamsi) | MIT | 24 그래프 기법(4-pass 엔티티 dedup, Leiden-first/Louvain-fallback+cohesion-split, 2-tier 캐시, MCP 10 tools, grow-only build_merge) | `docs/research/graphify-graph-implementation-mining.md` |
| gbrain | (확인불가, TODO) | 로직만 흡수: RRF/rerank, 상용 임베딩 API + 대형 벡터DB 가용성 | design doc §6 |
| gajae-code (Can Bölük / Mario Zechner; Yeachan-Heo contributor) | **MIT (확정)** | 13패턴: P-06 pydantic-settings blank 정규화(즉시적용), P-03 ContextVar 취소토큰, P-04 3단계 graceful shutdown, P-08 2계층 retry, P-13 in-flight set 중복 ingest 방지, P-01 단일 dispatcher+per-task 병렬, shutdown-interrupted vs failed 구분(ingest checkpoint에 직접 적용) | `docs/research/gajae-code-patterns-mining.md` (668줄, 완료) |

**우리 차별점**: 로컬 임베딩(graphify엔 없음 — PR #1126 기각). graphify 핵심 갭: 로컬 임베딩 부재, SQLite 부재(graph.json 512MiB ceiling), ghost node 잔존, build_merge prune 순서 버그 #1283.

**graph 핵심 수정 1순위**: `src/graph/cache.ts`의 frontmatter wikilink가 현재 opaque string → resolve 구현이 최고 임팩트.

---

## 표준 제약 (불변, verbatim)
- main orchestration 깨끗하게 유지.
- 임의로 스킬 늘리지 말 것(anti-proliferation) — CLI alias는 ADR 메모로만(ADR-002).
- distill은 본체에서 untrusted script 미실행(R6: clean-room 격리로 화해).
- GPL-3.0(nashsu/llm_wiki) = 아이디어 참조만, 코드 inline 금지. no-license repo = 개념만, verbatim 복사 금지.
- 민감정보(주소 등) 한 곳 집중 + 외부 임베딩 API 제외(`ignore_for_external_apis`). 모든 시크릿 env var.
- DEVONthink/NotebookLM write 도구 차단 유지.
- 에이전트는 agent-writable zone에만 `created_by` frontmatter로 기록.
- 흡수한 모든 repo는 ACKNOWLEDGMENTS.md에 레퍼런스+감사 기록(필수).

## ACKNOWLEDGMENTS 보강 대기
- graphify vendored(MIT © Safi Shamsi), qmd vendored(MIT © tobi), gajae-code(라이선스 마이너 확정 후) — 흡수-코드 attribution 추가.
- 잔여 TODO(verify) 3건: gbrain(확인불가), anthropics/skills, VoltAgent.

---

## Plan Dimension (HOW) — R18+ (같은 record 연속, spec R17b 이후)

> spec 차원은 R17b에서 threshold(5%) 통과. 이 섹션은 **"어떻게 짓나"(plan.md crystallize 대상)** 차원의 Socratic 연속.
> ⚠️ **발견(2026-06-13)**: `oh-my-claudecode:planner` 에이전트가 `plan.md`(369줄, `pending-approval`)를 **one-shot 생성** — 인터뷰 미-derive(사용자가 지적한 프로세스 위반). 결정: 이 plan을 **crystallize 초안**으로 두고, planner가 silently 정한 미결정만 R19+로 **ratify/override**. 임계 도달 시 plan.md를 edit(=not rewrite)로 reconcile.

### R18 — 기존 자산 교체 전략 (잠금)
사용자 선택: **병렬 신규 모듈 → parity 확인 후 swap.**
- 작동 중인 oms 벡터층(`src/search/`)을 **in-place 교체 금지**. 신규 `src/engine/` 병렬 모듈로 전체 엔진 구축.
- 골든셋 parity-or-better(R7) 게이트 통과 전까지 production 라우팅 변경 금지.
- parity 확인 후에만 swap ceremony로 `src/search/` 은퇴(`src/search.legacy/` 1릴리스 보관 후 삭제).
- (plan.md RALPLAN-DR Driver 1 = 이 결정. **직전까지 record 누락** 상태였음 — 이제 기록.)

### R19 — Repo 물리 토폴로지 (잠금)
사용자 선택: **A — 모노레포 + private 격리.**
- 단일 oms repo 유지(plan.md 현 가정과 정합). engine·generic skill = public 가능.
- personal(personal recipe·vault 경로·사람 이름·개인 워크플로) = **gitignore 또는 git submodule**로 격리.
- 코드/데이터 분리 = privacy 경계(spec §4 정합). 진짜 private = *데이터*(vault·`.oms` cache·`.env`) → 항상 git 밖.
- B(public/private 2-repo)·C(현행 3-repo) 기각. 솔로 publish엔 A로 충분 + 운영 마찰 최소.

### Plan-HOW Ambiguity 진행
R18 후 ~22% → **R19 후 ~14%** (repo 토폴로지 해소 = 최대 기여)

| HOW Dimension | 상태 | 잔여 갭 |
|---|---|---|
| Sequencing/Milestone | ✅ plan 해소 (M1–M5 + completion gate + 제약병렬 Option B) | — |
| Replace strategy (R18) | ✅ 잠금 | — |
| Repo 토폴로지 (R19) | ✅ 잠금 (A) | gitignore vs submodule는 구현 디테일(하위) |
| skillify 패키징 / thick-router | 🟡 부분 | **spec §3 thick router ↔ plan flat skills 상충 ← R20** |
| 5개 신규 ADR 후보 | 🟡 plan이 스스로 "미결" 표시 | R21 (plan이 디폴트 제안 → 일괄 ratify 가능) |

### 다음 라운드
- **R20**: skillify 패키징 토폴로지 — spec §3 thick router(personal) + generic leaf **vs** plan.md flat standalone. R19 private 경계와 직접 합류(router=private, leaf=public).
- **R21**: 5개 ADR 후보(engine dir convention, staleness persistence format, golden-set tooling, swap ceremony, setup scope) 일괄 ratify/override.
- 임계(5%) 도달 시 → plan.md를 ratify된 결정으로 reconcile(edit) + 이 record FINALIZE + dynamic-workflow build-sequencing 섹션 확정.

### R20 — skillify 패키징 토폴로지 (잠금)
사용자 선택: **1 — thick router(private) + generic public leaf.**
- spec §3/§9 원안 복원. plan.md의 flat standalone 구조를 **override**.
- 단일 **thick router 스킬**(personal): vault 조작 레시피·워크플로 선호 총망라, env로 개인 config 주입 → **R19 private 격리 대상**(gitignore/submodule).
- **generic public leaf**: ingest/retrieve/wiki/compile/terminology — 개인색 제거 → public 가능.
- **distill = standalone 유지**(R16, 라우터 leaf 아님).
- 현 bstack/second-brain 라우터의 진화형(검증된 프로토타입) 재사용.
- ⟹ **plan.md reconcile 시**: router 스킬 1개 신설 + 기존 flat 스킬을 leaf로 reframe + public/private 경계선 = router↔leaf 경계.
- **신규 ADR 후보 +1**: "thick-router/leaf 분리 + private 경계" → R21 일괄에 합류(총 6 후보).

### Plan-HOW Ambiguity 진행 (R20 후)
~14% → **~8%** (패키징 토폴로지 + private 경계 동시 해소). 잔여 최대 갭 = 6개 ADR 후보(plan이 ①~⑤ 디폴트 제안) → **R21 일괄 ratify/override**.

### 다음 라운드 (갱신)
- **R21**: 6개 ADR 후보 일괄 — ① engine 모듈 dir convention(plan 공란→디폴트 채움) ② staleness 영속화 포맷=JSON ③ golden-set 하니스=vitest named suite ④ R18 swap ceremony=M5 step7 절차 ⑤ setup 인터뷰 scope=6 binding dims ⑥ thick-router/leaf 분리(R20 신규). 그대로 ratify or 개별 override.
- R21 후 임계(5%) 예상 도달 → plan.md reconcile(edit) + record FINALIZE + dynamic-workflow build-sequencing 확정.

### R21 — 6개 ADR 후보 일괄 (잠금)
사용자 선택: **전부 ratify.**
- ① engine dir convention: `src/engine/{embed,index,graph,retrieve,wiki,distill}/` — 컴포넌트당 sub-dir 1개·README 필수·루트 loose 파일 금지. 신규 capability=새 named dir. (plan 공란 → 이 디폴트로 확정)
- ② staleness 영속화: **JSON** `.llmwiki/staleness.json`(human-readable, delete→전부 DIRTY reset, gitignored·never-synced). concept-unit 단위(≪20k)라 JSON 충분. SQLite는 프로파일링이 rewrite 비용 입증 시에만.
- ③ golden-set 툴링: **vitest named suite** `test/golden-set/`, CI skip, `RUN_GOLDEN=1` env gate(R2 manual-only 인코딩).
- ④ swap ceremony: **M5 step7** — parity pass→`src/search/`→`src/search.legacy/` rename(swap commit)→MCP flip→1릴리스 후 별도 PR 삭제.
- ⑤ setup scope: **6 binding dims**(folder·provenance·lint SSOT·embedder·ignore·routing)만. full ambiguity engine 제외. 출력=`vault/.oms/taxonomy.yaml`만(Non-Sticky guard).
- ⑥ router/leaf 분리: R20 결정을 ADR로 기록. private 경계=router↔leaf.

### Plan-HOW Ambiguity — THRESHOLD MET ✅
~8% → **~3% (< 5% 임계 통과)**. plan/HOW 차원 인터뷰 종료(R18–R21).

| HOW Dimension | 최종 |
|---|---|
| Sequencing/Milestone | ✅ M1–M5 + completion gate + Option B 제약병렬 |
| Replace strategy (R18) | ✅ 병렬→parity→swap |
| Repo 토폴로지 (R19) | ✅ A 모노레포+private 격리 |
| 패키징/router (R20) | ✅ thick router(private)+public leaf+distill standalone |
| 6 ADR (R21) | ✅ 전부 ratify |

---

## CRYSTALLIZE — plan.md reconcile 지시 (R18–R21 → plan 반영) — ✅ EXECUTED (2026-06-13)
> 결과: plan.md 369→424줄(미커밋 → body mutable, immutability 미발동). 적용: Approach 문단에 router/leaf+monorepo 명시, 신규 §Skill Packaging & Repo Topology(R19/R20), Files Affected에 `private/`·`private/skills/router/*`·`config.local.json` 4행 + `.gitignore` 갱신, ADR Block follow-ups 2건 "Decided(R21)" 표기, Cross-Cutting 6건 `[x] ✅ R21` ratified(+⑥ router/leaf 신규), 신규 §Build Sequencing / Dynamic Workflow(post-approval, 발사 금지).
> planner 초안 plan.md를 아래 ratified 결정으로 **edit(=not rewrite)**:
> 1. **Approach/Files**: flat skills → **thick router(private) + generic leaf + distill standalone** 재구성. router = R19 private 격리(gitignore/submodule).
> 2. **Cross-Cutting → Decided**: 6 ADR 디폴트 확정값 기입(① dir convention 채움 ②JSON ③vitest ④M5step7 ⑤6dim ⑥router/leaf 신규).
> 3. **신규 섹션 "Build Sequencing / Dynamic Workflow"**: M1→M5 pipeline workflow(worktree 격리 병렬 컴포넌트 빌드 + adversarial parity 검증). **승인 후 실행**, 지금 발사 금지.
> 4. frontmatter: spec slug 유지, status는 승인 절차 따름.

## RECORD STATUS: FINALIZED ✅ (spec R1–R17b + plan R18–R21, ambiguity ~3% < 5% 임계)

---

## Post-Finalization Locked Principles — R22 (2026-06-14)

> 인터뷰 임계는 R21에서 통과(~3%)했다. 이 라운드는 구현 과정에서 명시적으로 잠금된 두 불변 원칙을 /documents 라이프사이클에 기록한다. 공식 결정은 ADR-007에 있으며, 이 섹션은 인터뷰 record의 연속으로 맥락을 보존한다.

### R22 — 임베딩 무결성 불변 (잠금) → ADR-007

**P-A — 네이티브 차원 무결성 (no-projection / native-dim integrity)**

사용자 verbatim 의도: "embedding dimensions are NEVER projected/folded/truncated — qmd and gbrain never do, and neither do we. native-dim-in == stored-dim-out. The engine embeds EmbeddingGemma-300M at full 768d (no modulo fold); Upstage Solar at 4096d. The 768->64 modulo fold in `src/search/semantic-embedding-provider.ts` is the LEGACY regression floor only, removed AT the #5 swap, never copied into the engine."

- **불변**: 임베딩 차원은 절대 투영·폴딩·절단하지 않는다. `native-dim-in == stored-dim-out`.
- 신규 엔진: EmbeddingGemma-300M = **768d**(전체), Upstage Solar = **4096d**(전체).
- `src/search/semantic-embedding-provider.ts`의 768→64 모듈로 폴드는 레거시 회귀 층 전용. `#5 swap` 시 완전 제거. `src/engine/`에 복사 금지.
- Solar 4096d가 pgvector HNSW 한계를 초과하는 것은 이 불변의 귀결 — exact scan + Qwen3-Reranker로 대응(ADR-002).

**P-B — 프로덕션 경로 가짜 임베더 폴백 금지 (no fake stub as unintended fallback in production)**

사용자 verbatim 의도: "a fake/stub provider used when a real model is missing must never sit on a production path — that is an unintended fallback. Verify with TEST code instead; test-only stubs live in *.test-helper.ts / *.test.ts and are never importable by production; do not leave decommission-marked dead code lying around. The production embedding factory requireRealEmbeddingProvider THROWS (citing OMS_MODEL_PATH) when no real model/key is configured — it never silently substitutes a fake embedder. (The hash-projection embedder, never in the plan, was removed from production and moved to a test-helper.)"

- 테스트 전용 스텁: `*.test-helper.ts` / `*.test.ts`에만. 프로덕션 임포트 불가.
- 폐기 표시 데드 코드: 즉시 제거. 코드베이스에 잔류 금지.
- `requireRealEmbeddingProvider`: 실제 모델/키 미설정 시 예외 throw(`OMS_MODEL_PATH` 메시지). 가짜 임베더 묵시적 대체 없음.
- 해시-투영 임베더: 계획에 없었음. 프로덕션에서 제거 → 테스트-헬퍼로 이동 완료.

**공식 기록 위치**: [ADR-007 임베딩 무결성 불변](../../../decisions/ADR-007-no-fake-embedder-fallback-native-dim-integrity.md)
