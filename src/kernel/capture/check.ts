import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parseNote } from "../conventions/frontmatter.js";
import { evaluateResolvedTemplateContract, type TemplateContractViolation } from "../conventions/write-contract.js";
import {
  buildEvidenceManifest,
  computeFindingId,
  createReadSnapshot,
  createReviewRequest,
  evaluateCompletion,
  validateReadSnapshot,
  validateSemanticReview,
  validateTaskBinding,
  verifyEvidence,
  CompletionContractError,
  type CompletionDigest,
  type CompletionEvaluation,
  type CompletionFailure,
  type CompletionRubric,
  type CompletionSnapshot,
  type EvidenceRef,
  type MachineEvaluation,
  type MachineFinding,
  type ReadSnapshot,
  type ReviewRequest,
  type SemanticReview,
  type TaskBinding,
} from "../conventions/completion-contract.js";
import type { JsonValue } from "../templates/types.js";
import { loadResolvedTemplates } from "../templates/resolver.js";
import { declaredTemplateId, getWriteGuidance, prepareApprovedWrite, type WritePreparation } from "./guidance.js";
import { admitWriteTarget, verifyVaultNotePath, type WriteTarget } from "./safe.js";

/**
 * Check and complete read the note the agent already saved.
 *
 * Neither writes vault bytes, launches a reviewer, or selects a model. A machine
 * pass is mechanics only; completion also requires a real separate review of the
 * same inputs, read again before and after that review.
 */

export type CheckRejectionCode =
  | "TARGET_UNVERIFIED"
  | "TARGET_INVALID"
  | "PATH_UNSAFE"
  | "NOTE_MISSING"
  | "NOTE_UNREADABLE"
  | "TASK_BINDING_INVALID"
  | "TASK_BINDING_MISMATCH"
  | "SNAPSHOT_STALE"
  | "EVIDENCE_INVALID"
  | "EVIDENCE_MISSING"
  | "CONTRACT_UNVERIFIABLE"
  | "CONTRACT_TRANSACTION_IN_PROGRESS"
  | "RUBRIC_INVALID"
  | "REVIEW_SCHEMA_INVALID";

export interface CheckRejection {
  readonly code: CheckRejectionCode;
  readonly message: string;
  readonly remediation: string;
}

export interface CheckRequest {
  /** Trusted target. A `cwd` inference is refused before any vault read. */
  readonly target: WriteTarget;
  readonly notePath: string;
  readonly templateId?: string | null;
  /** Binding returned by guide. Omitted means check recomputes it from the live vault. */
  readonly binding?: unknown;
  /** Extra vault-relative evidence files the caller wants bound into the review. */
  readonly evidencePaths?: readonly string[];
}

export interface CheckReport {
  readonly status: "pass" | "fail" | "rejected";
  readonly notePath: string | null;
  readonly templateId: string | null;
  readonly taskId: CompletionDigest | null;
  readonly binding: TaskBinding | null;
  readonly machine: MachineEvaluation | null;
  readonly rubric: CompletionRubric | null;
  readonly request: ReviewRequest | null;
  /** JSON-safe carrier for the exact inputs `complete` must re-read and compare. */
  readonly checkpoint: CompletionCheckpoint | null;
  readonly rejection: CheckRejection | null;
}

/**
 * Digest-bound checkpoint.
 *
 * `ReadSnapshot` carries raw bytes, which do not survive JSON. The checkpoint
 * records only paths and digests, so `complete` re-reads the bytes from disk and
 * compares them. A caller cannot substitute its own "before" bytes.
 */
export interface CompletionCheckpoint {
  readonly schemaVersion: 1;
  readonly binding: TaskBinding;
  readonly taskId: CompletionDigest;
  readonly notePath: string;
  readonly noteDigest: CompletionDigest;
  readonly contractDigest: CompletionDigest;
  readonly rubricDigest: CompletionDigest | null;
  readonly requestDigest: CompletionDigest;
  readonly reviewerPromptDigest: CompletionDigest;
  readonly targetIds: readonly string[];
  readonly evidenceManifest: readonly EvidenceRef[];
  readonly evidencePaths: readonly string[];
}

export interface CompleteRequest {
  readonly target: WriteTarget;
  readonly checkpoint: unknown;
  /** Structured result from a real separate reviewer, normalized by the harness adapter. */
  readonly review: unknown;
}

export interface CompleteReport {
  readonly status: "complete" | "incomplete" | "rejected";
  readonly taskId: CompletionDigest | null;
  readonly requestDigest: CompletionDigest | null;
  readonly machine: MachineEvaluation | null;
  readonly evaluation: CompletionEvaluation | null;
  readonly failures: readonly CompletionFailure[];
  readonly rejection: CheckRejection | null;
}

const REMEDIATION: Readonly<Record<CheckRejectionCode, string>> = {
  TARGET_UNVERIFIED: "pass an explicit vault (or set OMS_VAULT); a current-directory inference is not a verified target",
  TARGET_INVALID: "pass an existing vault directory",
  PATH_UNSAFE: "pass a vault-relative .md note path that stays inside the vault",
  NOTE_MISSING: "save the note first; OMS checks the file on disk and never writes it",
  NOTE_UNREADABLE: "make the note readable, then retry",
  TASK_BINDING_INVALID: "call guide again and forward the binding it returns",
  TASK_BINDING_MISMATCH: "the binding belongs to another vault, note, or contract; call guide for this note",
  SNAPSHOT_STALE: "the note, contract, or evidence changed; run check again before completing",
  EVIDENCE_INVALID: "reference evidence inside the vault with a real line span",
  EVIDENCE_MISSING: "the declared evidence file is absent; save it or drop the reference",
  CONTRACT_UNVERIFIABLE: "restore the approved .oms/template-policy.json or publish it again",
  CONTRACT_TRANSACTION_IN_PROGRESS: "finish or resume the contract publication, then retry",
  RUBRIC_INVALID: "fix the approved semantic criteria in the policy",
  REVIEW_SCHEMA_INVALID: "submit the separate reviewer's structured result unchanged",
};

function reject(code: CheckRejectionCode, message: string): CheckRejection {
  return { code, message, remediation: REMEDIATION[code] };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
}

function contractRejection(error: unknown): CheckRejection {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("CONTRACT_TRANSACTION_IN_PROGRESS")) return reject("CONTRACT_TRANSACTION_IN_PROGRESS", message);
  if (error instanceof CompletionContractError) {
    const code = error.code;
    if (code === "TASK_BINDING_INVALID" || code === "TASK_BINDING_MISMATCH" || code === "SNAPSHOT_STALE"
      || code === "EVIDENCE_INVALID" || code === "EVIDENCE_MISSING" || code === "RUBRIC_INVALID"
      || code === "REVIEW_SCHEMA_INVALID") {
      return reject(code, message);
    }
    // An inadmissible review is a submission defect, not a damaged contract.
    if (code === "REVIEW_EXECUTION_FAILED" || code === "REVIEWER_UNAVAILABLE") return reject("REVIEW_SCHEMA_INVALID", message);
  }
  return reject("CONTRACT_UNVERIFIABLE", message);
}

/** `field/<escaped>`, `heading/<id>`, and `criterion/<id>` are the stable target ids. */
function escapeTargetSegment(value: string): string {
  return value.normalize("NFC").replace(/[%/]/gu, character => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`);
}

function fieldTargetId(field: string): string {
  return `field/${escapeTargetSegment(field)}`;
}

function violationTargetId(violation: TemplateContractViolation): string {
  return violation.rule === "heading"
    ? `heading/${escapeTargetSegment(violation.field.replace(/^body:/u, ""))}`
    : fieldTargetId(violation.field);
}

interface MachineBinding {
  readonly taskId: CompletionDigest;
  readonly noteDigest: CompletionDigest;
  readonly contractDigest: CompletionDigest;
}

function machineEvaluation(violations: readonly TemplateContractViolation[], binding: MachineBinding): MachineEvaluation {
  const findings: MachineFinding[] = violations.map(violation => {
    const targetId = violationTargetId(violation);
    // The finding id is recomputed from the rule and target, so it is stable
    // across processes without being an issued credential.
    computeFindingId(violation.rule, targetId);
    return { ruleId: violation.rule, targetId, message: violation.message };
  });
  return { ...binding, status: findings.length === 0 ? "pass" : "fail", findings };
}

function contractTargetIds(preparation: WritePreparation): readonly string[] {
  return [
    ...Object.keys(preparation.fields).map(fieldTargetId),
    ...preparation.headings.map(heading => `heading/${escapeTargetSegment(heading.headingId)}`),
    ...preparation.semanticCriteria.map(criterion => `criterion/${escapeTargetSegment(criterion.criterionId)}`),
  ];
}

async function readNoteSnapshot(vaultRoot: string, notePath: string): Promise<ReadSnapshot> {
  const bytes = await readFile(path.resolve(vaultRoot, notePath));
  return createReadSnapshot(notePath, new Uint8Array(bytes));
}

/**
 * Evidence files are re-read through the same confinement guard as the note.
 * A traversal, symlink, hidden, or outside-vault reference is refused rather
 * than silently skipped.
 */
async function readEvidenceSnapshots(
  vaultRoot: string,
  evidencePaths: readonly string[],
): Promise<{ readonly snapshots: readonly ReadSnapshot[] } | { readonly rejection: CheckRejection }> {
  const snapshots: ReadSnapshot[] = [];
  for (const candidate of evidencePaths) {
    const verified = await verifyVaultNotePath(vaultRoot, candidate);
    if (!verified.ok) return { rejection: reject("EVIDENCE_INVALID", verified.rejection.message) };
    try {
      snapshots.push(await readNoteSnapshot(verified.vaultRoot, verified.notePath));
    } catch (error: unknown) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") {
        return { rejection: reject("EVIDENCE_MISSING", `declared evidence ${verified.notePath} is not on disk`) };
      }
      return { rejection: reject("EVIDENCE_INVALID", error instanceof Error ? error.message : String(error)) };
    }
  }
  return { snapshots };
}

function jsonFrontmatter(frontmatter: Readonly<Record<string, unknown>>): Readonly<Record<string, JsonValue>> {
  const fields: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [key, value] of Object.entries(frontmatter)) fields[key] = value as JsonValue;
  return fields;
}

interface EvaluatedNote {
  readonly note: ReadSnapshot;
  readonly machine: MachineEvaluation;
}

function evaluateSavedNote(note: ReadSnapshot, preparation: WritePreparation): EvaluatedNote {
  const binding: MachineBinding = {
    taskId: preparation.taskId,
    noteDigest: note.digest,
    contractDigest: preparation.contractDigest,
  };
  const parsed = parseNote(new TextDecoder().decode(note.bytes));
  if (parsed.diagnostics.length > 0) {
    const findings: MachineFinding[] = parsed.diagnostics.map(diagnostic => ({
      ruleId: diagnostic.code,
      targetId: "field/%2F",
      message: diagnostic.message,
    }));
    return { note, machine: { ...binding, status: "fail", findings } };
  }
  const contract = {
    templateId: preparation.templateId,
    headingOrder: preparation.headingOrder,
    fields: preparation.fields,
    headings: preparation.headings,
    semanticCriteria: preparation.semanticCriteria,
    approved: {
      defaultLayer: { markdown: preparation.approvedMarkdown.defaultLayer },
      ...(preparation.approvedMarkdown.templateLayer === null
        ? {}
        : { templateLayer: { markdown: preparation.approvedMarkdown.templateLayer } }),
    },
  } as unknown as Parameters<typeof evaluateResolvedTemplateContract>[1];
  const result = evaluateResolvedTemplateContract(jsonFrontmatter(parsed.frontmatter), contract, parsed.body);
  return { note, machine: machineEvaluation(result.violations, binding) };
}


async function resolvePreparation(
  request: Pick<CheckRequest, "target" | "notePath" | "templateId">,
): Promise<{ readonly preparation: WritePreparation; readonly vaultRoot: string } | { readonly rejection: CheckRejection }> {
  const guidance = await getWriteGuidance({
    target: request.target,
    notePath: request.notePath,
    ...(request.templateId === undefined ? {} : { templateId: request.templateId }),
  });
  if (guidance.rejection !== null) {
    const code = guidance.rejection.code;
    const mapped: CheckRejectionCode =
      code === "TEMPLATE_ID_EMPTY" || code === "TEMPLATE_UNKNOWN" ? "TASK_BINDING_MISMATCH" : code;
    return { rejection: reject(mapped, guidance.rejection.message) };
  }
  if (guidance.preparation === null) {
    return { rejection: reject("PATH_UNSAFE", guidance.pathRequest?.message ?? "a note path is required") };
  }
  return { preparation: guidance.preparation, vaultRoot: await realpath(request.target.vault) };
}

/**
 * Reads the saved note and returns machine findings plus an immutable review
 * request. It never accepts a caller verdict or an unsaved body.
 */
export async function checkSavedNote(request: CheckRequest): Promise<CheckReport> {
  const empty: Omit<CheckReport, "status" | "rejection"> = {
    notePath: null, templateId: null, taskId: null, binding: null,
    machine: null, rubric: null, request: null, checkpoint: null,
  };
  const admission = await admitWriteTarget(request.target);
  if (admission !== undefined) return { ...empty, status: "rejected", rejection: reject("TARGET_UNVERIFIED", admission.message) };

  // The saved note declares its own identity. When the caller does not name a
  // template, that declaration decides the contract; otherwise a note bound to
  // a template would be checked against the default layer alone and its
  // template's rules would go unreported.
  let templateId = request.templateId;
  if (templateId === undefined) {
    try {
      templateId = await declaredTemplateId(request.target.vault, request.notePath);
    } catch {
      templateId = undefined;
    }
  }

  let resolved: Awaited<ReturnType<typeof resolvePreparation>>;
  try {
    resolved = await resolvePreparation({ ...request, ...(templateId === undefined ? {} : { templateId }) });
  } catch (error: unknown) {
    return { ...empty, status: "rejected", rejection: contractRejection(error) };
  }
  if ("rejection" in resolved) return { ...empty, status: "rejected", rejection: resolved.rejection };
  const { preparation, vaultRoot } = resolved;

  if (request.binding !== undefined) {
    try {
      const supplied = validateTaskBinding(request.binding);
      const live = preparation.binding;
      if (supplied.vaultFingerprint !== live.vaultFingerprint || supplied.notePath !== live.notePath
        || supplied.templateId !== live.templateId) {
        return { ...empty, status: "rejected", rejection: reject("TASK_BINDING_MISMATCH", "the binding does not describe this vault, note, and template") };
      }
      if (supplied.contractDigest !== live.contractDigest || supplied.rubricDigest !== live.rubricDigest) {
        return { ...empty, status: "rejected", rejection: reject("SNAPSHOT_STALE", "the approved contract or rubric changed after guide") };
      }
    } catch (error: unknown) {
      return { ...empty, status: "rejected", rejection: contractRejection(error) };
    }
  }

  let note: ReadSnapshot;
  try {
    note = await readNoteSnapshot(vaultRoot, preparation.notePath);
  } catch (error: unknown) {
    const code = errorCode(error);
    return {
      ...empty,
      status: "rejected",
      rejection: code === "ENOENT" || code === "ENOTDIR"
        ? reject("NOTE_MISSING", `${preparation.notePath} is not saved yet`)
        : reject("NOTE_UNREADABLE", error instanceof Error ? error.message : String(error)),
    };
  }

  const evidencePaths = [...new Set(request.evidencePaths ?? [])].sort();
  const evidence = await readEvidenceSnapshots(vaultRoot, evidencePaths);
  if ("rejection" in evidence) return { ...empty, status: "rejected", rejection: evidence.rejection };

  const { machine } = evaluateSavedNote(note, preparation);
  try {
    const manifest = buildEvidenceManifest({
      rubric: preparation.rubric,
      evidencePaths,
      evidenceSnapshots: evidence.snapshots,
    });
    const review = createReviewRequest({
      binding: preparation.binding,
      note,
      rubric: preparation.rubric,
      evidenceManifest: manifest,
      targetIds: contractTargetIds(preparation),
    });
    return {
      status: machine.status === "pass" ? "pass" : "fail",
      notePath: preparation.notePath,
      templateId: preparation.templateId,
      taskId: preparation.taskId,
      binding: preparation.binding,
      machine,
      rubric: preparation.rubric,
      request: review,
      checkpoint: {
        schemaVersion: 1,
        binding: preparation.binding,
        taskId: preparation.taskId,
        notePath: preparation.notePath,
        noteDigest: note.digest,
        contractDigest: review.contractDigest,
        rubricDigest: review.rubricDigest,
        requestDigest: review.requestDigest,
        reviewerPromptDigest: review.reviewerPromptDigest,
        targetIds: review.targetIds,
        evidenceManifest: review.evidenceManifest,
        evidencePaths,
      },
      rejection: null,
    };
  } catch (error: unknown) {
    return { ...empty, status: "rejected", rejection: contractRejection(error) };
  }
}

function validateCheckpoint(value: unknown): CompletionCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CompletionContractError("TASK_BINDING_INVALID", "checkpoint must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record["schemaVersion"] !== 1) throw new CompletionContractError("TASK_BINDING_INVALID", "unsupported checkpoint schema version");
  const binding = validateTaskBinding(record["binding"]);
  const evidencePaths = Array.isArray(record["evidencePaths"]) ? record["evidencePaths"] : [];
  if (!evidencePaths.every((entry): entry is string => typeof entry === "string")) {
    throw new CompletionContractError("EVIDENCE_INVALID", "checkpoint evidencePaths must be strings");
  }
  for (const key of ["taskId", "noteDigest", "contractDigest", "requestDigest", "reviewerPromptDigest"]) {
    if (typeof record[key] !== "string") throw new CompletionContractError("TASK_BINDING_INVALID", `checkpoint ${key} must be a digest`);
  }
  return { ...(record as unknown as CompletionCheckpoint), binding, evidencePaths };
}

function completionSnapshot(note: ReadSnapshot, rubric: CompletionRubric | null, contractDigest: CompletionDigest, evidence: readonly ReadSnapshot[]): CompletionSnapshot {
  return { note, contractDigest, rubric, evidenceSnapshots: evidence };
}

/**
 * Re-reads the note, controls, and evidence, re-runs mechanics, rebuilds the
 * request, and combines it with a real separate review. The reviewer is neither
 * launched nor trusted to describe OMS-observed facts.
 */
export async function completeSavedNote(request: CompleteRequest): Promise<CompleteReport> {
  const empty: Omit<CompleteReport, "status" | "rejection"> = {
    taskId: null, requestDigest: null, machine: null, evaluation: null, failures: [],
  };
  const admission = await admitWriteTarget(request.target);
  if (admission !== undefined) return { ...empty, status: "rejected", rejection: reject("TARGET_UNVERIFIED", admission.message) };

  let checkpoint: CompletionCheckpoint;
  let review: SemanticReview;
  try {
    checkpoint = validateCheckpoint(request.checkpoint);
    review = validateSemanticReview(request.review);
  } catch (error: unknown) {
    return { ...empty, status: "rejected", rejection: contractRejection(error) };
  }

  const recheck = await checkSavedNote({
    target: request.target,
    notePath: checkpoint.binding.notePath,
    templateId: checkpoint.binding.templateId,
    binding: checkpoint.binding,
    evidencePaths: checkpoint.evidencePaths,
  });
  if (recheck.rejection !== null) return { ...empty, status: "rejected", rejection: recheck.rejection };
  if (recheck.request === null || recheck.machine === null || recheck.checkpoint === null) {
    return { ...empty, status: "rejected", rejection: reject("SNAPSHOT_STALE", "the note could not be re-evaluated") };
  }
  if (recheck.checkpoint.requestDigest !== checkpoint.requestDigest
    || recheck.checkpoint.noteDigest !== checkpoint.noteDigest
    || recheck.checkpoint.reviewerPromptDigest !== checkpoint.reviewerPromptDigest) {
    return {
      ...empty,
      status: "incomplete",
      failures: [{ code: "SNAPSHOT_STALE", message: "the note, contract, rubric, or evidence changed after check" }],
      machine: recheck.machine,
      taskId: recheck.taskId,
      requestDigest: recheck.request.requestDigest,
      rejection: null,
    };
  }

  const vaultRoot = await realpath(request.target.vault);
  const before = await readEvidenceSnapshots(vaultRoot, checkpoint.evidencePaths);
  if ("rejection" in before) return { ...empty, status: "rejected", rejection: before.rejection };
  const beforeNote = validateReadSnapshot(recheck.request.note);
  const afterNote = await readNoteSnapshot(vaultRoot, checkpoint.binding.notePath);
  const after = await readEvidenceSnapshots(vaultRoot, checkpoint.evidencePaths);
  if ("rejection" in after) return { ...empty, status: "rejected", rejection: after.rejection };

  const evaluation = evaluateCompletion({
    request: recheck.request,
    machine: recheck.machine,
    review,
    before: completionSnapshot(beforeNote, recheck.rubric, recheck.request.contractDigest, before.snapshots),
    after: completionSnapshot(afterNote, recheck.rubric, recheck.request.contractDigest, after.snapshots),
  });
  return {
    status: evaluation.complete ? "complete" : "incomplete",
    taskId: evaluation.taskId,
    requestDigest: evaluation.requestDigest,
    machine: recheck.machine,
    evaluation,
    failures: evaluation.failures,
    rejection: null,
  };
}

/** Verifies declared evidence against a note without judging completion. */
export function verifyDeclaredEvidence(
  note: ReadSnapshot,
  manifest: readonly EvidenceRef[],
  evidenceSnapshots: readonly ReadSnapshot[],
): ReturnType<typeof verifyEvidence> {
  return verifyEvidence(note, manifest, evidenceSnapshots);
}

/** Loads the approved snapshot for callers that report contract state beside a check. */
export async function readApprovedSnapshot(vault: string): Promise<ReturnType<typeof loadResolvedTemplates>> {
  return loadResolvedTemplates(vault);
}

export { prepareApprovedWrite };
