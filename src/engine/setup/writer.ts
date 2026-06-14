/**
 * Non-Sticky Guard: taxonomy output writer.
 *
 * HARD CONSTRAINT: writes ONLY to vault/.oms/taxonomy.yaml.
 * Writing to core/ontology/taxonomy.yaml or any engine path is FORBIDDEN.
 * This constraint is enforced by construction — the path is always derived
 * from vaultRoot and validated before any disk I/O.
 *
 * Self-reimplementation of the omc deep-interview methodology — no code copied.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import type { TaxonomyOutput } from "./types.js";

/** Relative path from vault root to the override file (always this, never engine default). */
const VAULT_OVERRIDE_RELATIVE = path.join(".oms", "taxonomy.yaml");

/**
 * Resolve the canonical vault override path: `{vaultRoot}/.oms/taxonomy.yaml`.
 *
 * Enforces path confinement: the resolved path must start with the `.oms` dir
 * inside vaultRoot. Throws if path traversal is detected.
 */
export function resolveVaultOverridePath(vaultRoot: string): string {
  const omsDir = path.resolve(vaultRoot, ".oms");
  const target = path.resolve(vaultRoot, VAULT_OVERRIDE_RELATIVE);

  // Confinement check: target must be inside {vaultRoot}/.oms/
  if (!target.startsWith(omsDir + path.sep) && target !== omsDir) {
    throw new Error(
      `[Non-Sticky Guard] Resolved path "${target}" escapes the vault override zone "${omsDir}". Write refused.`
    );
  }

  return target;
}

/**
 * Guard: throw if targetPath matches the engine default fragment.
 * Called before any disk write.
 */
function guardAgainstEngineDefault(targetPath: string): void {
  // Normalise to forward slashes for cross-platform fragment matching.
  const normalised = targetPath.replace(/\\/g, "/");
  if (normalised.includes("core/ontology/taxonomy.yaml")) {
    throw new Error(
      `[Non-Sticky Guard] Writing to engine default "core/ontology/taxonomy.yaml" is FORBIDDEN. ` +
        `Use vault/.oms/taxonomy.yaml instead.`
    );
  }
}

/**
 * Write the resolved taxonomy output to `{vaultRoot}/.oms/taxonomy.yaml`.
 *
 * Non-Sticky Guard is enforced by construction:
 *   1. resolveVaultOverridePath() confines the target to {vaultRoot}/.oms/.
 *   2. guardAgainstEngineDefault() rejects any path matching the engine default.
 *   3. Only after both checks pass does disk I/O proceed.
 *
 * Merges with any existing file — keys not present in `data` are preserved.
 * Always sets `version: 1`.
 *
 * Returns the absolute path that was written.
 */
export async function writeTaxonomyToVaultOverride(
  vaultRoot: string,
  data: TaxonomyOutput
): Promise<string> {
  const targetPath = resolveVaultOverridePath(vaultRoot);
  guardAgainstEngineDefault(targetPath);

  // Read existing file if present, then shallow-merge (data wins on conflict).
  let merged: Record<string, unknown> = {};
  try {
    const existing = await readFile(targetPath, "utf8");
    const parsed = yamlParse(existing);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      merged = parsed as Record<string, unknown>;
    }
  } catch {
    // File does not exist yet — start from empty.
  }

  // Spread data over existing, always forcing version: 1.
  const output: Record<string, unknown> = { ...merged, ...data, version: 1 };

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, yamlStringify(output, { lineWidth: 120 }), "utf8");

  return targetPath;
}
