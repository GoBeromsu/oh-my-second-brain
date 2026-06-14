/**
 * McpEngineAdapter — engine-side adapter facade for the 10 MCP ops.
 *
 * Receives DispatcherDeps + the vault root as INJECTED dependencies; never
 * instantiates VectorStore, EmbeddingProvider, or any other backend. Backend
 * construction is the assemble step (assemble.ts), which passes the real
 * EngineStore + EmbeddingProvider via DispatcherDeps and the vault path here.
 *
 * This class owns the translation between MCP op inputs/outputs and the
 * engine's retrieval / sync / graph contracts:
 *   - semantic_query      → dispatch() over the RRF pipeline
 *   - sync_embeddings     → syncEngineStore() (vault scan → chunk → embed → upsert)
 *   - semantic_status / collections / contexts → caps probe of DispatcherDeps
 *   - semantic_cleanup    → orphan diff (store paths − live vault paths)
 *   - graph_build / status → builder.ts edge graph + node index, cached on disk
 *   - retrieve_by_axis    → node-index axis filter + lexical score
 *   - retrieve_context    → axis-seeded local-graph exploration + optional semantic fan-out
 *
 * R18: NO import from src/search.
 */

import path from "node:path";
import { readFileSync } from "node:fs";
import { dispatch } from "../retrieval/dispatcher.js";
import type { DispatcherDeps } from "../retrieval/dispatcher.js";
import { syncEngineStore, walkMarkdown } from "../embed/sync.js";
import type { EngineStore } from "../embed/store.js";
import {
  buildGraph,
  saveCachedGraph,
  loadCachedGraph,
  loadCachedGraphMeta,
  buildNodeIndex,
  saveNodeIndex,
  loadNodeIndex,
} from "../graph/builder.js";
import type { EngineGraphNode } from "../graph/node.js";
import { filterNodesByAxis, searchScore } from "../graph/node.js";
import { exploreEngineGraph } from "../graph/explore.js";
import type { EngineGraphExploreNode } from "../graph/explore.js";
import type {
  McpSemanticQueryOptions,
  McpSemanticQueryResult,
  McpSemanticEmbeddingSyncOptions,
  McpSemanticEmbeddingSyncResult,
  McpStatusOptions,
  McpSemanticProviderStatus,
  McpSemanticCollectionResult,
  McpSemanticContextResult,
  McpSemanticCleanupResult,
  McpGraphBuildOptions,
  McpGraphBuildResult,
  McpGraphStatusResult,
  McpAxisFilters,
  McpRetrieveContextOptions,
  McpSemanticSearchHit,
  EngineSyncResult,
  McpSemanticGetOptions,
  McpSemanticMultiGetOptions,
  McpSemanticDocumentResult,
  McpSemanticDocument,
} from "./types.js";
import {
  queryOptionsToSubQueries,
  retrievalResultsToQueryResult,
  queryResultUnavailable,
} from "./query-mapper.js";
import {
  engineSyncResultToMcp,
  syncResultUnavailable,
  capsToEngineStatusResult,
  engineStatusResultToMcp,
  statusResultUnavailable,
  engineStatusToCollectionResult,
  engineStatusToContextResult,
  cleanupResultUnavailable,
  graphBuildOptionsToEngineArgs,
  engineGraphBuildResultToMcp,
  engineGraphBuildToStatusResult,
} from "./op-mappers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

// ---------------------------------------------------------------------------
// Document-hydration helpers (file-based, R18-clean — no src/search imports)
// ---------------------------------------------------------------------------

interface ParsedDocTarget {
  readonly filePath: string;
  readonly fromLine?: number;
  readonly lineCount?: number;
  readonly isDocid: boolean;
  readonly isGlob: boolean;
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return parsed > 0 ? parsed : undefined;
}

/**
 * Strip a resource scheme to a vault-relative path (parity with src/search
 * normalizePath): qmd://<path> and oms://<collection>/<path> are URL-decoded;
 * plain targets get backslashes and a leading "./" normalized away.
 */
function normalizeDocScheme(target: string): string {
  if (target.startsWith("qmd://")) {
    return decodeURIComponent(target.slice("qmd://".length)).replace(/^\/+/u, "");
  }
  if (target.startsWith("oms://")) {
    const rest = target.slice("oms://".length);
    const slash = rest.indexOf("/");
    return slash >= 0 ? decodeURIComponent(rest.slice(slash + 1)) : "";
  }
  return target.replace(/\\/g, "/").replace(/^\.?\//u, "");
}

/** Split a trailing line range off a path, supporting both colon forms. */
function splitDocRange(value: string): { filePath: string; fromLine?: number; lineCount?: number } {
  const parts = value.split(":");
  // src/search colon form: "file:FROM:COUNT" (>= 3 parts, last two positive ints).
  if (parts.length >= 3) {
    const count = positiveInt(parts.at(-1));
    const from = positiveInt(parts.at(-2));
    if (from !== undefined && count !== undefined) {
      return { filePath: parts.slice(0, -2).join(":"), fromLine: from, lineCount: count };
    }
  }
  const colonIdx = value.lastIndexOf(":");
  if (colonIdx > 0) {
    const rangePart = value.slice(colonIdx + 1);
    const filePart = value.slice(0, colonIdx);
    const dash = /^(\d+)-(\d+)$/u.exec(rangePart);
    if (dash) {
      const from = parseInt(dash[1]!, 10);
      const to = parseInt(dash[2]!, 10);
      return { filePath: filePart, fromLine: from, lineCount: Math.max(0, to - from + 1) };
    }
    if (/^\d+$/u.test(rangePart)) {
      return { filePath: filePart, fromLine: parseInt(rangePart, 10), lineCount: 1 };
    }
  }
  return { filePath: value };
}

/**
 * Parse target forms: "#docid", "file.md", "file.md:N", "file.md:N-M",
 * "file.md:FROM:COUNT", "dir/*.md" (glob), and qmd:// / oms:// resource URIs.
 */
function parseDocTarget(target: string): ParsedDocTarget {
  if (target.startsWith("#")) {
    return { filePath: target.slice(1), isDocid: true, isGlob: false };
  }
  const scheme = normalizeDocScheme(target);
  const { filePath, fromLine, lineCount } = splitDocRange(scheme);
  return { filePath, fromLine, lineCount, isDocid: false, isGlob: filePath.includes("*") };
}

/** Mirror src/search globRegex: "*" → one path segment, "**" → any depth. */
function docGlobToRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? "";
    const next = pattern[index + 1] ?? "";
    if (char === "*" && next === "*") {
      source += ".*";
      index++;
    } else if (char === "*") {
      source += "[^/]*";
    } else if ("|\\{}()[]^$+?.".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`, "u");
}

/** Filesystem glob over the vault's markdown files; sorted for determinism. */
async function globVaultDocs(vault: string, pattern: string): Promise<string[]> {
  const regex = docGlobToRegex(pattern);
  const matches: string[] = [];
  for await (const rel of walkMarkdown(vault, vault)) {
    if (regex.test(rel)) matches.push(rel);
  }
  return matches.sort((a, b) => a.localeCompare(b));
}

/** Return true if resolving filePath inside vaultRoot would escape the vault. */
function isUnsafeVaultPath(filePath: string, vaultRoot: string): boolean {
  if (path.isAbsolute(filePath)) return true;
  const root = path.resolve(vaultRoot);
  const resolved = path.resolve(vaultRoot, filePath);
  return resolved !== root && !resolved.startsWith(root + path.sep);
}

/** Slice and optionally number lines. lineNumbers format: "N\tline". */
function sliceDocLines(
  content: string,
  opts: { readonly fromLine?: number; readonly lineCount?: number; readonly lineLimit?: number; readonly lineNumbers?: boolean },
): string {
  const lines = content.split(/\r?\n/u);
  const start = Math.max(0, (opts.fromLine ?? 1) - 1);
  const count = opts.lineCount ?? opts.lineLimit ?? lines.length;
  const selected = lines.slice(start, start + Math.max(0, count));
  return selected
    .map((line, index) => (opts.lineNumbers === true ? `${start + index + 1}\t${line}` : line))
    .join("\n");
}

/** Cheaply extract a title from the first 20 lines (# H1 or frontmatter title:). */
function extractDocTitle(content: string): string | undefined {
  for (const line of content.split(/\r?\n/u).slice(0, 20)) {
    const h1 = /^#\s+(.+)$/u.exec(line);
    if (h1) return h1[1]!.trim();
    const fm = /^title:\s*(.+)$/u.exec(line);
    if (fm) return fm[1]!.trim();
  }
  return undefined;
}

/**
 * First body lines (YAML frontmatter stripped, heading markers removed) as a
 * single-line preview, capped to maxChars. The engine's retrieval is
 * document-level (no chunk offsets), so this is an honest doc-head preview, not
 * a match-centered excerpt.
 */
function docHeadSnippet(content: string, maxChars = 200): string {
  let body = content;
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u.exec(body);
  if (fm && fm.index === 0) body = body.slice(fm[0].length);
  const preview = body
    .split(/\r?\n/u)
    .map((line) => line.replace(/^#{1,6}\s+/u, "").trim())
    .filter((line) => line.length > 0)
    .join(" ");
  return preview.length > maxChars ? `${preview.slice(0, maxChars).trimEnd()}…` : preview;
}

/**
 * Best-effort title + doc-head snippet for ranked hits. Retrieval returns
 * document-level paths only, so the snippet is the note's opening body (not a
 * passage match) — practical parity with the src/search hit preview without
 * faking relevance. Out-of-vault paths or read failures degrade to the bare hit
 * (empty snippet, no title), never throwing.
 */
function enrichQueryHits(result: McpSemanticQueryResult, vault: string): McpSemanticQueryResult {
  if (!result.available || result.hits.length === 0) return result;
  const hits = result.hits.map((hit): McpSemanticSearchHit => {
    if (isUnsafeVaultPath(hit.path, vault)) return hit;
    let raw: string;
    try {
      raw = readFileSync(path.join(vault, hit.path), "utf-8");
    } catch {
      return hit;
    }
    const title = extractDocTitle(raw);
    return { ...hit, snippet: docHeadSnippet(raw), ...(title !== undefined ? { title } : {}) };
  });
  return { available: true, hits };
}

// ---------------------------------------------------------------------------
// Adapter facade
// ---------------------------------------------------------------------------

/**
 * Engine-side adapter for the 10 MCP ops.
 *
 * Construct with injected DispatcherDeps + the vault root; the assemble step
 * wires the real EngineStore + EmbeddingProvider into those deps.
 */
export class McpEngineAdapter {
  /**
   * @param deps      - Injected backend dependencies (store + embed required).
   * @param vaultPath - Absolute vault root, used by graph / sync / cleanup /
   *                    retrieve ops that are vault-scoped. Required so tsc
   *                    enforces it at every construction site (RISK-4).
   * @param modelPath - Server-configured GGUF path (OMS_MODEL_PATH, resolved by
   *                    assembleEngine). Threaded into syncEmbeddings so a sync
   *                    triggered through the MCP surface — which carries no
   *                    per-call modelPath — still reaches the real provider
   *                    instead of tripping the ADR-007 model-less guard.
   */
  constructor(
    private readonly deps: DispatcherDeps,
    private readonly vaultPath: string,
    private readonly modelPath?: string,
  ) {}

  // -------------------------------------------------------------------------
  // Cache-path + node-index helpers
  // -------------------------------------------------------------------------

  private graphCachePath(vault: string): string {
    return path.join(vault, ".oms", "cache", "engine", "graph.json");
  }

  private nodeCachePath(vault: string): string {
    return path.join(vault, ".oms", "cache", "engine", "node-index.json");
  }

  /** Load the node index from cache, building it live on a cache miss. */
  private async loadOrBuildNodes(): Promise<EngineGraphNode[]> {
    const cached = await loadNodeIndex(this.nodeCachePath(this.vaultPath));
    if (cached !== null) return cached;
    return buildNodeIndex({ vaultPath: this.vaultPath });
  }

  // -------------------------------------------------------------------------
  // 1. oms_semantic_query (centerpiece)
  // -------------------------------------------------------------------------

  /**
   * Execute a semantic query and return MCP-shaped results.
   * Maps opts → TypedSubQuery[] → dispatch() → McpSemanticQueryResult.
   */
  async semanticQuery(opts: McpSemanticQueryOptions): Promise<McpSemanticQueryResult> {
    const subQueries = queryOptionsToSubQueries(opts);
    if (subQueries.length === 0) {
      return queryResultUnavailable("No sub-queries derived from options");
    }
    try {
      const k = opts.candidateLimit ?? 20;
      const results = await dispatch(subQueries, this.deps, k);
      const mapped = retrievalResultsToQueryResult(results, opts);
      // Fill title + doc-head snippet from disk so engine hits reach practical
      // parity with the src/search preview (the pure mapper stays text-free).
      return enrichQueryHits(mapped, opts.vault ?? this.vaultPath);
    } catch (err) {
      return queryResultUnavailable(err instanceof Error ? err.message : String(err));
    }
  }

  // -------------------------------------------------------------------------
  // 2. oms_sync_embeddings
  // -------------------------------------------------------------------------

  /**
   * Sync the vault into the engine store: scan → chunk → embed → upsert.
   *
   * Delegates to syncEngineStore() (embed/sync.ts), which performs SHA-256
   * incremental diffing so unchanged chunks are skipped. The mandatory
   * `status` field is synthesized from deps.embed + the run counters.
   *
   * Note: syncEngineStore opens its own provider+store internally; the GGUF
   * pool deduplicates by loadPromise per process so this is safe (RISK-1).
   */
  async syncEmbeddings(
    opts: McpSemanticEmbeddingSyncOptions,
  ): Promise<McpSemanticEmbeddingSyncResult> {
    try {
      const syncResult = await syncEngineStore({
        vault: opts.vault,
        collection: opts.collection,
        collectionPath: opts.collectionPath,
        // Fall back to the server-configured model (OMS_MODEL_PATH) when the MCP
        // call omits an explicit modelPath — otherwise syncEngineStore builds a
        // model-less provider and the ADR-007 guard rejects the sync. Mirrors
        // AssembledEngine.syncVault, which threads config.modelPath the same way.
        modelPath: opts.modelPath ?? this.modelPath,
        embed: opts.embed ?? true,
      });
      if (!syncResult.available) {
        return syncResultUnavailable(syncResult.reason ?? "sync unavailable", opts);
      }
      const engineResult: EngineSyncResult = {
        upserted: syncResult.added + syncResult.updated,
        skipped: syncResult.skipped,
        errors: 0,
      };
      const statusSnapshot: McpSemanticProviderStatus & { readonly available: true } = {
        available: true,
        storage: opts.storage ?? "oms-native-json",
        models: { embedding: this.deps.embed.model },
        index: {
          documents: {
            total: syncResult.scanned,
            vectors: syncResult.added + syncResult.updated,
          },
        },
      };
      return engineSyncResultToMcp(engineResult, opts, statusSnapshot);
    } catch (err) {
      return syncResultUnavailable(
        err instanceof Error ? err.message : String(err),
        opts,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 3. oms_semantic_status
  // -------------------------------------------------------------------------

  /** Return status derived from the injected embed + store capabilities. */
  semanticStatus(_opts: McpStatusOptions): McpSemanticProviderStatus {
    try {
      const engineResult = capsToEngineStatusResult(this.deps.embed, this.deps.store);
      return engineStatusResultToMcp(engineResult);
    } catch (err) {
      return statusResultUnavailable(err instanceof Error ? err.message : String(err));
    }
  }

  // -------------------------------------------------------------------------
  // 4. oms_semantic_collections
  // -------------------------------------------------------------------------

  /** List embedding collections visible through the injected store. */
  listCollections(_opts: McpStatusOptions): McpSemanticCollectionResult {
    try {
      const engineResult = capsToEngineStatusResult(this.deps.embed, this.deps.store);
      return engineStatusToCollectionResult(engineResult);
    } catch (err) {
      return {
        available: false,
        reason: err instanceof Error ? err.message : String(err),
        collections: [],
      };
    }
  }

  // -------------------------------------------------------------------------
  // 5. oms_semantic_contexts
  // -------------------------------------------------------------------------

  /** List semantic contexts from the injected store. */
  listContexts(_opts: McpStatusOptions): McpSemanticContextResult {
    try {
      const engineResult = capsToEngineStatusResult(this.deps.embed, this.deps.store);
      return engineStatusToContextResult(engineResult);
    } catch (err) {
      return {
        available: false,
        reason: err instanceof Error ? err.message : String(err),
        contexts: [],
      };
    }
  }

  // -------------------------------------------------------------------------
  // 6. oms_semantic_cleanup
  // -------------------------------------------------------------------------

  /**
   * Remove orphaned documents from the store: any stored doc_path that no
   * longer exists in the live vault is cleared (meta + vec + FTS).
   */
  async cleanup(_opts: McpStatusOptions): Promise<McpSemanticCleanupResult> {
    try {
      const store = this.deps.store as EngineStore;
      const livePaths = new Set<string>();
      for await (const rel of walkMarkdown(this.vaultPath, this.vaultPath)) {
        livePaths.add(rel);
      }
      const storePaths = store.listDocPaths();
      let removed = 0;
      for (const docPath of storePaths) {
        if (!livePaths.has(docPath)) {
          store.clearDocument(docPath);
          removed++;
        }
      }
      return {
        available: true,
        storage: "oms-native-json",
        removedDocuments: removed,
        remainingDocuments: storePaths.length - removed,
        collections: 1,
      };
    } catch (err) {
      return cleanupResultUnavailable(err instanceof Error ? err.message : String(err));
    }
  }

  // -------------------------------------------------------------------------
  // 7. oms_graph_build
  // -------------------------------------------------------------------------

  /**
   * Build the edge graph + node index and persist both to .oms/cache/engine/.
   * On dryRun, report stats from the existing cache without rebuilding.
   */
  async graphBuild(opts: McpGraphBuildOptions, vaultPath: string): Promise<McpGraphBuildResult> {
    const args = graphBuildOptionsToEngineArgs(opts, vaultPath);
    const graphCachePath = this.graphCachePath(args.vaultPath);

    if (args.dryRun) {
      const meta = await loadCachedGraphMeta(graphCachePath);
      if (meta !== null) {
        const noteSet = new Set(meta.edges.flatMap((e) => [e.from, e.to]));
        return engineGraphBuildResultToMcp({
          notes: noteSet.size,
          edges: meta.edges.length,
          generatedAt: meta.generatedAt,
        });
      }
      return engineGraphBuildResultToMcp({
        notes: 0,
        edges: 0,
        generatedAt: new Date().toISOString(),
      });
    }

    const edges = await buildGraph({ vaultPath: args.vaultPath });
    await saveCachedGraph(graphCachePath, edges);

    const nodes = await buildNodeIndex({ vaultPath: args.vaultPath });
    await saveNodeIndex(this.nodeCachePath(args.vaultPath), nodes);

    const noteSet = new Set(edges.flatMap((e) => [e.from, e.to]));
    return engineGraphBuildResultToMcp({
      notes: noteSet.size,
      edges: edges.length,
      generatedAt: new Date().toISOString(),
    });
  }

  // -------------------------------------------------------------------------
  // 8a. oms_graph_status
  // -------------------------------------------------------------------------

  /** Report graph cache status (notes / edges / generatedAt) from disk. */
  async graphStatus(vaultPath: string): Promise<McpGraphStatusResult> {
    const meta = await loadCachedGraphMeta(this.graphCachePath(vaultPath));
    if (meta === null) return engineGraphBuildToStatusResult(null);
    const noteSet = new Set(meta.edges.flatMap((e) => [e.from, e.to]));
    return engineGraphBuildToStatusResult({
      notes: noteSet.size,
      edges: meta.edges.length,
      generatedAt: meta.generatedAt,
    });
  }

  // -------------------------------------------------------------------------
  // 8b. oms_retrieve_by_axis
  // -------------------------------------------------------------------------

  /**
   * Filter the node index by axis (concept / folder / property / value /
   * wikilink), rank by lexical overlap with the optional query, return hits.
   * Axis metadata (concept / folder / axes / wikilinks) is JSON-encoded into
   * the hit's `context` field for callers that need it (RISK-6).
   */
  async retrieveByAxis(filters: McpAxisFilters): Promise<McpSemanticQueryResult> {
    try {
      const nodes = await this.loadOrBuildNodes();
      const limit = clamp(filters.limit ?? 10, 1, 50);
      const filtered = filterNodesByAxis(nodes, {
        concept: filters.concept,
        folder: filters.folder,
        property: filters.property,
        value: filters.value,
        wikilink: filters.wikilink,
      });
      const query = filters.query ?? "";
      const scored = filtered
        .map((node) => ({ node, score: searchScore(node, query) }))
        .sort((a, b) => b.score - a.score || a.node.path.localeCompare(b.node.path))
        .slice(0, limit);
      const hits: McpSemanticSearchHit[] = scored.map(({ node, score }) => ({
        docid: node.path,
        score,
        uri: node.path,
        path: node.path,
        snippet: node.bodyPreview,
        context: JSON.stringify({
          concept: node.concept,
          folder: node.folder,
          axes: node.axes,
          wikilinks: node.wikilinks,
        }),
        evidence: { lexical: true, vector: false },
      }));
      return { available: true, hits };
    } catch (err) {
      return { available: false, reason: err instanceof Error ? err.message : String(err), hits: [] };
    }
  }

  // -------------------------------------------------------------------------
  // 8c. oms_retrieve_context
  // -------------------------------------------------------------------------

  /**
   * Axis-seeded local-graph exploration: filter nodes to seeds, expand the
   * neighbourhood via property-value / wikilink / backlink reasons, then
   * optionally fan out semantic sub-queries through dispatch(). Hits are
   * assembled seeds → neighbours → semantic (no re-ranking — mirrors the
   * floor contract). Dropped semantic sub-fields are the documented GAP-10.
   */
  async retrieveContext(opts: McpRetrieveContextOptions): Promise<McpSemanticQueryResult> {
    try {
      const nodes = await this.loadOrBuildNodes();
      let edges = await loadCachedGraph(this.graphCachePath(this.vaultPath));
      if (edges === null) edges = await buildGraph({ vaultPath: this.vaultPath });

      const exploreResult = exploreEngineGraph(nodes, edges, {
        concept: opts.concept,
        folder: opts.folder,
        property: opts.property,
        value: opts.value,
        wikilink: opts.wikilink,
        query: opts.query,
        limit: opts.limit,
        maxNeighbors: opts.maxNeighbors,
      });

      let semanticHits: McpSemanticSearchHit[] = [];
      if (opts.semanticSearches && opts.semanticSearches.length > 0) {
        const first = opts.semanticSearches[0];
        const queryResult = await this.semanticQuery({
          query: first?.query ?? opts.query ?? "",
          searches: opts.semanticSearches,
          limit: opts.maxNeighbors ?? 10,
        });
        if (queryResult.available) semanticHits = [...queryResult.hits];
      }

      const nodeToHit = (n: EngineGraphExploreNode, source: string): McpSemanticSearchHit => ({
        docid: n.path,
        score: n.score,
        uri: n.path,
        path: n.path,
        snippet: n.bodyPreview,
        context: JSON.stringify({
          source,
          concept: n.concept,
          folder: n.folder,
          axes: n.axes,
          reasons: n.reasons,
        }),
        evidence: { lexical: true, vector: false },
      });

      const hits: McpSemanticSearchHit[] = [
        ...exploreResult.seeds.map((n) => nodeToHit(n, "oms-seed")),
        ...exploreResult.neighbors.map((n) => nodeToHit(n, "oms-neighbor")),
        ...semanticHits,
      ];
      return { available: true, hits };
    } catch (err) {
      return { available: false, reason: err instanceof Error ? err.message : String(err), hits: [] };
    }
  }

  // -------------------------------------------------------------------------
  // 9. oms_get — single-document file-based hydration (GAP-9)
  // -------------------------------------------------------------------------

  /**
   * Hydrate one document from disk by real vault-relative path (ADR-008).
   * Supports "file.md", "file.md:N" (single line), "file.md:N-M" (range),
   * and "#docid" (resolved via store.listDocPaths). No embedding model needed.
   */
  async getDocument(opts: McpSemanticGetOptions): Promise<McpSemanticDocumentResult> {
    const vault = opts.vault ?? this.vaultPath;
    const parsed = parseDocTarget(opts.target);

    let resolvedPath = parsed.filePath;
    if (parsed.isDocid) {
      const store = this.deps.store as EngineStore;
      const matched = store.listDocPaths().find((p) => p === parsed.filePath);
      if (!matched) {
        return { available: false, reason: `No OMS document matched "${opts.target}".`, documents: [] };
      }
      resolvedPath = matched;
    } else if (parsed.isGlob) {
      const [matched] = await globVaultDocs(vault, parsed.filePath);
      if (!matched) {
        return { available: false, reason: `No OMS document matched "${opts.target}".`, documents: [] };
      }
      resolvedPath = matched;
    }

    if (isUnsafeVaultPath(resolvedPath, vault)) {
      return { available: false, reason: "OMS semantic document target must stay inside the vault.", documents: [] };
    }

    let raw: string;
    try {
      raw = readFileSync(path.join(vault, resolvedPath), "utf-8");
    } catch {
      return { available: false, reason: `No OMS document matched "${opts.target}".`, documents: [] };
    }

    const content = sliceDocLines(raw, {
      fromLine: opts.fromLine ?? parsed.fromLine,
      lineCount: opts.lineCount ?? parsed.lineCount,
      lineNumbers: opts.lineNumbers,
    });

    const doc: McpSemanticDocument = {
      target: opts.target,
      path: opts.fullPath === true ? path.join(vault, resolvedPath) : resolvedPath,
      content,
      docid: resolvedPath,
      title: extractDocTitle(raw),
    };

    return { available: true, documents: [doc] };
  }

  // -------------------------------------------------------------------------
  // 10. oms_multi_get — batch file-based hydration (GAP-9)
  // -------------------------------------------------------------------------

  /**
   * Hydrate multiple documents from disk. De-dups by resolved path. Honors
   * lineLimit per doc and stops early when accumulated bytes would exceed
   * maxBytes (returns available:true with partial results, mirroring src/search).
   */
  async multiGetDocuments(opts: McpSemanticMultiGetOptions): Promise<McpSemanticDocumentResult> {
    const vault = opts.vault ?? this.vaultPath;
    const documents: McpSemanticDocument[] = [];
    const seen = new Set<string>();
    let usedBytes = 0;

    for (const rawTarget of opts.targets) {
      const parsed = parseDocTarget(rawTarget);

      let resolvedPaths: string[];
      if (parsed.isDocid) {
        const store = this.deps.store as EngineStore;
        const matched = store.listDocPaths().find((p) => p === parsed.filePath);
        resolvedPaths = matched ? [matched] : [];
      } else if (parsed.isGlob) {
        resolvedPaths = await globVaultDocs(vault, parsed.filePath);
      } else {
        resolvedPaths = [parsed.filePath];
      }

      for (const resolvedPath of resolvedPaths) {
        if (isUnsafeVaultPath(resolvedPath, vault)) {
          return { available: false, reason: "OMS semantic document target must stay inside the vault.", documents: [] };
        }

        if (seen.has(resolvedPath)) continue;

        let raw: string;
        try {
          raw = readFileSync(path.join(vault, resolvedPath), "utf-8");
        } catch {
          continue;
        }

        const content = sliceDocLines(raw, {
          fromLine: parsed.fromLine,
          lineCount: parsed.lineCount,
          lineLimit: opts.lineLimit,
          lineNumbers: opts.lineNumbers,
        });

        const nextBytes = Buffer.byteLength(content, "utf-8");
        if (opts.maxBytes && usedBytes + nextBytes > opts.maxBytes) {
          return { available: true, documents };
        }

        seen.add(resolvedPath);
        usedBytes += nextBytes;

        documents.push({
          target: rawTarget,
          path: opts.fullPath === true ? path.join(vault, resolvedPath) : resolvedPath,
          content,
          docid: resolvedPath,
          title: extractDocTitle(raw),
        });
      }
    }

    return { available: true, documents };
  }
}
