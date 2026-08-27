import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseNote } from "../../conventions/frontmatter.js";
import { excludedNoteMatcher } from "../../conventions/note-exclude.js";
import type { GraphEdge } from "../types.js";
import type { AxisScalar, EngineGraphNode } from "./node.js";
import { toAxisScalars, tokenize } from "./node.js";
import { buildWikilinkIndex, resolveWikilink } from "./resolver.js";

// ---------------------------------------------------------------------------
// Internal file-system helpers
// ---------------------------------------------------------------------------

function ensureInsideRoot(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the configured vault root.`);
  }
}

async function* walkMarkdown(
  dir: string,
  base: string,
  isExcluded: (notePath: string) => boolean,
  rootRealPath?: string,
  visitedDirectories: Set<string> = new Set(),
): AsyncGenerator<string> {
  const root = rootRealPath ?? await realpath(base);
  const realDir = await realpath(dir);
  ensureInsideRoot(root, realDir, `Vault directory "${dir}"`);
  if (visitedDirectories.has(realDir)) return;
  visitedDirectories.add(realDir);

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    const full = path.join(dir, name);
    // Resolve skipped entries too: an excluded symlink must not conceal an
    // escape or a dangling path from a strict graph build.
    const realEntry = await realpath(full);
    ensureInsideRoot(root, realEntry, `Vault entry "${full}"`);
    if (name === ".oms" || name === "node_modules" || name.startsWith(".")) continue;
    const entryStat = await stat(full);
    if (entryStat.isDirectory()) {
      yield* walkMarkdown(full, base, isExcluded, root, visitedDirectories);
    } else if (entryStat.isFile() && name.toLowerCase().endsWith(".md")) {
      const notePath = path.relative(base, full).replace(/\\/g, "/");
      // Template sources and other taxonomy-declared non-notes are skipped
      // here: their pre-substitution frontmatter is intentionally invalid
      // YAML, and a single one of them must not abort the whole vault scan.
      if (!isExcluded(notePath)) yield notePath;
    }
  }
}

async function validateExplicitFiles(vault: string, files: readonly string[]): Promise<void> {
  const lexicalRoot = path.resolve(vault);
  const root = await realpath(lexicalRoot);
  for (const docPath of files) {
    if (path.isAbsolute(docPath)) {
      throw new Error(`Graph file path must be vault-relative: ${docPath}`);
    }
    const fullPath = path.resolve(vault, docPath);
    ensureInsideRoot(lexicalRoot, fullPath, `Graph file "${docPath}"`);
    const realPath = await realpath(fullPath);
    ensureInsideRoot(root, realPath, `Graph file "${docPath}"`);
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) throw new Error(`Graph file path is not a regular file: ${docPath}`);
  }
}

// ---------------------------------------------------------------------------
// Markdown parsing helpers (shared frontmatter contract parser)
// ---------------------------------------------------------------------------

/** Parse YAML frontmatter from raw markdown. Invalid YAML is a loud contract error. */
function parseFrontmatter(raw: string, docPath?: string): Record<string, unknown> {
  // Keep this parser at the graph boundary, but use the shared frontmatter
  // contract diagnostics so malformed notes cannot become an indistinguishable
  // empty map.
  const parsed = parseNote(raw);
  if (parsed.diagnostics.length > 0) {
    const location = docPath === undefined ? "" : ` in ${docPath}`;
    throw new Error(`Malformed frontmatter${location}: ${parsed.diagnostics.map((item) => item.message).join("; ")}`);
  }
  return parsed.frontmatter;
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
        frontmatter: parseFrontmatter(raw, docPath),
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
    await validateExplicitFiles(vaultPath, files);
  } else {
    const isExcluded = await excludedNoteMatcher(vaultPath);
    const collected: string[] = [];
    for await (const f of walkMarkdown(vaultPath, vaultPath, isExcluded)) collected.push(f);
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

async function readCacheFile(cachePath: string): Promise<string | null> {
  try {
    return await readFile(cachePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await lstat(cachePath);
    } catch (missingError) {
      if ((missingError as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw missingError;
    }
    throw new Error(`Graph cache "${cachePath}" is a broken symbolic link.`, { cause: error });
  }
}

function parseCacheJson(raw: string, cachePath: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Graph cache "${cachePath}" is not valid JSON.`, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function writeCacheAtomically(cachePath: string, contents: string): Promise<void> {
  const outputPath = path.resolve(cachePath);
  const directory = path.dirname(outputPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(outputPath)}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf-8", flag: "wx" });
    await rename(temporaryPath, outputPath);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Load the persisted full-graph cache from `cachePath`.
 * Returns `null` only when the file is absent or at a stale version.
 */
export async function loadCachedGraph(cachePath: string): Promise<GraphEdge[] | null> {
  const raw = await readCacheFile(cachePath);
  if (raw === null) return null;
  const parsed = parseCacheJson(raw, cachePath);
  if (!isRecord(parsed)) {
    throw new Error(`Graph cache "${cachePath}" has an invalid format.`);
  }
  if (parsed.version !== CACHE_VERSION) return null;
  if (
    !Array.isArray(parsed.edges) ||
    !parsed.edges.every((edge) =>
      isRecord(edge) &&
      typeof edge.from === "string" &&
      typeof edge.to === "string" &&
      typeof edge.weight === "number" &&
      typeof edge.kind === "string"
    )
  ) {
    throw new Error(`Graph cache "${cachePath}" has an invalid format.`);
  }
  return parsed.edges as GraphEdge[];
}

/**
 * Persist `edges` to `cachePath` as the full-graph cache.
 * Parent directories are created automatically.
 */
export async function saveCachedGraph(cachePath: string, edges: GraphEdge[]): Promise<void> {
  const file: EngineCacheFile = {
    version: CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    edges,
  };
  await writeCacheAtomically(cachePath, `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Load the persisted full-graph cache, returning both edges and the build
 * timestamp.  Unlike {@link loadCachedGraph} (which drops `generatedAt`), this
 * is used by oms_graph_status to report when the cache was built.
 * Returns `null` only when the file is absent or at a stale version.
 */
export async function loadCachedGraphMeta(
  cachePath: string,
): Promise<{ edges: GraphEdge[]; generatedAt: string } | null> {
  const raw = await readCacheFile(cachePath);
  if (raw === null) return null;
  const parsed = parseCacheJson(raw, cachePath);
  if (!isRecord(parsed)) {
    throw new Error(`Graph cache "${cachePath}" has an invalid format.`);
  }
  if (parsed.version !== CACHE_VERSION) return null;
  if (
    typeof parsed.generatedAt !== "string" ||
    !Array.isArray(parsed.edges) ||
    !parsed.edges.every((edge) =>
      isRecord(edge) &&
      typeof edge.from === "string" &&
      typeof edge.to === "string" &&
      typeof edge.weight === "number" &&
      typeof edge.kind === "string"
    )
  ) {
    throw new Error(`Graph cache "${cachePath}" has an invalid format.`);
  }
  return { edges: parsed.edges as GraphEdge[], generatedAt: parsed.generatedAt };
}

// ---------------------------------------------------------------------------
// Node index — per-note metadata for axis-filtered retrieval (C2)
// ---------------------------------------------------------------------------

const NODE_CACHE_VERSION = 2;

/** JSON-serialisable form of EngineGraphNode (Set → string[] for searchTerms). */
interface SerializedNode {
  readonly path: string;
  readonly concept: string | null;
  readonly folder: string;
  readonly axes: Record<string, AxisScalar[]>;
  readonly wikilinks: string[];
  readonly bodyPreview: string;
  readonly searchTerms: string[];
}

interface NodeCacheFile {
  readonly version: number;
  readonly generatedAt: string;
  readonly sourceSignature: string;
  readonly nodes: SerializedNode[];
}

/** Hash sorted markdown paths and bytes so add/edit/delete invalidates a cache. */
export async function nodeSourceSignature(vaultPath: string): Promise<string> {
  const vault = path.resolve(vaultPath);
  const isExcluded = await excludedNoteMatcher(vault);
  const files: string[] = [];
  for await (const file of walkMarkdown(vault, vault, isExcluded)) files.push(file);
  files.sort();

  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file);
    digest.update("\0");
    digest.update(await readFile(path.join(vault, file)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function inferNodeCacheVault(cachePath: string): string {
  const absolute = path.resolve(cachePath);
  const engineDir = path.basename(path.dirname(absolute));
  const cacheDir = path.basename(path.dirname(path.dirname(absolute)));
  const omsDir = path.basename(path.dirname(path.dirname(path.dirname(absolute))));
  if (engineDir === "engine" && cacheDir === "cache" && omsDir === ".oms") {
    return path.dirname(path.dirname(path.dirname(path.dirname(absolute))));
  }
  return path.dirname(absolute);
}

/**
 * Scan the vault (or an explicit file slice) and build the per-note index
 * consumed by retrieve_by_axis.
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
    await validateExplicitFiles(vaultPath, files);
  } else {
    const isExcluded = await excludedNoteMatcher(vaultPath);
    const collected: string[] = [];
    for await (const f of walkMarkdown(vaultPath, vaultPath, isExcluded)) collected.push(f);
    files = collected;
  }

  const index = buildWikilinkIndex(files);
  const nodes: EngineGraphNode[] = [];

  for (const docPath of files) {
    const raw = await readFile(path.join(vaultPath, docPath), "utf-8");

    const frontmatter = parseFrontmatter(raw, docPath);
    const body = extractBody(raw);

    const conceptRaw = frontmatter["concept"];
    const concept = typeof conceptRaw === "string" ? conceptRaw : null;

    const axes: Record<string, AxisScalar[]> = {};
    const fmStrings: string[] = [];
    for (const [key, value] of Object.entries(frontmatter)) {
      const arr = toAxisScalars(value);
      if (arr.length > 0) {
        axes[key] = arr;
        fmStrings.push(...arr.map((item) => String(item)));
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
      // Keep the node-index DTO compatible with legacy graph renderers. The
      // runtime values remain typed (the cast only documents the old surface).
      axes: axes as unknown as Record<string, string[]>,
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
  sourceSignature?: string,
): Promise<void> {
  const file: NodeCacheFile = {
    version: NODE_CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    sourceSignature: sourceSignature ?? await nodeSourceSignature(inferNodeCacheVault(cachePath)),
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
  await writeCacheAtomically(cachePath, `${JSON.stringify(file)}\n`);
}

/**
 * Load the node index from `cachePath`, rebuilding each searchTerms Set from
 * its serialised array form. Returns `null` when absent, stale, or when the
 * markdown source signature no longer matches the cache. Corrupt or
 * unreadable files fail loudly so a partial snapshot is never accepted.
 */
export async function loadNodeIndex(
  cachePath: string,
  sourceSignature?: string,
): Promise<EngineGraphNode[] | null> {
  const raw = await readCacheFile(cachePath);
  if (raw === null) return null;
  const parsed = parseCacheJson(raw, cachePath);
  if (!isRecord(parsed)) {
    throw new Error(`Node cache "${cachePath}" has an invalid format.`);
  }
  if (parsed.version !== NODE_CACHE_VERSION) return null;
  if (
    typeof parsed.sourceSignature !== "string" ||
    typeof parsed.generatedAt !== "string" ||
    !Array.isArray(parsed.nodes) ||
    !parsed.nodes.every((node) =>
      isRecord(node) &&
      typeof node.path === "string" &&
      (typeof node.concept === "string" || node.concept === null) &&
      typeof node.folder === "string" &&
      isRecord(node.axes) &&
      Array.isArray(node.wikilinks) &&
      node.wikilinks.every((item) => typeof item === "string") &&
      typeof node.bodyPreview === "string" &&
      Array.isArray(node.searchTerms) &&
      node.searchTerms.every((item) => typeof item === "string")
    )
  ) {
    throw new Error(`Node cache "${cachePath}" has an invalid format.`);
  }
  const expectedSignature = sourceSignature ?? await nodeSourceSignature(inferNodeCacheVault(cachePath));
  if (parsed.sourceSignature !== expectedSignature) return null;
  return (parsed.nodes as SerializedNode[]).map((n) => ({
    path: n.path,
    concept: n.concept,
    folder: n.folder,
    // Typed values survive JSON round-tripping; retain the legacy DTO
    // declaration for graph consumers.
    axes: n.axes as unknown as Record<string, string[]>,
    wikilinks: n.wikilinks,
    bodyPreview: n.bodyPreview,
    searchTerms: new Set(n.searchTerms),
  }));
}
