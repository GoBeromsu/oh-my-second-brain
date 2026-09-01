import { lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

/**
 * Cross-repo vault bridge.
 *
 * Two distinct `.oms/` profiles exist, distinguished by content:
 *
 *   - Vault `.oms/`  — template-first controls: `template-policy.json`,
 *                      `taxonomy.json`, and derived `types.json`.
 *                      Written by `oms setup`. Owned by the user's Obsidian vault.
 *   - Bridge `.oms/` — a link into a vault from some *other* repo (e.g. a GitHub
 *                      project). Holds NO convention yaml; only `links.yaml`
 *                      (vault path + scope) plus gitignored `linked/<name>`
 *                      symlinks so any agent/indexer can read the scoped vault
 *                      folders transparently. Written by `oms link`.
 *
 * The convention yaml is never duplicated into a bridge repo — that would split
 * the single source of truth. A bridge resolves the real vault and loads *its*
 * `.oms/` ontology.
 */

/** Schema version for `.oms/links.yaml`. */
export const LINK_RECORD_VERSION = 1;

/** Relative path (from a bridge repo root) holding the vault symlinks. */
export const LINKED_DIR_RELATIVE = path.join(".oms", "linked");

/** `.gitignore` pattern that keeps the symlinks out of the published repo. */
export const LINKED_GITIGNORE_PATTERN = ".oms/linked/";

export interface LinkRecord {
  version: number;
  /** Absolute (or `~`-prefixed) path to the vault root this repo bridges to. */
  vault: string;
  /** Vault folders (top-level names or nested subpaths) this repo may reach. */
  scope: string[];
}

export type VaultSource = "vault" | "bridge" | "env" | "cwd";

export interface ResolvedVault {
  /** Effective vault root — where the `.oms/` ontology lives. */
  vault: string;
  /**
   * Allowed vault folders. `null` means unrestricted (the start dir IS the
   * vault, or resolution fell back to env/cwd). A bridge yields the declared
   * scope (possibly empty).
   */
  scope: string[] | null;
  source: VaultSource;
}

export interface CreateVaultLinkOptions {
  /** Bridge repo root (where `.oms/` is created). */
  cwd: string;
  /** Target vault root to link into. */
  vault: string;
  /** Vault folders to expose (top-level or nested subpaths). Must be non-empty. */
  folders: string[];
}

export interface CreateVaultLinkResult {
  /** Absolute path to the bridge `.oms/` directory. */
  omsDir: string;
  /** Absolute path to the written `links.yaml`. */
  recordPath: string;
  /** Symlinks created or refreshed this run, as `linked/<name>` relatives. */
  linked: string[];
  /** Symlinks already present and correct (left untouched). */
  unchanged: string[];
  /** Whether `.gitignore` was modified to ignore the symlinks. */
  gitignoreUpdated: boolean;
  /** The merged record persisted to disk. */
  record: LinkRecord;
}

/** Expand a leading `~/` to the user's home directory, then resolve. */
export function expandHome(target: string): string {
  if (target === "~") return os.homedir();
  if (target.startsWith("~/") || target.startsWith(`~${path.sep}`)) {
    return path.resolve(path.join(os.homedir(), target.slice(2)));
  }
  return path.resolve(target);
}

async function pathKind(
  target: string,
): Promise<"missing" | "file" | "directory" | "symlink" | "other"> {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

function parseScope(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Read a bridge link record from `<omsDir>/links.yaml`.
 * Returns `null` only when the file is missing; a present-but-invalid bridge
 * record is a configuration error and must not silently fall back to cwd/env.
 */
export async function readLinkRecord(omsDir: string): Promise<LinkRecord | null> {
  const recordPath = path.join(omsDir, "links.yaml");
  let raw: string;
  try {
    raw = await readFile(recordPath, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let parsed: Record<string, unknown> | null;
  try {
    parsed = yamlParse(raw) as Record<string, unknown> | null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[oms] Invalid bridge record at ${recordPath}: links.yaml is not valid YAML (${message}). Re-run oms link to repair it.`);
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`[oms] Invalid bridge record at ${recordPath}: expected a YAML mapping with vault and scope.`);
  }

  const vault = parsed["vault"];
  if (typeof vault !== "string" || vault.trim().length === 0) {
    throw new Error(`[oms] Invalid bridge record at ${recordPath}: missing required string field "vault". Re-run oms link to repair it.`);
  }
  if (parsed["scope"] !== undefined && !Array.isArray(parsed["scope"])) {
    throw new Error(`[oms] Invalid bridge record at ${recordPath}: field "scope" must be a list.`);
  }

  return {
    version: typeof parsed["version"] === "number" ? parsed["version"] : LINK_RECORD_VERSION,
    vault: vault.trim(),
    scope: parseScope(parsed["scope"]),
  };
}

/** Write a bridge link record to `<omsDir>/links.yaml` (creates `<omsDir>`). */
export async function writeLinkRecord(omsDir: string, record: LinkRecord): Promise<string> {
  await mkdir(omsDir, { recursive: true });
  const recordPath = path.join(omsDir, "links.yaml");
  await writeFile(recordPath, yamlStringify(record), "utf-8");
  return recordPath;
}

/**
 * Resolve the effective vault root for a command invoked from `startDir`.
 *
 * Precedence (content-based, so the two `.oms/` profiles never collide):
 *   1. Local template convention (`.oms/template-policy.json` or
 *      `.oms/taxonomy.json`)                                        → vault.
 *   2. Local bridge (`.oms/links.yaml`)                              → bridge.
 *   3. `OMS_VAULT` environment variable                             → env.
 *   4. Fallback to `startDir`                                       → cwd.
 */
export async function resolveEffectiveVault(
  startDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ResolvedVault> {
  const omsDir = path.join(startDir, ".oms");

  const policyKind = await pathKind(path.join(omsDir, "template-policy.json"));
  const taxonomyKind = await pathKind(path.join(omsDir, "taxonomy.json"));
  if (policyKind === "file" || taxonomyKind === "file") {
    return { vault: path.resolve(startDir), scope: null, source: "vault" };
  }

  const record = await readLinkRecord(omsDir);
  if (record) {
    const resolvedVault = expandHome(record.vault);
    if ((await pathKind(resolvedVault)) !== "directory") {
      throw new Error(`[oms] Linked vault path does not exist or is not a directory: ${resolvedVault}. Re-run oms link with a valid --vault.`);
    }
    return { vault: resolvedVault, scope: record.scope, source: "bridge" };
  }

  const envVault = env["OMS_VAULT"];
  if (envVault && envVault.trim().length > 0) {
    return { vault: expandHome(envVault), scope: null, source: "env" };
  }

  return { vault: path.resolve(startDir), scope: null, source: "cwd" };
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

  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(pattern.trim())) return false;

  const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  const block = existing.length === 0 ? `${pattern}\n` : `# Oh My Second Brain vault bridge (machine-local)\n${pattern}\n`;
  await writeFile(gitignorePath, `${prefix}${block}`, "utf-8");
  return true;
}

/**
 * Resolve a user-supplied `--folder` spec (a top-level name OR a nested vault
 * subpath like `15. Work/01 Project/Foo`) into its absolute target, normalized
 * relative scope entry, and the basename used for the `linked/<name>` symlink.
 * Rejects absolute paths and any spec that escapes the vault root.
 */
function resolveLinkFolder(
  vaultRoot: string,
  folder: string,
): { rel: string; target: string; linkName: string } {
  if (path.isAbsolute(folder)) {
    throw new Error(`[oms] Folder must be relative to the vault, not absolute: ${folder}`);
  }
  const rel = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const target = path.resolve(vaultRoot, rel);
  if (rel.length === 0 || target === vaultRoot) {
    throw new Error("[oms] Folder must name a vault subfolder, not the vault root.");
  }
  if (!target.startsWith(vaultRoot + path.sep)) {
    throw new Error(`[oms] Folder escapes the vault: ${folder}`);
  }
  const linkName = path.basename(target);
  if (linkName.length === 0 || linkName === "." || linkName === "..") {
    throw new Error(`[oms] Cannot derive a link name from folder: ${folder}`);
  }
  return { rel, target, linkName };
}

/**
 * Create (or refresh) a vault bridge in `cwd`:
 *   - validates the vault and each requested folder,
 *   - creates gitignored `.oms/linked/<name>` symlinks into the vault (top-level
 *     folders or nested subpaths; the symlink name is the folder basename),
 *   - merges the vault path + folders into `.oms/links.yaml`,
 *   - ensures `.gitignore` excludes the symlinks.
 *
 * Idempotent: re-linking an identical folder is a no-op; an existing real
 * (non-symlink) file at a target path is refused rather than clobbered.
 */
export async function createVaultLink(opts: CreateVaultLinkOptions): Promise<CreateVaultLinkResult> {
  const repoRoot = path.resolve(opts.cwd);
  // A relative vault path resolves against the bridge repo root, not the
  // process cwd — `oms link --vault ../my-vault` means "relative to here".
  const vaultRoot =
    path.isAbsolute(opts.vault) || opts.vault.startsWith("~")
      ? expandHome(opts.vault)
      : path.resolve(repoRoot, opts.vault);

  if ((await pathKind(vaultRoot)) !== "directory") {
    throw new Error(`[oms] Vault path is not a directory: ${vaultRoot}`);
  }

  const folders = Array.from(
    new Set(opts.folders.map((folder) => folder.trim()).filter((folder) => folder.length > 0)),
  );
  if (folders.length === 0) {
    throw new Error("[oms] At least one --folder is required to create a vault link.");
  }

  const specs = folders.map((folder) => resolveLinkFolder(vaultRoot, folder));
  const byName = new Map<string, string>();
  for (const spec of specs) {
    const prior = byName.get(spec.linkName);
    if (prior !== undefined && prior !== spec.rel) {
      throw new Error(
        `[oms] Link name collision: "${spec.linkName}" maps to both "${prior}" and "${spec.rel}". Link them separately.`,
      );
    }
    byName.set(spec.linkName, spec.rel);
    if ((await pathKind(spec.target)) !== "directory") {
      throw new Error(`[oms] Vault folder does not exist: ${spec.target}`);
    }
  }

  const omsDir = path.join(repoRoot, ".oms");
  const linkedDir = path.join(repoRoot, LINKED_DIR_RELATIVE);
  await mkdir(linkedDir, { recursive: true });

  const linked: string[] = [];
  const unchanged: string[] = [];

  for (const spec of specs) {
    const linkPath = path.join(linkedDir, spec.linkName);
    const relName = path.join("linked", spec.linkName);
    const kind = await pathKind(linkPath);

    if (kind === "symlink") {
      const resolvedCurrent = path.resolve(linkedDir, await readlink(linkPath));
      if (resolvedCurrent === spec.target) {
        unchanged.push(relName);
        continue;
      }
      await unlink(linkPath);
    } else if (kind !== "missing") {
      throw new Error(
        `[oms] Refusing to overwrite existing ${kind} at ${linkPath}; remove it first.`,
      );
    }

    await symlink(spec.target, linkPath, "dir");
    linked.push(relName);
  }

  const existingRecord = await readLinkRecord(omsDir);
  const mergedScope = Array.from(
    new Set([...(existingRecord?.scope ?? []), ...specs.map((spec) => spec.rel)]),
  ).sort();
  const record: LinkRecord = {
    version: LINK_RECORD_VERSION,
    vault: vaultRoot,
    scope: mergedScope,
  };
  const recordPath = await writeLinkRecord(omsDir, record);
  const gitignoreUpdated = await ensureGitignore(repoRoot, LINKED_GITIGNORE_PATTERN);

  return { omsDir, recordPath, linked, unchanged, gitignoreUpdated, record };
}

