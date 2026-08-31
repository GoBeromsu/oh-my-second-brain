/**
 * McpEngineAdapter — engine-side adapter facade for live MCP semantic ops.
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
 *
 * Live oms_retrieve_context is handled by retrieveMorningContext(), not this class.
 *
 * R18: NO import from src/search.
 */

import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { resolveBundledAssetPaths } from "../../runtime/assets.js";
import { loadContract } from "../../contracts/index.js";
import type { DispatcherDeps } from "../retrieval/dispatcher.js";
import { retrieve } from "../retrieval/index.js";
import type { Reranker } from "../retrieval/reranker.js";
import { validateExpandedPlan } from "../retrieval/generator.js";
import {
  loadTaxonomyIntentProjection,
  loadTaxonomyIntentProjectionSync,
  type TaxonomyIntentProjection,
} from "../retrieval/taxonomy-context.js";
import {
  acquireEngineStoreWriterLock,
  syncEngineStore,
  walkMarkdown,
} from "../embed/sync.js";
import { openEngineStore } from "../embed/store.js";
import { engineStorePath } from "../paths.js";
import type { EngineStore } from "../embed/store.js";
import type { EmbeddingModelDescriptor } from "../embed/model.js";
import { capabilityGuidance } from "../embed/config.js";
import {
  buildGraph,
  saveCachedGraph,
  loadCachedGraphMeta,
  buildNodeIndex,
  saveNodeIndex,
  loadNodeIndex,
  nodeSourceSignature,
} from "../graph/builder.js";
import type { EngineGraphNode } from "../graph/node.js";
import {
  filterNodesByAxis,
  filterNodesByQueryAxes,
  queryFacets,
  searchScore,
} from "../graph/node.js";
import type { QueryAxes } from "../graph/node.js";
import {
  axisStorePath,
  collectVaultAxisObservations,
  openAxisStore,
} from "../axes/store.js";
import type { AxisObservation } from "../axes/store.js";
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
  McpSemanticSearchHit,
  McpSemanticFacet,
  EngineSyncResult,
  McpSemanticGetOptions,
  McpSemanticMultiGetOptions,
  McpSemanticDocumentResult,
  McpSemanticDocument,
  McpSemanticModelCapabilityStatus,
  McpSemanticReceipt,
  McpSemanticTypedSearch,
} from "./types.js";
import {
  normalizeQueryOptions,
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
  cleanupResultUnavailable,
  graphBuildOptionsToEngineArgs,
  engineGraphBuildResultToMcp,
  engineGraphBuildToStatusResult,
} from "./op-mappers.js";

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
 * Strip a resource scheme to a vault-relative path.
 *
 * `oms://<collection>/<path>` is URL-decoded; plain targets get backslashes and
 * a leading "./" normalized away. The `qmd://` branch was removed with ADR-009:
 * qmd compatibility is no longer a product contract, and keeping an input
 * tolerance for a retired scheme is a compatibility layer with no caller.
 */
function normalizeDocScheme(target: string): string {
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
 * "file.md:FROM:COUNT", "dir/*.md" (glob), and oms:// resource URIs.
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
  return { ...result, available: true, hits };
}

/** Read folder intent declarations without creating or updating vault state. */
function folderIntents(vault: string): Map<string, string> {
  const candidates = [
    path.join(vault, ".oms", "taxonomy.yaml"),
    path.join(vault, "taxonomy.yaml"),
  ];
  try {
    candidates.push(path.join(resolveBundledAssetPaths().ontologyDir, "taxonomy.yaml"));
  } catch {
    // A package without bundled ontology still serves axis results; intents
    // remain optional metadata.
  }
  for (const candidate of candidates) {
    try {
      const parsed = parseYaml(readFileSync(candidate, "utf-8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const folders = (parsed as Record<string, unknown>)["folders"];
      if (!folders || typeof folders !== "object" || Array.isArray(folders)) continue;
      const intents = new Map<string, string>();
      for (const [folder, value] of Object.entries(folders as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const intent = (value as Record<string, unknown>)["intent"];
        if (typeof intent === "string" && intent.trim()) intents.set(folder, intent.trim());
      }
      return intents;
    } catch {
      // A missing optional taxonomy is not an error; a malformed one simply
      // contributes no intent and never causes a write.
    }
  }
  return new Map();
}

function facetIntent(
  facet: { readonly axis: McpSemanticFacet["axis"]; readonly key?: string; readonly value: string },
  intents: ReadonlyMap<string, string>,
  queryIntent: string | undefined,
): string {
  if (facet.axis === "folder") return intents.get(facet.value) ?? `Folder axis: ${facet.value}`;
  if (queryIntent !== undefined && queryIntent.trim().length > 0) return queryIntent.trim();
  if (facet.axis === "field") return `Frontmatter field axis: ${facet.key ?? "unknown"}`;
  return `Link axis: ${facet.value}`;
}

function isLexOnlySubQueries(subQueries: readonly { readonly type: string }[]): boolean {
  return subQueries.length > 0 && subQueries.every((subQuery) => subQuery.type === "lex");
}

/** Return true when the caller explicitly requested an embedding channel. */
function hasExplicitEmbeddingSearch(
  opts: McpSemanticQueryOptions,
): boolean {
  if (opts.mode === "vsearch") return true;
  if (typeof opts.vec === "string" && opts.vec.trim().length > 0) return true;
  if (typeof opts.hyde === "string" && opts.hyde.trim().length > 0) return true;
  return (opts.searches ?? []).some((search) => search.type === "vec" || search.type === "hyde");
}

const UNBOUNDED_CANDIDATE_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * Collection aggregation asks each child query for every candidate and applies
 * one global page after merging. A direct query without a limit still keeps
 * the public ten-hit default.
 */
function resultPageLimit(opts: McpSemanticQueryOptions): number | undefined {
  return opts.limit ?? (opts.collectionPath === undefined ? undefined : UNBOUNDED_CANDIDATE_LIMIT);
}

/** Read the dedicated EAV snapshot without creating `.oms` state. */
async function loadAxisSnapshot(vault: string): Promise<AxisObservation[] | null> {
  const dbPath = axisStorePath(vault);
  if (!existsSync(dbPath)) return null;
  const store = openAxisStore(dbPath, { readOnly: true });
  try {
    const storedSignature = store.sourceSignature();
    if (storedSignature === null || storedSignature !== await nodeSourceSignature(vault)) return null;
    return store.list();
  } finally {
    store.close();
  }
}

function observationValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString().toLowerCase();
  return String(value).trim().toLowerCase();
}

function contractAxisType(type: string): AxisObservation["valueType"] | undefined {
  switch (type) {
    case "number":
      return "number";
    case "boolean":
    case "checkbox":
      return "boolean";
    case "date":
    case "datetime":
      return "date";
    case "text":
    case "string":
    case "select":
    case "list":
    case "multitext":
    case "multi":
    case "tags":
    case "aliases":
    case "file":
      return "string";
    default:
      return undefined;
  }
}

/**
 * Compare live frontmatter/EAV observations with the tracked JSON contract.
 * Missing fields are allowed (required-field validation owns that concern);
 * an observed undeclared key, type, or closed-vocabulary value is drift.
 */
function hasContractObservationDrift(
  contract: Awaited<ReturnType<typeof loadContract>>,
  nodes: readonly EngineGraphNode[],
  observations: readonly AxisObservation[] | null,
): boolean {
  if (contract === null) return false;

  const declared = new Set<string>();
  const types = new Map<string, string>();
  const allowed = new Map<string, Set<string>>();
  const addAllowed = (key: string, values: readonly unknown[] | undefined): void => {
    if (values === undefined) return;
    const normalizedKey = key.trim().toLowerCase();
    const target = allowed.get(normalizedKey) ?? new Set<string>();
    for (const item of values) {
      const value = typeof item === "string"
        ? item
        : item && typeof item === "object" && typeof (item as { readonly value?: unknown }).value === "string"
          ? (item as { readonly value: string }).value
          : undefined;
      if (value !== undefined) target.add(observationValue(value));
    }
    allowed.set(normalizedKey, target);
  };

  for (const axis of contract.axes) {
    if (axis.kind !== "field") continue;
    const key = axis.key.trim().toLowerCase();
    if (key === "concept") continue;
    declared.add(key);
    types.set(key, axis.type);
    addAllowed(key, axis.allowedValues);
  }
  for (const [key, type] of Object.entries(contract.types)) {
    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey === "concept") continue;
    declared.add(normalizedKey);
    types.set(normalizedKey, type);
  }
  for (const [key, values] of Object.entries(contract.allowedValues)) {
    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey === "concept") continue;
    declared.add(normalizedKey);
    addAllowed(normalizedKey, values);
  }

  const observedKeys = new Set<string>();
  const observedValues: Array<{
    readonly key: string;
    readonly value: unknown;
    readonly valueType?: AxisObservation["valueType"];
    readonly normalizedValue?: string;
  }> = [];
  // Node axes are the live source of truth even when no EAV snapshot exists.
  for (const node of nodes) {
    for (const [key, rawValues] of Object.entries(node.axes)) {
      const normalizedKey = key.trim().toLowerCase();
      if (normalizedKey === "concept") continue;
      observedKeys.add(normalizedKey);
      const values = Array.isArray(rawValues) ? rawValues : [rawValues];
      for (const value of values) {
        // String values can also represent YAML dates after node-cache
        // serialisation, so only infer unambiguous primitive types here.
        const valueType = typeof value === "number"
          ? "number"
          : typeof value === "boolean"
            ? "boolean"
            : undefined;
        observedValues.push({ key: normalizedKey, value, valueType });
      }
    }
  }
  for (const row of observations ?? []) {
    const normalizedKey = row.axisKey.trim().toLowerCase();
    if (row.axisKind !== "field" || normalizedKey === "concept") continue;
    observedKeys.add(normalizedKey);
    observedValues.push({
      key: normalizedKey,
      value: row.value,
      valueType: row.valueType,
      normalizedValue: row.normalizedValue,
    });
  }
  for (const observed of observedValues) {
    if (!declared.has(observed.key)) return true;
    const expectedType = contractAxisType(types.get(observed.key) ?? "");
    if (expectedType !== undefined && observed.valueType !== undefined && expectedType !== observed.valueType) {
      return true;
    }
    const values = allowed.get(observed.key);
    if (values !== undefined && !values.has(observed.normalizedValue ?? observationValue(observed.value))) {
      return true;
    }
  }
  for (const key of observedKeys) {
    if (!declared.has(key)) return true;
  }
  return false;
}

async function contractObservationDrift(
  vault: string,
  nodes: readonly EngineGraphNode[],
  observations: readonly AxisObservation[] | null,
): Promise<boolean> {
  return hasContractObservationDrift(await loadContract(vault), nodes, observations);
}

/** Overlay typed EAV values onto the lexical node snapshot. */
function applyAxisSnapshot(
  nodes: readonly EngineGraphNode[],
  observations: readonly AxisObservation[],
): EngineGraphNode[] {
  const byNote = new Map<string, AxisObservation[]>();
  for (const observation of observations) {
    const rows = byNote.get(observation.notePath) ?? [];
    rows.push(observation);
    byNote.set(observation.notePath, rows);
  }
  return nodes.map((node) => {
    const rows = byNote.get(node.path);
    if (rows === undefined) return node;
    const fields: Record<string, (string | number | boolean)[]> = {};
    const links: string[] = [];
    let folder = node.folder;
    for (const row of rows) {
      const value = row.value instanceof Date ? row.value.toISOString() : row.value;
      if (row.axisKind === "folder" && typeof value === "string") {
        folder = value;
      } else if (row.axisKind === "link" && typeof value === "string") {
        links.push(value);
      } else if (row.axisKind === "field") {
        const values = fields[row.axisKey] ?? [];
        values.push(value);
        fields[row.axisKey] = values;
      }
    }
    return {
      ...node,
      folder,
      // The node DTO keeps its legacy string-array declaration, while this
      // runtime overlay deliberately carries typed EAV scalars.
      axes: fields as unknown as Record<string, string[]>,
      // An existing snapshot is authoritative: an empty link/field set must
      // clear stale values from an older JSON node-index cache.
      wikilinks: [...new Set(links)],
    };
  });
}

/** Contract field names are the allow-list for public field-axis queries. */
async function loadContractFieldKeys(vault: string): Promise<ReadonlySet<string> | undefined> {
  const contract = await loadContract(vault);
  if (contract === null) return undefined;
  const keys = new Set<string>();
  for (const axis of contract.axes) {
    if (axis.kind === "field") keys.add(axis.key.trim().toLowerCase());
  }
  for (const key of Object.keys(contract.types)) keys.add(key.trim().toLowerCase());
  return keys;
}

function validateKnownFieldAxes(
  axes: QueryAxes | undefined,
  knownFields: ReadonlySet<string> | undefined,
): void {
  if (axes === undefined || knownFields === undefined || axes.field === undefined) return;
  if (axes.field === null || typeof axes.field !== "object" || Array.isArray(axes.field)) {
    throw new Error("Field axis must be an object mapping field names to values.");
  }
  for (const key of Object.keys(axes.field)) {
    if (key.trim().toLocaleLowerCase() === "concept") {
      throw new Error('Unknown query field axis "concept".');
    }
    if (!knownFields.has(key.trim().toLowerCase())) {
      throw new Error(`Unknown field axis "${key}" (not declared by the JSON contract).`);
    }
  }
}

type ModelCapability = "embed" | "rerank" | "generate";

type EmbeddingIdentityReader = {
  readonly readEmbeddingIdentity: () => { readonly fingerprint: string } | null;
};

function canReadEmbeddingIdentity(value: unknown): value is EmbeddingIdentityReader {
  return typeof value === "object" &&
    value !== null &&
    "readEmbeddingIdentity" in value &&
    typeof value.readEmbeddingIdentity === "function";
}

/**
 * Status crosses a process boundary. Preserve portable identifiers while
 * excluding filesystem locations and URLs supplied by runtime providers.
 */
function isPathSafeStatusValue(value: string): boolean {
  return value.length > 0 &&
    !/(?:^|[\s("'=])(?:[a-z][a-z0-9+.-]*:\/\/|file:|~?\/|[a-z]:[\\/])/iu.test(value) &&
    !value.includes("\\");
}

function pathSafeStatusValue(value: string | undefined): string | undefined {
  return value !== undefined && isPathSafeStatusValue(value) ? value : undefined;
}

function pathSafeCapabilityStatus(
  capability: ModelCapability,
  status: McpSemanticModelCapabilityStatus,
): McpSemanticModelCapabilityStatus {
  const provider = pathSafeStatusValue(status.provider);
  const model = pathSafeStatusValue(status.model);
  const revision = pathSafeStatusValue(status.revision);
  const sha256 = pathSafeStatusValue(status.sha256);
  const promptScheme = pathSafeStatusValue(status.promptScheme);
  const guidance = pathSafeStatusValue(status.guidance) ??
    "Configure this capability with a portable model identity.";
  return {
    capability,
    available: status.available,
    source: status.source,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(revision === undefined ? {} : { revision }),
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(promptScheme === undefined ? {} : { promptScheme }),
    guidance,
  };
}

function portableEmbeddingModel(
  configuredModel: string | undefined,
  runtimeModel: string | undefined,
): string | undefined {
  return pathSafeStatusValue(configuredModel) ?? pathSafeStatusValue(runtimeModel);
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
   * @param config    - Optional embedding identity config (provider/model).
   *                    This is used to enforce mismatch policy and to thread
   *                    identity into syncEmbeddings when the call omits it.
   */
  constructor(
    private readonly deps: DispatcherDeps,
    private readonly vaultPath: string,
    private readonly config?: {
      readonly embeddingProvider?: string;
      readonly embeddingModel?: string;
      readonly embeddingRevision?: string;
      readonly embeddingSha256?: string;
      readonly embeddingDescriptor?: EmbeddingModelDescriptor;
      readonly embeddingDimensions?: number;
      readonly embeddingContext?: number;
      readonly embeddingMrlDim?: number;
      readonly embeddingNormalization?: string;
      readonly embeddingPrefixScheme?: string;
      readonly modelCapabilityStatus?: () => Readonly<Record<ModelCapability, McpSemanticModelCapabilityStatus>>;
      readonly dbPath?: string;
      readonly onStoreRebind?: (store: EngineStore) => void;
    },
    private readonly reranker?: Reranker,
    /** Explicit assembly policy; read-only engines suppress this refresh. */
    private readonly implicitLexicalSync = false,
    private readonly persistLexicalSync = true,
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
  private async loadOrBuildNodes(vault = this.vaultPath): Promise<EngineGraphNode[]> {
    // A direct adapter caller may supply a store-backed query without a
    // filesystem vault (for example an MCP transport test). Node enrichment is
    // optional in that case; never turn a valid retrieval result into an ENOENT.
    if (!existsSync(vault)) return [];
    const cached = await loadNodeIndex(
      this.nodeCachePath(vault),
      await nodeSourceSignature(vault),
    );
    if (cached !== null) return cached;
    return buildNodeIndex({ vaultPath: vault });
  }

  // -------------------------------------------------------------------------
  // 1. oms_semantic_query (centerpiece)
  // -------------------------------------------------------------------------

  /**
   * Evaluate an overview/axis query directly from the read-only node index.
   * This path is intentionally model-free and does not open the embedding
   * store, so a query issued outside a vault or against an empty vault cannot
   * create `.oms/` state as a side effect.
   */
  private async queryNodeAxes(
    opts: McpSemanticQueryOptions,
    subQueries: readonly { readonly type: string; readonly query: string }[],
  ): Promise<McpSemanticQueryResult> {
    const vault = opts.vault ?? this.vaultPath;
    const baseNodes = await this.loadOrBuildNodes(vault);
    const snapshot = await loadAxisSnapshot(vault);
    const drift = await contractObservationDrift(vault, baseNodes, snapshot);
    const observedFields = snapshot === null
      ? undefined
      : new Set(snapshot.filter((row) => row.axisKind === "field").map((row) => row.axisKey.toLowerCase()));
    const liveObservedFields = new Set(
      baseNodes.flatMap((node) => Object.keys(node.axes).map((key) => key.toLowerCase())),
    );
    const knownFields = await loadContractFieldKeys(vault)
      ?? (observedFields === undefined ? liveObservedFields : new Set([...observedFields, ...liveObservedFields]));
    validateKnownFieldAxes(opts.axes as QueryAxes | undefined, knownFields);
    const nodes = snapshot === null ? baseNodes : applyAxisSnapshot(baseNodes, snapshot);
    const axisFiltered = opts.axes === undefined
      ? nodes
      : filterNodesByQueryAxes(nodes, opts.axes as QueryAxes);
    const collection = opts.collectionPath;
    const filtered = collection === undefined
      ? axisFiltered
      : axisFiltered.filter((node) => node.path === collection || node.path.startsWith(`${collection}/`));
    const query = subQueries.find((subQuery) => subQuery.type === "lex")?.query
      ?? (subQueries.length === 0 ? opts.query ?? "" : "");
    const scored = filtered
      .map((node) => {
        const score = searchScore(node, query);
        return {
          docPath: node.path,
          score,
          ...(query.trim().length > 0 ? { perTypeScores: { lex: score } } : {}),
        };
      })
      // An axis constraint narrows the corpus; it is not lexical evidence.
      // Once a lexical query is supplied, do not return axis-only zero-score
      // documents as query hits.
      .filter((result) => query.trim().length === 0 || result.score > 0)
      .sort((left, right) => right.score - left.score || left.docPath.localeCompare(right.docPath));
    const facetNodes = opts.minScore === undefined
      ? filtered
      : filtered.filter((node) => searchScore(node, query) >= opts.minScore!);
    const intents = folderIntents(vault);
    const facets: McpSemanticFacet[] = queryFacets(facetNodes).map((facet) => ({
      ...facet,
      intent: facetIntent(facet, intents, opts.intent),
    }));
    const candidateLimit = opts.candidateLimit ?? UNBOUNDED_CANDIDATE_LIMIT;
    const candidates = scored.slice(0, candidateLimit);
    const shouldRerank = opts.rerank === true && opts.noRerank !== true;
    if (shouldRerank && this.reranker === undefined) {
      return queryResultUnavailable(
        "reranking requires a configured Reranker; pass one to assembleEngine() or createOMSMcpServer().",
      );
    }
    if (shouldRerank && query.trim().length === 0) {
      return queryResultUnavailable("reranking requires a non-empty natural-language query.");
    }
    const reranker = this.reranker;
    const ranked = shouldRerank
      ? await reranker!.rerank(query, candidates.map((result) => ({
        docPath: result.docPath,
        chunkOrdinal: 0,
        score: result.score,
      }))).then((reranked) => {
        const candidateByPath = new Map(candidates.map((candidate) => [candidate.docPath, candidate]));
        return reranked.flatMap((hit) => {
          const candidate = candidateByPath.get(hit.docPath);
          return candidate === undefined
            ? []
            : [{ ...candidate, score: hit.score, perTypeScores: { lex: hit.score } }];
        });
      })
      : candidates;
    const hasNonLexSearch = subQueries.some((search) => search.type !== "lex");
    const result = retrievalResultsToQueryResult(ranked, {
      minScore: opts.minScore,
      limit: resultPageLimit(opts),
      cursor: opts.cursor,
      intent: opts.intent,
      facetValues: facets,
      // Axis queries are evaluated by the model-free node matcher. A vector
      // request is reported as approximated rather than falsely claiming vec
      // evidence in the receipt.
      usedChannels: query.trim().length > 0 ? ["lex"] : [],
      approximated: hasNonLexSearch,
      drift,
    });
    return enrichQueryHits(result, vault);
  }

  /**
   * Execute a semantic query and return MCP-shaped results.
   * Maps opts → TypedSubQuery[] → dispatch() → McpSemanticQueryResult.
   */
  async semanticQuery(opts: McpSemanticQueryOptions): Promise<McpSemanticQueryResult> {
    let normalized: ReturnType<typeof normalizeQueryOptions>;
    try {
      normalized = normalizeQueryOptions(opts);
    } catch (err) {
      return queryResultUnavailable(err instanceof Error ? err.message : String(err));
    }
    let subQueries = [...normalized.subQueries];
    const requestedStrategy: McpSemanticReceipt["requestedStrategy"] = opts.strategy !== undefined
      ? "expand"
      : (
        (opts.searches?.length ?? 0) > 0
        || opts.lex !== undefined
        || opts.vec !== undefined
        || opts.hyde !== undefined
        || opts.mode === "vsearch"
      )
        ? "explicit"
        : "plain";
    let generatedSearches: readonly McpSemanticTypedSearch[] = [];
    let taxonomyProjection: TaxonomyIntentProjection | undefined;
    const ensureTaxonomyProjection = async (): Promise<TaxonomyIntentProjection> => {
      if (taxonomyProjection !== undefined) return taxonomyProjection;
      const indexedPaths = typeof (this.deps.store as Partial<EngineStore>).listDocPaths === "function"
        ? (this.deps.store as EngineStore).listDocPaths()
        : [];
      taxonomyProjection = await loadTaxonomyIntentProjection(
        opts.vault ?? this.vaultPath,
        indexedPaths,
        opts.collectionPath,
      );
      return taxonomyProjection;
    };

    if (opts.strategy !== undefined) {
      if (this.deps.queryExpander === undefined) {
        return queryResultUnavailable(capabilityGuidance("generate"), {
          requestedStrategy: "expand",
        });
      }
      try {
        const context = await ensureTaxonomyProjection();
        generatedSearches = validateExpandedPlan(
          await this.deps.queryExpander({
            query: opts.query!,
            ...(context.promptContext === undefined ? {} : { context: context.promptContext }),
            ...(opts.strategy.maxQueries === undefined ? {} : { maxQueries: opts.strategy.maxQueries }),
          }),
          opts.query!,
          opts.strategy.maxQueries,
        );
        subQueries = generatedSearches.map((search) =>
          search.type === "hyde"
            ? { ...search, hypotheticalDocument: true as const }
            : search);
      } catch (err) {
        return queryResultUnavailable(err instanceof Error ? err.message : String(err), {
          requestedStrategy: "expand",
          generatedSearches,
          taxonomyIntents: taxonomyProjection?.matched ?? [],
          warnings: taxonomyProjection?.warnings ?? [],
        });
      }
    }
    if (opts.axes !== undefined && hasExplicitEmbeddingSearch(opts)) {
      return queryResultUnavailable(
        "Axis queries support lexical matching only; explicit vector/HyDE retrieval requires " +
          "OMS_EMBEDDING_PROVIDER + OMS_EMBEDDING_MODEL.",
      );
    }
    if (opts.axes !== undefined || normalized.overview) {
      try {
        return await this.queryNodeAxes(opts, subQueries);
      } catch (err) {
        return queryResultUnavailable(err instanceof Error ? err.message : String(err));
      }
    }
    let rerankRequested = false;
    try {
      // A core engine has a real lexical store but deliberately no embedding
      // provider. The default query mode is hybrid for vector-capable engines;
      // on a model-less engine, retain the useful lexical half unless the
      // caller explicitly asked for vec/HyDE (which must fail loudly).
      const vecAvailable = typeof (this.deps.store as Partial<EngineStore>).capabilities === "function"
        ? (this.deps.store as EngineStore).capabilities().vecAvailable
        : true;
      const modelLessFallback =
        !vecAvailable &&
        !hasExplicitEmbeddingSearch(opts) &&
        subQueries.some((subQuery) => subQuery.type === "vec");
      const effectiveSubQueries = modelLessFallback
        ? subQueries.filter((subQuery) => subQuery.type === "lex")
        : subQueries;

      if (this.implicitLexicalSync && isLexOnlySubQueries(effectiveSubQueries)) {
        const syncResult = await syncEngineStore({
          vault: opts.vault ?? this.vaultPath,
          collection: opts.collection,
          embed: false,
          store: this.deps.store as EngineStore,
          persist: this.persistLexicalSync,
        });
        if (!syncResult.available) {
          return queryResultUnavailable(syncResult.reason ?? "Lexical index sync unavailable");
        }
      }
      // Without an explicit candidate limit, retrieve the complete ranked
      // stream so totalCount and offset cursors remain accurate on pages past
      // the first 50 results. A caller-supplied candidateLimit remains an
      // intentional cap (not an implementation truncation).
      const k = opts.candidateLimit ?? UNBOUNDED_CANDIDATE_LIMIT;
      const shouldRerank = opts.rerank === true && opts.noRerank !== true;
      rerankRequested = shouldRerank;
      if (shouldRerank && this.reranker === undefined) {
        return queryResultUnavailable(
          `${capabilityGuidance("rerank")} A programmatic caller may also inject one through \`assembleEngine()\` or \`createOMSMcpServer()\`.`,
          {
            requestedStrategy,
            generatedSearches,
            taxonomyIntents: taxonomyProjection?.matched ?? [],
            warnings: taxonomyProjection?.warnings ?? [],
          },
        );
      }
      const naturalQuery = opts.query?.trim()
        || effectiveSubQueries.map((subQuery) => subQuery.query.trim()).filter(Boolean).join(" ");
      if (shouldRerank && naturalQuery === "") {
        return queryResultUnavailable("reranking requires a non-empty natural-language query.");
      }
      if (shouldRerank) await ensureTaxonomyProjection();
      const modelQuery = shouldRerank && taxonomyProjection?.promptContext !== undefined
        ? `${naturalQuery}\n\nVault folder intents:\n${taxonomyProjection.promptContext}`
        : naturalQuery || undefined;
      const results = await retrieve({
        subQueries: [...effectiveSubQueries],
        deps: this.deps,
        k,
        collection: opts.collectionPath,
        query: modelQuery,
        reranker: shouldRerank ? this.reranker : undefined,
      });
      let facetValues: McpSemanticFacet[] | undefined;
      const vault = opts.vault ?? this.vaultPath;
      const baseNodes = await this.loadOrBuildNodes(vault);
      const snapshot = await loadAxisSnapshot(vault);
      const nodes = snapshot === null ? baseNodes : applyAxisSnapshot(baseNodes, snapshot);
      const drift = await contractObservationDrift(vault, baseNodes, snapshot);
      const scoped = opts.collectionPath === undefined
        ? nodes
        : nodes.filter((node) =>
          node.path === opts.collectionPath || node.path.startsWith(`${opts.collectionPath}/`));
      const intents = folderIntents(vault);
      facetValues = queryFacets(scoped).map((facet) => ({
        ...facet,
        intent: facetIntent(facet, intents, opts.intent),
      }));
      const requestedChannels = [...new Set(effectiveSubQueries.map((search) => search.type))]
        .filter((type): type is "lex" | "vec" | "hyde" => type === "lex" || type === "vec" || type === "hyde");
      const mapped = retrievalResultsToQueryResult(results, {
        ...opts,
        limit: resultPageLimit(opts),
        facetValues,
        usedChannels: requestedChannels,
        approximated:
          modelLessFallback ||
          effectiveSubQueries.some((search) => search.type !== "lex" && search.type !== "vec"),
        drift,
        requestedStrategy,
        generatedSearches,
        rerankApplied: shouldRerank,
        taxonomyIntents: taxonomyProjection?.matched ?? [],
        warnings: taxonomyProjection?.warnings ?? [],
      });
      // Fill title + doc-head snippet from disk so engine hits reach practical
      // parity with the src/search preview (the pure mapper stays text-free).
      return enrichQueryHits(mapped, opts.vault ?? this.vaultPath);
    } catch (err) {
      return queryResultUnavailable(err instanceof Error ? err.message : String(err), {
        requestedStrategy,
        generatedSearches,
        // A failed response cannot claim the reranker was successfully applied,
        // but preserve its request in warnings for an auditable error receipt.
        rerankApplied: false,
        taxonomyIntents: taxonomyProjection?.matched ?? [],
        warnings: [
          ...(taxonomyProjection?.warnings ?? []),
          ...(rerankRequested ? ["Reranking was requested but the query did not complete."] : []),
        ],
      });
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
    const activeDbPath = this.config?.dbPath ??
      engineStorePath(path.resolve(opts.vault));
    let swapHandleClosed = false;
    try {
      const syncResult = await syncEngineStore({
        vault: opts.vault,
        collection: opts.collection,
        collectionPath: opts.collectionPath,
        // Embedding identity is owned by the assemble-time canonical config
        // (OMS_EMBEDDING_PROVIDER / OMS_EMBEDDING_MODEL) threaded into the
        // adapter; the MCP call no longer carries modelPath. syncEngineStore
        // resolves the real provider and fails fast (ADR-007) if it is missing.
        embeddingProvider: this.config?.embeddingProvider,
        embeddingModel: this.config?.embeddingModel,
        embeddingRevision: this.config?.embeddingRevision,
        embeddingSha256: this.config?.embeddingSha256,
        embeddingDescriptor: this.config?.embeddingDescriptor,
        embeddingDimensions: this.config?.embeddingDimensions,
        embeddingContext: this.config?.embeddingContext,
        embeddingMrlDim: this.config?.embeddingMrlDim,
        embeddingNormalization: this.config?.embeddingNormalization,
        embeddingPrefixScheme: this.config?.embeddingPrefixScheme,
        dbPath: this.config?.dbPath,
        embed: opts.embed ?? true,
        force: opts.force ?? false,
        onGenerationSwapPrepare: () => {
          // The adapter's store outlives one sync call. Close it before the
          // active WAL/SHM sidecars are removed, not after rename.
          swapHandleClosed = true;
          this.deps.store.close();
        },
        onGenerationSwapComplete: () => {
          if (!swapHandleClosed) return;
          const reboundStore = openEngineStore(activeDbPath, this.deps.embed.dimensions);
          this.deps.store = reboundStore;
          this.config?.onStoreRebind?.(reboundStore);
          swapHandleClosed = false;
        },
      });
      if (!syncResult.available) {
        return syncResultUnavailable(syncResult.reason ?? "sync unavailable", opts);
      }
      const engineResult: EngineSyncResult = {
        upserted: syncResult.added + syncResult.updated,
        skipped: syncResult.skipped,
        errors: 0,
      };
      const model = portableEmbeddingModel(this.config?.embeddingModel, this.deps.embed.model);
      const statusSnapshot: McpSemanticProviderStatus & { readonly available: true } = {
        available: true,
        storage: opts.storage ?? "oms-native-json",
        models: {
          ...(model === undefined ? {} : { embedding: model }),
        },
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
      const status = engineStatusResultToMcp(engineResult);
      if (!status.available) return status;

      const model = portableEmbeddingModel(this.config?.embeddingModel, status.models.embedding);
      const identity = canReadEmbeddingIdentity(this.deps.store)
        ? this.deps.store.readEmbeddingIdentity()
        : null;
      const indexedPaths = typeof (this.deps.store as Partial<EngineStore>).listDocPaths === "function"
        ? (this.deps.store as EngineStore).listDocPaths()
        : [];
      const taxonomyContext = loadTaxonomyIntentProjectionSync(
        _opts.vault ?? this.vaultPath,
        indexedPaths,
      );
      const taxonomyStatus = {
        matched: taxonomyContext.matched,
        indexedWithoutIntent: taxonomyContext.indexedWithoutIntent,
        taxonomyWithoutIndexed: taxonomyContext.taxonomyWithoutIndexed,
        warnings: taxonomyContext.warnings,
      };
      if (this.config?.modelCapabilityStatus === undefined) {
        return {
          ...status,
          models: model === undefined ? {} : { ...status.models, embedding: model },
          ...(identity === null ? {} : { storeEmbeddingFingerprint: identity.fingerprint }),
          taxonomyContext: taxonomyStatus,
        };
      }

      let capabilities: Readonly<Record<ModelCapability, McpSemanticModelCapabilityStatus>>;
      try {
        const resolved = this.config.modelCapabilityStatus();
        capabilities = {
          embed: pathSafeCapabilityStatus("embed", resolved.embed),
          rerank: pathSafeCapabilityStatus("rerank", resolved.rerank),
          generate: pathSafeCapabilityStatus("generate", resolved.generate),
        };
      } catch {
        return statusResultUnavailable("Model capability resolution is unavailable.");
      }
      return {
        ...status,
        models: model === undefined ? {} : { ...status.models, embedding: model },
        capabilities,
        ...(identity === null ? {} : { storeEmbeddingFingerprint: identity.fingerprint }),
        taxonomyContext: taxonomyStatus,
      };
    } catch {
      return statusResultUnavailable("Semantic status is unavailable.");
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

  /** List active taxonomy contexts without creating a parallel context store. */
  listContexts(opts: McpStatusOptions): McpSemanticContextResult {
    try {
      const store = this.deps.store as Partial<EngineStore>;
      const indexedPaths = typeof store.listDocPaths === "function" ? store.listDocPaths() : [];
      const vault = opts.vault ?? this.vaultPath;
      const projection = loadTaxonomyIntentProjectionSync(vault, indexedPaths);
      const taxonomyPath = path.join(vault, ".oms", "taxonomy.yaml");
      const updatedAt = projection.matched.length === 0
        ? ""
        : statSync(taxonomyPath).mtime.toISOString();
      return {
        available: true,
        contexts: projection.matched.map(({ folder, intent, source }) => ({
          collection: folder,
          pathPrefix: folder,
          context: intent,
          updatedAt,
          source,
        })),
        ...(projection.warnings.length === 0 ? {} : { warnings: projection.warnings }),
      };
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
    let releaseLock: (() => void) | undefined;
    try {
      const dbPath = this.config?.dbPath ??
        engineStorePath(path.resolve(this.vaultPath));
      releaseLock = acquireEngineStoreWriterLock(dbPath);
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
    } finally {
      releaseLock?.();
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
    const sourceSignature = await nodeSourceSignature(args.vaultPath);
    await saveNodeIndex(this.nodeCachePath(args.vaultPath), nodes, sourceSignature);

    // Graph build is the explicit writable refresh boundary for the typed
    // EAV snapshot. Reconcile it atomically with the current markdown set.
    const axisStore = await collectVaultAxisObservations(args.vaultPath);
    axisStore.close();

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
      const baseNodes = await this.loadOrBuildNodes();
      const snapshot = await loadAxisSnapshot(this.vaultPath);
      const drift = await contractObservationDrift(this.vaultPath, baseNodes, snapshot);
      const nodes = snapshot === null ? baseNodes : applyAxisSnapshot(baseNodes, snapshot);
      const limit = Math.max(1, filters.limit ?? 10);
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
      const intents = folderIntents(this.vaultPath);
      const facets: McpSemanticFacet[] = queryFacets(filtered).map((facet) => ({
        ...facet,
        intent: facetIntent(facet, intents, undefined),
      }));
      return {
        available: true,
        hits,
        totalCount: filtered.length,
        facets,
        cursor: scored.length < filtered.length ? String(scored.length) : null,
        receipt: {
          usedChannels: ["lex"],
          approximated: false,
          drift,
          requestedStrategy: "plain",
          generatedSearches: [],
          rerankApplied: false,
          taxonomyIntents: [],
          warnings: [],
        },
      };
    } catch (err) {
      return queryResultUnavailable(err instanceof Error ? err.message : String(err));
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
