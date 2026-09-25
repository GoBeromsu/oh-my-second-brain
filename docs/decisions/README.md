# Architecture Decision Records

oh-my-secondbrain 프로젝트의 주요 설계 결정을 기록한다. 주제당 ADR 하나만 살아 있다(MECE).
다른 주제에 속하는 내용은 다시 쓰지 않고 해당 ADR을 가리킨다.

| ADR | 주제 | Title | Status |
|-----|------|-------|--------|
| [ADR-001](./ADR-001-vault-resolution-link-note-identity.md) | 볼트 해석·링크·노트 식별자 | 볼트 해석·링크·노트 식별자 | Accepted |
| [ADR-002](./ADR-002-config-secrets-host-state-roots.md) | 설정·비밀·호스트 상태 루트 | 설정·비밀·호스트 상태 루트 | Accepted |
| [ADR-003](./ADR-003-local-index-storage-and-fusion.md) | 로컬 인덱스 | 외부 캐시 SQLite(FTS5 + sqlite-vec), 증분 sync, RRF | Accepted |
| [ADR-004](./ADR-004-search-backend-and-reranking.md) | 검색 백엔드·리랭킹 | 좁은 SearchBackend seam, 단일 정규화, opt-in 리랭크 | Accepted |
| [ADR-005](./ADR-005-embedding-model-contract-integrity-lifecycle.md) | 임베딩 모델 | identity-only 선언, 검증된 로컬 설치, 불변 lineage, 가짜 폴백 금지 | Accepted |
| [ADR-006](./ADR-006-graph-access.md) | 그래프 접근 | axis-seed 1-hop 로컬 이웃, cache 또는 headless scan | Accepted |
| [ADR-007](./ADR-007-vault-contract-ontology.md) | vault 계약 | 폴더·속성·템플릿 세 봉인 계약, 단일 판정자, 에이전트에게 비공개 | Accepted |
| [ADR-008](./ADR-008-taxonomy.md) | taxonomy | 사용자 소유 `.oms/taxonomy.json` 단일 권위 | Superseded by ADR-007 |
| [ADR-009](./ADR-009-cross-cutting-principles.md) | 공통 원칙 | 보고형 결과, 사용자 권위, 읽기 무생성, 은퇴 경로 거부 | Accepted |

2026-09-24에 기존 ADR 0001–016을 위 아홉 개로 재편하고 삭제했다. 본문의 "구 ADR-0NN"은
삭제된 기록을 뜻하며, 원문은 git 이력(commit `de1994b9` 이전)에서 볼 수 있다. 각 ADR 끝의
`흡수 내역` 표가 구 조항이 어디로 옮겨졌는지(또는 왜 폐기되었는지) 적는다.

## 작성 규칙

- 언어: 한국어 우선, 기술 용어는 영어 원어 사용
- 필수 섹션: Status / Context / Decision / Alternatives Considered / Consequences, 끝에 `흡수 내역`(해당 시)
- Frontmatter: `slug`, `title`, `status`, `date`, `created_by`, `deciders`, `relates_to`; 대체 관계는 `supersedes`, `supersedes_in_part`(조항 표시), 대체된 기록은 `superseded_by`
- 번호 형식: `ADR-NNN`
- 새 결정은 먼저 기존 주제 ADR을 고친다. 어느 주제에도 속하지 않을 때만 새 번호를 만든다
- Decision 항목은 현재 코드 동작을 근거(`파일:줄`)로 쓴다. 코드와 다른 계획은 Proposed로 남긴다
