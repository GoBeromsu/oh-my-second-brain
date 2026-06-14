/**
 * Graph traversal utilities: adjacency-map construction and BFS/DFS walk.
 *
 * The traversal result is a ScoredHit[] with scores decaying by hop distance
 * (score = 1 / (1 + depth)), compatible with the C3 dispatcher's graphTraverse
 * injection point.
 */

import type { GphQuery, GraphEdge, ScoredHit } from "../types.js";

// ---------------------------------------------------------------------------
// Adjacency map
// ---------------------------------------------------------------------------

export interface AdjEdge {
  readonly to: string;
  readonly weight: number;
}

export type AdjMap = ReadonlyMap<string, readonly AdjEdge[]>;

/**
 * Build a weighted directed adjacency map from a flat GraphEdge list.
 * Multiple edges between the same pair are summed.
 */
export function buildAdjacency(edges: readonly GraphEdge[]): AdjMap {
  const adj = new Map<string, AdjEdge[]>();

  for (const e of edges) {
    if (e.weight <= 0) continue; // skip unknown-ref / zero-weight edges
    const bucket = adj.get(e.from);
    if (bucket === undefined) {
      adj.set(e.from, [{ to: e.to, weight: e.weight }]);
    } else {
      // Merge: if an edge to `to` already exists, sum weights
      const existing = bucket.find((x) => x.to === e.to);
      if (existing !== undefined) {
        (existing as { to: string; weight: number }).weight += e.weight;
      } else {
        bucket.push({ to: e.to, weight: e.weight });
      }
    }
  }

  return adj;
}

// ---------------------------------------------------------------------------
// BFS traversal
// ---------------------------------------------------------------------------

/**
 * Perform a BFS traversal from `query.seed` up to `query.depth` hops.
 * Returns ScoredHit[] with scores decaying as 1 / (1 + depth).
 * The seed node itself is excluded from results.
 */
function traverseBFS(adj: AdjMap, query: GphQuery): ScoredHit[] {
  const depth = query.depth ?? 2;
  const results: ScoredHit[] = [];
  const visited = new Set<string>([query.seed]);

  // Queue entries: [docPath, currentDepth]
  const queue: Array<[string, number]> = [[query.seed, 0]];

  while (queue.length > 0) {
    const entry = queue.shift();
    if (entry === undefined) break;
    const [current, d] = entry;

    // Emit all nodes except the seed
    if (d > 0) {
      results.push({
        docPath: current,
        chunkOrdinal: 0,
        score: 1 / (1 + d),
      });
    }

    if (d >= depth) continue;

    const neighbors = adj.get(current) ?? [];
    // Sort by descending weight so highest-weight neighbors are explored first
    const sorted = neighbors.slice().sort((a, b) => b.weight - a.weight);
    for (const { to } of sorted) {
      if (!visited.has(to)) {
        visited.add(to);
        queue.push([to, d + 1]);
      }
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// DFS traversal
// ---------------------------------------------------------------------------

/**
 * Perform a depth-limited DFS traversal from `query.seed`.
 * Returns ScoredHit[] with scores decaying as 1 / (1 + depth).
 */
function traverseDFS(adj: AdjMap, query: GphQuery): ScoredHit[] {
  const depth = query.depth ?? 2;
  const results: ScoredHit[] = [];
  const visited = new Set<string>([query.seed]);

  const dfs = (node: string, d: number): void => {
    if (d > depth) return;
    if (d > 0) {
      results.push({ docPath: node, chunkOrdinal: 0, score: 1 / (1 + d) });
    }
    const neighbors = adj.get(node) ?? [];
    const sorted = neighbors.slice().sort((a, b) => b.weight - a.weight);
    for (const { to } of sorted) {
      if (!visited.has(to)) {
        visited.add(to);
        dfs(to, d + 1);
      }
    }
  };

  dfs(query.seed, 0);
  return results.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

/**
 * Execute a graph traversal query against a pre-built adjacency map.
 *
 * Modes:
 *   - "bfs"       — breadth-first; explores the neighbourhood layer by layer
 *   - "dfs"       — depth-first; follows the heaviest path first
 *   - "community" — falls back to BFS (full community detection is deferred to M2)
 */
export function traverseGraph(adj: AdjMap, query: GphQuery): Promise<ScoredHit[]> {
  switch (query.mode) {
    case "bfs":
    case "community":
      return Promise.resolve(traverseBFS(adj, query));
    case "dfs":
      return Promise.resolve(traverseDFS(adj, query));
  }
}
