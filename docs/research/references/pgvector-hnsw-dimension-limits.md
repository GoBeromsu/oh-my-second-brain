---
slug: pgvector-hnsw-dimension-limits
source_url: https://github.com/pgvector/pgvector
captured_date: 2026-06-13
original_title: pgvector — Open-source vector similarity search for Postgres
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

> **VERBATIM SNAPSHOT** — Source: https://github.com/pgvector/pgvector  
> Captured: 2026-06-13. Do NOT edit after capture.

---

<!-- ================================================================
     확인된 핵심 수치 (캡처자 노트 — 본문 verbatim 블록과 분리)
     ================================================================ -->

> **확인된 핵심 수치** (claude-code 노트, 본문 밖)
>
> | 항목 | 값 | 출처 |
> |------|-----|------|
> | `vector` HNSW 인덱스 최대 차원 | **2,000 dimensions** | pgvector README (verbatim below) |
> | `halfvec` HNSW 인덱스 최대 차원 | **4,000 dimensions** | pgvector README (verbatim below) |
> | `bit` HNSW 인덱스 최대 차원 | **64,000 dimensions** | pgvector README (verbatim below) |
> | `vector` 스토리지 최대 차원 (인덱스 없이) | **16,000 dimensions** | pgvector README |
> | `halfvec` 스토리지 최대 차원 (인덱스 없이) | **16,000 dimensions** | pgvector README |
> | HNSW 기본 `m` | 16 | pgvector README |
> | HNSW 기본 `ef_construction` | 64 | pgvector README |
> | HNSW 기본 `ef_search` | 40 | pgvector README |
>
> **결론**: `vector` HNSW는 2,000차원 한계, `halfvec` HNSW로 캐스팅하면 4,000차원까지 인덱싱 가능.
> Solar Embedding(4,096차원)은 이 두 한계를 모두 초과 → binary quantization 또는 dimensionality reduction 필요.

---

<!-- ================================================================
     PASTE OR TRANSCRIBE THE SOURCE DOCUMENT VERBATIM BELOW THIS LINE
     ================================================================ -->

## HNSW

An HNSW index creates a multilayer graph. It has better query performance than IVFFlat (in terms of speed-recall tradeoff), but has slower build times and uses more memory. Also, an index can be created without any data in the table since there's no training step like IVFFlat.

Add an index for each distance function you want to use.

L2 distance

```sql
CREATE INDEX ON items USING hnsw (embedding vector_l2_ops);
```

Inner product

```sql
CREATE INDEX ON items USING hnsw (embedding vector_ip_ops);
```

Cosine distance

```sql
CREATE INDEX ON items USING hnsw (embedding vector_cosine_ops);
```

L1 distance

```sql
CREATE INDEX ON items USING hnsw (embedding vector_l1_ops);
```

Hamming distance

```sql
CREATE INDEX ON items USING hnsw (embedding bit_hamming_ops);
```

Jaccard distance

```sql
CREATE INDEX ON items USING hnsw (embedding bit_jaccard_ops);
```

### Index Options

Specify HNSW parameters

- `m` - the max number of connections per layer (16 by default)
- `ef_construction` - the size of the dynamic candidate list for constructing the graph (64 by default)

```sql
CREATE INDEX ON items USING hnsw (embedding vector_l2_ops) WITH (m = 16, ef_construction = 64);
```

A higher value of `ef_construction` provides better recall at the cost of index build time / insert speed.

### Query Options

Specify the size of the dynamic candidate list for search (40 by default)

```sql
SET hnsw.ef_search = 100;
```

A higher value provides better recall at the cost of speed.

Use `SET LOCAL` inside a transaction to set it for a single query

```sql
BEGIN;
SET LOCAL hnsw.ef_search = 100;
SELECT ...
COMMIT;
```

---

## Supported Types (HNSW indexing dimension limits)

Supported types are:

- `vector` - up to 2,000 dimensions
- `halfvec` - up to 4,000 dimensions
- `bit` - up to 64,000 dimensions
- `sparsevec` - up to 1,000 non-zero elements

---

## Half-Precision Vectors

`halfvec` - each element is a half-precision floating-point number. Half vectors can have up to 16,000 dimensions.

Half vectors can be indexed using the same distance functions as regular vectors.

```sql
CREATE INDEX ON items USING hnsw (embedding halfvec_l2_ops);
```

---

## Half-Precision Indexing

Index vectors at half precision for smaller indexes

```sql
CREATE INDEX ON items USING hnsw ((embedding::halfvec(3)) halfvec_l2_ops);
```

Get the nearest neighbors

```sql
SELECT * FROM items ORDER BY embedding::halfvec(3) <-> '[1,2,3]' LIMIT 5;
```

---

## Frequently Asked Questions

**I want to index vectors with more than 2,000 dimensions. What should I do?**

You can use half-precision vectors or half-precision indexing to index up to 4,000 dimensions or binary quantization to index up to 64,000 dimensions. Other options are indexing subvectors (for models that support it) or dimensionality reduction.

---

## Vector Type Storage

Each vector takes `4 * dimensions + 8` bytes of storage. Each element is a single-precision floating-point number (like the `real` type in Postgres), and all elements must be finite (no `NaN`, `Infinity` or `-Infinity`). Vectors can have up to 16,000 dimensions.

## Half Vector Type Storage

Each half vector takes `2 * dimensions + 8` bytes of storage. Each element is a half-precision floating-point number, and all elements must be finite (no `NaN`, `Infinity` or `-Infinity`). Half vectors can have up to 16,000 dimensions.
