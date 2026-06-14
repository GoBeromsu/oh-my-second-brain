---
slug: hnsw-paper-malkov-yashunin
source_url: https://arxiv.org/abs/1603.09320
captured_date: 2026-06-13
original_title: "Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs"
source_type: paper
status: active
created_by: claude-code
type: references
---

<!--
PURPOSE: Verbatim static archive of an external document, converted to markdown.
This file is a snapshot of the SOURCE CONTENT — raw and unedited.
Do NOT add your own synthesis, commentary, or conclusions here.
Your synthesis belongs in a research file (docs/research/{slug}.md).

Capture workflow:
1. Convert the external source to markdown (paste, convert tool, or manual transcription).
2. Preserve all headings, lists, code blocks, and tables exactly as in the source.
3. Do not paraphrase, summarize, or annotate — only fix markdown rendering issues.
4. Commit this file immediately after capture; never edit the body afterward.
-->

> **VERBATIM SNAPSHOT** — Source: https://arxiv.org/abs/1603.09320  
> Captured: 2026-06-13. Do NOT edit after capture.

---

<!-- ================================================================
     캡처자 노트 — 본문 verbatim 블록과 분리
     ================================================================ -->

> **캡처자 노트** (claude-code, 본문 밖)
>
> 원 논문 전체 텍스트(PDF)는 이 파일에 포함하지 않음. arXiv 초록 페이지에서 접근 가능한
> verbatim 텍스트(제목, 저자, 초록, 메타데이터)만 수록.
>
> **정식 인용**:  
> Yu. A. Malkov, D. A. Yashunin, "Efficient and robust approximate nearest neighbor search  
> using Hierarchical Navigable Small World graphs," *IEEE Transactions on Pattern Analysis  
> and Machine Intelligence*, vol. 42, no. 4, pp. 824–836, 2020.  
> arXiv:1603.09320 [cs.DS]. DOI: https://doi.org/10.48550/arXiv.1603.09320
>
> **핵심 알고리즘 파라미터** (초록 및 일반 HNSW 문헌 기준):
> - `M`: 레이어별 최대 연결 수 (max connections per layer)
> - `efConstruction`: 그래프 구성 시 동적 후보 리스트 크기
> - 복잡도: 초록에서 "logarithmic complexity scaling" 명시
> - 레이어 배정: "exponentially decaying probability distribution"으로 결정

---

<!-- ================================================================
     PASTE OR TRANSCRIBE THE SOURCE DOCUMENT VERBATIM BELOW THIS LINE
     ================================================================ -->

## Bibliographic Information

**Title:** Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs

**Authors:** Yu. A. Malkov, D. A. Yashunin

**Submitted:** 30 Mar 2016 (v1)  
**Last revised:** 14 Aug 2018 (v4)

**arXiv:** 1603.09320 [cs.DS]  
**DOI:** https://doi.org/10.48550/arXiv.1603.09320

**Subject Classifications:**
- Data Structures and Algorithms (cs.DS)
- Computer Vision and Pattern Recognition (cs.CV)
- Information Retrieval (cs.IR)
- Social and Information Networks (cs.SI)

**Comments:** 13 pages, 15 figures

**Journal reference:** IEEE Transactions on Pattern Analysis and Machine Intelligence, 2018

---

## Abstract

We present a new approach for the approximate K-nearest neighbor search based on navigable small world graphs with controllable hierarchy (Hierarchical NSW, HNSW). The proposed solution is fully graph-based, without any need for additional search structures, which are typically used at the coarse search stage of the most proximity graph techniques. Hierarchical NSW incrementally builds a multi-layer structure consisting from hierarchical set of proximity graphs (layers) for nested subsets of the stored elements. The maximum layer in which an element is present is selected randomly with an exponentially decaying probability distribution. This allows producing graphs similar to the previously studied Navigable Small World (NSW) structures while additionally having the links separated by their characteristic distance scales. Starting search from the upper layer together with utilizing the scale separation boosts the performance compared to NSW and allows a logarithmic complexity scaling. Additional employment of a heuristic for selecting proximity graph neighbors significantly increases performance at high recall and in case of highly clustered data. Performance evaluation has demonstrated that the proposed general metric space search index is able to strongly outperform previous opensource state-of-the-art vector-only approaches. Similarity of the algorithm to the skip list structure allows straightforward balanced distributed implementation.

---

## Key Concepts Referenced in Abstract

The following terms appear verbatim in the abstract above and describe the algorithm's core mechanisms:

- **"navigable small world graphs with controllable hierarchy"** — the structural foundation
- **"multi-layer structure consisting from hierarchical set of proximity graphs (layers) for nested subsets of the stored elements"** — describes the layered graph construction
- **"The maximum layer in which an element is present is selected randomly with an exponentially decaying probability distribution"** — the stochastic layer assignment rule (governs `M`-based connectivity)
- **"Starting search from the upper layer together with utilizing the scale separation boosts the performance compared to NSW and allows a logarithmic complexity scaling"** — the core search complexity claim
- **"heuristic for selecting proximity graph neighbors significantly increases performance at high recall and in case of highly clustered data"** — refers to the `efConstruction`-governed neighbor selection heuristic
- **"Similarity of the algorithm to the skip list structure allows straightforward balanced distributed implementation"** — the skip-list analogy
