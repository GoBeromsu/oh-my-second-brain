## retrieval

Responsible for the hybrid retrieval pipeline that fuses lexical (BM25), vector-ANN, HyDE, and graph-walk signals into a single ranked `RetrievalResult` list. Accepts a `TypedSubQuery[]` fan-out, executes each modality against the `VectorStore` and graph layer, then applies reciprocal-rank fusion (RRF) with provenance re-ranking to produce the final scored list. All input and output types are defined in `../types.ts`.

**Absorbed sources (idea-only, no verbatim code):**
- `nashsu/llm_wiki` (GPL-3.0) — reciprocal-rank fusion weight schedule and HyDE hypothetical-document generation prompt structure.
