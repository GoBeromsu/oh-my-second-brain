---
slug: ADR-002-config-secrets-host-state-roots
title: "설정·비밀·호스트 상태 루트"
status: Accepted
date: 2026-09-24
created_by: claude
deciders: [beomsu]
supersedes:
  - 구 ADR-004
supersedes_in_part:
  - 구 ADR-012#D2
relates_to:
  - ./ADR-001-vault-resolution-link-note-identity.md
  - ./ADR-003-local-index-storage-and-fusion.md
  - ./ADR-005-embedding-model-contract-integrity-lifecycle.md
  - ./ADR-007-vault-contract-ontology.md
  - ./ADR-009-cross-cutting-principles.md
---

# ADR-002: 설정·비밀·호스트 상태 루트

## Status

Accepted (2026-09-24). 이 주제의 유일한 기준이다. 구 ADR-004 전체와 구 ADR-012 D2 중 설정 위치·env 우선순위 부분을 대체한다.

## Context

OMS는 설정과 상태를 네 곳에 둔다: 볼트 안(`<vault>/.oms/`), 프로젝트 안(`<repo>/.oms/`), 호스트 사용자 설정(XDG config), 호스트 상태·캐시(`~/.oms`, XDG cache). 이 배치를 한 문서로 정한 ADR이 없었고, 구 ADR-004의 계획은 구현과 다르다.

- 구 ADR-004는 전역 설정을 `~/.config/vault-search/config.yml`에, 비밀을 `secrets.env`(0600)에 두라고 했지만, 구현에는 `vault-search` 경로가 없다. 호스트 설정은 `$XDG_CONFIG_HOME/oms/vault.json` 하나뿐이다 (src/kernel/install/connection-registry.ts:226-234, src/kernel/install/pointer.ts:36-46).
- 구 ADR-004는 API key(UPSTAGE/VOYAGE/OPENAI, `OMS_PGVECTOR_URL`)와 `ignore_for_external_apis` glob을 전제했지만, 구현에는 비밀 저장소도 API key 처리도 없다. 비-test src에서 `API_KEY`/`apiKey`/`secrets` 검색 결과가 0건이다. 원격 provider는 구 ADR-012 D2 시점에 제거됐다.
- 구 ADR-004 Tier 3는 프로젝트 `.oms` 마커를 "포인터·권한 선언"으로 정했지만, 구현은 `.oms/links.yaml` v2 connection reference다 (→ ADR-001 §3).
- 구 ADR-004 Tier 2는 `taxonomy.yaml`·`routing-guidelines.md`였지만, 구현은 볼트 안에 `.oms/settings.json`만 두고 폴더 의미를 볼트 밖 봉인된 계약에 둔다 (→ ADR-007, 구 ADR-008 대체).
- 코드에는 ADR에 없던 `~/.oms` 상태 루트(runtime, update notice)가 있다.

## Decision

### 1. 호스트 설정 루트: `$XDG_CONFIG_HOME/oms/vault.json`
`XDG_CONFIG_HOME`이 비어 있으면 `~/.config`을 쓰고, 값은 절대 경로여야 한다(상대 경로는 거부) (src/kernel/install/connection-registry.ts:226-234; src/kernel/install/pointer.ts:36-46). 파일 하나에 두 형식이 있다.
- v1 host vault pointer `{version:1, vault, signature}`. signature는 도메인 `oms-host-vault-pointer`에 대한 sha256이다 (src/kernel/install/pointer.ts:6-8, 49). `oms host install|remove|sync|status`가 사용한다 (src/cli/host-commands.ts).
- v2 connection registry(`REGISTRY_VERSION = 2`)는 bridge 검증에 쓰인다 (src/kernel/install/connection-registry.ts:10-12; → ADR-001 §3). v1 레코드는 `migrateHostVaultPointer`로 v2로 옮긴다 (src/kernel/install/connection-registry.ts:934).
- 이 파일은 볼트 해석의 fallback이 아니다 (→ ADR-001 §1).

### 2. 호스트 runtime 상태 루트: `~/.oms/runtime/v1`
`OMS_RUNTIME_ROOT`로 바꿀 수 있고 절대 경로여야 한다 (src/kernel/install/connection-registry.ts:236-241). 하위에 `connection-reservations/v1`, `connection-updates/v1`을 둔다 (src/kernel/install/connection-registry.ts:373, 669). event journal도 같은 루트를 쓴다 (src/kernel/runtime/event-journal.ts:141-143).

### 3. Update notice 상태: `~/.oms`
cache 파일은 `OMS_AUTO_UPDATE_STATE_DIR`이 있으면 그 아래, 없으면 `~/.oms` 아래에 둔다 (src/mcp/update-notice.ts:64-69). `OMS_UPDATE_NOTICE=0` 또는 `OMS_NO_UPDATE_NOTICE=1`이면 끈다 (src/mcp/update-notice.ts:60-62; src/cli/update-notice.ts:26).

### 4. 호스트 캐시 루트: `$XDG_CACHE_HOME` 또는 `~/.cache`
- 모델 artifact와 host-local receipt `installed-models.json`은 `<cache>/oms/models`에 둔다 (src/kernel/engine/embed/model.ts:22, 501-505, 509). 모델 세부 → ADR-005.
- 볼트별 인덱스 캐시의 base도 같은 규칙이다. 단, 상대 경로인 `XDG_CACHE_HOME`은 무시한다 (src/kernel/engine/paths.ts:70-76). 저장 구조 → ADR-003.

### 5. 볼트 내 설정 `<vault>/.oms/` (portable)
볼트에 들어가는 설정은 볼트와 함께 이동하며 호스트 절대 경로를 담지 않는다.
- 볼트 안의 OMS 파일은 `settings.json` 하나다 (src/kernel/vault/settings.ts:8, 25). 키는 `version`(1), `vaultId`(소문자 UUID), `templateFolder`(정규 볼트 상대 폴더), `embedding.model`, `agentRepair`뿐이며 모르는 키는 거부한다 (src/kernel/vault/settings.ts:9-18, 28, 57-86).
- 쓰기는 `publishVaultSettings`가 control path를 검증한 뒤 원자적으로 쓰고 다시 읽어 확인한다 (src/kernel/install/vault-settings-publish.ts:6-15).
- 봉인된 계약(폴더·속성·템플릿)은 볼트 밖 `~/.oms/vaults/<id>`에 있다 (src/kernel/contract/store.ts:12-17). 계약 내용 → ADR-007.
- `.oms/`의 다른 항목은 읽지 않는다. `oms contract doctor`가 예상하지 않은 제어 파일로 보고할 뿐이다 (src/kernel/contract/status.ts:86-100).

프로젝트 `<repo>/.oms/links.yaml`은 참조와 scope만 담는다 (→ ADR-001 §3).

### 6. 모델 설정 우선순위 (설정 층위만)
capability(embed/rerank/generate)마다 request → 완전한 env 쌍 → 볼트 `.oms/settings.json`의 `embedding.model`(embed만) → setup default(receipt) → unavailable 순으로 고른다 (src/kernel/engine/embed/config.ts:352-388). 볼트 값은 `readVaultEmbeddingModel`/`readVaultEmbeddingModelSync`가 읽는다 (src/kernel/engine/embed/config.ts:39-54). env 쌍은 `OMS_EMBEDDING_*`, `OMS_RERANK_*`, `OMS_GENERATE_*`의 `PROVIDER`/`MODEL`이다 (src/kernel/engine/embed/config.ts:55-59). `OMS_MODEL_PATH` alias는 없다 (src/kernel/engine/README.md:13-14). fail-closed·identity·lineage는 → ADR-005.

### 7. 호스트 에이전트 홈과 주입
- 에이전트 홈 디렉터리는 `OMS_CLAUDE_HOME`/`OMS_CODEX_HOME`/`OMS_HERMES_HOME`으로 바꿀 수 있다. 기본값은 `~/.claude`/`~/.codex`/`~/.hermes`다 (src/kernel/install/common.ts:31-34; src/vendors/claude/claude.ts:256, src/vendors/codex/codex.ts:295, src/vendors/hermes/hermes.ts:193).
- 설치 시 볼트 경로는 설정 파일이 아니라 hook의 `OMS_VAULT=`/`OMS_AGENT_VAULT=` 할당 (src/vendors/claude/claude-hooks.ts:27-39)과 MCP 인자 `serve mcp --vault <vault>` (src/kernel/install/common.ts:36-37)로 주입한다.
- guard를 끄는 환경 변수는 없다. `oms hook pre`는 볼트 안 쓰기를 항상 판정자에게 보낸다 (→ ADR-007).

### 8. 비밀과 권한
- OMS는 비밀(API key 등)을 저장하거나 읽지 않는다. 비밀 파일도 없다.
- 호스트 설정·runtime 디렉터리는 0700, 파일과 lock owner는 0600으로 만든다 (src/kernel/install/pointer.ts:60-65; src/kernel/install/connection-registry.ts:321, 586-587, 642-647).

### 9. 오류 표현
경로 검증 실패의 반환·예외 규칙은 → ADR-009.

### 미결
- v1 pointer와 v2 registry가 같은 `vault.json`을 공유하는 상태가 최종인지, v1 경로(pointer.ts)를 없앨지 정해지지 않았다.
- `~/.oms`(상태)와 `~/.config/oms`(설정)가 XDG state(`$XDG_STATE_HOME`)를 쓰지 않는 점을 의도로 확정할지 기록이 없다.
- 원격 provider가 다시 도입되면 비밀 저장 위치를 새로 정해야 한다. 현재는 해당 코드가 없다.
- `OMS_NON_INTERACTIVE`, `OMS_TYPE_AFFINITY_UNBOUNDED`, `OMS_UPDATE_LATEST_VERSION` 등 동작 스위치 env 목록을 공개 계약으로 둘지 정해지지 않았다.

## Alternatives Considered

- **`~/.config/vault-search/config.yml` + `secrets.env`** (구 ADR-004): 원격 API provider가 없어 비밀을 둘 대상이 없다. 이름도 제품명과 맞지 않아 구현되지 않았다.
- **볼트 안에 전역 설정 두기**: 볼트를 찾기 전에 설정을 읽어야 하는 bootstrap 순환이 생긴다. 구 ADR-004의 기각 사유를 유지한다.
- **프로젝트 마커에 설정 두기**: 커밋되는 파일에 호스트 경로·비밀이 섞인다. 그래서 참조만 둔다 (→ ADR-001).
- **env만으로 설정**: 호스트 등록(connection registry)과 원자적 갱신을 표현할 수 없다. env는 override로만 쓴다.

## Consequences

- 볼트를 다른 호스트로 옮겨도 `.oms/` 설정은 그대로 유효하다. 호스트 경로와 모델 artifact 위치는 호스트 쪽 파일에만 있다.
- 호스트 상태를 지우면 `~/.config/oms`, `~/.oms`, `~/.cache/oms` 세 곳이 초기화 대상이다.
- 테스트와 격리 실행은 `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `OMS_RUNTIME_ROOT`, `OMS_*_HOME`, `OMS_AUTO_UPDATE_STATE_DIR`로 모든 루트를 바꿀 수 있다.
- 비밀 관리가 없으므로 원격 모델 provider를 추가하려면 먼저 새 ADR이 필요하다.

## 흡수 내역

| 기존 ADR 조항 | 이 ADR |
|---|---|
| 구 ADR-004 Tier 1 `~/.config/vault-search/config.yml` | §1 (실제 `$XDG_CONFIG_HOME/oms/vault.json`) |
| 구 ADR-004 Tier 1 `secrets.env`, API key, `OMS_PGVECTOR_URL` | 폐기: 원격 provider·pgvector 코드 없음 (§8) |
| 구 ADR-004 `ignore_for_external_apis` | 폐기: 외부 API 호출 경로 없음 |
| 구 ADR-004 Tier 2 볼트 설정(`taxonomy.yaml`, `routing-guidelines.md`) | 폐기: 볼트 안 파일은 `settings.json` 하나 (§5), 폴더 의미는 봉인된 계약 (→ ADR-007) |
| 구 ADR-004 Tier 3 프로젝트 마커 = 포인터·권한 | §5, → ADR-001 §3 (v2 reference) |
| 구 ADR-004 기각안(볼트 내 전역 설정, 마커 내 설정, env 단독) | Alternatives Considered |
| 구 ADR-012 D2 해석 순서·env 쌍 | §6 |
| 구 ADR-012 D2 fail-closed, 로컬 GGUF 한정 | → ADR-005 |
| 구 ADR-012 D1 receipt는 host cache | §4 (위치만, 내용 → ADR-005) |
| (공백) `~/.oms` runtime·update notice 루트 | §2, §3 |
