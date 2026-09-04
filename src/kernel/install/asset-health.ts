import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { harnessSurfaceRegistry } from "../harness/surface-registry.js";
import { hostHome } from "./common.js";
import { computeTreeDigest, parseProvenance } from "./provenance.js";

export type InstalledAssetKind = "hook" | "binary" | "skill-tree";
export type InstalledAssetState = "ok" | "missing" | "dangling-symlink" | "not-executable" | "not-a-file" | "provenance-mismatch";

export interface InstalledAssetDeclaration {
  readonly id: string;
  readonly kind: InstalledAssetKind;
  readonly declaredPath: string;
  readonly provenancePath?: string;
  readonly remediation?: string;
}

export interface InstalledAssetHealth {
  readonly id: string;
  readonly kind: InstalledAssetKind;
  readonly declaredPath: string;
  readonly realPath: string | null;
  readonly state: InstalledAssetState;
  readonly remediation: string;
}

export interface InstalledAssetInspectionOptions {
  readonly assets?: readonly InstalledAssetDeclaration[];
  readonly hostHomes?: Readonly<Partial<Record<"claude" | "codex" | "hermes", string>>>;
  readonly registry?: typeof harnessSurfaceRegistry;
  readonly packageRoot?: string;
  readonly binaryDirectories?: readonly string[];
}

export interface InstalledAssetInspection {
  readonly status: "ok" | "degraded";
  readonly assets: readonly InstalledAssetHealth[];
}

function packageRoot(): string {
  return path.dirname(fileURLToPath(new URL("../../../package.json", import.meta.url)));
}

function remediation(asset: InstalledAssetDeclaration): string {
  if (asset.remediation !== undefined) return asset.remediation;
  return asset.kind === "skill-tree" ? "oms install --host hermes" : "oms install --host claude";
}

async function binaryPath(binaryDirectories: readonly string[], binary: string, fallback: string): Promise<string> {
  for (const directory of binaryDirectories) {
    const candidate = path.join(directory, binary);
    try {
      await lstat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return path.join(binaryDirectories[0] ?? fallback, binary);
}

async function defaultAssets(options: InstalledAssetInspectionOptions): Promise<readonly InstalledAssetDeclaration[]> {
  const registry = options.registry ?? harnessSurfaceRegistry;
  const root = options.packageRoot ?? packageRoot();
  const binaryDirectories = options.binaryDirectories ?? (process.env.PATH?.split(path.delimiter) ?? []);
  const hermesHome = options.hostHomes?.hermes ?? hostHome(undefined, ".hermes", "OMS_HERMES_HOME");
  const hooks = await Promise.all(registry.hooks.map(async hook => [
    { id: `hook:${hook.bin}`, kind: "hook" as const, declaredPath: path.join(root, hook.path) },
    { id: `binary:${hook.bin}`, kind: "binary" as const, declaredPath: await binaryPath(binaryDirectories, hook.bin, root) },
  ]));
  return [
    ...hooks.flat(),
    {
      id: "skill-tree:hermes",
      kind: "skill-tree",
      declaredPath: path.join(hermesHome, "skills", "knowledge-management", "oms"),
      provenancePath: path.join(hermesHome, "adapters", "oms", "oms-provenance.json"),
    },
  ];
}

function missingHealth(asset: InstalledAssetDeclaration, state: "missing" | "dangling-symlink"): InstalledAssetHealth {
  return { id: asset.id, kind: asset.kind, declaredPath: asset.declaredPath, realPath: null, state, remediation: remediation(asset) };
}

async function inspectAsset(asset: InstalledAssetDeclaration): Promise<InstalledAssetHealth> {
  let entry;
  try {
    entry = await lstat(asset.declaredPath);
  } catch {
    return missingHealth(asset, "missing");
  }
  let resolved: string;
  try {
    resolved = await realpath(asset.declaredPath);
  } catch {
    return missingHealth(asset, entry.isSymbolicLink() ? "dangling-symlink" : "missing");
  }
  let target;
  try {
    target = await stat(asset.declaredPath);
  } catch {
    return missingHealth(asset, entry.isSymbolicLink() ? "dangling-symlink" : "missing");
  }
  if (asset.kind === "skill-tree") {
    if (!target.isDirectory()) {
      return { id: asset.id, kind: asset.kind, declaredPath: asset.declaredPath, realPath: resolved, state: "not-a-file", remediation: remediation(asset) };
    }
    if (asset.provenancePath !== undefined) {
      try {
        const provenance = parseProvenance(await readFile(asset.provenancePath, "utf8"));
        if (provenance === null || provenance.skillTreeDigest !== await computeTreeDigest(resolved)) {
          return { id: asset.id, kind: asset.kind, declaredPath: asset.declaredPath, realPath: resolved, state: "provenance-mismatch", remediation: remediation(asset) };
        }
      } catch {
        return { id: asset.id, kind: asset.kind, declaredPath: asset.declaredPath, realPath: resolved, state: "provenance-mismatch", remediation: remediation(asset) };
      }
    }
    return { id: asset.id, kind: asset.kind, declaredPath: asset.declaredPath, realPath: resolved, state: "ok", remediation: "" };
  }
  if (!target.isFile()) {
    return { id: asset.id, kind: asset.kind, declaredPath: asset.declaredPath, realPath: resolved, state: "not-a-file", remediation: remediation(asset) };
  }
  if ((target.mode & 0o111) === 0) {
    return { id: asset.id, kind: asset.kind, declaredPath: asset.declaredPath, realPath: resolved, state: "not-executable", remediation: remediation(asset) };
  }
  return { id: asset.id, kind: asset.kind, declaredPath: asset.declaredPath, realPath: resolved, state: "ok", remediation: "" };
}

export async function inspectInstalledAssets(options: InstalledAssetInspectionOptions = {}): Promise<InstalledAssetInspection> {
  const declarations = options.assets ?? await defaultAssets(options);
  const assets = await Promise.all(declarations.map(inspectAsset));
  return { status: assets.every(asset => asset.state === "ok") ? "ok" : "degraded", assets };
}
