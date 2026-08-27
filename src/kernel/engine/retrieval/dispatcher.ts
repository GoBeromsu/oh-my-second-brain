/**
 * Typed sub-query dispatcher.
 *
 * Routes a TypedSubQuery[] fan-out to the appropriate retrieval backends
 * (lexical BM25, vector-ANN, HyDE, graph traversal), then fuses the per-type
 * ranked lists via RRF and applies a provenance-grade score boost.
 *
 * Resilience patterns (idea-only, no verbatim code):
 *   - P-08 two-layer retry — inner async retry wraps each backend call.
 *   - gajae-code cancel token (MIT) — lightweight cancellation passed through
 *     every async step.
 */

import type {
  EmbeddingProvider,
  GphQuery,
  Provenance,
  RetrievalResult,
  ScoredHit,
  TypedSubQuery,
  VectorStore,
} from "../types.js";
import { fuseRRF } from "./rrf.js";

type QueryEmbeddingProvider = EmbeddingProvider & {
  readonly embedQuery?: (text: string) => Promise<Float32Array>;
};

function assertFiniteVector(vector: unknown, expectedDimensions: number): asserts vector is Float32Array {
  if (!(vector instanceof Float32Array)) {
    throw new Error("Embedding provider returned a vector that is not a Float32Array.");
  }
  if (vector.length !== expectedDimensions) {
    throw new Error(
      `Embedding provider returned ${vector.length} dimensions; expected ${expectedDimensions}.`,
    );
  }
  for (let index = 0; index < vector.length; index += 1) {
    if (!Number.isFinite(vector[index])) {
      throw new Error(`Embedding provider returned a non-finite vector value at index ${index}.`);
    }
  }
}

async function embedQuery(
  provider: EmbeddingProvider,
  text: string,
): Promise<Float32Array> {
  const queryProvider = provider as QueryEmbeddingProvider;
  return queryProvider.embedQuery?.(text) ?? provider.embed(text);
}

// ---------------------------------------------------------------------------
// Cancel token
// ---------------------------------------------------------------------------

/** Lightweight cancellation handle. Pass to dispatch() to abort in-flight work. */
export interface CancelToken {
  readonly cancelled: boolean;
  cancel(): void;
}

/** Create a new mutable cancel token. */
export function createCancelToken(): CancelToken {
  let cancelled = false;
  return {
    get cancelled(): boolean {
      return cancelled;
    },
    cancel(): void {
      cancelled = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Two-layer retry (P-08-style, no external dep)
// ---------------------------------------------------------------------------

/**
 * Retry `fn` up to `maxAttempts` times, aborting early if `cancel` is set.
 * The outer layer catches all errors; the inner re-attempt is immediate.
 * A 50 ms back-off is applied between the two attempts.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  cancel: CancelToken,
  maxAttempts = 2,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (cancel.cancelled) throw new Error("Retrieval cancelled");
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Back-off only between attempts, not after the final one
      if (attempt < maxAttempts - 1 && !cancel.cancelled) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// HyDE generator
// ---------------------------------------------------------------------------

/**
 * Injectable HyDE (Hypothetical Document Embeddings) generator.
 * Given a query, produces a hypothetical answer document whose embedding
 * is closer to relevant documents than the raw query embedding.
 *
 * M1 default: identity stub — embeds the query text directly.
 * Intended M2+ impl: prompt an LLM to write a short hypothetical passage,
 * then embed that passage.
 */
export type HydeGenerator = (query: string) => Promise<string>;

/** Default no-op HyDE generator: returns the query unchanged. */
const defaultHydeGenerator: HydeGenerator = (query: string) =>
  Promise.resolve(query);

// ---------------------------------------------------------------------------
// Provenance boost
// ---------------------------------------------------------------------------

const PROVENANCE_BOOST: Record<Provenance, number> = {
  authored: 0.02,   // first-person authored notes — highest trust
  curated: 0.01,    // deliberately imported / curated references
  "external-raw": 0, // raw external content — no boost
};

/**
 * Apply the provenance signal without putting it on a different scale from
 * RRF. RRF scores are bounded by the number of lists and `rrfK` (roughly
 * 0.016 for one rank-1 list with k=60), so adding a raw 0.02 would let a
 * low-ranked authored hit leap over a stronger multi-list result. A
 * multiplicative adjustment keeps the signal monotonic and proportional to
 * the fused score.
 */
export function applyProvenanceBoost(score: number, provenance?: Provenance): number {
  const boost = provenance === undefined ? 0 : PROVENANCE_BOOST[provenance];
  return score * (1 + boost);
}

// ---------------------------------------------------------------------------
// Dispatcher dependencies (injectable for testing and wiring)
// ---------------------------------------------------------------------------

/**
 * Preregistered retrieval policies used by the measurement harness.
 *
 * The policy is deliberately part of the production dispatcher dependency
 * graph rather than a harness-only score transform: every arm therefore
 * exercises the same retrieval implementation that ships to callers.
 */
export type DispatcherPolicy = "boost-additive" | "boost-k-scale" | "boost-per-list" | "boost-zero";
export const DISPATCHER_POLICIES = Object.freeze([
  "boost-additive",
  "boost-k-scale",
  "boost-per-list",
  "boost-zero",
] as const);
export const PREREGISTERED_ARM_POLICIES = Object.freeze(["boost-k-scale", "boost-per-list", "boost-zero"] as const);
export const DEFAULT_DISPATCHER_POLICY: DispatcherPolicy = "boost-additive";

export interface DispatcherDeps {
  /** SQLite-backed vector + lexical store (C1). */
  store: VectorStore;
  /** Embedding provider (C1). */
  embed: EmbeddingProvider;
  /**
   * Graph traversal function (C2 — injected at integrate phase).
   * When absent, "graph" sub-queries return an empty list.
   */
  graphTraverse?: (query: GphQuery) => Promise<ScoredHit[]>;
  /**
   * HyDE generator — injectable; defaults to identity stub for M1.
   * Replace with an LLM-backed generator to enable full HyDE.
   */
  hydeGenerator?: HydeGenerator;
  /**
   * Provenance resolver: maps a vault-relative docPath to its curation grade.
   * When absent, no provenance boost is applied.
   */
  provenanceMap?: (docPath: string) => Provenance;
  /** RRF smoothing constant (default 60). */
  rrfK?: number;
  /** Production policy defaults to the shipped boost-additive baseline; the other three are preregistered experiment arms. */
  policy?: DispatcherPolicy;
  /** Default BFS hop depth for graph sub-queries (default 2). */
  graphDepth?: number;
}

// ---------------------------------------------------------------------------
// Per-type dispatch
// ---------------------------------------------------------------------------

async function dispatchOne(
  sub: TypedSubQuery,
  deps: DispatcherDeps,
  k: number,
  cancel: CancelToken,
  collection?: string,
): Promise<ScoredHit[]> {
  switch (sub.type) {
    case "lex": {
      return withRetry(
        () => Promise.resolve(
          collection === undefined
            ? deps.store.queryLex(sub.query, k)
            : deps.store.queryLex(sub.query, k, collection),
        ),
        cancel,
      );
    }

    case "vec": {
      const vec = await withRetry(() => embedQuery(deps.embed, sub.query), cancel);
      assertFiniteVector(vec, deps.embed.dimensions);
      return withRetry(
        () => Promise.resolve(
          collection === undefined ? deps.store.queryVec(vec, k) : deps.store.queryVec(vec, k, collection),
        ),
        cancel,
      );
    }

    case "hyde": {
      const generator = deps.hydeGenerator ?? defaultHydeGenerator;
      const hypoDoc = await withRetry(() => generator(sub.query), cancel);
      const vec = await withRetry(() => embedQuery(deps.embed, hypoDoc), cancel);
      assertFiniteVector(vec, deps.embed.dimensions);
      return withRetry(
        () => Promise.resolve(
          collection === undefined ? deps.store.queryVec(vec, k) : deps.store.queryVec(vec, k, collection),
        ),
        cancel,
      );
    }

    case "graph": {
      if (!deps.graphTraverse) return [];
      const gphQuery: GphQuery = {
        mode: "bfs",
        seed: sub.query,
        depth: deps.graphDepth ?? 2,
      };
      return withRetry(() => deps.graphTraverse!(gphQuery), cancel);
    }
  }
}

/**
 * Apply the per-list policy before RRF ranking. RRF consumes rank positions,
 * so the weighted score must be used to establish each list's order rather
 * than applied after fusion (which would be the k-scale policy).
 */
function rankListForPolicy(
  list: ScoredHit[],
  deps: DispatcherDeps,
  policy: DispatcherPolicy,
): ScoredHit[] {
  if (policy !== "boost-per-list") return list;
  return [...list].sort((left, right) => {
    const leftScore = applyProvenanceBoost(left.score, deps.provenanceMap?.(left.docPath));
    const rightScore = applyProvenanceBoost(right.score, deps.provenanceMap?.(right.docPath));
    return rightScore - leftScore ||
      left.docPath.localeCompare(right.docPath) ||
      left.chunkOrdinal - right.chunkOrdinal;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a hybrid multi-modal query and fuse results via RRF.
 *
 * @param subQueries - One or more typed sub-queries (lex / vec / hyde / graph).
 * @param deps       - Injected backend dependencies.
 * @param k          - Number of hits to request from each backend (default 10).
 * @param cancel     - Optional cancel token; a fresh token is created if absent.
 * @returns Fused and provenance-boosted RetrievalResult[], sorted descending by score.
 */
export async function dispatch(
  subQueries: TypedSubQuery[],
  deps: DispatcherDeps,
  k = 10,
  cancel?: CancelToken,
  collection?: string,
): Promise<RetrievalResult[]> {
  const token = cancel ?? createCancelToken();
  const rrfK = deps.rrfK ?? 60;
  const policy = deps.policy ?? DEFAULT_DISPATCHER_POLICY;
  if (!Number.isSafeInteger(k) || k < 0) {
    throw new Error("Retrieval candidate count k must be a non-negative safe integer.");
  }
  if (!Number.isFinite(rrfK) || rrfK < 0) {
    throw new Error("RRF smoothing constant k must be a finite non-negative number.");
  }
  if (!(DISPATCHER_POLICIES as readonly string[]).includes(policy)) {
    throw new Error(`Unknown dispatcher policy: ${String(policy)}`);
  }

  if (subQueries.length === 0) return [];

  // Execute all sub-queries in parallel (each with its own retry envelope)
  const rankedLists = await Promise.all(
    subQueries.map((sub) => dispatchOne(sub, deps, k, token, collection)),
  );
  const policyLists = rankedLists.map((list) =>
    rankListForPolicy(list, deps, policy),
  );

  // Build per-type score index for the perTypeScores field
  // key = "docPath\0chunkOrdinal" → type → max raw score from that type
  const typeScores = new Map<string, Map<string, number>>();
  for (let i = 0; i < subQueries.length; i++) {
    const type = subQueries[i]!.type;
    const list = policyLists[i]!;
    for (const hit of list) {
      const key = `${hit.docPath}\x00${hit.chunkOrdinal}`;
      const perType = typeScores.get(key) ?? new Map<string, number>();
      const prev = perType.get(type) ?? 0;
      if (hit.score > prev) perType.set(type, hit.score);
      typeScores.set(key, perType);
    }
  }

  // Fuse with RRF
  const fused = fuseRRF(policyLists, rrfK, {
    preserveInputOrder: policy === "boost-per-list",
  });

  // Build final results with provenance boost and per-type breakdown.
  const results = fused.map((hit) => {
    const key = `${hit.docPath}\x00${hit.chunkOrdinal}`;
    const provenance = deps.provenanceMap?.(hit.docPath);
    const boost = provenance === undefined ? 0 : PROVENANCE_BOOST[provenance];

    const perTypeMap = typeScores.get(key);
    const perTypeScores: Record<string, number> | undefined =
      perTypeMap !== undefined && perTypeMap.size > 0
        ? Object.fromEntries(perTypeMap)
        : undefined;

    return {
      docPath: hit.docPath,
      score: policy === "boost-additive"
        ? hit.score + boost
        : policy === "boost-k-scale"
          ? applyProvenanceBoost(hit.score, provenance)
          : hit.score,
      provenance,
      perTypeScores,
    };
  });
  if (policy === "boost-additive") return results;

  return results.sort(
    (a, b) =>
      b.score - a.score ||
      a.docPath.localeCompare(b.docPath),
  );
}
