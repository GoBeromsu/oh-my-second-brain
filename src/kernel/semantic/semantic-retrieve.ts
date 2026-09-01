import {
  documentGetOptionsFromArgs,
  documentMultiGetOptionsFromArgs,
  embeddingSyncOptionsFromArgs,
  semanticStatusOptionsFromArgs,
  semanticOptionsFromArgs,
  semanticQueryOptionsFromArgs,
  type ParseResult,
} from "./semantic-retrieve-args.js";
import type { McpEngineAdapter } from "../engine/mcp/facade.js";
import { queryOptionsToSubQueries } from "../engine/mcp/query-mapper.js";

export { semanticMcpTools, retrieveContextSemanticInputProperties } from "./semantic-schemas.js";
export { semanticOptionsFromArgs };

/**
 * The op-name set that normally requires a real embedding model. Query is listed
 * here because its default mode is hybrid lex+vec; `isModelOptionalSemanticQueryOp`
 * narrows explicit lex-only calls back onto the core BM25/FTS adapter.
 *
 * oms_get_document / oms_multi_get_documents are NOT here: they form the
 * model-OPTIONAL set ({@link isEngineDocumentOp}). The server resolves them on
 * the vec-capable engine when a model is configured, else the core (lex +
 * file-based) engine — file reads never need a model.
 */
const ENGINE_SEMANTIC_OPS: ReadonlySet<string> = new Set([
  "oms_sync_embeddings",
  "oms_semantic_query",
  "oms_semantic_status",
  "oms_semantic_collections",
  "oms_semantic_contexts",
  "oms_semantic_cleanup",
]);

/**
 * True when `name` is a semantic op. The server uses this together with
 * `isModelOptionalSemanticQueryOp` so vec/HyDE paths loud-guard without a model
 * while explicit lex-only query uses real model-free BM25/FTS.
 */
export function isEngineSemanticOp(name: string): boolean {
  return ENGINE_SEMANTIC_OPS.has(name);
}
export function isModelOptionalSemanticQueryOp(
  name: string,
  args: Record<string, unknown> | undefined,
  vault: string,
): boolean {
  if (name !== "oms_semantic_query") return false;
  const subQueries = queryOptionsToSubQueries(semanticQueryOptionsFromArgs(vault, args));
  return subQueries.length > 0 && subQueries.every((subQuery) => subQuery.type === "lex");
}

/**
 * The op-name set the engine serves WITHOUT requiring a model: the two document
 * reads (plus bare CLI aliases). The server resolves these on the vec-capable
 * engine when a model is configured (so a retrieve_context docid hydrates on the
 * backend that produced it) and on the core engine otherwise — file-based
 * hydration works either way.
 */
const ENGINE_DOCUMENT_OPS: ReadonlySet<string> = new Set([
  "oms_get_document",
  "oms_multi_get_documents",
]);

/**
 * True when `name` is a document read the engine can serve without a model.
 */
export function isEngineDocumentOp(name: string): boolean {
  return ENGINE_DOCUMENT_OPS.has(name);
}

/**
 * Dispatch a semantic / sync / cleanup / document MCP op through the native
 * engine adapter. After the src/search teardown the engine is the single
 * backend: callers supply a vec-capable adapter (model configured) or a core
 * lex + document adapter (model-less); there is no legacy fallback.
 *
 * Returns undefined when `name` is not a semantic op (the caller routes it
 * elsewhere).
 */
export async function handleSemanticTool(
  name: string,
  args: Record<string, unknown> | undefined,
  vault: string,
  adapter: McpEngineAdapter,
): Promise<ParseResult<unknown> | undefined> {
  if (name === "oms_sync_embeddings") {
    return { ok: true, value: await adapter.syncEmbeddings(embeddingSyncOptionsFromArgs(vault, args)) };
  }

  if (name === "oms_semantic_query") {
    return { ok: true, value: await adapter.semanticQuery(semanticQueryOptionsFromArgs(vault, args)) };
  }

  if (name === "oms_semantic_status") {
    return { ok: true, value: await adapter.semanticStatus(semanticStatusOptionsFromArgs(vault, args)) };
  }

  if (name === "oms_semantic_collections") {
    return { ok: true, value: adapter.listCollections(semanticStatusOptionsFromArgs(vault, args)) };
  }

  if (name === "oms_semantic_contexts") {
    return { ok: true, value: await adapter.listContexts(semanticStatusOptionsFromArgs(vault, args)) };
  }

  if (name === "oms_semantic_cleanup") {
    return { ok: true, value: await adapter.cleanup(semanticStatusOptionsFromArgs(vault, args)) };
  }

  if (name === "oms_get_document") {
    const parsed = documentGetOptionsFromArgs(args);
    if (!parsed.ok) return parsed;
    return { ok: true, value: await adapter.getDocument({ ...parsed.value, vault }) };
  }

  if (name === "oms_multi_get_documents") {
    const parsed = documentMultiGetOptionsFromArgs(args);
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      value: await adapter.multiGetDocuments({ ...parsed.value, vault, targets: [...parsed.value.targets] }),
    };
  }

  return undefined;
}
