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

export { semanticMcpTools, retrieveContextSemanticInputProperties } from "./semantic-schemas.js";
export { semanticOptionsFromArgs };

/**
 * The op-name set that REQUIRES a real embedding model: sync / query / status /
 * collections / contexts / cleanup, plus the bare CLI aliases. The main stdio
 * server assembles the vec-capable engine EAGERLY for these so a model-less host
 * loud-guards (ADR-007) instead of silently degrading.
 *
 * oms_get_document / oms_multi_get_documents are NOT here: they form the
 * model-OPTIONAL set ({@link isEngineDocumentOp}). The server resolves them on
 * the vec-capable engine when a model is configured, else the core (lex +
 * file-based) engine — file reads never need a model.
 */
const ENGINE_SEMANTIC_OPS: ReadonlySet<string> = new Set([
  "oms_sync_embeddings",
  "oms_semantic_query",
  "query",
  "oms_semantic_status",
  "status",
  "oms_semantic_collections",
  "oms_semantic_contexts",
  "oms_semantic_cleanup",
]);

/**
 * True when `name` is a semantic op that requires the vec-capable engine. The
 * main stdio server uses this to assemble the model-backed engine ONLY for these
 * ops, keeping get/multi_get (GAP-9) and every non-semantic tool off the eager
 * model path.
 */
export function isEngineSemanticOp(name: string): boolean {
  return ENGINE_SEMANTIC_OPS.has(name);
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
  "get",
  "oms_multi_get_documents",
  "multi_get",
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

  if (name === "oms_semantic_query" || name === "query") {
    return { ok: true, value: await adapter.semanticQuery(semanticQueryOptionsFromArgs(vault, args)) };
  }

  if (name === "oms_semantic_status" || name === "status") {
    return { ok: true, value: adapter.semanticStatus(semanticStatusOptionsFromArgs(vault, args)) };
  }

  if (name === "oms_semantic_collections") {
    return { ok: true, value: adapter.listCollections(semanticStatusOptionsFromArgs(vault, args)) };
  }

  if (name === "oms_semantic_contexts") {
    return { ok: true, value: adapter.listContexts(semanticStatusOptionsFromArgs(vault, args)) };
  }

  if (name === "oms_semantic_cleanup") {
    return { ok: true, value: await adapter.cleanup(semanticStatusOptionsFromArgs(vault, args)) };
  }

  if (name === "oms_get_document" || name === "get") {
    const parsed = documentGetOptionsFromArgs(args);
    if (!parsed.ok) return parsed;
    return { ok: true, value: await adapter.getDocument({ ...parsed.value, vault }) };
  }

  if (name === "oms_multi_get_documents" || name === "multi_get") {
    const parsed = documentMultiGetOptionsFromArgs(args);
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      value: await adapter.multiGetDocuments({ ...parsed.value, vault, targets: [...parsed.value.targets] }),
    };
  }

  return undefined;
}
