/**
 * Read-only source exclusion inventory for vault walkers.
 *
 * Settings roots, original source registrations, and user taxonomy exclusions
 * are independent channels. A malformed channel cannot erase a valid sibling.
 * `complete` means every control was read and its declared facts classified;
 * it is not proof that every possible source in the vault was discovered.
 *
 * Current matcher names remain the live entry points. Passing a whole
 * inventory and renaming them belongs to the consumer cutover.
 */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { digestBytes, hashCanonical } from "../templates/canonical.js";
import { parseLegacyJson } from "../templates/legacy-json.js";
import { normalizeTemplateControlPath, normalizeTemplateFolderPath, normalizeTemplateSourcePath, verifyTemplateControlPath, verifyTemplateFolderPath, verifyTemplateSourcePath } from "../templates/paths.js";
import { parseContractPolicyV5 } from "../templates/contract-v5.js";
import { loadConfiguredTemplatePaths } from "../templates/hints.js";
import type { Digest } from "../templates/types.js";
import { parseVaultSettings, VaultSettingsError } from "../templates/vault-settings.js";

/**
 * Default audit exemptions. Built-in lexical exclusions stay independent of
 * user taxonomy and of whether a physical default Markdown exists.
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

const SETTINGS_PATH = ".oms/settings.json";
const POLICY_PATH = ".oms/template-policy.json";
const TAXONOMY_PATH = ".oms/taxonomy.json";
const EXTERNAL_TEMPLATES_PATH = ".obsidian";
const MAX_CONTROL_BYTES = 8 * 1024 * 1024;
const INVENTORY_DOMAIN = "oms.source-exclusion-inventory.v5";

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

interface ControlRead {
  readonly state: "absent" | "bytes" | "unreadable";
  readonly bytes: Uint8Array | null;
  readonly diagnostic: SourceExclusionDiagnostic | null;
}

function failure(code: string, evidence: string): never {
  throw new Error(`${code}: ${evidence}`);
}

function diagnostic(code: string, controlPath: string, message: string): SourceExclusionDiagnostic {
  return { code, path: controlPath, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0) ?? 0);
  const b = Array.from(right, character => character.codePointAt(0) ?? 0);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

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
  if (lexical.split("/").some(segment => segment === "" || segment === "." || segment === "..")) return null;
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
  const message = error instanceof Error ? error.message : String(error);
  const unsafe = error instanceof TypeError && message.startsWith("TEMPLATE_SOURCE_UNSAFE:");
  return diagnostic(
    unsafe ? "SOURCE_ALIAS_UNSAFE" : "SOURCE_ALIAS_UNAVAILABLE",
    POLICY_PATH,
    unsafe
      ? `${sourcePath} resolves outside the vault; lexical exclusion remains and its alias is not followed: ${message}`
      : `${sourcePath} cannot provide alias evidence: ${message}`,
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

async function readControl(vault: string, controlPath: string): Promise<ControlRead> {
  let verified;
  try {
    verified = await verifyTemplateControlPath(vault, normalizeTemplateControlPath(controlPath), { expected: "either" });
  } catch (error) {
    return {
      state: "unreadable",
      bytes: null,
      diagnostic: diagnostic("SOURCE_CONTROL_UNREADABLE", controlPath, error instanceof Error ? error.message : String(error)),
    };
  }
  if (verified.targetRealPath === null) return { state: "absent", bytes: null, diagnostic: null };
  let handle;
  try {
    handle = await open(verified.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = nodeCode(error);
    if (code === "ENOENT") return { state: "absent", bytes: null, diagnostic: null };
    return {
      state: "unreadable",
      bytes: null,
      diagnostic: diagnostic("SOURCE_CONTROL_UNREADABLE", controlPath, error instanceof Error ? error.message : String(error)),
    };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { state: "unreadable", bytes: null, diagnostic: diagnostic("SOURCE_CONTROL_UNSAFE", controlPath, "control is not a regular file") };
    }
    if (stat.nlink !== 1) {
      return { state: "unreadable", bytes: null, diagnostic: diagnostic("SOURCE_CONTROL_UNSAFE", controlPath, "hardlinked control is not followed") };
    }
    if (stat.size > MAX_CONTROL_BYTES) {
      return { state: "unreadable", bytes: null, diagnostic: diagnostic("SOURCE_CONTROL_UNREADABLE", controlPath, "control exceeds the read limit") };
    }
    return { state: "bytes", bytes: await handle.readFile(), diagnostic: null };
  } catch (error) {
    return {
      state: "unreadable",
      bytes: null,
      diagnostic: diagnostic("SOURCE_CONTROL_UNREADABLE", controlPath, error instanceof Error ? error.message : String(error)),
    };
  } finally {
    await handle.close();
  }
}

function decodeControl(read: ControlRead, controlPath: string): { readonly text: string | null; readonly diagnostic: SourceExclusionDiagnostic | null } {
  if (read.diagnostic !== null || read.bytes === null) return { text: null, diagnostic: read.diagnostic };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(read.bytes), diagnostic: null };
  } catch {
    return { text: null, diagnostic: diagnostic("SOURCE_CONTROL_INVALID", controlPath, "control is not strict UTF-8") };
  }
}

function uniqueValue(text: string, controlPath: string): { readonly value: unknown | null; readonly diagnostic: SourceExclusionDiagnostic | null } {
  let parsed;
  try {
    parsed = parseLegacyJson(text);
  } catch (error) {
    return { value: null, diagnostic: diagnostic("SOURCE_CONTROL_INVALID", controlPath, error instanceof Error ? error.message : "control is not JSON") };
  }
  if (parsed.members !== "unique") {
    return {
      value: null,
      diagnostic: diagnostic("SOURCE_CONTROL_AMBIGUOUS", controlPath, "duplicate or uninspectable JSON cannot authorize declarations"),
    };
  }
  return { value: parsed.value, diagnostic: null };
}

async function canonicalRoot(vault: string, root: string): Promise<string | null> {
  try {
    if (normalizeTemplateFolderPath(root) !== root) return null;
    const verified = await verifyTemplateFolderPath(vault, normalizeTemplateFolderPath(root));
    return verified.vaultRelativePath;
  } catch {
    return null;
  }
}

async function readRoots(vault: string, read: ControlRead): Promise<{ readonly roots: readonly string[]; readonly diagnostic: SourceExclusionDiagnostic | null; readonly classification: string }> {
  if (read.state === "absent") return { roots: [], diagnostic: null, classification: "absent" };
  const decoded = decodeControl(read, SETTINGS_PATH);
  if (decoded.diagnostic !== null || decoded.text === null) return { roots: [], diagnostic: decoded.diagnostic, classification: "unreadable" };
  const unique = uniqueValue(decoded.text, SETTINGS_PATH);
  if (unique.diagnostic !== null) return { roots: [], diagnostic: unique.diagnostic, classification: "invalid" };
  try {
    const settings = parseVaultSettings(decoded.text);
    const roots: string[] = [];
    for (const root of settings.templateRoots) {
      const canonical = await canonicalRoot(vault, root);
      if (canonical === null) {
        return { roots: [], diagnostic: diagnostic("SOURCE_ROOT_UNSAFE", SETTINGS_PATH, `template root ${root} is not a confined vault folder`), classification: "invalid" };
      }
      roots.push(canonical);
    }
    return { roots, diagnostic: null, classification: "valid" };
  } catch (error) {
    const code = error instanceof VaultSettingsError ? error.code : "VAULT_SETTINGS_INVALID";
    return { roots: [], diagnostic: diagnostic(code, SETTINGS_PATH, error instanceof Error ? error.message : "settings are invalid"), classification: "invalid" };
  }
}

/**
 * Only a nested `source.path` is a source declaration. The retired flat
 * `sourcePath` key is historical prose and never invents an exclusion.
 */
function literalSource(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.source) && typeof value.source.path === "string") return value.source.path;
  return null;
}

async function confinedSource(
  vault: string,
  sourcePath: string,
): Promise<{ readonly path: string | null; readonly diagnostic: SourceExclusionDiagnostic | null }> {
  const lexical = declaredSourcePath(sourcePath);
  if (lexical === null) {
    return { path: null, diagnostic: diagnostic("SOURCE_REGISTRATION_NONCANONICAL", POLICY_PATH, `${sourcePath} is not a canonical confined source declaration`) };
  }
  try {
    const verified = await verifyTemplateSourcePath(vault, normalizeTemplateSourcePath(lexical), { expected: "either" });
    if (verified.targetRealPath !== null) {
      const relative = path.relative(verified.vaultRoot, verified.targetRealPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return { path: lexical, diagnostic: diagnostic("SOURCE_ALIAS_UNSAFE", POLICY_PATH, `${lexical} resolves outside the vault; lexical exclusion remains and its alias is not followed`) };
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
        return { path: lexical, diagnostic: diagnostic("SOURCE_ALIAS_UNAVAILABLE", POLICY_PATH, `${lexical} cannot provide alias evidence: ${error instanceof Error ? error.message : String(error)}`) };
      }
      if (stat.isSymbolicLink() || (cursor === verified.absolutePath && (!stat.isFile() || stat.nlink !== 1))) {
        return { path: lexical, diagnostic: diagnostic("SOURCE_ALIAS_UNSAFE", POLICY_PATH, `${lexical} is not a regular confined file; lexical exclusion remains and its alias is not followed`) };
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

async function v5Sources(
  vault: string,
  value: unknown,
): Promise<{ readonly paths: readonly string[]; readonly diagnostics: readonly SourceExclusionDiagnostic[]; readonly complete: boolean } | null> {
  if (!isRecord(value) || value.version !== 5 || !isRecord(value.templates)) return null;
  try {
    const policy = parseContractPolicyV5(value);
    const candidates = Object.entries(policy.templates)
      .filter((entry): entry is [string, Extract<(typeof policy.templates)[string], { status: "active" }>] => entry[1].status === "active")
      .map(([id, entry]) => ({ id, path: entry.source.path }));
    const accepted = await acceptSources(vault, POLICY_PATH, candidates);
    return { ...accepted, complete: accepted.diagnostics.length === 0 };
  } catch {
    // Unrelated invalid rules must not erase an independently safe source ref.
  }
  const candidates: { id: string; path: string }[] = [];
  for (const [id, entry] of Object.entries(value.templates)) {
    if (!isRecord(entry) || entry.status === "review-required") continue;
    if (!isRecord(entry.source) || typeof entry.source.path !== "string") continue;
    candidates.push({ id, path: entry.source.path });
  }
  const accepted = await acceptSources(vault, POLICY_PATH, candidates);
  return {
    paths: accepted.paths,
    diagnostics: [
      diagnostic("SOURCE_POLICY_PARTIAL", POLICY_PATH, "V5 policy is not an active contract; independently valid explicit source refs were retained"),
      ...accepted.diagnostics,
    ],
    complete: false,
  };
}

async function legacySources(
  vault: string,
  value: unknown,
): Promise<{ readonly paths: readonly string[]; readonly diagnostics: readonly SourceExclusionDiagnostic[]; readonly complete: boolean } | null> {
  if (!isRecord(value) || (value.version !== 3 && value.version !== 4)) return null;
  const candidates: { id: string; path: string }[] = [];
  if (value.version === 4 && isRecord(value.default)) {
    const declared = literalSource(value.default);
    if (declared !== null) candidates.push({ id: "default", path: declared });
  }
  if (isRecord(value.templates)) {
    for (const [id, entry] of Object.entries(value.templates)) {
      const declared = literalSource(entry);
      if (declared !== null) candidates.push({ id, path: declared });
    }
  } else if (Array.isArray(value.templates)) {
    return {
      paths: [],
      diagnostics: [diagnostic("SOURCE_POLICY_INCOMPLETE", POLICY_PATH, "historical template list has no recoverable source registration")],
      complete: false,
    };
  }
  const accepted = await acceptSources(vault, POLICY_PATH, candidates);
  return {
    paths: accepted.paths,
    diagnostics: [
      diagnostic("SOURCE_LEGACY_DECLARATION", POLICY_PATH, `version ${String(value.version)} source declarations are exclusion facts only and do not activate a contract`),
      ...accepted.diagnostics,
    ],
    complete: false,
  };
}

async function readSources(vault: string, read: ControlRead): Promise<{ readonly paths: readonly string[]; readonly diagnostics: readonly SourceExclusionDiagnostic[]; readonly classification: string; readonly complete: boolean }> {
  if (read.state === "absent") return { paths: [], diagnostics: [], classification: "absent", complete: true };
  const decoded = decodeControl(read, POLICY_PATH);
  if (decoded.diagnostic !== null || decoded.text === null) {
    return { paths: [], diagnostics: decoded.diagnostic === null ? [] : [decoded.diagnostic], classification: "unreadable", complete: false };
  }
  const unique = uniqueValue(decoded.text, POLICY_PATH);
  if (unique.diagnostic !== null || !isRecord(unique.value)) {
    return {
      paths: [],
      diagnostics: [unique.diagnostic ?? diagnostic("SOURCE_POLICY_INVALID", POLICY_PATH, "policy is not a unique JSON object")],
      classification: "invalid",
      complete: false,
    };
  }
  const modern = await v5Sources(vault, unique.value);
  if (modern !== null) return { ...modern, classification: modern.complete ? "valid" : "partial" };
  const historical = await legacySources(vault, unique.value);
  if (historical !== null) return { ...historical, classification: historical.complete ? "legacy" : "partial" };
  return {
    paths: [],
    diagnostics: [diagnostic("SOURCE_POLICY_INCOMPLETE", POLICY_PATH, "unknown policy version has no safely recoverable source registration")],
    classification: "invalid",
    complete: false,
  };
}

function readGlobs(read: ControlRead): { readonly globs: readonly string[]; readonly diagnostic: SourceExclusionDiagnostic | null; readonly classification: string } {
  if (read.state === "absent") return { globs: [], diagnostic: null, classification: "absent" };
  const decoded = decodeControl(read, TAXONOMY_PATH);
  if (decoded.diagnostic !== null || decoded.text === null) return { globs: [], diagnostic: decoded.diagnostic, classification: "unreadable" };
  const unique = uniqueValue(decoded.text, TAXONOMY_PATH);
  if (unique.diagnostic !== null || !isRecord(unique.value)) {
    return { globs: [], diagnostic: unique.diagnostic ?? diagnostic("SOURCE_TAXONOMY_INVALID", TAXONOMY_PATH, "taxonomy is not a unique JSON object"), classification: "invalid" };
  }
  if (!Object.hasOwn(unique.value, "exclude")) return { globs: [], diagnostic: null, classification: "valid" };
  const declared = unique.value.exclude;
  if (!Array.isArray(declared) || !declared.every(item => typeof item === "string")) {
    return { globs: [], diagnostic: diagnostic("SOURCE_TAXONOMY_INVALID", TAXONOMY_PATH, "exclude must be a list of strings"), classification: "invalid" };
  }
  const globs: string[] = [];
  for (const glob of declared) {
    const lexical = glob.replaceAll("\\", "/");
    if (lexical.includes("\0") || lexical.startsWith("/") || lexical.split("/").includes("..")) {
      return { globs: [], diagnostic: diagnostic("SOURCE_TAXONOMY_UNSAFE", TAXONOMY_PATH, `exclude glob ${glob} is not vault-confined`), classification: "invalid" };
    }
    globs.push(lexical);
  }
  return { globs, diagnostic: null, classification: "valid" };
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

function inventoryDigest(input: {
  readonly settings: ControlRead;
  readonly policy: ControlRead;
  readonly taxonomy: ControlRead;
  readonly roots: readonly string[];
  readonly paths: readonly string[];
  readonly globs: readonly string[];
  readonly diagnostics: readonly SourceExclusionDiagnostic[];
  readonly classifications: readonly string[];
}): Digest {
  const channel = (read: ControlRead): string | null => read.bytes === null ? null : digestBytes(read.bytes);
  return hashCanonical(INVENTORY_DOMAIN, {
    controls: {
      settings: { state: input.settings.state, bytes: channel(input.settings) },
      policy: { state: input.policy.state, bytes: channel(input.policy) },
      taxonomy: { state: input.taxonomy.state, bytes: channel(input.taxonomy) },
    },
    roots: input.roots,
    paths: input.paths,
    globs: input.globs,
    diagnostics: input.diagnostics.map(item => ({ code: item.code, path: item.path, message: item.message })),
    classifications: input.classifications,
  });
}

/**
 * Declared exclusion channels that a walker cannot silently skip. Unreadable
 * user taxonomy or unreadable external template settings would hide explicit
 * declarations, so enforcement fails loudly instead of scanning unfiltered.
 */
function lexicalBlocker(inventory: SourceExclusionInventory): SourceExclusionDiagnostic | null {
  return inventory.diagnostics.find(item => item.path === TAXONOMY_PATH || item.path === EXTERNAL_TEMPLATES_PATH) ?? null;
}

function assertLexicalChannels(inventory: SourceExclusionInventory): void {
  const blocker = lexicalBlocker(inventory);
  if (blocker !== null) failure("NOTE_EXCLUSION_RESOLUTION_FAILED", `${blocker.path}: ${blocker.message}`);
}

/** Reads settings, policy, taxonomy, and external template settings independently. It creates no vault state. */
export async function readSourceExclusions(vault: string): Promise<SourceExclusionInventory> {
  const [settings, policy, taxonomy] = await Promise.all([
    readControl(vault, SETTINGS_PATH),
    readControl(vault, POLICY_PATH),
    readControl(vault, TAXONOMY_PATH),
  ]);
  const roots = await readRoots(vault, settings);
  const sources = await readSources(vault, policy);
  const globs = readGlobs(taxonomy);
  const external = await readExternalTemplateGlobs(vault);
  const diagnostics = [roots.diagnostic, ...sources.diagnostics, globs.diagnostic, external.diagnostic]
    .filter((item): item is SourceExclusionDiagnostic => item !== null);
  if (!sources.complete && globs.diagnostic !== null) {
    diagnostics.push(diagnostic(
      "SOURCE_EXCLUSION_INCOMPLETE",
      POLICY_PATH,
      "Known exclusions remain in force, but additional sources may appear because policy and taxonomy could not both be read",
    ));
  }
  diagnostics.sort((left, right) => compareText(left.path, right.path) || compareText(left.code, right.code) || compareText(left.message, right.message));
  const complete = roots.diagnostic === null && sources.complete && globs.diagnostic === null && external.diagnostic === null;
  return {
    digest: inventoryDigest({
      settings,
      policy,
      taxonomy,
      roots: roots.roots,
      paths: sources.paths,
      globs: [...globs.globs, ...external.globs],
      diagnostics,
      classifications: [roots.classification, sources.classification, globs.classification, external.classification],
    }),
    roots: roots.roots,
    paths: sources.paths,
    globs: [...DEFAULT_EXCLUDE_GLOBS, ...globs.globs, ...external.globs],
    complete,
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
