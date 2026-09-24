import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { digestBytes, hashCanonical } from "./canonical.js";
import { loadConfiguredTemplatePaths } from "./hints.js";
import {
  normalizeTemplateControlPath,
  normalizeTemplateFolderPath,
  normalizeTemplateSourcePath,
  verifyTemplateControlPath,
  verifyTemplateFolderPath,
  verifyTemplateSourcePath,
} from "./paths.js";
import { readTemplateReviewContext } from "./review-context.js";
import type { Digest, TemplateId, TemplatePolicy, TemplateSourcePath } from "./types.js";

/**
 * Read-only inventory of raw template candidates.
 * Bytes are digested exactly and decoded as UTF-8 without stripping a BOM or
 * rewriting newlines. Templater, JavaScript, tokens, and frontmatter are not
 * parsed or executed. A new file name is not a template id.
 */

export const TEMPLATE_CENSUS_DIGEST_DOMAIN = "oms.template-census.v4";
/** Historical source cap previously published by the removed renderer. */
export const MAX_TEMPLATE_SOURCE_BYTES = 262_144;
const MAX_TEMPLATE_SOURCE_DEPTH = 16;
const MAX_TEMPLATE_SOURCE_FILES = 10_000;
const MAX_TEMPLATE_SOURCE_DIRECTORIES = 2_048;
const POLICY_PATH = ".oms/template-policy.json";

export type CensusAuthority = "absent" | "approved" | "invalid";
export type CensusBindingStatus = "matched" | "drift" | "missing" | "relocated" | "ambiguous" | "unreadable" | "conflict";
export type CensusDiffKind = "added" | "edited" | "missing" | "relocated" | "ambiguous";

export interface CensusDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly templateId?: TemplateId;
}

export interface TemplateCensusSelection {
  readonly path: string;
  readonly kind: "file" | "folder";
}

export interface TemplateCensusOptions {
  /** Caller-explicit files or folders. These are not discovered from note content. */
  readonly selections?: readonly TemplateCensusSelection[];
  /**
   * When omitted, configured Obsidian and Templater paths are included as raw
   * file or folder selections. Content hints are never consulted.
   */
  readonly includeConfiguredPaths?: boolean;
}

export interface CensusSource {
  readonly path: TemplateSourcePath;
  readonly bytes: Uint8Array;
  readonly rawDigest: Digest;
  /** UTF-8 with the BOM retained. Null when the bytes are not UTF-8. */
  readonly text: string | null;
  readonly diagnostics: readonly CensusDiagnostic[];
}

export interface CensusBinding {
  readonly templateId: TemplateId;
  readonly identity: string;
  readonly approvedPath: TemplateSourcePath;
  readonly approvedRawDigest: Digest;
  readonly observedPath: TemplateSourcePath | null;
  readonly observedRawDigest: Digest | null;
  readonly status: CensusBindingStatus;
  readonly candidatePaths: readonly TemplateSourcePath[];
}

export interface CensusDiff {
  readonly kind: CensusDiffKind;
  readonly path: TemplateSourcePath;
  readonly fromPath: TemplateSourcePath | null;
  readonly templateId: TemplateId | null;
  readonly rawDigest: Digest | null;
  readonly approvedRawDigest: Digest | null;
  readonly candidatePaths: readonly TemplateSourcePath[];
  readonly automatic: boolean;
}

export interface CensusResult {
  readonly vault: string;
  readonly authority: CensusAuthority;
  readonly generationDigest: Digest | null;
  readonly approvedPolicy: TemplatePolicy | null;
  readonly sources: readonly CensusSource[];
  readonly bindings: readonly CensusBinding[];
  readonly diffs: readonly CensusDiff[];
  readonly diagnostics: readonly CensusDiagnostic[];
  readonly censusDigest: Digest;
}

interface ApprovedRef {
  readonly templateId: TemplateId;
  readonly identity: string;
  readonly path: TemplateSourcePath;
  readonly rawDigest: Digest;
}

interface ReadySource {
  readonly path: TemplateSourcePath;
  readonly bytes: Uint8Array;
  readonly rawDigest: Digest;
  readonly text: string | null;
  readonly diagnostics: CensusDiagnostic[];
}

interface Budget {
  files: number;
  directories: number;
  exhausted: boolean;
}

function compareText(left: string, right: string): number {
  const leftCodes = Array.from(left, character => character.codePointAt(0) ?? 0);
  const rightCodes = Array.from(right, character => character.codePointAt(0) ?? 0);
  const length = Math.min(leftCodes.length, rightCodes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftCodes[index]! - rightCodes[index]!;
    if (difference !== 0) return difference;
  }
  return leftCodes.length - rightCodes.length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function prefixedCode(error: unknown, fallback: string): string {
  if (error instanceof Error && "code" in error && error.code === "ELOOP") return "TEMPLATE_SOURCE_UNSAFE";
  const code = errorMessage(error).split(":", 1)[0] ?? "";
  return /^[A-Z][A-Z0-9_]*$/u.test(code) ? code : fallback;
}

function diagnostic(code: string, message: string, path?: string, templateId?: TemplateId): CensusDiagnostic {
  return {
    code,
    message,
    ...(path === undefined ? {} : { path }),
    ...(templateId === undefined ? {} : { templateId }),
  };
}

function pushDiagnostic(diagnostics: CensusDiagnostic[], value: CensusDiagnostic): void {
  if (diagnostics.some(item => item.code === value.code && item.path === value.path && item.templateId === value.templateId && item.message === value.message)) return;
  diagnostics.push(value);
}

function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function vaultRelative(root: string, absolutePath: string): string {
  return relative(root, absolutePath).replaceAll("\\", "/");
}

function decodeRaw(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

async function readBounded(root: string, absolutePath: string): Promise<{ readonly bytes?: Uint8Array; readonly oversized: boolean }> {
  const parent = dirname(absolutePath);
  const canonicalParent = await realpath(parent);
  if (!contained(root, canonicalParent)) throw new Error(`TEMPLATE_SOURCE_UNSAFE: ${absolutePath} has a parent outside the vault`);
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`TEMPLATE_SOURCE_UNSAFE: ${absolutePath} is not a regular file`);
    if (before.size > MAX_TEMPLATE_SOURCE_BYTES) return { oversized: true };
    const buffer = Buffer.alloc(MAX_TEMPLATE_SOURCE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - total) {
        throw new Error(`TEMPLATE_SOURCE_READ_FAILED: invalid byte count returned for ${absolutePath}`);
      }
      total += bytesRead;
    }
    const after = await handle.stat();
    if (!contained(root, await realpath(parent)) || !contained(root, await realpath(absolutePath))) {
      throw new Error(`TEMPLATE_SOURCE_UNSAFE: ${absolutePath} escaped the vault while reading`);
    }
    if (total > MAX_TEMPLATE_SOURCE_BYTES || after.size > MAX_TEMPLATE_SOURCE_BYTES) return { oversized: true };
    if (after.size !== before.size || total !== after.size) {
      throw new Error(`TEMPLATE_SOURCE_READ_FAILED: ${absolutePath} changed while reading`);
    }
    return { bytes: new Uint8Array(buffer.subarray(0, total)), oversized: false };
  } finally {
    await handle.close();
  }
}

async function readCandidate(root: string, sourcePath: TemplateSourcePath): Promise<
  | { readonly state: "absent" }
  | { readonly state: "blocked"; readonly diagnostic: CensusDiagnostic }
  | { readonly state: "ready"; readonly source: ReadySource }
> {
  let absolutePath: string;
  try {
    const verified = await verifyTemplateSourcePath(root, sourcePath, { expected: "either" });
    if (verified.targetRealPath === null) return { state: "absent" };
    absolutePath = verified.absolutePath;
  } catch (error: unknown) {
    return { state: "blocked", diagnostic: diagnostic(prefixedCode(error, "TEMPLATE_SOURCE_READ_FAILED"), `Template source cannot be verified: ${errorMessage(error)}`, sourcePath) };
  }
  let stat;
  try {
    stat = await lstat(absolutePath);
  } catch (error: unknown) {
    return { state: "blocked", diagnostic: diagnostic("TEMPLATE_SOURCE_READ_FAILED", `Template source cannot be read: ${errorMessage(error)}`, sourcePath) };
  }
  if (stat.isSymbolicLink()) return { state: "blocked", diagnostic: diagnostic("TEMPLATE_SOURCE_UNSAFE", "Symlink template entry is skipped", sourcePath) };
  if (!stat.isFile()) return { state: "blocked", diagnostic: diagnostic("TEMPLATE_SOURCE_INVALID", "Template source is not a regular file", sourcePath) };
  try {
    const bounded = await readBounded(root, absolutePath);
    if (bounded.oversized || bounded.bytes === undefined) {
      return {
        state: "blocked",
        diagnostic: diagnostic("TEMPLATE_PROPOSAL_OVERSIZE", `Template source exceeds the ${MAX_TEMPLATE_SOURCE_BYTES}-byte source limit`, sourcePath),
      };
    }
    const bytes = bounded.bytes;
    const diagnostics: CensusDiagnostic[] = [];
    let text: string | null = null;
    try {
      text = decodeRaw(bytes);
    } catch {
      diagnostics.push(diagnostic("TEMPLATE_SOURCE_MALFORMED", "Template source is not valid UTF-8; bytes were not decoded or parsed", sourcePath));
    }
    return { state: "ready", source: { path: sourcePath, bytes, rawDigest: digestBytes(bytes), text, diagnostics } };
  } catch (error: unknown) {
    return { state: "blocked", diagnostic: diagnostic(prefixedCode(error, "TEMPLATE_SOURCE_READ_FAILED"), `Template source cannot be read: ${errorMessage(error)}`, sourcePath) };
  }
}

function exhaust(budget: Budget, diagnostics: CensusDiagnostic[], path: string, kind: "files" | "directories"): boolean {
  if (budget.exhausted) return true;
  if (kind === "files" && budget.files >= MAX_TEMPLATE_SOURCE_FILES) {
    budget.exhausted = true;
    pushDiagnostic(diagnostics, diagnostic("TEMPLATE_PROPOSAL_OVERSIZE", `Template source scan exceeds ${MAX_TEMPLATE_SOURCE_FILES} files`, path));
    return true;
  }
  if (kind === "directories" && budget.directories >= MAX_TEMPLATE_SOURCE_DIRECTORIES) {
    budget.exhausted = true;
    pushDiagnostic(diagnostics, diagnostic("TEMPLATE_PROPOSAL_OVERSIZE", `Template source scan exceeds ${MAX_TEMPLATE_SOURCE_DIRECTORIES} directories`, path));
    return true;
  }
  return false;
}

async function scanFolder(root: string, folder: string, budget: Budget, files: Set<string>, diagnostics: CensusDiagnostic[]): Promise<void> {
  let verified: Awaited<ReturnType<typeof verifyTemplateFolderPath>>;
  try {
    verified = await verifyTemplateFolderPath(root, normalizeTemplateFolderPath(folder));
  } catch (error: unknown) {
    pushDiagnostic(diagnostics, diagnostic(prefixedCode(error, "TEMPLATE_FOLDER_INVALID"), `Selected template folder cannot be verified: ${errorMessage(error)}`, folder));
    return;
  }
  if (verified.targetRealPath === null) {
    pushDiagnostic(diagnostics, diagnostic("TEMPLATE_FOLDER_INVALID", "Selected template folder is absent", folder));
    return;
  }
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (exhaust(budget, diagnostics, vaultRelative(root, directory), "directories")) return;
    budget.directories += 1;
    let directoryStat;
    try {
      directoryStat = await lstat(directory);
    } catch (error: unknown) {
      pushDiagnostic(diagnostics, diagnostic("TEMPLATE_SOURCE_READ_FAILED", `Template directory cannot be read: ${errorMessage(error)}`, vaultRelative(root, directory)));
      return;
    }
    if (directoryStat.isSymbolicLink()) {
      pushDiagnostic(diagnostics, diagnostic("TEMPLATE_SOURCE_UNSAFE", "Symlink directory is not a trusted template scope", vaultRelative(root, directory)));
      return;
    }
    if (!directoryStat.isDirectory()) {
      pushDiagnostic(diagnostics, diagnostic("TEMPLATE_FOLDER_INVALID", "Selected template folder is not a directory", vaultRelative(root, directory)));
      return;
    }
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      pushDiagnostic(diagnostics, diagnostic("TEMPLATE_SOURCE_READ_FAILED", `Template directory cannot be read: ${errorMessage(error)}`, vaultRelative(root, directory)));
      return;
    }
    children.sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      if (budget.exhausted) return;
      const absolutePath = join(directory, child.name);
      const rawPath = vaultRelative(root, absolutePath);
      if (child.isSymbolicLink()) {
        pushDiagnostic(diagnostics, diagnostic("TEMPLATE_SOURCE_UNSAFE", "Symlink template entry is skipped", rawPath));
        continue;
      }
      if (child.name.startsWith(".")) {
        if (child.isDirectory() || child.name.endsWith(".md")) {
          pushDiagnostic(diagnostics, diagnostic("TEMPLATE_SOURCE_UNSAFE", "Hidden template subtree or Markdown leaf is excluded from discovery", rawPath));
        }
        continue;
      }
      if (child.isDirectory()) {
        if (child.name.endsWith(".md")) {
          pushDiagnostic(diagnostics, diagnostic("TEMPLATE_SOURCE_INVALID", "Template directory leaf is not a markdown file", rawPath));
          continue;
        }
        if (depth >= MAX_TEMPLATE_SOURCE_DEPTH) {
          pushDiagnostic(diagnostics, diagnostic("TEMPLATE_PROPOSAL_OVERSIZE", `Template source depth exceeds the limit of ${MAX_TEMPLATE_SOURCE_DEPTH}`, rawPath));
          continue;
        }
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!child.isFile() || !child.name.endsWith(".md")) continue;
      let sourcePath: TemplateSourcePath;
      try {
        sourcePath = normalizeTemplateSourcePath(rawPath);
      } catch (error: unknown) {
        pushDiagnostic(diagnostics, diagnostic(prefixedCode(error, "TEMPLATE_SOURCE_INVALID"), `Template source is invalid: ${errorMessage(error)}`, rawPath));
        continue;
      }
      if (files.has(sourcePath) || exhaust(budget, diagnostics, sourcePath, "files")) continue;
      budget.files += 1;
      files.add(sourcePath);
    }
  };
  await visit(verified.absolutePath, 0);
}

async function configuredSelections(root: string, diagnostics: CensusDiagnostic[]): Promise<readonly TemplateCensusSelection[]> {
  try {
    const configured = await loadConfiguredTemplatePaths(root);
    return configured.map(item => ({ path: item.path, kind: item.kind }));
  } catch (error: unknown) {
    pushDiagnostic(diagnostics, diagnostic("TEMPLATE_SOURCE_READ_FAILED", `Configured template paths cannot be read: ${errorMessage(error)}`));
    return [];
  }
}

async function readAuthority(root: string, diagnostics: CensusDiagnostic[]): Promise<{
  readonly authority: CensusAuthority;
  readonly generationDigest: Digest | null;
  readonly approvedPolicy: TemplatePolicy | null;
  readonly approved: readonly ApprovedRef[];
}> {
  let policyPresent = false;
  try {
    const verified = await verifyTemplateControlPath(root, normalizeTemplateControlPath(POLICY_PATH), { expected: "either" });
    policyPresent = verified.targetRealPath !== null;
  } catch (error: unknown) {
    pushDiagnostic(diagnostics, diagnostic(prefixedCode(error, "CONTRACT_UNVERIFIABLE"), `Approved policy cannot be verified: ${errorMessage(error)}`, POLICY_PATH));
    return { authority: "invalid", generationDigest: null, approvedPolicy: null, approved: [] };
  }
  if (!policyPresent) return { authority: "absent", generationDigest: null, approvedPolicy: null, approved: [] };
  try {
    const review = await readTemplateReviewContext(root);
    for (const item of review.resolved.diagnostics) {
      if (item.code === "SOURCE_DRIFT") continue;
      const detail = item.field === undefined ? item.message ?? item.code : `${item.message ?? item.code} (${item.field})`;
      pushDiagnostic(diagnostics, diagnostic(item.code, detail, item.path, item.templateId));
    }
    const approved: ApprovedRef[] = [];
    for (const templateId of Object.keys(review.resolved.policy.templates).sort(compareText)) {
      const template = review.resolved.policy.templates[templateId];
      if (template?.source === undefined) continue;
      approved.push({
        templateId: template.templateId,
        identity: template.source.identity,
        path: template.source.path,
        rawDigest: template.source.rawDigest,
      });
    }
    return {
      authority: "approved",
      generationDigest: review.resolved.generationDigest,
      approvedPolicy: review.resolved.policy,
      approved,
    };
  } catch (error: unknown) {
    pushDiagnostic(diagnostics, diagnostic(prefixedCode(error, "CONTRACT_UNVERIFIABLE"), errorMessage(error), POLICY_PATH));
    return { authority: "invalid", generationDigest: null, approvedPolicy: null, approved: [] };
  }
}

function pair(
  approved: readonly ApprovedRef[],
  sources: readonly ReadySource[],
  blocked: ReadonlySet<string>,
  diagnostics: CensusDiagnostic[],
): { readonly bindings: CensusBinding[]; readonly diffs: CensusDiff[] } {
  const observed = new Map<string, ReadySource>(sources.map(source => [source.path, source]));
  const byPath = new Map<string, ApprovedRef[]>();
  for (const ref of approved) {
    const group = byPath.get(ref.path) ?? [];
    group.push(ref);
    byPath.set(ref.path, group);
  }
  const consumed = new Set<string>();
  const bindings: CensusBinding[] = [];
  const pending: ApprovedRef[] = [];
  for (const path of [...byPath.keys()].sort(compareText)) {
    const group = byPath.get(path) ?? [];
    if (group.length > 1) {
      pushDiagnostic(diagnostics, diagnostic("TEMPLATE_SOURCE_DUPLICATE", "Multiple approved templates claim this source path", path));
      for (const ref of group) {
        bindings.push({
          templateId: ref.templateId,
          identity: ref.identity,
          approvedPath: ref.path,
          approvedRawDigest: ref.rawDigest,
          observedPath: null,
          observedRawDigest: null,
          status: "conflict",
          candidatePaths: [],
        });
      }
      if (observed.has(path)) consumed.add(path);
      continue;
    }
    const ref = group[0]!;
    const source = observed.get(path);
    if (source !== undefined) {
      consumed.add(path);
      const drift = source.rawDigest !== ref.rawDigest;
      if (drift) pushDiagnostic(diagnostics, diagnostic("SOURCE_DRIFT", `Raw source ${path} does not match the approved raw digest`, path, ref.templateId));
      bindings.push({
        templateId: ref.templateId,
        identity: ref.identity,
        approvedPath: ref.path,
        approvedRawDigest: ref.rawDigest,
        observedPath: source.path,
        observedRawDigest: source.rawDigest,
        status: drift ? "drift" : "matched",
        candidatePaths: [],
      });
      continue;
    }
    if (blocked.has(path)) {
      bindings.push({
        templateId: ref.templateId,
        identity: ref.identity,
        approvedPath: ref.path,
        approvedRawDigest: ref.rawDigest,
        observedPath: null,
        observedRawDigest: null,
        status: "unreadable",
        candidatePaths: [],
      });
      continue;
    }
    pending.push(ref);
  }

  const unbound = sources.filter(source => !consumed.has(source.path));
  const unboundByDigest = new Map<string, ReadySource[]>();
  for (const source of unbound) {
    const group = unboundByDigest.get(source.rawDigest) ?? [];
    group.push(source);
    unboundByDigest.set(source.rawDigest, group);
  }
  const ambiguousPaths = new Set<string>();
  for (const ref of [...pending].sort((left, right) => compareText(left.templateId, right.templateId))) {
    const candidates = (unboundByDigest.get(ref.rawDigest) ?? []).map(source => source.path).sort(compareText);
    const sameDigest = pending.filter(item => item.rawDigest === ref.rawDigest);
    if (candidates.length === 1 && sameDigest.length === 1) {
      const match = unbound.find(source => source.path === candidates[0]);
      if (match === undefined) continue;
      consumed.add(match.path);
      bindings.push({
        templateId: ref.templateId,
        identity: ref.identity,
        approvedPath: ref.path,
        approvedRawDigest: ref.rawDigest,
        observedPath: match.path,
        observedRawDigest: match.rawDigest,
        status: "relocated",
        candidatePaths: [],
      });
      continue;
    }
    if (candidates.length > 0) {
      for (const candidate of candidates) ambiguousPaths.add(candidate);
      pushDiagnostic(diagnostics, diagnostic(
        "TEMPLATE_RENAME_AMBIGUOUS",
        `Raw source ${ref.path} has no unique exact-byte replacement`,
        ref.path,
        ref.templateId,
      ));
      bindings.push({
        templateId: ref.templateId,
        identity: ref.identity,
        approvedPath: ref.path,
        approvedRawDigest: ref.rawDigest,
        observedPath: null,
        observedRawDigest: null,
        status: "ambiguous",
        candidatePaths: candidates,
      });
      continue;
    }
    pushDiagnostic(diagnostics, diagnostic("TEMPLATE_SOURCE_MISSING", `Raw source ${ref.path} is missing`, ref.path, ref.templateId));
    bindings.push({
      templateId: ref.templateId,
      identity: ref.identity,
      approvedPath: ref.path,
      approvedRawDigest: ref.rawDigest,
      observedPath: null,
      observedRawDigest: null,
      status: "missing",
      candidatePaths: [],
    });
  }

  for (const source of sources) {
    if (consumed.has(source.path) || ambiguousPaths.has(source.path)) continue;
    const owners = bindings.filter(binding => binding.observedRawDigest === source.rawDigest && binding.status !== "ambiguous");
    if (owners.length > 0) {
      pushDiagnostic(diagnostics, diagnostic("TEMPLATE_SOURCE_DUPLICATE", `Raw bytes at ${source.path} duplicate an approved source`, source.path, owners[0]?.templateId));
    }
  }

  const diffs: CensusDiff[] = [];
  for (const binding of bindings) {
    if (binding.status === "drift") {
      diffs.push({
        kind: "edited",
        path: binding.observedPath ?? binding.approvedPath,
        fromPath: null,
        templateId: binding.templateId,
        rawDigest: binding.observedRawDigest,
        approvedRawDigest: binding.approvedRawDigest,
        candidatePaths: [],
        automatic: false,
      });
    } else if (binding.status === "relocated" && binding.observedPath !== null) {
      diffs.push({
        kind: "relocated",
        path: binding.observedPath,
        fromPath: binding.approvedPath,
        templateId: binding.templateId,
        rawDigest: binding.observedRawDigest,
        approvedRawDigest: binding.approvedRawDigest,
        candidatePaths: [],
        automatic: true,
      });
    } else if (binding.status === "missing") {
      diffs.push({
        kind: "missing",
        path: binding.approvedPath,
        fromPath: null,
        templateId: binding.templateId,
        rawDigest: null,
        approvedRawDigest: binding.approvedRawDigest,
        candidatePaths: [],
        automatic: false,
      });
    } else if (binding.status === "ambiguous") {
      diffs.push({
        kind: "ambiguous",
        path: binding.approvedPath,
        fromPath: null,
        templateId: binding.templateId,
        rawDigest: null,
        approvedRawDigest: binding.approvedRawDigest,
        candidatePaths: binding.candidatePaths,
        automatic: false,
      });
    }
  }
  for (const source of sources) {
    if (consumed.has(source.path) || ambiguousPaths.has(source.path)) continue;
    diffs.push({
      kind: "added",
      path: source.path,
      fromPath: null,
      templateId: null,
      rawDigest: source.rawDigest,
      approvedRawDigest: null,
      candidatePaths: [],
      automatic: false,
    });
  }
  bindings.sort((left, right) => compareText(left.templateId, right.templateId) || compareText(left.approvedPath, right.approvedPath));
  diffs.sort((left, right) => compareText(left.kind, right.kind) || compareText(left.path, right.path) || compareText(left.templateId ?? "", right.templateId ?? ""));
  return { bindings, diffs };
}

function censusDigest(result: Omit<CensusResult, "censusDigest">): Digest {
  return hashCanonical(TEMPLATE_CENSUS_DIGEST_DOMAIN, {
    authority: result.authority,
    generationDigest: result.generationDigest,
    sources: result.sources.map(source => ({ path: source.path, rawDigest: source.rawDigest, decoded: source.text !== null })),
    bindings: result.bindings,
    diffs: result.diffs,
    diagnostics: result.diagnostics.map(item => ({
      code: item.code,
      path: item.path ?? null,
      templateId: item.templateId ?? null,
      message: item.message,
    })),
  });
}

/**
 * Lists raw candidates from explicit selections, configured file or folder
 * settings, and approved source refs. Invalid policy stays unverifiable.
 * Exact-byte identity pairing is the only automatic match.
 */
async function collectSources(
  root: string,
  requested: readonly TemplateCensusSelection[],
  initialPaths: readonly string[] = [],
): Promise<{ sources: ReadySource[]; blocked: Set<string>; missing: string[]; diagnostics: CensusDiagnostic[] }> {
  const diagnostics: CensusDiagnostic[] = [];
  const files = new Set<string>(initialPaths);
  const budget: Budget = { files: files.size, directories: 0, exhausted: false };
  for (const selection of requested) {
    if (selection.kind === "folder") {
      await scanFolder(root, selection.path, budget, files, diagnostics);
      continue;
    }
    try {
      const sourcePath = normalizeTemplateSourcePath(selection.path);
      if (!files.has(sourcePath) && !exhaust(budget, diagnostics, sourcePath, "files")) {
        budget.files += 1;
        files.add(sourcePath);
      }
    } catch (error: unknown) {
      pushDiagnostic(diagnostics, diagnostic(prefixedCode(error, "TEMPLATE_SOURCE_INVALID"), `Selected template file is invalid: ${errorMessage(error)}`, selection.path));
    }
  }
  const sources: ReadySource[] = [];
  const blocked = new Set<string>();
  const missing: string[] = [];
  for (const path of [...files].sort(compareText)) {
    const read = await readCandidate(root, path as TemplateSourcePath);
    if (read.state === "absent") {
      missing.push(path);
      continue;
    }
    if (read.state === "blocked") {
      blocked.add(path);
      pushDiagnostic(diagnostics, read.diagnostic);
      continue;
    }
    sources.push(read.source);
    for (const item of read.source.diagnostics) pushDiagnostic(diagnostics, item);
  }
  return { sources, blocked, missing, diagnostics };
}

export interface TemplateSourceInventory {
  readonly sources: readonly CensusSource[];
  readonly complete: boolean;
  readonly diagnostics: readonly CensusDiagnostic[];
}

/** Explicit raw discovery only: no policy, approval, configured hints or registration side effects. */
export async function scanTemplateSources(vault: string, selections: readonly TemplateCensusSelection[]): Promise<TemplateSourceInventory> {
  const root = await realpath(vault);
  const { sources, diagnostics, missing } = await collectSources(root, selections);
  for (const path of missing) diagnostics.push(diagnostic("TEMPLATE_SOURCE_MISSING", "Selected source is absent or disappeared during discovery", path));
  return { sources, complete: diagnostics.length === 0, diagnostics };
}

export async function templateCensus(vault: string, options: TemplateCensusOptions = {}): Promise<CensusResult> {
  const root = await realpath(vault);
  const diagnostics: CensusDiagnostic[] = [];
  const authority = await readAuthority(root, diagnostics);
  const requested: TemplateCensusSelection[] = [...(options.selections ?? [])];
  if (options.includeConfiguredPaths !== false) requested.push(...await configuredSelections(root, diagnostics));
  const inventory = await collectSources(root, requested, authority.approved.map(ref => ref.path));
  const { sources, blocked } = inventory;
  for (const item of inventory.diagnostics) pushDiagnostic(diagnostics, item);
  const paired = pair(authority.approved, sources, blocked, diagnostics);
  diagnostics.sort((left, right) => compareText(left.path ?? "", right.path ?? "") || compareText(left.code, right.code) || compareText(left.message, right.message));
  const result: Omit<CensusResult, "censusDigest"> = {
    vault: root,
    authority: authority.authority,
    generationDigest: authority.generationDigest,
    approvedPolicy: authority.approvedPolicy,
    sources,
    bindings: paired.bindings,
    diffs: paired.diffs,
    diagnostics,
  };
  return { ...result, censusDigest: censusDigest(result) };
}
