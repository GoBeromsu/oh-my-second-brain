import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { parseNote } from "../conventions/frontmatter.js";
import {
  evaluateWriteContract,
  routingLawStrictFolders,
  writeFieldDescriptors,
  type WriteContractViolation,
  type WriteFieldDescriptor,
} from "../conventions/write-contract.js";
import { resolveConcept } from "../core/ontology/resolver.js";
import type { Concept, Ontology } from "../core/ontology/types.js";

export type CapturePrepareAction = "ready" | "ask-missing-fields" | "route-to-inbox";
export type CaptureWriteMode = "create" | "append";
export type WriteMode = "create" | "append" | "update";
export type WriteStatus = "ask" | "inbox" | "written" | "rejected";

export interface CapturePrepareInput {
  vault: string;
  ontology: Ontology;
  concept?: string;
  folder?: string;
  filename?: string;
  frontmatter?: Record<string, unknown>;
}

export interface CapturePlan {
  action: CapturePrepareAction;
  concept: string | null;
  folder: string;
  notePath: string;
  missingFields: string[];
  frontmatter: Record<string, unknown>;
  fields: WriteFieldDescriptor[];
  violations: WriteContractViolation[];
  reason?: string;
}

export interface CaptureCommitInput {
  vault: string;
  ontology: Ontology;
  notePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
  mode: CaptureWriteMode;
}

export interface CaptureCommitResult {
  written: true;
  mode: CaptureWriteMode;
  notePath: string;
}

export interface WriteNoteInput {
  vault: string;
  ontology: Ontology;
  mode: WriteMode;
  dryRun: boolean;
  concept?: string;
  folder?: string;
  filename?: string;
  notePath?: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
}

export interface WriteNoteResult {
  status: WriteStatus;
  mode: WriteMode;
  notePath: string;
  concept: string | null;
  folder: string;
  fields: WriteFieldDescriptor[];
  frontmatter: Record<string, unknown>;
  missingFields: string[];
  violations: WriteContractViolation[];
  reason?: string;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "untitled";
}

function conceptsForFolder(ontology: Ontology, folder: string): string[] {
  const binding = ontology.taxonomy.folders[folder]?.concept;
  if (!binding) return [];
  return Array.isArray(binding) ? binding : [binding];
}

function findConcept(ontology: Ontology, conceptName: string | undefined): Concept | undefined {
  return conceptName ? ontology.concepts.get(conceptName) : undefined;
}

function defaultInboxFolder(ontology: Ontology): string {
  if (ontology.taxonomy.folders["inbox"]) return "inbox";
  const inboxConcept = ontology.concepts.get("inbox");
  return inboxConcept?.folder ?? "inbox";
}

function mergeFrontmatter(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...base, ...patch };
}

function emptyWriteFields(): WriteFieldDescriptor[] {
  return [];
}

function contractFields(concept: Concept | undefined): WriteFieldDescriptor[] {
  return concept ? writeFieldDescriptors(concept) : emptyWriteFields();
}

function writeResult(partial: WriteNoteResult): WriteNoteResult {
  return partial;
}

function inboxResult(
  mode: WriteMode,
  ontology: Ontology,
  filename: string,
  frontmatter: Record<string, unknown>,
  reason: string,
): WriteNoteResult {
  const inbox = defaultInboxFolder(ontology);
  const inboxConcept = findConcept(ontology, "inbox");
  return writeResult({
    status: "inbox",
    mode,
    notePath: `${inbox}/${filename}`,
    concept: "inbox",
    folder: inbox,
    fields: contractFields(inboxConcept),
    frontmatter,
    missingFields: [],
    violations: [],
    reason,
  });
}

function rejectedResult(
  mode: WriteMode,
  notePath: string,
  concept: Concept | undefined,
  frontmatter: Record<string, unknown>,
  violations: WriteContractViolation[],
  reason: string,
): WriteNoteResult {
  return writeResult({
    status: "rejected",
    mode,
    notePath,
    concept: concept?.concept ?? null,
    folder: notePath.split("/")[0] ?? "",
    fields: contractFields(concept),
    frontmatter,
    missingFields: violations.map((violation) => violation.field),
    violations,
    reason,
  });
}

function askResult(
  mode: WriteMode,
  notePath: string,
  concept: Concept,
  frontmatter: Record<string, unknown>,
  violations: WriteContractViolation[],
): WriteNoteResult {
  return writeResult({
    status: "ask",
    mode,
    notePath,
    concept: concept.concept,
    folder: notePath.split("/")[0] ?? concept.folder,
    fields: contractFields(concept),
    frontmatter,
    missingFields: violations.map((violation) => violation.field),
    violations,
  });
}

function writtenResult(
  mode: WriteMode,
  notePath: string,
  concept: Concept | undefined,
  frontmatter: Record<string, unknown>,
): WriteNoteResult {
  return writeResult({
    status: "written",
    mode,
    notePath,
    concept: concept?.concept ?? null,
    folder: notePath.split("/")[0] ?? "",
    fields: contractFields(concept),
    frontmatter,
    missingFields: [],
    violations: [],
  });
}

export function safeVaultNotePath(vault: string, notePath: string): string {
  if (path.isAbsolute(notePath)) {
    throw new Error("notePath must be vault-relative");
  }
  const normalized = notePath.replace(/\\/g, "/");
  if (!normalized.endsWith(".md")) {
    throw new Error("notePath must end with .md");
  }
  const segments = normalized.split("/");
  if (segments.some((part) => part === ".." || part === "." || part === "")) {
    throw new Error("notePath must not contain unsafe path segments");
  }
  if (segments.some((part) => part.startsWith(".")) || segments.includes("node_modules")) {
    throw new Error("notePath cannot target hidden, internal, or dependency folders");
  }
  const resolved = path.resolve(vault, normalized);
  const relative = path.relative(vault, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("notePath must stay inside the configured vault");
  }
  return resolved;
}

function trySafeNotePath(
  vault: string,
  notePath: string,
): { ok: true; fullPath: string; normalized: string } | { ok: false; reason: string } {
  try {
    const fullPath = safeVaultNotePath(vault, notePath);
    return {
      ok: true,
      fullPath,
      normalized: path.relative(vault, fullPath).replace(/\\/g, "/"),
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function safeCaptureFilename(
  requested: string | undefined,
  title: string,
): {
  filename: string;
  safe: boolean;
} {
  if (!requested) {
    return {
      filename: `${new Date().toISOString().slice(0, 10)}-${slugify(title)}.md`,
      safe: true,
    };
  }

  const normalized = requested.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const safe =
    segments.length === 1 &&
    normalized.endsWith(".md") &&
    !segments.some((part) => part === ".." || part === "." || part === "" || part.startsWith("."));

  return {
    filename: safe ? normalized : `${new Date().toISOString().slice(0, 10)}-${slugify(title)}.md`,
    safe,
  };
}

interface PlannedPlacement {
  kind: "inbox" | "bound";
  notePath: string;
  concept: Concept | undefined;
  folder: string;
  filename: string;
  reason?: string;
}

function planCreatePlacement(
  ontology: Ontology,
  conceptName: string | undefined,
  folderName: string | undefined,
  filename: string | undefined,
  frontmatter: Record<string, unknown>,
): PlannedPlacement {
  const requestedConcept = findConcept(ontology, conceptName);
  const folder = folderName ?? requestedConcept?.folder ?? defaultInboxFolder(ontology);
  const folderConcepts = conceptsForFolder(ontology, folder);
  const resolvedConcept = requestedConcept ?? findConcept(ontology, folderConcepts[0]);
  const titleValue = frontmatter["title"];
  const title = typeof titleValue === "string" ? titleValue : "untitled";
  const filenamePlan = safeCaptureFilename(filename, title);

  if (!filenamePlan.safe) {
    return {
      kind: "inbox",
      notePath: `${defaultInboxFolder(ontology)}/${filenamePlan.filename}`,
      concept: findConcept(ontology, "inbox"),
      folder: defaultInboxFolder(ontology),
      filename: filenamePlan.filename,
      reason: "Requested filename was unsafe; planned a safe inbox capture path.",
    };
  }

  if (!resolvedConcept || !folderConcepts.includes(resolvedConcept.concept)) {
    return {
      kind: "inbox",
      notePath: `${defaultInboxFolder(ontology)}/${filenamePlan.filename}`,
      concept: findConcept(ontology, "inbox"),
      folder: defaultInboxFolder(ontology),
      filename: filenamePlan.filename,
      reason: "No safe folder/concept binding matched the requested capture.",
    };
  }

  return {
    kind: "bound",
    notePath: `${folder}/${filenamePlan.filename}`,
    concept: resolvedConcept,
    folder,
    filename: filenamePlan.filename,
  };
}

function formatNote(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${yamlStringify(frontmatter).trimEnd()}\n---\n\n${body.trim()}\n`;
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function fileExists(fullPath: string): Promise<boolean> {
  try {
    await access(fullPath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export function prepareCapture(input: CapturePrepareInput): CapturePlan {
  const frontmatter = input.frontmatter ?? {};
  const planned = planCreatePlacement(
    input.ontology,
    input.concept,
    input.folder,
    input.filename,
    frontmatter,
  );

  if (planned.kind === "inbox") {
    return {
      action: "route-to-inbox",
      concept: "inbox",
      folder: planned.folder,
      notePath: planned.notePath,
      missingFields: [],
      frontmatter,
      fields: contractFields(planned.concept),
      violations: [],
      reason: planned.reason,
    };
  }

  const concept = planned.concept;
  if (!concept) {
    return {
      action: "route-to-inbox",
      concept: "inbox",
      folder: defaultInboxFolder(input.ontology),
      notePath: planned.notePath,
      missingFields: [],
      frontmatter,
      fields: [],
      violations: [],
      reason: "No safe folder/concept binding matched the requested capture.",
    };
  }

  const contract = evaluateWriteContract(
    frontmatter,
    concept,
    planned.notePath,
    routingLawStrictFolders(input.ontology),
  );
  return {
    action: contract.valid ? "ready" : "ask-missing-fields",
    concept: concept.concept,
    folder: planned.folder,
    notePath: planned.notePath,
    missingFields: contract.violations.map((violation) => violation.field),
    frontmatter,
    fields: contractFields(concept),
    violations: contract.violations,
  };
}

export async function writeNote(input: WriteNoteInput): Promise<WriteNoteResult> {
  const frontmatter = input.frontmatter ?? {};
  const strictZones = routingLawStrictFolders(input.ontology);

  if (input.mode === "update") {
    return writeUpdate(input, frontmatter, strictZones);
  }
  if (input.mode === "append") {
    return writeAppend(input, frontmatter, strictZones);
  }
  return writeCreate(input, frontmatter, strictZones);
}

async function writeCreate(
  input: WriteNoteInput,
  frontmatter: Record<string, unknown>,
  strictZones: ReadonlySet<string>,
): Promise<WriteNoteResult> {
  let notePath: string;
  let concept: Concept | undefined;

  if (input.notePath) {
    const safe = trySafeNotePath(input.vault, input.notePath);
    if (!safe.ok) {
      return rejectedResult("create", input.notePath, undefined, frontmatter, [], safe.reason);
    }
    notePath = safe.normalized;
    concept = resolveConcept(input.ontology, notePath);
    if (!concept) {
      const filename = path.posix.basename(notePath);
      return inboxResult(
        "create",
        input.ontology,
        filename,
        frontmatter,
        "No safe folder/concept binding matched the requested capture.",
      );
    }
  } else {
    const planned = planCreatePlacement(
      input.ontology,
      input.concept,
      input.folder,
      input.filename,
      frontmatter,
    );
    if (planned.kind === "inbox") {
      return inboxResult(
        "create",
        input.ontology,
        planned.filename,
        frontmatter,
        planned.reason ?? "No safe folder/concept binding matched the requested capture.",
      );
    }
    notePath = planned.notePath;
    concept = planned.concept;
  }

  if (!concept) {
    return inboxResult(
      "create",
      input.ontology,
      path.posix.basename(notePath),
      frontmatter,
      "No safe folder/concept binding matched the requested capture.",
    );
  }

  const contract = evaluateWriteContract(frontmatter, concept, notePath, strictZones);
  if (!contract.valid) {
    return askResult("create", notePath, concept, frontmatter, contract.violations);
  }

  if (input.body === undefined) {
    return rejectedResult(
      "create",
      notePath,
      concept,
      frontmatter,
      [],
      "create requires a body",
    );
  }

  const safe = trySafeNotePath(input.vault, notePath);
  if (!safe.ok) {
    return rejectedResult("create", notePath, concept, frontmatter, [], safe.reason);
  }

  if (await fileExists(safe.fullPath)) {
    return rejectedResult(
      "create",
      notePath,
      concept,
      frontmatter,
      [],
      "Cannot create capture: target note already exists",
    );
  }

  if (!input.dryRun) {
    await mkdir(path.dirname(safe.fullPath), { recursive: true });
    await writeFile(safe.fullPath, formatNote(frontmatter, input.body), {
      encoding: "utf-8",
      flag: "wx",
    });
  }

  return writtenResult("create", notePath, concept, frontmatter);
}

async function writeAppend(
  input: WriteNoteInput,
  frontmatter: Record<string, unknown>,
  strictZones: ReadonlySet<string>,
): Promise<WriteNoteResult> {
  if (!input.notePath) {
    return rejectedResult("append", "", undefined, frontmatter, [], "append requires notePath");
  }
  if (input.body === undefined) {
    return rejectedResult(
      "append",
      input.notePath,
      undefined,
      frontmatter,
      [],
      "append requires a body",
    );
  }

  const safe = trySafeNotePath(input.vault, input.notePath);
  if (!safe.ok) {
    return rejectedResult("append", input.notePath, undefined, frontmatter, [], safe.reason);
  }

  const exists = await fileExists(safe.fullPath);
  if (!exists) {
    const created = await writeCreate(
      {
        vault: input.vault,
        ontology: input.ontology,
        mode: "create",
        dryRun: input.dryRun,
        notePath: safe.normalized,
        frontmatter,
        body: input.body,
      },
      frontmatter,
      strictZones,
    );
    if (created.status !== "written") {
      return created;
    }
    return writeResult({
      ...created,
      mode: "append",
    });
  }

  const raw = await readFile(safe.fullPath, "utf-8");
  const parsed = parseNote(raw);
  const concept = resolveConcept(input.ontology, safe.normalized);
  if (!concept) {
    return rejectedResult(
      "append",
      safe.normalized,
      undefined,
      parsed.frontmatter,
      [],
      "Cannot commit capture: notePath does not resolve to a concept binding",
    );
  }

  const contract = evaluateWriteContract(parsed.frontmatter, concept, safe.normalized, strictZones);
  if (!contract.valid) {
    return rejectedResult(
      "append",
      safe.normalized,
      concept,
      parsed.frontmatter,
      contract.violations,
      "Cannot append: existing frontmatter violates the concept contract",
    );
  }

  if (!input.dryRun) {
    await appendFile(safe.fullPath, `\n\n${input.body.trim()}\n`, "utf-8");
  }

  return writtenResult("append", safe.normalized, concept, parsed.frontmatter);
}

async function writeUpdate(
  input: WriteNoteInput,
  frontmatter: Record<string, unknown>,
  strictZones: ReadonlySet<string>,
): Promise<WriteNoteResult> {
  if (!input.notePath) {
    return rejectedResult("update", "", undefined, frontmatter, [], "update requires notePath");
  }
  if (input.frontmatter === undefined && input.body === undefined) {
    return rejectedResult(
      "update",
      input.notePath,
      undefined,
      frontmatter,
      [],
      "update requires frontmatter or body",
    );
  }

  const safe = trySafeNotePath(input.vault, input.notePath);
  if (!safe.ok) {
    return rejectedResult("update", input.notePath, undefined, frontmatter, [], safe.reason);
  }

  if (!(await fileExists(safe.fullPath))) {
    return rejectedResult(
      "update",
      safe.normalized,
      undefined,
      frontmatter,
      [],
      "Cannot update capture: target note does not exist",
    );
  }

  const raw = await readFile(safe.fullPath, "utf-8");
  const parsed = parseNote(raw);
  const merged = input.frontmatter === undefined ? parsed.frontmatter : mergeFrontmatter(parsed.frontmatter, frontmatter);
  const body = input.body === undefined ? parsed.body : input.body;
  const concept = resolveConcept(input.ontology, safe.normalized);
  if (!concept) {
    return rejectedResult(
      "update",
      safe.normalized,
      undefined,
      merged,
      [],
      "Cannot commit capture: notePath does not resolve to a concept binding",
    );
  }

  const contract = evaluateWriteContract(merged, concept, safe.normalized, strictZones);
  if (!contract.valid) {
    return rejectedResult(
      "update",
      safe.normalized,
      concept,
      merged,
      contract.violations,
      "Cannot update capture: resulting frontmatter violates the concept contract",
    );
  }

  if (!input.dryRun) {
    await writeFile(safe.fullPath, formatNote(merged, body), "utf-8");
  }

  return writtenResult("update", safe.normalized, concept, merged);
}

export async function commitCapture(input: CaptureCommitInput): Promise<CaptureCommitResult> {
  const result = await writeNote({
    vault: input.vault,
    ontology: input.ontology,
    mode: input.mode,
    dryRun: false,
    notePath: input.notePath,
    frontmatter: input.frontmatter,
    body: input.body,
  });

  if (result.status === "written") {
    return { written: true, mode: input.mode, notePath: result.notePath };
  }

  if (result.violations.length > 0) {
    const fields = result.violations.map((violation) => violation.field).join(", ");
    throw new Error(`Cannot commit capture: frontmatter violates the concept contract (${fields})`);
  }

  throw new Error(result.reason ?? "Cannot commit capture");
}
