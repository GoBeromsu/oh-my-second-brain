/**
 * Engine barrel — re-exports shared contracts now; component implementations
 * will be added incrementally (embed in M2, graph in M3, retrieval in M4).
 */
export type {
  EngineConfig,
  ChunkerOptions,
  Chunk,
  EmbeddingProvider,
  ScoredHit,
  VectorStore,
  GraphEdge,
  GphQuery,
  Provenance,
  TypedSubQuery,
  RetrievalResult,
} from "./types.js";
