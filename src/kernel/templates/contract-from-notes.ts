import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { parseNote, type ParsedNote } from "../conventions/frontmatter.js";
import { excludedNoteMatcher } from "../conventions/note-exclude.js";
import type { FieldPolicy, ObsidianContractType } from "./types.js";

const SAMPLE_LIMIT = 50;
const FIELD_LIMIT = 64;
const DEPTH_LIMIT = 16;
const SOURCE_BYTES_LIMIT = 262_144;

export interface ContractFromNotesOptions {
  readonly templateId: string;
  readonly sampleKeys?: readonly string[];
  readonly folders?: readonly string[];
  readonly excludedPaths?: readonly string[];
  readonly obsidianTypes?: Readonly<Record<string, ObsidianContractType>>;
}

export interface ContractFromNotesDiagnostic {
  readonly code:
    | "TEMPLATE_CONTRACT_NOTE_INVALID"
    | "TEMPLATE_CONTRACT_READ_FAILED"
    | "TEMPLATE_PROPOSAL_TYPE_CONFLICT"
    | "TEMPLATE_CONTRACT_UNOBSERVED"
    | "TEMPLATE_PROPOSAL_OVERSIZE";
  readonly message: string;
  readonly path?: string;
}

export interface DerivedContractFromNotes {
  readonly templateId: string;
  readonly samples: number;
  readonly fields: Readonly<Record<string, FieldPolicy>>;
  readonly coverage: Readonly<Record<string, number>>;
  readonly diagnostics: readonly ContractFromNotesDiagnostic[];
  readonly sampleSources: readonly { readonly path: string; readonly digest: string }[];
  readonly status: "observed" | "unobserved" | "oversize" | "unresolved";
  readonly capped: boolean;
}

function normalizedRelative(value: string, label: string): string {
  const normalized = value.normalize("NFC").replaceAll("\\", "/").replace(/^\.\/+|\/+$/g, "");
  if (
    normalized === ""
    || normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").some(segment => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`TEMPLATE_PROPOSAL_PATH_UNSAFE: ${label} ${JSON.stringify(value)}`);
  }
  return normalized;
}

function inFolder(notePath: string, folders: readonly string[]): boolean {
  return folders.some(folder => notePath.startsWith(`${folder}/`));
}

function inferredType(value: unknown): ObsidianContractType | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "boolean") return "checkbox";
  if (Array.isArray(value)) {
    return value.every(item => typeof item === "string") ? "list" : undefined;
  }
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) {
      return "datetime";
    }
    return "text";
  }
  return undefined;
}

function combinedType(values: readonly unknown[]): ObsidianContractType | undefined {
  const types = new Set(values.map(inferredType));
  return !types.has(undefined) && types.size === 1
    ? [...types][0] as ObsidianContractType
    : undefined;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ""
    || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function readBoundedFile(
  root: string,
  absolute: string,
): Promise<{ readonly bytes?: Buffer; readonly oversized: boolean }> {
  const parent = path.dirname(absolute);
  const canonicalParent = await realpath(parent);
  if (!isInside(root, canonicalParent)) {
    throw new Error(`TEMPLATE_PROPOSAL_PATH_UNSAFE: ${absolute} has a parent outside the vault`);
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`TEMPLATE_PROPOSAL_PATH_UNSAFE: ${absolute} is not a regular file`);
    if (before.size > SOURCE_BYTES_LIMIT) return { oversized: true };
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= SOURCE_BYTES_LIMIT) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, SOURCE_BYTES_LIMIT + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    const after = await handle.stat();
    const canonicalParentAfter = await realpath(parent);
    if (!isInside(root, canonicalParentAfter)) {
      throw new Error(`TEMPLATE_PROPOSAL_PATH_UNSAFE: ${absolute} parent escaped the vault while reading`);
    }
    if (total > SOURCE_BYTES_LIMIT || after.size > SOURCE_BYTES_LIMIT) return { oversized: true };
    return { bytes: Buffer.concat(chunks, total), oversized: false };
  } finally {
    await handle.close();
  }
}

/**
 * Derives a read-only contract proposal from existing notes. Identity fields
 * and taxonomy folders are observations only; this function never persists
 * the proposal or changes the vault.
 */
export async function deriveContractFromNotes(
  vaultRoot: string,
  options: ContractFromNotesOptions,
): Promise<DerivedContractFromNotes> {
  const root = await realpath(vaultRoot);
  const sampleKeys = (options.sampleKeys ?? ["template", "type"]).map((key, index) => {
    const normalized = key.normalize("NFC").trim();
    if (normalized === "" || normalized.includes("\0")) {
      throw new Error(`TEMPLATE_PROPOSAL_PATH_UNSAFE: sampleKeys[${index}] must be non-empty`);
    }
    return normalized;
  });
  const folders = (options.folders ?? []).map((folder, index) =>
    normalizedRelative(folder, `folders[${index}]`)
  );
  const explicitlyExcluded = new Set((options.excludedPaths ?? []).map((pathname, index) =>
    normalizedRelative(pathname, `excludedPaths[${index}]`)
  ));
  const excluded = await excludedNoteMatcher(root, false);
  const samples: { readonly frontmatter: Record<string, unknown>; readonly path: string; readonly digest: string }[] = [];
  const diagnostics: ContractFromNotesDiagnostic[] = [];
  let capped = false;
  let oversize = false;

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (capped || oversize || depth > DEPTH_LIMIT) return;
    const directoryStat = await lstat(directory);
    if (directoryStat.isSymbolicLink()) return;
    const canonicalDirectory = await realpath(directory);
    if (!isInside(root, canonicalDirectory)) {
      throw new Error(`TEMPLATE_PROPOSAL_PATH_UNSAFE: ${directory} resolves outside the vault`);
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
      const canonicalAfterRead = await realpath(directory);
      if (canonicalAfterRead !== canonicalDirectory || !isInside(root, canonicalAfterRead)) {
        throw new Error(`TEMPLATE_PROPOSAL_PATH_UNSAFE: ${directory} changed while scanning`);
      }
    } catch (error) {
      const relative = path.relative(root, directory).replaceAll("\\", "/") || ".";
      const unsafe = error instanceof Error && error.message.startsWith("TEMPLATE_PROPOSAL_PATH_UNSAFE:");
      if (unsafe) oversize = true;
      diagnostics.push({
        code: unsafe ? "TEMPLATE_PROPOSAL_OVERSIZE" : "TEMPLATE_CONTRACT_READ_FAILED",
        path: relative,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (capped || oversize) return;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth >= DEPTH_LIMIT) {
          oversize = true;
          diagnostics.push({
            code: "TEMPLATE_PROPOSAL_OVERSIZE",
            path: path.relative(root, absolute).replaceAll("\\", "/"),
            message: `Directory exceeds the proposal depth limit of ${DEPTH_LIMIT}`,
          });
          return;
        }
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (explicitlyExcluded.has(relative) || excluded(relative)) continue;
      let parsed: ParsedNote;
      let raw: Buffer;
      try {
        const bounded = await readBoundedFile(root, absolute);
        if (bounded.oversized || bounded.bytes === undefined) {
          oversize = true;
          diagnostics.push({
            code: "TEMPLATE_PROPOSAL_OVERSIZE",
            path: relative,
            message: `Note exceeds the ${SOURCE_BYTES_LIMIT}-byte source limit`,
          });
          continue;
        }
        raw = bounded.bytes;
        parsed = parseNote(raw.toString("utf8"));
      } catch (error) {
        const unsafe =
          (error instanceof Error && error.message.startsWith("TEMPLATE_PROPOSAL_PATH_UNSAFE:"))
          || (error instanceof Error && "code" in error && error.code === "ELOOP");
        if (unsafe) oversize = true;
        diagnostics.push({
          code: unsafe ? "TEMPLATE_PROPOSAL_OVERSIZE" : "TEMPLATE_CONTRACT_READ_FAILED",
          path: relative,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (parsed.diagnostics.length > 0) {
        diagnostics.push({
          code: "TEMPLATE_CONTRACT_NOTE_INVALID",
          path: relative,
          message: parsed.diagnostics.map(item => item.message).join("; "),
        });
        continue;
      }
      const identified = sampleKeys.some(key => parsed.frontmatter[key] === options.templateId)
        || inFolder(relative, folders);
      if (!identified) continue;
      if (samples.length === SAMPLE_LIMIT) {
        capped = true;
        oversize = true;
        diagnostics.push({
          code: "TEMPLATE_PROPOSAL_OVERSIZE",
          path: relative,
          message: `Eligible note count exceeds the ${SAMPLE_LIMIT}-sample limit`,
        });
        return;
      }
      samples.push({
        frontmatter: parsed.frontmatter,
        path: relative,
        digest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      });
    }
  };
  await walk(root, 0);

  const values = new Map<string, unknown[]>();
  for (const sample of samples) {
    for (const [key, value] of Object.entries(sample.frontmatter)) {
      const collected = values.get(key) ?? [];
      collected.push(value);
      values.set(key, collected);
    }
  }
  const fields: Record<string, FieldPolicy> = {};
  const coverage: Record<string, number> = {};
  let conflicts = false;
  for (const key of [...values.keys()].sort()) {
    const observed = values.get(key)!;
    const authorityType = options.obsidianTypes?.[key];
    const inferred = combinedType(observed);
    if (authorityType === undefined && inferred === undefined) {
      conflicts = true;
      diagnostics.push({
        code: "TEMPLATE_PROPOSAL_TYPE_CONFLICT",
        message: `Field ${key} has incompatible observed value types`,
      });
      coverage[key] = observed.length / samples.length;
      continue;
    }
    fields[key] = {
      type: authorityType ?? inferred!,
      ...(observed.length === samples.length ? { required: true } : {}),
    };
    coverage[key] = observed.length / samples.length;
  }

  let status: DerivedContractFromNotes["status"] = "observed";
  if (samples.length === 0) {
    status = oversize ? "oversize" : "unobserved";
    if (!oversize) {
      diagnostics.push({
        code: "TEMPLATE_CONTRACT_UNOBSERVED",
        message: `No existing notes were observed for template ${options.templateId}`,
      });
    }
  } else if (oversize || values.size > FIELD_LIMIT) {
    status = "oversize";
    if (values.size > FIELD_LIMIT) {
      diagnostics.push({
        code: "TEMPLATE_PROPOSAL_OVERSIZE",
        message: `Observed ${values.size} fields; the proposal limit is ${FIELD_LIMIT}`,
      });
    }
  } else if (conflicts) {
    status = "unresolved";
  }
  return {
    templateId: options.templateId,
    samples: samples.length,
    fields,
    coverage,
    sampleSources: samples.map(sample => ({ path: sample.path, digest: sample.digest })),
    diagnostics: diagnostics.sort((left, right) =>
      (left.path ?? "").localeCompare(right.path ?? "") || left.code.localeCompare(right.code)
    ),
    status,
    capped,
  };
}
