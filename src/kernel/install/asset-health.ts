import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harnessSurfaceRegistry } from "../harness/surface-registry.js";
import type { HarnessReviewerMechanismId } from "../harness/surface-registry.js";
import { hostHome } from "./common.js";
import { computeTreeDigest, digestFileBytes, digestOneFile, parseProvenance } from "./provenance.js";

export type InstalledAssetKind = "hook" | "binary" | "skill-tree" | "registration" | "reviewer-definition";
export type InstalledAssetState = "ok" | "missing" | "dangling-symlink" | "not-executable" | "not-a-file" | "provenance-mismatch" | "inspection-error";
export type InstalledHostState = "not-installed" | "ok" | "degraded";

export interface InstalledAssetDeclaration {
  readonly id: string;
  readonly kind: InstalledAssetKind;
  /**
   * Trusted installed path declared by the composition root.
   * Reviewer checks must not copy this from a completion envelope.
   */
  readonly declaredPath: string;
  readonly host?: string;
  readonly provenancePath?: string;
  /** Expected source version for a provenance-backed asset, injected by the composition root. */
  readonly provenanceVersion?: string;
  /**
   * SHA-256 of the shipped reviewer definition bytes.
   * Composition root only. Not a directory digest and not an envelope field.
   */
  readonly expectedShippedBytesDigest?: string;
  /**
   * Tree-relative file name mixed into the one-file provenance digest.
   * Composition root only. This is a hash label, not a path to open.
   */
  readonly oneFileRelativeName?: string;
  readonly evidence?: { readonly state: InstalledAssetState; readonly cause: string | null };
  readonly remediation?: string;
}

export interface InstalledHostDeclaration {
  readonly host: string;
  readonly state: InstalledHostState;
}

export interface InstalledAssetHealth {
  readonly id: string;
  readonly kind: InstalledAssetKind;
  readonly declaredPath: string;
  readonly realPath: string | null;
  readonly state: InstalledAssetState;
  readonly cause: string | null;
  readonly remediation: string;
  readonly packageVersion?: string | null;
  readonly recordedVersion?: string | null;
  readonly digestMatch?: boolean | null;
}

export interface InstalledHostHealth extends InstalledHostDeclaration {}

export interface InstalledAssetInspectionOptions {
  readonly assets?: readonly InstalledAssetDeclaration[];
  readonly hosts?: readonly InstalledHostDeclaration[];
  readonly vault?: string;
}

export interface InstalledAssetInspection {
  readonly status: "ok" | "degraded";
  readonly hosts: readonly InstalledHostHealth[];
  readonly assets: readonly InstalledAssetHealth[];
}

export type ReviewerDefinitionDisposition = "matched" | "missing" | "drifted" | "unavailable" | "not-applicable";
export type ReviewerProvenanceStatus = "match" | "mismatch" | "invalid" | "missing" | "unreadable" | "not-applicable";

/**
 * Read-only definition identity. Byte equality is not launch, enforcement, or independence.
 * isolationLevel stays instruction-only; sandbox text in the file is not an upgrade.
 */
export interface ReviewerDefinitionAtRest {
  readonly mechanismId: HarnessReviewerMechanismId;
  readonly disposition: ReviewerDefinitionDisposition;
  readonly definitionDigestVerifiedByOms: boolean;
  readonly independenceVerifiedByOms: false;
  readonly enforcementVerifiedByOms: false;
  readonly launchVerifiedByOms: false;
  readonly isolationLevel: "instruction-only";
  readonly shippedBytesDigest: string | null;
  readonly installedBytesDigest: string | null;
  readonly provenanceStatus: ReviewerProvenanceStatus;
  readonly cause: string | null;
}

/**
 * Composition-root roots only. Do not copy either field from a completion envelope.
 * Installed and shipped file paths are not parameters: source comes from
 * reviewerMechanisms[].assetPath, and the install path comes from the table below.
 */
export interface ReviewerDefinitionLocation {
  readonly packageRoot?: string;
  readonly homeDir?: string;
}

interface TrustedReviewerInstall {
  readonly dirname: string;
  readonly envName: string;
  readonly installedRelativePath: string;
  readonly provenanceRelativePath: string | null;
  readonly oneFileRelativeName: string;
}

/**
 * Fixed install paths. A mechanism with a shipped asset but no row is unavailable.
 * A mechanism with no registry assetPath is not-applicable.
 * Codex hashes only oms-reviewer.toml, never the whole agents directory.
 */
const TRUSTED_REVIEWER_INSTALLS: Partial<Record<HarnessReviewerMechanismId, TrustedReviewerInstall>> = {
  "codex.custom-agent": {
    dirname: ".codex",
    envName: "OMS_CODEX_HOME",
    installedRelativePath: "agents/oms-reviewer.toml",
    provenanceRelativePath: "agents/oms-reviewer.provenance.json",
    oneFileRelativeName: "oms-reviewer.toml",
  },
};

interface ReviewerAssessment {
  readonly disposition: ReviewerDefinitionDisposition;
  readonly shippedBytesDigest: string | null;
  readonly installedBytesDigest: string | null;
  readonly provenanceStatus: ReviewerProvenanceStatus;
  readonly cause: string | null;
  readonly recordedVersion: string | null;
  readonly realPath: string | null;
}

type RegularFileRead =
  | { readonly kind: "bytes"; readonly bytes: Buffer }
  | { readonly kind: "missing"; readonly cause: string }
  | { readonly kind: "unavailable"; readonly cause: string };

export function installRemediationCommand(vault: string, host: string): string {
  return `oms host install --runtime ${host} --vault ${JSON.stringify(vault)}`;
}

/** Package root that contains this module. Not a path taken from a completion envelope. */
export function reviewerDefinitionPackageRoot(): string {
  return path.dirname(fileURLToPath(new URL("../../../package.json", import.meta.url)));
}

function remediation(asset: InstalledAssetDeclaration, vault: string): string {
  if (asset.remediation !== undefined) return asset.remediation;
  return installRemediationCommand(vault, asset.host ?? "auto");
}

function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

function absent(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function health(
  asset: InstalledAssetDeclaration,
  vault: string,
  state: InstalledAssetState,
  realPath: string | null,
  cause: string | null,
  provenance?: Pick<InstalledAssetHealth, "packageVersion" | "recordedVersion" | "digestMatch">,
): InstalledAssetHealth {
  return { id: asset.id, kind: asset.kind, declaredPath: asset.declaredPath, realPath, state, cause, remediation: state === "ok" ? "" : remediation(asset, vault), ...provenance };
}

function reviewerAssessment(
  disposition: ReviewerDefinitionDisposition,
  detail: Partial<Omit<ReviewerAssessment, "disposition">> = {},
): ReviewerAssessment {
  return {
    disposition,
    shippedBytesDigest: detail.shippedBytesDigest ?? null,
    installedBytesDigest: detail.installedBytesDigest ?? null,
    provenanceStatus: detail.provenanceStatus ?? "not-applicable",
    cause: detail.cause ?? null,
    recordedVersion: detail.recordedVersion ?? null,
    realPath: detail.realPath ?? null,
  };
}

function definitionReceipt(mechanismId: HarnessReviewerMechanismId, result: ReviewerAssessment): ReviewerDefinitionAtRest {
  return {
    mechanismId,
    disposition: result.disposition,
    definitionDigestVerifiedByOms: result.disposition === "matched",
    independenceVerifiedByOms: false,
    enforcementVerifiedByOms: false,
    launchVerifiedByOms: false,
    isolationLevel: "instruction-only",
    shippedBytesDigest: result.shippedBytesDigest,
    installedBytesDigest: result.installedBytesDigest,
    provenanceStatus: result.provenanceStatus,
    cause: result.cause,
  };
}

function safeRelativeName(name: string): string | null {
  const normalized = name.replaceAll("\\", "/");
  if (normalized.length === 0 || normalized.length > 240) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
  return normalized;
}

function resolveInsideRoot(root: string, relativePath: string): string | null {
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) return null;
  const normalized = safeRelativeName(relativePath);
  if (normalized === null) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(base, normalized);
  const relative = path.relative(base, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

function reviewerMechanism(mechanismId: HarnessReviewerMechanismId): { readonly assetPath?: string } | undefined {
  for (const host of harnessSurfaceRegistry.hosts) {
    const mechanism = host.reviewerMechanisms.find((candidate) => candidate.id === mechanismId);
    if (mechanism !== undefined) return mechanism;
  }
  return undefined;
}

function packageRootFrom(location: ReviewerDefinitionLocation): string | null {
  if (location.packageRoot === undefined) return reviewerDefinitionPackageRoot();
  if (location.packageRoot.trim() === "") return null;
  return location.packageRoot;
}

async function readRegularFile(file: string): Promise<RegularFileRead> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(file);
  } catch (error) {
    if (absent(error)) return { kind: "missing", cause: errorCode(error) ?? "ENOENT" };
    return { kind: "unavailable", cause: errorCode(error) ?? "inspection-error" };
  }
  if (stats.isSymbolicLink()) return { kind: "unavailable", cause: "symlink" };
  if (!stats.isFile()) return { kind: "unavailable", cause: "not-a-file" };
  try {
    const parent = await lstat(path.dirname(file));
    if (parent.isSymbolicLink()) return { kind: "unavailable", cause: "symlink" };
  } catch (error) {
    return { kind: "unavailable", cause: errorCode(error) ?? "inspection-error" };
  }
  try {
    return { kind: "bytes", bytes: await readFile(file) };
  } catch (error) {
    return { kind: "unavailable", cause: errorCode(error) ?? "inspection-error" };
  }
}

async function readProvenanceStatus(
  file: string,
  oneFileRelativeName: string,
  installedBytes: Buffer,
): Promise<{ readonly provenanceStatus: ReviewerProvenanceStatus; readonly recordedVersion: string | null }> {
  const name = safeRelativeName(oneFileRelativeName);
  if (name === null) return { provenanceStatus: "unreadable", recordedVersion: null };
  const read = await readRegularFile(file);
  if (read.kind === "missing") return { provenanceStatus: "missing", recordedVersion: null };
  if (read.kind === "unavailable") return { provenanceStatus: "unreadable", recordedVersion: null };
  const parsed = parseProvenance(read.bytes.toString("utf8"));
  if (parsed === null) return { provenanceStatus: "invalid", recordedVersion: null };
  const actual = digestOneFile(name, installedBytes);
  return {
    provenanceStatus: parsed.skillTreeDigest === actual ? "match" : "mismatch",
    recordedVersion: parsed.version,
  };
}

async function assessReviewerFile(input: {
  readonly installedPath: string;
  readonly provenancePath: string | null;
  readonly oneFileRelativeName: string | null;
  readonly expectedShippedBytesDigest: string;
}): Promise<ReviewerAssessment> {
  const read = await readRegularFile(input.installedPath);
  if (read.kind === "missing") {
    return reviewerAssessment("missing", { shippedBytesDigest: input.expectedShippedBytesDigest });
  }
  if (read.kind === "unavailable") {
    return reviewerAssessment("unavailable", { shippedBytesDigest: input.expectedShippedBytesDigest, cause: read.cause });
  }
  const installedBytesDigest = digestFileBytes(read.bytes);
  const bytesMatch = installedBytesDigest === input.expectedShippedBytesDigest;
  const provenance = input.provenancePath === null
    ? { provenanceStatus: "not-applicable" as const, recordedVersion: null }
    : await readProvenanceStatus(input.provenancePath, input.oneFileRelativeName ?? "", read.bytes);
  return reviewerAssessment(bytesMatch ? "matched" : "drifted", {
    shippedBytesDigest: input.expectedShippedBytesDigest,
    installedBytesDigest,
    provenanceStatus: provenance.provenanceStatus,
    recordedVersion: provenance.recordedVersion,
    realPath: input.installedPath,
    cause: bytesMatch ? null : "installed-bytes-differ",
  });
}

function provenanceCause(status: ReviewerProvenanceStatus): string | null {
  if (status === "invalid") return "invalid-provenance";
  if (status === "mismatch") return "provenance-digest-mismatch";
  if (status === "missing") return "provenance-missing";
  if (status === "unreadable") return "provenance-unreadable";
  return null;
}

function mapReviewerHealth(
  asset: InstalledAssetDeclaration,
  vault: string,
  result: ReviewerAssessment,
): InstalledAssetHealth {
  const provenanceAgrees = result.provenanceStatus === "match" || result.provenanceStatus === "not-applicable";
  const bytesMatch = result.disposition === "matched";
  const evidence = bytesMatch || result.disposition === "drifted"
    ? {
        packageVersion: asset.provenanceVersion ?? null,
        recordedVersion: result.recordedVersion,
        digestMatch: bytesMatch && provenanceAgrees,
      }
    : undefined;
  if (result.disposition === "missing") return health(asset, vault, "missing", null, "ENOENT");
  if (bytesMatch && provenanceAgrees) return health(asset, vault, "ok", result.realPath, null, evidence);
  if (bytesMatch || result.disposition === "drifted") {
    const cause = result.disposition === "drifted" ? result.cause : provenanceCause(result.provenanceStatus);
    return health(asset, vault, "provenance-mismatch", result.realPath, cause, evidence);
  }
  const state = result.cause === "not-a-file" ? "not-a-file" as const : "inspection-error" as const;
  return health(asset, vault, state, null, result.cause);
}

async function inspectDeclaredReviewer(asset: InstalledAssetDeclaration, vault: string): Promise<InstalledAssetHealth> {
  if (asset.expectedShippedBytesDigest === undefined || asset.expectedShippedBytesDigest === "") {
    return health(asset, vault, "inspection-error", null, "expected-shipped-bytes-digest-missing");
  }
  if (asset.provenancePath !== undefined && (asset.oneFileRelativeName === undefined || safeRelativeName(asset.oneFileRelativeName) === null)) {
    return health(asset, vault, "inspection-error", null, "one-file-name-not-declared");
  }
  const result = await assessReviewerFile({
    installedPath: asset.declaredPath,
    provenancePath: asset.provenancePath ?? null,
    oneFileRelativeName: asset.oneFileRelativeName ?? null,
    expectedShippedBytesDigest: asset.expectedShippedBytesDigest,
  });
  return mapReviewerHealth(asset, vault, result);
}

/**
 * Compare one registry-shipped reviewer definition with its trusted install.
 * Does not launch a model, write an install, or read vault notes.
 * Hermes and the generic Codex subagent have no asset and return not-applicable.
 */
export async function inspectReviewerDefinitionAtRest(
  mechanismId: HarnessReviewerMechanismId,
  location: ReviewerDefinitionLocation = {},
): Promise<ReviewerDefinitionAtRest> {
  const mechanism = reviewerMechanism(mechanismId);
  if (mechanism === undefined) {
    return definitionReceipt(mechanismId, reviewerAssessment("unavailable", { cause: "unknown-mechanism" }));
  }
  const assetPath = mechanism.assetPath;
  if (assetPath === undefined || assetPath.trim() === "") {
    return definitionReceipt(mechanismId, reviewerAssessment("not-applicable"));
  }
  const trusted = TRUSTED_REVIEWER_INSTALLS[mechanismId];
  if (trusted === undefined) {
    return definitionReceipt(mechanismId, reviewerAssessment("unavailable", { cause: "trusted-installed-path-not-declared" }));
  }
  const packageRoot = packageRootFrom(location);
  if (packageRoot === null) {
    return definitionReceipt(mechanismId, reviewerAssessment("unavailable", { cause: "invalid-package-root" }));
  }
  const sourcePath = resolveInsideRoot(packageRoot, assetPath);
  if (sourcePath === null) {
    return definitionReceipt(mechanismId, reviewerAssessment("unavailable", { cause: "source-path-escaped" }));
  }
  const source = await readRegularFile(sourcePath);
  if (source.kind === "missing") {
    return definitionReceipt(mechanismId, reviewerAssessment("unavailable", { cause: "shipped-source-missing" }));
  }
  if (source.kind === "unavailable") {
    return definitionReceipt(mechanismId, reviewerAssessment("unavailable", { cause: source.cause }));
  }
  const home = hostHome(location.homeDir, trusted.dirname, trusted.envName);
  const installedPath = resolveInsideRoot(home, trusted.installedRelativePath);
  const provenancePath = trusted.provenanceRelativePath === null ? null : resolveInsideRoot(home, trusted.provenanceRelativePath);
  if (installedPath === null || (trusted.provenanceRelativePath !== null && provenancePath === null)) {
    return definitionReceipt(mechanismId, reviewerAssessment("unavailable", {
      shippedBytesDigest: digestFileBytes(source.bytes),
      cause: "source-path-escaped",
    }));
  }
  return definitionReceipt(mechanismId, await assessReviewerFile({
    installedPath,
    provenancePath,
    oneFileRelativeName: trusted.oneFileRelativeName,
    expectedShippedBytesDigest: digestFileBytes(source.bytes),
  }));
}

async function inspectAsset(asset: InstalledAssetDeclaration, vault: string): Promise<InstalledAssetHealth> {
  if (asset.kind === "reviewer-definition") return inspectDeclaredReviewer(asset, vault);
  if (asset.kind === "registration") {
    const evidence = asset.evidence ?? { state: "missing" as const, cause: null };
    return health(asset, vault, evidence.state, null, evidence.cause);
  }
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(asset.declaredPath);
  } catch (error) {
    return health(asset, vault, absent(error) ? "missing" : "inspection-error", null, errorCode(error));
  }
  let resolved: string;
  try {
    resolved = await realpath(asset.declaredPath);
  } catch (error) {
    return health(asset, vault, entry.isSymbolicLink() && absent(error) ? "dangling-symlink" : "inspection-error", null, errorCode(error));
  }
  let target: Awaited<ReturnType<typeof stat>>;
  try {
    target = await stat(asset.declaredPath);
  } catch (error) {
    return health(asset, vault, entry.isSymbolicLink() && absent(error) ? "dangling-symlink" : "inspection-error", null, errorCode(error));
  }
  if (asset.kind === "skill-tree") {
    if (!target.isDirectory()) return health(asset, vault, "not-a-file", resolved, null);
    try {
      const provenance = asset.provenancePath === undefined ? null : parseProvenance(await readFile(asset.provenancePath, "utf8"));
      const digest = await computeTreeDigest(resolved);
      const evidence = {
        packageVersion: asset.provenanceVersion ?? null,
        recordedVersion: provenance?.version ?? null,
        digestMatch: provenance === null ? false : provenance.skillTreeDigest === digest,
      };
      if (
        provenance === null ||
        !evidence.digestMatch ||
        (asset.provenanceVersion !== undefined && provenance.version !== asset.provenanceVersion)
      ) return health(asset, vault, "provenance-mismatch", resolved, null, evidence);
      return health(asset, vault, "ok", resolved, null, evidence);
    } catch (error) {
      return health(asset, vault, absent(error) ? "provenance-mismatch" : "inspection-error", resolved, errorCode(error), {
        packageVersion: asset.provenanceVersion ?? null,
        recordedVersion: null,
        digestMatch: false,
      });
    }
  }
  if (!target.isFile()) return health(asset, vault, "not-a-file", resolved, null);
  if ((target.mode & 0o111) === 0) return health(asset, vault, "not-executable", resolved, null);
  return health(asset, vault, "ok", resolved, null);
}

export async function inspectInstalledAssets(options: InstalledAssetInspectionOptions = {}): Promise<InstalledAssetInspection> {
  const declarations = options.assets ?? [];
  const assets = await Promise.all(declarations.map(asset => inspectAsset(asset, options.vault ?? process.cwd())));
  const hostDeclarations = options.hosts ?? [...new Set(declarations.flatMap(asset => asset.host === undefined ? [] : [asset.host]))].map(host => ({ host, state: "ok" as const }));
  const hosts: InstalledHostHealth[] = hostDeclarations.map((host): InstalledHostHealth => {
    const hostAssets = assets.filter((_, index) => declarations[index]?.host === host.host);
    if (host.state === "not-installed") return host;
    return { host: host.host, state: host.state === "degraded" || !hostAssets.every(asset => asset.state === "ok") ? "degraded" : "ok" };
  });
  return { status: assets.every(asset => asset.state === "ok") && hosts.every(host => host.state !== "degraded") ? "ok" : "degraded", hosts, assets };
}
