import { createHash } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseNote } from "../conventions/frontmatter.js";
import { validateFrontmatter } from "../conventions/validate.js";
import { safeVaultNotePath } from "../capture/safe.js";
import { resolveConcept } from "../ontology/resolver.js";
import type { Concept, Ontology } from "../ontology/types.js";

export type GraphEdgeType = "folder-concept" | "property-axis" | "property-value" | "wikilink";

export interface GraphEdge {
  type: GraphEdgeType;
  from: string;
  to: string;
  axis?: string;
  value?: string;
}

export interface GraphNote {
  path: string;
  folder: string;
  concept: string | null;
  frontmatter: Record<string, unknown>;
  axes: Record<string, string[]>;
  wikilinks: string[];
  bodyLoaded: false;
  validation: {
    valid: boolean;
    violations: number;
  };
}

export interface SearchDocument {
  path: string;
  terms: string[];
  bodyPreview: string;
}

export interface NoteSignature {
  mtimeMs: number;
  size: number;
  frontmatterHash: string;
  wikilinkHash: string;
  bodyTextHash: string;
}

export interface SourceSignatures {
  taxonomyHash: string;
  conceptHashes: Record<string, string>;
  notes: Record<string, NoteSignature>;
}

export interface OMSGraphCache {
  version: 1;
  generatedAt: string;
  sourceOfTruth: string[];
  signatures: SourceSignatures;
  notes: GraphNote[];
  edges: GraphEdge[];
  search: SearchDocument[];
}

export interface GraphStaleness {
  schemaStale: boolean;
  graphStale: boolean;
  searchStale: boolean;
  embeddingStale: "not-configured" | boolean;
  validationStale: boolean;
  reasons: string[];
}

export interface GraphCacheStatus {
  cachePath: string;
  exists: boolean;
  generatedAt: string | null;
  notes: number;
  edges: number;
  searchDocuments: number;
  staleness: GraphStaleness;
}

export interface RetrieveByAxisOptions {
  vault: string;
  ontology: Ontology;
  concept?: string;
  folder?: string;
  property?: string;
  value?: string;
  wikilink?: string;
  query?: string;
  limit?: number;
}

const CACHE_VERSION = 1;

export function graphCachePath(vault: string): string {
  return path.resolve(vault, ".oms", "cache", "graph.json");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ensureInsideRoot(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the configured vault root.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGraphCacheShape(value: unknown): value is OMSGraphCache {
  if (!isRecord(value)) return false;
  if (
    value.version !== CACHE_VERSION ||
    typeof value.generatedAt !== "string" ||
    !Array.isArray(value.sourceOfTruth) ||
    !value.sourceOfTruth.every((item) => typeof item === "string") ||
    !Array.isArray(value.notes) ||
    !Array.isArray(value.edges) ||
    !Array.isArray(value.search) ||
    !isRecord(value.signatures)
  ) {
    return false;
  }
  const signatures = value.signatures;
  if (
    typeof signatures.taxonomyHash !== "string" ||
    !isRecord(signatures.conceptHashes) ||
    !isRecord(signatures.notes)
  ) {
    return false;
  }
  for (const note of value.notes) {
    if (
      !isRecord(note) ||
      typeof note.path !== "string" ||
      typeof note.folder !== "string" ||
      !(typeof note.concept === "string" || note.concept === null) ||
      !isRecord(note.frontmatter) ||
      !isRecord(note.axes) ||
      !Array.isArray(note.wikilinks) ||
      !note.wikilinks.every((item) => typeof item === "string") ||
      note.bodyLoaded !== false ||
      !isRecord(note.validation) ||
      typeof note.validation.valid !== "boolean" ||
      typeof note.validation.violations !== "number"
    ) {
      return false;
    }
  }
  for (const edge of value.edges) {
    if (
      !isRecord(edge) ||
      typeof edge.type !== "string" ||
      typeof edge.from !== "string" ||
      typeof edge.to !== "string"
    ) {
      return false;
    }
  }
  for (const document of value.search) {
    if (
      !isRecord(document) ||
      typeof document.path !== "string" ||
      !Array.isArray(document.terms) ||
      !document.terms.every((item) => typeof item === "string") ||
      typeof document.bodyPreview !== "string"
    ) {
      return false;
    }
  }
  return true;
}

async function* walkMarkdown(
  dir: string,
  base: string,
  rootRealPath?: string,
  visitedDirectories: Set<string> = new Set(),
): AsyncGenerator<string> {
  const root = rootRealPath ?? await realpath(base);
  const realDir = await realpath(dir);
  ensureInsideRoot(root, realDir, `Vault directory "${dir}"`);
  if (visitedDirectories.has(realDir)) return;
  visitedDirectories.add(realDir);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Unable to scan vault directory "${dir}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // Resolve every entry, including skipped dot-directories, so an escape
    // cannot hide behind the scanner's exclusion policy.
    const realEntry = await realpath(full);
    ensureInsideRoot(root, realEntry, `Vault entry "${full}"`);
    if (entry.name === ".oms" || entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const entryStat = await stat(full);
    if (entryStat.isDirectory()) {
      yield* walkMarkdown(full, base, root, visitedDirectories);
    } else if (entryStat.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      yield path.relative(base, full).replace(/\\/g, "/");
    }
  }
}

function jsonStable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(jsonStable).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${jsonStable(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function valueToStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(valueToStrings).filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (value instanceof Date) {
    return [value.toISOString()];
  }
  return [];
}

function extractWikilinks(body: string): string[] {
  const links = new Set<string>();
  const pattern = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const target = match[1]?.trim();
    if (target) links.add(target);
  }
  return Array.from(links).sort();
}

function tokenize(text: string): string[] {
  const terms = text
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu);
  return Array.from(new Set(terms ?? [])).sort();
}

function firstFolder(notePath: string): string {
  return notePath.split("/")[0] ?? "";
}

function conceptSchemaHash(concept: Concept): string {
  return hash(jsonStable(concept));
}

function taxonomyHash(ontology: Ontology): string {
  return hash(jsonStable(ontology.taxonomy));
}

function parseGraphFrontmatter(raw: string, notePath: string): ReturnType<typeof parseNote> {
  const parsed = parseNote(raw);
  if (parsed.diagnostics.length > 0) {
    throw new Error(
      `${notePath}: malformed frontmatter (${parsed.diagnostics.map((item) => item.message).join("; ")})`,
    );
  }
  return parsed;
}

async function buildSourceSignatures(vault: string, ontology: Ontology): Promise<SourceSignatures> {
  const notes: Record<string, NoteSignature> = {};
  for await (const notePath of walkMarkdown(vault, vault)) {
    const fullPath = path.join(vault, notePath);
    const [raw, fileStat] = await Promise.all([readFile(fullPath, "utf-8"), stat(fullPath)]);
    const parsed = parseGraphFrontmatter(raw, notePath);
    const wikilinks = extractWikilinks(parsed.body);
    notes[notePath] = {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      frontmatterHash: hash(jsonStable(parsed.frontmatter)),
      wikilinkHash: hash(jsonStable(wikilinks)),
      bodyTextHash: hash(parsed.body),
    };
  }

  return {
    taxonomyHash: taxonomyHash(ontology),
    conceptHashes: Object.fromEntries(
      Array.from(ontology.concepts.entries()).map(([name, concept]) => [
        name,
        conceptSchemaHash(concept),
      ]),
    ),
    notes,
  };
}

function buildNoteGraph(notePath: string, raw: string, ontology: Ontology): {
  note: GraphNote;
  edges: GraphEdge[];
  search: SearchDocument;
} {
  const parsed = parseGraphFrontmatter(raw, notePath);
  const folder = firstFolder(notePath);
  const concept = resolveConcept(ontology, notePath);
  const axes: Record<string, string[]> = {};
  const edges: GraphEdge[] = [];

  if (concept) {
    edges.push({
      type: "folder-concept",
      from: notePath,
      to: `concept:${concept.concept}`,
    });
  }

  for (const [key, rawValue] of Object.entries(parsed.frontmatter)) {
    const values = valueToStrings(rawValue);
    if (values.length === 0) continue;
    axes[key] = values;
    edges.push({ type: "property-axis", from: notePath, to: `axis:${key}`, axis: key });
    for (const value of values) {
      edges.push({
        type: "property-value",
        from: notePath,
        to: `axis:${key}:value:${value}`,
        axis: key,
        value,
      });
    }
  }

  const wikilinks = extractWikilinks(parsed.body);
  for (const target of wikilinks) {
    edges.push({ type: "wikilink", from: notePath, to: target });
  }

  const validation = concept
    ? validateFrontmatter(parsed.frontmatter, concept)
    : { valid: false, violations: [] };
  const searchText = `${Object.values(parsed.frontmatter).flatMap(valueToStrings).join(" ")} ${parsed.body}`;

  return {
    note: {
      path: notePath,
      folder,
      concept: concept?.concept ?? null,
      frontmatter: parsed.frontmatter,
      axes,
      wikilinks,
      bodyLoaded: false,
      validation: {
        valid: validation.valid,
        violations: validation.violations.length,
      },
    },
    edges,
    search: {
      path: notePath,
      terms: tokenize(searchText),
      bodyPreview: parsed.body.trim().slice(0, 240),
    },
  };
}

export async function buildGraphCache(opts: {
  vault: string;
  ontology: Ontology;
  write?: boolean;
}): Promise<OMSGraphCache> {
  const vault = path.resolve(opts.vault);
  const notes: GraphNote[] = [];
  const edges: GraphEdge[] = [];
  const search: SearchDocument[] = [];

  for await (const notePath of walkMarkdown(vault, vault)) {
    const raw = await readFile(path.join(vault, notePath), "utf-8");
    const built = buildNoteGraph(notePath, raw, opts.ontology);
    notes.push(built.note);
    edges.push(...built.edges);
    search.push(built.search);
  }

  const cache: OMSGraphCache = {
    version: CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    sourceOfTruth: ["markdown notes", ".oms/taxonomy.yaml", ".oms/concepts/*.yaml"],
    signatures: await buildSourceSignatures(vault, opts.ontology),
    notes: notes.sort((a, b) => a.path.localeCompare(b.path)),
    edges: edges.sort((a, b) => `${a.type}:${a.from}:${a.to}`.localeCompare(`${b.type}:${b.from}:${b.to}`)),
    search: search.sort((a, b) => a.path.localeCompare(b.path)),
  };

  if (opts.write) {
    const outPath = graphCachePath(vault);
    const cacheDirectory = path.dirname(outPath);
    await mkdir(cacheDirectory, { recursive: true });
    const rootRealPath = await realpath(vault);
    const cacheDirectoryRealPath = await realpath(cacheDirectory);
    ensureInsideRoot(rootRealPath, cacheDirectoryRealPath, "Graph cache directory");
    const temporaryPath = path.join(
      cacheDirectory,
      `.${path.basename(outPath)}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, {
        encoding: "utf-8",
        flag: "wx",
      });
      await rename(temporaryPath, outPath);
    } finally {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  return cache;
}

export async function readGraphCache(vault: string): Promise<OMSGraphCache | null> {
  const root = path.resolve(vault);
  const rootRealPath = await realpath(root);
  const cachePath = graphCachePath(root);
  let cacheDirectoryRealPath: string;
  try {
    cacheDirectoryRealPath = await realpath(path.dirname(cachePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  ensureInsideRoot(rootRealPath, cacheDirectoryRealPath, "Graph cache directory");
  let cacheRealPath: string;
  try {
    cacheRealPath = await realpath(cachePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        await lstat(cachePath);
      } catch (missingError) {
        if ((missingError as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw missingError;
      }
      throw new Error(`Graph cache "${cachePath}" is a broken symbolic link.`, { cause: error });
    }
    throw error;
  }
  ensureInsideRoot(rootRealPath, cacheRealPath, "Graph cache");

  const raw = await readFile(cachePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Graph cache "${cachePath}" is not valid JSON.`, { cause: error });
  }
  if (!isGraphCacheShape(parsed)) {
    throw new Error(`Graph cache "${cachePath}" has an invalid format.`);
  }
  return parsed;
}

function compareSignatures(previous: SourceSignatures, current: SourceSignatures): GraphStaleness {
  const reasons: string[] = [];
  let schemaStale = false;
  let graphStale = false;
  let searchStale = false;
  let validationStale = false;

  if (previous.taxonomyHash !== current.taxonomyHash) {
    schemaStale = true;
    graphStale = true;
    validationStale = true;
    reasons.push("taxonomy changed: folder-concept edges and validation plan are stale");
  }

  const conceptNames = new Set([...Object.keys(previous.conceptHashes), ...Object.keys(current.conceptHashes)]);
  for (const name of conceptNames) {
    if (previous.conceptHashes[name] !== current.conceptHashes[name]) {
      schemaStale = true;
      graphStale = true;
      validationStale = true;
      reasons.push(`concept schema changed: ${name}`);
    }
  }

  const notePaths = new Set([...Object.keys(previous.notes), ...Object.keys(current.notes)]);
  for (const notePath of notePaths) {
    const before = previous.notes[notePath];
    const after = current.notes[notePath];
    if (!before || !after) {
      graphStale = true;
      searchStale = true;
      validationStale = true;
      reasons.push(`note added/deleted: ${notePath}`);
      continue;
    }
    if (before.frontmatterHash !== after.frontmatterHash) {
      graphStale = true;
      searchStale = true;
      validationStale = true;
      reasons.push(`frontmatter/search axes changed: ${notePath}`);
    }
    if (before.wikilinkHash !== after.wikilinkHash) {
      graphStale = true;
      reasons.push(`wikilinks changed: ${notePath}`);
    }
    if (before.bodyTextHash !== after.bodyTextHash) {
      searchStale = true;
      reasons.push(`body/search text changed: ${notePath}`);
    }
  }

  return {
    schemaStale,
    graphStale,
    searchStale,
    embeddingStale: "not-configured",
    validationStale,
    reasons,
  };
}

export async function graphCacheStatus(vault: string, ontology: Ontology): Promise<GraphCacheStatus> {
  const cache = await readGraphCache(vault);
  const cachePath = graphCachePath(vault);
  if (!cache) {
    // Even without a persisted cache, validate source notes so malformed YAML
    // cannot be silently reported as an ordinary cache miss.
    await buildSourceSignatures(vault, ontology);
    return {
      cachePath,
      exists: false,
      generatedAt: null,
      notes: 0,
      edges: 0,
      searchDocuments: 0,
      staleness: {
        schemaStale: true,
        graphStale: true,
        searchStale: true,
        embeddingStale: "not-configured",
        validationStale: true,
        reasons: ["graph cache has not been built"],
      },
    };
  }

  return {
    cachePath,
    exists: true,
    generatedAt: cache.generatedAt,
    notes: cache.notes.length,
    edges: cache.edges.length,
    searchDocuments: cache.search.length,
    staleness: compareSignatures(cache.signatures, await buildSourceSignatures(vault, ontology)),
  };
}

export async function lazyLoadNoteBody(vault: string, notePath: string): Promise<{ path: string; body: string }> {
  const root = path.resolve(vault);
  const rootRealPath = await realpath(root);
  const resolved = safeVaultNotePath(root, notePath);
  const realResolved = await realpath(resolved);
  ensureInsideRoot(rootRealPath, realResolved, `Vault note "${notePath}"`);
  const relative = path.relative(root, resolved);
  const raw = await readFile(resolved, "utf-8");
  return { path: relative.replace(/\\/g, "/"), body: parseNote(raw).body };
}
