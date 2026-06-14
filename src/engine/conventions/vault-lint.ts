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
 * NEVER throws. Notes that cannot be parsed are silently skipped.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Concept, Ontology, OntologyField } from "../../ontology/types.js";
import { validateFrontmatter } from "../../conventions/validate.js";
import { parseNote } from "../../conventions/frontmatter.js";

// ── Internal extension ────────────────────────────────────────────────────────

/**
 * Concept YAML files may optionally declare an `enum` array on a field.
 * TypeScript doesn't know about it (OntologyField has no `enum` key), but
 * the YAML loader passes it through at runtime. We widen locally here —
 * never modify src/ontology/types.ts for a single consumer.
 */
type FieldWithEnum = OntologyField & { enum?: string[] };

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
}

// ── Internals ─────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  ".oms",
  ".obsidian",
  ".trash",
  ".git",
  ".claude",
  "_archive",
  "node_modules",
]);

async function* walkMarkdown(
  dir: string,
  base: string,
): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(full, base);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield path.relative(base, full).replace(/\\/g, "/");
    }
  }
}

/**
 * Derive the set of "agent-writable" folders from the loaded ontology.
 *
 * A folder is agent-writable when:
 *  - It is declared in taxonomy.folders
 *  - Its bound concept is NOT null
 *  - The concept declares at least one field (i.e. it is NOT a raw-capture
 *    inbox with no structure requirements)
 */
function agentWritableFolders(ontology: Ontology): Set<string> {
  const zones = new Set<string>();
  for (const [folder, binding] of Object.entries(ontology.taxonomy.folders)) {
    if (binding.concept === null) continue;
    const names = Array.isArray(binding.concept)
      ? binding.concept
      : [binding.concept];
    for (const name of names) {
      const concept = ontology.concepts.get(name);
      if (concept && concept.fields.length > 0) {
        zones.add(folder);
      }
    }
  }
  return zones;
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
  const violations: VaultLintViolation[] = [];
  for (const field of concept.fields as FieldWithEnum[]) {
    if (!field.enum || field.enum.length === 0) continue;
    const value = frontmatter[field.name];
    if (value === undefined || value === null) continue; // required check handles missing
    if (typeof value !== "string") continue; // type check handles wrong type
    if (!field.enum.includes(value)) {
      violations.push({
        notePath,
        field: field.name,
        rule: "enum",
        message:
          `Field "${field.name}" value "${value}" is not one of` +
          ` [${field.enum.map((e) => `"${e}"`).join(", ")}].`,
      });
    }
  }
  return violations;
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
  const folder = notePath.split("/")[0] ?? "";
  if (!agentZones.has(folder)) return [];

  const createdBy = frontmatter["created_by"];
  const missing =
    createdBy === undefined ||
    createdBy === null ||
    (typeof createdBy === "string" && createdBy.trim() === "");

  if (!missing) return [];

  return [
    {
      notePath,
      field: "created_by",
      rule: "routing-law",
      message:
        `Note in agent-writable zone "${folder}" must carry "created_by"` +
        ` to satisfy the ROUTING LAW (agent-authored notes are traceable).`,
    },
  ];
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

  const agentZones = agentWritableFolders(ontology);
  const violations: VaultLintViolation[] = [];
  let scannedNotes = 0;

  for await (const notePath of walkMarkdown(vaultRoot, vaultRoot)) {
    let raw: string;
    try {
      raw = await readFile(path.join(vaultRoot, notePath), "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, hasFrontmatter } = parseNote(raw);
    if (!hasFrontmatter) continue;

    // Resolve concept via top-level folder (taxonomy shortest-path)
    const folder = notePath.split("/")[0] ?? "";
    const binding = ontology.taxonomy.folders[folder];
    if (binding === undefined || binding.concept === null) continue;

    const conceptNames = Array.isArray(binding.concept)
      ? binding.concept
      : [binding.concept];
    const conceptName = conceptNames[0];
    if (!conceptName) continue;

    const concept = ontology.concepts.get(conceptName);
    if (!concept) continue;

    scannedNotes++;
    violations.push(
      ...lintNoteFrontmatter(frontmatter, notePath, concept, agentZones),
    );
  }

  return { violations, scannedNotes, clean: violations.length === 0 };
}
