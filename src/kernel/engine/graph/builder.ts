import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseNote } from "../../conventions/frontmatter.js";
import { managedSourceExclusionMatcher } from "../../conventions/note-exclude.js";
import { deriveTemplateRetrievalAxes } from "../../templates/axes.js";
import type { TemplateRetrievalAxes } from "../../templates/axes.js";
import { classifyNoteTemplateIdentity } from "../../templates/note-index.js";
import type { Digest } from "../../templates/types.js";
import type { SearchTemplateSource } from "../retrieval/template-source.js";
import type { GraphEdge } from "../types.js";
import type { AxisScalar, EngineGraphNode, NodeTemplateBinding } from "./node.js";
import { toAxisScalars, tokenize } from "./node.js";
import { buildWikilinkIndexWithFrontmatter, resolveWikilink } from "./resolver.js";

const CACHE_VERSION = 3;
const NODE_CACHE_VERSION = 4;
export const TYPE_AFFINITY_MAX_GROUP = 64;

interface ParsedDoc {
  readonly docPath: string;
  readonly raw: string;
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
  readonly diagnostics: readonly string[];
}

interface BoundDoc extends ParsedDoc {
  readonly template: string | null;
  readonly binding: NodeTemplateBinding;
}

interface SerializedNode {
  readonly path: string;
  readonly template: string | null;
  readonly binding: NodeTemplateBinding;
  readonly diagnostics: readonly string[];
  readonly folder: string;
  readonly axes: Readonly<Record<string, readonly AxisScalar[]>>;
  readonly wikilinks: readonly string[];
  readonly bodyPreview: string;
  readonly searchTerms: readonly string[];
}

function fail(message: string): never { throw new Error(`TEMPLATE_GRAPH_INVALID: ${message}`); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function folderOf(pathname: string): string { return pathname.split("/")[0] ?? ""; }

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  return Object.getOwnPropertyDescriptor(record, key)?.value as T | undefined;
}

function requireSource(meta: SearchTemplateSource): TemplateRetrievalAxes | null {
  if (meta === null || typeof meta !== "object" || (meta.available !== true && meta.available !== false) || typeof meta.digest !== "string" || !Array.isArray(meta.managedSourcePaths)) {
    fail("search template source is missing or malformed");
  }
  if (meta.available === false) {
    if (typeof meta.reason !== "string") fail("search template source is missing or malformed");
    return null;
  }
  return deriveTemplateRetrievalAxes(meta.source);
}

function ensureInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} escapes the configured vault root.`);
}

async function markdownPaths(vault: string, isExcluded: (notePath: string) => Promise<boolean>): Promise<string[]> {
  const root = await realpath(vault);
  const paths: string[] = [];
  const visited = new Set<string>();
  async function walk(directory: string): Promise<void> {
    const resolved = await realpath(directory);
    ensureInside(root, resolved, `Vault directory "${directory}"`);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".oms" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const absolute = path.join(directory, entry.name);
      const target = await realpath(absolute);
      ensureInside(root, target, `Vault entry "${absolute}"`);
      const entryStat = await stat(absolute);
      if (entryStat.isDirectory()) await walk(absolute);
      else if (entryStat.isFile() && entry.name.toLocaleLowerCase().endsWith(".md")) {
        const relative = path.relative(vault, absolute).replaceAll("\\", "/");
        if (!(await isExcluded(relative))) paths.push(relative);
      }
    }
  }
  await walk(vault);
  return paths.sort((left, right) => left.localeCompare(right));
}

async function explicitPaths(vault: string, files: readonly string[], isExcluded: (notePath: string) => Promise<boolean>): Promise<string[]> {
  const root = await realpath(vault);
  const output: string[] = [];
  for (const docPath of files) {
    if (path.isAbsolute(docPath)) throw new Error(`Graph file path must be vault-relative: ${docPath}`);
    const absolute = path.resolve(vault, docPath);
    ensureInside(path.resolve(vault), absolute, `Graph file "${docPath}"`);
    const target = await realpath(absolute);
    ensureInside(root, target, `Graph file "${docPath}"`);
    if (!(await stat(absolute)).isFile()) throw new Error(`Graph file path is not a regular file: ${docPath}`);
    const normalized = path.relative(vault, absolute).replaceAll("\\", "/");
    if (!(await isExcluded(normalized))) output.push(normalized);
  }
  return [...new Set(output)].sort((left, right) => left.localeCompare(right));
}

async function graphPaths(vault: string, files: readonly string[] | undefined, meta: SearchTemplateSource): Promise<string[]> {
  const isExcluded = await managedSourceExclusionMatcher(vault, meta.managedSourcePaths);
  return files === undefined ? markdownPaths(vault, isExcluded) : explicitPaths(vault, files, isExcluded);
}

function parseDocument(raw: string): { readonly frontmatter: Record<string, unknown>; readonly body: string; readonly diagnostics: readonly string[] } {
  const parsed = parseNote(raw);
  if (parsed.diagnostics.length === 0) return { frontmatter: parsed.frontmatter, body: parsed.body, diagnostics: [] };
  return {
    frontmatter: {},
    body: parsed.body,
    diagnostics: ["invalid-frontmatter", ...parsed.diagnostics.map(item => item.message)],
  };
}

function wikilinks(markdown: string): string[] {
  const links: string[] = [];
  for (const match of markdown.matchAll(/\[\[([^\]]+)\]\]/gu)) if (match[1]?.trim()) links.push(match[1].trim());
  return links;
}

function strings(value: unknown, ancestors = new Set<object>()): string[] {
  if (!Array.isArray(value)) return typeof value === "string" && value.trim() ? [value.trim()] : [];
  if (ancestors.has(value)) return [];
  ancestors.add(value);
  try { return value.flatMap(item => strings(item, ancestors)); }
  finally { ancestors.delete(value); }
}

/** Copy frontmatter for the wikilink index so a cyclic alias array cannot recurse there. */
function acyclicValue(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (ancestors.has(value)) return null;
  if (value instanceof Date) return value;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => acyclicValue(item, ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) copy[key] = acyclicValue(ownValue(value as Record<string, unknown>, key), ancestors);
    return copy;
  } finally { ancestors.delete(value); }
}

function wikilinkIndex(docs: readonly { readonly docPath: string; readonly frontmatter: Record<string, unknown> }[]) {
  return buildWikilinkIndexWithFrontmatter(docs.map(doc => {
    const frontmatter = acyclicValue(doc.frontmatter, new Set());
    return { path: doc.docPath, frontmatter: isRecord(frontmatter) ? frontmatter : {} };
  }));
}

async function parseDocs(vault: string, paths: readonly string[]): Promise<ParsedDoc[]> {
  return Promise.all(paths.map(async docPath => {
    const raw = await readFile(path.join(vault, docPath), "utf8");
    return { docPath, raw, ...parseDocument(raw) };
  }));
}

/** Shared identity classification. Required and allowed-value checks stay out of search. */
function classifyIdentity(doc: ParsedDoc, meta: SearchTemplateSource, templateIds: ReadonlySet<string>): { readonly template: string | null; readonly binding: NodeTemplateBinding; readonly diagnostics: readonly string[] } {
  if (meta.available === false) return { template: null, binding: "unresolved", diagnostics: doc.diagnostics };
  const identity = classifyNoteTemplateIdentity(doc.frontmatter, templateIds, doc.diagnostics.length > 0);
  if (identity.layer === "unresolved") {
    return { template: null, binding: "unresolved", diagnostics: identity.reason === "invalid-frontmatter" ? doc.diagnostics : [identity.reason] };
  }
  if (identity.layer === "default") return { template: null, binding: "default", diagnostics: [] };
  return { template: identity.templateId, binding: "template", diagnostics: [] };
}

async function loadBoundDocs(vault: string, meta: SearchTemplateSource, files: readonly string[] | undefined): Promise<{ readonly retrieval: TemplateRetrievalAxes | null; readonly docs: readonly BoundDoc[] }> {
  const retrieval = requireSource(meta);
  const templateIds = new Set(retrieval?.templates.map(item => item.templateId) ?? []);
  const docs = (await parseDocs(vault, await graphPaths(vault, files, meta))).map(doc => ({ ...doc, ...classifyIdentity(doc, meta, templateIds) }));
  return { retrieval, docs };
}

function fieldKeys(retrieval: TemplateRetrievalAxes | null, doc: BoundDoc): readonly string[] {
  if (retrieval === null || doc.binding === "unresolved") return [];
  if (doc.binding === "default") return retrieval.defaultAxes.map(axis => axis.key);
  const match = retrieval.templates.find(item => item.templateId === doc.template);
  if (match === undefined) fail(`${doc.docPath} template ${doc.template ?? ""} has no derived axes`);
  return match.axes.filter(axis => axis.kind === "field").map(axis => axis.key);
}

/** Unclosed fences parse to an empty body, so malformed notes are searched from the raw text. */
function lexicalText(doc: BoundDoc): string {
  return doc.diagnostics.includes("invalid-frontmatter") ? doc.raw : doc.body;
}

function adamicAdarContribution(degree: number): number { return degree <= 1 ? 0 : 1 / Math.log(degree); }

export function typeAffinityCapWarnings(
  groups: ReadonlyMap<string, readonly string[]>,
  unbounded = process.env["OMS_TYPE_AFFINITY_UNBOUNDED"] === "1",
): string[] {
  return typeAffinityCappedTemplates(groups, unbounded)
    .map(([template, members]) =>
      `Skipped type-affinity edges for template "${template}": ${members.length} notes exceeds the ${TYPE_AFFINITY_MAX_GROUP}-note limit.`,
    );
}

function typeAffinityCappedTemplates(
  groups: ReadonlyMap<string, readonly string[]>,
  unbounded: boolean,
): [string, readonly string[]][] {
  if (unbounded) return [];
  return [...groups.entries()]
    .filter(([, members]) => members.length > TYPE_AFFINITY_MAX_GROUP)
    .sort(([left], [right]) => left.localeCompare(right));
}

function templateGroups(docs: readonly BoundDoc[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const doc of docs) {
    if (doc.binding !== "template" || doc.template === null) continue;
    const members = groups.get(doc.template) ?? [];
    members.push(doc.docPath);
    groups.set(doc.template, members);
  }
  return groups;
}

/** Build graph edges for every indexed note. Type affinity uses registered template bindings only. */
export async function buildGraphWithWarnings(opts: { readonly vaultPath: string; readonly meta: SearchTemplateSource; readonly files?: readonly string[] }): Promise<{ readonly edges: GraphEdge[]; readonly warnings: readonly string[] }> {
  const vault = path.resolve(opts.vaultPath);
  const { docs } = await loadBoundDocs(vault, opts.meta, opts.files);
  if (docs.length === 0) return { edges: [], warnings: [] };
  const index = wikilinkIndex(docs);
  const edges: GraphEdge[] = [];
  const adjacency = new Map<string, Set<string>>();
  const adjacent = (key: string): Set<string> => {
    const existing = adjacency.get(key);
    if (existing !== undefined) return existing;
    const next = new Set<string>();
    adjacency.set(key, next);
    return next;
  };
  for (const doc of docs) {
    adjacent(doc.docPath);
    for (const reference of wikilinks(doc.body)) {
      const target = resolveWikilink(reference, index).docPath;
      if (target === null) edges.push({ from: doc.docPath, to: reference, weight: 0, kind: "unknown-ref" });
      else { edges.push({ from: doc.docPath, to: target, weight: 3, kind: "wikilink" }); adjacent(doc.docPath).add(target); adjacent(target).add(doc.docPath); }
    }
    for (const reference of [...strings(doc.frontmatter.sources), ...strings(doc.frontmatter.relations)]) {
      const target = resolveWikilink(reference, index).docPath;
      edges.push(target === null ? { from: doc.docPath, to: reference, weight: 0, kind: "unknown-ref" } : { from: doc.docPath, to: target, weight: 4, kind: "frontmatter" });
    }
  }
  const pairs = new Map<string, number>();
  for (const neighbors of adjacency.values()) {
    const score = adamicAdarContribution(neighbors.size);
    if (score === 0) continue;
    const sorted = [...neighbors].sort((left, right) => left.localeCompare(right));
    for (let left = 0; left < sorted.length; left++) for (let right = left + 1; right < sorted.length; right++) {
      const a = sorted[left]!;
      const b = sorted[right]!;
      const key = a.localeCompare(b) < 0 ? `${a}\0${b}` : `${b}\0${a}`;
      pairs.set(key, (pairs.get(key) ?? 0) + score);
    }
  }
  for (const [key, score] of [...pairs].sort(([left], [right]) => left.localeCompare(right))) {
    const split = key.indexOf("\0");
    const left = key.slice(0, split);
    const right = key.slice(split + 1);
    edges.push({ from: left, to: right, weight: score * 1.5, kind: "adamic-adar" }, { from: right, to: left, weight: score * 1.5, kind: "adamic-adar" });
  }
  const groups = templateGroups(docs);
  const cappedTemplates = new Set(typeAffinityCappedTemplates(
    groups,
    process.env["OMS_TYPE_AFFINITY_UNBOUNDED"] === "1",
  ).map(([template]) => template));
  for (const [template, members] of groups) {
    if (cappedTemplates.has(template)) continue;
    for (let left = 0; left < members.length; left++) for (let right = left + 1; right < members.length; right++) {
      const from = members[left];
      const to = members[right];
      if (from === undefined || to === undefined) continue;
      edges.push({ from, to, weight: 1, kind: "type-affinity" }, { from: to, to: from, weight: 1, kind: "type-affinity" });
    }
  }
  return {
    edges: edges.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.kind.localeCompare(right.kind) || left.weight - right.weight),
    warnings: typeAffinityCapWarnings(groups),
  };
}

/** Build graph edges for every indexed note without writing vault state. */
export async function buildGraph(opts: { readonly vaultPath: string; readonly meta: SearchTemplateSource; readonly files?: readonly string[] }): Promise<GraphEdge[]> {
  return (await buildGraphWithWarnings(opts)).edges;
}

/** Scan ordinary notes and construct retrieval nodes without writing vault state. */
export async function buildNodeIndex(opts: { readonly vaultPath: string; readonly meta: SearchTemplateSource; readonly files?: readonly string[] }): Promise<EngineGraphNode[]> {
  const vault = path.resolve(opts.vaultPath);
  const { retrieval, docs } = await loadBoundDocs(vault, opts.meta, opts.files);
  const index = wikilinkIndex(docs);
  return docs.map(doc => {
    const axes: Record<string, readonly AxisScalar[]> = {};
    const searchable: string[] = [];
    const diagnostics = [...doc.diagnostics];
    for (const key of [...fieldKeys(retrieval, doc)].sort((left, right) => left.localeCompare(right))) {
      const converted = toAxisScalars(ownValue(doc.frontmatter, key));
      if (!converted.supported) diagnostics.push(`unsupported-field:${key}`);
      if (converted.values.length === 0) continue;
      axes[key] = converted.values;
      searchable.push(...converted.values.map(value => String(value)));
    }
    const outgoing = wikilinks(doc.body).map(link => resolveWikilink(link, index).docPath).filter((link): link is string => link !== null).sort((left, right) => left.localeCompare(right));
    return {
      path: doc.docPath,
      template: doc.template,
      binding: doc.binding,
      diagnostics,
      folder: folderOf(doc.docPath),
      axes,
      wikilinks: outgoing,
      bodyPreview: doc.body.slice(0, 240),
      searchTerms: new Set([...tokenize(searchable.join(" ")), ...tokenize(lexicalText(doc))]),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

/** Hash the metadata digest, managed exclusions, and current note bytes. */
export async function nodeSourceSignature(vaultPath: string, meta: SearchTemplateSource): Promise<Digest> {
  const vault = path.resolve(vaultPath);
  requireSource(meta);
  const hash = createHash("sha256");
  hash.update(meta.digest);
  hash.update("\0");
  for (const excluded of [...new Set(meta.managedSourcePaths)].sort((left, right) => left.localeCompare(right))) {
    hash.update(excluded);
    hash.update("\0");
  }
  for (const file of await graphPaths(vault, undefined, meta)) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(path.join(vault, file)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}` as Digest;
}

async function readCache(cachePath: string): Promise<string | null> {
  try { return await readFile(cachePath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { await lstat(cachePath); } catch (missing) { if ((missing as NodeJS.ErrnoException).code === "ENOENT") return null; throw missing; }
    throw new Error(`Graph cache "${cachePath}" is a broken symbolic link.`, { cause: error });
  }
}

async function atomicWrite(cachePath: string, content: string): Promise<void> {
  const directory = path.dirname(path.resolve(cachePath));
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(cachePath)}.${process.pid}-${Date.now()}.tmp`);
  try { await writeFile(temporary, content, { encoding: "utf8", flag: "wx" }); await rename(temporary, cachePath); }
  finally { try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

function parseCache(raw: string, cachePath: string): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(raw); if (!isRecord(parsed)) throw new Error(); return parsed; }
  catch (error) { throw new Error(`Graph cache "${cachePath}" has an invalid format.`, { cause: error }); }
}

function validEdges(edges: unknown): edges is GraphEdge[] {
  return Array.isArray(edges) && edges.every(edge => isRecord(edge) && typeof edge.from === "string" && typeof edge.to === "string" && typeof edge.weight === "number" && typeof edge.kind === "string");
}

function validStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function validAxes(value: unknown): value is Readonly<Record<string, readonly AxisScalar[]>> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(item => Array.isArray(item) && item.every(scalar => typeof scalar === "string" || typeof scalar === "boolean" || (typeof scalar === "number" && Number.isFinite(scalar))));
}

function validNode(node: unknown): node is SerializedNode {
  return isRecord(node)
    && typeof node.path === "string"
    && (node.template === null || typeof node.template === "string")
    && (node.binding === "template" || node.binding === "default" || node.binding === "unresolved")
    && validStringArray(node.diagnostics)
    && typeof node.folder === "string"
    && validAxes(node.axes)
    && validStringArray(node.wikilinks)
    && typeof node.bodyPreview === "string"
    && validStringArray(node.searchTerms);
}

export async function saveCachedGraph(cachePath: string, edges: readonly GraphEdge[], projectionSignature: Digest): Promise<void> {
  await atomicWrite(cachePath, `${JSON.stringify({ version: CACHE_VERSION, generatedAt: new Date().toISOString(), projectionSignature, edges })}\n`);
}

export async function loadCachedGraph(cachePath: string, projectionSignature: Digest): Promise<GraphEdge[] | null> {
  const raw = await readCache(cachePath);
  if (raw === null) return null;
  const parsed = parseCache(raw, cachePath);
  if (parsed.version !== CACHE_VERSION) return null;
  if (typeof parsed.projectionSignature !== "string") fail(`cache "${cachePath}" is stale; rebuild explicitly`);
  if (!validEdges(parsed.edges)) throw new Error(`Graph cache "${cachePath}" has an invalid format.`);
  if (parsed.projectionSignature !== projectionSignature) fail(`cache "${cachePath}" projection signature is stale; rebuild explicitly`);
  return parsed.edges;
}

export async function loadCachedGraphMeta(cachePath: string, projectionSignature: Digest): Promise<{ readonly edges: GraphEdge[]; readonly generatedAt: string } | null> {
  const raw = await readCache(cachePath);
  if (raw === null) return null;
  const parsed = parseCache(raw, cachePath);
  if (parsed.version !== CACHE_VERSION) return null;
  if (typeof parsed.projectionSignature !== "string") fail(`cache "${cachePath}" is stale; rebuild explicitly`);
  if (typeof parsed.generatedAt !== "string" || !validEdges(parsed.edges)) throw new Error(`Graph cache "${cachePath}" has an invalid format.`);
  if (parsed.projectionSignature !== projectionSignature) fail(`cache "${cachePath}" projection signature is stale; rebuild explicitly`);
  return { edges: parsed.edges, generatedAt: parsed.generatedAt };
}

export async function saveNodeIndex(cachePath: string, nodes: readonly EngineGraphNode[], sourceSignature: Digest, projectionSignature: Digest): Promise<void> {
  const serialized: SerializedNode[] = nodes.map(node => ({
    path: node.path,
    template: node.template,
    binding: node.binding,
    diagnostics: [...node.diagnostics],
    folder: node.folder,
    axes: node.axes,
    wikilinks: node.wikilinks,
    bodyPreview: node.bodyPreview,
    searchTerms: [...node.searchTerms].sort((left, right) => left.localeCompare(right)),
  }));
  await atomicWrite(cachePath, `${JSON.stringify({ version: NODE_CACHE_VERSION, generatedAt: new Date().toISOString(), sourceSignature, projectionSignature, nodes: serialized })}\n`);
}

export async function loadNodeIndex(cachePath: string, sourceSignature: Digest, projectionSignature: Digest): Promise<EngineGraphNode[] | null> {
  const raw = await readCache(cachePath);
  if (raw === null) return null;
  const parsed = parseCache(raw, cachePath);
  if (parsed.version !== NODE_CACHE_VERSION) return null;
  if (typeof parsed.sourceSignature !== "string" || typeof parsed.projectionSignature !== "string") fail(`node cache "${cachePath}" is stale; rebuild explicitly`);
  if (parsed.sourceSignature !== sourceSignature || parsed.projectionSignature !== projectionSignature) fail(`node cache "${cachePath}" signature is stale; rebuild explicitly`);
  if (!Array.isArray(parsed.nodes)) throw new Error(`Node cache "${cachePath}" has an invalid format.`);
  const nodes: SerializedNode[] = [];
  for (const node of parsed.nodes) {
    if (!validNode(node)) throw new Error(`Node cache "${cachePath}" has an invalid format.`);
    nodes.push(node);
  }
  return nodes.map(node => ({
    path: node.path,
    template: node.template,
    binding: node.binding,
    diagnostics: [...node.diagnostics],
    folder: node.folder,
    axes: node.axes,
    wikilinks: [...node.wikilinks],
    bodyPreview: node.bodyPreview,
    searchTerms: new Set(node.searchTerms),
  }));
}
