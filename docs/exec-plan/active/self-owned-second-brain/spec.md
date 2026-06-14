---
title: Self-Owned Second Brain — Consolidation & De-coupling Design
slug: self-owned-second-brain
status: draft
created: 2026-06-13
created_by: claude-code
owner: beomsu
---

# Self-Owned Second Brain — Consolidation & De-coupling Design

## 1. Thesis — 탈종속 + Self-Owned 통합

**핵심 명제**: 내 의도(intent-data)가 담긴 지식을 omc wiki / omx / graphify 같은 *남이 소유한 도구·포맷*에 넣어 종속되는 것을 거부한다.

- 모든 것을 **내가 소유한 단일 시스템**으로 통합
- 개인적인 것은 external exposure 없이 **PRIVATE zone**에 보호
- **Dogfooding 원칙**: qmd·gbrain의 벡터/임베딩에 의존하는 대신, 그들의 좋은 아이디어만 흡수(꿀꺽)해 내 고유 엔진을 만든다

종속의 형태는 두 가지다:
1. **데이터 종속** — 내 노트/의도가 남의 store(`.omc/wiki/`, graphify store, project-memory)에 갇히는 것
2. **기능 종속** — 남의 API·서버·임베딩 서비스 없이는 내 지식에 접근 불가능해지는 것

---

## 2. Layer Model (L1–L6)

capability를 6층위로 MECE 분해.

| Layer | 하는 일 | 현재 위치 | 목표 위치 (통합 후) |
|-------|---------|----------|-------------------|
| **L1 Ingest** | URL/문서 → markdown 2개 (raw + 가공) | `bstack/second-brain/ingest` | 동일 — ingest 레시피 통합·표준화 |
| **L2 Store** | Vault 자체 (Ataraxia, Obsidian Sync, git 밖) | Ataraxia Obsidian vault | 동일 — vault는 single source of truth 유지 |
| **L3 Index/Embed** | 벡터 + 렉시컬 인덱스 | `oms` (sqlite-vec) + `qmd` 중복 | **단일화**: oms 엔진으로 통합, qmd 역할 재검토 |
| **L4 Wiki/Synthesis** | 노트를 엮어 backlink·contradiction·concept page 컴파일 (Karpathy LLM Wiki 패턴) | **현재 공백** | 신규: oms 백킹 (`semantic_query` + `graph_build`), Ataraxia vault에 write |
| **L5 Retrieve** | 질의 → 답 | `oms_semantic_query` / `qmd` / `omc wiki_query` 파편화 | **단일화**: oms로 통합, global MCP로 노출 |
| **L6 Distill** | 반복 워크플로 → skill, 외부 SKILL.md 흡수(꿀꺽) | `skillify` (bstack + craft 중복) | 단일 canonical skillify + absorb 기능 추가 |

---

## 3. Target Topology — 통합 후 구조

아래 결정은 **locked** (audit 전 번복 없음). `[open]` 표기는 audit 후 결정.

### 단일 시스템, 단 Private 분리

| Zone | 내용 | 노출 |
|------|------|------|
| **Public** | generic skill, 엔진 코드, non-personal 레시피 | repo 공개 가능 |
| **Private** | 개인 의도가 담긴 skill, vault 경로, 사람 이름, 개인 워크플로 | external 비노출 |

- "second brain" = private zone의 레시피 + env 주입 조합
- 코드와 personal data는 완전 분리 — skill 코드에 personal data 0

### 두꺼운 단일 라우터 스킬 (Single Thick Router)

```
user query
    │
    ▼
[Router Skill] ── vault 조작 레시피 총망라
    ├── ingest leaf
    ├── retrieve leaf
    ├── wiki/synthesis leaf
    ├── distill/skillify leaf
    └── ...
```

- 현 `bstack/second-brain` 라우터 패턴의 진화형 (second-brain 흐름만 흡수)
- user 개성(워크플로 선호, vault 구조)은 router 레벨에서 보존
- leaf skill은 generic → public 가능

> **bstack 흡수 범위**: 엄격한 전체 이관 아님 — second-brain 관련 지식 흐름만 oms로 흡수 (ingest → wiki → terminology → roundup → retrieve over the vault). `hermes/`·`life/`·`discord-ops`·`publish/`·`rss`·`tailscale`·`agent-workbench` 등은 흡수 대상이 아니며 bstack에 그대로 둔다.

### oms = 엔진 / 뇌 (gbrain 등가물)

- 임베딩(sqlite-vec) · graph · ontology · retrieve를 소유
- **전역 MCP**로 노출 — cwd와 무관하게 어느 작업 폴더에서도 vault 접속 가능
- L4 wiki 스킬: oms `semantic_query` + `graph_build` 백킹 → 개념 페이지를 Ataraxia vault에 write *(사용자 확정)*

### Global MCP 접근

- mount point: `oms` MCP server → vault path는 env var로 주입
- 어느 프로젝트에서 작업 중이든 `oms_semantic_query`, `oms_retrieve_context` 등 즉시 호출 가능

---

## 4. Privacy Model — 민감정보 = 환경변수, 계층 단위 주입

### 원칙

```
skill 코드  ←→  env var  ←→  personal data
  (public)       (경계)        (private)
```

- 모든 sensitive 정보는 **env var**로 저장, layer/tier마다 주입
- skill 코드에 personal data **0** — privacy = 코드/데이터 분리

### 표준 플레이스홀더 규율

| Env Var | 용도 |
|---------|------|
| `${ATARAXIA_VAULT_PATH}` | Obsidian vault 루트 경로 |
| `${AGENT_VAULT_PATH}` | agent 전용 vault 경로 |
| `${OWNER_EMAIL}` | 소유자 이메일 |
| `${PRIVATE_SKILL_PATH}` | private skill 루트 |

- `bstack/second-brain`이 이미 부분 적용 중 → 전 레이어로 확장
- env var 미설정 시 graceful error (silent fail 금지)

### 보호 경계

```
[Public Repo]          [Private Zone]
engine code      ←→   env vars + personal recipes
generic skills         vault content
```

---

## 5. De-coupling Targets — 끊어낼 종속

> **audit 완료** — 항목별 내 데이터 위치·포맷·lock-in·조치 정리.

### 중요 발견: oms vs omc 구분

**oms**(GoBeomsu/oh-my-second-brain)와 **qmd**는 **내 것**이다 — "끊어낼" 대상이 아니라 *통합할* 엔진이다.
끊어낼 대상은 제3자 도구: **omc(oh-my-claudecode), omx(oh-my-codex), graphify, devonthink(write), notebooklm(write)**.

### De-coupling Ledger

| 도구 | 내 데이터 위치 | 포맷 | Lock-in | 조치 | 우선순위 |
|------|-------------|------|---------|------|---------|
| **OMC wiki** | `.omc/wiki/*.md` (프로젝트별) | plain MD | MED — 실제 아키텍처 결정 담김: Health Sync(12 files), Upstage 에이전트 조교(20+), gongsiri(20+) | 각 프로젝트 `.omc/wiki/`를 vault로 migrate | **1순위** (irreplaceable) |
| **OMC project-memory.json** | `.omc/project-memory.json` (27+ 프로젝트) | JSON | LOW-MED — `customNotes[]`만 intent 있음 | `jq '.customNotes[]'`로 추출 후 vault note화 | 2순위 |
| **DEVONthink** | 바이너리 `.dtBase2` DB | proprietary | HIGH — 플랫폼 전체 탈출 불가 | `create_record`/`import_file` allowlist 차단; Claude 생성 레코드 audit/export | **즉시** |
| **NotebookLM** | Google cloud | Google 포맷 | HIGH | write tools 이미 미노출 — read-only 현상태 유지 | 현 조치 충분 |
| **OMC state/, notepad.md** | `.omc/state/`, `.omc/notepad.md` | MD/JSON | LOW | archive or discard | 3순위 |
| **OMS concepts/taxonomy** | `Ataraxia/.oms/concepts/*.yaml`(16) + `taxonomy.yaml` | YAML | LOW (내 것) | **⚠️ 발견**: oms 인스턴스 2개 불일치 — `settings.json` hook이 Ataraxia에서 `oms-guard`/`oms-post-guard` 자동 실행; `mcp.json`은 oms를 `/01_Project/oms`(다른 vault)로 마운트. 정리 필요. | 정리 대상 |
| **graphify** | `.trash/`에만 live data 없음 | — | LOW | 현재 주권 이슈 없음 (live data 없음) | 무시 |
| **QMD** | 로컬 cache 전용 | sqlite | LOW | 주권 이슈 없음; 오히려 **흡수 대상**(설계를 oms에 이식) | §6 참조 |

---

## 6. Own Engine — qmd·gbrain 흡수 설계

> **audit 완료** — oms 현황, qmd 설계, gbrain 평가 결과.

### oms 현황 — 벡터층 한계

| 항목 | 상태 | 설명 |
|------|------|------|
| 임베더 | 🔴 폐기 필요 | 기본 임베더 = 64-dim SHA1 해시 (neural 아님) |
| 청킹 | 🔴 없음 | 문서 통째로 처리, 긴 문서 처리 불가 |
| Sync | 🔴 전체 재작성 | 매 sync마다 DELETE + 재삽입, incremental 없음 |
| 배칭 | 🔴 미적용 | 선언만 되고 write path에서 실제 미사용 |
| 적정 규모 | 🔴 <1k 노트 | 20k 스케일 불가 |
| Ontology/Graph/MCP 셸 | 🟢 양호 | 17 tools (9 graph/ontology + 8 semantic) 유지 |

**결론**: oms 벡터 백엔드는 폐기. Ontology·graph·MCP 셸만 유지하고 **벡터층만 qmd 설계로 교체**.

### qmd = 이식할 레퍼런스 설계 (`store.ts`)

- **벡터스토어**: sqlite-vec `vec0` (cosine 유사도)
- **Content-addressable**: `content(hash, doc)` + `documents(collection, path, hash)` 테이블
- **청킹**: 900 token / 15% overlap, heading 경계 존중, code-fence 보호
- **하이브리드 검색**: BM25(lex) + vec + rerank + **HyDE** 조합
- **Collection context metadata** 지원
- **임베더**: 로컬 **EmbeddingGemma-300M** — 내 벤치마크에서 Qwen3-0.6B 대비 우월 확인
- **증분 sync**: hash 변경된 문서만 재임베딩 (전체 재작성 없음)
- **실증 규모**: 16k docs / ~1GB, 서버 0, 100% 로컬

### gbrain — 도구 불채택, 로직만 흡수

**gbrain 도구 자체는 사용하지 않는다(런타임으로도).** 흡수 대상은 gbrain의 **로직**뿐 — atomic-state+lock 증분 sync 패턴, pgvector 스키마, 3-stage(index→embed→push) 파이프라인. 내 자체 pgvector 엔진을 구축한다.

| 이유/흡수 대상 | 내용 |
|------|------|
| 프라이버시 위험 (불채택 사유) | 기본값이 Voyage/OpenAI API로 문서 외부 전송 |
| 흡수할 로직 ① | atomic-state + lock 증분 sync 패턴 (`~/.gstack/.gbrain-sync-state.json` + lock 파일) |
| 흡수할 로직 ② | pgvector 스키마 설계 |
| 흡수할 로직 ③ | 3-stage(index→embed→push) 파이프라인 |

### 결정: 교체 전략

```
oms 유지 항목          교체 항목
────────────────       ─────────────────────────────
ontology layer    →    유지
graph layer       →    유지 (backlink O; contradiction/synthesis 신규 구현 필요)
MCP 셸 (17 tools) →    유지
벡터 백엔드       →    qmd store.ts 설계로 교체
임베더            →    EmbeddingGemma-300M (로컬)
sync pipeline     →    증분 (hash-diff 방식)
```

이로써 **qmd 의존도를 내부화하여 제거** — qmd는 설계를 기여하고 은퇴.

### 목표 요건 (확정)

| 요건 | 방법 |
|------|------|
| Local & Private | 외부 서버 0, EmbeddingGemma-300M 로컬 실행 |
| 20k 노트 스케일 | sqlite-vec + hash-diff 증분 sync |
| No external embedding API | EmbeddingGemma-300M |
| Single index | oms 단일 인덱스, qmd 은퇴 |

### §6.x — 엔진 아키텍처 결정 (ADR 포인터)

> UX 원칙: 사용자 관점에서 단순하다 — **"embed하면 임베딩이 된다"**. 단일 embed 작업이 벡터 인덱스와 그래프를 동시에 구축한다. keyword / semantic / graph 세 검색 모드 모두 동일한 전역 MCP에서 cwd 무관하게 제공된다 (qmd 방식과 동일).

세부 결정은 각 ADR에 위임한다 — 이 섹션은 링크 맵이다.

| ADR | 핵심 결정 |
|-----|----------|
| [ADR-002 벡터 임베딩 백엔드](../../../decisions/ADR-002-vector-embedding-backend.md) | 스토어: PGLite/pgvector 주, sqlite-vec 폴백, 플러그인 교체 가능. 비대칭 임베더: Upstage Solar passage/query 분리. 임베더 티어: 경량 로컬 기본 → 고품질 로컬 → commercial opt-in. HNSW dim 제한 정책: vector≤2000 / halfvec≤4000 / Solar 4096 → 양자화·차원축소·서브벡터·exact+rerank 중 선택. RRF+rerank 퓨전(qmd MCP 인터페이스 미러링, gbrain 강화). content-hash 증분 sync. **unified embed**: 벡터 + 그래프를 단일 작업으로 동시 구축. |
| [ADR-004 설정·민감정보·접근 토폴로지](../../../decisions/ADR-004-config-secrets-access-topology.md) | 3-tier: 전역 `~/.config/vault-search/` 엔진 설정 + 단일 secrets 저장소 / vault 거주 온톨로지 / 저장소별 `.oms` 마커(포인터+권한). "설정/민감정보는 한 곳에 모여야 한다" 요구 충족 — global 설정 우선(vault 내 설정은 순환 참조가 됨). |
| [ADR-005 그래프 접근 모델](../../../decisions/ADR-005-graph-access-model.md) | frontmatter-관계 에지(OMS 갭 해소). 4-tier 가중 에지. **두 모드**: 캐시 전체 그래프(embed 시 구축, 대규모 조회용) + 실시간 희소 로컬 그래프(온디맨드, Obsidian 방식, 항상 최신). 실시간 희소 모드가 "실시간 graph 조회" 요구를 해소. |

**참조 자료**:
- [`docs/research/retrieval-engine-design-references.md`](../../../research/retrieval-engine-design-references.md) — 검색 엔진 설계 레퍼런스 종합
- [`docs/research/references/pgvector-hnsw-limits.md`](../../../research/references/pgvector-hnsw-limits.md) — pgvector HNSW dim 제한
- [`docs/research/references/hnsw-paper.md`](../../../research/references/hnsw-paper.md) — HNSW 논문
- [`docs/research/references/upstage-solar-api.md`](../../../research/references/upstage-solar-api.md) — Upstage Solar API

---

## 7. Distillation — 외부 스킬 흡수(꿀꺽)

> **audit 완료** — bstack vs craft diff, absorb 기능 현황.

### Canonical 결정: craft-skills skillify v3.0.4

| 항목 | bstack v3.0.2 | craft v3.0.4 | 결정 |
|------|--------------|-------------|------|
| 개인명 | Beomsu 잔존, "우리끼리만" 문구 | 없음 (generic) | craft 채택 |
| CHANGELOG | `# Change Log` — Layer-1 위반 | 표준 형식 | craft 채택 |
| Plugin discovery routing | 구형 | Claude Code plugin discovery 맞게 수정됨 | craft 채택 |
| 역할 | upstream 참조용 | **SSOT** | **craft = canonical** |

- **bstack v3.0.2** = 참조/제거 대상 (개인식별 정보 잔존)
- **craft v3.0.4** = 유일한 canonical, 여기서 파생

### Absorb 기능 현황

```
내 세션 harvest  ✓ (현재 구현)
외부 SKILL.md 흡수  ✗ (oms에도 없음, 신규 구현 필요)
세션-trace 자동 harvest  ✗ (양쪽 모두 없음)
```

### 흡수(꿀꺽) 플로우 — `mode=absorb` 신규 설계

```
외부 SKILL.md path 입력
    │
    ▼
[reviewer agent 시작]        ← writer 건너뜀 (기존 skillify와 다른 점)
    │  trigger-fit 평가
    │  recipe 품질 audit (schemas.md §3 anatomy 기준)
    ▼
[비식별화]                    ← 개인정보 strip
    │  개인명/경로/이메일 → env var placeholder
    ▼
[일반 create/update 게이트]   ← 기존 skillify 후반부 재사용
    │
    ▼
내 private skill zone
```

- **진입점**: skillify writer Step4가 schemas.md §3 anatomy를 이미 가리킴 → absorb 진입점으로 적합
- writer pass 없이 **reviewer부터 시작**하는 것이 핵심 차이점

> **audit 완료 (license)** — 공개 skill repo 라이선스 검토: 흡수 대상 SKILL.md들은 MIT/Apache 또는 라이선스 명시 없음. 비식별화 후 private zone 사용은 attribution 의무 없음. Public 재배포 시에는 upstream 표기 권장.

---

## 8. Open Decisions

### 해소된 결정

| 결정 사항 | 결론 |
|---------|------|
| **자체 엔진 방향** | oms에 qmd 벡터 설계 이식. gbrain 도구 불채택 — 도구 자체는 사용하지 않는다(런타임으로도). gbrain의 **로직만 흡수**(atomic-state+lock 증분 sync, pgvector 스키마, 3-stage 파이프라인)하여 자체 pgvector 엔진을 구축한다. |
| **skillify canonical** | craft-skills v3.0.4 = SSOT. bstack v3.0.2 참조/제거. absorb 모드 신규 설계 완료. |

### 잔존 결정 (사용자 확정 필요)

**물리적 단일 repo 병합 vs. 논리적 통합**

| 안 | 구조 | 설명 |
|----|------|------|
| **A** | monorepo + gitignored/submodule private zone | 단일 repo, private 영역만 격리 |
| **B** | public repo + private repo 2분리 | 엔진/generic skills public, personal overlay private |
| **C** | 현행 3-repo 유지, 의존방향만 oms로 고정 | 최소 변경, 장기 부채 잔존 |

권고 초안: ~~A 또는 B~~ → **✅ RESOLVED (deep-interview R19, 2026-06-13): 안 A — monorepo + gitignored/submodule private zone.** 엔진·generic leaf = public, personal(레시피·vault 경로·이름) = `private/` 격리(submodule는 upgrade path). B·C 기각. 상세: `plan.md` §Skill Packaging & Repo Topology + `deep-interview-record.md` R19.

| 결정 사항 | 옵션 A | 옵션 B | 현재 기울기 |
|---------|--------|--------|-----------|
| **`.oms/concepts/*.yaml` 온톨로지** | oms YAML 포맷 유지 | vault 노트로 평탄화 | 미결 |
| **qmd 완전 은퇴** | 설계 이식 후 즉시 은퇴 | 과도기 병행 운영 | 미결 |
| **(잔존) `.oms` 마커 스키마 확정** | 권한 zone 표현, agent-id, vault 포인터 포함 여부 | — | 미결 |
| **(잔존) 온톨로지 fine층 "개념 승격" 합성 패스 트리거** | 수동 실행 | ingest 후 자동 트리거 | 미결 |

### oms L4 Wiki 백킹 평가

**현재 가능한 것** (17 MCP tools):
- `graph_build`: backlink/wikilink 그래프 구성 ✓
- `semantic_query`: vec + BM25 하이브리드 검색 ✓ (벡터층 교체 후)
- `oms_retrieve_context`: 컨텍스트 기반 문서 묶음 ✓
- `oms_list_concepts`: 온톨로지 개념 열거 ✓

**Missing — 신규 구현 필요**:
- contradiction 감지 (상충 노트 식별) ✗
- synthesis 레이어 (여러 노트 → 개념 페이지 자동 컴파일) ✗
- vault write-back (개념 페이지를 Ataraxia에 저장) ✗ (MCP capture tool 있으나 L4 전용 write 흐름 미구현)

**결론**: graph(backlink) + semantic retrieve는 충분. contradiction/synthesis 신규 구현 필요 — 1차는 backlink 기반 concept page 생성만으로 시작 가능.

---

## Scorecard — oms "Single Brain" Readiness

| 항목 | 상태 | 비고 |
|------|------|------|
| **Embedding 품질** | 🔴 미흡 | 64-dim SHA1 해시 → 512+ dim neural 교체 필요 |
| **Scale 안정성** | 🔴 위험 | 매 sync 전체 재작성 → hash-diff 증분 sync 필요 |
| **MCP 노출** | 🟢 양호 | 17 tools: 9 graph/ontology + 8 semantic + qmd 호환 alias |
| **Graph 완성도** | 🟡 부분 | backlink/wikilink ✓ — contradiction/synthesis ✗ |
| **Distillation** | 🔴 전무 | 코드/CLI/MCP 0 → mode=absorb 신규 구현 필요 |
| **Personal coupling** | 🟢 깨끗 | 런타임 generic, publishable |
| **종합** | 🟡 partial | 벡터층 교체 + distillation 추가 후 production-ready |

---

## 9. Recommended Topology (post-audit)

### 핵심 원칙

**oms = 단일 self-owned 엔진/뇌.** 전역 MCP (`OMS_VAULT` env로 cwd 무관). qmd 벡터 설계 이식, EmbeddingGemma-300M 로컬, 증분 sync.

### 컴포넌트 구성

| 컴포넌트 | 역할 | 구현 방향 |
|---------|------|----------|
| **oms (engine)** | 벡터+그래프+온톨로지+retrieve | qmd store.ts 설계 이식; EmbeddingGemma-300M 로컬; hash-diff 증분 |
| **단일 라우터 스킬 (personal)** | vault 조작 레시피 총망라 | ingest·wiki·people·roundup·terminology… leaf routing; oms MCP 호출; 개인 config 전부 env 주입 |
| **L4 wiki (Karpathy)** | 개념 페이지 컴파일 | oms `semantic_query` + `graph_build` 백킹 → Ataraxia vault write; backlink 1차, contradiction/synthesis 신규 구현 |
| **distillation** | 외부 스킬 흡수(꿀꺽) | skillify craft v3.0.4 (canonical) + mode=absorb 신규 |

### Privacy = 코드/데이터 분리

```
skill 코드 (public/generic)  ←env→  개인 config
                                     vault (.oms cache, .env)
                                     personal recipes (private overlay)
```

- 진짜 private = *데이터* — vault, `.oms` cache, `.env` → **절대 git 밖**
- 비식별 불가한 개인 *레시피*만 private overlay (submodule or gitignored)

### bstack public/private 분리선

> **bstack 흡수 범위**: 엄격한 전체 이관 아님 — second-brain 관련 지식 흐름만 oms로 흡수 (ingest → wiki → terminology → roundup → retrieve over the vault). `hermes/`·`life/`·`discord-ops`·`publish/`·`rss`·`tailscale`·`agent-workbench` 등은 흡수 대상이 아니며 bstack에 그대로 둔다.

| Zone | 항목 |
|------|------|
| **Private** | `life/`, `hermes/`, `discord-ops`, `publish/deploy-quartz`, `youtube-*`, `second-brain/people·roundup·ledger·daily-thinking-capture`, `rss`, `clawhip`, `obsidian-sync` |
| **Public (generic)** | `gws`, `tailscale`, `agent-browser`, `obsidian-*`(markdown/canvas/bases/mermaid/cli/plugin-doctor), `second-brain/ingest·defuddle·lint·terminology·book·zotero·trip-planning`, `evidence-archive`, `skillify` |

> ⚠️ **즉시 조치**: `rss/rss.env`에 Discord guild/channel ID 커밋됨 → env화 + rotate + git history scrub.

---

## 10. Ontology 구축 전략 — 창발(emergent) + 얇은 척추

> "llm-wiki를 구축하는 것은 온톨로지의 한 축일 뿐, 총체적인 지식 구조가 합쳐져서 온톨로지가 된다."

온톨로지는 단일 구조가 아니다. 아래 4축이 결합해 총체적 지식 그래프를 형성한다:

| 축 | 구조 | 역할 |
|----|------|------|
| **coarse** | 폴더 분류체계 | 탐색 가능한 거시 분류 |
| **mid** | frontmatter 그래프 (선언된 관계) | 결정론적 backbone — deterministic edges |
| **synthesis** | LLM-Wiki (Karpathy/L4) | 합성·복리(compounding) 레이어 — **이것은 온톨로지의 한 축**, 전체가 아님 |
| **semantic** | 벡터 임베딩 | 의미 기반 유사도 축 |

Wiki(L4)는 합성·복리 레이어를 담당한다. 폴더·frontmatter 그래프·임베딩이 나머지 세 축을 채운다. 온톨로지는 이 네 축의 합집합(union)에서 창발한다.

원칙: 거대 분류체계를 위에서 설계하지 않는다. 두 실패모드(① 못 채울 분류체계 과설계 ② 구조 없는 더미)를 피하는 3층 모델.

| 층 | 무엇 | 안정성 | 어떻게 |
|----|------|--------|--------|
| **L-coarse 폴더 분류** | 기존 번호폴더(00 Inbox·10 Time·30 Literature·40 Permanent·50 AI·70 Collections·80 References…)가 이미 사실상의 온톨로지. oms가 *읽는다*, 새로 발명하지 않음. = `taxonomy.yaml` 척추. | 거의 불변 | 기존 폴더구조 흡수 → `taxonomy.yaml`로 시드 |
| **L-mid frontmatter 축(axes)** | 타입 속성(`created_by`·`type`·`tags`·`source`) — slice/retrieve 기준. folder↔contract 검증(`oms_validate_contract`)이 여기. | 가끔 변함 | 핵심 axis 몇 개만 정의, contract 검증으로 강제 |
| **L-fine 개념 그래프 / 위키 페이지** | 실제 개념 노드 = 위키 페이지, edge = backlink. bottom-up 창발 — 손으로 안 짜고 ingest/distil/wiki가 채움. | 매 ingest 성장 | 반복 tag/link를 명명된 개념으로 승격(bottom-up 통합) |

**실천 원칙**

- coarse(폴더) + 핵심 axis 몇 개만 시드; fine층은 ingest가 채우게 둔다
- 주기적 합성 패스로 **반복 tag/link를 명명된 개념으로 승격**(bottom-up 통합)
- 시드 재료는 이미 존재: 기존 `terminology` 노트 + qmd `index.yml`의 폴더별 `context:` 설명 = 경량 온톨로지 → 흡수해서 출발
- ⚠️ oms `.oms/concepts/*.yaml` 16개 + `taxonomy.yaml`가 이미 vault에 있음 — 이걸 coarse/mid 시드로 재사용

### §10.x — LLM-Wiki 레퍼런스 기반 온톨로지 구축 제안 (Karpathy에서 출발, 구현체 흡수)

> 근거 문서: [docs/research/llm-wiki-ecosystem-design-references.md](../../../research/llm-wiki-ecosystem-design-references.md)
> 이 섹션은 설계 의도(design intent)를 기록한다. 결정이 아닌 제안 — 구현 전 사용자 확정 필요.

4개 실존 구현체(Karpathy gist, Astro-Han SKILL.md, nashsu/llm_wiki, nvk/llm-wiki + lucasastorian/llmwiki)에서 패턴을 흡수해 §10 3층 모델과 L4 wiki SKILL.md를 구체화한다.

#### 1) 출발점 — Karpathy canonical + Astro-Han 골격

**L4 wiki SKILL.md의 뼈대**:

- **Karpathy canonical** (https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f, 2026-04-04): compile-once compounding artifact 원칙, `ingest` / `query` / `lint` 3 operation, `wiki/index.md`(매 ingest마다 갱신되는 전역 카탈로그, 항상 먼저 읽음) + `wiki/log.md`(append-only, `## [YYYY-MM-DD] ingest | Title`) 두 파일.
- **Astro-Han SKILL.md 템플릿** (https://github.com/Astro-Han/karpathy-llm-wiki/blob/main/SKILL.md): `raw/`(불변 원본, LLM 수정 금지) + `wiki/`(LLM 전부 소유, 토픽 서브디렉토리 1단계만) 구조. init-if-missing, 절대 덮어쓰기 금지. ingest = fetch+compile 항상 2-step. cascade pass(주 페이지 갱신 후 관련 페이지 ripple 갱신, archive 제외). lint 2-tier(auto-fix: 인덱스 일관성·내부 링크·See Also / report-only: 사실 모순·outdated·orphan). query 원칙 "Prefer wiki content over training knowledge".

#### 2) Fine 층(창발 개념 그래프) — nashsu 4-signal → OMS graph_build 흡수

nashsu/llm_wiki (https://github.com/nashsu/llm_wiki)의 composite edge weight 공식을 OMS `graph_build` edge 속성에 명시 저장:

| Signal | Weight | 특성 |
|--------|--------|------|
| Direct wikilink `[[]]` | ×3.0 | 명시적 참조 |
| **frontmatter `sources[]` / relations 중첩** | **×4.0** | **가장 강한 신호 — deterministic** |
| Adamic-Adar (공통 이웃) | ×1.5 | 토폴로지 추론 |
| Type affinity (같은 page type) | ×1.0 | 스키마 동질성 |

> ⚠️ nashsu 원본의 정확한 결합식(합/최대/곱)은 미공개. 경험적 튜닝 필요 — 초기값은 가중 합으로 시작.

**`sources[]` / relations frontmatter가 1급 edge 소스**임을 명시. 이는 곧 완성될 frontmatter-graph 에이전트 결과와 자연스럽게 합류하는 자리다 — frontmatter가 graph의 deterministic backbone임을 설계 의도로 고정.

#### 3) Coarse/Mid 층 진단 — Louvain over weighted graph (진단 전용)

- **방법**: 임베딩이 아닌 **링크 토폴로지 위** Louvain community 검출 (nashsu: `graphology-communities-louvain`).
- **cohesion 임계값**: intra-edge density < 0.15이면 해당 클러스터/폴더가 너무 sparse하다는 진단 신호 → 폴더 분류 재검토 또는 mid층 axis 추가 제안.
- **자동 페이지 생성 금지**: nashsu도 진단 전용으로만 사용. 클러스터 검출 결과는 human-gate 리뷰 큐로만 노출.

#### 4) Ingest 파이프라인 — nashsu 2-step CoT + SHA256 캐시 + nvk credibility gate

```
소스 입력
    │
    ▼
[Credibility gate]           ← nvk: peer-review/recency/author/bias 점수, threshold 미달 reject
    │
    ▼
[SHA256 캐시 확인]            ← nashsu: 무변경 소스 스킵
    │
    ▼
[Step 1 CoT 분석]             ← nashsu: 엔티티/개념/논점/모순/구조 추천
    │
    ▼
[oms_semantic_query 유사도 선검출]  ← OMS 추가: merge/create 판정을 LLM 주관이 아닌 벡터 유사도 기반으로
    │  유사 페이지 있으면 merge 후보, 없으면 신규
    ▼
[Step 2 생성]                 ← nashsu: source summary + entity/concept 페이지, [[wikilink]] 삽입
    │
    ▼
[cascade pass]               ← Astro-Han: 관련 페이지 ripple 갱신
    │
    ▼
index.md 갱신 + log.md append
    │
    ▼
[lint 리뷰 큐]               ← nashsu typed: contradiction/duplicate/missing-page/suggestion
```

- **merge 판정 환각 제거**: Astro-Han의 "same core thesis" 판단을 LLM에 완전 위임하지 않고 `oms_semantic_query` 유사도 선검출 후 결정.
- **contradiction 표기**: typed lint 큐(`contradiction` 타입) → human 리뷰. 인라인 annotation 컨벤션: `> **Conflict:** A claims X; B claims Y. Unresolved.` (Karpathy와 Astro-Han 양쪽이 비어있는 갭 — 신규 정의).

#### 5) 오케스트레이션 — nvk 관점별 fan-out 모델

nvk/llm-wiki (https://github.com/nvk/llm-wiki, Apache 2.0)에서 흡수:

- **Research fan-out**: 작업 분할이 아닌 **관점별**(Academic / Technical / Applied / Contrarian / Historical …). Thesis mode = Supporting vs Opposing 역할 분리로 확증편향 방지.
- **3 phase 하드 분리**: Research(병렬) → credibility gate → Compile(항상 순차) → Query(read-only).
- **멀티라이터 동시성**: 구조적 회피 우선 — `raw/` 불변, compile 순차, 토픽/네임스페이스 격리. nashsu식 디스크 영속 serial queue 보완.
- **write 응답에 backlink/staleness 반환** (lucasastorian 패턴): agent가 write 직후 영향받는 페이지를 알 수 있어 cascade pass를 스스로 이어감.

#### 6) 전역 cwd-독립 접근

- **nvk AGENTS.md 이식 원칙**: 단일 파일로 이식 가능한 프로토콜 → 우리 SKILL.md가 어느 cwd에서도 `OMS_VAULT` env만 있으면 동작.
- **lucasastorian "전역 1서버 + knowledge_base 파라미터"** → 우리 OMS 전역 MCP(`OMS_VAULT` env 주입)와 정합. `.oms` 마커(§11)가 현재 workdir의 vault 포인터와 권한을 공급.

#### 7) OMS 우위로 교체/신설할 것 (구현체 대비 갭)

기존 구현체들이 비어있거나 약한 부분 — 우리가 OMS 백킹으로 개선해야 하는 항목:

| 갭 항목 | 기존 구현체 방식 | OMS 개선 방향 |
|---------|---------------|--------------|
| **링크 식별자** | 파일경로 기반 wikilink | OMS 개념 ID 기반 (rename에 견고) |
| **provenance 저장** | 본문 blockquote (`> Source:`, `> Raw:`) | OMS custom metadata (쿼리 가능, 본문 비오염) |
| **split 트리거** | 없음 | >8 sub-concept 교차참조 시 분할 후보 신설 |
| **contradiction 컨벤션** | 없음 (Karpathy·Astro-Han 양쪽 갭) | `> **Conflict:** A claims X; B claims Y. Unresolved.` 표기 신설 |
| **merge 판정** | LLM thesis 주관 판단 | `oms_semantic_query` 유사도 선검출 후 결정 (환각 제거) |

---

## 11. Access Model — `.oms` 마커 + 전역 MCP

핵심 통찰: 에이전트가 *일하는 곳*(cwd, 아무 repo)과 *뇌가 사는 곳*(vault, 고정)을 분리. MCP가 다리.

**1) 전역 엔진·고정 vault**

oms MCP를 프로젝트별이 아니라 유저 레벨로 등록(`OMS_VAULT=~/Documents/Obsidian/Ataraxia`), 글로벌 mcp 설정에 → 모든 세션·모든 cwd에서 접근. qmd가 "어디서든" 되는 방식과 동일한 패턴.

**2) `.oms` 마커 = 스코프+권한 부여 (엔진/스토어 아님)**

작업 폴더의 `.oms`는 별도 뇌를 띄우는 게 아니라 전역 oms에게 권한·컨텍스트를 알려주는 경량 config.

| 담는 것 | 설명 |
|---------|------|
| **write zone** | 이 폴더 에이전트가 CRUD 가능한 zone (예: `15. Work`·`00. Inbox` write, 나머지 read-only) |
| **provenance** | 자동 `created_by: <repo 에이전트 id>` |
| **project context** | 노트 출처 기록 (어느 프로젝트에서 생성됐는지) |

> ⚠️ 불변식: **마커는 포인터+권한만, 데이터는 canonical vault에 단 한 번.** 데이터 복제 금지.

**ownership/CRUD 메커니즘 (이미 절반 존재)**

`oms_capture_prepare`/`oms_capture_commit`이 vault-path 봉쇄 + contract 검증으로 게이트됨 = ownership 메커니즘. `.oms` 마커가 현재 workdir의 봉쇄경계+provenance 공급.

```
repo X 에이전트가 commit
    │
    ▼
oms가 X의 `.oms` 권한 확인
    │
    ▼
created_by 찍고 frontmatter 계약검증
    │
    ▼
vault write
```

이는 vault 기존 **Routing Law(agent-writable zone + created_by)의 기계 강제판**이며, 그 법을 임의 작업폴더로 확장한 federated 접근(뇌 1개·공유, 권한은 마커로 분배).

**정리 필요 (audit 발견)**

| 문제 | 현재 상태 | 수렴 방향 |
|------|----------|----------|
| oms 인스턴스 2개 불일치 | `mcp.json` → `/01_Project/oms`, `settings.json` 훅 → `Ataraxia` | canonical vault 단일화 |
| `.oms/` 캐시 분산 | 프로젝트마다 265MB graph 등 흩뿌려짐 | 마커 경량화, 캐시는 전역 vault 경로에 단일 위치 |

---

## 12. oms = Vault-Convention 자산 (default 온톨로지 + vault-ADR 투명성)

oms는 단순 검색·임베딩 엔진을 넘어 vault 조직 전략 자체를 **1급 shipped asset**으로 제공한다. ([ADR-003](../../../decisions/ADR-003-oms-vault-convention-asset.md))

- **의견 있는 default 폴더 온톨로지**: §10 L-coarse 층에 해당하는 `taxonomy.yaml`을 Ataraxia 구조(reference implementation)에서 추출해 제공. 신규 사용자는 검증된 구조에서 출발하며, `vault/.oms/` config로 override 가능.
- **Vault-ADR 투명성 메커니즘**: oms가 vault를 scaffold·재구성할 때 사람이 읽는 결정 노트를 vault 안에 기록. 모든 구조 변경 = vault 내 ADR. §11 Routing Law(`created_by` + agent-writable zone) 준수.
- **oms 소유 skill 2개**: `vault-scaffold`(default taxonomy 기반 vault 초기화) + `vault-decision-record`(구조 변경 시 ADR 자동 기록). ADR 규율을 내부 dev 관행이 아닌 *제품 자산*으로 취급.
- craft-skills `documents` 스킬이 코드 repo에 ADR/spec 규율을 부여하듯, oms가 vault(지식 repo)에 동일 규율을 부여하는 **의도적 대칭 설계**.
- 구현 전제: Ataraxia `taxonomy.yaml` 추출, `95. Decisions` zone 일반화, override 경로 필수 구현.

---

## Changelog

| 날짜 | 내용 |
|------|------|
| 2026-06-13 | 초안 생성, audit 5건 대기 |
| 2026-06-13 | audit 5건 반영, 권고 토폴로지 추가 |
| 2026-06-13 | bstack 흡수범위를 second-brain 흐름으로 축소, gbrain은 로직만 흡수로 명확화 |
| 2026-06-13 | §10 온톨로지 3층 전략, §11 .oms 마커+전역MCP 접근모델 추가 |
| 2026-06-13 | §12 추가: oms를 vault-convention 자산으로(default 온톨로지 + vault-ADR 투명성), ADR-003 |
| 2026-06-13 | §10.x 추가: LLM-Wiki 레퍼런스 기반 온톨로지 구축 제안 (Karpathy→Astro-Han 골격, nashsu 4-signal graph, Louvain 진단, nvk 오케스트레이션, lucasastorian cwd-독립 접근, OMS 갭 7항목) |
| 2026-06-13 | §10 서두 재구성: 온톨로지 = 4축(coarse·mid·synthesis·semantic) 합집합 프레이밍 추가, llm-wiki는 한 축임을 명시. §6.x 추가: 엔진 아키텍처 ADR 포인터 블록(ADR-002·004·005 + research refs) + UX 원칙("embed하면 임베딩이 된다"). |
