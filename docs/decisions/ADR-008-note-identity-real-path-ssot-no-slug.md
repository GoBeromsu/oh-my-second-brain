---
title: 노트 식별자 모델 — 실경로 SSOT, 슬러그 비도입 (display-decoded by construction)
status: Accepted
date: 2026-06-14
created_by: claude-code
deciders: [beomsu]
relates_to:
  - docs/decisions/ADR-003-oms-vault-convention-asset.md
  - docs/decisions/ADR-007-no-fake-embedder-fallback-native-dim-integrity.md
  - src/engine/tracer.ts (walkMd → path.relative)
  - docs/exec-plan/active/self-owned-second-brain/plan.md §Principle 3 (Parity-or-Better before Swap)
---

# ADR 0008: 노트 식별자 모델 — 실경로 SSOT, 슬러그 비도입

## Status

Accepted

## Context

#8 골든셋 parity 게이트 구축 중, 회귀 층(qmd)을 relevance oracle로 쓰면서 **qmd의 경로 포맷이 슬러그화(slugified)**되어 있음이 드러났다.

- qmd `file` 필드는 `obsidian/` 프리픽스 + 세그먼트별 `[^A-Za-z0-9가-힣]+` 런(run)을 단일 하이픈으로 접은 형태다.
  - 디스크 `50. AI/02 Terminologies/Encoder-Decoder Models.md` → qmd `obsidian/50-AI/02-Terminologies/Encoder-Decoder-Models.md`
  - 디스크 `…/제텔카스텐 메모법 종류(임시메모, 문헌메모, 영구메모)와 사용 목적.md` → qmd `…/제텔카스텐-메모법-종류-임시메모-문헌메모-영구메모-와-사용-목적.md`
- qmd가 이렇게 하는 건 **공백/구두점으로 인한 식별자 이슈를 회피**하려는 의도적 설계로 판단된다.

여기서 oms 신규 엔진이 동일한 슬러그 계층을 도입해야 하는가 하는 식별자(identity)·표시(display) 모델 결정이 발생했다.

**관찰된 사실:**

1. **슬러그는 손실적(lossy)이다.** `Encoder-Decoder-Models`는 `Encoder-Decoder Models` / `Encoder Decoder Models` 중 무엇인지 유일하게 복원할 수 없다. 슬러그→실경로 역변환은 본질적으로 모호하며, 디코딩하려면 결국 **실경로를 별도로 저장**해야 한다. 그 순간 슬러그를 정식 ID로 쓸 이유가 사라진다.
2. **oms엔 qmd가 풀려던 문제가 없다.** 신규 엔진(`src/engine/tracer.ts`)은 `walkMd → path.relative`로 **실제 경로(공백·괄호·한글 원문 그대로)**를 docPath로 저장한다. SQLite는 공백 TEXT 키를 문제없이 다루고, FTS5는 식별자가 아닌 본문을 토크나이즈하므로 저장 정확성을 위해 슬러그화가 필요하지 않다.
3. **표시는 이미 디코딩된 상태다.** 엔진이 실경로를 그대로 반환하므로 별도 디코딩 단계 없이 사람이 읽는 이름(공백 포함)이 그대로 나온다. 슬러그는 **qmd 내부 산물일 뿐** 우리 결과에 유출되지 않는다.

## Decision

**노트 식별자는 실제 경로(real path)를 정식 SSOT로 삼는다. 엔진에 슬러그 계층을 도입하지 않는다.**

### P — 실경로 SSOT, 슬러그 비도입

- **정식 식별자 = 실제 vault-상대 경로**(공백·괄호·한글 등 원문 그대로). 저장값과 표시값이 동일하다 → "표시는 디코딩"이 **구성상(by construction)** 충족된다. 별도 인코딩/디코딩 단계 없음.
- **엔진은 슬러그를 저장하지 않는다.** qmd식 슬러그-as-ID(손실적 + 역변환 위해 실경로 재저장 필요 → 무이득)는 채택하지 않는다.
- **qmd 연동 경계의 디코딩만 수행한다.** 회귀 층 비교·골든셋 정답 채굴 시 qmd 슬러그는 `slug(실경로)→실경로` 전방(forward) 맵으로 매칭 키로만 잠깐 쓰고 즉시 실경로로 환원한다. 사용자 보고·골든셋·MCP 반환값은 항상 실경로.
- **미래 확장(비파괴):** URL 라우팅·외부 연동 등 공백-안전 핸들이 실제로 필요한 소비자가 생기면, 슬러그를 **실경로에서 파생한 비정식(non-canonical) 필드**로 추가한다. 실경로가 보존되므로 디코딩은 무손실 조회가 된다. SSOT는 영원히 실경로다.

## Consequences

**긍정적 결과:**

- **무손실 식별자:** 실경로가 SSOT이므로 정보 손실·역변환 모호성이 원천 차단된다.
- **단순성(YAGNI):** 슬러그 동기화·역매핑 테이블·디코딩 계층이 불필요하다. 엔진 현 동작이 이미 정답이므로 **코드 변경이 없다**.
- **표시 정확성:** 결과·wikilink 해소·Obsidian 표시 모두 원문 이름을 그대로 쓴다.
- **확장 경로 명확:** 슬러그가 필요해지면 파생 필드로 비파괴 추가하는 단일 규칙만 따르면 된다.

**트레이드오프 및 제약:**

- 외부 시스템(qmd 등)과 docid를 공유하지 않는다. 상호운용 시 매번 `slug(실경로)→실경로` 전방 매칭이 필요하다(연동 경계 한정, 손실 없음).
- 공백·구두점이 포함된 경로를 셸/외부 API에 넘길 때는 호출부에서 적절히 인용/이스케이프해야 한다(식별자를 망가뜨리는 대신 호출부에서 처리).

## Links

- [ADR-003 oms Vault Convention Asset](./ADR-003-oms-vault-convention-asset.md) — vault 경로·컨벤션 자산
- [ADR-007 임베딩 무결성 불변](./ADR-007-no-fake-embedder-fallback-native-dim-integrity.md) — 자매 불변(네이티브 차원 무결성: no-projection). 본 ADR은 식별자 차원의 무손실 원칙
- `src/engine/tracer.ts` `walkMd → path.relative` — 실경로를 docPath로 저장하는 SSOT 구현 지점
- [plan.md §Principle 3 — Parity-or-Better before Swap](../exec-plan/active/self-owned-second-brain/plan.md) — #8 골든셋 parity 게이트 맥락(슬러그 발견 계기)
