import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { OmsbConfig } from "../rules/types.js";

export interface QmdStatus {
  installed: boolean;
  collections: string[];
  missingPaths: string[];
  message: string;
}

/**
 * Check if qmd CLI is installed and available.
 */
export function isQmdInstalled(): boolean {
  try {
    execSync("qmd --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get current qmd collections (directories it indexes).
 * Parses qmd config or status output.
 */
export function getQmdCollections(): string[] {
  try {
    const output = execSync("qmd collections list", {
      stdio: "pipe",
      encoding: "utf-8",
    });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && path.isAbsolute(line));
  } catch {
    return [];
  }
}

/**
 * Check if OMSB compile output paths are in qmd collections.
 * Returns status object with advisory message.
 */
export function ensureQmdCollections(config: OmsbConfig): QmdStatus {
  if (!isQmdInstalled()) {
    return {
      installed: false,
      collections: [],
      missingPaths: [],
      message:
        "qmd is not installed. Install it for enhanced vault search: npm install -g qmd",
    };
  }

  const collections = getQmdCollections();
  const vaultPath = config.vault_path;

  const pathsToCheck = [vaultPath];
  const missingPaths = pathsToCheck.filter((p) => {
    const resolved = path.resolve(p);
    return (
      fs.existsSync(resolved) &&
      !collections.some(
        (c) => path.resolve(c) === resolved || path.resolve(c) === resolved
      )
    );
  });

  if (missingPaths.length === 0) {
    return {
      installed: true,
      collections,
      missingPaths: [],
      message: "qmd is installed and vault path is indexed.",
    };
  }

  return {
    installed: true,
    collections,
    missingPaths,
    message: `[OMSB] qmd is installed but the following paths are not in any collection: ${missingPaths.join(", ")}. Run: qmd collections add <path>`,
  };
}

/**
 * Search the vault using qmd.
 * Returns search results or advisory if qmd is not available.
 */
export function searchVault(
  query: string,
  options?: { limit?: number }
): string {
  if (!isQmdInstalled()) {
    return "[OMSB] qmd not installed. Search unavailable.";
  }

  try {
    const limit = options?.limit ?? 10;
    const result = execSync(
      `qmd query ${JSON.stringify(query)} --limit ${limit}`,
      {
        stdio: "pipe",
        encoding: "utf-8",
      }
    );
    return result;
  } catch (err) {
    return `[OMSB] Search failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
