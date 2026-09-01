/**
 * Cross-encoder reranker hook.
 *
 * This module defines the opt-in Reranker interface. The node-llama-cpp
 * implementation below is lazy: constructing it never loads a model or
 * creates a ranking context.
 *
 * Intended production implementations (inject at the integrate phase):
 *   - bge-reranker-v2-m3  (BAAI, Apache-2.0) — strong multilingual reranker,
 *     ~570 M params, load via node-llama-cpp or a local REST endpoint.
 *   - Qwen3-Reranker-0.6B (Alibaba Cloud, Apache-2.0) — lightweight reranker,
 *     good for low-latency on-device use; also loadable via node-llama-cpp.
 *
 * Wire a real impl by passing it to retrieve() as `opts.reranker`.
 */

import type { LlamaRankingContextOptions } from "node-llama-cpp";
import type { ScoredHit } from "../types.js";

/**
 * Opt-in cross-encoder reranker hook.
 *
 * A reranker receives the original query string and a candidate hit list
 * (already fused by RRF) and returns a re-scored / re-ordered list.
 * Implementations may call an external model or REST endpoint; the caller
 * awaits the result before returning the final RetrievalResult[].
 */
export interface Reranker {
  /**
   * Re-score and reorder `hits` with respect to `query`.
   *
   * @param query - The original natural-language query string.
   * @param hits  - RRF-fused candidate list, sorted descending by fused score.
   * @returns A new list sorted descending by the reranker's cross-encoder score.
   *          The returned list may be shorter than `hits` (e.g. top-k precision cut).
   */
  rerank(
    query: string,
    hits: ScoredHit[],
    cancel?: { readonly cancelled: boolean },
  ): Promise<ScoredHit[]>;
}

/** A reranker whose owner can release its resources. */
export interface DisposableReranker extends Reranker {
  dispose(): Promise<void>;
}

type OptionallyDisposableReranker = Reranker & Partial<DisposableReranker>;

/**
 * Narrow seam around node-llama-cpp used by the lazy implementation.
 *
 * Keeping the seam injectable makes the lifecycle contract testable without
 * downloading or loading a model. Production uses the default dynamic loader.
 */
export interface RankingContext {
  rankAll(query: string, documents: string[]): Promise<readonly number[]>;
  dispose(): Promise<void>;
}

export interface RankingModel {
  createRankingContext(options?: LlamaRankingContextOptions): Promise<RankingContext>;
  dispose(): Promise<void>;
}

export type LlamaModelLoader = (modelPath: string) => Promise<RankingModel>;

/** Conservative candidate budget; reranking is opt-in and default-off. */
export const DEFAULT_RERANKER_CANDIDATE_CAP = 50;

/**
 * Options for {@link createLlamaReranker}.
 *
 * `idleUnloadMs` is disabled by default (`0`). Enabling it is useful for
 * memory-constrained hosts, but the model is otherwise retained after its
 * first requested rerank so repeated opt-in calls do not reload native state.
 */
export interface LlamaRerankerOptions {
  readonly modelPath: string;
  readonly candidateCap?: number;
  readonly idleUnloadMs?: number;
  readonly contextOptions?: LlamaRankingContextOptions;
  /** Test seam; production callers should omit this. */
  readonly loadModel?: LlamaModelLoader;
}

async function loadLlamaModel(modelPath: string): Promise<RankingModel> {
  const { getLlama } = await import("node-llama-cpp");
  const llama = await getLlama();
  return llama.loadModel({ modelPath });
}

/**
 * A lazy node-llama-cpp cross-encoder reranker.
 *
 * The model and `LlamaRankingContext` are created only by the first
 * `rerank()` call. Only the first `candidateCap` fused hits are sent to the
 * cross-encoder as source chunk content; hits beyond that safety budget are
 * intentionally omitted. Scores are replaced with the cross-encoder scores
 * and returned descending.
 */
export class LlamaReranker implements Reranker {
  private readonly modelPath: string;
  private readonly candidateCap: number;
  private readonly idleUnloadMs: number;
  private readonly contextOptions: LlamaRankingContextOptions | undefined;
  private readonly loadModel: LlamaModelLoader;
  private model: RankingModel | null = null;
  private context: RankingContext | null = null;
  private loadPromise: Promise<RankingContext> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeCalls = 0;
  private activeDone: Promise<void> | null = null;
  private resolveActiveDone: (() => void) | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(options: LlamaRerankerOptions) {
    const candidateCap = options.candidateCap ?? DEFAULT_RERANKER_CANDIDATE_CAP;
    if (!Number.isSafeInteger(candidateCap) || candidateCap < 1) {
      throw new Error("reranker candidateCap must be a positive safe integer.");
    }
    const idleUnloadMs = options.idleUnloadMs ?? 0;
    if (!Number.isFinite(idleUnloadMs) || idleUnloadMs < 0) {
      throw new Error("reranker idleUnloadMs must be a non-negative number.");
    }
    if (options.modelPath.trim().length === 0) {
      throw new Error("reranker modelPath must be non-empty.");
    }
    this.modelPath = options.modelPath;
    this.candidateCap = candidateCap;
    this.idleUnloadMs = idleUnloadMs;
    this.contextOptions = options.contextOptions;
    this.loadModel = options.loadModel ?? loadLlamaModel;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleUnload(): void {
    this.clearIdleTimer();
    if (this.disposed || this.idleUnloadMs <= 0 || this.context === null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.activeCalls > 0) {
        this.scheduleIdleUnload();
        return;
      }
      void this.unload().catch(() => undefined);
    }, this.idleUnloadMs);
  }

  private async ensureContext(): Promise<RankingContext> {
    if (this.disposed) throw new Error("Reranker has been disposed.");
    if (this.context !== null) return this.context;
    if (this.loadPromise !== null) return this.loadPromise;

    this.loadPromise = (async () => {
      const model = await this.loadModel(this.modelPath);
      this.model = model;
      try {
        const context = await model.createRankingContext(this.contextOptions);
        this.context = context;
        return context;
      } catch (error) {
        this.model = null;
        await model.dispose().catch(() => undefined);
        throw error;
      }
    })().finally(() => {
      this.loadPromise = null;
    });

    return this.loadPromise;
  }

  private async unload(): Promise<void> {
    this.clearIdleTimer();
    const context = this.context;
    const model = this.model;
    this.context = null;
    this.model = null;
    if (context !== null) await context.dispose().catch(() => undefined);
    if (model !== null) await model.dispose().catch(() => undefined);
  }

  /** Release model/context resources; safe before the first rerank call. */
  async dispose(): Promise<void> {
    if (this.disposePromise !== null) {
      return this.disposePromise;
    }
    this.disposed = true;
    this.clearIdleTimer();
    this.disposePromise = (async () => {
      if (this.loadPromise !== null) {
        await this.loadPromise.catch(() => undefined);
      }
      // Context disposal must never race a native rankAll() call. Calls
      // already admitted before dispose() drain before unloading resources.
      if (this.activeDone !== null) await this.activeDone;
      await this.unload();
    })();
    return this.disposePromise;
  }

  async rerank(
    query: string,
    hits: ScoredHit[],
    cancel?: { readonly cancelled: boolean },
  ): Promise<ScoredHit[]> {
    if (hits.length === 0) return [];
    if (this.disposed) throw new Error("Reranker has been disposed.");
    if (cancel?.cancelled) throw new Error("Retrieval cancelled");
    const candidates = hits.slice(0, this.candidateCap);
    for (const candidate of candidates) {
      if (typeof candidate.text !== "string" || candidate.text.trim() === "") {
        throw new Error(
          `reranker requires bounded source content for ${candidate.docPath}#${candidate.chunkOrdinal}; ` +
            "document paths cannot be used as ranking input.",
        );
      }
    }
    this.activeCalls += 1;
    if (this.activeCalls === 1) {
      this.activeDone = new Promise<void>((resolve) => {
        this.resolveActiveDone = resolve;
      });
    }
    try {
      const context = await this.ensureContext();
      if (cancel?.cancelled) throw new Error("Retrieval cancelled");
      const scores = await context.rankAll(query, candidates.map((hit) => hit.text!));
      if (cancel?.cancelled) throw new Error("Retrieval cancelled");
      if (scores.length !== candidates.length) {
        throw new Error(
          `reranker returned ${scores.length} scores for ${candidates.length} candidates.`,
        );
      }
      if (scores.some((score) => !Number.isFinite(score))) {
        throw new Error("reranker returned a non-finite score.");
      }
      return candidates
        .map((hit, index) => ({ ...hit, score: scores[index]! }))
        .sort((left, right) => right.score - left.score);
    } finally {
      this.activeCalls -= 1;
      if (this.activeCalls === 0) {
        this.resolveActiveDone?.();
        this.resolveActiveDone = null;
        this.activeDone = null;
      }
      this.scheduleIdleUnload();
    }
  }
}

/**
 * Construct a lazy reranker. No model import, native load, or context
 * creation occurs until the returned reranker's `rerank()` is requested.
 */
export function createLlamaReranker(options: LlamaRerankerOptions): LlamaReranker {
  return new LlamaReranker(options);
}

/**
 * Lazy owner for a reranker assembled from a factory.
 *
 * Construction starts only for a non-empty, non-cancelled request. The owner
 * retains the factory result for its lifetime and releases it after all
 * admitted reranks have completed.
 */
class LazyOwnedReranker implements DisposableReranker {
  private readonly factory: () => Reranker | Promise<Reranker>;
  private inner: Reranker | null = null;
  private constructionPromise: Promise<Reranker> | null = null;
  private activeCalls = 0;
  private activeDone: Promise<void> | null = null;
  private resolveActiveDone: (() => void) | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(factory: () => Reranker | Promise<Reranker>) {
    this.factory = factory;
  }

  private ensureInner(): Promise<Reranker> {
    if (this.inner !== null) return Promise.resolve(this.inner);
    if (this.constructionPromise !== null) return this.constructionPromise;

    this.constructionPromise = Promise.resolve()
      .then(this.factory)
      .then((inner) => {
        this.inner = inner;
        return inner;
      });
    return this.constructionPromise;
  }

  private admitCall(): void {
    this.activeCalls += 1;
    if (this.activeCalls === 1) {
      this.activeDone = new Promise<void>((resolve) => {
        this.resolveActiveDone = resolve;
      });
    }
  }

  private finishCall(): void {
    this.activeCalls -= 1;
    if (this.activeCalls === 0) {
      this.resolveActiveDone?.();
      this.resolveActiveDone = null;
      this.activeDone = null;
    }
  }

  rerank(
    query: string,
    hits: ScoredHit[],
    cancel?: { readonly cancelled: boolean },
  ): Promise<ScoredHit[]> {
    if (hits.length === 0) return Promise.resolve([]);
    if (this.disposed) return Promise.reject(new Error("Reranker has been disposed."));
    if (cancel?.cancelled) return Promise.reject(new Error("Retrieval cancelled"));

    this.admitCall();
    return this.ensureInner()
      .then((inner) => {
        if (cancel?.cancelled) throw new Error("Retrieval cancelled");
        return inner.rerank(query, hits, cancel);
      })
      .finally(() => {
        this.finishCall();
      });
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.disposeOwned();
    return this.disposePromise;
  }

  private async disposeOwned(): Promise<void> {
    let constructionFailed = false;
    let constructionError: unknown;
    if (this.constructionPromise !== null) {
      try {
        await this.constructionPromise;
      } catch (error) {
        constructionFailed = true;
        constructionError = error;
      }
    }
    if (this.activeDone !== null) await this.activeDone;

    const inner = this.inner as OptionallyDisposableReranker | null;
    await inner?.dispose?.();

    if (constructionFailed) throw constructionError;
  }
}

/**
 * Create an assembly-owned reranker that initializes its factory product on
 * the first non-empty rerank request.
 */
export function createLazyOwnedReranker(
  factory: () => Reranker | Promise<Reranker>,
): DisposableReranker {
  return new LazyOwnedReranker(factory);
}

// A passthrough reranker deliberately does NOT live here.
//
// It used to, exported as the "default no-op reranker", which made a fake
// capability reachable as a real one: the MCP facade treats any defined reranker
// as available, so injecting a passthrough made an explicit `rerank: true` request
// report success while returning the unchanged RRF order. Reranking is opt-in
// (ADR-011) and an unavailable capability must fail loudly (ADR-007), so the
// correct production state is an absent reranker, not an inert one.
//
// Tests that need an inert `Reranker` import it from `./passthrough.test-helper.js`.
