import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseNote } from "../conventions/frontmatter.js";
import { validateFrontmatter } from "../conventions/validate.js";
import { safeVaultNotePath } from "../capture/safe.js";
import { resolveConcept } from "../core/ontology/resolver.js";
import type { Concept, Ontology } from "../core/ontology/types.js";

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

export interface RetrieveHit {
  path: string;
  concept: string | null;
  folder: string;
  axes: Record<string, string[]>;
  wikilinks: string[];
  score: number;
  bodyPreview: string;
}

const CACHE_VERSION = 1;

export function graphCachePath(vault: string): string {
  return path.join(vault, ".oms", "cache", "graph.json");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function* walkMarkdown(dir: string, base: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name === ".oms" || entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(full, base);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
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

async function buildSourceSignatures(vault: string, ontology: Ontology): Promise<SourceSignatures> {
  const notes: Record<string, NoteSignature> = {};
  for await (const notePath of walkMarkdown(vault, vault)) {
    const fullPath = path.join(vault, notePath);
    const [raw, fileStat] = await Promise.all([readFile(fullPath, "utf-8"), stat(fullPath)]);
    const parsed = parseNote(raw);
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
  const parsed = parseNote(raw);
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
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(cache, null, 2)}\n`, "utf-8");
  }

  return cache;
}

export async function readGraphCache(vault: string): Promise<OMSGraphCache | null> {
  try {
    const raw = await readFile(graphCachePath(vault), "utf-8");
    const parsed = JSON.parse(raw) as OMSGraphCache;
    return parsed.version === CACHE_VERSION ? parsed : null;
  } catch {
    return null;
  }
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

function matchesAxis(note: GraphNote, opts: RetrieveByAxisOptions): boolean {
  if (opts.concept && note.concept !== opts.concept) return false;
  if (opts.folder && note.folder !== opts.folder) return false;
  if (opts.wikilink && !note.wikilinks.includes(opts.wikilink)) return false;
  if (opts.property) {
    const values = note.axes[opts.property] ?? [];
    if (opts.value && !values.includes(opts.value)) return false;
    if (!opts.value && values.length === 0) return false;
  }
  return true;
}

function searchScore(search: SearchDocument | undefined, query: string | undefined): number {
  if (!query || !search) return 0;
  const queryTerms = tokenize(query);
  return queryTerms.filter((term) => search.terms.includes(term)).length;
}

export async function retrieveByAxis(opts: RetrieveByAxisOptions): Promise<RetrieveHit[]> {
  const cache = (await readGraphCache(opts.vault)) ?? (await buildGraphCache({ ...opts, write: false }));
  const searchByPath = new Map(cache.search.map((item) => [item.path, item]));
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));

  return cache.notes
    .filter((note) => matchesAxis(note, opts))
    .map((note) => {
      const search = searchByPath.get(note.path);
      return {
        path: note.path,
        concept: note.concept,
        folder: note.folder,
        axes: note.axes,
        wikilinks: note.wikilinks,
        score: searchScore(search, opts.query),
        bodyPreview: search?.bodyPreview ?? "",
      };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

export async function lazyLoadNoteBody(vault: string, notePath: string): Promise<{ path: string; body: string }> {
  const resolved = safeVaultNotePath(vault, notePath);
  const relative = path.relative(vault, resolved);
  const raw = await readFile(resolved, "utf-8");
  return { path: relative.replace(/\\/g, "/"), body: parseNote(raw).body };
}
