/**
 * exploreEngineGraph — axis-seeded local-neighbourhood exploration.
 *
 * Shared axis-seeded local-neighbourhood walk. `exploreLocalGraph` adapts the
 * vault graph cache onto this function. Given the node index + edge graph, it:
 *
 *   1. axis-filters the nodes to a seed set (ranked by lexical query overlap),
 *   2. expands each seed's neighbourhood along three reason kinds —
 *      property-value (shared frontmatter axis), wikilink (out-going link),
 *      backlink (incoming link),
 *   3. ranks neighbours by reason count, then lexical query overlap,
 *   4. returns the top seeds + neighbours with their connection reasons.
 *
 * Edges are produced by builder.ts with fully resolved vault-relative paths,
 * so link matching is exact path equality (no stem heuristics needed here).
 */

import type { AxisScalar, EngineGraphNode } from "./node.js";
import { filterNodesByAxis, searchScore } from "./node.js";
import type { GraphEdge } from "../types.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Why a neighbour is connected to a seed. */
export interface EngineGraphConnectionReason {
  readonly kind: "property-value" | "wikilink" | "backlink";
  readonly from: string;
  readonly to: string;
  readonly axis?: string;
  readonly value?: AxisScalar;
  readonly target?: string;
}

/** A node enriched with its exploration score + the reasons it surfaced. */
export interface EngineGraphExploreNode extends EngineGraphNode {
  readonly score: number;
  readonly reasons: EngineGraphConnectionReason[];
}

/** Full result of an axis-seeded local-graph exploration. */
export interface EngineGraphExploreResult {
  readonly provider: "cache" | "live";
  readonly mode: "axis-seed-local-neighborhood";
  readonly bodyPolicy: "lazy-load";
  readonly seeds: EngineGraphExploreNode[];
  readonly neighbors: EngineGraphExploreNode[];
  readonly connections: EngineGraphConnectionReason[];
}

/** Inputs to exploreEngineGraph (axis filters + query + neighbourhood knobs). */
export interface ExploreOptions {
  template?: string;
  folder?: string;
  property?: string;
  value?: AxisScalar;
  wikilink?: string;
  query?: string;
  limit?: number;
  maxNeighbors?: number;
  provider?: "cache" | "live";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

function pushInto(map: Map<string, string[]>, key: string, value: string): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function connectionKey(r: EngineGraphConnectionReason): string {
  return `${r.kind}|${r.from}|${r.to}|${r.axis ?? ""}|${r.value ?? ""}|${r.target ?? ""}`;
}

// ---------------------------------------------------------------------------
// Exploration
// ---------------------------------------------------------------------------

/**
 * Explore the local neighbourhood around axis-filtered seed nodes.
 *
 * @param nodes - The full node index (every node is a potential neighbour).
 * @param edges - The full edge graph (wikilink edges drive link expansion).
 * @param opts  - Axis filters, query, and seed/neighbour limits.
 */
export function exploreEngineGraph(
  nodes: readonly EngineGraphNode[],
  edges: readonly GraphEdge[],
  opts: ExploreOptions,
): EngineGraphExploreResult {
  const provider = opts.provider ?? "cache";
  const query = opts.query ?? "";

  // 1. axis filter → seeds, ranked by lexical query overlap
  const filtered = filterNodesByAxis(nodes, opts);
  const seedLimit = clamp(opts.limit ?? 5, 1, 50);
  const rankedSeeds = [...filtered].sort((a, b) => {
    const delta = searchScore(b, query) - searchScore(a, query);
    return delta !== 0 ? delta : a.path.localeCompare(b.path);
  });
  const seedNodes = rankedSeeds.slice(0, seedLimit);
  const seedSet = new Set(seedNodes.map((n) => n.path));

  // Indices over ALL nodes/edges (neighbours may lie outside the filtered set)
  const nodeByPath = new Map<string, EngineGraphNode>();
  for (const n of nodes) nodeByPath.set(n.path, n);

  // property-value index: `${axis}\0${value}` → paths declaring it
  const propValueIndex = new Map<string, string[]>();
  for (const n of nodes) {
    for (const [axis, values] of Object.entries(n.axes)) {
      for (const v of values) pushInto(propValueIndex, `${axis}\0${v}`, n.path);
    }
  }

  // wikilink forward / backward indices (resolved paths → exact equality)
  const fwdIndex = new Map<string, string[]>();
  const backIndex = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "wikilink" || e.weight <= 0) continue;
    pushInto(fwdIndex, e.from, e.to);
    pushInto(backIndex, e.to, e.from);
  }

  // 2. gather neighbour reasons (globally de-duplicated by connectionKey)
  const neighborReasons = new Map<string, EngineGraphConnectionReason[]>();
  const seenKeys = new Set<string>();
  const addReason = (ownerPath: string, reason: EngineGraphConnectionReason): void => {
    const key = connectionKey(reason);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    const arr = neighborReasons.get(ownerPath);
    if (arr) arr.push(reason);
    else neighborReasons.set(ownerPath, [reason]);
  };

  for (const seed of seedNodes) {
    // a. property-value: other nodes sharing any of this seed's axis values
    for (const [axis, values] of Object.entries(seed.axes)) {
      for (const value of values) {
        for (const otherPath of propValueIndex.get(`${axis}\0${value}`) ?? []) {
          if (otherPath === seed.path) continue;
          addReason(otherPath, { kind: "property-value", from: seed.path, to: otherPath, axis, value });
        }
      }
    }
    // b. wikilink forward: notes this seed links out to
    for (const to of fwdIndex.get(seed.path) ?? []) {
      if (to === seed.path) continue;
      addReason(to, { kind: "wikilink", from: seed.path, to, target: to });
    }
    // c. backlink reverse: notes that link into this seed
    for (const from of backIndex.get(seed.path) ?? []) {
      if (from === seed.path) continue;
      addReason(from, { kind: "backlink", from, to: seed.path, target: seed.path });
    }
  }

  // 3. Rank neighbours lexicographically: connection evidence is primary and
  // lexical overlap resolves ties. Keep score in the same lexical unit as seeds.
  const neighbors: EngineGraphExploreNode[] = [];
  for (const [npath, reasons] of neighborReasons) {
    if (seedSet.has(npath)) continue;
    const node = nodeByPath.get(npath);
    if (node === undefined) continue;
    const score = searchScore(node, query);
    neighbors.push({ ...node, score, reasons });
  }
  neighbors.sort((a, b) =>
    b.reasons.length - a.reasons.length ||
    b.score - a.score ||
    a.path.localeCompare(b.path));
  const maxNeighbors = clamp(opts.maxNeighbors ?? 10, 0, 100);
  const topNeighbors = neighbors.slice(0, maxNeighbors);

  // 4. seeds carry their lexical score; connections = surviving reasons
  const seeds: EngineGraphExploreNode[] = seedNodes.map((n) => ({
    ...n,
    score: searchScore(n, query),
    reasons: [],
  }));

  const connections: EngineGraphConnectionReason[] = [];
  for (const n of topNeighbors) connections.push(...n.reasons);
  connections.sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.kind.localeCompare(b.kind),
  );

  return {
    provider,
    mode: "axis-seed-local-neighborhood",
    bodyPolicy: "lazy-load",
    seeds,
    neighbors: topNeighbors,
    connections,
  };
}
