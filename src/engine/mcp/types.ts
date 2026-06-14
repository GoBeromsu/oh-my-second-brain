/**
 * Mirrored MCP-contract types for the engine/mcp adapter layer.
 *
 * Structurally identical to their src/search counterparts, but live here so
 * the engine layer has ZERO runtime imports from src/search (R18 constraint).
 * Update these when the live MCP contract changes.
 */

// ---------------------------------------------------------------------------
// Storage / mode / format discriminants
// ---------------------------------------------------------------------------

/** Storage backend discriminant (mirrors SemanticStorage in src/search). */
export type McpSemanticStorage = "qmd-sqlite" | "oms-native-json";

/** Query mode (mirrors SemanticSearchMode in src/search). */
export type McpSemanticSearchMode = "query" | "search" | "vsearch";

/** Output format (mirrors SemanticSearchFormat in src/search). */
export type McpSemanticSearchFormat = "json" | "files";

/**
 * Sub-query type supported by the MCP contract.
 * Note: the engine also supports "graph"; that type is injected by the adapter
 * when graphTraverse is wired into DispatcherDeps.
 */
export type McpSemanticTypedSearchType = "lex" | "vec" | "hyde";

/** A single typed sub-search within a query options object. */
export interface McpSemanticTypedSearch {
  readonly type: McpSemanticTypedSearchType;
  readonly query: string;
}

// ---------------------------------------------------------------------------
// Shared status / identity options
// ---------------------------------------------------------------------------

/** Options shared by every MCP semantic op (mirrors SemanticStatusOptions). */
export interface McpStatusOptions {
  readonly vault?: string;
  readonly index?: string;
  readonly storage?: McpSemanticStorage;
  readonly modelPath?: string;
}

// ---------------------------------------------------------------------------
// oms_semantic_query — options + result
// ---------------------------------------------------------------------------

/** Full query options for oms_semantic_query (mirrors SemanticQueryOptions). */
export interface McpSemanticQueryOptions extends McpStatusOptions {
  readonly query: string;
  readonly collection?: string;
  readonly limit?: number;
  readonly mode?: McpSemanticSearchMode;
  readonly intent?: string;
  readonly searches?: readonly McpSemanticTypedSearch[];
  readonly lex?: string;
  readonly vec?: string;
  readonly hyde?: string;
  readonly minScore?: number;
  readonly all?: boolean;
  readonly format?: McpSemanticSearchFormat;
  readonly full?: boolean;
  readonly lineNumbers?: boolean;
  readonly fullPath?: boolean;
  readonly chunkStrategy?: string;
  readonly candidateLimit?: number;
  readonly noRerank?: boolean;
}

/** Per-hit evidence flags indicating which retrieval modality matched. */
export interface McpSemanticHitEvidence {
  readonly lexical: boolean;
  readonly vector: boolean;
}

/** A single result hit from oms_semantic_query (mirrors SemanticSearchHit). */
export interface McpSemanticSearchHit {
  readonly docid: string;
  readonly score: number;
  readonly uri: string;
  readonly path: string;
  readonly line?: number;
  readonly title?: string;
  readonly snippet: string;
  readonly context?: string;
  readonly evidence: McpSemanticHitEvidence;
}

/** Output of oms_semantic_query (mirrors SemanticQueryResult). */
export type McpSemanticQueryResult =
  | { readonly available: true; readonly hits: readonly McpSemanticSearchHit[] }
  | { readonly available: false; readonly reason: string; readonly hits: readonly McpSemanticSearchHit[] };

// ---------------------------------------------------------------------------
// oms_sync_embeddings — options + result
// ---------------------------------------------------------------------------

/** Options for oms_sync_embeddings (mirrors SemanticEmbeddingSyncOptions). */
export interface McpSemanticEmbeddingSyncOptions {
  readonly vault: string;
  readonly collection?: string;
  readonly collectionPath?: string;
  readonly pattern?: string;
  readonly ignore?: readonly string[];
  readonly includeByDefault?: boolean;
  readonly updateCommand?: string;
  readonly context?: string;
  readonly ensureCollection?: boolean;
  readonly update?: boolean;
  readonly embed?: boolean;
  readonly force?: boolean;
  readonly pull?: boolean;
  readonly index?: string;
  readonly chunkStrategy?: string;
  readonly maxDocsPerBatch?: number;
  readonly maxBatchMb?: number;
  readonly storage?: McpSemanticStorage;
  readonly modelPath?: string;
}

/** A single step in the sync pipeline (mirrors SemanticSyncStep). */
export interface McpSemanticSyncStep {
  readonly name: "pull" | "scan" | "write-index" | "status";
  readonly status: number;
  readonly message: string;
  readonly documents?: number;
}

/** Output of oms_sync_embeddings (mirrors SemanticEmbeddingSyncResult). */
export type McpSemanticEmbeddingSyncResult =
  | {
      readonly available: true;
      readonly storage: McpSemanticStorage;
      readonly collection?: string;
      readonly index?: string;
      /**
       * Provider status snapshot captured at sync time.
       * Mirrors `Extract<SemanticProviderStatus, { available: true }>` from
       * src/search/semantic-sync-types.ts:41.
       */
      readonly status: McpSemanticProviderStatus & { readonly available: true };
      readonly steps: readonly McpSemanticSyncStep[];
    }
  | {
      readonly available: false;
      readonly reason: string;
      readonly storage: McpSemanticStorage;
      readonly collection?: string;
      readonly index?: string;
      readonly steps: readonly McpSemanticSyncStep[];
    };

// ---------------------------------------------------------------------------
// oms_semantic_status — result
// ---------------------------------------------------------------------------

/** Model configuration within a status response (mirrors SemanticModels). */
export interface McpSemanticModels {
  readonly embedding?: string;
  readonly reranking?: string;
  readonly generation?: string;
}

/** Document-count fields within a status response (mirrors SemanticIndexDocuments). */
export interface McpSemanticIndexDocuments {
  readonly total?: number;
  readonly vectors?: number;
  readonly pending?: number;
  readonly updated?: string;
}

/** Index metadata within a status response (mirrors SemanticIndexStatus). */
export interface McpSemanticIndexStatus {
  readonly path?: string;
  readonly size?: string;
  readonly documents?: McpSemanticIndexDocuments;
}

/** Output of oms_semantic_status (mirrors SemanticProviderStatus). */
export type McpSemanticProviderStatus =
  | {
      readonly available: true;
      readonly storage: McpSemanticStorage;
      readonly models: McpSemanticModels;
      readonly index?: McpSemanticIndexStatus;
    }
  | { readonly available: false; readonly reason: string };

// ---------------------------------------------------------------------------
// oms_semantic_collections — result
// ---------------------------------------------------------------------------

/** Summary of a single collection (mirrors SemanticCollectionSummary). */
export interface McpSemanticCollectionSummary {
  readonly name: string;
  readonly path: string;
  readonly pattern: string;
  readonly ignore: readonly string[];
  readonly includeByDefault: boolean;
  readonly updateCommand?: string;
  readonly context?: string;
  readonly documents: number;
  readonly activeDocuments: number;
  readonly lastModified?: string;
}

/** Output of oms_semantic_collections (mirrors SemanticCollectionResult). */
export type McpSemanticCollectionResult =
  | { readonly available: true; readonly collections: readonly McpSemanticCollectionSummary[] }
  | {
      readonly available: false;
      readonly reason: string;
      readonly collections: readonly McpSemanticCollectionSummary[];
    };

// ---------------------------------------------------------------------------
// oms_semantic_contexts — result
// ---------------------------------------------------------------------------

/** A stored context entry (mirrors SemanticStoredContext). */
export interface McpSemanticStoredContext {
  readonly collection?: string;
  readonly pathPrefix: string;
  readonly context: string;
  readonly updatedAt: string;
}

/** Output of oms_semantic_contexts (mirrors SemanticContextResult). */
export type McpSemanticContextResult =
  | { readonly available: true; readonly contexts: readonly McpSemanticStoredContext[] }
  | {
      readonly available: false;
      readonly reason: string;
      readonly contexts: readonly McpSemanticStoredContext[];
    };

// ---------------------------------------------------------------------------
// oms_semantic_cleanup — result
// ---------------------------------------------------------------------------

/** Output of oms_semantic_cleanup (mirrors SemanticCleanupResult). */
export type McpSemanticCleanupResult =
  | {
      readonly available: true;
      readonly storage: McpSemanticStorage;
      readonly removedDocuments: number;
      readonly remainingDocuments: number;
      readonly collections: number;
    }
  | { readonly available: false; readonly storage: McpSemanticStorage; readonly reason: string };

// ---------------------------------------------------------------------------
// oms_graph_build / oms_graph_status — options + results
// ---------------------------------------------------------------------------

/** Input options for oms_graph_build. */
export interface McpGraphBuildOptions {
  readonly dryRun?: boolean;
}

/** Output of oms_graph_build. */
export interface McpGraphBuildResult {
  readonly available: true;
  readonly notes: number;
  readonly edges: number;
  readonly generatedAt: string;
}

/** Output of oms_graph_status. */
export type McpGraphStatusResult =
  | { readonly available: true; readonly notes: number; readonly edges: number; readonly generatedAt?: string }
  | { readonly available: false; readonly reason: string };

// ---------------------------------------------------------------------------
// oms_retrieve_by_axis / oms_retrieve_context — options
// ---------------------------------------------------------------------------

/** Axis filters common to both retrieve ops. */
export interface McpAxisFilters {
  readonly concept?: string;
  readonly folder?: string;
  readonly property?: string;
  readonly value?: string;
  readonly wikilink?: string;
  readonly query?: string;
  readonly limit?: number;
}

/** Extended options for oms_retrieve_context (adds semantic + graph neighbors). */
export interface McpRetrieveContextOptions extends McpAxisFilters {
  readonly maxNeighbors?: number;
  readonly useCache?: boolean;
  /** Optional semantic sub-queries to fan out alongside axis filters. */
  readonly semanticSearches?: readonly McpSemanticTypedSearch[];
}

// ---------------------------------------------------------------------------
// oms_get / oms_multi_get — document hydration types (GAP-9, R18 mirror)
// ---------------------------------------------------------------------------

/** A single hydrated document returned by get/multi_get (mirrors SemanticDocument). */
export interface McpSemanticDocument {
  readonly target: string;
  readonly path: string;
  readonly content: string;
  readonly docid?: string;
  readonly title?: string;
  readonly uri?: string;
}

/** Output of oms_get / oms_multi_get (flat shape; mirrors SemanticDocumentResult). */
export interface McpSemanticDocumentResult {
  readonly available: boolean;
  readonly reason?: string;
  readonly documents: McpSemanticDocument[];
}

/** Options for oms_get (mirrors SemanticGetOptions). */
export interface McpSemanticGetOptions {
  readonly target: string;
  readonly vault?: string;
  readonly fromLine?: number;
  readonly lineCount?: number;
  readonly lineNumbers?: boolean;
  readonly fullPath?: boolean;
  readonly collection?: string;
}

/** Options for oms_multi_get (mirrors SemanticMultiGetOptions). */
export interface McpSemanticMultiGetOptions {
  readonly targets: string[];
  readonly vault?: string;
  readonly lineLimit?: number;
  readonly maxBytes?: number;
  readonly lineNumbers?: boolean;
  readonly fullPath?: boolean;
  readonly collection?: string;
}

// ---------------------------------------------------------------------------
// Engine-facing seam types (internal to engine/mcp — not mirrored from src/search)
// ---------------------------------------------------------------------------

/** Engine-internal args produced by the sync request mapper. */
export interface EngineSyncArgs {
  /** Vault-relative paths to (re-)embed. Empty slice = full-scan. */
  readonly paths: readonly string[];
  readonly collection?: string;
  readonly collectionPath?: string;
  readonly pattern?: string;
  readonly ignore?: readonly string[];
  readonly includeByDefault?: boolean;
  readonly updateCommand?: string;
  readonly context?: string;
  readonly force: boolean;
}

/** Engine-internal result from the sync operation. */
export interface EngineSyncResult {
  readonly upserted: number;
  readonly skipped: number;
  readonly errors: number;
}

/** Engine-internal args for a status probe of DispatcherDeps capabilities. */
export interface EngineStatusArgs {
  readonly includeModels: boolean;
}

/** Engine-internal result from a status probe. */
export interface EngineStatusResult {
  readonly storeAvailable: boolean;
  readonly model: string;
  readonly dimensions: number;
}

/** Engine-internal args for graph build (vaultPath supplied by facade). */
export interface EngineGraphBuildArgs {
  readonly vaultPath: string;
  readonly dryRun: boolean;
}

/** Engine-internal result from a graph build. */
export interface EngineGraphBuildResult {
  readonly notes: number;
  readonly edges: number;
  readonly generatedAt: string;
}
