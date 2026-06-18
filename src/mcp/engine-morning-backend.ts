/**
 * Engine-backed MorningSemanticBackend — adapts the native McpEngineAdapter to
 * the five semantic leaf operations the morning retrieval flow expects.
 *
 * Injected by the MCP server's oms_retrieve_context handler (and any other
 * morning caller) so the context op's semantic leg runs on the native engine
 * while its graph leg stays on the src/graph warm cache. Every adapter op wraps
 * its body in try/catch, so a model-less host degrades to "unavailable"
 * (graph-only context) rather than throwing.
 *
 * After the src/search teardown the morning contract types are the engine
 * contract types (re-exported via src/retrieve/semantic-contract.ts), so this
 * wrapper only threads the sync gate and the default vault — no type bridging.
 */

import type { McpEngineAdapter } from "../engine/mcp/facade.js";
import type { MorningRetrieveOptions, MorningSemanticBackend } from "../retrieve/morning.js";

/**
 * Build a MorningSemanticBackend that routes the five semantic leaf operations
 * through the native engine adapter.
 *
 * @param adapter - The engine adapter (vec-capable when a model is configured;
 *                  a core lex + document adapter otherwise — query degrades to
 *                  lex while vec/HyDE fail fast, and file-based getDocument /
 *                  multiGet keep working).
 * @param vault   - Absolute vault root, used as the default when a leaf op omits
 *                  its own vault (the adapter is vault-scoped).
 */
export function makeEngineMorningBackend(adapter: McpEngineAdapter, vault: string): MorningSemanticBackend {
  return {
    sync(opts: MorningRetrieveOptions) {
      // Same R2 gate as before: never auto-sync unless the caller explicitly
      // asked (syncBeforeSearch). Engine sync is incremental (SHA-256 diff), so
      // even a forced re-sync skips unchanged chunks.
      if (opts.semantic?.syncBeforeSearch !== true) return Promise.resolve(undefined);
      return adapter.syncEmbeddings({
        vault: opts.vault ?? vault,
        collection: opts.semantic.collection,
        index: opts.semantic.index,
        embed: opts.semantic.syncEmbed,
        force: opts.semantic.syncForce,
        chunkStrategy: opts.semantic.chunkStrategy,
        maxDocsPerBatch: opts.semantic.syncMaxDocsPerBatch,
        maxBatchMb: opts.semantic.syncMaxBatchMb,
      });
    },

    status(opts) {
      // semanticStatus is synchronous on the adapter; lift it into the async
      // backend contract.
      return Promise.resolve(adapter.semanticStatus(opts));
    },

    query(opts) {
      return adapter.semanticQuery(opts);
    },

    getDocument(opts) {
      return adapter.getDocument({ ...opts, vault: opts.vault ?? vault });
    },

    multiGet(opts) {
      return adapter.multiGetDocuments({ ...opts, vault: opts.vault ?? vault, targets: [...opts.targets] });
    },
  };
}
