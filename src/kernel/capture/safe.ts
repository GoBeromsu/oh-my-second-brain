import { access, appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
import {
  rejection,
  type WriteRejection,
  type WriteReceipt,
  type WriteTargetSource,
} from "../conventions/write-protocol.js";
import { resolveConcept } from "../ontology/resolver.js";
import type { Concept, Ontology } from "../ontology/types.js";

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

export interface WriteTarget {
  vault: string;
  source: WriteTargetSource;
}

export interface CaptureCommitInput {
  vault: string;
  source: WriteTargetSource;
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
  target: WriteTarget;
  ontology: Ontology;
  mode: WriteMode;
  dryRun: boolean;
  concept?: string;
  folder?: string;
  filename?: string;
  notePath?: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
  /**
   * Test-only DI seam for the postcondition read-back. Defaults to reading the
   * persisted file with node:fs/promises. Exists so tests can force a
   * postcondition failure deterministically without mocking node:fs/promises.
   */
  readBack?: (fullPath: string) => Promise<string>;
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
  rejection?: WriteRejection;
  receipt?: WriteReceipt;
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

function pathUnsafeRejection(reason: string): WriteRejection {
  return rejection(
    "admission",
    "path-unsafe",
    reason,
    "pass a vault-relative `notePath` ending in .md that stays inside the vault and avoids hidden or internal folders",
  );
}

function conceptUnboundRejection(): WriteRejection {
  return rejection(
    "admission",
    "concept-unbound",
    "Cannot commit capture: notePath does not resolve to a concept binding",
    "move the note into a folder bound to a concept in taxonomy.yaml, or target an existing bound note",
  );
}

function rejectedResult(
  mode: WriteMode,
  notePath: string,
  concept: Concept | undefined,
  frontmatter: Record<string, unknown>,
  violations: WriteContractViolation[],
  reason: string,
  rejectionPayload?: WriteRejection,
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
    ...(rejectionPayload ? { rejection: rejectionPayload } : {}),
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
    rejection: rejection(
      "admission",
      "contract-violation",
      "Capture does not satisfy the concept contract yet",
      `provide or correct these fields, then retry: ${violations
        .map((violation) => violation.field)
        .join(", ")}`,
    ),
  });
}

function writtenResult(
  mode: WriteMode,
  notePath: string,
  concept: Concept | undefined,
  frontmatter: Record<string, unknown>,
  receipt?: WriteReceipt,
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
    ...(receipt ? { receipt } : {}),
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

async function isDirectory(fullPath: string): Promise<boolean> {
  try {
    return (await stat(fullPath)).isDirectory();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
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

/**
 * Admission Rules - target verification.
 *
 * Runs before ANY disk mutation. `cwd` resolution is unverified for the write
 * surface (the process may have booted anywhere). A `global` registry pointer
 * must still point at a real `.oms` ontology; every other source is trusted
 * without an ontology presence check so the bundled-ontology fallback keeps
 * working.
 */
export async function admitWriteTarget(target: WriteTarget): Promise<WriteRejection | undefined> {
  if (target.source === "cwd") {
    return rejection(
      "admission",
      "target-unverified",
      `Refusing to write: the target vault was inferred from the current directory (${target.vault}), which is not a verified Oh My Second Brain vault`,
      "run `oms setup` in your Obsidian vault (or set OMS_VAULT / register the vault in ~/.oms/config.yaml), then retry",
    );
  }

  if (target.source === "global") {
    const hasOntology =
      (await isDirectory(path.join(target.vault, ".oms", "concepts"))) ||
      (await fileExists(path.join(target.vault, ".oms", "taxonomy.yaml")));
    if (!hasOntology) {
      return rejection(
        "admission",
        "target-invalid",
        `Refusing to write: the registered global vault target has no .oms ontology: ${target.vault}`,
        "update ~/.oms/config.yaml to point at your vault, or run `oms setup` in that vault, then retry",
      );
    }
  }

  return undefined;
}

function targetRejectedResult(
  mode: WriteMode,
  input: WriteNoteInput,
  frontmatter: Record<string, unknown>,
  rejectionPayload: WriteRejection,
): WriteNoteResult {
  return rejectedResult(
    mode,
    input.notePath ?? "",
    undefined,
    frontmatter,
    [],
    rejectionPayload.message,
    rejectionPayload,
  );
}

export interface StagedEvaluation {
  ok: boolean;
  violations: WriteContractViolation[];
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Acceptance Criteria - staged evaluation (pre-persist).
 *
 * Parses the note content that is ABOUT to be written and re-runs the kernel
 * write contract against the RENDERED frontmatter. This catches divergence
 * between the caller-supplied frontmatter and what actually lands on disk
 * (yaml round-trip artifacts such as `NaN` rendering as `.nan` and parsing
 * back as `null`).
 */
export function evaluateStagedNote(
  stagedContent: string,
  concept: Concept,
  notePath: string,
  strictZones: ReadonlySet<string>,
): StagedEvaluation {
  const parsed = parseNote(stagedContent);
  const contract = evaluateWriteContract(parsed.frontmatter, concept, notePath, strictZones);
  return {
    ok: contract.valid,
    violations: contract.violations,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
  };
}

function sameViolationSet(
  left: readonly WriteContractViolation[],
  right: readonly WriteContractViolation[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const key = (violation: WriteContractViolation): string =>
    `${violation.field}\u0000${violation.rule}\u0000${violation.message}`;
  const leftKeys = left.map(key).sort();
  const rightKeys = right.map(key).sort();
  return leftKeys.every((entry, index) => entry === rightKeys[index]);
}

/**
 * Acceptance rejection for a staged render that diverges from the (already
 * passing) input evaluation. Callers only reach this when the input-level
 * contract check passed, so the violation is a genuine render divergence.
 */
function stagedRejectedResult(
  mode: WriteMode,
  notePath: string,
  concept: Concept,
  frontmatter: Record<string, unknown>,
  violations: WriteContractViolation[],
): WriteNoteResult {
  const fields = violations.map((violation) => violation.field).join(", ");
  return rejectedResult(
    mode,
    notePath,
    concept,
    frontmatter,
    violations,
    "Cannot write: the rendered note violates the concept contract",
    rejection(
      "acceptance",
      "contract-violation",
      `Staged note render violates the concept contract (${fields})`,
      `these values do not survive the note render unchanged - correct them, then retry: ${fields}`,
    ),
  );
}

function stagedBodyMissingResult(
  mode: WriteMode,
  notePath: string,
  concept: Concept,
  frontmatter: Record<string, unknown>,
): WriteNoteResult {
  return rejectedResult(
    mode,
    notePath,
    concept,
    frontmatter,
    [],
    "create requires a body",
    rejection(
      "acceptance",
      "body-missing",
      "Staged note render carries no body content",
      "pass a non-empty `body` for the note, then retry",
    ),
  );
}

function postconditionRejectedResult(
  mode: WriteMode,
  notePath: string,
  fullPath: string,
  concept: Concept,
  frontmatter: Record<string, unknown>,
  violations: WriteContractViolation[],
  detail: string,
): WriteNoteResult {
  return rejectedResult(
    mode,
    notePath,
    concept,
    frontmatter,
    violations,
    `Postcondition failed after writing ${notePath}: ${detail}`,
    rejection(
      "acceptance",
      "postcondition-failed",
      `Postcondition failed after writing ${notePath}: ${detail}`,
      `inspect the persisted file at ${fullPath} (it was NOT removed) and repair or delete it before retrying`,
    ),
  );
}

function receiptFor(
  input: WriteNoteInput,
  mode: WriteMode,
  notePath: string,
  concept: Concept | undefined,
): WriteReceipt {
  return {
    resolvedVault: input.target.vault,
    resolutionSource: input.target.source,
    notePath,
    mode,
    concept: concept?.concept ?? null,
    postconditionVerified: true,
  };
}

function normalizeBody(body: string): string {
  return body.replace(/\s+$/, "");
}

interface PostconditionCheck {
  ok: boolean;
  violations: WriteContractViolation[];
  detail: string;
}

/**
 * Acceptance Criteria - postcondition (post-persist).
 *
 * Re-reads the persisted note through the `readBack` seam, re-runs the write
 * contract on what is actually on disk, and asserts the intended body content
 * landed. The persisted file is never auto-deleted on failure.
 */
async function verifyPostcondition(
  input: WriteNoteInput,
  fullPath: string,
  notePath: string,
  concept: Concept,
  strictZones: ReadonlySet<string>,
  expectation: { kind: "full"; body: string } | { kind: "suffix"; body: string },
): Promise<PostconditionCheck> {
  const read = input.readBack ?? ((target: string) => readFile(target, "utf-8"));
  const persisted = await read(fullPath);
  const parsed = parseNote(persisted);
  const contract = evaluateWriteContract(parsed.frontmatter, concept, notePath, strictZones);
  if (!contract.valid) {
    return {
      ok: false,
      violations: contract.violations,
      detail: `persisted frontmatter violates the concept contract (${contract.violations
        .map((violation) => violation.field)
        .join(", ")})`,
    };
  }

  const bodyOk =
    expectation.kind === "full"
      ? normalizeBody(parsed.body) === normalizeBody(expectation.body)
      : normalizeBody(persisted).endsWith(expectation.body.trim());
  if (!bodyOk) {
    return { ok: false, violations: [], detail: "persisted body does not match the staged content" };
  }

  return { ok: true, violations: [], detail: "" };
}

export async function writeNote(input: WriteNoteInput): Promise<WriteNoteResult> {
  const frontmatter = input.frontmatter ?? {};
  const strictZones = routingLawStrictFolders(input.ontology);

  const targetRejection = await admitWriteTarget(input.target);
  if (targetRejection) {
    return targetRejectedResult(input.mode, input, frontmatter, targetRejection);
  }

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
    const safe = trySafeNotePath(input.target.vault, input.notePath);
    if (!safe.ok) {
      return rejectedResult(
        "create",
        input.notePath,
        undefined,
        frontmatter,
        [],
        safe.reason,
        pathUnsafeRejection(safe.reason),
      );
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
      rejection(
        "admission",
        "body-missing",
        "create requires a body",
        "pass a non-empty `body` for the note, then retry",
      ),
    );
  }

  const safe = trySafeNotePath(input.target.vault, notePath);
  if (!safe.ok) {
    return rejectedResult(
      "create",
      notePath,
      concept,
      frontmatter,
      [],
      safe.reason,
      pathUnsafeRejection(safe.reason),
    );
  }

  if (await fileExists(safe.fullPath)) {
    return rejectedResult(
      "create",
      notePath,
      concept,
      frontmatter,
      [],
      "Cannot create capture: target note already exists",
      rejection(
        "admission",
        "note-exists",
        "Cannot create capture: target note already exists",
        "use mode `append` or `update` for an existing note, or choose a different filename",
      ),
    );
  }

  // Write Attempt: build the staged note in memory.
  const staged = formatNote(frontmatter, input.body);

  // Evaluation (pre-persist): the staged render is a second gate that only
  // fires on divergence from the input evaluation, which already passed above.
  const stagedEvaluation = evaluateStagedNote(staged, concept, notePath, strictZones);
  if (!stagedEvaluation.ok && !sameViolationSet(stagedEvaluation.violations, contract.violations)) {
    return stagedRejectedResult(
      "create",
      notePath,
      concept,
      frontmatter,
      stagedEvaluation.violations,
    );
  }
  if (stagedEvaluation.body.trim() === "") {
    return stagedBodyMissingResult("create", notePath, concept, frontmatter);
  }

  if (input.dryRun) {
    return writtenResult("create", notePath, concept, frontmatter);
  }

  // Persist.
  await mkdir(path.dirname(safe.fullPath), { recursive: true });
  await writeFile(safe.fullPath, staged, {
    encoding: "utf-8",
    flag: "wx",
  });

  // Postcondition.
  const postcondition = await verifyPostcondition(
    input,
    safe.fullPath,
    notePath,
    concept,
    strictZones,
    { kind: "full", body: stagedEvaluation.body },
  );
  if (!postcondition.ok) {
    return postconditionRejectedResult(
      "create",
      notePath,
      safe.fullPath,
      concept,
      frontmatter,
      postcondition.violations,
      postcondition.detail,
    );
  }

  return writtenResult(
    "create",
    notePath,
    concept,
    frontmatter,
    receiptFor(input, "create", notePath, concept),
  );
}

async function writeAppend(
  input: WriteNoteInput,
  frontmatter: Record<string, unknown>,
  strictZones: ReadonlySet<string>,
): Promise<WriteNoteResult> {
  if (!input.notePath) {
    return rejectedResult(
      "append",
      "",
      undefined,
      frontmatter,
      [],
      "append requires notePath",
      rejection(
        "admission",
        "args-invalid",
        "append requires notePath",
        "pass the vault-relative `notePath` of the note to append to, then retry",
      ),
    );
  }
  if (input.body === undefined) {
    return rejectedResult(
      "append",
      input.notePath,
      undefined,
      frontmatter,
      [],
      "append requires a body",
      rejection(
        "admission",
        "body-missing",
        "append requires a body",
        "pass a non-empty `body` to append, then retry",
      ),
    );
  }

  const safe = trySafeNotePath(input.target.vault, input.notePath);
  if (!safe.ok) {
    return rejectedResult(
      "append",
      input.notePath,
      undefined,
      frontmatter,
      [],
      safe.reason,
      pathUnsafeRejection(safe.reason),
    );
  }

  const exists = await fileExists(safe.fullPath);
  if (!exists) {
    const created = await writeCreate(
      {
        target: input.target,
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
      ...(created.receipt ? { receipt: { ...created.receipt, mode: "append" as const } } : {}),
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
      conceptUnboundRejection(),
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

  // Write Attempt: the staged note is exactly what the file will hold after the
  // append (current content + the appended block).
  const appended = `\n\n${input.body.trim()}\n`;
  const staged = `${raw}${appended}`;

  // Evaluation (pre-persist).
  const stagedEvaluation = evaluateStagedNote(staged, concept, safe.normalized, strictZones);
  if (!stagedEvaluation.ok && !sameViolationSet(stagedEvaluation.violations, contract.violations)) {
    return stagedRejectedResult(
      "append",
      safe.normalized,
      concept,
      parsed.frontmatter,
      stagedEvaluation.violations,
    );
  }

  if (input.dryRun) {
    return writtenResult("append", safe.normalized, concept, parsed.frontmatter);
  }

  // Persist.
  await appendFile(safe.fullPath, appended, "utf-8");

  // Postcondition.
  const postcondition = await verifyPostcondition(
    input,
    safe.fullPath,
    safe.normalized,
    concept,
    strictZones,
    { kind: "suffix", body: input.body },
  );
  if (!postcondition.ok) {
    return postconditionRejectedResult(
      "append",
      safe.normalized,
      safe.fullPath,
      concept,
      parsed.frontmatter,
      postcondition.violations,
      postcondition.detail,
    );
  }

  return writtenResult(
    "append",
    safe.normalized,
    concept,
    parsed.frontmatter,
    receiptFor(input, "append", safe.normalized, concept),
  );
}

async function writeUpdate(
  input: WriteNoteInput,
  frontmatter: Record<string, unknown>,
  strictZones: ReadonlySet<string>,
): Promise<WriteNoteResult> {
  if (!input.notePath) {
    return rejectedResult(
      "update",
      "",
      undefined,
      frontmatter,
      [],
      "update requires notePath",
      rejection(
        "admission",
        "args-invalid",
        "update requires notePath",
        "pass the vault-relative `notePath` of the note to update, then retry",
      ),
    );
  }
  if (input.frontmatter === undefined && input.body === undefined) {
    return rejectedResult(
      "update",
      input.notePath,
      undefined,
      frontmatter,
      [],
      "update requires frontmatter or body",
      rejection(
        "admission",
        "args-invalid",
        "update requires frontmatter or body",
        "pass `frontmatter`, `body`, or both, then retry",
      ),
    );
  }

  const safe = trySafeNotePath(input.target.vault, input.notePath);
  if (!safe.ok) {
    return rejectedResult(
      "update",
      input.notePath,
      undefined,
      frontmatter,
      [],
      safe.reason,
      pathUnsafeRejection(safe.reason),
    );
  }

  if (!(await fileExists(safe.fullPath))) {
    return rejectedResult(
      "update",
      safe.normalized,
      undefined,
      frontmatter,
      [],
      "Cannot update capture: target note does not exist",
      rejection(
        "admission",
        "note-missing",
        "Cannot update capture: target note does not exist",
        "create the note first (mode `create`) or correct `notePath`, then retry",
      ),
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
      conceptUnboundRejection(),
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

  // Write Attempt: build the staged note in memory.
  const staged = formatNote(merged, body);

  // Evaluation (pre-persist).
  const stagedEvaluation = evaluateStagedNote(staged, concept, safe.normalized, strictZones);
  if (!stagedEvaluation.ok && !sameViolationSet(stagedEvaluation.violations, contract.violations)) {
    return stagedRejectedResult("update", safe.normalized, concept, merged, stagedEvaluation.violations);
  }

  if (input.dryRun) {
    return writtenResult("update", safe.normalized, concept, merged);
  }

  // Persist.
  await writeFile(safe.fullPath, staged, "utf-8");

  // Postcondition.
  const postcondition = await verifyPostcondition(
    input,
    safe.fullPath,
    safe.normalized,
    concept,
    strictZones,
    { kind: "full", body: stagedEvaluation.body },
  );
  if (!postcondition.ok) {
    return postconditionRejectedResult(
      "update",
      safe.normalized,
      safe.fullPath,
      concept,
      merged,
      postcondition.violations,
      postcondition.detail,
    );
  }

  return writtenResult(
    "update",
    safe.normalized,
    concept,
    merged,
    receiptFor(input, "update", safe.normalized, concept),
  );
}

export async function commitCapture(input: CaptureCommitInput): Promise<CaptureCommitResult> {
  const result = await writeNote({
    target: { vault: input.vault, source: input.source },
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
