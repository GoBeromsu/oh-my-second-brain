/**
 * Deferred (graph-only) embedding primitives.
 *
 * The native engine's graph subsystem — buildGraph, the node index, axis-first
 * retrieval, and cache-meta status — needs NO embeddings: it scans markdown,
 * frontmatter, folders, and wikilinks off the filesystem. assembleGraphOnlyEngine()
 * wires the McpEngineAdapter with these throw-on-use stand-ins so graph ops run
 * model-free, while any accidental semantic / vector call fails loudly instead of
 * silently fabricating vectors.
 *
 * ADR-007: these are LOUD GUARDS, not fake fallbacks. They never return a
 * projected / hash vector — they throw. Real semantic retrieval stays on the
 * src/search layer until the engine reaches output parity (Option-1 swap).
 *
 * R18: no runtime import from src/search.
 */

import type { EmbeddingProvider } from "../types.js";
import type { EngineStore } from "./store.js";

const GRAPH_ONLY = "graph-only engine";

/** Embedding width advertised by the deferred provider (EmbeddingGemma-300M). */
const DEFERRED_DIMENSIONS = 768;

/**
 * An EmbeddingProvider that throws on embed().
 *
 * Used by the graph-only engine, where no model is loaded and embeddings are
 * never produced. `dimensions` is advertised so a downstream store could still
 * be opened with a stable width, but `embed()` rejects loudly. `dispose()` is a
 * safe no-op so engine teardown never crashes.
 */
export function makeDeferredProvider(): EmbeddingProvider {
  return {
    model: "deferred:graph-only",
    dimensions: DEFERRED_DIMENSIONS,
    embed(_text: string): Promise<Float32Array> {
      return Promise.reject(
        new Error(
          `${GRAPH_ONLY}: embedding provider unavailable. Set OMS_MODEL_PATH or ` +
            `UPSTAGE_API_KEY for engine semantic ops; semantic retrieval otherwise ` +
            `stays on the src/search layer.`,
        ),
      );
    },
    async dispose(): Promise<void> {
      // no native resources held
    },
  };
}

/**
 * An EngineStore that throws on every persistence / query call except close().
 *
 * The graph subsystem never touches the store, so these guards are never hit in
 * normal operation; they exist to fail loudly if a semantic path is ever wired
 * here by mistake (ADR-007 — never fabricate vectors). `close()` is a safe no-op
 * so dispose() can run unconditionally.
 */
export function makeDeferredStore(): EngineStore {
  const unavailable = (): never => {
    throw new Error(
      `${GRAPH_ONLY}: vector/lexical store unavailable. Engine semantic ops require ` +
        `a real embedding provider; graph ops do not use the store.`,
    );
  };
  return {
    upsert: () => unavailable(),
    queryVec: () => unavailable(),
    queryLex: () => unavailable(),
    getShas: () => unavailable(),
    clearDocument: () => unavailable(),
    listDocPaths: () => unavailable(),
    close: () => {
      // nothing to close
    },
  };
}
