import { exploreEngineGraph, type EngineGraphConnectionReason, type EngineGraphExploreNode } from "../engine/graph/explore.js";
import { buildGraph, buildNodeIndex, loadCachedGraph, loadNodeIndex, nodeSourceSignature } from "../engine/graph/builder.js";
import type { AxisScalar } from "../engine/graph/node.js";
import { loadResolvedTemplates } from "../templates/resolver.js";

export type LocalGraphProvider = "cache" | "headless-scan";
export type GraphConnectionKind = "property-value" | "wikilink" | "backlink";

export interface GraphExploreOptions {
  readonly vault: string;
  readonly template?: string;
  readonly folder?: string;
  readonly property?: string;
  readonly value?: AxisScalar;
  readonly wikilink?: string;
  readonly query?: string;
  readonly limit?: number;
  readonly maxNeighbors?: number;
  readonly useCache?: boolean;
}

export interface GraphConnectionReason {
  readonly kind: GraphConnectionKind;
  readonly from: string;
  readonly to: string;
  readonly axis?: string;
  readonly value?: AxisScalar;
  readonly target?: string;
}

export interface GraphExploreNode {
  readonly path: string;
  readonly template: string;
  readonly folder: string;
  readonly axes: Readonly<Record<string, readonly AxisScalar[]>>;
  readonly wikilinks: readonly string[];
  readonly score: number;
  readonly bodyPreview: string;
  readonly reasons: readonly GraphConnectionReason[];
}

export interface GraphExploreResult {
  readonly provider: LocalGraphProvider;
  readonly mode: "axis-seed-local-neighborhood";
  readonly bodyPolicy: "lazy-load";
  readonly seeds: readonly GraphExploreNode[];
  readonly neighbors: readonly GraphExploreNode[];
  readonly connections: readonly GraphConnectionReason[];
}

function engineCachePath(vault: string, file: string): string {
  return `${vault}/.oms/cache/engine/${file}`;
}

function remapReason(reason: EngineGraphConnectionReason): GraphConnectionReason {
  return {
    kind: reason.kind,
    from: reason.from,
    to: reason.to,
    ...(reason.axis === undefined ? {} : { axis: reason.axis }),
    ...(reason.value === undefined ? {} : { value: reason.value }),
    ...(reason.target === undefined ? {} : { target: reason.target }),
  };
}

function toLocalNode(node: EngineGraphExploreNode): GraphExploreNode {
  return {
    path: node.path,
    template: node.template,
    folder: node.folder,
    axes: node.axes,
    wikilinks: node.wikilinks,
    score: node.score,
    bodyPreview: node.bodyPreview,
    reasons: node.reasons.map(remapReason),
  };
}

export async function exploreLocalGraph(opts: GraphExploreOptions): Promise<GraphExploreResult> {
  const convention = await loadResolvedTemplates(opts.vault);
  const sourceSignature = await nodeSourceSignature(opts.vault, convention);
  const projectionSignature = convention.inputSignature;
  const cacheAllowed = opts.useCache !== false;
  const cachedNodes = cacheAllowed
    ? await loadNodeIndex(engineCachePath(opts.vault, "node-index.json"), sourceSignature, projectionSignature)
    : null;
  const cachedEdges = cacheAllowed
    ? await loadCachedGraph(engineCachePath(opts.vault, "graph.json"), projectionSignature)
    : null;
  const nodes = cachedNodes ?? await buildNodeIndex({ vaultPath: opts.vault, convention });
  const edges = cachedEdges ?? await buildGraph({ vaultPath: opts.vault, convention });
  const provider: LocalGraphProvider = cachedNodes !== null && cachedEdges !== null ? "cache" : "headless-scan";
  const explored = exploreEngineGraph(nodes, edges, {
    template: opts.template,
    folder: opts.folder,
    property: opts.property,
    value: opts.value,
    wikilink: opts.wikilink,
    query: opts.query,
    limit: opts.limit,
    maxNeighbors: opts.maxNeighbors,
    provider: provider === "cache" ? "cache" : "live",
  });
  return {
    provider,
    mode: "axis-seed-local-neighborhood",
    bodyPolicy: "lazy-load",
    seeds: explored.seeds.map(toLocalNode),
    neighbors: explored.neighbors.map(toLocalNode),
    connections: explored.connections.map(remapReason),
  };
}
