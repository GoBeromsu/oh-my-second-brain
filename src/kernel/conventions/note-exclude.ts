/**
 * Read-only source exclusion inventory for vault walkers.
 *
 * Settings roots, the sealed contract, and external template settings are
 * independent channels. A malformed channel cannot erase a valid sibling.
 * The sealed contract contributes its template sources and every folder
 * marked `searchExclude`; an unsealed vault contributes nothing from it.
 * `complete` means every channel was read and its declared facts classified;
 * it is not proof that every possible source in the vault was discovered.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { VaultContract } from "../contract/types.js";
import { resolveSealState } from "../contract/vault-id.js";
import { loadConfiguredTemplatePaths } from "./template-paths.js";
import { normalizeFolderPath, normalizeTemplateSourcePath, verifyVaultPath } from "../vault/paths.js";
import { readVaultSettings, SETTINGS_PATH, VaultSettingsError } from "../vault/settings.js";
import { compareCodePoints, hashCanonical, type Digest } from "./canonical.js";

/**
 * Default audit exemptions. Built-in lexical exclusions stay independent of
 * the sealed contract and of whether a physical default Markdown exists.
 */
export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  "**/.deploy-staging/**",
  "**/*.template.md",
  "**/SKILL.md",
  ".obsidian/**",
  ".trash/**",
  ".oms/**",
  "_attachments/**",
];

/** Diagnostic label for the sealed folder contract. */
const FOLDERS_PATH = "folders.json";
/** Diagnostic label for the sealed template sources. */
const TEMPLATES_PATH = "templates";
const EXTERNAL_TEMPLATES_PATH = ".obsidian";
const INVENTORY_DOMAIN = "oms.source-exclusion-inventory.v6";

export interface SourceExclusionDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface SourceExclusionInventory {
  readonly digest: Digest;
  readonly roots: readonly string[];
  readonly paths: readonly string[];
  readonly globs: readonly string[];
  readonly complete: boolean;
  readonly diagnostics: readonly SourceExclusionDiagnostic[];
}

function failure(code: string, evidence: string): never {
  throw new Error(`${code}: ${evidence}`);
}

function diagnostic(code: string, controlPath: string, message: string): SourceExclusionDiagnostic {
  return { code, path: controlPath, message };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const compareText = compareCodePoints;

function lexicalPath(notePath: string): string {
  const lexical = notePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (
    lexical === ""
    || lexical.startsWith("/")
    || /^[A-Za-z]:/.test(lexical)
    || lexical.split("/").some(segment => segment === "" || segment === "." || segment === "..")
  ) {
    failure("MANAGED_SOURCE_RESOLUTION_FAILED", `unsafe path ${notePath}`);
  }
  return lexical;
}

function declaredSourcePath(sourcePath: string): string | null {
  const lexical = sourcePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (lexical.normalize("NFC") !== lexical) return null;
  try {
    if (normalizeTemplateSourcePath(lexical) !== lexical) return null;
  } catch {
    return null;
  }
  return lexical;
}

function globToRegExp(glob: string): RegExp {
  const placeholder = "\u0000";
  const escaped = glob.replace(/\*\*/g, placeholder).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, "[^/]*").split(placeholder).join(".*")}$`);
}

function nodeCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

function aliasDiagnostic(sourcePath: string, error: unknown): SourceExclusionDiagnostic {
  const text = message(error);
  const unsafe = error instanceof TypeError && text.startsWith("TEMPLATE_SOURCE_UNSAFE:");
  return diagnostic(
    unsafe ? "SOURCE_ALIAS_UNSAFE" : "SOURCE_ALIAS_UNAVAILABLE",
    TEMPLATES_PATH,
    unsafe
      ? `${sourcePath} resolves outside the vault; lexical exclusion remains and its alias is not followed: ${text}`
      : `${sourcePath} cannot provide alias evidence: ${text}`,
  );
}

/** True when `notePath` matches at least one of `globs`. */
export function matchesAnyGlob(notePath: string, globs: readonly string[]): boolean {
  return globs.some(glob => globToRegExp(glob).test(notePath));
}

/** Explicit exclusion declarations; runtime readers stay JSON-only. */
export function noteExcludeMatcherFromGlobs(globs: readonly string[]): (notePath: string) => boolean {
  const matchers = [...DEFAULT_EXCLUDE_GLOBS, ...globs].map(globToRegExp);
  return (notePath: string) => matchers.some(matcher => matcher.test(lexicalPath(notePath)));
}

async function confinedSource(
  vault: string,
  sourcePath: string,
): Promise<{ readonly path: string | null; readonly diagnostic: SourceExclusionDiagnostic | null }> {
  const lexical = declaredSourcePath(sourcePath);
  if (lexical === null) {
    return { path: null, diagnostic: diagnostic("SOURCE_REGISTRATION_NONCANONICAL", TEMPLATES_PATH, `${sourcePath} is not a canonical confined source declaration`) };
  }
  try {
    const verified = await verifyVaultPath(vault, normalizeTemplateSourcePath(lexical), { expected: "either" });
    if (verified.targetRealPath !== null) {
      const relative = path.relative(verified.vaultRoot, verified.targetRealPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return { path: lexical, diagnostic: diagnostic("SOURCE_ALIAS_UNSAFE", TEMPLATES_PATH, `${lexical} resolves outside the vault; lexical exclusion remains and its alias is not followed`) };
      }
    }
    let cursor = verified.vaultRoot;
    for (const segment of lexical.split("/")) {
      cursor = path.resolve(cursor, segment);
      let stat;
      try {
        stat = await lstat(cursor);
      } catch (error) {
        if (nodeCode(error) === "ENOENT") return { path: lexical, diagnostic: null };
        return { path: lexical, diagnostic: diagnostic("SOURCE_ALIAS_UNAVAILABLE", TEMPLATES_PATH, `${lexical} cannot provide alias evidence: ${error instanceof Error ? error.message : String(error)}`) };
      }
      if (stat.isSymbolicLink() || (cursor === verified.absolutePath && (!stat.isFile() || stat.nlink !== 1))) {
        return { path: lexical, diagnostic: diagnostic("SOURCE_ALIAS_UNSAFE", TEMPLATES_PATH, `${lexical} is not a regular confined file; lexical exclusion remains and its alias is not followed`) };
      }
    }
    return { path: lexical, diagnostic: null };
  } catch (error) {
    return { path: lexical, diagnostic: aliasDiagnostic(lexical, error) };
  }
}

async function acceptSources(
  vault: string,
  controlPath: string,
  candidates: readonly { readonly id: string; readonly path: string }[],
): Promise<{ readonly paths: readonly string[]; readonly diagnostics: readonly SourceExclusionDiagnostic[] }> {
  const paths: string[] = [];
  const diagnostics: SourceExclusionDiagnostic[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const confined = await confinedSource(vault, candidate.path);
    if (confined.path === null) {
      diagnostics.push(confined.diagnostic ?? diagnostic("SOURCE_REGISTRATION_UNSAFE", controlPath, `${candidate.id} source ${candidate.path} is not a confined original source`));
      continue;
    }
    if (confined.diagnostic !== null) diagnostics.push(confined.diagnostic);
    if (seen.has(confined.path)) {
      diagnostics.push(diagnostic("SOURCE_REGISTRATION_DUPLICATE", controlPath, `${confined.path} is registered more than once`));
      continue;
    }
    seen.add(confined.path);
    paths.push(confined.path);
  }
  paths.sort((left, right) => compareText(left, right));
  return { paths, diagnostics };
}

/**
 * Authoritative Obsidian and Templater template settings are a separate
 * channel. A configured folder excludes itself and its descendants; a
 * configured file excludes only that file.
 */
async function readExternalTemplateGlobs(
  vault: string,
): Promise<{ readonly globs: readonly string[]; readonly diagnostic: SourceExclusionDiagnostic | null; readonly classification: string }> {
  let configured;
  try {
    configured = await loadConfiguredTemplatePaths(vault);
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return { globs: [], diagnostic: null, classification: "absent" };
    return {
      globs: [],
      diagnostic: diagnostic(
        "SOURCE_EXTERNAL_TEMPLATES_UNREADABLE",
        EXTERNAL_TEMPLATES_PATH,
        `external template settings: ${error instanceof Error ? error.message : String(error)}`,
      ),
      classification: "invalid",
    };
  }
  return {
    globs: configured.flatMap(entry => entry.kind === "folder" ? [entry.path, `${entry.path}/**`] : [entry.path]),
    diagnostic: null,
    classification: configured.length === 0 ? "absent" : "valid",
  };
}

/**
 * Declared exclusion channels that a walker cannot silently skip. An unreadable
 * seal or unreadable external template settings would hide explicit
 * declarations, so enforcement fails loudly instead of scanning unfiltered.
 */
function lexicalBlocker(inventory: SourceExclusionInventory): SourceExclusionDiagnostic | null {
  return inventory.diagnostics.find(item => item.path === FOLDERS_PATH || item.path === EXTERNAL_TEMPLATES_PATH) ?? null;
}

function assertLexicalChannels(inventory: SourceExclusionInventory): void {
  const blocker = lexicalBlocker(inventory);
  if (blocker !== null) failure("NOTE_EXCLUSION_RESOLUTION_FAILED", `${blocker.path}: ${blocker.message}`);
}

async function readRoots(vault: string): Promise<{ readonly roots: readonly string[]; readonly diagnostic: SourceExclusionDiagnostic | null; readonly classification: string }> {
  let templateFolder: string | undefined;
  try {
    const settings = await readVaultSettings(vault);
    if (settings === null) return { roots: [], diagnostic: null, classification: "absent" };
    templateFolder = settings.templateFolder;
  } catch (error: unknown) {
    const code = error instanceof VaultSettingsError ? error.code : "SOURCE_CONTROL_UNREADABLE";
    return { roots: [], diagnostic: diagnostic(code, SETTINGS_PATH, message(error)), classification: "invalid" };
  }
  if (templateFolder === undefined) return { roots: [], diagnostic: null, classification: "valid" };
  try {
    if (normalizeFolderPath(templateFolder) !== templateFolder) throw new TypeError("template root is not canonical");
    const verified = await verifyVaultPath(vault, templateFolder, { expected: "either" });
    return { roots: [verified.vaultRelativePath], diagnostic: null, classification: "valid" };
  } catch {
    return { roots: [], diagnostic: diagnostic("SOURCE_ROOT_UNSAFE", SETTINGS_PATH, `template root ${templateFolder} is not a confined vault folder`), classification: "invalid" };
  }
}

/**
 * Sealed template sources and `searchExclude` folders. A missing vault or an
 * unsealed vault declares nothing; an unreadable seal is a blocker because it
 * would otherwise hide declared exclusions.
 */
async function readSealed(vault: string): Promise<{
  readonly paths: readonly string[];
  readonly globs: readonly string[];
  readonly diagnostics: readonly SourceExclusionDiagnostic[];
  readonly classification: string;
}> {
  let contract: VaultContract | null = null;
  try {
    const view = (await resolveSealState(vault)).view;
    if (view.state === "unreadable") {
      return { paths: [], globs: [], diagnostics: [diagnostic("SOURCE_CONTRACT_UNREADABLE", FOLDERS_PATH, "the sealed contract is unreadable; run oms contract doctor")], classification: "unreadable" };
    }
    if (view.state === "sealed") contract = view.contract;
  } catch (error: unknown) {
    const code = nodeCode(error);
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return { paths: [], globs: [], diagnostics: [diagnostic("SOURCE_CONTRACT_UNREADABLE", FOLDERS_PATH, `${code ?? "CONTRACT_READ_FAILED"}; run oms contract doctor`)], classification: "unreadable" };
    }
  }
  if (contract === null) return { paths: [], globs: [], diagnostics: [], classification: "open" };
  const globs = Object.entries(contract.folders ?? {})
    .filter(([, folder]) => folder.searchExclude)
    .map(([folder]) => folder)
    .sort(compareText)
    .flatMap(folder => [folder, `${folder}/**`]);
  const candidates = Object.entries(contract.templates)
    .map(([id, template]) => ({ id, path: template.source }))
    .sort((left, right) => compareText(left.id, right.id));
  const accepted = await acceptSources(vault, TEMPLATES_PATH, candidates);
  return { paths: accepted.paths, globs, diagnostics: accepted.diagnostics, classification: "sealed" };
}

/** Reads settings, the sealed contract, and external template settings independently. It creates no vault state. */
export async function readSourceExclusions(vault: string): Promise<SourceExclusionInventory> {
  const [roots, sealed, external] = await Promise.all([readRoots(vault), readSealed(vault), readExternalTemplateGlobs(vault)]);
  const diagnostics = [roots.diagnostic, ...sealed.diagnostics, external.diagnostic]
    .filter((item): item is SourceExclusionDiagnostic => item !== null);
  diagnostics.sort((left, right) => compareText(left.path, right.path) || compareText(left.code, right.code) || compareText(left.message, right.message));
  const declared = [...sealed.globs, ...external.globs];
  return {
    digest: hashCanonical(INVENTORY_DOMAIN, {
      roots: roots.roots,
      paths: sealed.paths,
      globs: declared,
      diagnostics: diagnostics.map(item => ({ code: item.code, path: item.path, message: item.message })),
      classifications: [roots.classification, sealed.classification, external.classification],
    }),
    roots: roots.roots,
    paths: sealed.paths,
    globs: [...DEFAULT_EXCLUDE_GLOBS, ...declared],
    complete: diagnostics.length === 0,
    diagnostics,
  };
}

async function lexicalSources(vault: string): Promise<ReadonlySet<string>> {
  return new Set((await readSourceExclusions(vault)).paths);
}

/** Exact original source paths without requiring a derived projection or active contract. */
export async function managedSourcePathSet(vaultRoot: string): Promise<ReadonlySet<string>> {
  return lexicalSources(path.resolve(vaultRoot));
}

function underRoot(notePath: string, root: string): boolean {
  return notePath === root || notePath.startsWith(`${root}/`);
}

function lexicallyExcluded(inventory: SourceExclusionInventory, notePath: string, includeSources: boolean): boolean {
  const lexical = lexicalPath(notePath);
  if (inventory.roots.some(root => underRoot(lexical, root))) return true;
  if (inventory.globs.some(glob => globToRegExp(glob).test(lexical))) return true;
  return includeSources && inventory.paths.includes(lexical);
}

/**
 * Lexical predicate over vault-relative note paths. Settings roots, source
 * paths, and globs are reread together; a supplied source list cannot erase
 * roots or globs, and an empty source list is not replace-all authority.
 */
export async function excludedNoteMatcher(
  vaultRoot: string,
  includeManagedSources = true,
): Promise<(notePath: string) => boolean> {
  const inventory = await readSourceExclusions(vaultRoot);
  assertLexicalChannels(inventory);
  return (notePath: string) => lexicallyExcluded(inventory, notePath, includeManagedSources);
}

async function resolveAlias(root: string, relativePath: string): Promise<string | null> {
  let lexical: string;
  try {
    lexical = lexicalPath(relativePath);
  } catch {
    return null;
  }
  let cursor = root;
  for (const segment of lexical.split("/")) {
    cursor = path.resolve(cursor, segment);
    let stat;
    try {
      stat = await lstat(cursor);
    } catch {
      return null;
    }
    if (!stat.isSymbolicLink()) continue;
    const linkPath = path.relative(root, cursor);
    if (linkPath.startsWith("..") || path.isAbsolute(linkPath)) return null;
  }
  const absolute = path.resolve(root, ...lexical.split("/"));
  let stat;
  try {
    stat = await lstat(absolute);
  } catch {
    return null;
  }
  if (!stat.isSymbolicLink() && stat.nlink !== 1) return null;
  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch {
    return null;
  }
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

/**
 * Matches lexical roots, globs, and known source paths, then confined aliases
 * of files that can be resolved safely. Alias enrichment never erases a known
 * lexical exclusion or aborts an ordinary note scan.
 */
export async function managedSourceExclusionMatcher(
  vaultRoot: string,
  sourcePaths?: readonly string[],
): Promise<(notePath: string) => Promise<boolean>> {
  const root = await realpath(vaultRoot);
  const inventory = await readSourceExclusions(root);
  assertLexicalChannels(inventory);
  const lexical = new Set<string>();
  for (const sourcePath of [...inventory.paths, ...(sourcePaths ?? [])]) {
    try {
      lexical.add(lexicalPath(sourcePath));
    } catch {
      // An unsafe supplied path adds no alias evidence and erases nothing.
    }
  }
  const resolved = new Set<string>();
  for (const sourcePath of lexical) {
    const actual = await resolveAlias(root, sourcePath);
    if (actual !== null) resolved.add(actual);
  }
  return async (notePath: string) => {
    try {
      if (lexicallyExcluded(inventory, notePath, false) || lexical.has(lexicalPath(notePath))) return true;
    } catch {
      return false;
    }
    const actual = await resolveAlias(root, notePath);
    return actual !== null && resolved.has(actual);
  };
}
