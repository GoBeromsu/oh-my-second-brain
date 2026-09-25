---
slug: ADR-001-vault-resolution-link-note-identity
title: "볼트 해석·링크·노트 식별자"
status: Accepted
date: 2026-09-24
created_by: claude
deciders: [beomsu]
supersedes:
  - 구 ADR-008
supersedes_in_part:
  - 구 ADR-009#D1
  - 구 ADR-009#D3
  - 구 ADR-009#D4
  - 구 ADR-010#Context
relates_to:
  - ./ADR-002-config-secrets-host-state-roots.md
  - ./ADR-006-graph-access.md
  - ./ADR-007-vault-contract-ontology.md
  - ./ADR-009-cross-cutting-principles.md
---

# ADR-001: 볼트 해석·링크·노트 식별자

## Status

Accepted (2026-09-24). 이 주제의 유일한 기준이다. 구 ADR-008 전체와 구 ADR-009 D1/D3/D4, 구 ADR-010 Context의 fallback 순서 서술(24–27행)을 대체한다.

## Context

명령은 어느 디렉터리에서든 실행되고, 그때마다 "어느 볼트에 대해 동작하는가"와 "노트를 무엇으로 식별하는가"를 결정론적으로 정해야 한다. 이 결정은 구 ADR-008·009·010에 흩어져 있었고, 그 뒤 구현이 바뀌면서 문서와 코드가 어긋났다. 이 ADR은 현재 코드를 기준으로 다시 쓴다.

- 구 ADR-009 D1은 로컬 볼트 증거를 `.oms/concepts/` 또는 `.oms/taxonomy.yaml`로 정했지만, 구현은 `.oms/settings.json` 파일 하나만 본다(src/kernel/link/link.ts:159-162).
- 구 ADR-009 D1에는 명시 지정(explicit)이 없었지만, 구현은 `--vault`/explicit을 모든 단계보다 먼저 둔다(src/kernel/link/link.ts:231-233).
- 구 ADR-009 D1은 bridge를 `vault`+`scope` 레코드로 정했지만, 구현은 v2 connection reference를 registry에 대조해 검증하고, v1 레코드는 읽기 전용 `legacy-bridge`로만 인정한다(src/kernel/link/link.ts:183-215).
- 구 ADR-010(24–27행)과 구 ADR-009는 "이후 global-config fallback"을 말했지만, 구현은 global selection을 fallback으로 절대 쓰지 않는다(src/kernel/link/link.ts:223-224).
- 구 ADR-009 D4는 `qmd://`를 scheme으로만 허용했지만, 구현은 `qmd://` 분기를 제거했고 `oms://<collection>/<path>`만 벗겨 낸다(src/kernel/engine/mcp/facade.ts:125-140).
- 구 ADR-008은 `src/engine/tracer.ts`를 인용했지만, 현재 경로는 `src/kernel/engine/tracer.ts`다.

## Decision

### 1. 볼트 해석 우선순위
`resolveEffectiveVault`는 다음 순서로 결정하며 앞 단계가 성립하면 멈춘다: (1) explicit(`--vault`) → (2) startDir의 로컬 볼트 증거 → (3) 검증된 bridge → (4) `OMS_VAULT`(`~` 전개) → (5) startDir(cwd). global selection(호스트 pointer/registry의 "선택된 볼트")은 fallback이 아니다 (src/kernel/link/link.ts:220-240). 결과에는 출처 `VaultSource = explicit | vault | bridge | legacy-bridge | env | cwd`가 붙는다 (src/kernel/link/link.ts:37). CLI 명령은 모두 이 함수 하나로 해석한다 (src/cli/oms.ts:67, src/cli/search.ts:49, src/cli/note-command.ts:75, src/cli/status-command.ts:51, src/cli/host-commands.ts:247 등). 순서 변경은 breaking change다 (src/cli/usage.ts:98에 사용자 문서로 고정).

### 2. 로컬 볼트 증거
startDir의 `.oms/settings.json`이 regular file로 있으면 그 디렉터리가 볼트다 (src/kernel/link/link.ts:159-162). `.oms/`의 다른 파일은 볼트 증거가 아니다. 파일 내용은 → ADR-002 §5, 봉인된 계약은 → ADR-007.

### 3. Bridge(프로젝트 → 볼트 링크)
- 증거: `<repo>/.oms/links.yaml`이 있거나 `<repo>/.oms/linked/`에 보이는 항목이 있으면 bridge 경로로 간다 (src/kernel/link/link.ts:166-177, 32-35).
- v2 레코드(`version: 2`, `connectionId`, `portableVaultId`, `scope`)만 정식 bridge다 (src/kernel/install/project-connection.ts:25, 205, 220). 해석 시 connection registry의 항목과 `portableVaultId`가 일치하고, 볼트 `.oms/settings.json`의 `vaultId`가 같으며, 등록 경로가 realpath와 같아야 한다. 어느 하나라도 어긋나면 해석을 거부한다 (src/kernel/link/link.ts:201-214). registry 위치는 → ADR-002.
- v1 레코드(`version`, `vault`, `scope`)는 변환하지 않고 `legacy-bridge` + `legacy-readonly` 진단으로 읽기 전용 해석만 한다 (src/kernel/link/link.ts:195-200).
- bridge 레코드는 참조와 scope만 담고 설정·비밀은 담지 않는다 (src/kernel/install/project-connection.ts:110, 220).
- 기록 동시성은 `.oms/links.yaml.lock`으로 직렬화한다 (src/kernel/install/project-connection.ts:67).

### 4. 출처별 변경 허용
cwd와 legacy-bridge 출처는 읽기 전용이다. 쓰기 admission은 `explicit | vault | bridge | env`만 허용하고 나머지를 `target-unverified`로 거부한다 (src/kernel/capture/safe.ts:28-48; 쓰기 검증 세부 → ADR-007). 호스트 변경 명령도 cwd 출처를 거부한다 (src/cli/host-commands.ts:249-250).

### 5. `oms link`의 부수 기록
`oms link`는 프로젝트 `AGENTS.md`에 `<!-- oms:begin -->`…`<!-- oms:end -->` 관리 블록을 쓰고, 기존 블록은 교체한다. 블록에는 볼트 basename과 "connection details live in .oms/links.yaml"만 적고 개인 절대 경로·비밀은 넣지 않는다 (src/kernel/link/convention-note.ts:4, 31, 44). `conventionNote === false`면 생략한다 (src/cli/link-command.ts:184). 링크 투영(`.oms/linked/`)은 gitignore 대상이다 (src/kernel/link/link.ts:32-35).

### 6. 노트 식별자 = 볼트 상대 real path
노트의 canonical ID는 볼트 루트 기준 상대 경로이며 구분자는 `/`로 정규화한다. slug 계층은 없다. 인덱스 동기화 (src/kernel/engine/embed/sync.ts:155-174), 명시 파일 입력 검증 (src/kernel/engine/embed/sync.ts:177-200), tracer (src/kernel/engine/tracer.ts:70-91), 그래프 빌더 (src/kernel/engine/graph/builder.ts:91, 110), axes store (src/kernel/engine/axes/store.ts:413)가 모두 같은 규칙을 쓴다. 외부 입력의 `oms://<collection>/<path>`는 path만 남기고, 일반 입력은 `\`→`/`, 선행 `./`를 제거한다 (src/kernel/engine/mcp/facade.ts:133-140).

### 7. Wikilink → real path
wikilink는 basename·경로(대소문자 무시, 원래 대소문자 경로로 복원)·frontmatter alias 인덱스로 볼트 상대 real path에 매핑한다. 못 찾으면 `docPath: null`이다 (src/kernel/engine/graph/resolver.ts:1-60). edge 의미와 그래프 탐색은 → ADR-006.

### 8. 오류 표현
bridge 해석 실패의 반환·예외 규칙은 → ADR-009.

### 미결
- `src/kernel/engine/tracer.ts:265-284`의 별도 `resolveVault()`는 `OMS_VAULT` → cwd만 보고 `resolveEffectiveVault`를 우회한다. `makeTracerConfig`(tracer.ts:291) 외에 production 호출자는 확인되지 않았다. 제거할지, 1번 순서로 통일할지 정해지지 않았다.
- 구 ADR-008의 "slug를 비-canonical 파생 필드로 나중에 추가할 수 있다"는 코드 근거가 없다(engine에 slug 없음). 필요해지면 새 ADR에서 정한다.

## Alternatives Considered

- **global selection을 마지막 fallback으로 두기** (구 ADR-009/010 서술): 호스트 전역 상태가 프로젝트 해석을 조용히 바꾸어 잘못된 볼트에 쓸 위험이 있어 기각했다. 코드가 명시적으로 배제한다 (link.ts:223-224).
- **`OMS_VAULT` 단독**: 프로젝트마다 다른 볼트/scope를 표현할 수 없어 기각했다.
- **v1 bridge 자동 변환**: 경로 기반 레코드는 볼트 identity를 증명하지 못한다. 그래서 읽기 전용으로만 두고, 변환은 명시 migration에 맡긴다.
- **qmd global registry / `qmd://` scheme 유지**: qmd 호환은 더 이상 제품 계약이 아니므로 기각했다 (facade.ts:129-131).
- **slug를 canonical ID로**: rename 시 이중 SSOT와 충돌 해소 부담이 생겨 기각했다 (구 ADR-008 근거 유지).

## Consequences

- 같은 디렉터리·환경에서는 해석 결과가 결정론적이고, 출처(`source`)가 항상 드러난다.
- cwd에서 우연히 해석된 볼트에는 쓰기·호스트 변경이 일어나지 않는다. 대신 사용자는 `--vault`, `oms setup`, `oms link`, `OMS_VAULT` 중 하나를 거쳐야 한다.
- v1 bridge를 쓰는 프로젝트는 읽기만 되고, 쓰려면 v2로 migration해야 한다.
- 노트 rename은 ID 변경이다. 인덱스·그래프는 경로 기준으로 재동기화된다.
- AGENTS.md 관리 블록은 커밋되어도 개인 경로가 새지 않는다.

## 흡수 내역

| 기존 ADR 조항 | 이 ADR |
|---|---|
| 구 ADR-008 전체 (real path SSOT, no slug) | §6 |
| 구 ADR-008 "slug는 나중에 파생 필드로" | 미결 (코드 근거 없음) |
| 구 ADR-008 qmd 경계의 slug forward map | 폐기: qmd 경계 코드 제거됨 (facade.ts:129) |
| 구 ADR-009 D1 해석 순서 | §1 (explicit 선행, global fallback 없음으로 코드 기준 갱신) |
| 구 ADR-009 D1 로컬 증거 `concepts/`·`taxonomy.yaml` | §2 (코드 기준 `settings.json` 하나) |
| 구 ADR-009 D1 bridge `links.yaml` (vault+scope) | §3 (v2 registry 검증, v1은 legacy 읽기 전용) |
| 구 ADR-009 제약 "bridge는 포인터·scope만, 설정·비밀 금지" | §3 |
| 구 ADR-009 D3 `oms link`가 AGENTS.md에 사용법 기록 | §5 |
| 구 ADR-009 D3 설치 시 user-level host 규칙 안내 | 폐기: 이 ADR 범위 밖, 호스트 설치 경로는 → ADR-002 §7 |
| 구 ADR-009 D4 real path identity | §6 |
| 구 ADR-009 D4 `qmd://`는 scheme만 | 폐기: `qmd://` 제거, `oms://`만 처리 (§6) |
| 구 ADR-010 Context 24–27행 fallback 순서 | §1 (global-config fallback 서술 폐기) |
