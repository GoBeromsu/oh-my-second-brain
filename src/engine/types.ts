/**
 * Shared contract types for the OMS retrieval engine (M1 scaffold).
 *
 * All three components — embed, graph, retrieval — import exclusively from here.
 * No component-local type duplication is permitted at this layer.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Top-level configuration threaded through every engine entry-point. */
export interface EngineConfig {
  /** Absolute path to the Obsidian vault root. */
  vaultPath: string;
  /** Absolute path to the SQLite database file (.db). */
  dbPath: string;
  /** Dimensionality of raw embeddings produced by the chosen model. Default 768. */
  embeddingDimensions: number;
  /**
   * Optional path to a GGUF model file.
   * Required on the strict production path (requireRealEmbeddingProvider);
   * omitting it without UPSTAGE_API_KEY causes a loud throw.
   */
  modelPath?: string;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/** Options controlling how documents are split into chunks. */
export interface ChunkerOptions {
  /** Maximum token budget per chunk. Default 900. */
  maxTokens: number;
  /** Fractional overlap between consecutive chunks (0–1). Default 0.15. */
  overlapRatio: number;
}

/**
 * A single text chunk extracted from a document.
 * Ordinals are zero-based and monotonically increasing within a document.
 */
export interface Chunk {
  /** Vault-relative path to the source document (e.g. "projects/foo.md"). */
  docPath: string;
  /** Zero-based position of this chunk within its document. */
  ordinal: number;
  /** Raw text content of the chunk. */
  text: string;
  /** Breadcrumb of heading text from the document root to this chunk's section. */
  headingPath: string[];
  /** SHA-256 hex digest of `text`, used for change-detection. */
  sha: string;
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

/**
 * Abstraction over an embedding backend (GGUF/llama.cpp or Upstage Solar).
 * Mirrors the shape of SemanticEmbeddingProvider in src/search/ but exposes
 * `dimensions` as a configurable field instead of folding to the hard-coded 64.
 * The hash-projection stub exists only in test helpers and must never appear
 * on the production path.
 */
export interface EmbeddingProvider {
  /** Human-readable model identifier (e.g. "node-llama-cpp:/path/to/model.gguf"). */
  readonly model: string;
  /** Dimensionality of the Float32Array returned by `embed`. */
  readonly dimensions: number;
  /** Produce a normalised embedding vector for `text`. */
  embed(text: string): Promise<Float32Array>;
  /** Release any native resources held by the provider. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Vector + lexical store
// ---------------------------------------------------------------------------

/** A ranked result from a vector or lexical store query. */
export interface ScoredHit {
  /** Vault-relative path to the source document. */
  docPath: string;
  /** Zero-based ordinal of the matching chunk within its document. */
  chunkOrdinal: number;
  /** Relevance score (higher = more relevant; scale depends on query type). */
  score: number;
}

/**
 * Low-level persistence layer exposing both vector-ANN and BM25 lexical search.
 * Backed by sqlite-vec + better-sqlite3.
 */
export interface VectorStore {
  /** Insert or replace chunk rows (keyed by docPath + ordinal). */
  upsert(rows: ReadonlyArray<Chunk & { vector: Float32Array }>): void;
  /** ANN search: return the `k` nearest chunks to `vec`. */
  queryVec(vec: Float32Array, k: number): ScoredHit[];
  /** BM25 lexical search: return the top `k` chunks matching `text`. */
  queryLex(text: string, k: number): ScoredHit[];
  /** Flush WAL and release the database connection. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/** A directed weighted edge in the document link graph. */
export interface GraphEdge {
  /** Vault-relative path of the source document. */
  from: string;
  /** Vault-relative path of the target document. */
  to: string;
  /** Edge weight ≥ 0 (interpretation depends on `kind`). */
  weight: number;
  /** Semantic classification of why this edge exists. */
  kind:
    | "wikilink"       // [[target]] syntax
    | "frontmatter"    // YAML frontmatter relation field
    | "adamic-adar"    // co-link structural similarity score
    | "type-affinity"  // same ontology type boost
    | "unknown-ref";   // unresolved reference kept for analysis
}

/** Parameters for a graph traversal query. */
export interface GphQuery {
  /** Traversal strategy. */
  mode: "bfs" | "dfs" | "community";
  /** Starting document path (vault-relative). */
  seed: string;
  /** Maximum hop depth; undefined means engine default. */
  depth?: number;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Provenance grade for a retrieved document, classifying the curation level
 * of its source relative to the vault owner.
 */
export type Provenance = "authored" | "curated" | "external-raw";

/** A single sub-query within a hybrid retrieval request. */
export interface TypedSubQuery {
  /** Retrieval modality. */
  type: "lex" | "vec" | "hyde" | "graph";
  /** The query string (natural language for vec/hyde; keyword for lex; seed path for graph). */
  query: string;
}

/** Final ranked result returned by the retrieval pipeline. */
export interface RetrievalResult {
  /** Vault-relative path to the document. */
  docPath: string;
  /** Fused relevance score across all active retrieval modalities. */
  score: number;
  /** Optional curation grade of the document. */
  provenance?: Provenance;
  /** Per-modality score breakdown keyed by TypedSubQuery.type. */
  perTypeScores?: Record<string, number>;
}
