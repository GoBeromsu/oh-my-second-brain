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

/** Storage backend discriminant. Native JSON is the only live store. */
export type McpSemanticStorage = "oms-native-json";

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

/** Scalar frontmatter value accepted by the public query-axis contract. */
export type McpSemanticAxisValue = string | number | boolean;

export interface McpSemanticFieldPredicate {
  readonly contains?: McpSemanticAxisValue | readonly McpSemanticAxisValue[];
  readonly containsAll?: readonly McpSemanticAxisValue[];
  readonly in?: readonly McpSemanticAxisValue[];
  readonly between?: readonly [McpSemanticAxisValue, McpSemanticAxisValue];
  readonly gte?: McpSemanticAxisValue;
  readonly gt?: McpSemanticAxisValue;
  readonly lte?: McpSemanticAxisValue;
  readonly lt?: McpSemanticAxisValue;
  readonly from?: McpSemanticAxisValue;
  readonly to?: McpSemanticAxisValue;
}

/**
 * Query axes are intentionally closed: folder, field, and link only.
 * Values in one axis are OR'ed; distinct field keys and distinct axis kinds
 * are AND'ed.
 */
export interface McpSemanticQueryAxes {
  readonly folder?: McpSemanticAxisValue | readonly McpSemanticAxisValue[];
  readonly field?: Readonly<
    Record<
      string,
      McpSemanticAxisValue | readonly McpSemanticAxisValue[] | McpSemanticFieldPredicate
    >
  >;
  readonly link?: McpSemanticAxisValue | readonly McpSemanticAxisValue[];
}

/** Closed, explicit query-plan strategy. Omission is always lexical-only. */
export interface McpSemanticExpandStrategy {
  readonly kind: "expand";
  readonly profile: "qmd-v2.8.3";
  /** Maximum generated typed lines; defaults to the generator's frozen budget. */
  readonly maxQueries?: number;
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
  readonly query?: string;
  readonly strategy?: McpSemanticExpandStrategy;
  readonly collection?: string;
  /** Vault-relative path prefix that constrains retrieval candidates. */
  readonly collectionPath?: string;
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
  /** Apply the configured reranker (opt-in; ADR-011). */
  readonly rerank?: boolean;
  /** Internal inverse spelling used by morning retrieval options. */
  readonly noRerank?: boolean;
  /** Optional axis-first narrowing over folder, frontmatter fields, and links. */
  readonly axes?: McpSemanticQueryAxes;
  /** Opaque offset cursor returned by a previous query. */
  readonly cursor?: string;
  /** Request explicit total-count metadata (responses include it regardless). */
  readonly count?: boolean;
  /** Request explicit facet metadata (responses include it regardless). */
  readonly facets?: boolean;
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

/** A facet count computed after axis filtering and before result limiting. */
export interface McpSemanticFacet {
  readonly axis: "template" | "folder" | "field" | "link";
  readonly value: string;
  readonly count: number;
  readonly key?: string;
  readonly intent: string;
}

/** Small, deterministic receipt attached to every query response. */
export interface McpSemanticReceipt {
  readonly usedChannels: readonly McpSemanticTypedSearchType[];
  readonly approximated: boolean;
  readonly drift: boolean;
  /** Plain lexical, caller-authored typed channels, or model-generated expansion. */
  readonly requestedStrategy: "plain" | "explicit" | "expand";
  /** Validated model output; empty for plain and caller-authored typed requests. */
  readonly generatedSearches: readonly McpSemanticTypedSearch[];
  readonly rerankApplied: boolean;
  /** Exact active-taxonomy intents that reached a model prompt. */
  readonly taxonomyIntents: readonly {
    readonly folder: string;
    readonly intent: string;
    readonly source: ".oms/taxonomy.yaml";
  }[];
  readonly warnings: readonly string[];
}

/**
 * Output of oms_semantic_query (mirrors SemanticQueryResult).
 *
 * Every response carries the complete envelope metadata, including failures.
 * Callers can therefore consume counts, facets, cursors, and receipts without
 * optional-field branching on the transport result.
 */
export type McpSemanticQueryResult =
  | {
      readonly available: true;
      readonly hits: readonly McpSemanticSearchHit[];
      readonly totalCount: number;
      readonly facets: readonly McpSemanticFacet[];
      readonly cursor: string | null;
      readonly intent?: string;
      readonly receipt: McpSemanticReceipt;
    }
  | {
      readonly available: false;
      readonly reason: string;
      readonly hits: readonly McpSemanticSearchHit[];
      readonly totalCount: number;
      readonly facets: readonly McpSemanticFacet[];
      readonly cursor: string | null;
      readonly intent?: string;
      readonly receipt: McpSemanticReceipt;
    };

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
       * Mirrors the success branch of the provider status (always
       * available:true at sync time).
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

/** Path-safe availability and identity for one semantic model capability. */
export interface McpSemanticModelCapabilityStatus {
  readonly capability: "embed" | "rerank" | "generate";
  readonly available: boolean;
  readonly source: "request" | "environment" | "vault" | "setup-default" | "unavailable";
  readonly provider?: string;
  readonly model?: string;
  readonly revision?: string;
  readonly sha256?: string;
  readonly promptScheme?: string;
  readonly guidance: string;
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
      readonly capabilities?: Readonly<Record<"embed" | "rerank" | "generate", McpSemanticModelCapabilityStatus>>;
      readonly storeEmbeddingFingerprint?: string;
      readonly taxonomyContext?: {
        readonly matched: readonly McpSemanticReceipt["taxonomyIntents"][number][];
        readonly indexedWithoutIntent: readonly string[];
        readonly taxonomyWithoutIndexed: readonly string[];
        readonly warnings: readonly string[];
      };
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
  readonly source: ".oms/taxonomy.yaml";
}

/** Output of oms_semantic_contexts (mirrors SemanticContextResult). */
export type McpSemanticContextResult =
  | {
      readonly available: true;
      readonly contexts: readonly McpSemanticStoredContext[];
      readonly warnings?: readonly string[];
    }
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
  readonly warnings: readonly string[];
}

/** Output of oms_graph_status. */
export type McpGraphStatusResult =
  | { readonly available: true; readonly notes: number; readonly edges: number; readonly generatedAt?: string }
  | { readonly available: false; readonly reason: string };

// ---------------------------------------------------------------------------
// oms_retrieve_by_axis — options
// ---------------------------------------------------------------------------

/** Axis filters for oms_retrieve_by_axis. */
export interface McpAxisFilters {
  readonly template?: string;
  readonly folder?: string;
  readonly property?: string;
  readonly value?: string;
  readonly wikilink?: string;
  readonly query?: string;
  readonly limit?: number;
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

/** Engine-internal result from the sync operation. */
export interface EngineSyncResult {
  readonly upserted: number;
  readonly skipped: number;
  readonly errors: number;
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
  readonly warnings?: readonly string[];
}
