import type { BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { mapWithConcurrency } from "../../conventions/vault-walk.js";
import { fileMetadataWitness, readFileSnapshot } from "../../conventions/file-snapshot.js";
import { parseNote, type ParsedNote } from "../../conventions/frontmatter.js";
import { managedSourceExclusionMatcher } from "../../conventions/note-exclude.js";
import type { Digest } from "../../conventions/canonical.js";
import { classifyNoteTemplateIdentity, deriveTemplateRetrievalAxes, type TemplateRetrievalAxes } from "../retrieval/axes.js";
import { readSearchTemplateSource, type SearchTemplateSource } from "../retrieval/template-source.js";
import type { GraphEdge } from "../types.js";
import type { AxisScalar, EngineGraphNode, NodeTemplateBinding } from "./node.js";
import { toAxisScalars, tokenize } from "./node.js";
import { buildWikilinkIndexWithFrontmatter, resolveWikilink } from "./resolver.js";

const CACHE_VERSION = 3;
const NODE_CACHE_VERSION = 5;
export const TYPE_AFFINITY_MAX_GROUP = 64;

interface ParsedDoc {
  readonly docPath: string;
  readonly raw: string;
  readonly bytes: Buffer;
  readonly metadataWitness: string | null;
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

/**
 * Declared field axes, or null when the contract could not be established. A
 * graph is still built from actual note bytes in that case; the diagnostics
 * travel with the metadata instead of blocking the scan.
 */
function requireSource(meta: SearchTemplateSource): TemplateRetrievalAxes | null {
  if (meta === null || typeof meta !== "object" || typeof meta.digest !== "string"
    || meta.source === null || typeof meta.source !== "object" || meta.exclusions === null || typeof meta.exclusions !== "object"
    || !Array.isArray(meta.diagnostics)) {
    fail("search template source is missing or malformed");
  }
  if (meta.source.templates === null && meta.source.defaultFields === null) return null;
  return deriveTemplateRetrievalAxes(meta.source);
}

function ensureInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} escapes the configured vault root.`);
}

async function markdownPaths(vault: string, isExcluded: (notePath: string) => Promise<boolean>, metadata?: Map<string, BigIntStats>): Promise<string[]> {
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
      const entryStat = await stat(absolute, { bigint: true });
      if (entryStat.isDirectory()) await walk(absolute);
      else if (entryStat.isFile() && entry.name.toLocaleLowerCase().endsWith(".md")) {
        const relative = path.relative(vault, absolute).replaceAll("\\", "/");
        if (!(await isExcluded(relative))) { paths.push(relative); metadata?.set(relative, entryStat); }
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

async function graphPaths(vault: string, files: readonly string[] | undefined, meta: SearchTemplateSource, metadata?: Map<string, BigIntStats>): Promise<string[]> {
  const isExcluded = await managedSourceExclusionMatcher(vault, meta.source.sourcePaths ?? []);
  return files === undefined ? markdownPaths(vault, isExcluded, metadata) : explicitPaths(vault, files, isExcluded);
}

function parseDocument(raw: string, parsed: Readonly<ParsedNote> = parseNote(raw)): { readonly frontmatter: Record<string, unknown>; readonly body: string; readonly diagnostics: readonly string[] } {
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

async function parseDocs(vault: string, paths: readonly string[], expected?: ReadonlyMap<string, BigIntStats>): Promise<ParsedDoc[]> {
  let failed = false;
  let firstError: unknown;
  const docs = await mapWithConcurrency(paths, 32, async docPath => {
    if (failed) return null;
    try {
      const { bytes, witness: metadataWitness } = await readFileSnapshot(path.join(vault, docPath), expected?.get(docPath));
      const raw = bytes.toString("utf8");
      return { docPath, raw, bytes, metadataWitness, ...parseDocument(raw) };
    } catch (error) {
      // Stop admitting reads, but let every admitted handle close before the
      // original failure reaches a caller that may immediately retry the build.
      if (!failed) { failed = true; firstError = error; }
      return null;
    }
  });
  if (failed) throw firstError;
  return docs.filter((doc): doc is ParsedDoc => doc !== null);
}

/** Shared identity classification. Required and allowed-value checks stay out of search. */
function classifyIdentity(doc: Pick<ParsedDoc, "frontmatter" | "diagnostics">, meta: SearchTemplateSource, templateIds: ReadonlySet<string>): { readonly template: string | null; readonly binding: NodeTemplateBinding; readonly diagnostics: readonly string[] } {
  if (meta.source.templates === null) return { template: null, binding: "unresolved", diagnostics: doc.diagnostics };
  const identity = classifyNoteTemplateIdentity(doc.frontmatter, templateIds, doc.diagnostics.length > 0);
  if (identity.layer === "unresolved") {
    return { template: null, binding: "unresolved", diagnostics: identity.reason === "invalid-frontmatter" ? doc.diagnostics : [identity.reason] };
  }
  if (identity.layer === "default") return { template: null, binding: "default", diagnostics: [] };
  return { template: identity.templateId, binding: "template", diagnostics: [] };
}

async function loadBoundDocs(vault: string, meta: SearchTemplateSource, files: readonly string[] | undefined, captured?: { readonly paths: readonly string[]; readonly metadata: ReadonlyMap<string, BigIntStats> }): Promise<{ readonly retrieval: TemplateRetrievalAxes | null; readonly docs: readonly BoundDoc[] }> {
  const retrieval = requireSource(meta);
  const templateIds = new Set(retrieval?.templates.map(item => item.templateId) ?? []);
  const docs = (await parseDocs(vault, captured?.paths ?? await graphPaths(vault, files, meta), captured?.metadata)).map(doc => ({ ...doc, ...classifyIdentity(doc, meta, templateIds) }));
  return { retrieval, docs };
}

function fieldKeys(retrieval: TemplateRetrievalAxes | null, doc: Pick<BoundDoc, "docPath" | "template" | "binding">): readonly string[] {
  if (retrieval === null || doc.binding === "unresolved") return [];
  if (doc.binding === "default") return retrieval.defaultAxes.map(axis => axis.key);
  const match = retrieval.templates.find(item => item.templateId === doc.template);
  if (match === undefined) fail(`${doc.docPath} template ${doc.template ?? ""} has no derived axes`);
  return match.axes.filter(axis => axis.kind === "field").map(axis => axis.key);
}

/** Unclosed fences parse to an empty body, so malformed notes are searched from the raw text. */
function lexicalText(doc: Pick<ParsedDoc, "raw" | "body" | "diagnostics">): string {
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
  return graphFromDocs(docs);
}

function graphFromDocs(docs: readonly BoundDoc[]): { readonly edges: GraphEdge[]; readonly warnings: readonly string[] } {
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

/** Compact input for the existing node projection; it retains no raw note body. */
export interface NodeProjectionDocument {
  readonly docPath: string;
  readonly frontmatter: Record<string, unknown>;
  readonly diagnostics: readonly string[];
  readonly links: readonly string[];
  readonly bodyPreview: string;
  readonly lexicalTerms: readonly string[];
  /** Conservative representation-size estimate for bounded process-local caches. */
  readonly retainedBytes: number;
}

/** V8 slices can pin a whole note; retained projection strings must own their bytes. */
function ownString(value: string): string { return Buffer.from(value, "utf16le").toString("utf16le"); }

function ownProjectionValue(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (typeof value === "string") return ownString(value);
  if (value === null || typeof value !== "object") return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  const copy: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : Object.create(null) as Record<string, unknown>;
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, ownString(key), {
      value: ownProjectionValue(ownValue(value as Record<string, unknown>, key), seen),
      enumerable: true, configurable: true, writable: true,
    });
  }
  return copy;
}

function projectionDocument(doc: Pick<ParsedDoc, "docPath" | "raw" | "frontmatter" | "body" | "diagnostics">, includeLexicalTerms = true): NodeProjectionDocument {
  const links = wikilinks(doc.body).map(ownString);
  const lexicalTerms = includeLexicalTerms ? [...new Set(tokenize(lexicalText(doc)))].map(ownString) : [];
  const bodyPreview = ownString(doc.body.slice(0, 240));
  const frontmatter = ownProjectionValue(doc.frontmatter) as Record<string, unknown>;
  const diagnostics = doc.diagnostics.map(ownString);
  let frontmatterBytes: number;
  try { frontmatterBytes = Buffer.byteLength(JSON.stringify(acyclicValue(frontmatter, new Set())), "utf8") * 4; }
  catch { frontmatterBytes = Buffer.byteLength(doc.raw, "utf8") * 4; }
  const stringBytes = (values: readonly string[]): number => values.reduce((sum, value) => sum + value.length * 2 + 64, 0);
  return {
    docPath: ownString(doc.docPath), frontmatter, diagnostics,
    links, lexicalTerms, bodyPreview,
    retainedBytes: frontmatterBytes + stringBytes([...links, ...lexicalTerms, ...doc.diagnostics]) + bodyPreview.length * 2 + doc.docPath.length * 2 + 1024,
  };
}

/** Parse captured bytes once; facets do not need retained lexical terms. */
export function parseNodeProjectionDocument(docPath: string, raw: string, includeLexicalTerms = true, parsed?: Readonly<ParsedNote>): NodeProjectionDocument {
  // A caller sharing the same captured bytes may reuse their canonical parse.
  return projectionDocument({ docPath, raw, ...parseDocument(raw, parsed) }, includeLexicalTerms);
}

/** Reuse one binding/axis/link projection for filesystem and live captured sources. */
export function projectNodeIndex(sources: readonly NodeProjectionDocument[], meta: SearchTemplateSource): EngineGraphNode[] {
  const retrieval = requireSource(meta);
  const templateIds = new Set(retrieval?.templates.map(item => item.templateId) ?? []);
  const docs = sources.map(doc => ({ ...doc, ...classifyIdentity(doc, meta, templateIds) }));
  return nodesFromProjectionDocs(retrieval, docs);
}

/** Preserve the graph cache's single handle-bound byte capture and classification. */
function nodesFromDocs(retrieval: TemplateRetrievalAxes | null, docs: readonly BoundDoc[]): EngineGraphNode[] {
  return nodesFromProjectionDocs(retrieval, docs.map(doc => ({
    ...projectionDocument(doc), template: doc.template, binding: doc.binding, diagnostics: doc.diagnostics,
  })));
}

/** Scan ordinary notes and construct retrieval nodes without writing vault state. */
export async function buildNodeIndex(opts: { readonly vaultPath: string; readonly meta: SearchTemplateSource; readonly files?: readonly string[] }): Promise<EngineGraphNode[]> {
  const { retrieval, docs } = await loadBoundDocs(path.resolve(opts.vaultPath), opts.meta, opts.files);
  return nodesFromDocs(retrieval, docs);
}

function nodesFromProjectionDocs(retrieval: TemplateRetrievalAxes | null, docs: readonly (NodeProjectionDocument & Pick<BoundDoc, "template" | "binding">)[]): EngineGraphNode[] {
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
    const outgoing = doc.links.map(link => resolveWikilink(link, index).docPath).filter((link): link is string => link !== null).sort((left, right) => left.localeCompare(right));
    return {
      path: doc.docPath,
      template: doc.template,
      binding: doc.binding,
      diagnostics,
      folder: folderOf(doc.docPath),
      axes,
      wikilinks: outgoing,
      bodyPreview: doc.bodyPreview,
      searchTerms: new Set([...tokenize(searchable.join(" ")), ...doc.lexicalTerms]),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function nodeSourceHash(meta: SearchTemplateSource) {
  requireSource(meta);
  const hash = createHash("sha256");
  hash.update(meta.digest);
  hash.update("\0");
  for (const excluded of [...new Set(meta.source.sourcePaths ?? [])].sort((left, right) => left.localeCompare(right))) {
    hash.update(excluded);
    hash.update("\0");
  }
  return hash;
}

/** Hash the metadata digest, registered source exclusions, and current note bytes. */
export async function nodeSourceSignature(vaultPath: string, meta: SearchTemplateSource): Promise<Digest> {
  const vault = path.resolve(vaultPath);
  const hash = nodeSourceHash(meta);
  for (const file of await graphPaths(vault, undefined, meta)) {
    hash.update(file);
    hash.update("\0");
    hash.update((await readFileSnapshot(path.join(vault, file))).bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}` as Digest;
}

/** Filesystem change witness, not a replacement for the authoritative byte hash. */
async function nodeMetadataSnapshot(vaultPath: string, meta: SearchTemplateSource): Promise<{ readonly signature: Digest | null; readonly paths: readonly string[]; readonly metadata: ReadonlyMap<string, BigIntStats> }> {
  requireSource(meta);
  const metadata = new Map<string, BigIntStats>();
  const paths = await graphPaths(path.resolve(vaultPath), undefined, meta, metadata);
  const hash = createHash("sha256");
  hash.update(JSON.stringify(["oms.node-metadata.v1", meta.digest, meta.exclusions.digest,
    [...new Set(meta.source.sourcePaths ?? [])].sort((left, right) => left.localeCompare(right))]));
  let trusted = true;
  for (const file of paths) {
    const witness = fileMetadataWitness(metadata.get(file));
    if (witness === null) trusted = false;
    hash.update(JSON.stringify([file, witness]));
  }
  return { signature: trusted ? `sha256:${hash.digest("hex")}` : null, paths, metadata };
}

/** Build and verify all cache inputs before either cache is published by an explicit repair. */
export async function buildGraphSnapshot(vaultPath: string, meta?: SearchTemplateSource): Promise<{
  readonly meta: SearchTemplateSource;
  readonly nodes: EngineGraphNode[];
  readonly edges: GraphEdge[];
  readonly warnings: readonly string[];
  readonly sourceSignature: Digest;
  readonly metadataSignature: Digest | null;
}> {
  const beforeMeta = meta ?? await readSearchTemplateSource(vaultPath);
  const before = await nodeMetadataSnapshot(vaultPath, beforeMeta);
  // One captured membership and byte set feeds every artifact. Independent scans
  // could disagree if an exclusion changed and reverted between those scans.
  const { retrieval, docs } = await loadBoundDocs(path.resolve(vaultPath), beforeMeta, undefined, before);
  const built = graphFromDocs(docs);
  const nodes = nodesFromDocs(retrieval, docs);
  const hash = nodeSourceHash(beforeMeta);
  for (const doc of docs) { hash.update(doc.docPath); hash.update("\0"); hash.update(doc.bytes); hash.update("\0"); }
  const sourceSignature = `sha256:${hash.digest("hex")}` as Digest;
  const afterMeta = await readSearchTemplateSource(vaultPath);
  const after = await nodeMetadataSnapshot(vaultPath, afterMeta);
  if (beforeMeta.digest !== afterMeta.digest || JSON.stringify(before.paths) !== JSON.stringify(after.paths)
    || (before.signature !== null && before.signature !== after.signature)) fail("vault changed during graph build; retry the explicit build");
  const trustedReads = docs.every(doc => doc.metadataWitness !== null);
  if (before.signature === null || after.signature === null || !trustedReads) {
    if (sourceSignature !== await nodeSourceSignature(vaultPath, afterMeta)) fail("vault changed during graph build; retry the explicit build");
  }
  return { ...built, nodes, meta: beforeMeta, sourceSignature, metadataSignature: before.signature !== null && after.signature !== null && trustedReads ? before.signature : null };
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

export async function saveNodeIndex(cachePath: string, nodes: readonly EngineGraphNode[], sourceSignature: Digest, projectionSignature: Digest, metadataSignature: Digest | null = null): Promise<void> {
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
  await atomicWrite(cachePath, `${JSON.stringify({ version: NODE_CACHE_VERSION, generatedAt: new Date().toISOString(), sourceSignature, projectionSignature, metadataSignature, nodes: serialized })}\n`);
}

interface NodeCache {
  readonly sourceSignature: string;
  readonly projectionSignature: string;
  readonly metadataSignature: string | null;
  readonly nodes: SerializedNode[];
}

async function readNodeCache(cachePath: string): Promise<NodeCache | null> {
  const raw = await readCache(cachePath);
  if (raw === null) return null;
  const parsed = parseCache(raw, cachePath);
  if (parsed.version !== NODE_CACHE_VERSION) return null;
  if (typeof parsed.sourceSignature !== "string" || typeof parsed.projectionSignature !== "string") fail(`node cache "${cachePath}" is stale; rebuild explicitly`);
  if ((parsed.metadataSignature !== null && (typeof parsed.metadataSignature !== "string" || !/^sha256:[a-f0-9]{64}$/.test(parsed.metadataSignature)))
    || !Array.isArray(parsed.nodes) || !parsed.nodes.every(validNode)) throw new Error(`Node cache "${cachePath}" has an invalid format.`);
  return { sourceSignature: parsed.sourceSignature, projectionSignature: parsed.projectionSignature,
    metadataSignature: parsed.metadataSignature, nodes: parsed.nodes };
}

function restoreNodes(nodes: readonly SerializedNode[]): EngineGraphNode[] {
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

/** Explicit byte-signature validation remains available for callers without a build witness. */
export async function loadNodeIndex(cachePath: string, sourceSignature: Digest, projectionSignature: Digest): Promise<EngineGraphNode[] | null> {
  const cached = await readNodeCache(cachePath);
  if (cached === null) return null;
  if (cached.sourceSignature !== sourceSignature || cached.projectionSignature !== projectionSignature) fail(`node cache "${cachePath}" signature is stale; rebuild explicitly`);
  return restoreNodes(cached.nodes);
}

/** Read-only warm path: miss before walking; changed metadata falls back to exact note bytes. */
export async function loadNodeIndexForVault(cachePath: string, vaultPath: string, meta: SearchTemplateSource): Promise<EngineGraphNode[] | null> {
  const cached = await readNodeCache(cachePath);
  if (cached === null) return null;
  if (cached.projectionSignature !== meta.digest) fail(`node cache "${cachePath}" projection signature is stale; rebuild explicitly`);
  if (cached.metadataSignature === null || cached.metadataSignature !== (await nodeMetadataSnapshot(vaultPath, meta)).signature) {
    if (cached.sourceSignature !== await nodeSourceSignature(vaultPath, meta)) fail(`node cache "${cachePath}" signature is stale; rebuild explicitly`);
  }
  return restoreNodes(cached.nodes);
}
