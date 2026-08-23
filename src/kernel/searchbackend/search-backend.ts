import type {
  McpSemanticQueryResult,
  McpSemanticTypedSearch,
} from "../engine/mcp/types.js";

/** A plain query or explicit retrieval sub-queries, but never both. */
export type SearchRequest =
  | {
      readonly query: string;
      readonly searches?: never;
      readonly limit?: number;
      readonly minScore?: number;
      /** Context that disambiguates a query without becoming a sub-query. */
      readonly intent?: string;
    }
  | {
      readonly query?: never;
      readonly searches: readonly McpSemanticTypedSearch[];
      readonly limit?: number;
      readonly minScore?: number;
      /** Context that disambiguates a query without becoming a sub-query. */
      readonly intent?: string;
    };

/** The portable search capability exposed by an OMS retrieval backend. */
export interface SearchBackend {
  search(request: SearchRequest): Promise<McpSemanticQueryResult>;
}
