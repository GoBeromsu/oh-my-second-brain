/**
 * Semantic surface contract.
 *
 * After the src/search teardown (follow-up to #34) the engine MCP adapter layer
 * is the single source of truth for the OMS semantic surface. These domain-named
 * aliases re-export the canonical engine contract types so the morning retrieval
 * layer and the CLI/MCP option builders stay decoupled from the engine's
 * `Mcp`-prefixed names without re-declaring a parallel type set.
 */
export type {
  McpSemanticStorage as SemanticStorage,
  McpSemanticSearchMode as SemanticSearchMode,
  McpSemanticSearchFormat as SemanticSearchFormat,
  McpSemanticTypedSearchType as SemanticTypedSearchType,
  McpSemanticTypedSearch as SemanticTypedSearch,
  McpStatusOptions as SemanticStatusOptions,
  McpSemanticQueryOptions as SemanticQueryOptions,
  McpSemanticHitEvidence as SemanticHitEvidence,
  McpSemanticSearchHit as SemanticSearchHit,
  McpSemanticQueryResult as SemanticQueryResult,
  McpSemanticEmbeddingSyncOptions as SemanticEmbeddingSyncOptions,
  McpSemanticEmbeddingSyncResult as SemanticEmbeddingSyncResult,
  McpSemanticProviderStatus as SemanticProviderStatus,
  McpSemanticDocument as SemanticDocument,
  McpSemanticDocumentResult as SemanticDocumentResult,
  McpSemanticGetOptions as SemanticGetOptions,
  McpSemanticMultiGetOptions as SemanticMultiGetOptions,
} from "../engine/mcp/types.js";
