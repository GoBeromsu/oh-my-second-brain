import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assertConnectionControlPath, assertConnectionControlTarget, connectionDigest, connectionRegistryPath, connectionRuntimeRoot } from "../install/connection-registry.js";
import type { WriteTarget } from "../capture/safe.js";
import {
  commitConnection,
  prepareConnection,
  settingsPublicationRequest,
  type ConnectionCommitResult,
  type ConnectionCoordinatorOptions,
  type PreparedConnection,
} from "../install/connection-coordinator.js";
import {
  type ConnectionRegistryOptions,
  readConnectionRegistry,
} from "../install/connection-registry.js";
import { readConnectionBytes } from "../install/connection-registry.js";
import { readProjectConnection } from "../install/project-connection.js";
import { parseVaultSettings, readVaultSettings, serializeVaultSettings, type VaultSettings } from "../templates/vault-settings.js";

/**
 * Cross-repo vault bridge.
 *
 * A vault `.oms/` holds template controls. A bridge `.oms/` holds a v2
 * connection reference plus gitignored `linked/<name>` symlinks. Global
 * selection is never inferred from a bridge.
 */

/** Relative path (from a bridge repo root) holding the vault symlinks. */
export const LINKED_DIR_RELATIVE = path.join(".oms", "linked");

/** `.gitignore` pattern that keeps the symlinks out of the published repo. */
export const LINKED_GITIGNORE_PATTERN = ".oms/linked/";

export type VaultSource = "explicit" | "vault" | "bridge" | "legacy-bridge" | "env" | "cwd";

export interface VaultBindingDiagnostic {
  readonly code: "missing-bridge" | "corrupt-bridge" | "identity-conflict" | "unsafe-target" | "legacy-readonly";
  readonly message: string;
}

export interface ResolvedVault {
  /** Effective vault root — where the `.oms/` ontology lives. */
  readonly vault: string;
  /**
   * Allowed vault folders. `null` means unrestricted. A v2 bridge yields its
   * declared scope; a diagnosed v1 bridge yields its recorded scope read-only
   * under source `legacy-bridge`.
   */
  readonly scope: readonly string[] | null;
  readonly source: VaultSource;
  readonly diagnostics: readonly VaultBindingDiagnostic[];
}

export interface ResolveVaultOptions {
  readonly explicitVault?: string;
  readonly registry?: ConnectionRegistryOptions;
}

export interface VaultLinkProjection {
  readonly linked: readonly string[];
  readonly unchanged: readonly string[];
  readonly gitignoreUpdated: boolean;
  readonly recordPath: string;
}

export type ProjectionDiagnosticCode = "projection-pending" | "projection-blocked";

export interface ProjectionDiagnostic {
  readonly code: ProjectionDiagnosticCode;
  readonly message: string;
}

/** Caller-retained link plan. Commit reuses this value and never rebuilds it. */
export interface PreparedVaultLink {
  readonly observedProjectDigest: string | null;
  readonly connection: PreparedConnection;
  readonly projection: readonly ApprovedProjection[];
}

export interface ApprovedProjection {
  readonly rel: string;
  readonly linkName: string;
  readonly target: string;
}

export interface VaultLinkProjectionResult {
  readonly state: "complete" | "pending" | "blocked" | "not-requested";
  readonly projection: VaultLinkProjection | null;
  readonly diagnostic: ProjectionDiagnostic | null;
}

export interface VaultLinkResult {
  readonly preparedDigest: string;
  readonly connection: ConnectionCommitResult;
  readonly projection: VaultLinkProjection | null;
  readonly projectionState: VaultLinkProjectionResult["state"];
  readonly projectionDiagnostic: ProjectionDiagnostic | null;
  /** False when any native stage or the separate projection is not complete. */
  readonly ready: boolean;
  readonly partial: boolean;
}

export interface VaultLinkRemoval {
  readonly removed: readonly string[];
  readonly recordPath: string;
  readonly linkedDirectory: string;
  /** Individual unlinks are not an atomic directory replacement. */
  readonly atomic: false;
}

export interface RemovalBinding {
  readonly connectionId: string;
  readonly portableVaultId: string;
  readonly canonicalVaultPath: string;
  readonly settingsIdentity: string;
  readonly registryDigest: string;
}

/** Expand a leading `~/` to the user's home directory, then resolve. */
export function expandHome(target: string): string {
  if (target === "~") return os.homedir();
  if (target.startsWith("~/") || target.startsWith(`~${path.sep}`)) {
    return path.resolve(path.join(os.homedir(), target.slice(2)));
  }
  return path.resolve(target);
}

async function pathKind(target: string): Promise<"missing" | "file" | "directory" | "symlink" | "other"> {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function diagnostic(code: VaultBindingDiagnostic["code"], message: string): VaultBindingDiagnostic {
  return { code, message };
}

async function visible(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function hasLocalVaultEvidence(startDir: string): Promise<boolean> {
  const omsDir = path.join(startDir, ".oms");
  return await pathKind(path.join(omsDir, "settings.json")) === "file"
    || await pathKind(path.join(omsDir, "template-policy.json")) === "file"
    || await pathKind(path.join(omsDir, "taxonomy.json")) === "file";
}

async function hasBridgeEvidence(startDir: string): Promise<boolean> {
  if (await visible(path.join(startDir, ".oms", "links.yaml"))) return true;
  const linked = path.join(startDir, LINKED_DIR_RELATIVE);
  try {
    const entries = await readdir(linked);
    for (const entry of entries) if (await visible(path.join(linked, entry))) return true;
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function resolved(vault: string, source: VaultSource, scope: readonly string[] | null, diagnostics: readonly VaultBindingDiagnostic[] = []): ResolvedVault {
  return { vault: path.resolve(vault), source, scope, diagnostics };
}

async function resolveBridge(startDir: string, registry: ConnectionRegistryOptions): Promise<ResolvedVault> {
  const root = await realpath(startDir);
  await assertConnectionControlPath(root, "Project root");
  let project;
  try {
    project = await readProjectConnection(root);
  } catch (error) {
    throw new Error(`[oms] Invalid bridge record at ${path.join(startDir, ".oms", "links.yaml")}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (project.state === "missing") {
    throw new Error(`[oms] Bridge evidence exists but links.yaml is missing: ${project.path}.`);
  }
  if (project.state === "v1" && project.pointer !== undefined) {
    const vault = expandHome(project.pointer.vault);
    if (await pathKind(vault) !== "directory") {
      throw new Error(`[oms] Linked vault path does not exist or is not a directory: ${vault}.`);
    }
    return resolved(vault, "legacy-bridge", project.pointer.scope, [diagnostic("legacy-readonly", "v1 bridge path is available read-only and was not converted.")]);
  }
  const reference = project.reference;
  if (reference === undefined) throw new Error(`[oms] Invalid bridge record at ${project.path}: v2 reference is missing.`);
  const registryRead = await readConnectionRegistry(registry);
  const entry = registryRead.registry?.connections.find(item => item.connectionId === reference.connectionId);
  if (entry === undefined || entry.portableVaultId !== reference.portableVaultId) {
    throw new Error(`[oms] Bridge connection ${reference.connectionId} is not bound in the connection registry.`);
  }
  const settings = await readVaultSettings(entry.localVaultPath);
  if (settings?.vaultId !== reference.portableVaultId || settings.vaultId !== entry.portableVaultId) {
    throw new Error(`[oms] Bridge connection ${reference.connectionId} does not match published portable identity.`);
  }
  if (path.resolve(entry.localVaultPath) !== path.resolve(await realpath(entry.localVaultPath))) {
    throw new Error(`[oms] Bridge connection ${reference.connectionId} does not resolve to its registered local path.`);
  }
  return resolved(entry.localVaultPath, "bridge", reference.scope);
}

/**
 * Resolve the effective vault root for a command invoked from `startDir`.
 *
 * Precedence is explicit, then local settings/policy/taxonomy evidence, then
 * a verified bridge, then `OMS_VAULT`, then `startDir`. Global selection is
 * never a fallback.
 */
export async function resolveEffectiveVault(
  startDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: ResolveVaultOptions = {},
): Promise<ResolvedVault> {
  if (options.explicitVault !== undefined && options.explicitVault.trim().length > 0) {
    return resolved(expandHome(options.explicitVault), "explicit", null);
  }
  if (await hasLocalVaultEvidence(startDir)) return resolved(startDir, "vault", null);
  if (await hasBridgeEvidence(startDir)) return resolveBridge(startDir, { env, ...options.registry });
  const envVault = env["OMS_VAULT"];
  if (envVault !== undefined && envVault.trim().length > 0) return resolved(expandHome(envVault), "env", null);
  return resolved(startDir, "cwd", null);
}

/** Append `pattern` to `<repoDir>/.gitignore` when absent. Returns whether it changed. */
export async function ensureGitignore(repoDir: string, pattern: string): Promise<boolean> {
  const gitignorePath = path.join(repoDir, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(gitignorePath, "utf-8");
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lines = existing.split(/\r?\n/).map(line => line.trim());
  if (lines.includes(pattern.trim())) return false;
  const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  const block = existing.length === 0 ? `${pattern}\n` : `# Oh My Second Brain vault bridge (machine-local)\n${pattern}\n`;
  await writeFile(gitignorePath, `${prefix}${block}`, "utf-8");
  return true;
}

function linkError(message: string): Error {
  return new Error(`[oms] ${message}`);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function canonicalPublicRoot(candidate: string, label: string): Promise<string> {
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    if (isEnoent(error)) throw linkError(`${label} is not a directory: ${candidate}`);
    throw error;
  }
  if (!info.isDirectory() && !info.isSymbolicLink()) throw linkError(`${label} is not a directory: ${candidate}`);
  const canonical = await realpath(candidate);
  await assertConnectionControlPath(canonical, label);
  const canonicalInfo = await lstat(canonical);
  if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isDirectory()) throw linkError(`${label} is not a directory: ${candidate}`);
  return canonical;
}

async function confinedSource(vaultRoot: string, rel: string): Promise<string> {
  const segments = rel.split("/");
  let cursor = vaultRoot;
  for (const segment of segments) {
    const next = path.join(cursor, segment);
    const info = await lstat(next);
    if (info.isSymbolicLink()) throw linkError(`Folder traverses a symlink inside the vault: ${rel}`);
    const real = await realpath(next);
    const relative = path.relative(vaultRoot, real);
    if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw linkError(`Folder escapes the vault: ${rel}`);
    }
    cursor = next;
  }
  if (!(await lstat(cursor)).isDirectory()) throw linkError(`Vault folder does not exist: ${path.join(vaultRoot, rel)}`);
  return path.resolve(cursor);
}

async function approveProjection(vaultRoot: string, scope: readonly string[]): Promise<readonly ApprovedProjection[]> {
  const specs: ApprovedProjection[] = [];
  const byName = new Map<string, string>();
  for (const folder of scope) {
    if (path.isAbsolute(folder) || folder.split("/").includes("..")) throw linkError(`Folder escapes the vault: ${folder}`);
    const rel = folder.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    if (rel.length === 0) throw linkError("Folder must name a vault subfolder, not the vault root.");
    let target: string;
    try {
      target = await confinedSource(vaultRoot, rel);
    } catch (error) {
      if (isEnoent(error)) throw linkError(`Vault folder does not exist: ${path.join(vaultRoot, rel)}`);
      throw error;
    }
    const linkName = path.basename(target);
    if (linkName.length === 0 || linkName === "." || linkName === "..") throw linkError(`Cannot derive a link name from folder: ${folder}`);
    const prior = byName.get(linkName);
    if (prior !== undefined && prior !== rel) throw linkError(`Link name collision: "${linkName}" maps to both "${prior}" and "${rel}". Link them separately.`);
    byName.set(linkName, rel);
    specs.push(Object.freeze({ rel, linkName, target }));
  }
  return Object.freeze(specs);
}

async function assertSafeGitignore(projectRoot: string): Promise<void> {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  await assertConnectionControlPath(path.dirname(gitignorePath), "Projection gitignore parent");
  const info = await lstat(gitignorePath).catch((error: unknown) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  if (info === undefined) return;
  if (info.isSymbolicLink()) throw linkError(`Refusing to append .gitignore through a symlink: ${gitignorePath}`);
  await assertConnectionControlTarget(gitignorePath, "Projection gitignore", "file");
}

async function preflightProjection(prepared: PreparedVaultLink): Promise<void> {
  const projectRoot = prepared.connection.input.project?.root;
  if (projectRoot === undefined) throw linkError("Projection requires the approved project root.");
  const linkedDir = path.join(projectRoot, LINKED_DIR_RELATIVE);
  await assertConnectionControlPath(path.dirname(linkedDir), "Projection destination parent");
  await assertConnectionControlPath(path.join(projectRoot, ".oms"), "Projection private control");
  await assertSafeGitignore(projectRoot);
  const parent = await lstat(linkedDir).catch((error: unknown) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  if (parent?.isSymbolicLink()) throw linkError(`Refusing to project through a symlinked destination: ${linkedDir}`);
}

function sameTarget(linkPath: string, linkText: string, intended: string): boolean {
  const lexical = path.resolve(path.dirname(linkPath), linkText);
  return lexical === path.resolve(intended);
}

async function revalidateSources(prepared: PreparedVaultLink): Promise<void> {
  for (const spec of prepared.projection) {
    const current = await confinedSource(prepared.connection.canonicalTarget, spec.rel);
    if (path.resolve(current) !== path.resolve(spec.target)) throw linkError(`Folder traverses a symlink inside the vault: ${spec.rel}`);
  }
}

async function projectApproved(prepared: PreparedVaultLink): Promise<VaultLinkProjection> {
  const projectRoot = prepared.connection.input.project?.root;
  if (projectRoot === undefined) throw linkError("Projection requires the approved project root.");
  await preflightProjection(prepared);
  await revalidateSources(prepared);
  const linkedDir = path.join(projectRoot, LINKED_DIR_RELATIVE);
  await mkdir(linkedDir, { recursive: true });
  const linked: string[] = [];
  const unchanged: string[] = [];
  for (const spec of prepared.projection) {
    const linkPath = path.join(linkedDir, spec.linkName);
    const relName = path.join("linked", spec.linkName);
    const kind = await pathKind(linkPath);
    if (kind === "symlink") {
      const text = await readlink(linkPath);
      if (sameTarget(linkPath, text, spec.target)) {
        const real = await realpath(linkPath).catch(() => "");
        if (real !== path.resolve(spec.target)) throw linkError(`Refusing to replace mismatched symlink at ${linkPath}; it is not the approved target.`);
        unchanged.push(relName);
        continue;
      }
      throw linkError(`Refusing to replace mismatched symlink at ${linkPath}; remove it first.`);
    }
    if (kind !== "missing") throw linkError(`Refusing to overwrite existing ${kind} at ${linkPath}; remove it first.`);
    await symlink(spec.target, linkPath, "dir");
    linked.push(relName);
  }
  return {
    linked,
    unchanged,
    gitignoreUpdated: await ensureGitignore(projectRoot, LINKED_GITIGNORE_PATTERN),
    recordPath: prepared.connection.projectPath ?? path.join(projectRoot, ".oms", "links.yaml"),
  };
}

function isProjectionConflict(message: string): boolean {
  return /Refusing to (replace|overwrite)/.test(message) || /through a symlink/.test(message);
}

function projectionDiagnostic(error: unknown): ProjectionDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const blocked = !isProjectionConflict(message) && /not a directory|escapes the vault|does not exist|collision|symlink inside/.test(message);
  return { code: blocked ? "projection-blocked" : "projection-pending", message };
}

function finish(prepared: PreparedVaultLink, connection: ConnectionCommitResult, projected: VaultLinkProjectionResult): VaultLinkResult {
  const nativeReady = connection.vault.state !== "blocked" && connection.vault.state !== "pending"
    && connection.global.state === "complete" && connection.project.state === "complete";
  const ready = nativeReady && projected.state === "complete" && projected.projection !== null;
  return {
    preparedDigest: prepared.connection.digest,
    connection,
    projection: projected.projection,
    projectionState: projected.state,
    projectionDiagnostic: projected.diagnostic,
    ready,
    partial: !ready,
  };
}

export interface PrepareVaultLinkInput {
  readonly cwd: string;
  readonly vault: string;
  readonly folders: readonly string[];
  readonly operationId: string;
  readonly publicationTransactionId: string;
  readonly publicationVaultId?: string;
  readonly select?: boolean;
  readonly registry?: ConnectionCoordinatorOptions;
}

export async function prepareVaultLink(input: PrepareVaultLinkInput): Promise<PreparedVaultLink> {
  const requestedRoot = path.isAbsolute(input.vault) || input.vault.startsWith("~") ? expandHome(input.vault) : path.resolve(input.cwd, input.vault);
  const vaultRoot = await canonicalPublicRoot(requestedRoot, "Vault");
  const projectRoot = await canonicalPublicRoot(path.resolve(input.cwd), "Project root");
  const folders = [...new Set(input.folders.map(folder => folder.trim()).filter(folder => folder.length > 0))];
  if (folders.length === 0) throw linkError("At least one --folder is required to create a vault link.");
  const settings = await readVaultSettings(vaultRoot);
  const publication = settings === null
    ? settingsPublicationRequest(input.publicationTransactionId, input.publicationVaultId ?? randomUUID())
    : null;
  let observed: Awaited<ReturnType<typeof readProjectConnection>> | undefined;
  let observedError: unknown;
  try {
    observed = await readProjectConnection(projectRoot);
  } catch (error) {
    observedError = error;
  }
  const requested = folders.map(folder => folder.replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""));
  const existing = observed?.reference?.scope ?? observed?.pointer?.scope ?? [];
  const scope = [...new Set([...(observedError === undefined ? existing : []), ...requested])].sort();
  const projection = await approveProjection(vaultRoot, scope);
  const connection = await prepareConnection({
    operationId: input.operationId,
    target: { vault: vaultRoot, source: "explicit" } satisfies WriteTarget,
    publication,
    select: input.select === true,
    project: { root: projectRoot, scope: projection.map(spec => spec.rel) },
  }, input.registry);
  const projectBlocker = connection.blockers.some(item => item.stage === "project");
  if (observedError !== undefined && !projectBlocker) {
    throw linkError("Project connection changed between the scope read and coordinator preparation; prepare again.");
  }
  if (observed !== undefined && connection.expectedProjectDigest !== (observed.digest ?? "sha256:absent")) {
    throw linkError("Project connection digest changed between the scope read and coordinator preparation; prepare again.");
  }
  if (connection.input.project?.root !== projectRoot || connection.canonicalTarget !== vaultRoot) {
    throw linkError("Coordinator preparation did not bind the canonical vault and project.");
  }
  const approvedScope = connection.input.project?.scope ?? [];
  if (approvedScope.length !== projection.length || approvedScope.some((rel, index) => rel !== projection[index]?.rel)) {
    throw linkError("Projection specs are not bound to the coordinator scope.");
  }
  return Object.freeze({
    connection,
    observedProjectDigest: observed?.digest ?? null,
    projection: Object.freeze(projection.map(spec => Object.freeze({ ...spec }))),
  });
}

function linkNameOf(target: string): string {
  const name = path.basename(path.resolve(target));
  if (name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw linkError(`Projection link name is not a confined basename: ${name}`);
  }
  return name;
}

function assertBound(prepared: PreparedVaultLink): void {
  const project = prepared.connection.input.project;
  if (project === undefined) throw linkError("Prepared link is not bound to a project.");
  if (prepared.projection.length !== project.scope.length || prepared.projection.some((spec, index) => spec.rel !== project.scope[index])) {
    throw linkError("Projection specs are not bound to the approved coordinator scope.");
  }
  const names = new Set<string>();
  for (const spec of prepared.projection) {
    const bound = path.resolve(prepared.connection.canonicalTarget, spec.rel);
    if (bound !== path.resolve(spec.target)) throw linkError("Projection target is not bound to the approved canonical vault.");
    const linkName = linkNameOf(bound);
    if (spec.linkName !== linkName || spec.linkName !== path.basename(spec.rel) || names.has(linkName)) {
      throw linkError(`Projection link name is not the unique basename of the bound target: ${spec.linkName}`);
    }
    names.add(linkName);
  }
}

export async function commitVaultLink(
  prepared: PreparedVaultLink,
  options: ConnectionCoordinatorOptions = {},
): Promise<VaultLinkResult> {
  assertBound(prepared);
  const connection = await commitConnection(prepared.connection, prepared.connection.digest, options);
  const faulted = connection.vault.code === "injected-fault" || connection.global.code === "injected-fault" || connection.project.code === "injected-fault";
  if (faulted || connection.global.state !== "complete" || connection.project.state !== "complete" || connection.project.receipt?.completed !== true) {
    return finish(prepared, connection, { state: "not-requested", projection: null, diagnostic: null });
  }
  try {
    const runtimeRoot = connectionRuntimeRoot(options);
    if (path.resolve(runtimeRoot) !== path.resolve(prepared.connection.runtimeRoot)) {
      throw linkError("Commit storage does not match the approved preparation.");
    }
    const projection = await projectApproved(prepared);
    return finish(prepared, connection, { state: "complete", projection, diagnostic: null });
  } catch (error) {
    const diagnostic = projectionDiagnostic(error);
    return finish(prepared, connection, { state: diagnostic.code === "projection-blocked" ? "blocked" : "pending", projection: null, diagnostic });
  }
}

interface VerifiedProjectionLink {
  readonly linkPath: string;
  readonly linkText: string;
  readonly target: string;
  readonly dev: number;
  readonly ino: number;
}


/** Invoked only after complete removal preflight and before the first unlink. */
/** Invoked after owned projection removal and before the final record unlink. */
export const removalRecordBoundarySeam: { beforeRecordUnlink?: () => Promise<void> } = {};
export const removalBindingSeam: { beforeUnlink?: (binding: RemovalBinding) => Promise<void> } = {};

/** Invoked after authority reads and before the final no-follow projection-leaf check. */

/** Invoked after the final leaf read and before the last projection-directory identity check. */
export const removalParentBoundarySeam: { beforeParentGuard?: () => Promise<void> } = {};


/** Invoked after the final record reread and before the expected linked-directory absence check. */
export const removalAbsenceBoundarySeam: { beforeAbsenceGuard?: () => Promise<void> } = {};
/** Invoked after the owned projection unlinks and before the empty-directory identity check. */
export const removalDirectoryBoundarySeam: { beforeDirectoryRemoval?: () => Promise<void> } = {};
export const removalLeafBoundarySeam: { beforeLeafUnlink?: () => Promise<void> } = {};

function settingsIdentityOf(settings: VaultSettings): string {
  return parseVaultSettings(serializeVaultSettings(settings)).vaultId;
}

async function liveRemovalBinding(
  registry: ConnectionRegistryOptions,
  reference: { readonly connectionId: string; readonly portableVaultId: string },
): Promise<RemovalBinding> {
  const location = registry.registryPath ?? connectionRegistryPath(registry.env, registry.homeDir);
  const registryRead = await readConnectionRegistry(registry);
  const entry = registryRead.registry?.connections.find(item => item.connectionId === reference.connectionId && item.portableVaultId === reference.portableVaultId);
  if (registryRead.state !== "v2" || entry === undefined) {
    throw linkError(`Bridge connection ${reference.connectionId} is not bound to portable identity ${reference.portableVaultId}.`);
  }
  const canonicalVaultPath = await realpath(entry.localVaultPath);
  if (path.resolve(entry.localVaultPath) !== path.resolve(canonicalVaultPath)) {
    throw linkError(`Bridge connection ${reference.connectionId} does not resolve to its registered local path.`);
  }
  const settings = await readVaultSettings(canonicalVaultPath);
  if (settings?.vaultId !== reference.portableVaultId || settings.vaultId !== entry.portableVaultId) {
    throw linkError(`Bridge connection ${reference.connectionId} does not match published portable identity.`);
  }
  const settingsIdentity = settingsIdentityOf(settings);
  if (settingsIdentity !== settings.vaultId) throw linkError(`Bridge connection ${reference.connectionId} settings identity drifted.`);
  const registryBytes = await readConnectionBytes(location);
  if (registryBytes === undefined) throw linkError(`Bridge connection ${reference.connectionId} registry changed before removal.`);
  return {
    connectionId: entry.connectionId,
    portableVaultId: entry.portableVaultId,
    canonicalVaultPath,
    settingsIdentity,
    registryDigest: connectionDigest(registryBytes),
  };
}

function assertSameRemovalBinding(verified: RemovalBinding, live: RemovalBinding): void {
  if (
    live.connectionId !== verified.connectionId
    || live.portableVaultId !== verified.portableVaultId
    || path.resolve(live.canonicalVaultPath) !== path.resolve(verified.canonicalVaultPath)
    || live.settingsIdentity !== verified.settingsIdentity
  ) {
    throw linkError(`Bridge connection ${verified.connectionId} binding changed before removal; nothing further was removed.`);
  }
}

async function assertOriginalProjectRecord(
  projectRoot: string,
  recordPath: string,
  recordBytes: Uint8Array,
): Promise<void> {
  await assertConnectionControlTarget(recordPath, "Project links", "file");
  const info = await lstat(recordPath);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw linkError("Project links changed before removal; nothing further was removed.");
  }
  const currentBytes = await readConnectionBytes(recordPath);
  if (currentBytes === undefined || !Buffer.from(currentBytes).equals(Buffer.from(recordBytes))) {
    throw linkError("Project links changed before removal; nothing further was removed.");
  }
  const current = await readProjectConnection(projectRoot);
  if (current.state !== "v2" || current.reference === undefined || current.path !== recordPath || !Buffer.from(current.reference.bytes).equals(Buffer.from(recordBytes))) {
    throw linkError("Project links changed before removal; nothing further was removed.");
  }
  if (current.reference.scope.length !== new Set(current.reference.scope).size) {
    throw linkError("Duplicate declared scope cannot be removed; nothing was removed.");
  }
}

async function assertOriginalProjectionLeaf(link: VerifiedProjectionLink): Promise<void> {
  const info = await lstat(link.linkPath);
  if (!info.isSymbolicLink() || info.dev !== link.dev || info.ino !== link.ino) {
    throw linkError(`Projection symlink changed before removal: ${link.linkPath}`);
  }
}

async function assertProjectionParent(linkedDir: string): Promise<void> {
  await assertConnectionControlPath(path.dirname(linkedDir), "Projection destination parent");
  const parent = await lstat(path.dirname(linkedDir));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw linkError(`Projection parent changed before removal: ${path.dirname(linkedDir)}`);
  }
}

async function assertOriginalRecordLeaf(recordPath: string, recordBytes: Uint8Array): Promise<void> {
  const info = await lstat(recordPath);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw linkError("Project links changed before removal; nothing further was removed.");
  }
  const currentBytes = await readConnectionBytes(recordPath);
  if (currentBytes === undefined || !Buffer.from(currentBytes).equals(Buffer.from(recordBytes))) {
    throw linkError("Project links changed before removal; nothing further was removed.");
  }
}

interface ProjectionDirectoryStat {
  readonly present: true;
  readonly dev: number;
  readonly ino: number;
}

async function assertOriginalProjectionDirectory(linkedDir: string, stat: ProjectionDirectoryStat | null): Promise<void> {
  await assertConnectionControlPath(path.dirname(linkedDir), "Projection destination parent");
  await assertConnectionControlPath(path.join(path.dirname(linkedDir), ".."), "Projection private control");
  const info = await lstat(linkedDir).catch((error: unknown) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  if (stat === null) {
    if (info !== undefined) throw linkError(`Projection directory appeared before record removal: ${linkedDir}`);
    return;
  }
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory() || info.dev !== stat.dev || info.ino !== stat.ino) {
    throw linkError(`Projection directory changed before removal: ${linkedDir}`);
  }
}

async function verifiedRemovalBinding(projectRoot: string, registry: ConnectionRegistryOptions): Promise<{
  readonly recordPath: string;
  readonly recordBytes: Uint8Array;
  readonly linkedDir: string;
  readonly linkedStat: ProjectionDirectoryStat | null;
  readonly links: readonly VerifiedProjectionLink[];
  readonly binding: RemovalBinding;
}> {
  await assertConnectionControlPath(projectRoot, "Project root");
  let project;
  try {
    project = await readProjectConnection(projectRoot);
  } catch (error) {
    throw linkError(`Invalid bridge record at ${path.join(projectRoot, ".oms", "links.yaml")}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (project.state === "missing") throw linkError("No vault bridge record is configured.");
  if (project.state !== "v2" || project.reference === undefined) throw linkError("Only an exact v2 bridge reference can be removed; v1 was not converted.");
  const reference = project.reference;
  if (reference.scope.length !== new Set(reference.scope).size) {
    throw linkError("Duplicate declared scope cannot be removed; nothing was removed.");
  }
  const binding = await liveRemovalBinding(registry, reference);
  const recordPath = project.path;
  await assertConnectionControlTarget(recordPath, "Project links", "file");
  const recordInfo = await lstat(recordPath);
  if (recordInfo.isSymbolicLink() || !recordInfo.isFile() || recordInfo.nlink !== 1) throw linkError(`Project links must be one regular file: ${recordPath}`);
  const recordBytes = await readConnectionBytes(recordPath);
  if (recordBytes === undefined || !Buffer.from(recordBytes).equals(Buffer.from(reference.bytes))) {
    throw linkError("Project links changed before removal; nothing was removed.");
  }
  const linkedDir = path.join(projectRoot, LINKED_DIR_RELATIVE);
  await assertConnectionControlPath(path.dirname(linkedDir), "Projection destination parent");
  await assertConnectionControlPath(path.join(projectRoot, ".oms"), "Projection private control");
  const parent = await lstat(linkedDir).catch((error: unknown) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  if (parent === undefined) throw linkError(`Projection directory is missing: ${linkedDir}`);
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw linkError(`Refusing to remove through an unsafe projection directory: ${linkedDir}`);
  }
  const linkedStat: ProjectionDirectoryStat = { present: true, dev: parent.dev, ino: parent.ino };
  await assertConnectionControlTarget(linkedDir, "Projection directory", "directory");
  const specs = await approveProjection(binding.canonicalVaultPath, reference.scope);
  if (specs.length !== reference.scope.length) throw linkError("Duplicate projection link names cannot be removed; nothing was removed.");
  const expected = new Map(specs.map(spec => [spec.linkName, spec]));
  if (expected.size !== specs.length) throw linkError("Duplicate projection link names cannot be removed; nothing was removed.");
  const names = await readdir(linkedDir);
  if (names.length !== expected.size || names.some(name => !expected.has(name))) {
    throw linkError("Projection directory contains an entry outside the declared v2 scope; nothing was removed.");
  }
  const links: VerifiedProjectionLink[] = [];
  for (const spec of specs) {
    const linkPath = path.join(linkedDir, spec.linkName);
    if (path.basename(linkPath) !== spec.linkName) throw linkError(`Projection link name is not a confined basename: ${spec.linkName}`);
    const info = await lstat(linkPath);
    if (!info.isSymbolicLink()) throw linkError(`Refusing to remove a non-symlink projection entry: ${linkPath}`);
    const text = await readlink(linkPath);
    if (!sameTarget(linkPath, text, spec.target)) throw linkError(`Refusing to remove a misdirected projection symlink: ${linkPath}`);
    const real = await realpath(linkPath);
    if (path.resolve(real) !== path.resolve(spec.target)) throw linkError(`Refusing to remove a projection symlink whose real target differs: ${linkPath}`);
    const source = await confinedSource(binding.canonicalVaultPath, spec.rel);
    if (path.resolve(source) !== path.resolve(spec.target)) throw linkError(`Folder traverses a symlink inside the vault: ${spec.rel}`);
    links.push({ linkPath, linkText: text, target: spec.target, dev: info.dev, ino: info.ino });
  }
  await assertOriginalProjectionDirectory(linkedDir, linkedStat);
  const confirmed = await liveRemovalBinding(registry, reference);
  assertSameRemovalBinding(binding, confirmed);
  await assertOriginalProjectionDirectory(linkedDir, linkedStat);
  return { recordPath, recordBytes, linkedDir, linkedStat, links, binding: confirmed };
}

/**
 * Remove only the declared projection symlinks and the original v2 record.
 * Node has no atomic conditional unlink, so parent and leaf cannot both be the final check.
 * The remaining race is the finite gap from the last local identity check to its syscall.
 */
export async function removeVaultLink(
  projectRoot: string,
  registry: ConnectionRegistryOptions = {},
): Promise<VaultLinkRemoval> {
  const canonicalRoot = await canonicalPublicRoot(projectRoot, "Project root");
  const verified = await verifiedRemovalBinding(canonicalRoot, registry);
  await assertOriginalProjectRecord(canonicalRoot, verified.recordPath, verified.recordBytes);
  await assertOriginalProjectionDirectory(verified.linkedDir, verified.linkedStat);
  assertSameRemovalBinding(verified.binding, await liveRemovalBinding(registry, verified.binding));
  if (removalBindingSeam.beforeUnlink !== undefined) await removalBindingSeam.beforeUnlink(verified.binding);
  await assertOriginalProjectRecord(canonicalRoot, verified.recordPath, verified.recordBytes);
  await assertOriginalProjectionDirectory(verified.linkedDir, verified.linkedStat);
  assertSameRemovalBinding(verified.binding, await liveRemovalBinding(registry, verified.binding));
  const removed: string[] = [];
  for (const link of verified.links) {
    assertSameRemovalBinding(verified.binding, await liveRemovalBinding(registry, verified.binding));
    await assertOriginalProjectRecord(canonicalRoot, verified.recordPath, verified.recordBytes);
    if (removalLeafBoundarySeam.beforeLeafUnlink !== undefined) await removalLeafBoundarySeam.beforeLeafUnlink();
    const info = await lstat(link.linkPath);
    if (!info.isSymbolicLink() || info.dev !== link.dev || info.ino !== link.ino) {
      throw linkError(`Projection symlink changed before removal: ${link.linkPath}`);
    }
    const text = await readlink(link.linkPath);
    if (text !== link.linkText || !sameTarget(link.linkPath, text, link.target)) {
      throw linkError(`Projection symlink changed before removal: ${link.linkPath}`);
    }
    const real = await realpath(link.linkPath);
    if (path.resolve(real) !== path.resolve(link.target)) throw linkError(`Projection symlink changed before removal: ${link.linkPath}`);
    await assertOriginalProjectionLeaf(link);
    if (removalParentBoundarySeam.beforeParentGuard !== undefined) await removalParentBoundarySeam.beforeParentGuard();
    await assertProjectionParent(verified.linkedDir);
    await assertOriginalProjectionDirectory(verified.linkedDir, verified.linkedStat);
    await unlink(link.linkPath);
    removed.push(path.join("linked", path.basename(link.linkPath)));
  }
  if (verified.linkedStat !== null) {
    assertSameRemovalBinding(verified.binding, await liveRemovalBinding(registry, verified.binding));
    await assertOriginalProjectRecord(canonicalRoot, verified.recordPath, verified.recordBytes);
    const remaining = await readdir(verified.linkedDir);
    if (remaining.length !== 0) throw linkError("Projection directory is not empty after verified unlink; the record was preserved.");
    if (removalDirectoryBoundarySeam.beforeDirectoryRemoval !== undefined) await removalDirectoryBoundarySeam.beforeDirectoryRemoval();
    await assertProjectionParent(verified.linkedDir);
    await assertOriginalProjectionDirectory(verified.linkedDir, verified.linkedStat);
    await rmdir(verified.linkedDir);
  }
  assertSameRemovalBinding(verified.binding, await liveRemovalBinding(registry, verified.binding));
  if (removalRecordBoundarySeam.beforeRecordUnlink !== undefined) await removalRecordBoundarySeam.beforeRecordUnlink();
  await assertOriginalRecordLeaf(verified.recordPath, verified.recordBytes);
  await assertOriginalProjectRecord(canonicalRoot, verified.recordPath, verified.recordBytes);
  if (removalAbsenceBoundarySeam.beforeAbsenceGuard !== undefined) await removalAbsenceBoundarySeam.beforeAbsenceGuard();
  await assertOriginalProjectionDirectory(verified.linkedDir, null);
  await unlink(verified.recordPath);
  return {
    removed,
    recordPath: verified.recordPath,
    linkedDirectory: verified.linkedDir,
    atomic: false,
  };
}
