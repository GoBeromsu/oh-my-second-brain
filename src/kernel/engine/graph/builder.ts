import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseNote } from "../../conventions/frontmatter.js";
import { managedSourceExclusionMatcher } from "../../conventions/note-exclude.js";
import { deriveTemplateRetrievalAxes } from "../../templates/axes.js";
import type { Digest, ResolvedConvention, TemplateId } from "../../templates/types.js";
import type { GraphEdge } from "../types.js";
import type { AxisScalar, EngineGraphNode } from "./node.js";
import { toAxisScalars, tokenize } from "./node.js";
import { buildWikilinkIndexWithFrontmatter, resolveWikilink } from "./resolver.js";

const CACHE_VERSION = 2;
const NODE_CACHE_VERSION = 3;
export const TYPE_AFFINITY_MAX_GROUP = 64;

interface ParsedDoc {
  readonly docPath: string;
  readonly raw: string;
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

interface SerializedNode {
  readonly path: string;
  readonly template: string;
  readonly folder: string;
  readonly axes: Readonly<Record<string, readonly AxisScalar[]>>;
  readonly wikilinks: readonly string[];
  readonly bodyPreview: string;
  readonly searchTerms: readonly string[];
}

function fail(message: string): never { throw new Error(`TEMPLATE_GRAPH_INVALID: ${message}`); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function folder(pathname: string): string { return pathname.split("/")[0] ?? ""; }
function excludedPaths(convention: ResolvedConvention): ReadonlySet<string> { return new Set(convention.managedSourcePaths); }

function requireConvention(convention: ResolvedConvention): void {
  if (!isRecord(convention) || typeof convention.inputSignature !== "string" || !isRecord(convention.templates) || !isRecord(convention.globalAxes) || !Array.isArray(convention.managedSourcePaths)) fail("resolved template projection is missing or malformed");
  deriveTemplateRetrievalAxes(convention);
}

function ensureInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} escapes the configured vault root.`);
}

async function markdownPaths(vault: string, isExcluded: (path: string) => Promise<boolean>): Promise<string[]> {
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

async function explicitPaths(vault: string, files: readonly string[], isExcluded: (path: string) => Promise<boolean>): Promise<string[]> {
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

async function graphPaths(vault: string, files: readonly string[] | undefined, convention: ResolvedConvention): Promise<string[]> {
  const isExcluded = await managedSourceExclusionMatcher(vault, convention.managedSourcePaths);
  return files === undefined ? markdownPaths(vault, isExcluded) : explicitPaths(vault, files, isExcluded);
}

function parseDocument(raw: string, docPath: string): { readonly frontmatter: Record<string, unknown>; readonly body: string } {
  const parsed = parseNote(raw);
  if (parsed.diagnostics.length) throw new Error(`Malformed frontmatter in ${docPath}: ${parsed.diagnostics.map(item => item.message).join("; ")}`);
  return { frontmatter: parsed.frontmatter, body: parsed.body };
}

function wikilinks(markdown: string): string[] {
  const links: string[] = [];
  for (const match of markdown.matchAll(/\[\[([^\]]+)\]\]/gu)) if (match[1]?.trim()) links.push(match[1].trim());
  return links;
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(strings);
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

async function parseDocs(vault: string, paths: readonly string[]): Promise<ParsedDoc[]> {
  return Promise.all(paths.map(async docPath => {
    const raw = await readFile(path.join(vault, docPath), "utf8");
    return { docPath, raw, ...parseDocument(raw, docPath) };
  }));
}

function isKnownTemplateId(value: unknown, convention: ResolvedConvention): value is TemplateId {
  return typeof value === "string" && Object.hasOwn(convention.templates, value);
}

function templateId(doc: ParsedDoc, convention: ResolvedConvention): TemplateId | null {
  const value = doc.frontmatter.template;
  if (value === undefined) return null;
  if (!isKnownTemplateId(value, convention)) return null;
  return value;
}

function selectedDocs(docs: readonly ParsedDoc[], convention: ResolvedConvention): ParsedDoc[] {
  return docs.filter(doc => templateId(doc, convention) !== null);
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

/** Build graph edges from the current resolved template projection without writing vault state. */
export async function buildGraphWithWarnings(opts: { readonly vaultPath: string; readonly convention: ResolvedConvention; readonly files?: readonly string[] }): Promise<{ readonly edges: GraphEdge[]; readonly warnings: readonly string[] }> {
  const vault = path.resolve(opts.vaultPath);
  requireConvention(opts.convention);
  const docs = selectedDocs(await parseDocs(vault, await graphPaths(vault, opts.files, opts.convention)), opts.convention);
  if (docs.length === 0) return { edges: [], warnings: [] };
  const index = buildWikilinkIndexWithFrontmatter(docs.map(doc => ({ path: doc.docPath, frontmatter: doc.frontmatter })));
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
  for (const [common, neighbors] of adjacency) {
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
  const groups = new Map<string, string[]>();
  for (const doc of docs) {
    const id = templateId(doc, opts.convention)!;
    const members = groups.get(id) ?? [];
    members.push(doc.docPath);
    groups.set(id, members);
  }
  const cappedTemplates = new Set(typeAffinityCappedTemplates(
    groups,
    process.env["OMS_TYPE_AFFINITY_UNBOUNDED"] === "1",
  ).map(([template]) => template));
  for (const [template, members] of groups) {
    if (cappedTemplates.has(template)) continue;
    for (let left = 0; left < members.length; left++) for (let right = left + 1; right < members.length; right++) {
    edges.push({ from: members[left]!, to: members[right]!, weight: 1, kind: "type-affinity" }, { from: members[right]!, to: members[left]!, weight: 1, kind: "type-affinity" });
  }
  }
  return {
    edges: edges.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.kind.localeCompare(right.kind) || left.weight - right.weight),
    warnings: typeAffinityCapWarnings(groups),
  };
}

/** Build graph edges from the current resolved template projection without writing vault state. */
export async function buildGraph(opts: { readonly vaultPath: string; readonly convention: ResolvedConvention; readonly files?: readonly string[] }): Promise<GraphEdge[]> {
  return (await buildGraphWithWarnings(opts)).edges;
}

/** Scan template-bound notes and construct retrieval nodes without writing vault state. */
export async function buildNodeIndex(opts: { readonly vaultPath: string; readonly convention: ResolvedConvention; readonly files?: readonly string[] }): Promise<EngineGraphNode[]> {
  const vault = path.resolve(opts.vaultPath);
  requireConvention(opts.convention);
  const retrieval = deriveTemplateRetrievalAxes(opts.convention);
  const declared = new Map(retrieval.templates.map(item => [item.templateId, new Set(item.axes.map(axis => axis.key))]));
  const docs = selectedDocs(await parseDocs(vault, await graphPaths(vault, opts.files, opts.convention)), opts.convention);
  const index = buildWikilinkIndexWithFrontmatter(docs.map(doc => ({ path: doc.docPath, frontmatter: doc.frontmatter })));
  return docs.map(doc => {
    const template = templateId(doc, opts.convention)!;
    const allowed = declared.get(template);
    if (allowed === undefined) fail(`${doc.docPath} template ${template} has no derived axes`);
    const axes: Record<string, readonly AxisScalar[]> = {};
    const searchable: string[] = [];
    for (const key of [...allowed].sort((left, right) => left.localeCompare(right))) {
      if (key === "template") continue;
      const values = toAxisScalars(doc.frontmatter[key]);
      if (values.length) { axes[key] = values; searchable.push(...values.map(String)); }
    }
    const outgoing = wikilinks(doc.body).map(link => resolveWikilink(link, index).docPath).filter((link): link is string => link !== null).sort((left, right) => left.localeCompare(right));
    return { path: doc.docPath, template, folder: folder(doc.docPath), axes, wikilinks: outgoing, bodyPreview: doc.body.slice(0, 240), searchTerms: new Set([...tokenize(searchable.join(" ")), ...tokenize(doc.body)]) };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

/** Hash current indexed notes, exact projection input signature, and managed exclusions. */
export async function nodeSourceSignature(vaultPath: string, convention: ResolvedConvention): Promise<Digest> {
  const vault = path.resolve(vaultPath);
  requireConvention(convention);
  const hash = createHash("sha256");
  hash.update(convention.inputSignature);
  hash.update("\0");
  for (const excluded of [...excludedPaths(convention)].sort((left, right) => left.localeCompare(right))) { hash.update(excluded); hash.update("\0"); }
  for (const file of await graphPaths(vault, undefined, convention)) { hash.update(file); hash.update("\0"); hash.update(await readFile(path.join(vault, file))); hash.update("\0"); }
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

function validEdges(edges: unknown): edges is GraphEdge[] { return Array.isArray(edges) && edges.every(edge => isRecord(edge) && typeof edge.from === "string" && typeof edge.to === "string" && typeof edge.weight === "number" && typeof edge.kind === "string"); }

export async function saveCachedGraph(cachePath: string, edges: readonly GraphEdge[], projectionSignature: Digest): Promise<void> {
  await atomicWrite(cachePath, `${JSON.stringify({ version: CACHE_VERSION, generatedAt: new Date().toISOString(), projectionSignature, edges })}\n`);
}

export async function loadCachedGraph(cachePath: string, projectionSignature: Digest): Promise<GraphEdge[] | null> {
  const raw = await readCache(cachePath);
  if (raw === null) return null;
  const parsed = parseCache(raw, cachePath);
  if (parsed.version !== CACHE_VERSION || typeof parsed.projectionSignature !== "string") fail(`cache "${cachePath}" is stale; rebuild explicitly`);
  if (!validEdges(parsed.edges)) throw new Error(`Graph cache "${cachePath}" has an invalid format.`);
  if (parsed.projectionSignature !== projectionSignature) fail(`cache "${cachePath}" projection signature is stale; rebuild explicitly`);
  return parsed.edges;
}

export async function loadCachedGraphMeta(cachePath: string, projectionSignature: Digest): Promise<{ readonly edges: GraphEdge[]; readonly generatedAt: string } | null> {
  const raw = await readCache(cachePath);
  if (raw === null) return null;
  const parsed = parseCache(raw, cachePath);
  if (parsed.version !== CACHE_VERSION || typeof parsed.projectionSignature !== "string") fail(`cache "${cachePath}" is stale; rebuild explicitly`);
  if (typeof parsed.generatedAt !== "string" || !validEdges(parsed.edges)) throw new Error(`Graph cache "${cachePath}" has an invalid format.`);
  if (parsed.projectionSignature !== projectionSignature) fail(`cache "${cachePath}" projection signature is stale; rebuild explicitly`);
  return { edges: parsed.edges, generatedAt: parsed.generatedAt };
}

export async function saveNodeIndex(cachePath: string, nodes: readonly EngineGraphNode[], sourceSignature: Digest, projectionSignature: Digest): Promise<void> {
  const serialized: SerializedNode[] = nodes.map(node => ({ path: node.path, template: node.template, folder: node.folder, axes: node.axes, wikilinks: node.wikilinks, bodyPreview: node.bodyPreview, searchTerms: [...node.searchTerms].sort((left, right) => left.localeCompare(right)) }));
  await atomicWrite(cachePath, `${JSON.stringify({ version: NODE_CACHE_VERSION, generatedAt: new Date().toISOString(), sourceSignature, projectionSignature, nodes: serialized })}\n`);
}

export async function loadNodeIndex(cachePath: string, sourceSignature: Digest, projectionSignature: Digest): Promise<EngineGraphNode[] | null> {
  const raw = await readCache(cachePath);
  if (raw === null) return null;
  const parsed = parseCache(raw, cachePath);
  if (parsed.version !== NODE_CACHE_VERSION || typeof parsed.sourceSignature !== "string" || typeof parsed.projectionSignature !== "string") fail(`node cache "${cachePath}" is stale; rebuild explicitly`);
  if (parsed.sourceSignature !== sourceSignature || parsed.projectionSignature !== projectionSignature) fail(`node cache "${cachePath}" signature is stale; rebuild explicitly`);
  if (!Array.isArray(parsed.nodes) || !parsed.nodes.every(node => isRecord(node) && typeof node.path === "string" && typeof node.template === "string" && typeof node.folder === "string" && isRecord(node.axes) && Array.isArray(node.wikilinks) && node.wikilinks.every(item => typeof item === "string") && typeof node.bodyPreview === "string" && Array.isArray(node.searchTerms) && node.searchTerms.every(item => typeof item === "string"))) throw new Error(`Node cache "${cachePath}" has an invalid format.`);
  return (parsed.nodes as SerializedNode[]).map(node => ({ ...node, searchTerms: new Set(node.searchTerms) }));
}
