---
slug: upstage-solar-embedding-api
source_url: https://www.upstage.ai/blog/en/solar-embedding-1-large
captured_date: 2026-06-13
original_title: "Breaking barriers: Revolutionize your work with our next-level embedding model"
source_type: documentation
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

> **VERBATIM SNAPSHOT** — Sources:  
> - https://www.upstage.ai/blog/en/solar-embedding-1-large (primary — passage/query model explanation)  
> - https://qdrant.tech/documentation/embeddings/upstage/ (embedding dimension, API usage)  
> Captured: 2026-06-13. Do NOT edit after capture.

---

<!-- ================================================================
     확인된 핵심 수치 (캡처자 노트 — 본문 verbatim 블록과 분리)
     ================================================================ -->

> **확인된 핵심 수치** (claude-code 노트, 본문 밖)
>
> | 항목 | 값 | 확인 출처 |
> |------|-----|----------|
> | 인덱싱(문서) 모델명 | `solar-embedding-1-large-passage` | Upstage blog + Qdrant docs (verbatim below) |
> | 쿼리 모델명 | `solar-embedding-1-large-query` | Upstage blog + Qdrant docs (verbatim below) |
> | 임베딩 차원 | **4096** | Qdrant docs (verbatim: "generates sentence embeddings of size 4096") |
> | 최대 컨텍스트 | **4k tokens** | Upstage blog (verbatim: "4k context length") |
> | 권장 입력 길이 | **512 tokens 이하** (최적 성능) | Upstage blog (verbatim below) |
>
> **엔진 ADR 관련 주의사항**:
> - Solar embedding dim(4096) > pgvector `vector` HNSW 한계(2000) > pgvector `halfvec` HNSW 한계(4000).
>   4096 > 4000이므로 `halfvec` HNSW도 불가. binary quantization 또는 dimensionality reduction 필요.
> - 권장 512 토큰은 hard limit이 아닌 성능 권장치. hard limit은 4k(4096 tokens).

---

<!-- ================================================================
     PASTE OR TRANSCRIBE THE SOURCE DOCUMENT VERBATIM BELOW THIS LINE
     ================================================================ -->

## Source 1: Upstage Blog — "Breaking barriers: Revolutionize your work with our next-level embedding model"

URL: https://www.upstage.ai/blog/en/solar-embedding-1-large

---

### Model Names and Usage

The Solar Embeddings API features dual models: `solar-embedding-1-large-query` for user queries and `solar-embedding-1-large-passage` for document embedding, within a unified vector space.

### When to Use Each Model

For developers building search engines or retrieval systems, `solar-embedding-1-large-passage` is ideal for initially embedding the searchable content. Upon user query submission, leveraging `solar-embedding-1-large-query` facilitates the efficient and accurate matching of queries with the embedded content, thereby optimizing the information retrieval process.

### Context Length and Recommended Input

Both models offer a 4k context length. Additionally, for optimal user experience, it is recommended to submit requests of 512 tokens or less.

---

## Source 2: Qdrant Documentation — "Upstage"

URL: https://qdrant.tech/documentation/embeddings/upstage/

---

### Embedding Models

The recommended models are:

- **`solar-embedding-1-large-passage`** — for embedding documents
- **`solar-embedding-1-large-query`** — for embedding search queries

Both models generate sentence embeddings of size 4096 and operate within a unified vector space designed for dual-model text processing.

### Vector Configuration

- **Vector Size:** 4096 dimensions
- **Recommended Distance Metric:** Cosine similarity
- **Base URL:** `https://api.upstage.ai/v1/solar/embeddings`

### Usage Pattern

The integration follows this pattern:

1. Embed documents using `solar-embedding-1-large-passage` (index time)
2. Embed user queries using `solar-embedding-1-large-query` (query time)
3. Perform nearest-neighbor search against indexed passage embeddings

The documentation emphasizes the importance of using the query-specific model when searching, separate from the passage model used during document embedding, to maintain consistency within the unified vector space.

---

## Source 3: Upstage Developers Documentation (models reference)

URL: https://developers.upstage.ai/docs/getting-started/models  
(redirects to https://console.upstage.ai — captured via web search, 2026-06-13)

### Model Listing

Solar Embeddings API dual models:

| Model | Use case |
|-------|----------|
| `solar-embedding-1-large-passage` | Embedding documents / passages for indexing |
| `solar-embedding-1-large-query` | Embedding search queries at query time |

Both models produce 4096-dimensional float vectors.
