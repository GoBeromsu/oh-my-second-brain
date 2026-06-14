import type { GraphEdge } from "../types.js";

// ---------------------------------------------------------------------------
// Public interface (stable — internals replaceable without changing callers)
// ---------------------------------------------------------------------------

/** Options controlling community detection behaviour. */
export interface CommunityOptions {
  /** Maximum label-propagation iterations before forced termination. Default: 50. */
  maxIterations?: number;
  /** Minimum cluster size to include in the result. Default: 1. */
  minSize?: number;
}

/** A detected community: a numeric id and its member document paths. */
export interface Community {
  /** Sequential 0-based identifier assigned after sorting by descending size. */
  id: number;
  /** Vault-relative paths of all documents in this community (sorted). */
  members: string[];
}

// ---------------------------------------------------------------------------
// detectCommunities
// ---------------------------------------------------------------------------

/**
 * Detect communities in the document graph via weighted label propagation.
 *
 * **Algorithm (current M1 implementation):**
 * Synchronous greedy label propagation.  Each node starts with a unique label.
 * On each iteration, every node (in a deterministic shuffled order) adopts the
 * label with the highest total incident-edge weight among its neighbours; ties
 * are broken by choosing the lexicographically smallest label.  Iteration
 * stops when no label changes or `maxIterations` is reached.
 *
 * **Stability contract (for future Leiden/Louvain replacement):**
 * This function's signature and the `Community` / `CommunityOptions` types are
 * the stable public interface.  A full Leiden algorithm (Traag et al., 2019)
 * is deferred to a later milestone; the function body can be replaced without
 * changing any caller.
 *
 * Absorbed interface pattern: graphify (MIT) — label-propagation structure.
 * No verbatim code copied.
 *
 * NOTE: Full Leiden algorithm is deferred — current implementation is greedy
 * label propagation sufficient for M1.
 */
export function detectCommunities(
  edges: readonly GraphEdge[],
  opts: CommunityOptions = {},
): Community[] {
  const maxIterations = opts.maxIterations ?? 50;
  const minSize = opts.minSize ?? 1;

  // Collect all nodes (both endpoints of every edge).
  const nodes = new Set<string>();
  for (const e of edges) {
    nodes.add(e.from);
    nodes.add(e.to);
  }
  if (nodes.size === 0) return [];

  // Build weighted symmetric adjacency: adjMap[u][v] = total weight.
  const adjMap = new Map<string, Map<string, number>>();
  for (const node of nodes) adjMap.set(node, new Map());

  for (const e of edges) {
    if (e.weight <= 0) continue;
    const fromAdj = adjMap.get(e.from);
    if (fromAdj !== undefined) fromAdj.set(e.to, (fromAdj.get(e.to) ?? 0) + e.weight);
    const toAdj = adjMap.get(e.to);
    if (toAdj !== undefined) toAdj.set(e.from, (toAdj.get(e.from) ?? 0) + e.weight);
  }

  // Initialise: each node holds its own path as its community label.
  const labels = new Map<string, string>();
  for (const node of nodes) labels.set(node, node);

  const nodeArr = Array.from(nodes);

  // ── Label propagation iterations ─────────────────────────────────────────
  for (let iter = 0; iter < maxIterations; iter++) {
    // Deterministic per-iteration shuffle avoids ordering bias.
    shuffleArray(nodeArr, iter);

    let changed = false;
    for (const node of nodeArr) {
      const neighbours = adjMap.get(node);
      if (!neighbours || neighbours.size === 0) continue;

      // Tally total weight per label across neighbours.
      const tally = new Map<string, number>();
      for (const [neighbour, weight] of neighbours) {
        const label = labels.get(neighbour);
        if (label === undefined) continue;
        tally.set(label, (tally.get(label) ?? 0) + weight);
      }

      // Select best label: highest total weight; ties broken lexicographically.
      const currentLabel = labels.get(node) ?? node;
      let bestLabel = currentLabel;
      let bestWeight = tally.get(currentLabel) ?? 0;

      for (const [label, weight] of tally) {
        if (weight > bestWeight || (weight === bestWeight && label < bestLabel)) {
          bestLabel = label;
          bestWeight = weight;
        }
      }

      if (bestLabel !== currentLabel) {
        labels.set(node, bestLabel);
        changed = true;
      }
    }

    if (!changed) break;
  }

  // ── Group by final label and emit Community[] ─────────────────────────────
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const label = labels.get(node) ?? node;
    const group = groups.get(label) ?? [];
    group.push(node);
    groups.set(label, group);
  }

  return Array.from(groups.values())
    .filter((members) => members.length >= minSize)
    .sort((a, b) => b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? ""))
    .map((members, idx): Community => ({ id: idx, members: members.slice().sort() }));
}

// ---------------------------------------------------------------------------
// Internal: deterministic per-iteration shuffle (Linear Congruential Generator)
// ---------------------------------------------------------------------------

/**
 * In-place Fisher-Yates shuffle with a deterministic LCG seed so that each
 * iteration uses a different but reproducible traversal order.
 */
function shuffleArray<T>(arr: T[], seed: number): void {
  // LCG parameters (Numerical Recipes)
  let s = (seed + 1) | 0;
  for (let i = arr.length - 1; i > 0; i--) {
    s = Math.imul(s, 1664525) + 1013904223;
    const j = Math.abs(s) % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j]!;
    arr[j] = tmp!;
  }
}
