---
title: "LLM-Wiki 생태계 구현체 설계 레퍼런스 — 우리 L4 wiki + 온톨로지에 흡수할 패턴"
slug: llm-wiki-ecosystem-design-references
status: draft
created: 2026-06-13
created_by: claude-code
type: research
relates_to:
  - docs/exec-plan/active/self-owned-second-brain/spec.md
---

# LLM-Wiki 생태계 구현체 설계 레퍼런스 — 우리 L4 wiki + 온톨로지에 흡수할 패턴

> 목적: L4 wiki SKILL.md 설계 및 §10 온톨로지 구축 제안의 근거가 되는 외부 구현체 4종을 정리한다.
> 각 섹션 말미의 "흡수(Absorb)" 항목이 우리 스택에 직접 이식할 패턴이다.

---

## A. Karpathy 원본 gist — canonical pattern

**URL**: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
**게시일**: 2026-04-04

### 핵심 주장

RAG 대체가 아니라 **compile-once / compounding artifact** 모델이다. "LLM reads it, extracts key info, integrates into existing wiki — updating entity pages, revising summaries, noting where new data contradicts old claims." 소스 1건이 보통 10–15개 wiki 페이지에 영향을 준다. 사람은 bookkeeping에서 지치지만 LLM은 한 패스에 15파일 갱신이 가능하다.

### 3개 명시 operation

| Operation | 설명 |
|-----------|------|
| `ingest` | 소스 → wiki 페이지 컴파일/갱신 |
| `query` | wiki 내용 기반 질의 |
| `lint` | wiki 일관성 검증 |

3 signature behaviors = backlinks/cross-ref, contradiction flags, synthesis (각 operation의 산물).

### 핵심 파일

- `index.md` — 매 ingest마다 갱신되는 카탈로그. **항상 먼저 읽는다.**
- `log.md` — append-only. 포맷: `## [YYYY-MM-DD] ingest | Title`

### Scale 경계

Karpathy가 명시한 범위: **~50k–100k 토큰(약 150–200페이지) 이하**에서 RAG 대비 "wins decisively" — 100% retrieval 신뢰성.

> 우리 대비: OMS 엔진이 백킹이므로 이 천장을 넘어선다. 유사도 선검출(`oms_semantic_query`) + 그래프 기반 컨텍스트가 단순 full-context load를 대체한다.

### 흡수(Absorb)

- `ingest / query / lint` 3-operation 구조를 L4 wiki SKILL.md의 최상위 진입점으로 채택
- `index.md` + `log.md` 두 파일을 L4 wiki의 필수 파일로 채택
- "compounding artifact" 원칙 — wiki가 RAG cache가 아닌 점진적 편집 대상임을 SKILL.md에 명시

---

## B. Astro-Han/karpathy-llm-wiki — 순수 SKILL.md 레퍼런스

**URL**: https://github.com/Astro-Han/karpathy-llm-wiki/blob/main/SKILL.md
**설치**: `npx add-skill Astro-Han/karpathy-llm-wiki`

> 우리 L4 wiki SKILL.md의 출발 템플릿. Karpathy gist를 Claude Code SKILL.md로 포팅한 구현.

### Frontmatter

- `name`: `karpathy-llm-wiki`
- `description` 트리거 구문: "add to wiki", "what do I know about", "LLM wiki", "Karpathy wiki"
- version 필드 없음

### 디렉토리 구조

```
raw/        ← 불변 원본. LLM이 절대 수정하지 않는다.
wiki/       ← LLM이 전부 소유. 토픽 서브디렉토리 1단계만 허용.
SKILL.md    ← 스키마층
wiki/index.md  ← 전역 TOC 표
wiki/log.md    ← append-only
```

### Init 규칙

없을 때만 생성. **절대 덮어쓰기 금지.**

### Ingest = fetch + compile (항상 두 단계, 예외 없음)

**Merge 결정 규칙** (원문 그대로):
- "same core thesis as existing article" → 기존 페이지에 병합
- "new concept" → 새 페이지
- "spans multiple topics" → 가장 관련 디렉토리에 두고 See Also 교차참조

**Conflict**: 새 소스가 기존과 모순되면 inline annotate.

**Cascade pass**: 주 페이지 작성 후 같은 토픽/관련 페이지의 ripple 갱신. archive 페이지는 cascade 제외.

**Post-ingest**: `index.md` 갱신 + `log.md` append.

### Query

`index.md` 먼저 읽기 → 해당 페이지 읽기 → "Prefer wiki content over training knowledge" → 프로젝트 루트 상대경로로 인용.

### Lint 2-tier

| 티어 | 대상 |
|------|------|
| **auto-fix** | 인덱스 일관성, 내부 링크 1-match 수정, See Also |
| **report-only** | 사실 모순, outdated, 누락 conflict annotation, orphan, 누락 교차참조 |

### 페이지 본문 메타

상단 blockquote 포맷. YAML frontmatter가 아님.

```markdown
> Source: https://...
> Raw: raw/filename.md
```

### 흡수(Absorb)

- `raw/` 불변 원칙 + `wiki/` LLM 소유 구조를 그대로 채택
- init-if-missing, never-overwrite 규칙 채택
- ingest = fetch+compile 2-step (항상 양쪽 실행) 채택
- cascade pass 채택 (archive 제외 규칙 포함)
- lint 2-tier 구분 채택
- "prefer wiki over training" 질의 원칙을 query operation에 명시
- 페이지 본문 blockquote 메타 → **우리는 OMS custom metadata로 대체** (쿼리 가능 provenance; §10.x 참조)
- 토픽 서브디렉토리 1단계 제한 → **우리는 OMS namespace로 대응**

---

## C. nashsu/llm_wiki — 가장 성숙한 구현 (graph/온톨로지 흡수 핵심)

**URL**: https://github.com/nashsu/llm_wiki
**동반 스킬**: https://github.com/nashsu/llm_wiki_skill
**기술 스택**: Tauri v2, Rust + React

> ⚠️ 스타 수 등 popularity 지표는 미확인 — 이 문서에서 주장하지 않는다.

### 4-signal knowledge graph

wikilink 그래프 위에 composite edge weight를 부여하는 방식.

| Signal | Weight | 설명 |
|--------|--------|------|
| Direct link | ×3.0 | `[[wikilink]]` 존재 |
| **Source overlap** | **×4.0** | frontmatter `sources[]` 교집합 — 가장 강한 신호, **deterministic** |
| Adamic-Adar | ×1.5 | 공통 이웃 노드 수 기반 |
| Type affinity | ×1.0 | 같은 page type |

> ⚠️ 정확한 결합식(합 / 최대 / 곱)은 미공개. "경험적 튜닝 필요" 항목으로 기록.

**시각화**: sigma.js + graphology. edge 굵기·색이 weight를 반영.

### Louvain clustering

- 라이브러리: `graphology-communities-louvain`
- 4-signal 그래프(링크 토폴로지, 임베딩 아님) 위에서 community 검출
- cohesion 지표: intra-edge density. **<0.15이면 상호참조 약함 경고**
- **시각/진단 전용** — 클러스터 → 자동 페이지 생성 안 함 (중요 갭)

### Ingest — 2-step CoT

**Step 1 (분석)**: 엔티티 / 개념 / 논점 / 모순 / 구조 추천
**Step 2 (생성)**: source summary + entity/concept 페이지 작성, `[[wikilink]]` 삽입, index/log/overview 자동 갱신

- SHA256 소스 캐시 — 무변경 소스 스킵
- 디스크 영속 serial queue — 동시 LLM 호출 방지
- 멀티모달 입력: PDF(pdf-extract/MinerU), DOCX(docx-rs), 이미지(vision 캡션), 웹클리퍼, Tavily/SerpApi deep research

### 페이지 lifecycle

- frontmatter 최소 필드: `type` / `title` / `sources[]`
- 소스 삭제 시: 공유 entity/concept 페이지는 `sources[]`에서 해당 소스만 제거 (페이지 삭제 안 함)
- 모순 표기: `.llm-wiki/lint.json` 리뷰 큐 (type: `contradiction` / `duplicate` / `missing-page` / `suggestion` / `confirm`)
- 병합은 human-driven

### Obsidian 호환 및 API

- `wiki/`가 유효한 Obsidian vault. `.obsidian/` 자동 생성.
- HTTP API: `http://127.0.0.1:19828` (health / projects / files / content / reviews / search(hybrid) / graph / sources-rescan)
- Bearer 인증. MCP 서버는 동일 API를 래핑.

### 흡수(Absorb)

- **4-signal graph weight 공식 채택**: wikilink ×3 + source overlap ×4 + Adamic-Adar ×1.5 + type affinity ×1.0 → OMS `graph_build` edge 속성에 저장 (결합식은 추후 경험적 튜닝)
- `sources[]` frontmatter를 1급 edge 소스로 채택 — deterministic signal로 가장 먼저 처리
- 2-step CoT ingest (분석→생성) 채택
- SHA256 캐시로 무변경 소스 스킵 채택
- lint 리뷰 큐 typed error 구조 (`contradiction` / `duplicate` / `missing-page`) 채택
- Louvain 클러스터링을 **진단 전용**으로만 채택 (자동 페이지 생성 금지 — nashsu와 동일 원칙)
- cohesion <0.15 경고 임계값 채택
- 병합은 human-gate, 자동 병합 금지 원칙 채택

---

## D. nvk/llm-wiki + lucasastorian/llmwiki — 멀티에이전트 오케스트레이션 + MCP

### nvk/llm-wiki

**URL**: https://github.com/nvk/llm-wiki
**라이선스**: Apache 2.0

> "raw = source code, you = compiler, wiki = executable."

#### 3 phase 하드 분리

```
Research  (병렬, 관점별 fan-out)
    ↓  [Credibility gate]
Compile   (항상 순차)
    ↓
Query     (read-only, "wiki content only, never training data")
```

#### Research fan-out — 작업 분할이 아닌 관점별

| 관점 유형 | 예시 역할 |
|-----------|---------|
| Academic | 학술 논문 기반 분석 |
| Technical | 구현 세부사항 |
| Applied | 실사용 패턴 |
| News | 최신 동향 |
| Contrarian | 반론 수집 |
| Historical | 시간적 맥락 |

**Thesis mode**: Supporting vs Opposing 역할 분리 → 확증편향 방지.

#### Credibility gate (Research → Ingest 사이)

기준: peer-review / recency / author / bias / corroboration 점수. threshold 미달 소스 reject.

#### 표준 agent 프롬프트 템플릿

```
Objective + Current wiki state + Constraints + Return format + Quality scoring
```

모든 agent는 `_index.md` 먼저 읽는다. `log.md` append-only.

#### 동시성 — 구조적 회피

- `raw/` 불변 (read-only)
- compile 항상 순차
- 토픽 격리 (서로 다른 네임스페이스는 충돌 없음)
- `.research-session.json` — 크래시 복구

#### AGENTS.md = 이식 가능 프로토콜

**45KB 단일 파일**. 어느 cwd, 어느 agent에게든 컨텍스트로 주면 동작. cwd-독립의 핵심.

### lucasastorian/llmwiki

**URL**: https://github.com/lucasastorian/llmwiki
**라이선스**: Apache 2.0

#### 아키텍처

```
문서 폴더 → FTS5 SQLite 인덱스 (.llmwiki/index.db) → MCP (stdio, FastMCP)
```

원본 파일 비이동.

#### MCP tool 목록

| Tool | 설명 |
|------|------|
| `guide` | **필수 첫 호출** — 사용법 안내 |
| `search` | FTS5 전문 검색 |
| `read` | 페이지 읽기 |
| `create` | 새 페이지 생성 |
| `edit` | str_replace, **정확히 1-match 강제** |
| `append` | footnote 자동 재번호 |
| `delete` | 페이지 삭제 |
| `ping` | health check |

모든 tool 첫 인자: `knowledge_base` → **하나의 전역 서버 + KB 파라미터 모델** (우리 전역 MCP 모델과 정합).

#### Write 시퀀스

```
디스크 write
    → SQLite 인덱스 갱신
    → 인용 그래프 갱신
    → staleness 전파 (인용 페이지를 stale로 표시)
    → backlink 목록을 write 응답에 반환
```

"backlink을 write 응답에 반환" = 맹목 write를 propagation 프롬프트로 전환하는 설계.

> ⚠️ 동시쓰기 락 없음 (명시 경고). 보호는 `edit`의 1-match 유니크 체크뿐.

### 흡수(Absorb)

- **관점별 fan-out** (작업분할 아님) + Credibility gate 채택 → ingest 전 소스 품질 검증 게이트로
- nvk AGENTS.md 이식 패턴 → 우리 SKILL.md가 cwd-독립적으로 동작하는 근거 (OMS_VAULT env 주입과 결합)
- "전역 1서버 + knowledge_base 파라미터" 모델 채택 → 우리 OMS 전역 MCP(`OMS_VAULT` env)와 정합
- write 응답에 backlink/staleness 반환 패턴 채택 → agent가 cascade pass를 스스로 이어갈 수 있음
- `edit` = str_replace + 1-match 강제 채택 → 잘못된 edit 위치 방지
- `append` footnote 재번호 채택 → 인용 일관성 유지
- 동시성은 구조적 회피(raw 불변, compile 순차, 토픽/네임스페이스 격리)를 1차 수단으로 채택. 락 메커니즘은 nashsu식 serial queue를 보완으로 고려.

---

## 요약 비교표

| 구현체 | 핵심 기여 | 우리 스택 매핑 |
|--------|---------|--------------|
| **Karpathy gist** | compile-once compounding, 3 operation, index+log 파일 | L4 SKILL.md 골격 |
| **Astro-Han SKILL.md** | raw/ 불변 + wiki/ LLM 소유, init-if-missing, cascade pass, lint 2-tier | L4 SKILL.md 구현 템플릿 |
| **nashsu/llm_wiki** | 4-signal graph, Louvain 진단, 2-step CoT ingest, typed lint queue | OMS graph_build edge weight, 온톨로지 진단 |
| **nvk/llm-wiki** | 관점별 fan-out, credibility gate, AGENTS.md 이식 | 멀티에이전트 research 오케스트레이션 |
| **lucasastorian/llmwiki** | 전역 1서버+KB 파라미터, write→backlink 반환, FTS5+MCP | 전역 MCP 모델, cascade 트리거 |

---

## 참고 링크

- Karpathy gist: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- Astro-Han SKILL.md: https://github.com/Astro-Han/karpathy-llm-wiki/blob/main/SKILL.md
- nashsu/llm_wiki: https://github.com/nashsu/llm_wiki
- nashsu/llm_wiki_skill: https://github.com/nashsu/llm_wiki_skill
- nvk/llm-wiki: https://github.com/nvk/llm-wiki
- lucasastorian/llmwiki: https://github.com/lucasastorian/llmwiki
