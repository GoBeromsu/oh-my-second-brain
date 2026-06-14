---
slug: ADR-004-config-secrets-access-topology
title: "Config · Secrets · Access Topology — 3-tier global/vault/per-repo 구성"
status: Proposed
date: 2026-06-13
created_by: claude-code
deciders: [beomsu]
relates_to:
  - ../exec-plan/active/self-owned-second-brain/spec.md §11
  - ./ADR-002-vector-embedding-backend.md
  - ./ADR-003-oms-vault-convention-asset.md
---

# ADR-004: Config · Secrets · Access Topology — 3-tier global/vault/per-repo 구성

## Status

Proposed

## Date

2026-06-13

## Context

엔진이 여러 작업 폴더(cwd)에서 동작하며 단일 Obsidian vault를 서비스한다. 설정과 시크릿을 어디에 두어야 하는지가 명확하지 않으면 다음 문제가 발생한다:

- **순환 의존**: vault 안에 설정 파일을 두면, 설정 파일 자신이 vault 경로를 선언하게 된다. 엔진을 시작하려면 vault를 먼저 알아야 하고, vault를 알려면 설정 파일을 읽어야 한다.
- **시크릿 노출 위험**: vault가 외부에 공개되거나 백업될 때 API 키가 함께 유출될 수 있다.
- **분산 관리**: `.oms` 마커가 설정을 담으면 각 repo마다 중복 설정이 필요하고 중앙 관리가 불가능하다.
- **민감 정보 산포**: 주소·연락처 등이 노트 곳곳에 흩어지면 `ignore_for_external_apis` glob으로 제외하기 어렵다.

qmd와 gbrain은 모두 단일 config 위치를 사용한다([ACKNOWLEDGMENTS.md](../../ACKNOWLEDGMENTS.md) 참조). 우리 엔진도 같은 원칙을 따라야 한다.

ADR-003의 vault-convention 자산(taxonomy.yaml, routing guideline)과 이 ADR의 경계를 명확히 구분해야 한다. vault 내 ontology는 vault-specific 의미이며 엔진 설정이 아니다.

## Decision

설정·시크릿·접근 권한을 **3-tier**로 분리한다.

### Tier 1 — Global Engine Config + Secrets (`~/.config/vault-search/`)

```
~/.config/vault-search/
  config.yml       # 엔진 전역 설정 (git-ignored)
  secrets.env      # API 키 등 시크릿 (git-ignored, 파일 권한 0600)
```

**`config.yml` 보유 항목**:

- `OMS_VAULT`: vault 절대 경로
- `embedder`: 선택된 임베더 tier 및 모델명
- `model_paths`: 로컬 GGUF 모델 경로
- HNSW 파라미터 override
- `ignore_for_external_apis`: 외부 임베딩 API 제외 glob 목록

**`secrets.env` 보유 항목**:

- `UPSTAGE_API_KEY`, `VOYAGE_API_KEY`, `OPENAI_API_KEY` 등 외부 API 키
- `OMS_PGVECTOR_URL` (Supabase 선택 시)

**채택 이유**:

- cwd-독립: 어느 작업 폴더에서 Claude Code를 실행해도 동일 vault에 접근 가능
- vault가 하나인 스케일에서 install-once로 충분
- vault 경로가 vault 밖에 있으므로 부트스트랩 역설이 없다
- qmd/gbrain의 단일 config 위치 패턴과 일치

**민감 개인정보 집중화 원칙**:

주소·연락처 등 민감 개인정보는 vault 내 **단일 지점**(예: `70. People/` 내 전용 people-note 또는 별도 secrets vault note)에 집중하고, 다른 노트에서는 placeholder만 참조한다. `ignore_for_external_apis` glob이 해당 경로를 **청킹 이전 단계**에서 제외한다. glob은 `config.yml`에 정의하며, 이 경로의 내용은 어떤 외부 API에도 전송되지 않는다.

### Tier 2 — Vault-Resident Ontology · Convention

vault와 함께 이동하는 파일. 엔진 설정이 아니라 vault-specific 의미를 담는다.

```
<vault>/.oms/
  taxonomy.yaml          # vault 폴더 온톨로지 default (ADR-003)
  routing-guidelines.md  # 노트 라우팅 가이드 (vault 특화)
```

이 파일은 사용자가 vault를 다른 머신으로 이전할 때 함께 이동해야 하는 vault 고유 자산이다. Tier 1의 `config.yml`과 내용이 겹치지 않는다.

### Tier 3 — Per-Repo `.oms` Marker

```
<working-repo>/.oms      # 포인터 + 권한 선언만. 데이터·설정 없음.
```

이 마커는 다음만 선언한다:

- 이 작업 폴더의 에이전트가 전역 MCP를 통해 second brain을 CRUD할 수 있다는 권한
- 선택적으로 컬렉션(collection) 범위 지정

설정값, 시크릿, vault 경로를 담지 않는다. 마커의 존재 자체가 권한 선언이다(spec §11 연결).

## Alternatives considered

### (A) Vault-resident 전역 설정 — 기각

vault 루트 또는 `<vault>/.oms/config.yml`에 전역 설정을 두는 방식. 순환 의존 발생: 설정 파일이 자신을 담은 vault 경로를 선언해야 한다. 엔진 초기화 시 vault를 먼저 열어야 설정을 읽을 수 있고, 설정을 읽어야 vault를 알 수 있다는 부트스트랩 역설이 생긴다. 기각.

### (B) `.oms` 마커에 설정 포함 — 기각

각 repo의 `.oms`에 embedder 선택, API 키 등을 두는 방식. 여러 repo마다 중복 관리가 필요하고, 키 노출 위험이 각 repo로 분산된다. vault 하나에 여러 cwd가 붙는 스케일에서 과도하다. 기각.

### (C) 환경변수만 사용 — 기각

`~/.zshrc`에 모든 설정을 env로 주입하는 방식. shell 세션 밖(cron, GUI 실행 등)에서는 접근이 안 된다. 설정 히스토리 관리 불가. 기각.

## Consequences

### Enables

- cwd-독립 엔진 접근: 어느 폴더에서나 동일 vault에 연결
- install-once 설정: 엔진 설치 한 번으로 모든 작업 폴더에 적용
- 순환 의존 해소: vault 경로가 vault 밖에 있으므로 부트스트랩 역설 없음
- 시크릿 집중: API 키가 `~/.config/vault-search/secrets.env` 단일 파일에만 존재
- vault 이동성: Tier 2 파일이 vault와 함께 이동하므로 vault 이전 시 convention 손실 없음

### Costs / trade-offs

- 새 사용자가 `~/.config/vault-search/`를 초기 설정해야 함 (`vault-init` 스킬이 scaffold 담당)
- 머신이 바뀌면 Tier 1 설정을 재설치해야 함 (dotfiles에 포함하여 완화 가능)
- `config.yml`과 vault 내 Tier 2 파일 사이의 경계를 팀 전체가 인지하고 유지해야 함

### New constraints

- 모든 외부 API 키는 `secrets.env`에만 저장한다. vault 노트나 `.oms` 마커에 API 키를 기록하지 않는다.
- `ignore_for_external_apis` glob은 `config.yml`에 정의한다. 청킹 이전 단계에서 검사한다.
- Tier 3 `.oms` 마커는 포인터·권한 선언만 담는다. 설정값 추가가 필요하다면 이 ADR을 supersede하는 새 ADR을 작성한다.
