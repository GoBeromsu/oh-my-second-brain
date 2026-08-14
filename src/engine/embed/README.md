## embed

Responsible for splitting vault documents into overlapping text chunks and producing embedding vectors for each chunk. The chunker respects Markdown heading boundaries and the `ChunkerOptions` token budget; the embedding layer wraps `node-llama-cpp` (GGUF model) or a configured embedding API. There is no fake/hash fallback: without a real embedding provider the vector path fails loudly (ADR-007), while lexical BM25/FTS remains available. All output conforms to the `Chunk` and `EmbeddingProvider` contracts defined in `../types.ts`.

**Absorbed sources (idea-only, no verbatim code):**
- `nashsu/llm_wiki` (GPL-3.0) — sliding-window overlap heuristic and heading-aware split boundary detection.
