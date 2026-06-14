---
title: "graphify 그래프 구현 마이닝 — 검증된 기법 흡수 및 허점 분석"
slug: graphify-graph-implementation-mining
date: 2026-06-13
type: research
status: active
tags:
  - graph
  - knowledge-graph
  - deduplication
  - community-detection
  - MCP
  - second-brain
source_repo: https://github.com/safishamsi/graphify
license: MIT
author_credit: Safi Shamsi
---

# graphify 그래프 구현 마이닝

> **검토 범위**: 로컬 클론 `/vendor/reference-repos/graphify/` (전체 소스), GitHub Issues 1093–1299 (약 120개 검토), PRs 1088–1301 (약 100개 검토).  
> **흡수 채택**: 24개 항목 [SHIPPED-IN-CODE] / [MERGED].  
> **허점 식별**: 14개 항목 [OPEN-BUG] / [OPEN-RFC].  
> **제외**: [UNVERIFIED] 항목 0개 포함 (미확인 항목 전량 배제).  
> **라이선스**: MIT © Safi Shamsi — 상세는 §5 참조.

---

## §1 graphify 그래프 아키텍처 요약 (코드 근거)

### 1.1 파이프라인 구조

```
detect() → extract() → build_graph() → cluster() → analyze() → report() → export()
```

각 단계는 독립 모듈의 단일 함수. 공유 상태 없음, 부작용은 `graphify-out/` 외부에 없음.  
근거: `ARCHITECTURE.md:4-10`

### 1.2 추출 스키마 (wire format)

```json
{
  "nodes": [{"id": "unique_string", "label": "human name", "source_file": "path",
             "source_location": "L42", "file_type": "code|document|paper|image|rationale|concept"}],
  "edges": [{"source": "id_a", "target": "id_b",
             "relation": "calls|imports|uses|inherits|…",
             "confidence": "EXTRACTED|INFERRED|AMBIGUOUS",
             "confidence_score": 1.0, "weight": 1.0}]
}
```

근거: `ARCHITECTURE.md:38-56`, `graphify/llm.py:374` (프롬프트 템플릿에서 직접 확인)

### 1.3 신뢰도 3-계층

| 레벨 | 의미 |
|------|------|
| `EXTRACTED` | 소스에 명시 (import 구문, 직접 호출) |
| `INFERRED` | 합리적 추론 (call-graph 2nd pass, 공출현) |
| `AMBIGUOUS` | 불확실 — GRAPH_REPORT.md에 플래그 |

근거: `ARCHITECTURE.md:58-64`, `build.py:248-261`

### 1.4 모듈 책임 매핑

| 모듈 | 핵심 함수 | 역할 |
|------|-----------|------|
| `detect.py` (1412 LOC) | `collect_files()` | 단일 pruned os.walk, .gitignore/ignore 패턴 적용 |
| `extract.py` (12059 LOC) | `extract()` → `{nodes, edges}` | tree-sitter AST + LLM semantic 2-pass |
| `build.py` (499 LOC) | `build_from_json()`, `build()`, `build_merge()` | NetworkX 그래프 조립, dedup 호출 |
| `dedup.py` (474 LOC) | `deduplicate_entities()` | 4-pass entity dedup (exact→entropy→MinHash→JW) |
| `cluster.py` (272 LOC) | `cluster()` | Leiden/Louvain community detection |
| `analyze.py` (732 LOC) | `god_nodes()`, `surprising_connections()` | 허브 탐지, 크로스-커뮤니티 연결 발견 |
| `serve.py` (1311 LOC) | `start_server()`, `serve_http()` | MCP stdio + Streamable HTTP 서버 |
| `cache.py` (475 LOC) | `file_hash()`, `load_cached()`, `save_cached()` | AST(버전별) / Semantic(미버전) 2-tier 캐시 |
| `security.py` (457 LOC) | `validate_url()`, `sanitize_label()`, `check_graph_file_size_cap()` | SSRF 가드, 레이블 sanitize, 크기 캡 |

---

## §2 흡수할 검증된 기법

### A. 그래프 구성 기법

#### A-1. AST-우선 노드 ID 생성 + 충돌-방지 부모디렉토리 접두
[SHIPPED-IN-CODE `extract.py:82-97`]

```python
def _file_stem(path: Path) -> str:
    parent = path.parent.name
    if parent and parent not in (".", ""):
        return f"{parent}.{path.stem}"
    return path.stem
```

동일 파일명(`index.py`)이 여러 디렉토리에 있을 때 `parent.index`로 ID 충돌 방지.  
`_make_id()`는 NFKC 유니코드 정규화 + `[^\w]+` → `_` 변환 + casefold.  
**우리 엔진 흡수 포인트**: Obsidian 노트 ID에서 동일 제목 충돌(예: `index.md` in 여러 폴더) 해결에 직접 적용 가능.

#### A-2. 3-레이어 노드 dedup 전략
[SHIPPED-IN-CODE `build.py:1-22`, `build.py:160-215`]

1. **파일 내 dedup**: extractor의 `seen_ids` set — 파일당 1회 emit
2. **파일 간 dedup**: `nx.add_node()` idempotent 덮어쓰기 — semantic이 AST 위에 쓰임(semantic 레이블 우선, AST source_location 우선)
3. **Ghost-merge**: `(basename, label)` 키로 LLM 생성 ghost 노드를 AST canonical 노드에 병합. `_origin=="ast"` 속성이 canonical 신호.

**우리 엔진 흡수**: frontmatter-graph에서 동일 제목 중복 노트 병합 시 `(folder_basename, normalized_title)` 키 전략 참고.

#### A-3. 엣지 방향 보존 (`_src` / `_tgt` attrs)
[SHIPPED-IN-CODE `build.py:264-278`]

undirected NetworkX Graph에서도 원래 방향을 `_src`, `_tgt` 속성으로 보존.  
역방향 중복 엣지는 "first-seen wins" 규칙으로 제거.  
**흡수**: 우리 그래프가 undirected 저장이더라도 `source→target` 의미론 보존 필요 시 동일 패턴.

#### A-4. 크로스-언어 INFERRED calls 필터링
[SHIPPED-IN-CODE `build.py:248-261`]

```python
_LANG_FAMILY: dict[str, str] = {
    ".py": "py", ".js": "js", ".go": "go", ...
}
# 다른 언어 패밀리 간 INFERRED calls 엣지 제거
if _LANG_FAMILY.get(src_ext) != _LANG_FAMILY.get(tgt_ext):
    continue
```

**흡수**: 우리 지식 그래프에서 서로 다른 "도메인" 간 INFERRED 연결 노이즈를 동일 방식으로 필터링 가능.

#### A-5. grow-only build_merge + explicit prune
[SHIPPED-IN-CODE `build.py:378-476`]

`build_merge()`는 기존 `graph.json`을 읽어 신규 청크와 병합. 그래프는 기본적으로 grow-only; 삭제는 `prune_sources` 명시 필요. shrink 감지 안전 가드 내장.  
**흡수**: 우리 엔진의 incremental 업데이트 설계에 동일 원칙 — 삭제는 명시적, 기본은 누적.

#### A-6. 멀티-레포 global graph (namespace prefix)
[SHIPPED-IN-CODE `build.py:479-498`]

```python
def prefix_graph_for_global(G, repo_tag):
    relabel = {n: f"{repo_tag}::{n}" for n in G.nodes}
```

레포 태그를 노드 ID에 prefix해 cross-repo 충돌 방지. per-repo dedup 먼저 실행 후 병합.  
**흡수**: 우리 vault의 "컬렉션" 개념(개인/업무/프로젝트) 간 네임스페이스 격리에 직접 활용.

---

### B. 엔티티 중복 제거 파이프라인

#### B-1. 4-pass dedup 파이프라인
[SHIPPED-IN-CODE `dedup.py:1-5`, `dedup.py:187-314`]

```
Pass 1: 정규화 정확 매칭 (동일 source_file 내)
Pass 2: MinHash/LSH blocking (entropy >= 2.5) + Jaro-Winkler 검증 (임계값 92.0)
Pass 3: LLM tiebreaker (opt-in, JW 75-92 구간)
결과: Union-Find로 트랜지티브 병합
```

주요 상수:
- `_ENTROPY_THRESHOLD = 2.5` bits/char — 저엔트로피 레이블(공통 단어) 제외
- `_LSH_THRESHOLD = 0.7` — MinHash 블로킹
- `_MERGE_THRESHOLD = 92.0` — JW 병합 임계값
- `_COMMUNITY_BOOST = 5.0` — 같은 커뮤니티 노드 보너스
- `_NUM_PERM = 128` — MinHash 해시 수

근거: `dedup.py:119-126`

#### B-2. 자체 구현 MinHash/LSH (datasketch 제거)
[SHIPPED-IN-CODE `graphify/_minhash.py`, CHANGELOG 0.8.37]

`datasketch` → `scipy` → `numpy.testing` 의존성 체인이 EDR/보안 소프트웨어에 의해 차단되는 Windows 환경 버그(#1234) 해결을 위해 순수 numpy MinHash/LSH를 자체 구현. **byte-identical 해시 수학** 보장.  
**흡수**: 우리 엔진도 외부 의존성 최소화 전략으로 핵심 알고리즘을 직접 구현할 것.

#### B-3. 코드 노드 ID-only dedup (레이블 기반 제외)
[SHIPPED-IN-CODE `dedup.py:129-140`, CHANGELOG 0.8.37]

```python
def _is_code(node: dict) -> bool:
    return node.get("file_type") == "code"
```

코드 노드는 레이블 기반 fuzzy dedup에서 완전 제외 — ID만으로 dedup. 서로 다른 파일의 동명 함수(`Config`, `render`)가 병합되던 버그(#1205) 해결.  
**흡수**: Obsidian 노트에서 `code` 타입 노트(예: 코드 스니펫, API 레퍼런스)는 제목 기반 dedup 대상에서 제외.

#### B-4. 변형-쌍 가드 + 접두어-확장 가드
[SHIPPED-IN-CODE `dedup.py:57-89`, `dedup.py:283-285`]

- `_is_variant_pair()`: 동일 스템 + 다른 suffix (M1/M2, cranel/cranelr) → 병합 차단
- 접두어 확장: `getActiveSession` / `getActiveSessions` — 한쪽이 다른쪽의 strict prefix → 병합 차단
- 길이 < 12 chars short label block: 같은 길이 1-char substitution typo만 허용

#### B-5. LLM tiebreaker (opt-in, 배치 30쌍)
[SHIPPED-IN-CODE `dedup.py:379-474`]

JW 75-92 "회색지대" 쌍을 LLM에 일괄 질의:  
`"For each pair: are they the same real-world concept? 1. yes/no"`  
배치 크기 30, 실패 시 graceful fallback.  
**흡수**: 우리 엔진의 semantic dedup에서 애매한 노트 제목 쌍 처리에 동일 패턴 — 단, 비용 주의.

---

### C. 커뮤니티 탐지

#### C-1. Leiden 우선 / Louvain 폴백 전략
[SHIPPED-IN-CODE `cluster.py:23-77`]

```python
try:
    from graspologic.partition import leiden
    result = leiden(stable, random_seed=42, trials=1, resolution=resolution)
except ImportError:
    communities = nx.community.louvain_communities(stable, seed=42, threshold=1e-4)
```

결정론적 출력을 위해 `sorted()` 기반 stable 그래프 사용.  
**흡수**: 우리 엔진도 graspologic optional dep, networkx 기본값으로 동일 패턴.

#### C-2. 과대 커뮤니티 분할 + 저응집도 재분할
[SHIPPED-IN-CODE `cluster.py:80-83`, `cluster.py:161-179`]

- **크기 분할**: 커뮤니티 > max(10, graph_nodes * 25%) → 서브그래프에 Leiden 재실행
- **응집도 재분할**: cohesion < 0.05이고 노드 >= 50 → 재분할 (CLAUDE.md 같은 hub 문서가 무관한 서브시스템을 하나의 커뮤니티로 묶는 문제 해결)

```python
def cohesion_score(G, community_nodes):
    actual = G.subgraph(community_nodes).number_of_edges()
    possible = n * (n - 1) / 2
    return actual / possible
```

근거: `cluster.py:209-217`

**흡수**: Obsidian에서 MOC/허브 노트가 커뮤니티를 과도하게 확장하는 문제를 cohesion-split으로 해결 가능.

#### C-3. 허브 노드 제외 + 다수결 재부착
[SHIPPED-IN-CODE `cluster.py:115-158`]

degree percentile 초과 허브 노드는 파티셔닝에서 제외, 이웃 커뮤니티 다수결로 재부착:
```python
best = min(votes, key=lambda c: (-votes[c], c))
```
**흡수**: README/CLAUDE.md처럼 모든 노드와 연결된 "전역 허브" 문서를 파티셔닝에서 제외하는 전략.

#### C-4. 커뮤니티 ID 안정화 (이전 할당과 최대 겹침)
[SHIPPED-IN-CODE `cluster.py:224-272`]

greedy one-to-one matching by intersection size로 이전 run의 커뮤니티 ID와 최대 겹침 유지.  
**흡수**: incremental 업데이트 시 커뮤니티 ID가 매번 변하면 에이전트가 혼란 — 안정화 필수.

---

### D. MCP 그래프 접근 표면

#### D-1. 10개 MCP 도구 + IDF 기반 노드 스코어링
[SHIPPED-IN-CODE `serve.py:565-686`]

| 도구 | 기능 |
|------|------|
| `query_graph` | BFS/DFS + IDF 가중 키워드 검색 + token_budget |
| `get_node` | 레이블/ID로 단일 노드 전체 속성 조회 |
| `get_neighbors` | 직접 이웃 + relation_filter |
| `get_community` | community_id로 전체 멤버 조회 |
| `god_nodes` | 최고 degree 노드 (허브) |
| `graph_stats` | 노드/엣지 수, 커뮤니티, confidence 분포 |
| `shortest_path` | 두 개념 간 최단 경로 |
| `list_prs` | 오픈 PR + graph impact |
| `get_pr_impact` | PR별 영향 커뮤니티 + 노드 수 |
| `triage_prs` | 모든 액션 가능 PR 우선순위화 |

IDF 가중 스코어링:
```python
_EXACT_MATCH_BONUS = 1000.0
_PREFIX_MATCH_BONUS = 100.0
_SUBSTRING_MATCH_BONUS = 1.0
_SOURCE_MATCH_BONUS = 0.5
```
`serve.py:106-109`

#### D-2. BFS + DFS 이중 탐색 모드
[SHIPPED-IN-CODE `serve.py:315-370`]

- BFS: 넓은 컨텍스트 (depth 기본 3, 최대 6)
- DFS: 특정 경로 추적

`_pick_seeds()`: IDF 스코어 상위 노드 중 score gap이 20% 이상인 지점에서 컷오프로 seed 선택.  
`serve.py:193-259`

#### D-3. Streamable HTTP transport (팀 공유 그래프 서버)
[SHIPPED-IN-CODE `serve.py:1110-1248`, CHANGELOG 0.8.34]

```
python -m graphify.serve graph.json --transport http --port 8080 --api-key $SECRET
```

MCP Streamable HTTP spec (2025-03-26) 준수. stateless/stateful 모드, session timeout, Bearer auth.  
**흡수**: 우리 엔진의 MCP 서버도 stdio 기본 + HTTP opt-in으로 동일 패턴.

#### D-4. 그래프 hot-reload
[SHIPPED-IN-CODE `serve.py:537-563`]

`_maybe_reload()`: 파일 mtime 감지 시 `_load_graph()` 재실행. 서버 재시작 불필요.  
**흡수**: 우리 MCP 서버도 vault 업데이트 시 그래프 자동 reload 필요.

---

### E. 캐시 전략

#### E-1. AST 버전별 / Semantic 미버전 2-tier 캐시
[SHIPPED-IN-CODE `cache.py:271-290`]

```
graphify-out/cache/ast/v{version}/  ← extractor 코드 의존 → 버전별 분리
graphify-out/cache/semantic/        ← LLM 출력 → 비버전 (expensive re-run 방지)
```

AST 캐시 키: SHA256(파일 본문, YAML frontmatter 제거 후).  
stat fastpath: size + mtime_ns 일치 시 전체 파일 읽기 스킵 (make(1)과 동일 전략).  
근거: `cache.py:85-88`, `cache.py:155-200`

**흡수**: 우리 그래프 빌드에서 structural parse(AST상당)는 버전 네임스페이스, LLM embedding은 미버전으로 분리.

#### E-2. Markdown frontmatter 제거 후 해시
[SHIPPED-IN-CODE `cache.py:66-85`]

Markdown `.md` 파일의 캐시 해시는 YAML frontmatter(---) 아래 body만 포함. frontmatter-only 변경(태그, 날짜 업데이트)이 불필요한 재추출을 트리거하지 않음.  
**흡수**: 우리 Obsidian 노트 캐시 전략에 직접 적용. frontmatter 변경은 메타데이터 업데이트만, body 변경은 full reindex.

---

### F. 보안 레이어

#### F-1. SSRF 가드 (per-connection, TOCTOU 없음)
[SHIPPED-IN-CODE `security.py`, CHANGELOG 0.8.37]

global `socket.getaddrinfo` monkey-patch 제거 → per-connection `_SSRFGuardedHTTPConnection` subclass로 교체. DNS 1회 resolve → IP validate → 동일 주소로 connect. thread-safe, TOCTOU 없음.

#### F-2. 프롬프트 인젝션 완화
[SHIPPED-IN-CODE CHANGELOG 0.8.37]

소스 파일 콘텐츠를 `<untrusted_source path="..." sha256="...">` XML 래퍼로 감싸, jailbreak 센티널 토큰(`<|im_start|>`, `[INST]` 등)을 zero-width space로 중화.

#### F-3. 레이블 sanitize
[SHIPPED-IN-CODE `security.py:sanitize_label()`]

제어 문자 strip, 256자 캡, HTML escape. 모든 LLM 파생 레이블에 적용.

---

## §3 허점/한계 → 우리의 개선점

### Gap-1. Ghost-merge가 동일 (basename, label) 다중 AST 노드에서 오병합
[OPEN-BUG #1257, PR #1258 OPEN as of 2026-06-13]

**증거**: issue #1257 — 서로 다른 파일에 동일 이름 심볼이 있을 때 last-writer-wins로 wrong canonical 선택.  
**우리 개선점**: `(basename, label, file_type)` 3-tuple 키 사용 + multi-match 시 병합 스킵 대신 명확화 프롬프트. Obsidian에서 동명 노트는 경로를 포함한 4-tuple 키 사용.

### Gap-2. 비-코드 노드(rationale/document/concept)에 대한 fuzzy dedup 과병합
[OPEN-BUG #1284, PR #1286 DRAFT]

**증거**: #1284 — 번호 붙은 sibling 노드(rationale-1 / rationale-2)와 cross-file boilerplate가 fuzzy merge됨. #1205의 code 보호가 다른 file_type에는 미적용.  
**우리 개선점**: `document`, `rationale`, `concept` 타입도 각각의 규칙으로 보호. 특히 번호 suffix guard 범용화.

### Gap-3. build_merge가 병합 후 prune — 수정 파일의 신선한 노드 손실
[OPEN-BUG #1283, PR #1285 OPEN]

**증거**: #1283 — 수정된 파일이 스킬 업데이트 템플릿에 전달될 때 이전 노드가 먼저 pruned되지 않아 stale 노드와 fresh 노드가 coexist.  
**우리 개선점**: build_merge 시퀀스: `prune(old) → extract(new) → merge` 순서 강제. 원자적 swap 전략.

### Gap-4. Ghost 노드 생존 — 파일에서 삭제된 심볼이 그래프에 잔류
[OPEN-BUG #1152]

**증거**: grow-only merge 설계상 source_file별 노드 교체가 없음. 함수 삭제 → ghost 노드 영구 잔류.  
**우리 개선점**: 파일 단위 `_origin` 마킹 + incremental run시 해당 source_file 노드 전량 교체 (set-replace 방식). 우리 Obsidian 노트는 파일 삭제가 명확하므로 더 간단하게 구현 가능.

### Gap-5. Node ID가 컨텍스트 의존적 (_file_stem 즉시 부모만 사용)
[OPEN-BUG #1158]

**증거**: `_file_stem`이 즉시 부모 디렉토리만 사용 → 깊은 경로에서 ID 충돌 (다른 `components/Button/index.ts`들).  
**우리 개선점**: vault-relative 전체 경로 해시 기반 ID 사용. `sha256(vault_relative_path)[:8]` + `normalized_title` 복합 키.

### Gap-6. cross-file 상속/타입 참조 추출 누락
[OPEN-BUG #1186, PR #1231 OPEN]

**증거**: AST 추출기가 같은 파일 내 상속만 캡처 — cross-file `extends`, `implements` 누락. ghost-duplicate 노드 발생.  
**우리 개선점**: SCIP/LSP 기반 심볼 해결 (graphify도 `scip_ingest.py`로 실험 중). 우리는 wikilink를 cross-file 연결의 1st-class 엣지로 처리하므로 이 문제가 구조적으로 없음.

### Gap-7. extract.py 11,600 LOC 모놀리스
[OPEN-BUG #1212, PR #1291 OPEN refactor]

**증거**: 45개 언어 추출기가 단일 파일. 로딩 시간, 테스트 격리, 기여 장벽 문제.  
**우리 개선점**: 처음부터 언어별 추출기 모듈 분리 (`extractors/python.py`, `extractors/markdown.py` 등). graphify의 교훈을 설계에 반영.

### Gap-8. 로컬 임베딩 패스 없음 — semantically_similar_to는 LLM 필수
[CLOSED PR #1126 — not merged, OPEN-BUG by design]

**증거**: PR #1126 (local embedding pass for semantically_similar_to) 클로즈됨. 현재 semantic similarity 엣지는 LLM API 없이 생성 불가.  
**우리 개선점**: sentence-transformers / nomic-embed-text 같은 로컬 임베딩으로 semantically_similar_to 엣지 생성 지원. API 키 없이도 semantic graph 구성 가능. **이것이 우리의 핵심 차별점**.

### Gap-9. SQLite tiered storage 미구현 (RFC 단계)
[OPEN-RFC #1297 — proposed, not implemented]

**증거**: #1297 — 현재 graph.json 단일 파일, query latency 17-64× 개선 가능한 SQLite 티어드 스토리지 RFC만 존재.  
**우리 개선점**: 그래프 저장소를 처음부터 SQLite or DuckDB로 구현. 노드/엣지 테이블 + FTS5 인덱스 + 벡터 컬럼(sqlite-vec). 파일 기반 graph.json의 512MiB 캡 문제도 해소.

### Gap-10. 레이블 매칭 노드 열거 서브커맨드 없음
[OPEN #1296]

**증거**: `query`는 traversal 도구 — 에이전트가 필요로 하는 단순 "이름으로 노드 목록 나열" 기능 없음.  
**우리 개선점**: `oms_list_concepts` 같은 레이블-인덱스 직접 접근 도구. 우리 OMS는 이미 `oms_list_concepts` 구현함.

### Gap-11. ProcessPoolExecutor가 Windows >61 코어에서 크래시
[OPEN-BUG #1298]

**증거**: Windows `ProcessPoolExecutor` max workers 61 cap. 크로스-플랫폼 배포 시 문제.  
**우리 개선점**: ThreadPoolExecutor 우선 + ProcessPoolExecutor opt-in. 혹은 async I/O 기반 파이프라인.

### Gap-12. cluster-only가 JSON parse 오류 시 배치 재시도/분할 없음
[OPEN-BUG #1278]

**증거**: #1278 — `extract`와 달리 `cluster-only`는 실패한 배치를 그냥 스킵. 일관성 없음.  
**우리 개선점**: 모든 LLM 배치 실패에 exponential backoff + chunk-split 재시도 표준화.

### Gap-13. 비밀 휴리스틱이 토픽 언급 노트를 잘못 차단
[OPEN-BUG #1225]

**증거**: `token-economics-of-recall.md`, `password-policy-discussion.md` 같은 파일이 `_is_sensitive()`에 의해 silently dropped.  
**우리 개선점**: 명시적 allowlist (`.graphifyinclude` 오버라이드 지원) + 차단 이유 로깅. Obsidian vault는 사용자가 신뢰하는 파일만 포함하므로 이 휴리스틱을 기본 off로.

### Gap-14. cross-domain AST↔semantic 서브그래프 브리징 없음
[OPEN #1254]

**증거**: AST 그래프와 semantic 그래프가 동일 엔티티를 별개 노드로 표현하는 alignment 문제. RFC만 존재.  
**우리 개선점**: 우리 엔진의 4-tier 모델(structural → semantic → conceptual → temporal)에서 계층 간 브리지 엣지를 first-class로 설계. graphify는 이를 ad-hoc 처리하지만 우리는 명시적 cross-tier 엣지 타입 도입.

---

## §4 우리 엔진 매핑

### 4.1 OMS (Oh My Second Brain) 4-tier 모델과의 대응

| graphify 개념 | 우리 4-tier 모델 대응 | 구체적 흡수 |
|---------------|----------------------|-------------|
| `file_type: code|document|concept` | Tier 1 structural (metadata graph) | Obsidian 노트 타입 분류 기반 dedup 정책 |
| `confidence: EXTRACTED|INFERRED|AMBIGUOUS` | Tier 2 semantic (link graph) | 엣지 신뢰도 3-계층 그대로 채택 |
| `community` 속성 on nodes | Tier 3 conceptual (topic clusters) | Leiden + cohesion-split로 MOC 자동 생성 |
| `god_nodes` | Tier 4 temporal (hub 감지) | 자주 링크된 노트 = hub = temporal importance |

### 4.2 live-sparse vs cached 전략

graphify의 2-tier 캐시 교훈:

| 레이어 | graphify 방식 | 우리 방식 |
|--------|--------------|----------|
| Structural parse | AST cache (버전별, SHA256-body) | frontmatter/wikilink parse (버전별) |
| Semantic enrichment | Semantic cache (미버전, expensive) | embedding cache (미버전, reuse across versions) |
| Live query | MCP serve + hot-reload | OMS MCP + `oms_lazy_load_note` |
| Incremental update | build_merge (grow-only + explicit prune) | capture-commit + prune-on-delete |

**핵심 결론**: graphify의 grow-only merge + prune 패턴은 우리 OMS capture 파이프라인의 `oms_capture_commit`과 직접 대응. 차이점은 우리는 Obsidian vault의 파일 삭제 이벤트를 watch로 감지할 수 있으므로 ghost 노드 문제가 구조적으로 더 해결하기 쉬움.

### 4.3 MCP graph 표면 설계 흡수

graphify MCP 10도구 중 우리 엔진에 흡수할 것:

| graphify 도구 | 우리 OMS 대응 / 개선 |
|--------------|---------------------|
| `query_graph` (BFS/DFS + IDF) | `oms_semantic_query` — 기존 구현에 IDF 가중치 추가 |
| `get_neighbors` | `oms_retrieve_context` — relation_filter 파라미터 추가 |
| `get_community` | `oms_semantic_collections` — community_id 기반 접근 |
| `god_nodes` | `oms_list_concepts` — degree 정렬 옵션 추가 |
| `shortest_path` | **미구현** → 신규 추가 필요 (`oms_find_path`) |
| `graph_stats` | `oms_graph_status` — confidence 분포 통계 추가 |
| `list_prs` / `get_pr_impact` | 우리 scope 외 (코드베이스 PR 아님) |
| `triage_prs` | 우리 scope 외 |

**신규 추가 우선순위**: `oms_find_path` (shortest_path 상당), IDF 기반 노드 스코어링을 `oms_semantic_query`에 통합.

### 4.4 frontmatter-graph 엣지 생성 전략

graphify의 엣지 생성 교훈을 Obsidian frontmatter에 적용:

```
wikilink [[Note B]] → relation: "references", confidence: EXTRACTED
frontmatter tags: same tag → relation: "shares_topic", confidence: INFERRED  
semantic similarity (embedding) → relation: "semantically_similar_to", confidence: AMBIGUOUS
frontmatter parent: / up: → relation: "hierarchical", confidence: EXTRACTED
```

graphify의 cross-language INFERRED filter 상당으로, 서로 다른 "도메인 폴더" 간 INFERRED 엣지는 신뢰도 하향 조정.

---

## §5 라이선스/귀속 메모

- **라이선스**: MIT © Safi Shamsi (graphify)
- **적용 범위**: 알고리즘 개념 및 아이디어 흡수는 MIT 라이선스 하에 자유롭게 허용됨
- **코드 직접 복사 시**: 저작권 고지 `// Copyright (c) Safi Shamsi — MIT License` 보존 필수
- **권고 조치**:
  1. `ACKNOWLEDGMENTS.md` 에 다음 항목 추가:
     ```
     ## graphify (vendored reference)
     - Repo: https://github.com/safishamsi/graphify
     - Author: Safi Shamsi
     - License: MIT
     - Local path: vendor/reference-repos/graphify/
     - Purpose: Graph algorithm implementation reference for oh-my-secondbrain engine design
     ```
  2. 코드를 직접 포크/복사할 경우 원본 `LICENSE` 파일을 `vendor/reference-repos/graphify/LICENSE`에 유지
  3. 알고리즘 설명 문서에 "inspired by graphify (MIT © Safi Shamsi)" 귀속 표기
- **Cross-link**: `/Users/beomsu/Documents/01_Project/oh-my-secondbrain/ACKNOWLEDGMENTS.md` — graphify 항목 추가 필요

---

## References

### 로컬 코드 파일
- `vendor/reference-repos/graphify/ARCHITECTURE.md` — 파이프라인 아키텍처
- `vendor/reference-repos/graphify/CHANGELOG.md` — 버전별 shipped 기능
- `vendor/reference-repos/graphify/graphify/build.py` — 그래프 구성, ghost-merge, edge direction
- `vendor/reference-repos/graphify/graphify/dedup.py` — 4-pass dedup 파이프라인
- `vendor/reference-repos/graphify/graphify/cluster.py` — Leiden/Louvain, cohesion-split
- `vendor/reference-repos/graphify/graphify/serve.py` — MCP 10도구, IDF 스코어링, HTTP transport
- `vendor/reference-repos/graphify/graphify/cache.py` — AST/Semantic 2-tier 캐시
- `vendor/reference-repos/graphify/graphify/extract.py` — tree-sitter AST 추출기 (12k LOC)
- `vendor/reference-repos/graphify/graphify/analyze.py` — god_nodes, cohesion, import cycles
- `vendor/reference-repos/graphify/graphify/_minhash.py` — 자체 구현 MinHash/LSH
- `vendor/reference-repos/graphify/graphify/security.py` — SSRF, sanitize, prompt injection 완화

### GitHub Issues (검토된 주요 항목)
- [#1297](https://github.com/safishamsi/graphify/issues/1297) — SQLite tiered storage RFC [OPEN]
- [#1296](https://github.com/safishamsi/graphify/issues/1296) — label-match 노드 열거 [OPEN]
- [#1284](https://github.com/safishamsi/graphify/issues/1284) — fuzzy dedup non-code over-merge [OPEN]
- [#1283](https://github.com/safishamsi/graphify/issues/1283) — build_merge prune order [OPEN]
- [#1279](https://github.com/safishamsi/graphify/issues/1279) — edges missing source_file [OPEN]
- [#1278](https://github.com/safishamsi/graphify/issues/1278) — cluster-only no retry [OPEN]
- [#1257](https://github.com/safishamsi/graphify/issues/1257) — ghost-merge basename collision [OPEN]
- [#1254](https://github.com/safishamsi/graphify/issues/1254) — AST↔semantic bridging RFC [OPEN]
- [#1212](https://github.com/safishamsi/graphify/issues/1212) — extract.py monolith [OPEN]
- [#1205](https://github.com/safishamsi/graphify/issues/1205) — dedup merges same-named code symbols [CLOSED-FIXED]
- [#1201](https://github.com/safishamsi/graphify/issues/1201) — fuzzy dedup prefix-extension [CLOSED-FIXED]
- [#1186](https://github.com/safishamsi/graphify/issues/1186) — cross-file inheritance missing [OPEN]
- [#1178](https://github.com/safishamsi/graphify/issues/1178) — --update destructive merge [CLOSED-FIXED]
- [#1158](https://github.com/safishamsi/graphify/issues/1158) — node ID context-dependent [OPEN]
- [#1152](https://github.com/safishamsi/graphify/issues/1152) — ghost nodes for deleted symbols [OPEN]
- [#1147](https://github.com/safishamsi/graphify/issues/1147) — builtin type annotation god-nodes [CLOSED-FIXED]
- [#1145](https://github.com/safishamsi/graphify/issues/1145) — AST/semantic different node IDs [CLOSED-FIXED]
- [#1126](https://github.com/safishamsi/graphify/issues/1126) — local embedding pass [CLOSED-NOT-MERGED]

### GitHub PRs (주요 MERGED 항목)
- [PR #1289](https://github.com/safishamsi/graphify/pull/1289) — O(n²)→O(n) LSH lookup [MERGED]
- [PR #1282](https://github.com/safishamsi/graphify/pull/1282) — --model flag for community labeling [MERGED]
- [PR #1280](https://github.com/safishamsi/graphify/pull/1280) — KeyError 'links' fix [MERGED]
- [PR #1276](https://github.com/safishamsi/graphify/pull/1276) — .graphifyignore negation fix [MERGED]
- [PR #1271](https://github.com/safishamsi/graphify/pull/1271) — Cargo extractor [MERGED]
- [PR #1269](https://github.com/safishamsi/graphify/pull/1269) — tsconfig paths baseUrl fix [MERGED]
- [PR #1262](https://github.com/safishamsi/graphify/pull/1262) — single walk collect_files [MERGED]
- [PR #1260](https://github.com/safishamsi/graphify/pull/1260) — frontmatter delimiter fix [MERGED]
- [PR #1253](https://github.com/safishamsi/graphify/pull/1253) — AST cache version namespace [MERGED]
- [PR #1251](https://github.com/safishamsi/graphify/pull/1251) — global graph external edge rewire [MERGED]
- [PR #1248](https://github.com/safishamsi/graphify/pull/1248) — dedup pass2 winner fix [MERGED]
- [PR #1244](https://github.com/safishamsi/graphify/pull/1244) — claude-cli JSON array envelope [MERGED]
- [PR #1197](https://github.com/safishamsi/graphify/pull/1197) — multi-batch label_communities [MERGED]
- [PR #1195](https://github.com/safishamsi/graphify/pull/1195) — None label guard [MERGED]
- [PR #1176](https://github.com/safishamsi/graphify/pull/1176) — FalkorDB export [MERGED]
