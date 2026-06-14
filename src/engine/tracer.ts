/**
 * End-to-end retrieval tracer — wires embed (C1), graph (C2), retrieval (C3).
 *
 * Minimal C4 vault resolver: reads OMS_VAULT env for the vault path when no
 * explicit config is passed.
 *
 * Design constraints (R2):
 *   - NO daemon, NO watcher, NO setInterval, NO persistent process.
 *   - Every call is a pure function: disk + .oms/cache are the only persistence.
 *
 * Pipeline:
 *   vault slice → chunk (C1) → embed (C1) → upsert store (C1)
 *     → typed queries (C3) → RRF → RetrievalResult[]
 */

import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { EngineConfig, RetrievalResult, TypedSubQuery } from "./types.js";
import { chunkDocument } from "./embed/chunker.js";
import { requireRealEmbeddingProvider } from "./embed/provider.js";
import { openEngineStore } from "./embed/store.js";
import { buildGraph, loadCachedGraph, saveCachedGraph } from "./graph/builder.js";
import { buildAdjacency, traverseGraph } from "./graph/traverse.js";
import { retrieve, createCancelToken } from "./retrieval/index.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Configuration for a single runTracer() invocation.
 * Extends the shared EngineConfig with tracer-specific options.
 */
export interface TracerConfig extends EngineConfig {
  /**
   * Vault-relative file paths to process in this run.
   * When absent, the entire vault is walked recursively.
   */
  files?: readonly string[];
  /**
   * Directory for `.oms/cache` artifacts (graph.json, etc.).
   * Defaults to `<vaultPath>/.oms/cache`.
   */
  cacheDir?: string;
  /** Number of top results to return (default 10). */
  topK?: number;
}

// ---------------------------------------------------------------------------
// Vault walker (mirrors builder.ts private helper — kept local to tracer)
// ---------------------------------------------------------------------------

async function* walkMd(dir: string, base: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".oms" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMd(full, base);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield path.relative(base, full).replace(/\\/g, "/");
    }
  }
}

async function resolveFiles(vaultPath: string, explicit?: readonly string[]): Promise<string[]> {
  if (explicit !== undefined) return explicit.slice();
  const collected: string[] = [];
  for await (const f of walkMd(vaultPath, vaultPath)) collected.push(f);
  return collected;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the end-to-end retrieval pipeline against a vault slice and return the
 * top-k fused results.
 *
 * Steps:
 *   1. Resolve vault files (explicit list or full walk).
 *   2. Chunk + embed each document, upsert into the SQLite VectorStore.
 *   3. Load or build the document link graph; cache it under cacheDir.
 *   4. Construct DispatcherDeps wiring store + embed + graphTraverse.
 *   5. Dispatch the TypedSubQuery[] through the C3 retrieval pipeline.
 *   6. Return the top-k RetrievalResult[] sorted descending by score.
 *
 * @param config  - Tracer configuration (vault path, DB path, dimensions, etc.).
 * @param queries - Typed sub-queries to fan out across retrieval modalities.
 */
export async function runTracer(
  config: TracerConfig,
  queries: TypedSubQuery[],
): Promise<RetrievalResult[]> {
  const vaultPath = path.resolve(config.vaultPath);
  const cacheDir = config.cacheDir ?? path.join(vaultPath, ".oms", "cache");
  const topK = config.topK ?? 10;

  // ── Step 1: resolve vault files ───────────────────────────────────────────
  const files = await resolveFiles(vaultPath, config.files);

  // ── Step 2: create embed provider + store ─────────────────────────────────
  const embedProvider = requireRealEmbeddingProvider({ modelPath: config.modelPath });
  await mkdir(path.dirname(config.dbPath), { recursive: true });
  const store = openEngineStore(config.dbPath, config.embeddingDimensions);

  try {
    // Chunk + embed + upsert every resolved file
    for (const filePath of files) {
      const fullPath = path.join(vaultPath, filePath);
      let text: string;
      try {
        text = await readFile(fullPath, "utf-8");
      } catch {
        // Unreadable or missing file — skip gracefully
        continue;
      }

      const chunks = chunkDocument(filePath, text);
      if (chunks.length === 0) continue;

      // Embed all chunks in the file in parallel
      const withVectors = await Promise.all(
        chunks.map(async (chunk) => ({
          ...chunk,
          vector: await embedProvider.embed(chunk.text),
        })),
      );
      store.upsert(withVectors);
    }

    // ── Step 3: load or build graph ─────────────────────────────────────────
    const graphCachePath = path.join(cacheDir, "engine", "graph.json");
    let edges = await loadCachedGraph(graphCachePath);
    if (edges === null) {
      edges = await buildGraph({ vaultPath, files });
      await saveCachedGraph(graphCachePath, edges);
    }
    const adj = buildAdjacency(edges);

    // ── Step 4: dispatch retrieval ───────────────────────────────────────────
    const cancel = createCancelToken();
    const results = await retrieve({
      subQueries: queries,
      deps: {
        store,
        embed: embedProvider,
        graphTraverse: (gphQuery) => traverseGraph(adj, gphQuery),
      },
      k: topK,
      cancel,
    });

    return results;
  } finally {
    store.close();
    await embedProvider.dispose();
  }
}

// ---------------------------------------------------------------------------
// Minimal C4: resolve vault from environment
// ---------------------------------------------------------------------------

/**
 * Resolve the vault path for the tracer from:
 *   1. `OMS_VAULT` environment variable (absolute or home-relative path)
 *   2. Falls back to the current working directory
 */
export function resolveVault(): string {
  const env = process.env["OMS_VAULT"];
  if (env) {
    // Expand leading ~
    if (env.startsWith("~/")) {
      const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
      return path.resolve(path.join(home, env.slice(2)));
    }
    return path.resolve(env);
  }
  return path.resolve(".");
}

/**
 * Build a TracerConfig from the vault environment, suitable for ad-hoc
 * tracer invocations without a full OMS setup interview.
 *
 * @param overrides - Partial config fields to override the defaults.
 */
export function makeTracerConfig(overrides: Partial<TracerConfig> = {}): TracerConfig {
  const vaultPath = overrides.vaultPath ?? resolveVault();
  return {
    vaultPath,
    dbPath: overrides.dbPath ?? path.join(vaultPath, ".oms", "cache", "engine", "engine.db"),
    embeddingDimensions: overrides.embeddingDimensions ?? 768,
    modelPath: overrides.modelPath ?? process.env["OMS_MODEL_PATH"],
    files: overrides.files,
    cacheDir: overrides.cacheDir,
    topK: overrides.topK ?? 10,
  };
}
