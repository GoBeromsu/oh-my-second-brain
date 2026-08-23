import {
  buildGraphCache,
  readGraphCache,
  type GraphNote,
  type OMSGraphCache,
  type RetrieveByAxisOptions,
} from "./cache.js";
import {
  exploreEngineGraph,
  type EngineGraphConnectionReason,
  type EngineGraphExploreNode,
} from "../engine/graph/explore.js";
import type { EngineGraphNode } from "../engine/graph/node.js";
import type { GraphEdge as EngineGraphEdge } from "../engine/types.js";

export type LocalGraphProvider = "cache" | "headless-scan";
export type GraphConnectionKind = "property-value" | "wikilink" | "backlink";

export interface GraphExploreOptions extends RetrieveByAxisOptions {
  maxNeighbors?: number;
  useCache?: boolean;
}

export interface GraphConnectionReason {
  kind: GraphConnectionKind;
  from: string;
  to: string;
  axis?: string;
  value?: string;
  target?: string;
}

export interface GraphExploreNode {
  path: string;
  concept: string | null;
  folder: string;
  axes: Record<string, string[]>;
  wikilinks: string[];
  score: number;
  bodyPreview: string;
  reasons: GraphConnectionReason[];
}

export interface GraphExploreResult {
  provider: LocalGraphProvider;
  mode: "axis-seed-local-neighborhood";
  bodyPolicy: "lazy-load";
  seeds: GraphExploreNode[];
  neighbors: GraphExploreNode[];
  connections: GraphConnectionReason[];
}

async function loadGraph(opts: GraphExploreOptions): Promise<{
  cache: OMSGraphCache;
  provider: LocalGraphProvider;
}> {
  if (opts.useCache !== false) {
    const cached = await readGraphCache(opts.vault);
    if (cached) {
      return { cache: cached, provider: "cache" };
    }
  }

  return {
    cache: await buildGraphCache({ vault: opts.vault, ontology: opts.ontology, write: false }),
    provider: "headless-scan",
  };
}

function normalizeTarget(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .toLowerCase();
}

function noteStem(notePath: string): string {
  return notePath.replace(/\.md$/i, "");
}

function noteBasename(notePath: string): string {
  const parts = noteStem(notePath).split("/");
  return parts[parts.length - 1] ?? noteStem(notePath);
}

function noteMatchesWikilinkTarget(note: GraphNote, target: string): boolean {
  const normalized = normalizeTarget(target);
  return normalized === normalizeTarget(noteStem(note.path)) || normalized === normalizeTarget(noteBasename(note.path));
}

function toEngineNodes(cache: OMSGraphCache): EngineGraphNode[] {
  const searchByPath = new Map(cache.search.map((item) => [item.path, item]));
  return cache.notes.map((note) => {
    const search = searchByPath.get(note.path);
    return {
      path: note.path,
      concept: note.concept,
      folder: note.folder,
      axes: note.axes,
      wikilinks: note.wikilinks,
      bodyPreview: search?.bodyPreview ?? "",
      searchTerms: new Set(search?.terms ?? []),
    };
  });
}

function toEngineWikilinkEdges(cache: OMSGraphCache): EngineGraphEdge[] {
  const edges: EngineGraphEdge[] = [];
  for (const edge of cache.edges) {
    if (edge.type !== "wikilink") continue;
    for (const note of cache.notes) {
      if (!noteMatchesWikilinkTarget(note, edge.to)) continue;
      edges.push({
        from: edge.from,
        to: note.path,
        weight: 1,
        kind: "wikilink",
      });
    }
  }
  return edges;
}

function rawWikilinkTarget(cache: OMSGraphCache, from: string, resolvedTo: string): string | undefined {
  const targetNote = cache.notes.find((note) => note.path === resolvedTo);
  if (targetNote === undefined) return undefined;
  for (const edge of cache.edges) {
    if (edge.type !== "wikilink" || edge.from !== from) continue;
    if (noteMatchesWikilinkTarget(targetNote, edge.to)) return edge.to;
  }
  return undefined;
}

function remapReason(cache: OMSGraphCache, reason: EngineGraphConnectionReason): GraphConnectionReason {
  if (reason.kind === "property-value") {
    return {
      kind: reason.kind,
      from: reason.from,
      to: reason.to,
      ...(reason.axis !== undefined ? { axis: reason.axis } : {}),
      ...(reason.value !== undefined ? { value: reason.value } : {}),
    };
  }
  const rawTarget = rawWikilinkTarget(cache, reason.from, reason.to) ?? reason.target;
  return {
    kind: reason.kind,
    from: reason.from,
    to: reason.to,
    ...(rawTarget !== undefined ? { target: rawTarget } : {}),
  };
}

function toLocalNode(
  cache: OMSGraphCache,
  node: EngineGraphExploreNode,
): GraphExploreNode {
  const note = cache.notes.find((candidate) => candidate.path === node.path);
  const search = cache.search.find((candidate) => candidate.path === node.path);
  return {
    path: node.path,
    concept: node.concept,
    folder: node.folder,
    axes: node.axes,
    wikilinks: note?.wikilinks ?? node.wikilinks,
    score: node.score,
    bodyPreview: search?.bodyPreview ?? node.bodyPreview,
    reasons: node.reasons.map((reason) => remapReason(cache, reason)),
  };
}

export async function exploreLocalGraph(opts: GraphExploreOptions): Promise<GraphExploreResult> {
  const { cache, provider } = await loadGraph(opts);
  const explored = exploreEngineGraph(toEngineNodes(cache), toEngineWikilinkEdges(cache), {
    concept: opts.concept,
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
    seeds: explored.seeds.map((node) => toLocalNode(cache, node)),
    neighbors: explored.neighbors.map((node) => toLocalNode(cache, node)),
    connections: explored.connections.map((reason) => remapReason(cache, reason)),
  };
}
