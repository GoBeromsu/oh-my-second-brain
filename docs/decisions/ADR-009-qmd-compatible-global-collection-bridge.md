---
slug: ADR-009-qmd-compatible-global-collection-bridge
title: "qmd-호환 전역 컬렉션 브릿지 — link 기반 vault 해석과 product interface 계약"
status: Superseded
superseded_by: ./ADR-010-search-backend-seam-qmd-optional.md
date: 2026-07-05
created_by: gjc
deciders: [beomsu]
relates_to:
  - ./ADR-004-config-secrets-access-topology.md
  - ./ADR-008-note-identity-real-path-ssot-no-slug.md
  - ../exec-plan/archived/self-owned-second-brain/deep-interview-record.md
---

# ADR-009: qmd-호환 전역 컬렉션 브릿지 — link 기반 vault 해석과 product interface 계약

## Status

Superseded by [ADR-010](./ADR-010-search-backend-seam-qmd-optional.md) on 2026-08-24.

This ADR is superseded only in part. **D1, D3, and D4 remain in force. D2 is
retired. D5 is retired insofar as it requires parity for the D2 qmd-compatible
aliases and `qmd://` resource.** The `superseded_by` frontmatter field is a
deliberate extension to this repository's ADR frontmatter schema; it records
the successor ADR without making a reader infer that every decision in this
record is dead.

## Context

OMS는 knowledge-management 엔진이고, 여러 외부 repo·host adapter에서 같은 Obsidian vault를 질의해야 한다. qmd는 사용자가 검증한 "어느 작업 폴더에서든 collection을 질의하는" 인터페이스 기준선이다. 다만 OMS는 qmd 런타임에 의존하지 않고, qmd의 좋은 product surface만 자체 엔진 위에 흡수한다.

이미 선행 ADR이 두 축을 고정했다.

- [ADR-004](./ADR-004-config-secrets-access-topology.md)는 config/secrets/access topology를 분리하고, repo별 `.oms`는 설정 저장소가 아니라 pointer/권한 선언만 담당한다고 정했다.
- [ADR-008](./ADR-008-note-identity-real-path-ssot-no-slug.md)은 qmd식 slug를 canonical identity로 도입하지 않고, document identity의 SSOT를 vault-relative real path로 유지한다고 정했다.

2026-07-05 deep-interview(`di-20260705-harness-skill-governance`)는 이 결정을 실행 기준으로 재확인했다.

- Established Fact #3 / Round 1: oms-query-bridge는 tobi/qmd 인터페이스 패턴을 채택한다 — 단일 엔진 위 CLI+MCP, 분산 흐름 통합.
- Established Fact #17 / Round 7: bridge 수용 기준은 **link 기반, upstream 그대로**이며 신규 query 엔진을 개발하지 않는다.
- Established Fact #18 / Round 7: `oms link`는 프로젝트 host convention 파일(`AGENTS.md` 등)에 사용법을 자동 기입한다. `oms install`의 전역 안내는 사용자 레벨 host rules(`~/.codex/rules/oms.md` 등)가 담당한다.
- Non-Goal #1: qmd 전역 collection registry 신규 개발은 비목표다. link 기반으로 충분하며 필요 시 후속 결정으로 분리한다.
- Acceptance Criteria §oms-query-bridge: vault 밖 외부 repo에서 `oms link --vault <vault>` 1회 후 `oms query/search/get`과 MCP query/get이 그 vault로 동작해야 한다.

따라서 "qmd와 비슷하게 보이는 표면"이 단순한 우발적 alias인지, 아니면 사용자·adapter가 의존해도 되는 공식 product interface인지 명시해야 한다.

## Decision

### D1 — Vault 해석은 link 기반 `resolveEffectiveVault` 경로가 공식이다

OMS가 명시적 `--vault` 없이 vault를 해석할 때의 공식 순서는 다음이다.

1. **vault `.oms/`**: 현재 작업 디렉터리가 vault 자체이고 `.oms/concepts/` 또는 `.oms/taxonomy.yaml`을 가진 경우 그 디렉터리를 vault로 본다.
2. **bridge `.oms/links.yaml`**: 외부 repo의 `.oms/links.yaml`이 `vault`와 선택적 `scope`를 선언하면, 해당 vault와 scope를 사용한다.
3. **`OMS_VAULT`**: local vault/bridge가 없으면 환경변수 vault를 사용한다.
4. **`cwd` fallback**: 아무 단서도 없으면 현재 작업 디렉터리를 vault로 취급한다.

이 순서는 `resolveEffectiveVault`의 product contract다. qmd식 전역 collection registry를 별도로 만들지 않는다. 외부 repo는 `oms link --vault <vault>`로 bridge를 생성하고, bridge는 config/secrets를 복제하지 않으며 vault real path와 scope만 가진다.

### D2 — qmd-호환 CLI/MCP 표면은 공식 product interface다 **[retired by ADR-010]**

다음 표면은 우발적 compatibility가 아니라 문서화된 product interface다.

- CLI: `oms query`, `oms search`, `oms vsearch`, `oms get`, `oms multi-get` 등 `oms semantic ...`의 qmd-호환 top-level alias.
- MCP: `query`, `status`, `get`, `multi_get` qmd-호환 alias와 canonical `oms_semantic_*` / `oms_*_document(s)` tools.
- MCP resource: `qmd://{path}` document resource.

OMS는 qmd binary를 요구하지 않는다. 위 표면은 native OMS engine/core document adapter로 동작하며, embedding model이 없는 document read 경로도 file-based hydration으로 유지한다. 이름이 qmd-compatible이어도 backend와 ownership은 OMS다.

### D3 — link는 프로젝트 convention 파일에 bridge 사용법을 자동 기입한다

`oms link`는 외부 repo에 bridge를 생성할 때 host adapter가 사용하는 프로젝트 convention 파일(`AGENTS.md` 등)에 OMS bridge 사용법 섹션을 자동 기입한다. 이는 사용 중인 repo가 자기 convention 안에 OMS bridge 사용법을 설명하는 ouroboros 패턴이다.

`oms install`은 사용자 레벨 설치 작업이므로 대상 프로젝트의 `AGENTS.md` 존재를 전제할 수 없다. 따라서 install-time 전역 안내는 기존 host rules(예: `~/.codex/rules/oms.md`, Claude/Hermes의 사용자 레벨 규칙 파일)가 담당하고, D3의 프로젝트 파일 자동 기입 범위에는 포함하지 않는다.

이 ADR은 product contract를 고정한다. 기입 내용은 generic해야 하며 특정 사용자 계정, 절대 개인 경로, 비밀값을 포함하지 않는다.

### D4 — Document identity는 ADR-008의 real path SSOT를 계승한다

qmd-compatible 표면을 제공해도 document identity는 변하지 않는다.

- canonical document id는 vault-relative real path다.
- `qmd://`는 resource URI scheme일 뿐 slug identity 계층이 아니다.
- qmd slug와 호환해야 하는 경계가 생기면 ADR-008처럼 `slug(real path) → real path` forward map으로만 처리하고, 사용자·MCP 반환값은 real path를 유지한다.

### D5 — Adapter parity는 의무다 **[retired with D2 by ADR-010]**

qmd-compatible CLI/MCP alias와 `qmd://` resource 의미론을 변경할 때는 core 구현만 바꾸지 않는다. Claude Code, Codex, Hermes 등 host adapter 문서·skills·manifest·tests가 같은 의미론을 노출해야 하며, 변경 PR은 ADR-009 영향과 adapter parity 갱신 여부를 함께 다룬다.

## Alternatives Considered

### (A) qmd 전역 collection registry 신규 구현 — 기각

qmd의 collection registry를 그대로 재구현하면 외부 repo에서 collection 이름으로 질의하는 경험은 얻지만, OMS의 기존 `oms link` bridge와 중복된다. deep-interview는 qmd 전역 collection registry를 non-goal로 두고 link 기반 수용 기준을 채택했다. 현재 scale에서는 `.oms/links.yaml` + scope가 더 단순하고 검증 가능하다.

### (B) `OMS_VAULT`만 공식 경로로 유지 — 기각

환경변수만으로도 cwd-independent 실행은 가능하지만, repo별 bridge/scope와 host convention 자동 안내를 표현하지 못한다. 외부 repo에서 한 번 link하고 이후 CLI/MCP가 자연스럽게 같은 vault를 쓰는 qmd급 사용감에 미달한다.

### (C) qmd-compatible alias를 best-effort 별칭으로만 취급 — 기각

alias를 우발적 편의로 두면 adapter 문서, MCP clients, 사용자 scripts가 안정적으로 의존할 수 없다. qmd 호환 표면은 이미 deep-interview acceptance criteria의 일부이므로 product interface로 고정한다.

### (D) qmd slug를 OMS document id로 채택 — 기각

ADR-008의 결정을 유지한다. qmd slug는 손실적이며 real path를 별도로 보존해야만 복원된다. OMS는 real path SSOT를 유지하고, `qmd://`는 호환 scheme으로만 제공한다.

## Consequences

### Enables

- 외부 repo에서 `oms link --vault <vault>` 1회 후 OMS CLI/MCP가 같은 vault로 해석된다.
- ADR-004의 config/access topology와 ADR-008의 real-path identity가 충돌 없이 연결된다.

### Costs / trade-offs

- `resolveEffectiveVault` 순서가 product contract가 되므로 fallback 순서 변경은 breaking change로 취급해야 한다.
- qmd 전역 collection registry를 원하는 미래 요구가 생기면 새 ADR/마이그레이션으로 별도 설계해야 한다.

### New constraints

- bridge `.oms/links.yaml`에는 vault pointer와 scope만 둔다. config/secrets/ontology를 복제하지 않는다.
- document identity는 real path SSOT다. slug를 canonical id로 승격하지 않는다.

## Supersession scope

- **D1 remains in force.** `resolveEffectiveVault` keeps link-based vault
  resolution as the official path for the verified-target write kernel. The
  implementation still resolves local vault, bridge `.oms/links.yaml`, and
  `OMS_VAULT` before its later global-config and cwd fallbacks.
- **D2 is retired.** The qmd-compatible CLI/MCP aliases and `qmd://` resource
  are removed; they are no longer an OMS product interface.
- **D3 remains in force.** `oms link` still writes its managed bridge usage
  section to a project `AGENTS.md`; install-time host guidance remains
  user-level.
- **D4 remains in force.** ADR-008's vault-relative real-path document
  identity remains canonical. The retired `qmd://` scheme no longer supplies a
  URI boundary, but it does not change the real-path SSOT.
- **D5 is retired with D2.** Its parity obligation was specifically for the
  removed aliases and resource. It creates no continuing requirement for those
  surfaces.
