import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface OmsInstallProvenance {
  readonly schemaVersion: 1;
  readonly source: "npm";
  readonly version: string;
  readonly treeDigest: string;
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
    typeof record["treeDigest"] !== "string" ||
    typeof record["installedAt"] !== "string"
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    source: "npm",
    version: record["version"],
    treeDigest: record["treeDigest"],
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
  readonly action: "install" | "noop" | "replace" | "reject-foreign" | "adopt-legacy-candidate";
  readonly reason: string;
};

/** Decides whether an existing install can be safely reconciled. */
export function decideOwnership(
  existing: OmsInstallProvenance | null,
  expected: { readonly version: string; readonly treeDigest: string },
  actualTreeDigest: string | null,
): OwnershipDecision {
  if (existing === null) {
    if (actualTreeDigest === null) {
      return { action: "install", reason: "No installed tree or provenance record exists." };
    }
    if (actualTreeDigest === expected.treeDigest) {
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

  if (
    existing.version === expected.version &&
    existing.treeDigest === expected.treeDigest &&
    actualTreeDigest === expected.treeDigest
  ) {
    return { action: "noop", reason: "Recorded and observed npm install identities match." };
  }
  return { action: "replace", reason: "Recorded or observed npm install identity has drifted." };
}
