/**
 * Stratified golden query set for the OMS M1 retrieval engine.
 *
 * Stratification requirements:
 *   - N >= 20 total queries
 *   - >= 4 of each type: lex, vec, hyde, graph
 *   - >= 1 Korean+English cross-language query
 *   - >= 1 technical-concept query
 *   - >= 1 personal-capture query
 *
 * expectedNotes contain plausible Ataraxia-style vault paths.
 * Entries marked TODO require real vault-backed curation before asserting.
 */

export type QueryType = "lex" | "vec" | "hyde" | "graph";

export interface GoldenQuery {
  /** Unique stable identifier for this query. */
  id: string;
  /** Retrieval modality. */
  type: QueryType;
  /** The query string sent to the retrieval engine. */
  query: string;
  /**
   * Expected top-10-relevant vault-relative note paths.
   * All paths must be verified against a live vault before the query is
   * marked `curated: true`.
   */
  expectedNotes: string[];
  /**
   * Whether the expectedNotes have been verified against a live vault.
   *
   * When false (or absent), the runner EXCLUDES this query from scoring and
   * emits a visible warning — it is NEVER silently scored 0.
   * Set to true only after every path in expectedNotes is confirmed.
   */
  curated?: boolean;
  /** Human-readable annotation for stratification tracking. */
  tags?: string[];
}

export const GOLDEN_QUERIES: GoldenQuery[] = [
  // ── Lexical (BM25) queries ─────────────────────────────────────────────────
  {
    id: "lex-01",
    type: "lex",
    query: "Stoic philosophy ataraxia tranquility",
    expectedNotes: [
      "notes/ataraxia-stoic-philosophy.md",         // TODO: verify path
      "notes/stoicism-daily-practice.md",            // TODO
      "captures/epictetus-enchiridion-notes.md",     // TODO
      "notes/marcus-aurelius-meditations.md",        // TODO
    ],
    tags: ["philosophy", "stoicism"],
  },
  {
    id: "lex-02",
    type: "lex",
    query: "Obsidian vault structure folder organization",
    expectedNotes: [
      "projects/oh-my-secondbrain-roadmap.md",       // TODO
      "notes/vault-architecture-design.md",          // TODO
      "captures/obsidian-plugin-list.md",            // TODO
    ],
    tags: ["obsidian", "pkm"],
  },
  {
    id: "lex-03",
    type: "lex",
    query: "second brain knowledge management Zettelkasten",
    expectedNotes: [
      "notes/zettelkasten-method.md",                // TODO
      "notes/building-second-brain-summary.md",      // TODO
      "captures/tiago-forte-book-notes.md",          // TODO
    ],
    tags: ["pkm", "zettelkasten"],
  },
  {
    id: "lex-04",
    type: "lex",
    query: "BFS graph traversal depth algorithm",
    expectedNotes: [
      "notes/graph-algorithms-overview.md",          // TODO
      "notes/bfs-dfs-comparison.md",                 // TODO
      "projects/oh-my-secondbrain-engine-design.md", // TODO
    ],
    tags: ["technical-concept", "graph"],
  },
  {
    id: "lex-05",
    type: "lex",
    query: "embedding vector similarity cosine distance",
    expectedNotes: [
      "notes/vector-search-fundamentals.md",         // TODO
      "notes/semantic-search-implementation.md",     // TODO
      "projects/oms-retrieval-engine.md",            // TODO
    ],
    tags: ["technical-concept", "ml"],
  },

  // ── Vector semantic queries ────────────────────────────────────────────────
  {
    id: "vec-01",
    type: "vec",
    query: "finding inner peace through philosophy and reflection",
    expectedNotes: [
      "notes/ataraxia-stoic-philosophy.md",          // TODO
      "notes/meditation-practice-log.md",            // TODO
      "captures/2024-01-15-morning-reflection.md",   // TODO
      "notes/equanimity-notes.md",                   // TODO
    ],
    tags: ["philosophy", "wellbeing"],
  },
  {
    id: "vec-02",
    type: "vec",
    query: "how to organize personal notes effectively for long-term recall",
    expectedNotes: [
      "notes/zettelkasten-method.md",                // TODO
      "notes/spaced-repetition-system.md",           // TODO
      "notes/building-second-brain-summary.md",      // TODO
    ],
    tags: ["pkm"],
  },
  {
    id: "vec-03",
    type: "vec",
    query: "machine learning model fine-tuning on local hardware",
    expectedNotes: [
      "notes/local-llm-setup-guide.md",              // TODO
      "notes/node-llama-cpp-integration.md",         // TODO
      "captures/gguf-model-comparison.md",           // TODO
    ],
    tags: ["technical-concept", "ml"],
  },
  {
    id: "vec-04",
    type: "vec",
    query: "daily journaling habit for self-improvement",
    expectedNotes: [
      "captures/2024-01-15-morning-reflection.md",   // TODO
      "captures/weekly-review-template.md",          // TODO
      "notes/journaling-benefits-research.md",       // TODO
    ],
    tags: ["personal-capture", "habits"],
  },
  {
    id: "vec-05",
    type: "vec",
    // Korean+English cross-language query
    query: "아타락시아 마음의 평화 스토아 철학 tranquility Stoic",
    expectedNotes: [
      "notes/ataraxia-stoic-philosophy.md",          // TODO
      "notes/stoicism-daily-practice.md",            // TODO
      "notes/marcus-aurelius-meditations.md",        // TODO
    ],
    tags: ["cross-language", "philosophy", "korean"],
  },

  // ── HyDE (Hypothetical Document Embeddings) queries ───────────────────────
  {
    id: "hyde-01",
    type: "hyde",
    query: "What are the core principles of Stoic philosophy for modern life?",
    expectedNotes: [
      "notes/ataraxia-stoic-philosophy.md",          // TODO
      "notes/stoicism-daily-practice.md",            // TODO
      "captures/epictetus-enchiridion-notes.md",     // TODO
      "notes/marcus-aurelius-meditations.md",        // TODO
    ],
    tags: ["philosophy", "stoicism"],
  },
  {
    id: "hyde-02",
    type: "hyde",
    query: "How does Reciprocal Rank Fusion work for combining search results?",
    expectedNotes: [
      "notes/rrf-fusion-algorithm.md",               // TODO
      "projects/oms-retrieval-engine.md",            // TODO
      "notes/information-retrieval-basics.md",       // TODO
    ],
    tags: ["technical-concept", "retrieval"],
  },
  {
    id: "hyde-03",
    type: "hyde",
    query: "What is the best way to capture fleeting thoughts in a personal knowledge system?",
    expectedNotes: [
      "captures/fleeting-notes-workflow.md",         // TODO
      "notes/zettelkasten-method.md",                // TODO
      "captures/2024-03-10-idea-capture.md",         // TODO
    ],
    tags: ["personal-capture", "pkm"],
  },
  {
    id: "hyde-04",
    type: "hyde",
    // Korean-language HyDE query (cross-language)
    query: "지식 그래프를 활용한 노트 연결 방법과 위키링크 구조",
    expectedNotes: [
      "notes/wikilink-graph-structure.md",           // TODO
      "projects/oh-my-secondbrain-graph-module.md",  // TODO
      "notes/knowledge-graph-design.md",             // TODO
    ],
    tags: ["cross-language", "graph", "korean"],
  },
  {
    id: "hyde-05",
    type: "hyde",
    query: "How do Adamic-Adar scores identify structurally similar documents in a knowledge graph?",
    expectedNotes: [
      "notes/adamic-adar-co-link-scoring.md",        // TODO
      "projects/oms-graph-builder.md",               // TODO
      "notes/graph-similarity-metrics.md",           // TODO
    ],
    tags: ["technical-concept", "graph"],
  },

  // ── Graph traversal queries ────────────────────────────────────────────────
  {
    id: "graph-01",
    type: "graph",
    // seed = a hub note; traversal discovers linked neighbors
    query: "notes/ataraxia-stoic-philosophy.md",
    expectedNotes: [
      "notes/stoicism-daily-practice.md",            // TODO
      "notes/marcus-aurelius-meditations.md",        // TODO
      "captures/epictetus-enchiridion-notes.md",     // TODO
    ],
    tags: ["philosophy", "graph"],
  },
  {
    id: "graph-02",
    type: "graph",
    query: "projects/oh-my-secondbrain-roadmap.md",
    expectedNotes: [
      "notes/vault-architecture-design.md",          // TODO
      "projects/oms-retrieval-engine.md",            // TODO
      "notes/semantic-search-implementation.md",     // TODO
    ],
    tags: ["pkm", "graph"],
  },
  {
    id: "graph-03",
    type: "graph",
    query: "notes/zettelkasten-method.md",
    expectedNotes: [
      "notes/building-second-brain-summary.md",      // TODO
      "captures/tiago-forte-book-notes.md",          // TODO
      "notes/spaced-repetition-system.md",           // TODO
    ],
    tags: ["pkm", "graph"],
  },
  {
    id: "graph-04",
    type: "graph",
    query: "notes/local-llm-setup-guide.md",
    expectedNotes: [
      "notes/node-llama-cpp-integration.md",         // TODO
      "captures/gguf-model-comparison.md",           // TODO
      "notes/vector-search-fundamentals.md",         // TODO
    ],
    tags: ["technical-concept", "graph", "ml"],
  },

  // ── Additional mixed queries ────────────────────────────────────────────────
  {
    id: "lex-06",
    type: "lex",
    // personal capture query
    query: "morning reflection journal 2024 daily log",
    expectedNotes: [
      "captures/2024-01-15-morning-reflection.md",   // TODO
      "captures/2024-03-10-idea-capture.md",         // TODO
      "captures/weekly-review-template.md",          // TODO
    ],
    tags: ["personal-capture"],
  },
  {
    id: "vec-06",
    type: "vec",
    // technical-concept query
    query: "SQLite vector ANN search approximate nearest neighbor index",
    expectedNotes: [
      "notes/sqlite-vec-setup.md",                   // TODO
      "notes/vector-search-fundamentals.md",         // TODO
      "projects/oms-retrieval-engine.md",            // TODO
    ],
    tags: ["technical-concept", "database"],
  },
  {
    id: "hyde-06",
    type: "hyde",
    // personal-capture + Korean
    query: "오늘 배운 것들을 정리하고 내일을 위한 액션 아이템 만들기",
    expectedNotes: [
      "captures/2024-01-15-morning-reflection.md",   // TODO
      "captures/weekly-review-template.md",          // TODO
      "notes/journaling-benefits-research.md",       // TODO
    ],
    tags: ["personal-capture", "cross-language", "korean"],
  },
  {
    id: "graph-05",
    type: "graph",
    query: "notes/rrf-fusion-algorithm.md",
    expectedNotes: [
      "notes/information-retrieval-basics.md",       // TODO
      "projects/oms-retrieval-engine.md",            // TODO
      "notes/bfs-dfs-comparison.md",                 // TODO
    ],
    tags: ["technical-concept", "graph", "retrieval"],
  },
];

// ---------------------------------------------------------------------------
// Derived counts (useful for assertions in harness)
// ---------------------------------------------------------------------------

export const QUERY_COUNT = GOLDEN_QUERIES.length; // >= 20

export const QUERIES_BY_TYPE = {
  lex: GOLDEN_QUERIES.filter((q) => q.type === "lex"),
  vec: GOLDEN_QUERIES.filter((q) => q.type === "vec"),
  hyde: GOLDEN_QUERIES.filter((q) => q.type === "hyde"),
  graph: GOLDEN_QUERIES.filter((q) => q.type === "graph"),
} as const;
