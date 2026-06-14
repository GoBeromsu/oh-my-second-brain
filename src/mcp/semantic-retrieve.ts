import {
  cleanupSemanticStore,
  getSemanticDocument,
  listSemanticCollections,
  listSemanticContexts,
  multiGetSemanticDocuments,
  querySemanticStore,
  readSemanticStatus,
  syncSemanticEmbeddingStore,
} from "../search/semantic.js";
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
 * The op-name set the native engine adapter owns: sync / query / status /
 * collections / contexts / cleanup, plus the bare CLI aliases. This MIRRORS the
 * adapter-routed branches in handleSemanticTool below — keep the two in lockstep.
 *
 * oms_get_document / oms_multi_get_documents are NOT here: they form a separate,
 * model-OPTIONAL set ({@link isEngineDocumentOp}). The server routes them to the
 * engine only when a model is already configured (so a retrieve_context docid
 * hydrates on the backend that produced it); a model-less host keeps them on
 * src/search instead of forcing engine assembly (which throws under ADR-007).
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
 * True when `name` is a semantic op the native engine adapter owns. The main
 * stdio server uses this to lazily assemble the engine ONLY for these ops,
 * keeping get/multi_get (GAP-9) and every non-semantic tool off the model path.
 */
export function isEngineSemanticOp(name: string): boolean {
  return ENGINE_SEMANTIC_OPS.has(name);
}

/**
 * The op-name set the engine adapter CAN serve but does NOT require a model for:
 * the two document reads (plus bare CLI aliases). The server gates these on an
 * already-configured model via trySemanticEngineAdapter — present → engine
 * (real-path docids, file-based hydration), absent → src/search. Keeping them
 * separate from ENGINE_SEMANTIC_OPS is what lets a model-less doc read stay off
 * the engine-assembly path (ADR-007) while a model-ful one hydrates a
 * retrieve_context hit on the same backend that produced its docid.
 */
const ENGINE_DOCUMENT_OPS: ReadonlySet<string> = new Set([
  "oms_get_document",
  "get",
  "oms_multi_get_documents",
  "multi_get",
]);

/**
 * True when `name` is a document read the engine adapter can serve. Unlike
 * {@link isEngineSemanticOp}, the server resolves the adapter for these ops
 * leniently (model present → engine, absent → src/search), never forcing engine
 * assembly on a model-less host.
 */
export function isEngineDocumentOp(name: string): boolean {
  return ENGINE_DOCUMENT_OPS.has(name);
}

/**
 * Dispatch a semantic / sync / cleanup / document MCP op.
 *
 * When `adapter` is supplied (the main stdio MCP server, post-swap), the
 * native engine owns sync / query / status / collections / contexts / cleanup.
 * When it is absent (the localhost semantic-http CLI), every op falls back to
 * the src/search layer — the legacy path that predates the engine swap.
 *
 * oms_get_document / oms_multi_get_documents follow the SAME adapter channel:
 * engine when supplied, src/search otherwise. The server passes an adapter for
 * them only when a model is configured (isEngineDocumentOp), so a model-less
 * doc read stays on src/search.
 */
export async function handleSemanticTool(
  name: string,
  args: Record<string, unknown> | undefined,
  vault: string,
  adapter?: McpEngineAdapter | null,
): Promise<ParseResult<unknown> | undefined> {
  if (name === "oms_sync_embeddings") {
    if (adapter) {
      return { ok: true, value: await adapter.syncEmbeddings(embeddingSyncOptionsFromArgs(vault, args)) };
    }
    return { ok: true, value: await syncSemanticEmbeddingStore(embeddingSyncOptionsFromArgs(vault, args)) };
  }

  if (name === "oms_semantic_query" || name === "query") {
    if (adapter) {
      return { ok: true, value: await adapter.semanticQuery(semanticQueryOptionsFromArgs(vault, args)) };
    }
    return { ok: true, value: await querySemanticStore(semanticQueryOptionsFromArgs(vault, args)) };
  }

  if (name === "oms_semantic_status" || name === "status") {
    if (adapter) {
      return { ok: true, value: adapter.semanticStatus(semanticStatusOptionsFromArgs(vault, args)) };
    }
    return { ok: true, value: await readSemanticStatus(semanticStatusOptionsFromArgs(vault, args)) };
  }

  if (name === "oms_semantic_collections") {
    const statusOptions = semanticStatusOptionsFromArgs(vault, args);
    if (adapter) {
      return { ok: true, value: adapter.listCollections(statusOptions) };
    }
    return { ok: true, value: await listSemanticCollections(statusOptions) };
  }

  if (name === "oms_semantic_contexts") {
    const statusOptions = semanticStatusOptionsFromArgs(vault, args);
    if (adapter) {
      return { ok: true, value: adapter.listContexts(statusOptions) };
    }
    return { ok: true, value: await listSemanticContexts(statusOptions) };
  }

  if (name === "oms_semantic_cleanup") {
    const statusOptions = semanticStatusOptionsFromArgs(vault, args);
    if (adapter) {
      return { ok: true, value: await adapter.cleanup(statusOptions) };
    }
    return { ok: true, value: await cleanupSemanticStore(statusOptions) };
  }

  if (name === "oms_get_document" || name === "get") {
    const parsed = documentGetOptionsFromArgs(args);
    if (!parsed.ok) return parsed;
    if (adapter) {
      return { ok: true, value: await adapter.getDocument({ ...parsed.value, vault }) };
    }
    return { ok: true, value: await getSemanticDocument({ ...parsed.value, vault }) };
  }

  if (name === "oms_multi_get_documents" || name === "multi_get") {
    const parsed = documentMultiGetOptionsFromArgs(args);
    if (!parsed.ok) return parsed;
    if (adapter) {
      return {
        ok: true,
        value: await adapter.multiGetDocuments({ ...parsed.value, vault, targets: [...parsed.value.targets] }),
      };
    }
    return { ok: true, value: await multiGetSemanticDocuments({ ...parsed.value, vault }) };
  }

  return undefined;
}
