# Architecture Decision Records

oh-my-secondbrain 프로젝트의 주요 설계 결정을 기록한다.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](./0001-validate-returns-result.md) | validateFrontmatter Returns a Result, Never Throws | Accepted |
| [0002](./ADR-002-vector-embedding-backend.md) | Vector Embedding Backend — pgvector + 상용 임베딩 | Accepted |
| [ADR-003](./ADR-003-oms-vault-convention-asset.md) | oms = Vault-Convention 자산 — Default 온톨로지 + Vault-ADR 투명성 | Accepted |
| [ADR-004](./ADR-004-config-secrets-access-topology.md) | Config · Secrets · Access Topology — 3-tier global/vault/per-repo 구성 | Proposed |
| [ADR-005](./ADR-005-graph-access-model.md) | 그래프 접근 모델 — 엣지 계층 · 운영 모드 · MCP tools | Proposed |
| [ADR-006](./ADR-006-oms-governance-contract-separation.md) | .oms 거버넌스 — 기계검증 계약(yaml) ↔ 의도 기록(documents) 명시적 분리 | Accepted |
| [ADR-007](./ADR-007-no-fake-embedder-fallback-native-dim-integrity.md) | 임베딩 무결성 불변 — 네이티브 차원 보존 & 가짜 임베더 폴백 금지 | Accepted |
| [ADR-008](./ADR-008-note-identity-real-path-ssot-no-slug.md) | 노트 식별자 모델 — 실경로 SSOT, 슬러그 비도입 | Accepted |
| [ADR-009](./ADR-009-qmd-compatible-global-collection-bridge.md) | qmd-호환 전역 컬렉션 브릿지 — link 기반 vault 해석과 product interface 계약 | Superseded (ADR-010; D1/D3/D4 remain in force) |
| [ADR-010](./ADR-010-search-backend-seam-qmd-optional.md) | SearchBackend seam — in-repo engine default, qmd optional backend | Accepted |
| [ADR-011](./ADR-011-search-reranking-opt-in.md) | Search reranking — explicit opt-in until a production reranker exists | Accepted |

## 작성 규칙

- 언어: 한국어 우선, 기술 용어는 영어 원어 사용
- 필수 섹션: Status / Context / Decision / Alternatives Considered / Consequences
- Frontmatter: `title`, `status`, `date`, `created_by`, `deciders`, `relates_to`; superseded records additionally use `superseded_by` to link their successor (a deliberate schema extension)
- 번호 형식: 4자리 zero-pad (`0001`, `0002`, …) 또는 `ADR-NNN` — 혼용 허용, 신규는 `ADR-NNN` 선호
