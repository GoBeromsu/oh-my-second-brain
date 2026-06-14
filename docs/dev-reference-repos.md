---
created_by: claude-code
date: 2026-06-13
type: dev-index
---

# 개발용 외부 레퍼런스 Repo 매니페스트

> **목적**: 개발 시 참고하는 외부 소스 트리 목록.  
> 클론은 git-ignored `vendor/reference-repos/` 아래에 위치한다 — 이 폴더는 커밋되지 않는다.  
> 라이선스 준수 규칙: `docs/rules/external-attribution.md` 참고.  
> 미확인 URL은 `TODO(verify)` 로 표시.

---

## Agent Skills / 도구

| 이름 | 용도 (왜 참조) | URL | License | Local clone path | 흡수 여부 |
|------|--------------|-----|---------|-----------------|---------|
| oh-my-claudecode (OMC) | 이 프로젝트가 의존하는 다중 에이전트 오케스트레이션 레이어. 에이전트 정의, 스킬 주입, 훅 패턴 참고. | https://github.com/Yeachan-Heo/oh-my-claudecode | MIT | `vendor/reference-repos/oh-my-claudecode` | reference-only |
| oh-my-codex (OMX) | Codex CLI 동반 레이어. OMC와 대칭 구조 비교, 훅/팀/HUD 패턴 참고. | https://github.com/Yeachan-Heo/oh-my-codex | MIT | `vendor/reference-repos/oh-my-codex` | reference-only |
| graphify | Claude Code 스킬 — 파일/코드/문서를 지식 그래프로 변환. 그래프 빌드 파이프라인 구조 참고. | https://github.com/safishamsi/graphify | MIT | `vendor/reference-repos/graphify` | reference-only |
| lazycodex | Codex CLI 에이전트 하네스 (© 2026 Yeongyu Kim). 에이전트-스타일 워크플로 패턴 참고. | https://github.com/code-yeongyu/lazycodex | MIT | `vendor/reference-repos/lazycodex` | reference-only |

---

## 검색 / 임베딩 엔진

| 이름 | 용도 (왜 참조) | URL | License | Local clone path | 흡수 여부 |
|------|--------------|-----|---------|-----------------|---------|
| qmd | 로컬 마크다운 MCP 검색 엔진 (tobi 작성). BM25+벡터+HyDE 하이브리드 검색, MCP 서버 노출. 이 프로젝트의 검색 계층 설계 참고. | https://github.com/tobi/qmd | MIT | `vendor/reference-repos/qmd` | reference-only |
| pgvector | PostgreSQL 벡터 유사도 검색 확장. 임베딩 스토어 백엔드 후보로 참고. | https://github.com/pgvector/pgvector | PostgreSQL License | `vendor/reference-repos/pgvector` | reference-only |
| PGLite | WASM 포팅 경량 PostgreSQL (electric-sql). 인-프로세스 pgvector 실행 가능성 검토. | https://github.com/electric-sql/pglite | Apache-2.0 / PostgreSQL (dual) | `vendor/reference-repos/pglite` | reference-only |

---

## LLM-Wiki 에코시스템

| 이름 | 용도 (왜 참조) | URL | License | Local clone path | 흡수 여부 |
|------|--------------|-----|---------|-----------------|---------|
| Karpathy's LLM Wiki gist | 원본 아이디어 — Raw sources → Wiki → Schema 3-레이어 패턴. 이 프로젝트의 개념적 원점. | https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f | 명시적 라이선스 없음 (idea doc) | — (gist, 클론 불필요) | reference-only |
| nashsu/llm_wiki | 크로스플랫폼 데스크톱 앱 — 문서를 자동으로 인터링크드 위키로 변환. 증분 위키 빌드 루프 구현 참고. | https://github.com/nashsu/llm_wiki | GPL-3.0 | `vendor/reference-repos/llm_wiki` | reference-only |
| nashsu/llm_wiki_skill | llm_wiki 의 Claude Code 스킬 래퍼. 스킬 통합 패턴 참고. | https://github.com/nashsu/llm_wiki_skill | 명시적 라이선스 없음 | `vendor/reference-repos/llm_wiki_skill` | reference-only |
| Astro-Han/karpathy-llm-wiki | Agent Skills 호환 Karpathy-스타일 위키. 94개 기사, 99개 소스의 실제 프로덕션 예시. | https://github.com/Astro-Han/karpathy-llm-wiki | MIT | `vendor/reference-repos/karpathy-llm-wiki` | reference-only |
| nvk/llm-wiki | 병렬 다중 에이전트 연구, 테제 기반 조사, 소스 수집, 위키 컴파일. 에이전트 오케스트레이션 패턴 참고. | https://github.com/nvk/llm-wiki | MIT | `vendor/reference-repos/nvk-llm-wiki` | reference-only |
| lucasastorian/llmwiki | MCP 서버 내장 오픈소스 LLM Wiki — Claude.ai 가 직접 위키를 읽고 쓸 수 있는 구조 참고. | https://github.com/lucasastorian/llmwiki | Apache-2.0 | `vendor/reference-repos/lucasastorian-llmwiki` | reference-only |

---

## 참고 사항

- `흡수 여부` = **absorbed**: 코드/로직을 이 프로젝트에 직접 포함 / **reference-only**: 열람 참고만.
- GPL-3.0 라이선스 repo(nashsu/llm_wiki)는 코드를 직접 인용하지 말 것 — copyleft 전파 위험.
- 라이선스가 명시되지 않은 repo(nashsu/llm_wiki_skill)는 저자에게 확인 후 사용.
- Karpathy gist 는 아이디어 문서로 라이선스 없음 — 개념 참고는 무방하나 직접 복붙 금지.
