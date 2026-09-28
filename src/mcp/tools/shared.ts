import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { WriteTargetSource } from "../../kernel/conventions/write-protocol.js";
import type { AssembledEngine } from "../../kernel/engine/assemble.js";
import type { McpEngineAdapter } from "../../kernel/engine/mcp/facade.js";
import type { EngineSearchBackend } from "../../kernel/searchbackend/engine-search-backend.js";

export function jsonText(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

export function errorText(message: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: message,
      },
    ],
  };
}

export class SemanticIndexUnavailableError extends Error {
  constructor() {
    super("The semantic index has not been built yet. Run `oms index sync` to build it.");
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Per-server state and engine resolvers the tool handlers share; built once by `createOMSMcpServer`. */
export interface ToolContext {
  readonly vault: string;
  readonly source: WriteTargetSource;
  readonly engine: AssembledEngine;
  readonly getSemanticEngine: () => AssembledEngine;
  readonly getReadOnlySemanticEngine: () => AssembledEngine | null;
  readonly getReadOnlyCoreSemanticEngine: () => AssembledEngine | null;
  readonly hasEmbeddingModel: () => boolean;
  readonly resolveCreatingDocumentAdapter: () => McpEngineAdapter;
  readonly resolveDocumentAdapter: (publicName: string) => McpEngineAdapter;
  readonly resolveReadOnlyIndexAdapter: () => McpEngineAdapter;
  readonly resolveReadOnlyLexicalAdapter: () => Promise<McpEngineAdapter>;
  readonly hasExplicitEmbeddingIntent: (args: Record<string, unknown> | undefined) => boolean;
  readonly searchBackend: EngineSearchBackend;
}
