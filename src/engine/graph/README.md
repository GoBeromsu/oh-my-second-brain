## graph

Responsible for building and querying the document link graph. Parses `[[wikilink]]` syntax and YAML frontmatter relation fields to produce `GraphEdge` rows, then computes structural-similarity weights (Adamic-Adar) and type-affinity boosts derived from the vault ontology. Exposes BFS and DFS traversals via the `GphQuery` contract defined in `../types.ts` (`community` mode currently falls back to BFS). The graph is persisted as an adjacency table in the same SQLite database used by the vector store (`better-sqlite3`).

**Absorbed sources (idea-only, no verbatim code):**
- `nashsu/llm_wiki` (GPL-3.0) — Adamic-Adar co-link scoring algorithm and frontmatter relation extraction pattern.
