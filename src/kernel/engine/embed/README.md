## embed

Responsible for splitting vault documents into overlapping text chunks and producing embedding vectors for each chunk. The chunker respects Markdown heading boundaries and the `ChunkerOptions` token budget; the embedding layer wraps `node-llama-cpp` (GGUF model) or a configured embedding API. There is no fake/hash fallback: without a real embedding provider the vector path fails loudly (ADR-005), while lexical BM25/FTS remains available. All output conforms to the `Chunk` and `EmbeddingProvider` contracts defined in `../types.ts`.

**Absorbed sources (idea-only, no verbatim code):**
- `nashsu/llm_wiki` (GPL-3.0) — sliding-window overlap heuristic and heading-aware split boundary detection.

Short database writers use a separate immutable-record owner directory before entering the legacy `.lock` protocol. This prevents concurrent upgraded stale reclaimers from moving a live successor and admitting a third writer through the temporary pathname gap. The legacy lock remains visible as a compatibility courtesy; old processes do not observe the new owner directory, so mixed-version concurrent writers are not covered by this guarantee. Stop old writers before using the upgraded writer protocol. Unreadable or malformed legacy owner records block acquisition without moving or deleting them; only a valid, provably dead PID admits stale recovery.
