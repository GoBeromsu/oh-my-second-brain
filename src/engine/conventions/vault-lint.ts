/**
 * Vault-level Layer 1 CONTRACT enforcement — checker lane only.
 *
 * Wraps the existing per-note validators (src/conventions/validate.ts and
 * src/conventions/frontmatter.ts) and adds three new checks to produce a
 * unified five-check lint surface:
 *
 *   (1) allowlist    — no rogue keys outside the concept's declared fields
 *   (2) required     — required fields must be present and non-empty
 *   (3) type         — values must match the declared FieldType
 *   (4) enum         — string fields with enum constraint must use a listed value
 *   (5) routing-law  — agent-authored notes must carry `created_by` and live
 *                      in an agent-writable taxonomy zone
 *
 * DEFAULT MODE: report-only. The vault is NEVER mutated unless
 * `autofixEnabled: true` is passed (human-gate flag).
 *
 * Invalid folder scopes throw clear caller-facing errors; individual notes that cannot be parsed are skipped.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseNote } from "../../conventions/frontmatter.js";
import { validateFrontmatter } from "../../conventions/validate.js";
import {
  enumViolations,
  routingLawStrictFolders as writeContractStrictFolders,
  routingLawViolations,
} from "../../conventions/write-contract.js";
import { walkVaultMarkdown } from "../../conventions/vault-walk.js";
import { resolveConcept } from "../../core/ontology/resolver.js";
import type { Concept, Ontology } from "../../core/ontology/types.js";


// ── Public types ──────────────────────────────────────────────────────────────

/** One of the five check layers. */
export type VaultLintRule =
  | "allowlist"
  | "required"
  | "type"
  | "enum"
  | "routing-law";

/** A single contract violation on a note. */
export interface VaultLintViolation {
  /** Vault-relative path, e.g. `references/clean-code.md`. */
  notePath: string;
  /** The frontmatter key that caused the violation. */
  field: string;
  /** Which check fired. */
  rule: VaultLintRule;
  /** Human-readable explanation. */
  message: string;
}

/** Result of a full vault scan. */
export interface VaultLintReport {
  violations: VaultLintViolation[];
  /** How many markdown notes with frontmatter were evaluated. */
  scannedNotes: number;
  /** How many markdown notes were skipped because they matched an exclude glob. */
  excludedNotes: number;
  /** Convenience flag: true when violations is empty. */
  clean: boolean;
}

/**
 * Options controlling the vault-lint run.
 *
 * ROUTING-LAW GUARD: autofix is off by default and MUST remain so.
 * Set `autofixEnabled: true` ONLY after an explicit human confirmation gate.
 */
export interface VaultLintOptions {
  /**
   * Human-gate flag. Never set programmatically — only pass true after the
   * user has explicitly approved vault mutations in the calling UI/CLI.
   * Default: false (report-only).
   */
  autofixEnabled?: boolean;
  /** Restrict the scan to a single top-level vault folder. */
  folder?: string;
  /** Additional vault-relative glob patterns to exempt from scanning. */
  excludeGlobs?: readonly string[];
}

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Default audit exemptions — deliberately not contract violations: build artifacts,
 * self-documenting templates, and skill files that intentionally carry no frontmatter.
 */
export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  "25. Digital Garden/.deploy-staging/**",
  "**/*.template.md",
  "**/SKILL.md",
  ".obsidian/**",
  ".trash/**",
  ".oms/**",
  "_attachments/**",
];

/** Convert a `*`/`**` glob into an anchored RegExp. `**` matches across `/`, `*` does not. */
function globToRegExp(glob: string): RegExp {
  const GLOBSTAR = "\u0000";
  const withPlaceholder = glob.replace(/\*\*/g, GLOBSTAR);
  const escaped = withPlaceholder.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withStar = escaped.replace(/\*/g, "[^/]*");
  const pattern = withStar.split(GLOBSTAR).join(".*");
  return new RegExp(`^${pattern}$`);
}

export function matchesAnyGlob(notePath: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(notePath));
}

/** Merge built-in defaults with vault-declared and caller-supplied exclude globs. */
export function resolveExcludeGlobs(ontology: Ontology, extra: readonly string[] = []): string[] {
  return [...DEFAULT_EXCLUDE_GLOBS, ...(ontology.taxonomy.exclude ?? []), ...extra];
}

export async function validateVaultLintFolder(
  vaultRoot: string,
  ontology: Ontology,
  folder: string | undefined,
): Promise<void> {
  if (folder === undefined) return;

  if (
    folder.length === 0 ||
    folder === "." ||
    folder.includes("/") ||
    folder.includes("\\") ||
    folder.includes("..")
  ) {
    throw new Error(
      `Audit folder "${folder}" must be one top-level vault folder name; path separators and ".." are not allowed.`,
    );
  }

  if (!Object.prototype.hasOwnProperty.call(ontology.taxonomy.folders, folder)) {
    throw new Error(`Audit folder "${folder}" is not declared in the active taxonomy.`);
  }

  try {
    const info = await stat(path.join(vaultRoot, folder));
    if (!info.isDirectory()) {
      throw new Error(`Audit folder "${folder}" does not exist as a top-level vault folder.`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Audit folder "${folder}" does not exist as a top-level vault folder.`);
    }
    throw error;
  }
}

/**
 * Derive the set of agent-writable folders from the loaded ontology.
 *
 * A folder is agent-writable when taxonomy explicitly declares `agentWritable: true`.
 */
export function agentWritableFolders(ontology: Ontology): Set<string> {
  const zones = new Set<string>();
  for (const [folder, binding] of Object.entries(ontology.taxonomy.folders)) {
    if (binding.agentWritable === true) zones.add(folder);
  }
  return zones;
}

/**
 * Derive folders where the ROUTING LAW is enforced as a hard per-note requirement.
 *
 * This is a strict subset of agentWritableFolders(): folders must be marked both
 * `agentWritable: true` and `routingLawStrict: true`.
 */
export function routingLawStrictFolders(ontology: Ontology): Set<string> {
  return writeContractStrictFolders(ontology);
}

// ── Per-note check functions ──────────────────────────────────────────────────

/** (1) No key outside the concept's declared field list. */
function checkAllowlist(
  frontmatter: Record<string, unknown>,
  concept: Concept,
  notePath: string,
): VaultLintViolation[] {
  const declared = new Set(concept.fields.map((f) => f.name));
  const violations: VaultLintViolation[] = [];
  for (const key of Object.keys(frontmatter)) {
    if (!declared.has(key)) {
      violations.push({
        notePath,
        field: key,
        rule: "allowlist",
        message:
          `Undeclared key "${key}" is not in the allowlist for concept` +
          ` "${concept.concept}". Declared keys: [${[...declared].join(", ")}].`,
      });
    }
  }
  return violations;
}

/** (4) String fields that carry an enum constraint must use a listed value. */
function checkEnum(
  frontmatter: Record<string, unknown>,
  concept: Concept,
  notePath: string,
): VaultLintViolation[] {
  return enumViolations(frontmatter, concept).map((violation) => ({
    notePath,
    field: violation.field,
    rule: violation.rule,
    message: violation.message,
  }));
}

/**
 * (5) ROUTING LAW: notes in agent-writable zones must carry `created_by`.
 *
 * This ensures every note that an agent deposits in a structured zone is
 * traceable. A note outside agent zones is not subject to this rule.
 */
function checkRoutingLaw(
  frontmatter: Record<string, unknown>,
  notePath: string,
  agentZones: Set<string>,
): VaultLintViolation[] {
  return routingLawViolations(frontmatter, notePath, agentZones).map((violation) => ({
    notePath,
    field: violation.field,
    rule: violation.rule,
    message: violation.message,
  }));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run all five lint checks against a single note's frontmatter.
 *
 * Pure function — never reads or writes files. Suitable for unit testing
 * with inline fixtures.
 *
 * @param frontmatter  Parsed frontmatter object.
 * @param notePath     Vault-relative path (used in violation messages + routing-law zone detection).
 * @param concept      The resolved concept for this note.
 * @param agentZones   Set of folder names considered agent-writable (from taxonomy).
 */
export function lintNoteFrontmatter(
  frontmatter: Record<string, unknown>,
  notePath: string,
  concept: Concept,
  agentZones: Set<string>,
): VaultLintViolation[] {
  const violations: VaultLintViolation[] = [];

  // (1) Allowlist
  violations.push(...checkAllowlist(frontmatter, concept, notePath));

  // (2) Required + (3) Type — delegate to existing field-level validator
  const valResult = validateFrontmatter(frontmatter, concept);
  for (const v of valResult.violations) {
    violations.push({
      notePath,
      field: v.field,
      rule: v.rule as "required" | "type",
      message: v.message,
    });
  }

  // (4) Enum
  violations.push(...checkEnum(frontmatter, concept, notePath));

  // (5) Routing law
  violations.push(...checkRoutingLaw(frontmatter, notePath, agentZones));

  return violations;
}

/**
 * Walk a vault directory, resolve each note to its taxonomy concept, and run
 * all five lint checks. Returns a VaultLintReport.
 *
 * Report-only by default. Autofix is a no-op unless `autofixEnabled: true`
 * is explicitly passed — that flag must only be set after an explicit human
 * confirmation gate in the calling layer.
 *
 * Notes without frontmatter, or whose top-level folder is not in the
 * taxonomy, are silently skipped (not their CONTRACT to satisfy).
 */
export async function lintVault(
  vaultRoot: string,
  ontology: Ontology,
  options: VaultLintOptions = {},
): Promise<VaultLintReport> {
  // ROUTING-LAW GUARD — autofix reserved for future human-gated implementation.
  // This block intentionally does nothing: the flag is read so callers cannot
  // accidentally assume silence == autofix applied.
  if (options.autofixEnabled) {
    // Autofix is not implemented. Set the flag only after the human-gate
    // protocol for M5 vault mutations is fully specified and approved.
  }

  await validateVaultLintFolder(vaultRoot, ontology, options.folder);
  const agentZones = routingLawStrictFolders(ontology);
  const excludeGlobs = resolveExcludeGlobs(ontology, options.excludeGlobs ?? []);
  const violations: VaultLintViolation[] = [];
  let scannedNotes = 0;
  let excludedNotes = 0;

  const walkRoot = options.folder ? path.join(vaultRoot, options.folder) : vaultRoot;

  for await (const notePath of walkVaultMarkdown(walkRoot, { base: vaultRoot })) {
    if (matchesAnyGlob(notePath, excludeGlobs)) {
      excludedNotes++;
      continue;
    }

    let raw: string;
    try {
      raw = await readFile(path.join(vaultRoot, notePath), "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, hasFrontmatter } = parseNote(raw);
    if (!hasFrontmatter) continue;

    const concept = resolveConcept(ontology, notePath);
    if (!concept) continue;

    scannedNotes++;
    violations.push(
      ...lintNoteFrontmatter(frontmatter, notePath, concept, agentZones),
    );
  }

  return { violations, scannedNotes, excludedNotes, clean: violations.length === 0 };
}
