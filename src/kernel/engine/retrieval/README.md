## retrieval

Responsible for the hybrid retrieval pipeline that fuses lexical (BM25), vector-ANN, HyDE, and graph-walk signals into a single ranked `RetrievalResult` list. Accepts a `TypedSubQuery[]` fan-out, dispatches each requested modality, then applies reciprocal-rank fusion (RRF) with provenance re-ranking to produce the final scored list. All input and output types are defined in `../types.ts`.

The four modalities do not have the same requirements, and a requested one that cannot run fails rather than returning something that looks like a result:

- **`lex`** always available; needs no model.
- **`vec`** needs the embed capability.
- **`hyde`** needs *two* capabilities — a generate model to write the hypothetical document and an embed model to embed it. There is no default generator: an identity stub once returned the query unchanged, which made an explicit HyDE request an ordinary vector search still reporting itself as HyDE. Absent generator, empty output, and output that merely echoes the query all fail.
- **`graph`** needs an injected `graphTraverse`. An unwired explicit graph
  sub-query fails loudly and names the missing traversal backend; it never
  reports an empty successful result.

Cross-encoder reranking is applied after fusion and is opt-in. An unconfigured reranker is absent rather than inert, so `rerank: true` fails loudly instead of returning the unchanged fused order as though it had been reranked.

**Absorbed sources (idea-only, no verbatim code):**
- `nashsu/llm_wiki` (GPL-3.0) — reciprocal-rank fusion weight schedule and HyDE hypothetical-document generation prompt structure.
