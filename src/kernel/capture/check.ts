import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parseNote } from "../conventions/frontmatter.js";
import { evaluateResolvedTemplateContract, type TemplateContractViolation } from "../conventions/write-contract.js";
import {
  computeFindingId,
  createReadSnapshot,
  validateTaskBinding,
  CompletionContractError,
  type CompletionDigest,
  type MachineEvaluation,
  type MachineFinding,
  type ReadSnapshot,
  type TaskBinding,
} from "../conventions/completion-contract.js";
import type { JsonValue } from "../templates/types.js";
import { loadResolvedTemplates } from "../templates/resolver.js";
import { declaredTemplateId, getWriteGuidance, prepareApprovedWrite, type WritePreparation } from "./guidance.js";
import { admitWriteTarget, type WriteTarget } from "./safe.js";

/**
 * Check reads the note the agent already saved.
 *
 * It writes no vault bytes, launches no reviewer, and selects no model. The
 * report is mechanics only: declared frontmatter fields and headings against
 * the approved contract. OMS does not judge whether the writing is good.
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
  | "CONTRACT_UNVERIFIABLE"
  | "CONTRACT_TRANSACTION_IN_PROGRESS"
  | "RUBRIC_INVALID";

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
}

export interface CheckReport {
  readonly status: "pass" | "fail" | "rejected";
  readonly notePath: string | null;
  readonly templateId: string | null;
  readonly taskId: CompletionDigest | null;
  readonly binding: TaskBinding | null;
  readonly machine: MachineEvaluation | null;
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
  SNAPSHOT_STALE: "the note or contract changed; call guide again for this note",
  CONTRACT_UNVERIFIABLE: "restore the approved .oms/template-policy.json or publish it again",
  CONTRACT_TRANSACTION_IN_PROGRESS: "finish or resume the contract publication, then retry",
  RUBRIC_INVALID: "fix the approved semantic criteria in the policy",
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
      || code === "RUBRIC_INVALID") {
      return reject(code, message);
    }
  }
  return reject("CONTRACT_UNVERIFIABLE", message);
}

/** `field/<escaped>` and `heading/<id>` are the stable target ids. */
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

async function readNoteSnapshot(vaultRoot: string, notePath: string): Promise<ReadSnapshot> {
  const bytes = await readFile(path.resolve(vaultRoot, notePath));
  return createReadSnapshot(notePath, new Uint8Array(bytes));
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
 * Reads the saved note and returns machine findings. It never accepts a caller
 * verdict, an unsaved body, or a semantic judgement.
 */
export async function checkSavedNote(request: CheckRequest): Promise<CheckReport> {
  const empty: Omit<CheckReport, "status" | "rejection"> = {
    notePath: null, templateId: null, taskId: null, binding: null, machine: null,
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

  const { machine } = evaluateSavedNote(note, preparation);
  return {
    status: machine.status === "pass" ? "pass" : "fail",
    notePath: preparation.notePath,
    templateId: preparation.templateId,
    taskId: preparation.taskId,
    binding: preparation.binding,
    machine,
    rejection: null,
  };
}

/** Loads the approved snapshot for callers that report contract state beside a check. */
export async function readApprovedSnapshot(vault: string): Promise<ReturnType<typeof loadResolvedTemplates>> {
  return loadResolvedTemplates(vault);
}

export { prepareApprovedWrite };
