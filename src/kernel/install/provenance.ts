import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface OmsInstallProvenance {
  readonly schemaVersion: 1;
  readonly source: "npm";
  readonly version: string;
  readonly skillTreeDigest: string;
  readonly installedAt: string;
}

/** Parses a provenance record without rejecting harmless unknown fields. */
export function parseProvenance(raw: string): OmsInstallProvenance | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record["schemaVersion"] !== 1 ||
    record["source"] !== "npm" ||
    typeof record["version"] !== "string" ||
    typeof record["skillTreeDigest"] !== "string" ||
    typeof record["installedAt"] !== "string"
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    source: "npm",
    version: record["version"],
    skillTreeDigest: record["skillTreeDigest"],
    installedAt: record["installedAt"],
  };
}

export function serializeProvenance(provenance: OmsInstallProvenance): string {
  return `${JSON.stringify(provenance, null, 2)}\n`;
}

/** Deterministic content digest of a file tree: sorted relative paths + bytes. */
export async function computeTreeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else {
        hash.update(path.relative(root, absolute));
        hash.update("\0");
        hash.update(await readFile(absolute));
        hash.update("\0");
      }
    }
  };
  await walk(root);
  return hash.digest("hex");
}

export type OwnershipDecision = {
  readonly action: "install" | "noop" | "replace" | "reject-foreign" | "reject-newer" | "adopt-legacy-candidate";
  readonly reason: string;
};

/** Decides whether an existing install can be safely reconciled. */
export function decideOwnership(
  existing: OmsInstallProvenance | null,
  expected: { readonly version: string; readonly skillTreeDigest: string },
  actualTreeDigest: string | null,
): OwnershipDecision {
  if (existing === null) {
    if (actualTreeDigest === null) {
      return { action: "install", reason: "No installed tree or provenance record exists." };
    }
    if (actualTreeDigest === expected.skillTreeDigest) {
      return {
        action: "adopt-legacy-candidate",
        reason: "The unrecorded installed tree matches the expected package tree.",
      };
    }
    return {
      action: "reject-foreign",
      reason: "An installed tree exists without valid OMS npm provenance.",
    };
  }

  if (compareSemver(existing.version, expected.version) > 0) {
    return {
      action: "reject-newer",
      reason: "The installed npm provenance version is newer than this package.",
    };
  }
  if (
    existing.version === expected.version &&
    existing.skillTreeDigest === expected.skillTreeDigest &&
    actualTreeDigest === expected.skillTreeDigest
  ) {
    return { action: "noop", reason: "Recorded and observed npm install identities match." };
  }
  return { action: "replace", reason: "Recorded or observed npm install identity has drifted." };
}

/** Compares SemVer versions without importing update orchestration. Invalid values sort equally. */
function compareSemver(left: string, right: string): number {
  const parse = (value: string): { core: number[]; prerelease: string[] } | null => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
    if (!match) return null;
    return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split(".") ?? [] };
  };
  const a = parse(left);
  const b = parse(right);
  if (a === null || b === null) return 0;
  for (let index = 0; index < a.core.length; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index]! > b.core[index]! ? 1 : -1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined || bPart === undefined) return aPart === undefined ? -1 : 1;
    if (aPart === bPart) continue;
    const aNumber = /^\d+$/.test(aPart);
    const bNumber = /^\d+$/.test(bPart);
    if (aNumber && bNumber) return Number(aPart) > Number(bPart) ? 1 : -1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return aPart > bPart ? 1 : -1;
  }
  return 0;
}
