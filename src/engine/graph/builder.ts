import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { GraphEdge } from "../types.js";
import type { EngineGraphNode } from "./node.js";
import { tokenize } from "./node.js";
import { buildWikilinkIndex, resolveWikilink } from "./resolver.js";

// ---------------------------------------------------------------------------
// Internal file-system helpers
// ---------------------------------------------------------------------------

async function* walkMarkdown(dir: string, base: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name === ".oms" || name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(full, base);
    } else if (entry.isFile() && name.endsWith(".md")) {
      yield path.relative(base, full).replace(/\\/g, "/");
    }
  }
}

// ---------------------------------------------------------------------------
// Markdown parsing helpers (self-contained; uses yaml dep directly)
// ---------------------------------------------------------------------------

/** Parse YAML frontmatter from raw markdown. Returns `{}` on missing or invalid FM. */
function parseFrontmatter(raw: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) return {};
  try {
    const parsed = parseYaml(match[1] ?? "") as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore YAML parse errors */
  }
  return {};
}

/** Return the markdown body after the frontmatter fence (or the whole doc). */
function extractBody(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)([\s\S]*)/.exec(raw);
  return match ? (match[1] ?? raw) : raw;
}

/** Extract raw inner strings from every `[[…]]` wikilink in body text. */
function extractRawWikilinks(body: string): string[] {
  const links: string[] = [];
  const pattern = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const inner = match[1];
    if (inner) links.push(inner.trim());
  }
  return links;
}

/** Coerce an unknown YAML value to a flat string array. */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(toStringArray);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

/** First path segment = note type (folder group). */
function noteType(docPath: string): string {
  return docPath.split("/")[0] ?? "";
}

// ---------------------------------------------------------------------------
// Adamic-Adar helpers
// ---------------------------------------------------------------------------

/**
 * Contribution of a common neighbour with `degree` connections.
 * AA contribution = 1 / log(degree). Returns 0 for degree ≤ 1 (log(1) = 0).
 *
 * Algorithm absorbed from nashsu/llm_wiki (GPL-3.0) — idea only, zero verbatim
 * code.  See ACKNOWLEDGMENTS.md for attribution.
 */
function adamicAdarContrib(degree: number): number {
  if (degree <= 1) return 0;
  const l = Math.log(degree);
  return l === 0 ? 0 : 1 / l;
}

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

interface ParsedDoc {
  docPath: string;
  frontmatter: Record<string, unknown>;
  rawWikilinks: string[];
}

async function parseDocs(vaultPath: string, files: readonly string[]): Promise<ParsedDoc[]> {
  return Promise.all(
    files.map(async (docPath): Promise<ParsedDoc> => {
      const raw = await readFile(path.join(vaultPath, docPath), "utf-8");
      return {
        docPath,
        frontmatter: parseFrontmatter(raw),
        rawWikilinks: extractRawWikilinks(extractBody(raw)),
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Public API — graph construction
// ---------------------------------------------------------------------------

/**
 * Build a 4-tier weighted edge graph from vault markdown files.
 *
 * Tier weights (composite = weighted sum; nashsu composite idea, GPL-3.0 —
 * algorithm absorbed as idea only, zero verbatim code):
 *
 *   Tier 1  wikilink    `[[target]]`         weight × 3.0
 *   Tier 2  frontmatter `sources`/`relations` weight × 4.0
 *   Tier 3  Adamic-Adar common-neighbour      weight × 1.5
 *   Tier 4  type-affinity same folder group   weight × 1.0
 *
 * Unresolvable links emit `kind: "unknown-ref"` edges (weight 0) rather than
 * throwing.  The full graph is returned as a flat GraphEdge array; persist it
 * with {@link saveCachedGraph} and reload with {@link loadCachedGraph}.
 */
export async function buildGraph(opts: {
  vaultPath: string;
  /**
   * Vault-relative file paths.  When omitted the whole vault is walked.
   * Provide an explicit list to build a sparse on-demand sub-graph.
   */
  files?: readonly string[];
}): Promise<GraphEdge[]> {
  const vaultPath = path.resolve(opts.vaultPath);

  let files: readonly string[];
  if (opts.files !== undefined) {
    files = opts.files;
  } else {
    const collected: string[] = [];
    for await (const f of walkMarkdown(vaultPath, vaultPath)) collected.push(f);
    files = collected;
  }

  const docs = await parseDocs(vaultPath, files);
  const index = buildWikilinkIndex(files);
  const edges: GraphEdge[] = [];

  // Undirected adjacency used for Adamic-Adar (resolved links only).
  const adj = new Map<string, Set<string>>();
  const ensureAdj = (node: string): Set<string> => {
    let s = adj.get(node);
    if (!s) { s = new Set<string>(); adj.set(node, s); }
    return s;
  };

  // ── Tier 1: wikilinks × 3.0 ──────────────────────────────────────────────
  for (const { docPath, rawWikilinks } of docs) {
    ensureAdj(docPath);
    for (const rawLink of rawWikilinks) {
      const { docPath: target } = resolveWikilink(rawLink, index);
      if (target !== null) {
        edges.push({ from: docPath, to: target, weight: 3.0, kind: "wikilink" });
        ensureAdj(docPath).add(target);
        ensureAdj(target).add(docPath);
      } else {
        edges.push({ from: docPath, to: rawLink, weight: 0, kind: "unknown-ref" });
      }
    }
  }

  // ── Tier 2: frontmatter sources / relations × 4.0 ────────────────────────
  for (const { docPath, frontmatter } of docs) {
    const refs: string[] = [
      ...toStringArray(frontmatter["sources"]),
      ...toStringArray(frontmatter["relations"]),
    ];
    for (const rawRef of refs) {
      const { docPath: target } = resolveWikilink(rawRef, index);
      if (target !== null) {
        edges.push({ from: docPath, to: target, weight: 4.0, kind: "frontmatter" });
      } else {
        edges.push({ from: docPath, to: rawRef, weight: 0, kind: "unknown-ref" });
      }
    }
  }

  // ── Tier 3: Adamic-Adar × 1.5 ────────────────────────────────────────────
  // For each node w, every pair of its neighbours (u, v) gains
  // 1/log(deg(w)) — the Adamic-Adar contribution.
  const aaPairs = new Map<string, number>();
  for (const [w, neighbours] of adj) {
    const contrib = adamicAdarContrib(neighbours.size);
    if (contrib === 0) continue;
    const ns = Array.from(neighbours).sort();
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const u = ns[i]!;
        const v = ns[j]!;
        // canonical key: lexicographically smaller node first
        const key = u < v ? `${u}\0${v}` : `${v}\0${u}`;
        aaPairs.set(key, (aaPairs.get(key) ?? 0) + contrib);
      }
    }
  }
  for (const [key, rawScore] of aaPairs) {
    const sep = key.indexOf("\0");
    const u = key.slice(0, sep);
    const v = key.slice(sep + 1);
    const weight = rawScore * 1.5;
    // Emit both directions — Adamic-Adar is an undirected similarity.
    edges.push({ from: u, to: v, weight, kind: "adamic-adar" });
    edges.push({ from: v, to: u, weight, kind: "adamic-adar" });
  }

  // ── Tier 4: type-affinity × 1.0 (same first-folder group) ────────────────
  const byType = new Map<string, string[]>();
  for (const { docPath } of docs) {
    const type = noteType(docPath);
    if (!type) continue;
    const bucket = byType.get(type) ?? [];
    bucket.push(docPath);
    byType.set(type, bucket);
  }
  for (const [, members] of byType) {
    if (members.length < 2) continue;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const u = members[i]!;
        const v = members[j]!;
        edges.push({ from: u, to: v, weight: 1.0, kind: "type-affinity" });
        edges.push({ from: v, to: u, weight: 1.0, kind: "type-affinity" });
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Two-tier cache
// ---------------------------------------------------------------------------

/**
 * Cache layout note:
 *
 *   Full graph  → .oms/cache/engine/graph.json  (gitignored)
 *   Sparse graph → computed live on demand via buildGraph({ files: [...] })
 *
 * Both paths use the same GraphEdge[] contract; the caller decides which to
 * invoke based on whether a cache hit is acceptable.
 */

const CACHE_VERSION = 1;

interface EngineCacheFile {
  readonly version: number;
  readonly generatedAt: string;
  readonly edges: GraphEdge[];
}

/**
 * Load the persisted full-graph cache from `cachePath`.
 * Returns `null` when the file is absent, unreadable, or at a stale version.
 */
export async function loadCachedGraph(cachePath: string): Promise<GraphEdge[] | null> {
  try {
    const raw = await readFile(cachePath, "utf-8");
    const file = JSON.parse(raw) as EngineCacheFile;
    if (file.version !== CACHE_VERSION) return null;
    return file.edges;
  } catch {
    return null;
  }
}

/**
 * Persist `edges` to `cachePath` as the full-graph cache.
 * Parent directories are created automatically.
 */
export async function saveCachedGraph(cachePath: string, edges: GraphEdge[]): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const file: EngineCacheFile = {
    version: CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    edges,
  };
  await writeFile(cachePath, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
}

/**
 * Load the persisted full-graph cache, returning both edges and the build
 * timestamp.  Unlike {@link loadCachedGraph} (which drops `generatedAt`), this
 * is used by oms_graph_status to report when the cache was built.
 * Returns `null` when the file is absent, unreadable, or at a stale version.
 */
export async function loadCachedGraphMeta(
  cachePath: string,
): Promise<{ edges: GraphEdge[]; generatedAt: string } | null> {
  try {
    const raw = await readFile(cachePath, "utf-8");
    const file = JSON.parse(raw) as EngineCacheFile;
    if (file.version !== CACHE_VERSION) return null;
    return { edges: file.edges, generatedAt: file.generatedAt };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Node index — per-note metadata for axis-filtered retrieval (C2)
// ---------------------------------------------------------------------------

const NODE_CACHE_VERSION = 1;

/** JSON-serialisable form of EngineGraphNode (Set → string[] for searchTerms). */
interface SerializedNode {
  readonly path: string;
  readonly concept: string | null;
  readonly folder: string;
  readonly axes: Record<string, string[]>;
  readonly wikilinks: string[];
  readonly bodyPreview: string;
  readonly searchTerms: string[];
}

interface NodeCacheFile {
  readonly version: number;
  readonly generatedAt: string;
  readonly nodes: SerializedNode[];
}

/**
 * Scan the vault (or an explicit file slice) and build the per-note index
 * consumed by retrieve_by_axis and retrieve_context.
 *
 * Each node carries concept (frontmatter["concept"] only — no Ontology, R18),
 * folder group, every frontmatter field as a string-array axis, resolved
 * out-going wikilinks, a 240-char body preview, and a tokenised searchTerms
 * set (frontmatter strings ∪ body) for lexical scoring.
 */
export async function buildNodeIndex(opts: {
  vaultPath: string;
  /** Vault-relative file paths.  Whole vault is walked when omitted. */
  files?: readonly string[];
}): Promise<EngineGraphNode[]> {
  const vaultPath = path.resolve(opts.vaultPath);

  let files: readonly string[];
  if (opts.files !== undefined) {
    files = opts.files;
  } else {
    const collected: string[] = [];
    for await (const f of walkMarkdown(vaultPath, vaultPath)) collected.push(f);
    files = collected;
  }

  const index = buildWikilinkIndex(files);
  const nodes: EngineGraphNode[] = [];

  for (const docPath of files) {
    let raw: string;
    try {
      raw = await readFile(path.join(vaultPath, docPath), "utf-8");
    } catch {
      continue; // unreadable file — skip silently
    }

    const frontmatter = parseFrontmatter(raw);
    const body = extractBody(raw);

    const conceptRaw = frontmatter["concept"];
    const concept = typeof conceptRaw === "string" ? conceptRaw : null;

    const axes: Record<string, string[]> = {};
    const fmStrings: string[] = [];
    for (const [key, value] of Object.entries(frontmatter)) {
      const arr = toStringArray(value);
      if (arr.length > 0) {
        axes[key] = arr;
        fmStrings.push(...arr);
      }
    }

    const wikilinks: string[] = [];
    for (const rawLink of extractRawWikilinks(body)) {
      const { docPath: target } = resolveWikilink(rawLink, index);
      if (target !== null) wikilinks.push(target);
    }

    const searchTerms = new Set<string>([
      ...tokenize(fmStrings.join(" ")),
      ...tokenize(body),
    ]);

    nodes.push({
      path: docPath,
      concept,
      folder: noteType(docPath),
      axes,
      wikilinks,
      bodyPreview: body.slice(0, 240),
      searchTerms,
    });
  }

  return nodes;
}

/** Persist the node index to `cachePath` (compact JSON; Set serialised as array). */
export async function saveNodeIndex(
  cachePath: string,
  nodes: readonly EngineGraphNode[],
): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const file: NodeCacheFile = {
    version: NODE_CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    nodes: nodes.map((n) => ({
      path: n.path,
      concept: n.concept,
      folder: n.folder,
      axes: n.axes,
      wikilinks: n.wikilinks,
      bodyPreview: n.bodyPreview,
      searchTerms: Array.from(n.searchTerms),
    })),
  };
  await writeFile(cachePath, `${JSON.stringify(file)}\n`, "utf-8");
}

/**
 * Load the node index from `cachePath`, rebuilding each searchTerms Set from
 * its serialised array form.  Returns `null` when absent / unreadable / stale.
 */
export async function loadNodeIndex(cachePath: string): Promise<EngineGraphNode[] | null> {
  try {
    const raw = await readFile(cachePath, "utf-8");
    const file = JSON.parse(raw) as NodeCacheFile;
    if (file.version !== NODE_CACHE_VERSION) return null;
    return file.nodes.map((n) => ({
      path: n.path,
      concept: n.concept,
      folder: n.folder,
      axes: n.axes,
      wikilinks: n.wikilinks,
      bodyPreview: n.bodyPreview,
      searchTerms: new Set(n.searchTerms),
    }));
  } catch {
    return null;
  }
}
