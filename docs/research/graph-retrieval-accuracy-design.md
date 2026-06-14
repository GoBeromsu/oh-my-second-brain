---
title: "그래프 기반 검색 정확도 설계 리서치 — 엣지 유도 전략 및 ~20k 노트 vault 구현 고려사항"
slug: graph-retrieval-accuracy-design
date: 2026-06-13
type: research
status: active
created_by: claude-code
relates_to:
  - docs/decisions/ADR-005-graph-access-model.md
  - docs/decisions/ADR-002-vector-embedding-backend.md
  - ../../ACKNOWLEDGMENTS.md
---

# 그래프 기반 검색 정확도 설계 리서치 — 엣지 유도 전략 및 ~20k 노트 vault 구현 고려사항

> 목적: 그래프(엔티티+타입 관계) 표현이 RAG/LLM 검색 정확도를 어떻게 높이는지, 그리고 ~20,000 노트 Obsidian vault에서 frontmatter relation / wikilink·backlink / shared tag / semantic similarity로 엣지를 유도할 때의 구현 고려사항을 정리한다.
> 이 문서는 **사실 · 옵션 · 트레이드오프**를 제시하며, 결정을 선언하지 않는다.
> 결정은 [ADR-005](../decisions/ADR-005-graph-access-model.md)에 기록한다.
>
> **출처**: 105-agent / 2.6M-token adversarial deep-research. 각 finding에 찬성(F)/반대(A) vote tally를 병기한다.

---

## Summary

그래프 구조는 RAG 검색에서 lexical/semantic 유사도만으로는 도달할 수 없는 topically-connected 문서를 surface하는 데 실증된 가치를 갖는다(multi-hop associative retrieval). 기존 GraphRAG 구현체(LightRAG, HippoRAG, MS GraphRAG)는 모두 그래프를 raw text에서 LLM 파이프라인으로만 구축하며, Obsidian vault의 wikilink·frontmatter 같은 pre-existing 메타데이터를 native하게 ingest하지 않는다 — 이 gap이 우리 frontmatter-first 전략의 핵심 정당화 근거다. graph 결과와 vector 검색의 RRF(k=60) 융합은 여러 실제 구현에서 지배적 패턴으로 확인됐으며, ADR-002의 결정과 일치한다.

정확도 lift 수치들은 adversarial 검증에서 대거 탈락했다. 메커니즘 설명은 근거가 강하지만, 정밀 수치는 independent reproduction 없이 신뢰할 수 없다.

---

## Background

**연구 질문**: 그래프(엔티티+타입 관계) 표현이 RAG/LLM 검색 정확도를 어떻게 높이는가, 그리고 ~20,000 노트 Obsidian vault에서 frontmatter relation / wikilink·backlink / shared tag / semantic similarity로 엣지를 유도할 때의 구현 고려사항.

주요 참조 구현체:

| 구현체 | 핵심 방식 | 출처 |
|--------|---------|------|
| **HippoRAG** | Personalized PageRank(PPR) over LLM-extracted KG | github.com/osu-nlp-group/hipporag |
| **LightRAG** | dual-level retrieval + graph 추출→profiling→dedup | arxiv.org/abs/2410.05779 |
| **MS GraphRAG** | hierarchical Leiden + community report 사전생성 | arxiv.org/abs/2404.16130 |
| **PathRAG** | flow-based path filtering | arxiv.org/abs/2502.14902 |

---

## Findings

### A. Multi-hop Associative Retrieval (vote: 3-0 확인)

그래프 구조는 relevance 신호를 엔티티-관계 노드로 전파해, lexical/semantic으로는 가깝지 않지만 topically 연결된 문서를 surface한다.

**HippoRAG 메커니즘**: Personalized PageRank(PPR)를 LLM-extracted KG 위에서 실행. MuSiQue, 2WikiMultiHopQA, HotpotQA, LV-Eval에서 vector/BM25 baseline 대비 우수한 결과 보고.

**Spreading activation 메커니즘** (cognitive science 유래):
- heterogeneous KG 엣지를 BFS로 전파
- embedding이 부여한 edge weight 사용
- LLM chain-of-thought graph walking 불필요 → 저비용 multi-hop 경로

> HippoRAG 2는 NaturalQuestions single-hop에서 63.3 F1 vs baseline 61.9로 동등~상회. multi-hop 강화가 single-hop을 해치지 않음을 시사.

Sources: github.com/osu-nlp-group/hipporag, arxiv.org/abs/2502.14802, arxiv.org/pdf/2512.15922, arxiv.org/abs/2503.13804.

---

### B. 기존 시스템은 메타데이터 엣지를 버린다 (vote: 3-0 확인)

LightRAG와 HippoRAG는 모두 그래프를 raw text에서 LLM 파이프라인으로만 구축한다.

| 구현체 | 그래프 구축 방식 | 메타데이터 처리 |
|--------|--------------|--------------|
| **LightRAG** | 추출 → profiling → dedup (`D̂ = Dedupe ∘ Prof(V, E)`) | wikilink/frontmatter 미지원 — GitHub issue에서 unsupported feature request로 취급(2025-08) |
| **HippoRAG** | OpenIE via GPT-4o-mini 또는 Llama-3.3-70B via vLLM | 동일 — pre-existing 메타데이터 native ingest 없음 |

**설계 함의**: Obsidian vault에서 wikilink·frontmatter는 이미 고정밀 엣지다. 이를 typed high-confidence link로 직접 사용하고 semantic-similarity 엣지로 보강하면, LLM 추출 비용을 대폭 절감하면서 gap을 메울 수 있다. 이것이 우리 frontmatter-first 전략의 비용-정당화 근거다.

Sources: arxiv.org/abs/2410.05779, github.com/osu-nlp-group/hipporag.

---

### C. RRF(k=60)가 Graph+Vector 융합의 지배적 패턴 (vote: 3-0 확인)

2025-07 practical-scale GraphRAG 구현에서 1-hop traversal 결과와 dense vector 검색을 RRF k=60으로 병합하는 패턴이 확인됐다.

```
RRF_score(d) = Σ_i  1 / (k + rank_i(d))     k = 60
```

순위 기반이므로 graph score와 vector cosine의 스케일 불일치 문제가 없다.

> ADR-002의 RRF(k=60) 결정과 일치한다. graph traversal 결과까지 동일 융합으로 확장 가능하다.

Source: arxiv.org/pdf/2507.03226.

---

### D. MS GraphRAG — Hierarchical Leiden (vote: architecture 3-0, dynamic-selection 수치 2-1)

MS GraphRAG는 엔티티 그래프를 **hierarchical Leiden**(Traag 2019)으로 분할한다. Louvain이 아님.

| 특성 | 상세 |
|------|------|
| **알고리즘** | Hierarchical Leiden (Traag et al. 2019) |
| **분할 보장** | MECE(mutually exclusive, collectively exhaustive) community partition |
| **community report** | 각 레벨에서 LLM이 사전생성 |
| **static global search** | ≈ 1,500 level-1 reports/query |
| **dynamic community selection** | 루트부터 LLM-rated traversal, irrelevant subtree 전체 prune, relevant이면 자식 재귀 |

Dynamic community selection은 평균 ≈470 reports 처리(69% 감소)와 품질 동등을 AP News 50문항에서 보고. 단, 이 수치는 vote 2-1로 확인됐으므로 1차 paper 재검증 없이 인용하지 말 것.

> Louvain 대비 Leiden의 핵심 차이: well-connected community를 수학적으로 보장. 이는 ADR-005 §4 `oms_graph_cluster`의 Louvain → Leiden 업그레이드 경로에 관련된다.

Sources: arxiv.org/abs/2404.16130, Microsoft Research blog (graphrag-improving-global-search-via-dynamic-community-selection).

---

### E. Scaling 실패모드 — Information Overload (vote: 3-0 확인)

그래프 기반 검색에서 주된 scaling 실패모드는 이웃 지수 팽창이다.

- multi-hop traversal 시 이웃 집합이 지수적으로 팽창해 무관 콘텐츠 대량 유입
- active pruning이 없으면 검색 품질이 급격히 저하

**확인된 pruning 전략**:

| 전략 | 방식 | 출처 |
|------|------|------|
| **PathRAG flow-based** | flow 기반 path filtering으로 저-관련 경로 제거 | arxiv.org/abs/2502.14902 (AAAI 2025) |
| **GraphRAG LLM-rated subtree pruning** | irrelevant subtree 전체 skip | arxiv.org/abs/2404.16130 |
| **Coarse attention pre-filter** | 탐색 전 coarse-grained filtering | arxiv.org/abs/2501.00309 |

**중요 caveat**: graph 증강이 단순 검색을 해치지 않음은 HippoRAG 2에서 확인(NQ single-hop F1 동등~상회). overload는 pruning 없는 deep traversal에서 발생하는 문제다.

Sources: arxiv.org/abs/2501.00309, arxiv.org/abs/2502.14902, arxiv.org/abs/2503.13804.

---

## 신뢰 불가 주장 (adversarial 검증 탈락)

아래 주장들은 adversarial 검증에서 탈락했다. 인용하지 말 것.

| 주장 | Vote | 탈락 이유 |
|------|------|---------|
| LightRAG 84.8% 승률 over NaiveRAG | 0-3 | independent reproduction 없음 |
| LightRAG dual-level retrieval ablation 수치 | 1-2 | 방법론 불명확 |
| LightRAG가 community detection을 회피한다는 주장 | 0-3 | 코드에서 community detection 사용 확인됨 |
| GraphRAG comprehensiveness 72–83% 승률 | 0-3 | 평가 기준 불명확, independent reproduction 없음 |
| Spreading activation 39% 절대 개선 | 0-3 | 측정 조건 미공개 |
| Dynamic community selection 77% 토큰 비용 절감 | 1-2 | AP News 50문항만으로 일반화 불가 |
| Dependency parsing이 LLM 추출의 94% 성능 | 0-3 | 저비용 추출 대안으로 미확인 — 미결 설계 문제로 남음 |
| Hybrid가 vector 대비 15%/4.35% 개선 | 0-3 | 조건·데이터셋 미공개 |
| "standard RAG는 multi-hop 불가" 단정 | 0-3 | 조건부 주장을 절대화한 과장 |
| LLM-extracted KG의 graph fragmentation 수치(GCC 0.309/0.249) | 0-3 | 측정 환경 미재현 |

**일반 caveat**: 정확도 lift 수치는 기계적 메커니즘 설명보다 근거가 약하다. 정밀 수치를 primary paper 재검증 없이 인용하지 말 것.

**분야 이동 속도 caveat**: EcphoryRAG(arXiv 2510.08958)가 이미 HippoRAG를 추월했다고 보고됨(EM 0.474 vs 0.392). 비교 랭킹은 시점 민감 — 최신 paper 확인 필수.

---

## Open Questions

모두 미해결 설계 문제로 분류한다. `TODO(verify)`.

1. **엣지 타입별 가중치 공식** `TODO(verify)`: 개인 vault 그래프에서 이종 엣지 타입(고정밀 wikilink / 저정밀 shared-tag cohesion / 고-recall semantic-similarity)의 최적 가중·정규화 공식은? 각 신호의 marginal 기여에 대한 ablation 근거는? 검증된 closed-form 공식이 소스 내 존재하지 않음 — 미해결 설계 문제.

2. **메타데이터 전용 그래프의 품질 상한** `TODO(verify)`: 메타데이터 유도 그래프(wikilink/frontmatter)가 full LLM OpenIE 추출과 동등한 검색 품질을 내는가? 개인 노트의 sparse·idiosyncratic 특성상 보조 LLM 추출이 필요한가?

3. **PKM-specific 벤치마크 부재** `TODO(verify)`: Obsidian 규모(~20k 노트) 개인 KG 검색 전용 벤치마크/데이터셋이 존재하는가? MuSiQue·2WikiMultiHop 같은 multi-hop QA가 associative·exploratory한 PKM 검색에 transfer되는가?

4. **Consumer 하드웨어 임계점** `TODO(verify)`: dedicated graph DB 없이 Leiden·PPR이 비실용적이 되는 node/edge 임계는? 노트 추가 시 live 그래프 유지를 위한 incremental-update 전략은?

---

## References

| 출처 | 유형 | URL |
|------|------|-----|
| HippoRAG GitHub | primary (code) | github.com/osu-nlp-group/hipporag |
| HippoRAG 2 paper | primary (paper) | arxiv.org/abs/2502.14802 |
| Spreading activation / heterogeneous KG | primary (paper) | arxiv.org/pdf/2512.15922 |
| LightRAG paper | primary (paper) | arxiv.org/abs/2410.05779 |
| MS GraphRAG paper | primary (paper) | arxiv.org/abs/2404.16130 |
| MS GraphRAG dynamic community selection | blog (Microsoft Research) | graphrag-improving-global-search-via-dynamic-community-selection |
| PathRAG (AAAI 2025) | primary (paper) | arxiv.org/abs/2502.14902 |
| Practical-scale GraphRAG / RRF(k=60) | primary (paper) | arxiv.org/pdf/2507.03226 |
| Coarse attention pre-filter | primary (paper) | arxiv.org/abs/2501.00309 |
| HippoRAG 2 (multi+single-hop) | primary (paper) | arxiv.org/abs/2503.13804 |
| EcphoryRAG (benchmark reference) | primary (paper) | arXiv 2510.08958 |
| Leiden algorithm (Traag 2019) | primary (paper) | Traag, Waltman & van Eck, Scientific Reports 2019 |

Cross-links:
- [ACKNOWLEDGMENTS.md](../../ACKNOWLEDGMENTS.md)
- [ADR-005: 그래프 접근 모델](../decisions/ADR-005-graph-access-model.md)
- [ADR-002: 벡터 임베딩 백엔드](../decisions/ADR-002-vector-embedding-backend.md)
