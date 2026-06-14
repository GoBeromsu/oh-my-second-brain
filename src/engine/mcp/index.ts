/**
 * Engine MCP adapter layer barrel.
 *
 * Public surface for the integrate-phase assemble step:
 *   - McpEngineAdapter    — the adapter facade (takes DispatcherDeps, never builds them)
 *   - queryOptionsToSubQueries / retrievalResultsToQueryResult — centerpiece mappers
 *   - Per-op mapper functions (sync, status, collections, contexts, cleanup, graph)
 *   - Axis-retrieve mapper functions
 *   - All mirrored MCP types (Mcp*) and engine-seam types (Engine*)
 */

// Mirrored MCP types + engine-seam types
export type {
  McpSemanticStorage,
  McpSemanticSearchMode,
  McpSemanticSearchFormat,
  McpSemanticTypedSearchType,
  McpSemanticTypedSearch,
  McpStatusOptions,
  McpSemanticQueryOptions,
  McpSemanticHitEvidence,
  McpSemanticSearchHit,
  McpSemanticQueryResult,
  McpSemanticEmbeddingSyncOptions,
  McpSemanticSyncStep,
  McpSemanticEmbeddingSyncResult,
  McpSemanticModels,
  McpSemanticIndexDocuments,
  McpSemanticIndexStatus,
  McpSemanticProviderStatus,
  McpSemanticCollectionSummary,
  McpSemanticCollectionResult,
  McpSemanticStoredContext,
  McpSemanticContextResult,
  McpSemanticCleanupResult,
  McpGraphBuildOptions,
  McpGraphBuildResult,
  McpGraphStatusResult,
  McpAxisFilters,
  McpRetrieveContextOptions,
  EngineSyncArgs,
  EngineSyncResult,
  EngineStatusArgs,
  EngineStatusResult,
  EngineGraphBuildArgs,
  EngineGraphBuildResult,
} from "./types.js";

// Centerpiece: oms_semantic_query mappers
export {
  queryOptionsToSubQueries,
  retrievalResultsToQueryResult,
  queryResultUnavailable,
} from "./query-mapper.js";

// Per-op mappers (sync, status, collections, contexts, cleanup, graph)
export {
  syncOptionsToEngineArgs,
  engineSyncResultToMcp,
  syncResultUnavailable,
  statusOptionsToEngineArgs,
  capsToEngineStatusResult,
  engineStatusResultToMcp,
  statusResultUnavailable,
  engineStatusToCollectionResult,
  engineStatusToContextResult,
  engineSyncResultToCleanupResult,
  cleanupResultUnavailable,
  graphBuildOptionsToEngineArgs,
  engineGraphBuildResultToMcp,
  engineGraphBuildToStatusResult,
} from "./op-mappers.js";

// Axis-retrieve mappers
export {
  axisFiltersToSubQueries,
  retrieveContextToSubQueries,
  retrievalResultsToAxisResult,
} from "./retrieve-mapper.js";

// Adapter facade
export { McpEngineAdapter } from "./facade.js";
