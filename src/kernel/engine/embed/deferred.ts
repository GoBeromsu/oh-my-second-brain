/**
 * Deferred embedding primitives — throw-on-use stand-ins for an absent model.
 *
 * Several assemblies run without an embedding model on purpose. Lexical search,
 * document reads, the link graph, axis-first retrieval, and cache-meta status all
 * work off the filesystem and need no vectors, so those engines wire these guards
 * and stay fully usable for everything that does not require embeddings.
 *
 * ADR-007: these are LOUD GUARDS, not fake fallbacks. They never return a
 * projected or hash vector — they throw, so a semantic call reaches a real error
 * rather than fabricated results.
 *
 * The provider is deliberately silent about *which* engine wired it. It is used by
 * the core, ephemeral, read-only, and graph-only assemblies alike, and it once
 * hardcoded "graph-only engine" into its message — so a user running
 * `oms semantic vsearch` on an ordinary model-less vault was told they were on a
 * graph-only engine they never asked for. A guard that misreports the runtime it
 * is guarding is its own kind of dishonest output, so the message now describes
 * only what is actually true: no embedding model is configured.
 */

import type { EmbeddingProvider } from "../types.js";
import { capabilityGuidance } from "./config.js";
import type { EngineStore } from "./store.js";

const GRAPH_ONLY = "graph-only engine";

/** Embedding width advertised by the deferred provider (EmbeddingGemma-300M). */
const DEFERRED_DIMENSIONS = 768;

/**
 * An EmbeddingProvider that throws on embed().
 *
 * Wired by every assembly that runs without an embedding model. `dimensions` is
 * advertised so a downstream store can still be opened with a stable width, but
 * `embed()` rejects loudly. `dispose()` is a safe no-op so engine teardown never
 * crashes.
 */
export function makeDeferredProvider(): EmbeddingProvider {
  return {
    model: "deferred:graph-only",
    dimensions: DEFERRED_DIMENSIONS,
    embed(_text: string): Promise<Float32Array> {
      // The remedy comes from the shared capability guidance rather than a local
      // copy, so this guard names the same environment pair, vault contract file,
      // and setup command the resolver does. A hand-written variant here drifted
      // once already: it named the env pair only, telling a user two of the three
      // ways to configure embeddings and omitting the one-step install.
      return Promise.reject(
        new Error(
          `Embedding provider unavailable. ${capabilityGuidance("embed")} ` +
            "A remote provider also needs its auth variable, e.g. UPSTAGE_API_KEY.",
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
    capabilities: () => ({ vecAvailable: false }),
    upsertLex: () => unavailable(),
    readEmbeddingIdentity: () => unavailable(),
    writeEmbeddingIdentity: () => unavailable(),
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
