import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  deriveTemplateSourcePath,
  normalizeTemplateFolderPath,
  normalizeTemplateSourcePath,
  verifyTemplateFolderPath,
  verifyTemplateSourcePath,
  validateTemplateId,
} from "./paths.js";
import { MAX_TEMPLATE_SOURCE_BYTES } from "./renderer.js";
import type { Digest, TemplateBinding, TemplateFolderPath, TemplateId, TemplatePolicy, TemplateSourcePath } from "./types.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_TEMPLATE_SOURCE_DEPTH = 16;

export type CensusDiffKind = "added" | "edited" | "deleted" | "renamed";
export type CensusRenameStrategy = "identical-bytes" | "body-signature" | "lone-delete-add";
export type CensusDiagnosticCode =
  | "TEMPLATE_FOLDER_INVALID"
  | "TEMPLATE_SOURCE_UNSAFE"
  | "TEMPLATE_SOURCE_INVALID"
  | "TEMPLATE_SOURCE_READ_FAILED"
  | "TEMPLATE_SOURCE_DUPLICATE"
  | "TEMPLATE_PROPOSAL_OVERSIZE"
  | "TEMPLATE_ID_INVALID"
  | "TEMPLATE_ID_DUPLICATE"
  | "TEMPLATE_RENAME_AMBIGUOUS";

export interface CensusDiagnostic {
  readonly code: CensusDiagnosticCode;
  readonly message: string;
  readonly path?: string;
  readonly templateId?: TemplateId;
}

/** A prior source identity/signature; verification gates automatic exact-byte pairing. */
export interface CensusPriorEntry {
  readonly sourcePath: TemplateSourcePath;
  readonly templateId: TemplateId;
  readonly signature: Digest;
  /**
   * Indicates that the prior signature was independently approved by policy,
   * rather than merely copied from an untrusted projection descriptor.
   */
  readonly signatureVerified: boolean;
  readonly bodySignature?: Digest;
}

export interface CensusEntry {
  readonly sourcePath: TemplateSourcePath;
  readonly bytes: Uint8Array;
  readonly signature: Digest;
  readonly templateId?: TemplateId;
  readonly diagnostics: readonly CensusDiagnostic[];
}

export interface CensusDiff {
  readonly kind: CensusDiffKind;
  /** The current path for add/edit/rename, or the former path for delete. */
  readonly sourcePath: TemplateSourcePath;
  readonly oldSourcePath?: TemplateSourcePath;
  readonly newSourcePath?: TemplateSourcePath;
  readonly templateId?: TemplateId;
  readonly automatic: boolean;
  readonly confirmationRequired: boolean;
  readonly strategy?: CensusRenameStrategy;
}

export interface CensusResult {
  readonly entries: readonly CensusEntry[];
  readonly diffs: readonly CensusDiff[];
  readonly diagnostics: readonly CensusDiagnostic[];
  readonly digest: Digest;
}

interface InternalEntry {
  readonly sourcePath: TemplateSourcePath;
  readonly bytes: Uint8Array;
  readonly signature: Digest;
  readonly bodySignature?: Digest;
  readonly rawPath: string;
  readonly diagnostics: CensusDiagnostic[];
  templateId?: TemplateId;
  identity: "policy" | "prior" | "slug" | "none";
}

interface IndexedBinding {
  readonly binding: TemplateBinding;
  readonly sourcePath: TemplateSourcePath;
}

interface IndexedPrior {
  readonly prior: CensusPriorEntry;
  readonly sourcePath: TemplateSourcePath;
}

interface MissingBinding {
  readonly sourcePath: TemplateSourcePath;
  readonly templateId: TemplateId;
  readonly signature?: Digest;
  readonly signatureVerified: boolean;
  readonly bodySignature?: Digest;
}

type DeletedCandidate = IndexedPrior | MissingBinding;

function deletedTemplateId(value: DeletedCandidate): TemplateId {
  return "prior" in value ? value.prior.templateId : value.templateId;
}

function deletedSignature(value: DeletedCandidate): Digest | undefined {
  return "prior" in value ? value.prior.signature : value.signature;
}

function deletedSignatureVerified(value: DeletedCandidate): boolean {
  return "prior" in value ? value.prior.signatureVerified : value.signatureVerified;
}

function deletedBodySignature(value: DeletedCandidate): Digest | undefined {
  return "prior" in value ? value.prior.bodySignature : value.bodySignature;
}

function digest(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Digest;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathCaseKey(path: string): string {
  return path.toLocaleLowerCase("en-US");
}

function diagnostic(
  code: CensusDiagnosticCode,
  message: string,
  path?: string,
  templateId?: TemplateId,
): CensusDiagnostic {
  return {
    code,
    message,
    ...(path === undefined ? {} : { path }),
    ...(templateId === undefined ? {} : { templateId }),
  };
}

function addDiagnostic(entry: InternalEntry, value: CensusDiagnostic): void {
  if (!entry.diagnostics.some(item => item.code === value.code && item.message === value.message)) entry.diagnostics.push(value);
}

/** Derives the stable template identity shared by census and migration. */
export function proposedTemplateId(path: string): TemplateId | null {
  const stem = basename(path, ".md").replace(/\.(?:template|eta)$/iu, "");
  const slug = stem
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, "-")
    .replace(/-{3,}/gu, "--")
    .replace(/^-+|-+$/gu, "");
  if (slug.length === 0) return null;
  try {
    return validateTemplateId(slug);
  } catch {
    return null;
  }
}

function bodySignature(bytes: Uint8Array): Digest | undefined {
  const decoded = decoder.decode(bytes);
  const content = decoded.startsWith("\ufeff") ? decoded.slice(1) : decoded;
  if (!/^---(?:\r?\n)/u.test(content)) return undefined;
  const close = /^(?:---)\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(content);
  if (close === null) return undefined;
  return digest(encoder.encode(content.slice(close[0].length)));
}

function canonicalPrior(prior: readonly CensusPriorEntry[], diagnostics: CensusDiagnostic[]): readonly IndexedPrior[] {
  const result: IndexedPrior[] = [];
  const seen = new Set<string>();
  for (const value of prior) {
    if (value === null || typeof value !== "object") {
      diagnostics.push(diagnostic("TEMPLATE_SOURCE_INVALID", "Prior census entry must be an object"));
      continue;
    }
    const rawPath = typeof value.sourcePath === "string" ? value.sourcePath : "";
    let sourcePath: TemplateSourcePath;
    try {
      sourcePath = normalizeTemplateSourcePath(rawPath);
    } catch (error: unknown) {
      diagnostics.push(diagnostic("TEMPLATE_SOURCE_INVALID", `Prior census source is invalid: ${errorMessage(error)}`, rawPath || undefined));
      continue;
    }
    if (seen.has(sourcePath)) {
      diagnostics.push(diagnostic("TEMPLATE_SOURCE_DUPLICATE", "Prior census contains a duplicate source path", sourcePath));
      continue;
    }
    seen.add(sourcePath);
    if (typeof value.templateId !== "string" || value.templateId.length === 0) {
      diagnostics.push(diagnostic("TEMPLATE_ID_INVALID", "Prior census source has no template id", sourcePath));
      continue;
    }
    if (typeof value.signature !== "string" || !DIGEST.test(value.signature)) {
      diagnostics.push(diagnostic("TEMPLATE_SOURCE_INVALID", "Prior census source has an invalid signature", sourcePath, value.templateId as TemplateId));
      continue;
    }
    if (typeof value.signatureVerified !== "boolean") {
      diagnostics.push(diagnostic("TEMPLATE_SOURCE_INVALID", "Prior census source has no signature verification status", sourcePath, value.templateId as TemplateId));
      continue;
    }
    if (value.bodySignature !== undefined && !DIGEST.test(value.bodySignature)) {
      diagnostics.push(diagnostic("TEMPLATE_SOURCE_INVALID", "Prior census source has an invalid body signature", sourcePath, value.templateId as TemplateId));
      continue;
    }
    result.push({ prior: value, sourcePath });
  }
  return result.sort((left, right) => compare(left.sourcePath, right.sourcePath));
}

function indexedBindings(policy: TemplatePolicy, diagnostics: CensusDiagnostic[]): ReadonlyMap<string, readonly IndexedBinding[]> {
  const grouped = new Map<string, IndexedBinding[]>();
  for (const binding of Object.values(policy.templates)) {
    let rawPath: string;
    let sourcePath: TemplateSourcePath;
    try {
      rawPath = deriveTemplateSourcePath(binding);
      sourcePath = normalizeTemplateSourcePath(rawPath);
    } catch (error: unknown) {
      diagnostics.push(diagnostic("TEMPLATE_SOURCE_INVALID", `Policy source is invalid: ${errorMessage(error)}`, binding.sourcePath, binding.templateId));
      continue;
    }
    const values = grouped.get(sourcePath) ?? [];
    values.push({ binding, sourcePath });
    grouped.set(sourcePath, values);
  }
  return grouped;
}

function folderDepth(path: string): number {
  return path.split("/").length;
}

function validFolderPaths(policy: TemplatePolicy, diagnostics: CensusDiagnostic[]): readonly TemplateFolderPath[] {
  const result: TemplateFolderPath[] = [];
  const seen = new Set<string>();
  for (const folder of policy.templateFolders) {
    const rawPath = folder.path;
    try {
      const normalized = normalizeTemplateFolderPath(rawPath);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
    } catch (error: unknown) {
      diagnostics.push(diagnostic("TEMPLATE_FOLDER_INVALID", `Selected template folder is invalid: ${errorMessage(error)}`, rawPath));
    }
  }
  return result.sort((left, right) => folderDepth(right) - folderDepth(left) || compare(left, right));
}

function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

interface BoundedSourceRead {
  readonly bytes?: Uint8Array;
  readonly oversized: boolean;
}

async function readBoundedSource(root: string, absolutePath: string): Promise<BoundedSourceRead> {
  const parent = dirname(absolutePath);
  const canonicalParent = await realpath(parent);
  if (!contained(root, canonicalParent)) {
    throw new Error(`TEMPLATE_SOURCE_UNSAFE: ${absolutePath} has a parent outside the vault`);
  }

  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error(`TEMPLATE_SOURCE_UNSAFE: ${absolutePath} is not a regular file`);
    }
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
    const canonicalParentAfter = await realpath(parent);
    if (!contained(root, canonicalParentAfter)) {
      throw new Error(`TEMPLATE_SOURCE_UNSAFE: ${absolutePath} parent escaped the vault while reading`);
    }
    const canonicalSourceAfter = await realpath(absolutePath);
    if (!contained(root, canonicalSourceAfter)) {
      throw new Error(`TEMPLATE_SOURCE_UNSAFE: ${absolutePath} escaped the vault while reading`);
    }
    if (total > MAX_TEMPLATE_SOURCE_BYTES || after.size > MAX_TEMPLATE_SOURCE_BYTES) return { oversized: true };
    if (after.size !== before.size || total !== after.size) {
      throw new Error(`TEMPLATE_SOURCE_READ_FAILED: ${absolutePath} changed while reading`);
    }
    return { bytes: buffer.subarray(0, total), oversized: false };
  } finally {
    await handle.close();
  }
}

async function scanFolder(
  root: string,
  folder: TemplateFolderPath,
  seenPhysicalPaths: Set<string>,
  entries: InternalEntry[],
  diagnostics: CensusDiagnostic[],
  scanFailures: Set<string>,
): Promise<void> {
  let verified: Awaited<ReturnType<typeof verifyTemplateFolderPath>>;
  try {
    verified = await verifyTemplateFolderPath(root, folder);
  } catch (error: unknown) {
    scanFailures.add(folder);
    diagnostics.push(diagnostic(
      sourceErrorCode(error),
      `Selected template folder cannot be verified: ${errorMessage(error)}`,
      folder,
    ));
    return;
  }
  // A selected folder that is absent is a verified empty scope. Keep it
  // distinct from a directory that vanished after the scan began: callers may
  // safely retire bindings under this scope, while a mid-scan race remains
  // unavailable evidence.
  if (verified.targetRealPath === null) return;
  let stat;
  try {
    stat = await lstat(verified.absolutePath);
  } catch (error: unknown) {
    scanFailures.add(folder);
    diagnostics.push(diagnostic("TEMPLATE_FOLDER_INVALID", `Selected template folder cannot be read: ${errorMessage(error)}`, folder));
    return;
  }
  if (!stat.isDirectory()) {
    scanFailures.add(folder);
    if (stat.isSymbolicLink()) {
      diagnostics.push(diagnostic("TEMPLATE_SOURCE_UNSAFE", "Selected template folder became a symlink while scanning", folder));
      return;
    }
    diagnostics.push(diagnostic("TEMPLATE_FOLDER_INVALID", "Selected template folder is not a directory", folder));
    return;
  }

  const visit = async (directory: string, depth: number): Promise<void> => {
    let directoryStat;
    try {
      directoryStat = await lstat(directory);
    } catch (error: unknown) {
      const scope = relative(root, directory).replaceAll("\\", "/");
      scanFailures.add(scope);
      diagnostics.push(diagnostic("TEMPLATE_SOURCE_READ_FAILED", `Template directory cannot be read: ${errorMessage(error)}`, scope));
      return;
    }
    if (directoryStat.isSymbolicLink()) {
      const scope = relative(root, directory).replaceAll("\\", "/");
      scanFailures.add(scope);
      diagnostics.push(diagnostic("TEMPLATE_SOURCE_UNSAFE", "Symlink directory is not a trusted template scope", scope));
      return;
    }
    if (!directoryStat.isDirectory()) {
      scanFailures.add(relative(root, directory).replaceAll("\\", "/"));
      return;
    }

    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      const scope = relative(root, directory).replaceAll("\\", "/");
      scanFailures.add(scope);
      diagnostics.push(diagnostic("TEMPLATE_SOURCE_READ_FAILED", `Template directory cannot be read: ${errorMessage(error)}`, scope));
      return;
    }
    children.sort((left, right) => compare(left.name, right.name));
    for (const child of children) {
      const absolutePath = join(directory, child.name);
      const rawPath = relative(root, absolutePath).replaceAll("\\", "/");
      if (child.isSymbolicLink()) {
        scanFailures.add(rawPath);
        diagnostics.push(diagnostic("TEMPLATE_SOURCE_UNSAFE", "Symlink template entry is skipped", rawPath));
        continue;
      }
      if (child.name.startsWith(".")) continue;
      if (child.isDirectory()) {
        if (child.name.endsWith(".md")) scanFailures.add(rawPath);
        if (depth >= MAX_TEMPLATE_SOURCE_DEPTH) {
          scanFailures.add(rawPath);
          diagnostics.push(diagnostic(
            "TEMPLATE_PROPOSAL_OVERSIZE",
            `Template source depth exceeds the limit of ${MAX_TEMPLATE_SOURCE_DEPTH}`,
            rawPath,
          ));
          continue;
        }
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!child.isFile()) {
        if (child.name.endsWith(".md")) scanFailures.add(rawPath);
        continue;
      }
      if (!child.name.endsWith(".md")) continue;
      if (seenPhysicalPaths.has(rawPath)) continue;
      seenPhysicalPaths.add(rawPath);

      let sourcePath: TemplateSourcePath;
      try {
        sourcePath = normalizeTemplateSourcePath(rawPath);
      } catch (error: unknown) {
        diagnostics.push(diagnostic("TEMPLATE_SOURCE_INVALID", `Template source is invalid: ${errorMessage(error)}`, rawPath));
        continue;
      }
      let verifiedSource;
      try {
        verifiedSource = await verifyTemplateSourcePath(root, sourcePath, { expected: "existing-file" });
      } catch (error: unknown) {
        diagnostics.push(diagnostic(sourceErrorCode(error), errorMessage(error), sourcePath));
        continue;
      }
      try {
        const bounded = await readBoundedSource(root, verifiedSource.absolutePath);
        if (bounded.oversized || bounded.bytes === undefined) {
          scanFailures.add(sourcePath);
          diagnostics.push(diagnostic(
            "TEMPLATE_PROPOSAL_OVERSIZE",
            `Template source exceeds the ${MAX_TEMPLATE_SOURCE_BYTES}-byte source limit`,
            sourcePath,
          ));
          continue;
        }
        const bytes = bounded.bytes;
        entries.push({
          sourcePath,
          bytes,
          signature: digest(bytes),
          bodySignature: bodySignature(bytes),
          rawPath,
          diagnostics: [],
          identity: "none",
        });
      } catch (error: unknown) {
        scanFailures.add(sourcePath);
        const message = errorMessage(error);
        const unsafe = message.startsWith("TEMPLATE_SOURCE_UNSAFE:")
          || (error instanceof Error && "code" in error && error.code === "ELOOP");
        diagnostics.push(diagnostic(
          unsafe ? "TEMPLATE_SOURCE_UNSAFE" : "TEMPLATE_SOURCE_READ_FAILED",
          `Template source cannot be read: ${message}`,
          sourcePath,
        ));
        continue;
      }
    }
  };

  await visit(verified.absolutePath, 0);
}

type SourcePresence = "verified-absent" | "present" | "unavailable";

function sourceWithin(path: string, scope: string): boolean {
  return path === scope || path.startsWith(`${scope}/`);
}

function sourceErrorCode(error: unknown): Extract<CensusDiagnosticCode, "TEMPLATE_SOURCE_UNSAFE" | "TEMPLATE_SOURCE_INVALID" | "TEMPLATE_SOURCE_READ_FAILED"> {
  const message = errorMessage(error);
  if (message.startsWith("TEMPLATE_SOURCE_UNSAFE:") || (error instanceof Error && "code" in error && error.code === "ELOOP")) {
    return "TEMPLATE_SOURCE_UNSAFE";
  }
  if (message.startsWith("TEMPLATE_SOURCE_INVALID:")) return "TEMPLATE_SOURCE_INVALID";
  return "TEMPLATE_SOURCE_READ_FAILED";
}

function verificationDiagnostic(path: string, error: unknown): CensusDiagnostic {
  const message = errorMessage(error);
  return diagnostic(
    sourceErrorCode(error),
    `Template source cannot be verified: ${message}`,
    path,
  );
}

/**
 * A path is considered absent only after a direct, bounded vault-path
 * verification. In particular, an omitted scan entry is never enough: a
 * failed directory walk, unsafe path, or unreadable source leaves the prior
 * identity unresolved rather than converting it into deletion evidence.
 */
async function sourcePresence(
  root: string,
  path: TemplateSourcePath,
  scanFailures: ReadonlySet<string>,
  diagnostics: CensusDiagnostic[],
): Promise<SourcePresence> {
  if ([...scanFailures].some(scope => sourceWithin(path, scope))) return "unavailable";
  try {
    const verified = await verifyTemplateSourcePath(root, path, { expected: "either" });
    if (verified.targetRealPath === null) return "verified-absent";
    const stat = await lstat(verified.absolutePath);
    if (stat.isSymbolicLink()) {
      const value = diagnostic("TEMPLATE_SOURCE_UNSAFE", "Template source became a symlink while being verified", path);
      if (!diagnostics.some(item => item.path === value.path && item.code === value.code)) diagnostics.push(value);
      return "unavailable";
    }
    if (!stat.isFile()) {
      const value = diagnostic("TEMPLATE_SOURCE_INVALID", "Template source is not a regular file", path);
      if (!diagnostics.some(item => item.path === value.path && item.code === value.code)) diagnostics.push(value);
      return "unavailable";
    }
    return "present";
  } catch (error: unknown) {
    const value = verificationDiagnostic(path, error);
    if (!diagnostics.some(item => item.path === value.path && item.code === value.code)) diagnostics.push(value);
    return "unavailable";
  }
}

function assignIdentities(
  entries: InternalEntry[],
  bindings: ReadonlyMap<string, readonly IndexedBinding[]>,
  priorByPath: ReadonlyMap<string, IndexedPrior>,
): void {
  for (const entry of entries) {
    const matchedBindings = bindings.get(entry.sourcePath) ?? [];
    if (matchedBindings.length > 1) {
      addDiagnostic(entry, diagnostic("TEMPLATE_SOURCE_DUPLICATE", "Multiple policy bindings claim this source path", entry.sourcePath));
      continue;
    }
    const binding = matchedBindings[0];
    if (binding !== undefined) {
      entry.templateId = binding.binding.templateId;
      entry.identity = "policy";
      returnIfKnownId(entry);
      continue;
    }
    const prior = priorByPath.get(entry.sourcePath);
    if (prior !== undefined) {
      entry.templateId = prior.prior.templateId;
      entry.identity = "prior";
      returnIfKnownId(entry);
      continue;
    }
    const candidate = proposedTemplateId(entry.sourcePath);
    if (candidate === null) {
      entry.identity = "none";
      addDiagnostic(entry, diagnostic("TEMPLATE_ID_INVALID", "File name yields no stable Unicode template id", entry.sourcePath));
      continue;
    }
    entry.templateId = candidate;
    entry.identity = "slug";
  }
}

function returnIfKnownId(entry: InternalEntry): void {
  // Existing policy/prior identifiers are authoritative and are deliberately not re-derived.
  if (entry.templateId === undefined || entry.templateId.length === 0) {
    entry.identity = "none";
    addDiagnostic(entry, diagnostic("TEMPLATE_ID_INVALID", "Authoritative template id is empty", entry.sourcePath));
  }
}

function markPathCollisions(entries: InternalEntry[]): void {
  const normalized = new Map<string, InternalEntry[]>();
  const caseFolded = new Map<string, InternalEntry[]>();
  for (const entry of entries) {
    const exact = normalized.get(entry.sourcePath) ?? [];
    exact.push(entry);
    normalized.set(entry.sourcePath, exact);
    const folded = caseFolded.get(pathCaseKey(entry.sourcePath)) ?? [];
    folded.push(entry);
    caseFolded.set(pathCaseKey(entry.sourcePath), folded);
  }
  for (const group of normalized.values()) {
    if (group.length < 2) continue;
    for (const entry of group) addDiagnostic(entry, diagnostic("TEMPLATE_SOURCE_DUPLICATE", "Multiple physical files normalize to this source path", entry.sourcePath));
  }
  for (const group of caseFolded.values()) {
    if (group.length < 2) continue;
    const paths = new Set(group.map(entry => entry.sourcePath));
    if (paths.size < 2) continue;
    for (const entry of group) addDiagnostic(entry, diagnostic("TEMPLATE_SOURCE_DUPLICATE", "Source path collides with another file by case", entry.sourcePath));
  }
}

function markIdCollisions(entries: InternalEntry[]): void {
  const grouped = new Map<string, InternalEntry[]>();
  for (const entry of entries) {
    if (entry.templateId === undefined) continue;
    const key = entry.templateId.normalize("NFC").toLocaleLowerCase("en-US");
    const group = grouped.get(key) ?? [];
    group.push(entry);
    grouped.set(key, group);
  }
  for (const group of grouped.values()) {
    if (group.length < 2) continue;
    for (const entry of group) addDiagnostic(entry, diagnostic("TEMPLATE_ID_DUPLICATE", "Template id is claimed by more than one source", entry.sourcePath, entry.templateId));
  }
}

function publicEntry(entry: InternalEntry): CensusEntry {
  return {
    sourcePath: entry.sourcePath,
    bytes: entry.bytes,
    signature: entry.signature,
    ...(entry.templateId === undefined ? {} : { templateId: entry.templateId }),
    diagnostics: [...entry.diagnostics].sort((left, right) => compare(left.code, right.code) || compare(left.message, right.message)),
  };
}

function renameDiff(
  oldEntry: DeletedCandidate,
  current: InternalEntry,
  strategy: CensusRenameStrategy,
  automatic: boolean,
): CensusDiff {
  return {
    kind: "renamed",
    sourcePath: current.sourcePath,
    oldSourcePath: oldEntry.sourcePath,
    newSourcePath: current.sourcePath,
    templateId: current.templateId,
    automatic,
    confirmationRequired: !automatic,
    strategy,
  };
}

function diffSort(left: CensusDiff, right: CensusDiff): number {
  return compare(left.sourcePath, right.sourcePath)
    || compare(left.oldSourcePath ?? "", right.oldSourcePath ?? "")
    || compare(left.kind, right.kind);
}

function buildDiffs(
  entries: InternalEntry[],
  prior: readonly IndexedPrior[],
  verifiedAbsent: ReadonlySet<string>,
  policyMissing: readonly MissingBinding[],
): CensusDiff[] {
  const priorByPath = new Map(prior.map(entry => [entry.sourcePath, entry]));
  const matchedPrior = new Set<string>();
  const handledCurrent = new Set<InternalEntry>();
  const diffs: CensusDiff[] = [];

  for (const entry of entries) {
    const previous = priorByPath.get(entry.sourcePath);
    if (previous === undefined) continue;
    matchedPrior.add(previous.sourcePath);
    handledCurrent.add(entry);
    if (entry.signature !== previous.prior.signature) {
      diffs.push({
        kind: "edited",
        sourcePath: entry.sourcePath,
        ...(entry.templateId === undefined ? {} : { templateId: entry.templateId }),
        automatic: true,
        confirmationRequired: false,
      });
    }
  }

  const added = entries.filter(entry => !handledCurrent.has(entry));
  const policyByPath = new Map(policyMissing.map(value => [value.sourcePath, value]));
  const priorCandidates: DeletedCandidate[] = prior
    .filter(value => !matchedPrior.has(value.sourcePath) && verifiedAbsent.has(value.sourcePath))
    .map(value => {
      const policy = policyByPath.get(value.sourcePath);
      return policy?.signatureVerified === true ? policy : value;
    });
  const deleted: DeletedCandidate[] = [
    ...priorCandidates,
    ...policyMissing.filter(value => !priorByPath.has(value.sourcePath) && verifiedAbsent.has(value.sourcePath)),
  ];
  const availableAdded = new Set(added);
  const availableDeleted = new Set(deleted);

  const bySignature = new Map<string, { readonly current: InternalEntry[]; readonly previous: DeletedCandidate[] }>();
  for (const entry of added) {
    const group = bySignature.get(entry.signature) ?? { current: [], previous: [] };
    group.current.push(entry);
    bySignature.set(entry.signature, group);
  }
  for (const previous of deleted) {
    const signature = deletedSignature(previous);
    if (signature === undefined || !deletedSignatureVerified(previous)) continue;
    const group = bySignature.get(signature) ?? { current: [], previous: [] };
    group.previous.push(previous);
    bySignature.set(signature, group);
  }
  for (const group of bySignature.values()) {
    if (group.current.length === 1 && group.previous.length === 1 && deletedSignatureVerified(group.previous[0]!)) {
      const current = group.current[0]!;
      const previous = group.previous[0]!;
      if (current.diagnostics.length === 0) {
        if (current.identity !== "policy") current.templateId = deletedTemplateId(previous);
        availableAdded.delete(current);
        availableDeleted.delete(previous);
        matchedPrior.add(previous.sourcePath);
        handledCurrent.add(current);
        diffs.push(renameDiff(previous, current, "identical-bytes", true));
      }
      continue;
    }
    if (group.current.length > 0 && group.previous.length > 0) {
      for (const current of group.current) {
        for (const previous of group.previous) {
          diffs.push({
            ...renameDiff(previous, current, "identical-bytes", false),
            automatic: false,
            confirmationRequired: true,
            ...(current.templateId === undefined ? {} : { templateId: current.templateId }),
          });
        }
      }
    }
  }

  const byBody = new Map<string, { readonly current: InternalEntry[]; readonly previous: DeletedCandidate[] }>();
  for (const entry of availableAdded) {
    if (entry.bodySignature === undefined) continue;
    const group = byBody.get(entry.bodySignature) ?? { current: [], previous: [] };
    group.current.push(entry);
    byBody.set(entry.bodySignature, group);
  }
  for (const previous of availableDeleted) {
    const body = deletedBodySignature(previous);
    if (body === undefined) continue;
    const group = byBody.get(body) ?? { current: [], previous: [] };
    group.previous.push(previous);
    byBody.set(body, group);
  }
  for (const group of byBody.values()) {
    if (group.current.length === 1 && group.previous.length === 1) {
      const current = group.current[0]!;
      const previous = group.previous[0]!;
      availableAdded.delete(current);
      availableDeleted.delete(previous);
      diffs.push(renameDiff(previous, current, "body-signature", false));
      continue;
    }
    if (group.current.length > 0 && group.previous.length > 0) {
      for (const current of group.current) {
        for (const previous of group.previous) {
          diffs.push({
            ...renameDiff(previous, current, "body-signature", false),
            automatic: false,
            confirmationRequired: true,
          });
        }
      }
    }
  }

  if (availableAdded.size === 1 && availableDeleted.size === 1) {
    const current = [...availableAdded][0]!;
    const previous = [...availableDeleted][0]!;
    availableAdded.delete(current);
    availableDeleted.delete(previous);
    diffs.push(renameDiff(previous, current, "lone-delete-add", false));
  }

  for (const entry of availableAdded) {
    diffs.push({
      kind: "added",
      sourcePath: entry.sourcePath,
      ...(entry.templateId === undefined ? {} : { templateId: entry.templateId }),
      automatic: false,
      confirmationRequired: false,
    });
  }
  for (const previous of availableDeleted) {
    diffs.push({
      kind: "deleted",
      sourcePath: previous.sourcePath,
      templateId: deletedTemplateId(previous),
      automatic: false,
      confirmationRequired: false,
    });
  }

  return diffs.sort(diffSort);
}

function censusDigest(entries: readonly CensusEntry[], diffs: readonly CensusDiff[], diagnostics: readonly CensusDiagnostic[]): Digest {
  const preimage = JSON.stringify({
    version: 1,
    entries: entries.map(entry => ({
      sourcePath: entry.sourcePath,
      signature: entry.signature,
      templateId: entry.templateId ?? null,
      diagnostics: entry.diagnostics,
    })),
    diffs,
    diagnostics,
  });
  return digest(encoder.encode(preimage));
}

/**
 * Recursively discovers Markdown sources in exactly the folders selected by the
 * current policy. This function only reads vault bytes; it never creates or
 * modifies OMS controls, indexes, or source files.
 */
export async function templateCensus(vault: string, policy: TemplatePolicy, prior: readonly CensusPriorEntry[] = []): Promise<CensusResult> {
  const root = await realpath(vault);
  const diagnostics: CensusDiagnostic[] = [];
  const folders = validFolderPaths(policy, diagnostics);
  const bindings = indexedBindings(policy, diagnostics);
  const indexedPriorEntries = canonicalPrior(prior, diagnostics);
  const priorByPath = new Map(indexedPriorEntries.map(value => [value.sourcePath, value]));
  const entries: InternalEntry[] = [];
  const seenPhysicalPaths = new Set<string>();
  const scanFailures = new Set<string>();

  for (const folder of folders) {
    try {
      await scanFolder(root, folder, seenPhysicalPaths, entries, diagnostics, scanFailures);
    } catch (error: unknown) {
      diagnostics.push(diagnostic("TEMPLATE_FOLDER_INVALID", `Selected template folder cannot be read: ${errorMessage(error)}`, folder));
    }
  }

  entries.sort((left, right) => compare(left.sourcePath, right.sourcePath) || compare(left.rawPath, right.rawPath));
  markPathCollisions(entries);
  assignIdentities(entries, bindings, priorByPath);
  markIdCollisions(entries);

  const pathsToVerify = new Set<string>(indexedPriorEntries.map(value => value.sourcePath));
  for (const group of bindings.values()) {
    for (const value of group) pathsToVerify.add(value.sourcePath);
  }
  const presence = new Map<string, SourcePresence>();
  for (const path of [...pathsToVerify].sort(compare)) {
    const normalized = normalizeTemplateSourcePath(path);
    const scopedToScan = folders.some(folder => sourceWithin(normalized, folder));
    if (!scopedToScan && !indexedPriorEntries.some(value => value.sourcePath === normalized)) continue;
    presence.set(normalized, await sourcePresence(root, normalized, scanFailures, diagnostics));
  }
  const verifiedAbsent = new Set(
    [...presence].flatMap(([path, state]) => state === "verified-absent" ? [path] : []),
  );
  // Policy-owned approval is independent evidence. It remains available when
  // a projection is missing or its path descriptor is untrusted; without a
  // stamp we deliberately leave the signature undefined.
  const policyMissing: MissingBinding[] = [];
  for (const group of bindings.values()) {
    for (const value of group) {
      if (presence.get(value.sourcePath) !== "verified-absent") continue;
      const body = value.binding.approvedBodySignature ?? value.binding.content?.bodySignature;
      policyMissing.push({
        sourcePath: value.sourcePath,
        templateId: value.binding.templateId,
        ...(value.binding.approvedSourceSignature === undefined ? {} : { signature: value.binding.approvedSourceSignature }),
        signatureVerified: value.binding.approvedSourceSignature !== undefined,
        ...(body === undefined ? {} : { bodySignature: body }),
      });
    }
  }
  const diffs = buildDiffs(entries, indexedPriorEntries, verifiedAbsent, policyMissing);
  const publicEntries = entries.map(publicEntry).sort((left, right) => compare(left.sourcePath, right.sourcePath));
  const allDiagnostics = [
    ...diagnostics,
    ...entries.flatMap(entry => entry.diagnostics),
  ].sort((left, right) => compare(left.path ?? "", right.path ?? "") || compare(left.code, right.code) || compare(left.message, right.message));
  return {
    entries: publicEntries,
    diffs,
    diagnostics: allDiagnostics,
    digest: censusDigest(publicEntries, diffs, allDiagnostics),
  };
}
