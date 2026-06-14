## graph

Responsible for building and querying the document link graph. Parses `[[wikilink]]` syntax and YAML frontmatter relation fields to produce `GraphEdge` rows, then computes structural-similarity weights (Adamic-Adar) and type-affinity boosts derived from the vault ontology. Exposes BFS, DFS, and community-detection traversals via the `GphQuery` contract defined in `../types.ts`. The graph is persisted as an adjacency table in the same SQLite database used by the vector store (`better-sqlite3`).

**Absorbed sources (idea-only, no verbatim code):**
- `nashsu/llm_wiki` (GPL-3.0) — Adamic-Adar co-link scoring algorithm and frontmatter relation extraction pattern.
