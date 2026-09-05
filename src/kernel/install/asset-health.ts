import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { computeTreeDigest, parseProvenance } from "./provenance.js";

export type InstalledAssetKind = "hook" | "binary" | "skill-tree" | "registration";
export type InstalledAssetState = "ok" | "missing" | "dangling-symlink" | "not-executable" | "not-a-file" | "provenance-mismatch" | "inspection-error";
export type InstalledHostState = "not-installed" | "ok" | "degraded";

export interface InstalledAssetDeclaration {
  readonly id: string;
  readonly kind: InstalledAssetKind;
  readonly declaredPath: string;
  readonly host?: string;
  readonly provenancePath?: string;
  /** Expected source version for a provenance-backed asset, injected by the composition root. */
  readonly provenanceVersion?: string;
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

export function installRemediationCommand(vault: string, host: string): string {
  return `oms host install --runtime ${host} --vault ${JSON.stringify(vault)}`;
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

async function inspectAsset(asset: InstalledAssetDeclaration, vault: string): Promise<InstalledAssetHealth> {
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
