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
import type { EmbeddingModelDescriptor } from "./embed/model.js";
import { buildGraph, loadCachedGraph, saveCachedGraph } from "./graph/builder.js";
import { loadResolvedTemplates } from "../templates/resolver.js";
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
   * Canonical setup descriptor.  The descriptor is carried alongside the
   * scalar config so model width/context and preprocessing metadata are not
   * discarded when the tracer composes the provider.
   */
  embeddingDescriptor?: EmbeddingModelDescriptor | null;
  embeddingContext?: number;
  embeddingContextLength?: number;
  embeddingContextTokens?: number;
  embeddingMrlDim?: number;
  embeddingNormalization?: string;
  embeddingPrefixScheme?: string;
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
  if (files.length === 0) return [];

  // ── Step 2: create embed provider + store ─────────────────────────────────
  const descriptor = config.embeddingDescriptor ?? undefined;
  const embeddingProvider = config.embeddingProvider ?? descriptor?.provider;
  const embeddingModel =
    config.embeddingModel ??
    descriptor?.path ??
    descriptor?.modelPath ??
    descriptor?.model;
  const embedProvider = requireRealEmbeddingProvider({
    provider: embeddingProvider,
    model: embeddingModel,
    dimensions: config.embeddingDimensions ?? descriptor?.dimensions,
    context: config.embeddingContext ?? descriptor?.context,
    contextLength: config.embeddingContextLength ?? descriptor?.contextLength,
    contextTokens: config.embeddingContextTokens ?? descriptor?.contextTokens,
    mrlDim: config.embeddingMrlDim ?? descriptor?.mrlDim,
    normalization: config.embeddingNormalization ?? descriptor?.normalization,
    prefixScheme: config.embeddingPrefixScheme ?? descriptor?.prefixScheme,
  });
  await mkdir(path.dirname(config.dbPath), { recursive: true });
  // A descriptor is authoritative for its vector width when no scalar
  // override was supplied.  Falling back to the provider width keeps custom
  // providers usable without inventing a dimension in the tracer.
  const dimensions = config.embeddingDimensions ?? descriptor?.dimensions ?? embedProvider.dimensions;
  const store = openEngineStore(config.dbPath, dimensions);

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
    const convention = await loadResolvedTemplates(vaultPath);
    const graphCachePath = path.join(cacheDir, "engine", "graph.json");
    let edges = await loadCachedGraph(graphCachePath, convention.inputSignature);
    if (edges === null) {
      edges = await buildGraph({ vaultPath, convention, files });
      await saveCachedGraph(graphCachePath, edges, convention.inputSignature);
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
  const descriptor = overrides.embeddingDescriptor ?? undefined;
  return {
    vaultPath,
    dbPath: overrides.dbPath ?? path.join(vaultPath, ".oms", "cache", "engine", "engine.db"),
    embeddingDimensions: overrides.embeddingDimensions ?? descriptor?.dimensions ?? 768,
    embeddingProvider:
      overrides.embeddingProvider ??
      descriptor?.provider ??
      process.env["OMS_EMBEDDING_PROVIDER"],
    embeddingModel:
      overrides.embeddingModel ??
      descriptor?.path ??
      descriptor?.modelPath ??
      descriptor?.model ??
      process.env["OMS_EMBEDDING_MODEL"],
    ...(overrides.embeddingDescriptor !== undefined
      ? { embeddingDescriptor: overrides.embeddingDescriptor }
      : {}),
    ...(overrides.embeddingContext !== undefined
      ? { embeddingContext: overrides.embeddingContext }
      : descriptor?.context !== undefined
        ? { embeddingContext: descriptor.context }
        : {}),
    ...(overrides.embeddingContextLength !== undefined
      ? { embeddingContextLength: overrides.embeddingContextLength }
      : descriptor?.contextLength !== undefined
        ? { embeddingContextLength: descriptor.contextLength }
        : {}),
    ...(overrides.embeddingContextTokens !== undefined
      ? { embeddingContextTokens: overrides.embeddingContextTokens }
      : descriptor?.contextTokens !== undefined
        ? { embeddingContextTokens: descriptor.contextTokens }
        : {}),
    ...(overrides.embeddingMrlDim !== undefined
      ? { embeddingMrlDim: overrides.embeddingMrlDim }
      : descriptor?.mrlDim !== undefined
        ? { embeddingMrlDim: descriptor.mrlDim }
        : {}),
    ...(overrides.embeddingNormalization !== undefined
      ? { embeddingNormalization: overrides.embeddingNormalization }
      : descriptor?.normalization !== undefined
        ? { embeddingNormalization: descriptor.normalization }
        : {}),
    ...(overrides.embeddingPrefixScheme !== undefined
      ? { embeddingPrefixScheme: overrides.embeddingPrefixScheme }
      : descriptor?.prefixScheme !== undefined
        ? { embeddingPrefixScheme: descriptor.prefixScheme }
        : {}),
    files: overrides.files,
    cacheDir: overrides.cacheDir,
    topK: overrides.topK ?? 10,
  };
}
