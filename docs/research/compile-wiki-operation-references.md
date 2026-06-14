---
title: "Compile & Wiki Stage 운영 레퍼런스 — C5 스킬 설계를 위한 구체 동작 수집"
slug: compile-wiki-operation-references
status: draft
created: 2026-06-13
created_by: research-agent
type: research
relates_to:
  - docs/exec-plan/active/self-owned-second-brain/spec.md
  - docs/exec-plan/active/self-owned-second-brain/deep-interview-record.md
  - docs/research/llm-wiki-ecosystem-design-references.md
---

# Compile & Wiki Stage 운영 레퍼런스

> **목적**: C5 스킬(Ingest→Compile→Wiki)에서 사용자가 이미 이해하고 있는 Ingest와 달리, **Compile**(합성 행위)과 **Wiki**(영속 페이지 컬렉션)가 실제 구현체들에서 어떻게 동작하는지 구체 레퍼런스를 수집한다. 이 문서는 `llm-wiki-ecosystem-design-references.md`(core 5 구현체 개요)의 자매 문서로, 운영 동작에 집중하고 C5 스킬 설계 권고로 귀결된다.
>
> **선행 문서**: `docs/research/llm-wiki-ecosystem-design-references.md`에서 Karpathy gist, Astro-Han SKILL.md, nashsu/llm_wiki, nvk/llm-wiki, lucasastorian/llmwiki의 개요가 이미 정리됨. 본 문서는 그 내용을 중복하지 않고 운영 세부를 보완하며, 미커버 구현체 6종을 추가한다.

---

## 1. Compile과 Wiki가 해야 하는 일 — 정의 요약

Deep Interview Record R12/R14 잠금에서 도출된 정의:

| 단계 | 역할 | 입력 | 출력 | 성격 |
|------|------|------|------|------|
| **Compile** | 재료 + 그래프 → 개념당 일관된 페이지 내용 생성 | `raw/`(외부) + `00.Inbox/`(개인 캡처) + OMS graph 컨텍스트 | `processed/` 중간 산출 (엔티티·요약) + `wiki/` 최종 페이지 | **동사/프로세스**. LLM 합성. SHA 증분 재컴파일. |
| **Wiki** | compile 산출 페이지들이 사는 영속·연결된 컬렉션 | Compile 산출 마크다운 | Ataraxia vault 1급 폴더 `wiki/`의 wikilink 연결 페이지군 | **명사/산출 표면**. 사람이 browse. |

**핵심 구분**: "Compile 단계가 Wiki 페이지를 생성한다." "wiki compile"은 부정확한 표현이다.

---

## 1.5 Per-Repo Quick Reference — Compile + Wiki 운영 속성

> 각 항목: (1) 라이선스 (2) Compile 핵심 단계/상태 (3) 폴더 레이아웃 (4) 증분/staleness 메커니즘 (5) 흡수 가능 수준
> `TODO(verify)` = 라이선스 또는 코드 확인 미완료.

| 구현체 | 라이선스 | Compile 단계/상태 | 폴더 레이아웃 | 증분/Staleness 메커니즘 | 흡수 수준 |
|--------|---------|-----------------|--------------|----------------------|----------|
| **Karpathy gist** | 미명시 TODO(verify) | 단일 pass: read→integrate→update existing pages→create new pages→flag contradictions→update index+log | `raw/` + `wiki/` + schema(CLAUDE.md) | 없음 (명시 없음) | 아이디어/패턴 |
| **Astro-Han SKILL.md** | MIT | fetch + compile 2-step 항상 실행; merge/create/span-topics 3-way 판단; cascade pass (ripple 갱신) | `raw/` (불변) + `wiki/` (LLM 소유, 1단계 서브디렉토리) | 없음 | 알고리즘 흡수 가능 |
| **nashsu/llm_wiki** | **GPL-3.0** ⚠️ | Step1 분석(entity/concept/arg/contradiction/recommendation) → Step2 생성(pages + wikilinks + index/log/overview 갱신); serial queue로 직렬화 | `wiki/entities/` + `wiki/concepts/` + `wiki/sources/` + `wiki/queries/` + `wiki/synthesis/` + `wiki/comparisons/` | **SHA256 소스 캐시** — 무변경 스킵; `lint.json` typed queue(contradiction/duplicate/missing-page/confirm) | **아이디어/알고리즘만 — 코드 verbatim 금지** |
| **nvk/llm-wiki** | Apache 2.0 | Phase1 Research(관점별 fan-out, 병렬) → credibility gate → Phase2 Compile(순차) → Phase3 Query(read-only); `.research-session.json` 크래시 복구 | `~/wiki/wikis.json`(registry) + `topics/<topic>/raw/` + `topics/<topic>/wiki/` + `output/` + `inventory/` + `inbox/` | 없음; 구조적 회피(raw 불변 + compile 순차 + 토픽 격리) | 알고리즘 흡수 가능 (Apache 2.0) |
| **lucasastorian/llmwiki** | Apache 2.0 | MCP tools(create/edit/append/delete)로 직접 파일 쓰기; write→backlink/staleness 반환으로 cascade 이어가기 | `[sources]` + `wiki/` + `.llmwiki/index.db`(파생 SQLite, 재구축 가능) | SQLite hash; **write 시 영향받는 backlink를 stale로 표시하고 응답에 반환** | 알고리즘 흡수 가능 (Apache 2.0) |
| **atomicstrata/llm-wiki-compiler** | 미확인 TODO(verify) | Phase1 전체 소스 개념 추출(쓰기 없음) → Phase2 페이지 생성; 순서 독립성 확보; `.llmwiki/candidates/` human 게이트 | `wiki/concepts/` + `wiki/queries/` + `wiki/index.md` + `.llmwiki/schema.json` + `.llmwiki/candidates/` + `.llmwiki/embeddings.json` | **content-hash 임베딩 캐시 + 캐시된 인용 판단 재사용** | 개념만 (라이선스 미확인) |
| **shannhk/llm-wikid** | 미확인 TODO(verify) | 7-phase: Sort→Resolve→ExtractMedia→Classify&Compile→CreatePages→BiasCheck→Reindex; 소스 유형별(transcript/paper/article/tweet) 차등 추출 | `raw/clippings/` + `raw/articles/` + `raw/papers/` + `wiki/concepts/` + `wiki/entities/` + `wiki/sources/` + `wiki/syntheses/` + `wiki/sops/` | git revert만; lint로 stale 탐지 | 개념만 (라이선스 미확인) |
| **AgriciDaniel/claude-obsidian** | 미확인 TODO(verify) | extract entities/concepts → create pages → cross-reference existing → update index + log → refresh hot.md | `.raw/`(불변) + `wiki/sources/` + `wiki/concepts/` + `wiki/entities/` + `wiki/sessions/` + `wiki/meta/hot.md` | **hot.md 세션 컨텍스트 버퍼** (~500 token); 증분 없음 | 개념만 (라이선스 미확인) |
| **braintrinity** | — | **Not Found** (다중 검색 후 미발견) | — | — | N/A |

---

## 2. 구현체별 Compile·Wiki 동작 상세

### 2.1 Karpathy canonical gist (2026-04-04)

**URL**: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f  
**선행 문서** `llm-wiki-ecosystem-design-references.md §A`에서 개요 커버됨.

**Compile 동작 보완**:
- 소스 1건 ingest 시 LLM이 10–15개 wiki 페이지를 수정. "reads it, extracts key info, integrates into existing wiki — updating entity pages, revising summaries, noting where new data contradicts old claims."
- Compile 트리거: 사람이 `ingest` 명령을 수동 실행. 자동화 없음.
- 개념 페이지 생성 기준: 명시되지 않음 — "create necessary new concept pages"라는 서술만. 기준은 LLM 판단에 위임.
- 증분 처리: 명시 없음 (Karpathy gist 자체는 SHA 캐시 미언급).

**Wiki 동작 보완**:
- `index.md`: 매 ingest마다 갱신되는 카탈로그. 페이지별 한 줄 요약. 항상 먼저 읽는다.
- `log.md`: append-only. `## [YYYY-MM-DD] ingest | Title` 형식. grep 가능.
- 페이지 업데이트 vs 신규 생성: 기존 page에 내용 병합(Astro-Han이 명시한 merge 판단 기준).
- **Scale 상한**: ~50k–100k 토큰 이내에서 "wins decisively." 그 이상은 RAG 보완 필요.

**Attribution**: Andrej Karpathy, https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

---

### 2.2 Astro-Han/karpathy-llm-wiki — SKILL.md 구현 (가장 운영 세부 풍부)

**URL**: https://github.com/Astro-Han/karpathy-llm-wiki/blob/main/SKILL.md  
**선행 문서** `llm-wiki-ecosystem-design-references.md §B`에서 개요 커버됨.

**Compile 동작 — 상세 판단 트리**:

```
새 소스 도착
    │
    ▼
[Merge 판단]
    ├── "same core thesis as existing article"  → 기존 페이지에 병합
    ├── "new concept"                           → 새 페이지 생성
    └── "spans multiple topics"                → 가장 관련 폴더 + See Also 교차참조
    │
    ▼
[Conflict 처리]
    새 소스가 기존 주장과 모순 → inline annotation 삽입 (컨벤션 미정의 — 갭)
    │
    ▼
[Cascade pass]
    주 페이지 완성 후 관련/같은 토픽 페이지 ripple 갱신
    archive 페이지는 cascade 제외
    │
    ▼
index.md 갱신 + log.md append
```

**결정적 갭**: "same core thesis" 판단을 LLM에 완전 위임 → 환각 위험. 우리는 `oms_semantic_query` 유사도 선검출로 대체 (spec §10.x 이미 명시).

**Wiki 동작**:
- `raw/` 불변 (LLM 절대 수정 금지), `wiki/` LLM 전부 소유
- 토픽 서브디렉토리 1단계만 허용 (`wiki/topic/page.md`)
- lint 2-tier: auto-fix (인덱스 일관성, 내부 링크 1-match 수정) vs report-only (모순, outdated, orphan)
- 페이지 provenance: 본문 상단 blockquote `> Source: URL` `> Raw: raw/filename.md`

**Attribution**: Astro-Han, https://github.com/Astro-Han/karpathy-llm-wiki (license: MIT)

---

### 2.3 nashsu/llm_wiki — 가장 성숙한 구현, 4-signal graph

**URL**: https://github.com/nashsu/llm_wiki  
**License**: GPL-3.0 → **아이디어/알고리즘 서술만, 코드 verbatim 금지**  
**선행 문서** `llm-wiki-ecosystem-design-references.md §C`에서 개요 커버됨.

**Compile 동작 — 2-step CoT 알고리즘**:

```
Step 1 (분석 패스):
  입력: 소스 원문
  출력: 구조화 분석
    - Key entities (사람, 조직, 제품, 기술)
    - Key concepts (이론, 방법, 패턴)
    - Main arguments / claims
    - Connections to existing wiki content
    - Contradictions & tensions with existing knowledge
    - Recommended page structure

Step 2 (생성 패스):
  입력: Step 1 분석 결과 + 기존 wiki 상태
  출력:
    - source summary 페이지 (YAML frontmatter: type/title/sources[])
    - entity 페이지 (신규 또는 기존 업데이트)
    - concept 페이지 (신규 또는 기존 업데이트)
    - [[wikilink]] 삽입
    - index.md + log.md + overview.md 갱신
```

**개념 페이지 생성 기준**:
- Step 1에서 entity/concept으로 분류된 것이 대상
- 기존 페이지와 `oms_semantic_query` 유사도 선검출로 merge/create 판정 (우리 개선안 — nashsu 원본은 LLM 판단)
- 소스 삭제 시: 해당 소스가 sources[]에 단독이면 페이지 삭제, 복수이면 sources[]에서만 제거

**증분 처리**:
- SHA256 소스 캐시 — 파일 해시 변경 없으면 처리 스킵
- disk-persistent serial queue — 동시 LLM 호출 방지

**Wiki 동작 — 페이지 타입 분류**:

```
wiki/
├── entities/      # People, orgs, products, tools
├── concepts/      # Theories, methods, techniques, patterns
├── sources/       # Per-source summaries
├── queries/       # Saved question answers
├── synthesis/     # Cross-source analysis
└── comparisons/   # Side-by-side comparative analysis
```

- `overview.md`: 매 ingest 후 자동 재생성 (전체 wiki 상태 반영)
- lint 큐: `.llm-wiki/lint.json`, typed errors: `contradiction` / `duplicate` / `missing-page` / `suggestion` / `confirm`
- 병합은 human-gate (자동 병합 금지 원칙)

**Attribution**: nashsu, https://github.com/nashsu/llm_wiki (GPL-3.0 — idea/algorithm only)

---

### 2.4 nvk/llm-wiki — 관점별 fan-out + 3-phase 하드 분리

**URL**: https://github.com/nvk/llm-wiki  
**License**: Apache 2.0  
**선행 문서** `llm-wiki-ecosystem-design-references.md §D`에서 개요 커버됨.

**Compile 동작 — 3-phase 하드 분리**:

```
Phase 1: Research (병렬)
  Standard mode: 5 관점 에이전트 (Academic / Technical / Applied / News / Contrarian)
  Deep mode:     8 관점 에이전트 (+Historical / Adjacent Fields / Data&Stats)
  Thesis mode:   Supporting vs Opposing 역할 분리 (확증편향 방지)
       ↓
  [Credibility gate]
  기준: peer-review 여부 / recency / author 신뢰도 / bias / corroboration
  threshold 미달 소스 reject (ingest 전 필터)
       ↓
Phase 2: Compile (항상 순차)
  "Articles are synthesized, not copied — they explain, contextualize, cross-reference"
  Confidence scoring: high / medium / low (소스 품질 + 교차검증 기반)
       ↓
Phase 3: Query (read-only)
  "wiki content only, never training data"
```

**동시성 처리 — 구조적 회피**:
- `raw/` 불변 → 읽기 충돌 없음
- compile 항상 순차 → 쓰기 충돌 없음
- 토픽/네임스페이스 격리 → 다른 토픽은 충돌 없음
- `.research-session.json` 크래시 복구

**Wiki 폴더 구조**:
```
~/wiki/                    # Hub (registry only, wikis.json)
└── topics/
    └── <topic>/
        ├── raw/           # Immutable sources
        ├── wiki/          # Compiled articles
        ├── output/        # Generated artifacts
        ├── inventory/     # Durable tracking
        ├── datasets/      # External data manifests
        └── inbox/         # Drop zone
```

**cwd-독립 접근**: `~/.config/llm-wiki/config.json` 전역 설정. 어느 디렉토리에서도 `--new-topic` 가능.

**AGENTS.md**: 45KB 단일 파일. 어느 cwd, 어느 LLM 에이전트에게든 컨텍스트로 주면 동작.

**Attribution**: nvk, https://github.com/nvk/llm-wiki (Apache 2.0)

---

### 2.5 lucasastorian/llmwiki — 전역 1서버 + write→backlink 반환

**URL**: https://github.com/lucasastorian/llmwiki  
**License**: Apache 2.0  
**선행 문서** `llm-wiki-ecosystem-design-references.md §D`에서 개요 커버됨.

**Compile 동작**:
- LLM이 MCP tools(create/edit/append/delete)로 직접 파일 쓰기
- 파일시스템이 source of truth, SQLite(index.db)는 파생/재구축 가능 캐시
- 동시쓰기 락 없음 (명시 경고) — "concurrent edits can lose updates"

**Wiki 동작 — write→backlink 반환 패턴**:
```
디스크 write
    → SQLite 인덱스 갱신
    → 인용 그래프 갱신
    → staleness 전파 (인용된 페이지를 stale로 표시)
    → 영향받는 backlink 목록을 write 응답에 반환
```
이 패턴으로 에이전트가 write 직후 cascade pass를 스스로 이어갈 수 있다.

**전역 MCP 모델**:
- 모든 tool의 첫 인자: `knowledge_base` 파라미터
- 하나의 서버 프로세스가 여러 knowledge base를 파라미터로 구분
- 우리 OMS 전역 MCP (`OMS_VAULT` env 주입)와 설계 정합

**edit 무결성**: `edit` tool은 str_replace + 정확히 1-match 강제 → 잘못된 위치 수정 방지.

**Attribution**: lucasastorian, https://github.com/lucasastorian/llmwiki (Apache 2.0)

---

### 2.6 atomicstrata/llm-wiki-compiler — 2-phase 분리 + 클레임 수준 인용

**URL**: https://github.com/atomicstrata/llm-wiki-compiler  
**License**: 미확인 — 개념/알고리즘 설명만 사용

**Compile 동작 — 2-phase 분리의 구체 이점**:

nashsu 2-step CoT와 별개로, 이 구현체는 Phase를 더 명확히 분리한다:

```
Phase 1: 전체 소스 집합에서 개념 추출 (쓰기 없음)
  - 모든 소스를 먼저 스캔
  - 개념 후보 목록 수집
  - 여러 소스에 걸친 개념 병합 결정

Phase 2: 페이지 생성 (Phase 1 완료 후)
  - Phase 1 결과 기반으로 페이지 생성
  - 순서 독립성 확보 (어느 소스를 먼저 처리하든 동일 결과)
  - 추출 실패를 쓰기 전에 감지 가능
```

**핵심 이점**: "Splitting the phases eliminates order-dependence, catches extraction failures before anything is written, merges concepts shared across multiple sources into a single page."

**Wiki 동작 — 페이지 타입 + 클레임 수준 인용**:

| 페이지 타입 | 설명 |
|------------|------|
| **Concept** | 독립적 아이디어/패턴 |
| **Entity** | 명명된 사람/제품/조직/결과물 |
| **Comparison** | 개념/엔티티 간 비교 분석 |
| **Overview** | 여러 개념을 연결하는 도메인 맵 |

**인용 2수준**:
- 문단 수준: `^[source.md]`
- 클레임 수준: `^[source.md:42-58]` (소스 파일 라인 범위)
- lint가 두 형식 모두 검증 (누락 소스파일, 잘못된 클레임 인용, 불가능한 라인 범위)

**증분 처리**:
- 소스 파일 hash 기반 변경 감지
- content-hash aware 임베딩 (변경된 내용만 재계산)
- 캐시된 인용 판단 재사용 (불필요한 LLM 스코어링 방지)
- "Recompiling unchanged corpora completes in seconds."

**페이지 심사 게이트**:
- `.llmwiki/candidates/` — human 리뷰 대기 후보
- `.llmwiki/schema.json` — 페이지 타입별 정책 (최소 wikilink 수 등)

**Attribution**: atomicstrata, https://github.com/atomicstrata/llm-wiki-compiler

---

### 2.7 shannhk/llm-wikid — 7-phase 파이프라인 + 편향 검사

**URL**: https://github.com/shannhk/llm-wikid  
**License**: 미확인 — 개념/알고리즘 설명만 사용

**Compile 동작 — 7-phase 파이프라인**:

```
Phase 1: Sort       — 소스를 유형별 폴더로 분류 (URL 타입 기반)
Phase 2: Resolve    — 전체 콘텐츠 수집 (YouTube 트랜스크립트, X API, 웹 스크래핑, PDF)
Phase 3: Extract Media — 이미지 다운로드 + 비전 분석
Phase 4: Classify & Compile — 소스 유형별 차등 추출
          (transcript / paper / report / article / tweet / notes)
Phase 5: Create Pages — wikilink 포함 wiki 페이지 생성
Phase 6: Bias Check — counter-argument + data gaps 섹션 추가
Phase 7: Re-index   — 검색 인덱스 갱신
```

**Phase 4 소스 유형별 차등 추출이 핵심**: 논문이면 abstract/contribution/limitation을, 트위트면 claim/context를 다르게 추출.

**Wiki 동작**:

```
raw/
├── clippings/    # Web Clipper 착지, ingest 시 자동 분류
├── ideas/
├── bookmarks/
├── articles/
├── papers/
├── assets/images/
└── x-archive/

wiki/
├── index.md      # Master catalog
├── concepts/
├── entities/
├── sources/
├── syntheses/
├── outputs/
├── sops/         # Standard Operating Procedures
├── log.md
└── dashboard.md  # Visual overview
```

**개념 페이지 생성 기준**:
- 여러 소스에 걸쳐 등장하는 개념
- 언급된 개념 중 기존 documentation이 없으면 stub 페이지 자동 생성
- 모든 claim에 신뢰도 표시: `high` / `medium` / `low` / `uncertain`

**Wiki 건전성**:
- git 기반 버전관리 ("Every change is reversible via git revert")
- `/wiki-lint` 명령으로 모순/stale 콘텐츠 식별
- frontmatter provenance 추적 + append-only changelog

**Attribution**: shannhk, https://github.com/shannhk/llm-wikid

---

### 2.8 AgriciDaniel/claude-obsidian — hot-cache + Obsidian-native 컴파일

**URL**: https://github.com/AgriciDaniel/claude-obsidian  
**License**: 미확인 — 개념/알고리즘 설명만 사용

> 참고: wikidocs.net/blog/@jaehong/12241 (박재홍 작성 추정)은 이 프로젝트 또는 유사한 Obsidian-Claude 통합의 한국어 리뷰로 보이나, 해당 URL이 접근 불가(403)하여 GitHub 원본 소스로 대체한다.

**Compile 동작**:

```
/wiki-ingest 실행
    │
    ▼
1. 엔티티(사람/조직) 추출
2. 개념(아이디어/원칙) 추출
3. 각 엔티티/개념별 별도 wiki 페이지 생성
4. 기존 페이지에 새 소스 교차참조 추가
5. index.md 카탈로그 갱신
6. log.md 활동 기록 추가
7. hot.md 갱신 (세션 컨텍스트 버퍼)
```

**Wiki 동작 — 페이지 업데이트 규칙**:
- 기존 페이지에 새 소스 도달 시: 인용/컨텍스트 추가, 양방향 링크 생성, 모순은 `[!contradiction]` callout으로 표시
- "compounding effect — each ingest strengthens the knowledge graph rather than replacing it"

**Hot-cache 메커니즘 (세션 지속성)**:
- `wiki/meta/hot.md` — 최근 세션 컨텍스트 ~500 단어 (~500 토큰)
- 새 세션 시작 시 hot.md를 먼저 읽어 워킹 메모리 복원
- 컨텍스트 창의 < 0.25% 비용으로 re-establishment 비용 4–6배 절감
- 매 세션 종료 후 갱신

**폴더 구조**:
```
.raw/                     # 불변 소스 (LLM 수정 불가)
wiki/
├── sources/              # 소스 요약
├── concepts/             # 추출된 개념
├── entities/             # 추출된 엔티티
├── sessions/             # 세션 저장
└── meta/
    ├── hot.md            # 세션 컨텍스트 버퍼
    ├── index.md          # 전체 카탈로그
    └── dashboard.md      # 시각 개요
```

**Attribution**: AgriciDaniel (Daniel Agrici), https://github.com/AgriciDaniel/claude-obsidian

---

### 2.9 NicholasSpisak/second-brain — raw→wiki 직접 2-tier

**URL**: https://github.com/NicholasSpisak/second-brain  
**License**: 미확인 — 개념/알고리즘 설명만 사용

**구조적 특이점**: `processed/` 중간 tier 없이 `raw/` → `wiki/` 직접 2-tier.

```
raw/
└── assets/            # 이미지/첨부

wiki/
├── sources/           # 소스당 1개 요약
├── entities/          # 사람/조직/제품/도구
├── concepts/          # 아이디어/프레임워크/이론
├── synthesis/         # 비교·분석·테마
├── index.md
└── log.md

output/                # 보고서/결과물
```

**Compile 동작**:
- `/second-brain-ingest` 스킬 실행
- raw/ 소스 읽기 → structured wiki로 컴파일 (cross-references 포함)
- wiki/index.md 유지, 핵심 takeaways 논의

**관찰**: processed/ tier 부재는 compile 중간 산출이 ephemeral(메모리/캐시)로만 존재함을 의미. 우리 설계는 `processed/`를 물리 폴더로 물질화 (R12/R14 잠금)하여 파이프라인 가시화 — 이것이 NicholasSpisak 대비 명확한 차이점.

**Attribution**: NicholasSpisak, https://github.com/NicholasSpisak/second-brain

---

### 2.10 한국 커뮤니티 사례 — @aboutcorelab + 박제창 + fastcampus

**출처 1**: @aboutcorelab (threads.com, 2026) — Karpathy LLM Wiki + Obsidian + Claude Code 실측 경험  
**URL**: https://www.threads.com/@aboutcorelab  
**실측 결과**: 153개 파일 투입 → 146개 소스 자동 요약, 48개 엔티티 자동 추출(기업/인물/기술 등), 29개 개념 페이지 생성 + 문서 간 연결 구축

**관찰**:
- Compile 비율: 소스 153개 → 개념 페이지 29개 (약 19%). 소스 1건이 반드시 개념 1개를 만들지 않음 — 여러 소스가 공유 개념으로 수렴.
- "153개 잠자던 리포트가 진짜 세컨드 브레인으로 변환" — compounding 효과 실증.

---

**출처 2**: 박제창(Dreamwalker), Medium, 2026-04-05  
**URL**: https://medium.com/@aristojeff/llm-wiki는-무엇이고-왜-지금-주목받는가-5c274bdf70ce

**핵심 관찰**:
- Compile = "질문 때마다 지식을 다시 조립하지 말고, 지식을 미리 정리하고 계속 업데이트하자" — pre-compiled codebase 은유
- Wiki = "핵심 주장마다 출처를 남긴다" — claim-level provenance 강조
- **"환각 자동화"(hallucination automation) 경고**: human review gate 없으면 hallucinated content가 wiki에 축적됨. 자동화는 필요하지만 맹목 자동화는 위험.
- Dedup: 정보 중복 대신 backlink로 참조 — 페이지 분산 방지

---

**출처 3**: 패스트캠퍼스, "Claude와 옵시디언으로 만드는 나만의 세컨브레인 LLM Wiki for Business"  
**URL**: https://fastcampus.co.kr/biz_camp_llmwiki  
**형태**: 3주 오프라인 실습 워크숍

**커리큘럼에서 드러나는 Compile/Wiki 교육 순서**:
1. 이론: LLM Wiki 개념 + 지식관리 방법론
2. 실습: Obsidian + Claude Code로 PKM 구조 설계 → LLM Wiki 구현
3. 과제: 개인 지식 구조 설계 → Compile 파이프라인 실행

**관찰**: 교육 현장에서도 Compile(구조 설계 + 파이프라인)과 Wiki(Obsidian vault에 결과 browse)를 별도 단계로 가르친다. "기록 구조 설계부터 AI 검색·요약·재활용이 가능한 운영 시스템까지"라는 커리큘럼 설명이 Ingest→Compile→Wiki 흐름과 정확히 대응.

---

## 3. braintrinity 조사 결과

**조사 범위**: GitHub (직접 검색), 웹 전반, YouTube, Medium, Substack, 한국어 검색어 포함 5회 이상 검색.

**결론**: **"braintrinity"라는 이름의 프로젝트는 발견되지 않음**.

유사 이름(braintribehq, BRAINtrinsic, braintrust, braintrance, CalSol/braintrain)이 존재하나 모두 무관한 프로젝트다.

**가능한 해석**:
1. 사용자가 참조한 이름이 다른 프로젝트의 별칭이거나 내부 명칭일 수 있음
2. 검색 인덱스에 아직 등록되지 않은 매우 새롭거나 비공개 프로젝트일 수 있음
3. 철자/명칭이 다를 수 있음 (예: "brain-trinity", "braintrinit" 등)

raw/→processed/→wiki/ 3-tier 물리 폴더 아이디어 자체는 여러 구현체(특히 shannhk/llm-wikid, MindStudio 가이드 계열)에서 공통으로 등장하며, 이는 "braintrinity가 이 모델에 동의한다"는 사용자의 기억이 다른 프로젝트를 가리킬 가능성을 시사한다. 특히 MindStudio AI Second Brain 가이드(https://www.mindstudio.ai/blog/ai-second-brain-obsidian-vault-folder-architecture)가 `/raw`, `/raw/processed`, `/wiki` 3-tier를 명시적으로 사용하는 공개 자료다.

---

## 4. 운영 권고 — 우리 Compile + Wiki 스킬 설계

아래는 §2 레퍼런스와 spec.md §10.x, deep-interview R12/R14를 교차하여 도출한 C5 스킬 설계 권고다. 각 항목은 잠금 결정이 아니라 **설계 입력**이다.

### 4.1 Compile 스킬 권고

**트리거**: R2 잠금(manual/stateless)에 따라 수동 `compile` 커맨드. daemon 금지.

**입력 정의**:
```
raw/         → external-raw provenance (80. References 계열)
00. Inbox/   → authored/curated provenance (개인 캡처 스트림, 다른 intent 온도)
oms graph    → 기존 wiki 페이지 컨텍스트, 유사 개념 선검출
```

**추천 알고리즘 — nashsu 2-step CoT + atomicstrata 2-phase 결합**:

```
Phase 0: SHA256 변경 감지
  소스 파일 hash 비교 → 변경된 소스만 처리 대상 지정 (R12 SHA 증분 재컴파일)

Phase 1: 개념 추출 (쓰기 없음 — atomicstrata 원칙)
  nashsu Step 1과 동일: entities / concepts / arguments / contradictions 추출
  + oms_semantic_query 유사도 선검출: 기존 wiki 페이지와 유사도 계산
    → merge 후보 (유사도 > threshold) vs create 후보 구분
  + provenance 등급 태깅: authored > curated > external-raw (R15 잠금)

Phase 2: 페이지 생성/갱신 (Phase 1 완료 후 — 순서 독립성)
  nashsu Step 2: source summary + entity/concept 페이지
  merge 후보 → 기존 페이지에 내용 병합 (환각 방지: LLM 판단 아닌 유사도 기반)
  create 후보 → 새 페이지 생성, [[wikilink]] 삽입
  authored/curated 소스 → compile 시 가중치 상승 (개성 보존, R15)

Post-compile:
  cascade pass: 관련 페이지 ripple 갱신 (Astro-Han 원칙, archive 제외)
  index.md + log.md 갱신
  processed/ 폴더 중간 산출 물질화 (R12/R14: ephemeral 아님)
```

**개념 페이지 생성 기준 (어느 개념이 페이지를 받는가)**:
- 레퍼런스들의 공통 패턴: 여러 소스에 걸쳐 등장 OR 명시적 entity/concept 분류
- 권고: (1) 2개 이상 소스 교차 등장, (2) oms_semantic_query 기존 페이지 유사도 < threshold (중복 아님), (3) authored 소스 단독 언급이어도 생성 가능
- stub 페이지: 언급되었으나 미문서화 개념 → stub 생성 후 후속 compile에서 충전

**모순 처리**: `> **Conflict:** A claims X; B claims Y. Unresolved.` 인라인 annotation (spec §10.x 신규 정의, 기존 구현체 갭 해소)

**동시성**: compile 항상 순차 (nvk 원칙). R2 stateless이므로 락 불필요 — 수동 실행이 자연적 직렬화.

**처리 폴더 물질화 (R12/R14)**:
```
raw/          → (ingest) →  processed/entities/   # 엔티티 추출 중간 산출
                         →  processed/summaries/  # 소스별 요약
                         →  wiki/concepts/        # 최종 개념 페이지
                         →  wiki/entities/        # 최종 엔티티 페이지
```

### 4.2 Wiki 스킬 권고

**페이지 생명주기**:

| 이벤트 | 동작 |
|--------|------|
| 신규 개념 (유사 없음) | 새 파일 생성, frontmatter `created_by` 필수 |
| 기존 개념 (유사 발견) | 기존 파일 갱신, `sources[]` 추가, 내용 병합 |
| 소스 제거 | `sources[]`에서 제거; 단독 소스면 페이지 삭제 |
| 개념 분할 | >8 sub-concept 교차참조 시 분할 후보 → human 게이트 (spec §10.x) |
| 개념 병합 | 유사도 > threshold AND human 승인 후 |

**Wikilink 관리**:
- lucasastorian 패턴: `edit` = str_replace + 1-match 강제 (잘못된 위치 수정 방지)
- write 후 backlink 목록 반환 → cascade pass 자동 이어가기
- OMS 개념 ID 기반 wikilink (파일경로 아님) → rename에 견고 (spec §10.x)

**MOC (Map-of-Content) / index.md**:
- Karpathy/Astro-Han/nashsu 공통: 매 compile 후 갱신
- index.md = 페이지별 1줄 요약 + 카탈로그 (항상 먼저 읽는다)
- overview.md = 현재 wiki 전체 상태 요약 (nashsu: 매 ingest 후 재생성)

**Dedup 전략**:
- primary: oms_semantic_query 유사도 선검출 (compile Phase 1)
- secondary: lint 큐 `duplicate` type → human 리뷰
- 자동 병합 금지 (nashsu 원칙)

**사람 가독성 유지**:
- 페이지 상단: provenance blockquote (Astro-Han) → 우리는 OMS custom metadata로 대체 (쿼리 가능, 본문 비오염)
- 모순 callout: `[!contradiction]` (claude-obsidian) 또는 `> **Conflict:**` (우리 신규 정의)
- 신뢰도 표시: claim별 `high/medium/low/uncertain` (shannhk/llm-wikid 패턴)

**Provenance 등급 흐름** (R15 잠금):
```
authored    → compile 시 가중치 상승 → wiki 페이지에 authored 마킹
curated     → 중간 처리
external-raw → 기본
```
폴더→등급 매핑은 setup-time 인터뷰 결정 (Non-Sticky 원칙).

**vault 쓰기 게이트**:
- `oms_capture_prepare` / `oms_capture_commit` 로 vault-path 봉쇄 + contract 검증
- created_by frontmatter 필수 (routing law)
- agent-writable zone 내에만 쓰기 허용

### 4.3 구현체 비교 — 우리 제약 대비

| 구현체 | 물리 폴더 tier | SHA 증분 | local embed | manual/stateless | human gate |
|--------|--------------|---------|-------------|-----------------|-----------|
| Karpathy gist | raw/+wiki/ (2-tier) | 없음 | 없음 | 사실상 수동 | 없음 |
| Astro-Han | raw/+wiki/ (2-tier) | 없음 | 없음 | 수동 | lint report-only |
| nashsu | entities/concepts/sources/... | SHA256 ✓ | 없음 | serial queue | human-gate merge ✓ |
| nvk | raw/+wiki/+output/+inbox (4-tier) | 없음 | 없음 | 수동 | credibility gate ✓ |
| lucasastorian | sources+wiki/ | SQLite hash | 없음 | stdio MCP (수동) | 없음 |
| atomicstrata | wiki/+.llmwiki/candidates/ | hash ✓ | embed cache ✓ | 수동 | candidates queue ✓ |
| shannhk/llm-wikid | raw/+wiki/ (7 sub-phase) | 없음 | 없음 | 수동 | git revert |
| claude-obsidian | .raw/+wiki/ | 없음 | 없음 | 수동 | 없음 |
| **우리 설계** | **raw/+processed/+wiki/ (3-tier)** | **SHA256 ✓** | **EmbeddingGemma ✓** | **manual-only ✓** | **human gate ✓** |

우리 설계는 모든 제약을 만족하면서 각 구현체의 최선 패턴(nashsu SHA256 + atomicstrata 2-phase + lucasastorian backlink-return + nvk credibility gate + our OMS semantic pre-check)을 결합한다.

---

## 4.4 Absorbable Skill Design Synthesis — Wiki = Staleness Ledger / Compile = SHA Worker

> 이 섹션이 C5 스킬 설계의 핵심 입력이다. bstack `terminology` 스킬이 단일 compile unit의 수동 프로토타입이라면, 우리는 **Wiki**(상태 소유자)와 **Compile**(무상태 작업자)을 명확히 분리한다.

### Wiki의 역할 — Staleness Ledger + Namespace Owner

Wiki는 단순한 출력 폴더가 아니다. Wiki는 **두 가지 책임**을 진다:

#### A. Namespace/Identity 관리

```
페이지 식별자 = OMS 개념 ID (파일경로 아님 → rename에 견고)
              = OMS custom metadata에 저장

Dedup 판단:
  oms_semantic_query 유사도 > threshold → merge 후보 → human gate
  유사도 ≤ threshold → create

Merge: human 승인 후 실행 (nashsu 원칙: 자동 merge 금지)

Split 트리거: sub-concept 교차참조 > 8개 (spec §10.x)
  → human gate 큐에 분할 후보 등록

Orphan 탐지 (lint):
  backlink 0개 + sources[] 비어있음 → orphan 후보
  → report-only 큐 (자동 삭제 금지)
```

#### B. Staleness Ledger — Compile 재실행 드라이버

구현체 조사 결과, staleness를 **명시적 상태로 관리**하는 것은 lucasastorian만 존재 (write→stale backlink 반환). 나머지는 lint-time 또는 전수 재처리. 우리는 이를 확장한다:

```
Staleness Ledger (wiki 레이어가 소유):

페이지 상태 = CLEAN | DIRTY | STUB | ORPHAN | CONFLICT

CLEAN  → sources[] 모두 SHA 최신, backlink 유효
DIRTY  → sources[] 중 1개 이상 SHA 변경 감지됨
         → compile 재실행 큐에 등록
STUB   → 언급됨, 아직 내용 없음 (nashsu + shannhk 패턴)
         → sources가 도달하면 DIRTY→compile로 전환
ORPHAN → backlink 0개 + sources[] 없음
         → lint report-only 큐
CONFLICT → 모순 annotation 존재, unresolved
         → lint report-only 큐, human 해소 대기

상태 전이:
  소스 파일 SHA 변경 → 해당 sources[]를 참조하는 모든 페이지 → DIRTY
  compile 완료      → DIRTY → CLEAN
  소스 파일 삭제    → sources[]에서 제거; 단독이면 페이지 → ORPHAN
  write 후 backlink 반환 (lucasastorian 패턴) → 인용 페이지 → DIRTY
```

**Staleness Ledger 저장 위치**: `wiki/.llmwiki/staleness.json` 또는 각 페이지 frontmatter `status:` 필드. 검토 필요(open question §5).

#### C. Navigation Surfaces (MOC / index)

```
index.md  — 매 compile 후 갱신. 페이지별 1줄 요약. 항상 먼저 읽는다 (Karpathy).
log.md    — append-only. ## [YYYY-MM-DD] compile | ConceptName (grep 가능).
overview.md — 전체 wiki 상태 요약. nashsu: 매 ingest 후 재생성.
```

MOC 생성: index.md가 1차 MOC. 필요 시 토픽별 sub-index (nvk `_index.md` 패턴).

#### D. Processed→Wiki Promotion Gate

```
processed/ 폴더 = compile의 중간 산출 (R12/R14 잠금: ephemeral 아님, 물리 물질화)

processed/entities/   → entity 추출 결과 (JSON or MD)
processed/summaries/  → 소스별 요약

Promotion 조건 (processed → wiki):
  1. SHA Phase 0 통과 (변경된 소스만)
  2. credibility gate 통과 (nvk 패턴: peer-review/recency/author/bias)
  3. OMS semantic pre-check 완료 (merge vs create 판정)
  4. human gate (stub/conflict/merge 후보는 자동 승격 금지)

Promotion 실패 시: processed/에 잔류, lint 큐 등록
```

---

### Compile의 역할 — SHA Dirty-Tracking 무상태 Worker

Compile은 Wiki가 제공하는 DIRTY 큐를 소비하는 **무상태 작업자**다 (R2 manual/stateless 잠금).

#### SHA Dirty-Tracking 메커니즘

```
상태: 디스크 파일만 (R2 stateless — 메모리/daemon 상태 없음)

[compile 실행]
    │
    ▼
1. SHA Scan: raw/ + 00.Inbox/ 소스 파일 해시 계산
             .llmwiki/sha-cache.json과 비교
             → changed_files = 변경/신규 소스 목록

2. DIRTY 페이지 확정:
   changed_files의 sources[]를 참조하는 wiki 페이지 목록
   = compile 재실행 대상 (DIRTY)
   + 해당 페이지의 backlink 추이 → 추가 DIRTY 전파 (1-hop)

3. 컴파일 순서 결정:
   의존성 없는 것 먼저 (sources[] 기준 위상 정렬)
   nashsu serial queue: 동시 LLM 호출 방지

4. Per-concept recompile:
   atomicstrata Phase1: 전체 DIRTY 소스 개념 추출 (쓰기 없음)
   nashsu Step2: 페이지 생성/갱신

5. SHA 캐시 갱신:
   processed 완료된 소스 → sha-cache.json 업데이트
   wiki 페이지 → DIRTY → CLEAN 전환
```

#### 신뢰도(Credibility) Gate

```
nvk 패턴: peer-review / recency / author / bias / corroboration 점수
threshold 미달 소스 → compiled 제외, lint 큐 등록 (자동 reject 아님 — human 확인)

우리 매핑:
  authored   → credibility 최고 (직접 작성)
  curated    → credibility 중간
  external-raw → credibility gate 통과 필요
  
provenance 등급(R15)이 credibility 초기값 역할 → gate threshold는 setup-time 결정
```

#### Multi-Writer 동시성 처리

```
R2(manual/stateless) + 수동 실행 → 자연적 직렬화 (동시 compile 실행 자체가 없음)

그러나 future-proof 설계를 위한 구조적 회피:
  raw/ 불변 (nvk 원칙) → 읽기 충돌 없음
  compile 항상 순차 (nashsu serial queue) → 쓰기 충돌 없음
  edit = str_replace + 1-match 강제 (lucasastorian 원칙) → 잘못된 위치 수정 방지
  write 후 backlink 반환 → cascade를 단일 에이전트 시퀀스로 유지
```

---

### 요약 — 분리된 역할 테이블

| 책임 | Wiki 스킬 소유 | Compile 스킬 소유 |
|------|--------------|-----------------|
| 페이지 식별자/namespace | ✓ OMS 개념 ID | — |
| Dedup/merge/split 판단 | ✓ (human gate 포함) | — |
| Staleness Ledger 유지 | ✓ CLEAN/DIRTY/STUB/ORPHAN/CONFLICT | — |
| SHA 변경 감지 | — | ✓ sha-cache.json |
| Credibility gate | — | ✓ (provenance 등급 입력) |
| LLM 합성 (개념→페이지 내용) | — | ✓ 2-step CoT |
| processed→wiki promotion | 게이트 소유 | 실행 담당 |
| Cascade pass | ✓ backlink 추적 | ✓ ripple 실행 |
| index/log/overview 갱신 | ✓ | 트리거 제공 |
| Orphan/conflict 탐지 | ✓ lint | — |

**핵심 인터페이스**: Compile이 Wiki에게 "이 페이지가 변경됨 + 영향받는 backlink 목록" 을 반환 → Wiki가 Staleness Ledger를 갱신. `terminology` 스킬의 수동 compile 단위가 이 인터페이스의 단일 인스턴스다.

---

## 5. 오픈 질문 — 다음 인터뷰 라운드 대상

1. **processed/ 구체 스키마**: `processed/entities/`, `processed/summaries/` 이외에 어떤 중간 산출이 필요한가? compile 실패 시 processed/의 partial 상태는 어떻게 처리하는가?

2. **개념 페이지 생성 threshold**: "2개 이상 소스 교차 등장"을 기준으로 삼을 것인가, 아니면 oms_semantic_query 유사도 threshold만으로 판단할 것인가? threshold 값은?

3. **stub 페이지 정책**: 미문서화 개념의 stub 자동 생성을 허용할 것인가? stub이 wiki를 오염시키는 risk vs. 빠른 구조화 이득.

4. **cascade pass 범위**: ripple 갱신 대상을 어떻게 결정하는가? 직접 wikilink 1-hop만? OMS graph 2-hop?

5. **Compile 트리거 조건 (open item, R12 이후)**: 소스 추가 시마다 실행? 배치로 묶어서? 사용자가 explicit하게 실행? R2(manual/stateless)와 정합하지만 편의와 tradeoff.

6. **wiki/ 폴더 위치**: Ataraxia vault 내 어떤 경로에 wiki/를 둘 것인가? 기존 번호폴더 체계(00–95)와의 관계. setup-time 인터뷰에서 결정해야 할 바인딩.

7. **authored 소스의 compile 처리**: 00. Inbox의 authored 소스는 외부 raw와 완전히 별도 파이프라인인가, 아니면 provenance 태그만 다르고 같은 파이프라인인가?

8. **hot.md 패턴 채택 여부**: claude-obsidian의 session continuity hot.md를 우리 Wiki 스킬에 포함할 것인가? OMS 자체 session 메커니즘과 중복 가능성 검토 필요.

---

## 6. 출처 / Attribution 목록

> 이 목록은 `ACKNOWLEDGMENTS.md`에 추가할 레퍼런스+감사 항목이다.

| 항목 | URL | License | 흡수 유형 |
|------|-----|---------|----------|
| Andrej Karpathy, LLM Wiki gist | https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f | 미명시 | 아이디어/패턴 |
| Astro-Han, karpathy-llm-wiki SKILL.md | https://github.com/Astro-Han/karpathy-llm-wiki | MIT | 아이디어/알고리즘 |
| nashsu, llm_wiki | https://github.com/nashsu/llm_wiki | GPL-3.0 | 아이디어/알고리즘만 (코드 금지) |
| nvk, llm-wiki | https://github.com/nvk/llm-wiki | Apache 2.0 | 아이디어/알고리즘 |
| lucasastorian, llmwiki | https://github.com/lucasastorian/llmwiki | Apache 2.0 | 아이디어/알고리즘 |
| atomicstrata, llm-wiki-compiler | https://github.com/atomicstrata/llm-wiki-compiler | 미확인 | 개념만 |
| shannhk, llm-wikid | https://github.com/shannhk/llm-wikid | 미확인 | 개념만 |
| AgriciDaniel (Daniel Agrici), claude-obsidian | https://github.com/AgriciDaniel/claude-obsidian | 미확인 | 개념만 |
| NicholasSpisak, second-brain | https://github.com/NicholasSpisak/second-brain | 미확인 | 개념만 |
| 박제창(Dreamwalker), LLM Wiki는 무엇이고 왜 주목받는가 | https://medium.com/@aristojeff/llm-wiki는-무엇이고-왜-지금-주목받는가-5c274bdf70ce | 미확인 | 관찰/통찰 참조 |
| @aboutcorelab, Threads 실측 경험 | https://www.threads.com/@aboutcorelab | 미확인 | 실측 데이터 참조 |
| 패스트캠퍼스, LLM Wiki for Business 워크숍 | https://fastcampus.co.kr/biz_camp_llmwiki | 교육 콘텐츠 | 교육 커리큘럼 참조 |
| MindStudio, AI Second Brain 7-folder architecture | https://www.mindstudio.ai/blog/ai-second-brain-obsidian-vault-folder-architecture | 미확인 | 개념만 |

---

## Changelog

| 날짜 | 내용 |
|------|------|
| 2026-06-13 | 초안 생성 (research-agent). llm-wiki-ecosystem-design-references.md 자매 문서로, Compile/Wiki 운영 동작에 특화. 구현체 10종 + 한국 사례 3건 + braintrinity 조사 포함. |
