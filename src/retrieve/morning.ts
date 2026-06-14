import {
  exploreLocalGraph,
  type GraphExploreNode,
  type GraphExploreOptions,
  type GraphExploreResult,
} from "../graph/explore.js";
import {
  getSemanticDocument,
  multiGetSemanticDocuments,
  querySemanticStore,
  readSemanticStatus,
  type SemanticDocument,
  type SemanticDocumentResult,
  type SemanticEmbeddingSyncResult,
  type SemanticGetOptions,
  type SemanticHitEvidence,
  type SemanticMultiGetOptions,
  type SemanticProviderStatus,
  type SemanticQueryOptions,
  type SemanticQueryResult,
  type SemanticSearchHit,
  type SemanticStatusOptions,
} from "../search/semantic.js";
import { syncRetrieveEmbeddings } from "./embedding-sync.js";

export type MorningHitSource = "oms-seed" | "oms-neighbor" | "oms-semantic";
export type SemanticFusionScope = "global" | "graph";
export type SemanticHydrateMode = "none" | "top" | "all" | "targets";

export interface MorningRetrieveOptions extends GraphExploreOptions {
  readonly semantic?: {
    readonly enabled?: boolean;
    readonly collection?: string;
    readonly limit?: number;
    readonly scope?: SemanticFusionScope;
    readonly mode?: SemanticQueryOptions["mode"];
    readonly intent?: string;
    readonly searches?: SemanticQueryOptions["searches"];
    readonly lex?: string;
    readonly vec?: string;
    readonly hyde?: string;
    readonly minScore?: number;
    readonly all?: boolean;
    readonly format?: SemanticQueryOptions["format"];
    readonly full?: boolean;
    readonly lineNumbers?: boolean;
    readonly fullPath?: boolean;
    readonly index?: string;
    readonly storage?: SemanticQueryOptions["storage"]; readonly modelPath?: string;
    readonly chunkStrategy?: string;
    readonly candidateLimit?: number;
    readonly noRerank?: boolean;
    readonly hydrate?: SemanticHydrateMode;
    readonly hydrateTargets?: readonly string[];
    readonly hydrateLineLimit?: number;
    readonly hydrateMaxBytes?: number;
    readonly hydrateFromLine?: number;
    readonly hydrateLineCount?: number;
    readonly syncBeforeSearch?: boolean;
    readonly syncEnsureCollection?: boolean;
    readonly syncUpdate?: boolean;
    readonly syncEmbed?: boolean;
    readonly syncForce?: boolean;
    readonly syncPull?: boolean;
    readonly syncMaxDocsPerBatch?: number;
    readonly syncMaxBatchMb?: number;
    readonly syncStorage?: SemanticQueryOptions["storage"]; readonly syncModelPath?: string;
  };
}

export interface MorningRetrieveHit {
  readonly source: MorningHitSource;
  readonly path: string;
  readonly title?: string;
  readonly score: number;
  readonly snippet: string;
  readonly docid?: string;
  readonly uri?: string;
  readonly line?: number;
  readonly context?: string;
  readonly evidence?: SemanticHitEvidence;
  readonly graphReasons?: GraphExploreNode["reasons"];
}

export interface MorningRetrieveResult {
  readonly mode: "oms-local-graph-semantic-fusion";
  readonly providers: {
    readonly graph: GraphExploreResult["provider"];
    readonly semantic: SemanticProviderStatus | { readonly available: false; readonly reason: "disabled" };
  };
  readonly graph: GraphExploreResult;
  readonly embeddingSync?: SemanticEmbeddingSyncResult;
  readonly semanticHits: readonly SemanticSearchHit[];
  readonly semanticDocuments: readonly SemanticDocument[];
  readonly hits: readonly MorningRetrieveHit[];
}

/**
 * Pluggable semantic backend for the morning retrieval flow.
 *
 * Abstracts the five semantic leaf operations so the caller chooses the
 * implementation without morning.ts knowing which one it is:
 *   - {@link defaultMorningSemanticBackend} → the model-free src/search layer.
 *   - makeEngineMorningBackend(...) (src/mcp/engine-morning-backend.ts) → the
 *     native EmbeddingGemma engine, injected by the MCP server once a real
 *     model is configured.
 *
 * query + getDocument + multiGet MUST come from the SAME backend: the engine
 * emits real-path docids that only its own file-based hydration resolves, so a
 * split backend (engine query + src/search hydration) would strand every hit.
 */
export interface MorningSemanticBackend {
  readonly sync: (opts: MorningRetrieveOptions) => Promise<SemanticEmbeddingSyncResult | undefined>;
  readonly status: (opts: SemanticStatusOptions) => Promise<SemanticProviderStatus>;
  readonly query: (opts: SemanticQueryOptions) => Promise<SemanticQueryResult>;
  readonly getDocument: (opts: SemanticGetOptions) => Promise<SemanticDocumentResult>;
  readonly multiGet: (opts: SemanticMultiGetOptions) => Promise<SemanticDocumentResult>;
}

/**
 * Default semantic backend: the mature, model-free src/search layer (SHA-1
 * hash embeddings + JSON/SQLite store). Used by the CLI and by any caller that
 * does not inject an engine-backed backend, so non-MCP paths are unchanged.
 */
export const defaultMorningSemanticBackend: MorningSemanticBackend = {
  sync: (opts) => syncRetrieveEmbeddings(opts),
  status: (opts) => readSemanticStatus(opts),
  query: (opts) => querySemanticStore(opts),
  getDocument: (opts) => getSemanticDocument(opts),
  multiGet: (opts) => multiGetSemanticDocuments(opts),
};

function graphHit(source: "oms-seed" | "oms-neighbor", node: GraphExploreNode): MorningRetrieveHit {
  return {
    source,
    path: node.path,
    score: node.score,
    snippet: node.bodyPreview,
    graphReasons: node.reasons,
  };
}

function semanticHit(hit: SemanticSearchHit): MorningRetrieveHit {
  return {
    source: "oms-semantic",
    path: hit.path,
    title: hit.title,
    score: hit.score,
    snippet: hit.snippet,
    docid: hit.docid,
    uri: hit.uri,
    line: hit.line,
    context: hit.context,
    evidence: hit.evidence,
  };
}

function graphCandidatePaths(graph: GraphExploreResult): Set<string> {
  return new Set([
    ...graph.seeds.map((node) => node.path),
    ...graph.neighbors.map((node) => node.path),
  ]);
}

function filteredSemanticHits(
  opts: MorningRetrieveOptions,
  graph: GraphExploreResult,
  hits: readonly SemanticSearchHit[],
): readonly SemanticSearchHit[] {
  if (opts.semantic?.scope !== "graph") return hits;
  const allowedPaths = graphCandidatePaths(graph);
  return hits.filter((hit) => allowedPaths.has(hit.path));
}

function semanticQueryOptions(opts: MorningRetrieveOptions): SemanticQueryOptions {
  return {
    query: opts.query ?? "",
    vault: opts.vault,
    collection: opts.semantic?.collection,
    limit: opts.semantic?.limit ?? opts.limit,
    mode: opts.semantic?.mode,
    intent: opts.semantic?.intent,
    searches: opts.semantic?.searches,
    lex: opts.semantic?.lex,
    vec: opts.semantic?.vec,
    hyde: opts.semantic?.hyde,
    minScore: opts.semantic?.minScore,
    all: opts.semantic?.all,
    format: opts.semantic?.format,
    full: opts.semantic?.full,
    lineNumbers: opts.semantic?.lineNumbers,
    fullPath: opts.semantic?.fullPath,
    index: opts.semantic?.index,
    storage: opts.semantic?.storage,
    modelPath: opts.semantic?.modelPath,
    chunkStrategy: opts.semantic?.chunkStrategy,
    candidateLimit: opts.semantic?.candidateLimit,
    noRerank: opts.semantic?.noRerank,
  };
}

function semanticHitTarget(hit: SemanticSearchHit): string {
  return hit.docid.startsWith("#") ? hit.docid : hit.path;
}

async function hydrateSemanticHits(
  opts: MorningRetrieveOptions,
  hits: readonly SemanticSearchHit[],
  backend: MorningSemanticBackend,
): Promise<readonly SemanticDocument[]> {
  const hydrate = opts.semantic?.hydrate ?? "none";
  if (hydrate === "none") return [];

  const explicitTargets = opts.semantic?.hydrateTargets ?? [];
  const targets =
    hydrate === "targets"
      ? explicitTargets
      : hydrate === "top"
        ? hits.slice(0, 1).map(semanticHitTarget)
        : hits.map(semanticHitTarget);

  if (targets.length === 0) return [];
  if (targets.length === 1 && typeof opts.semantic?.hydrateFromLine === "number") {
    const result = await backend.getDocument({
      target: targets[0] ?? "",
      vault: opts.vault,
      fromLine: opts.semantic.hydrateFromLine,
      lineCount: opts.semantic.hydrateLineCount,
      lineNumbers: opts.semantic.lineNumbers,
      fullPath: opts.semantic.fullPath,
      index: opts.semantic.index,
      storage: opts.semantic.storage,
      modelPath: opts.semantic.modelPath,
    });
    return result.available ? result.documents : [];
  }

  const result = await backend.multiGet({
    vault: opts.vault,
    targets,
    lineLimit: opts.semantic?.hydrateLineLimit,
    maxBytes: opts.semantic?.hydrateMaxBytes,
    lineNumbers: opts.semantic?.lineNumbers,
    fullPath: opts.semantic?.fullPath,
    index: opts.semantic?.index,
    storage: opts.semantic?.storage,
    modelPath: opts.semantic?.modelPath,
  });
  return result.available ? result.documents : [];
}

async function loadSemantic(
  opts: MorningRetrieveOptions,
  backend: MorningSemanticBackend,
): Promise<{
  status: MorningRetrieveResult["providers"]["semantic"];
  sync?: SemanticEmbeddingSyncResult;
  hits: readonly SemanticSearchHit[];
}> {
  if (opts.semantic?.enabled === false) {
    return { status: { available: false, reason: "disabled" }, hits: [] };
  }

  const sync = await backend.sync(opts);
  if (sync && !sync.available) {
    return {
      status: { available: false, reason: `embedding sync failed: ${sync.reason}` },
      sync,
      hits: [],
    };
  }

  const status = await backend.status({
    vault: opts.vault,
    index: opts.semantic?.index,
    storage: opts.semantic?.storage,
    modelPath: opts.semantic?.modelPath,
  });
  if (!status.available) {
    return { status, sync, hits: [] };
  }

  const queryResult = await backend.query(semanticQueryOptions(opts));
  if (!queryResult.available) {
    return { status: { available: false, reason: queryResult.reason }, sync, hits: [] };
  }

  return { status, sync, hits: queryResult.hits };
}

export async function retrieveMorningContext(
  opts: MorningRetrieveOptions,
  backend: MorningSemanticBackend = defaultMorningSemanticBackend,
): Promise<MorningRetrieveResult> {
  const graph = await exploreLocalGraph(opts);
  const semantic = await loadSemantic(opts, backend);
  const semanticHits = filteredSemanticHits(opts, graph, semantic.hits);
  const semanticDocuments = await hydrateSemanticHits(opts, semanticHits, backend);
  const hits = [
    ...graph.seeds.map((node) => graphHit("oms-seed", node)),
    ...graph.neighbors.map((node) => graphHit("oms-neighbor", node)),
    ...semanticHits.map(semanticHit),
  ];

  return {
    mode: "oms-local-graph-semantic-fusion",
    providers: {
      graph: graph.provider,
      semantic: semantic.status,
    },
    graph,
    embeddingSync: semantic.sync,
    semanticHits,
    semanticDocuments,
    hits,
  };
}
