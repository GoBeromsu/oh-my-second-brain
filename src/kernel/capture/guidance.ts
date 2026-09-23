import { readFile } from "node:fs/promises";
import { parseNote } from "../conventions/frontmatter.js";
import { CompletionContractError, type CompletionCriterion, type CompletionDigest, type CompletionRubric, type TaskBinding, computeRubricDigest, computeTaskId, createTaskBinding, validateRubric } from "../conventions/completion-contract.js";
import type { WriteRejection } from "../conventions/write-protocol.js";
import { digestBytes } from "../templates/canonical.js";
import { normalizeTemplateSourcePath } from "../templates/paths.js";
import { loadResolvedTemplates, type ResolvedTemplateSnapshot } from "../templates/resolver.js";
import type { Diagnostic, DiagnosticCode, HeadingOrder, ResolvedContract, ResolvedField, ResolvedHeading } from "../templates/types.js";
import { admitWriteTarget, safeVaultNotePath, verifyVaultNotePath, type VerifiedVaultNotePath, type WriteTarget } from "./safe.js";

/**
 * Read-only write guide. Approved policy snapshots are the contract bytes.
 * Templater, JavaScript, and naming tokens are not parsed or executed.
 * No note, control, journal, or `.oms` bytes are written.
 */

/** Framework rubric identity. This is not a host reviewer id. */
export const FRAMEWORK_RUBRIC_ID = "oms.framework.semantic.v1";

export type WriteGuidanceRejectionCode =
  | "TARGET_UNVERIFIED"
  | "TARGET_INVALID"
  | "PATH_UNSAFE"
  | "TEMPLATE_ID_EMPTY"
  | "TEMPLATE_UNKNOWN"
  | "CONTRACT_UNVERIFIABLE"
  | "CONTRACT_TRANSACTION_IN_PROGRESS"
  | "RUBRIC_INVALID";

export class WriteGuidanceFailure extends Error {
  readonly code: WriteGuidanceRejectionCode;
  readonly remediation: string;

  constructor(code: WriteGuidanceRejectionCode, message: string, remediation: string) {
    super(message);
    this.name = "WriteGuidanceFailure";
    this.code = code;
    this.remediation = remediation;
  }
}

export interface WriteGuidanceRejection {
  readonly code: WriteGuidanceRejectionCode;
  readonly message: string;
  readonly remediation: string;
  readonly admission?: WriteRejection;
}

export interface WriteGuidanceDiagnostic {
  readonly code: DiagnosticCode | "RUBRIC_MISSING";
  readonly message: string;
  readonly templateId?: string;
  readonly path?: string;
}

export interface WriteGuidanceRequest {
  /** Trusted target. `source: "cwd"` is refused before any vault read. */
  readonly target: WriteTarget;
  /** Explicit vault-relative note. Omitted or null asks for a path and does not invent one. */
  readonly notePath?: string | null;
  /** Omitted or null selects the default contract only. */
  readonly templateId?: string | null;
}

export interface ApprovedWriteInput {
  /** Canonical real vault path, such as `snapshot.vault` after `realpath`. */
  readonly vaultRealPath: string;
  readonly notePath: string;
  readonly snapshot: ResolvedTemplateSnapshot;
  readonly templateId: string | null;
}

interface ApprovedContractDescription {
  readonly templateId: string | null;
  readonly placementHint: string | null;
  readonly headingOrder: HeadingOrder;
  readonly fields: Readonly<Record<string, ResolvedField>>;
  readonly headings: readonly ResolvedHeading[];
  readonly semanticCriteria: readonly CompletionCriterion[];
  readonly approvedMarkdown: {
    readonly defaultLayer: string;
    readonly templateLayer: string | null;
  };
  readonly contractDigest: CompletionDigest;
  readonly rubric: CompletionRubric | null;
  readonly rubricDigest: CompletionDigest | null;
  readonly diagnostics: readonly WriteGuidanceDiagnostic[];
}

export interface WritePreparation extends ApprovedContractDescription {
  readonly vaultFingerprint: string;
  readonly notePath: string;
  readonly binding: TaskBinding;
  readonly taskId: CompletionDigest;
}

export interface WriteGuidanceReport {
  readonly status: "guided" | "needs-path" | "rejected";
  readonly templateId: string | null;
  readonly notePath: string | null;
  readonly placementHint: string | null;
  readonly headingOrder: HeadingOrder | null;
  readonly fields: Readonly<Record<string, ResolvedField>>;
  readonly headings: readonly ResolvedHeading[];
  readonly semanticCriteria: readonly CompletionCriterion[];
  readonly approvedMarkdown: {
    readonly defaultLayer: string;
    readonly templateLayer: string | null;
  } | null;
  readonly contractDigest: CompletionDigest | null;
  readonly rubric: CompletionRubric | null;
  readonly rubricDigest: CompletionDigest | null;
  readonly preparation: WritePreparation | null;
  readonly diagnostics: readonly WriteGuidanceDiagnostic[];
  readonly pathRequest: {
    readonly code: "NOTE_PATH_REQUIRED";
    readonly message: string;
  } | null;
  readonly rejection: WriteGuidanceRejection | null;
}

export type WriteGuidanceStatus = WriteGuidanceReport["status"];

/**
 * Hex identity of the canonical real vault root.
 * The preimage is that real path string, the same preimage as the runtime journal fingerprint.
 * The shared digest helper performs the hash.
 */
export function canonicalVaultFingerprint(vaultRealPath: string): string {
  if (vaultRealPath.length === 0 || vaultRealPath.includes("\0")) {
    throw new WriteGuidanceFailure(
      "TARGET_INVALID",
      "TARGET_INVALID: vault real path must be the canonical non-empty real path",
      "pass the real vault directory",
    );
  }
  return digestBytes(vaultRealPath).slice("sha256:".length);
}

/**
 * Shared read-only preparation for guide, check, and complete.
 * Call `verifyVaultNotePath` before this when the path must be checked for symlinks.
 * This repeats the lexical note rule, selects the approved contract, and builds one rubric and binding.
 */
export function prepareApprovedWrite(input: ApprovedWriteInput): WritePreparation {
  const templateId = normalizeTemplateId(input.templateId);
  const notePath = lexicalNotePath(input.vaultRealPath, input.notePath);
  const described = describeApprovedContract(input.snapshot, templateId);
  const vaultFingerprint = canonicalVaultFingerprint(input.vaultRealPath);
  const binding = createTaskBinding({
    vaultFingerprint,
    templateId: described.templateId,
    notePath,
    contractDigest: described.contractDigest,
    rubricDigest: described.rubricDigest,
  });
  return {
    ...described,
    vaultFingerprint,
    notePath: binding.notePath,
    binding,
    taskId: computeTaskId(binding),
  };
}

export async function getWriteGuidance(request: WriteGuidanceRequest): Promise<WriteGuidanceReport> {
  const targetRejection = await admitWriteTarget(request.target);
  if (targetRejection !== undefined) {
    return rejectedReport({
      code: "TARGET_UNVERIFIED",
      message: targetRejection.message,
      remediation: targetRejection.remediation,
      admission: targetRejection,
    }, null, typeof request.notePath === "string" ? request.notePath : null);
  }

  let templateId: string | null;
  try {
    if (request.templateId !== undefined) {
      templateId = normalizeTemplateId(request.templateId);
    } else if (typeof request.notePath === "string") {
      const declared = await declaredTemplateId(request.target.vault, request.notePath);
      templateId = declared === undefined ? normalizeTemplateId(undefined) : declared;
    } else {
      templateId = normalizeTemplateId(undefined);
    }
  } catch (error: unknown) {
    const rejection = rejectionForGuidance(error);
    if (rejection === null) throw error;
    return rejectedReport(rejection, null, typeof request.notePath === "string" ? request.notePath : null);
  }

  let verified: VerifiedVaultNotePath | null = null;
  if (typeof request.notePath === "string") {
    const pathResult = await verifyVaultNotePath(request.target.vault, request.notePath);
    if (!pathResult.ok) {
      const code = pathResult.rejection.code === "target-invalid" ? "TARGET_INVALID" : "PATH_UNSAFE";
      return rejectedReport({
        code,
        message: pathResult.rejection.message,
        remediation: pathResult.rejection.remediation,
        admission: pathResult.rejection,
      }, templateId, request.notePath);
    }
    verified = pathResult;
  }

  let snapshot: ResolvedTemplateSnapshot;
  try {
    snapshot = await loadResolvedTemplates(verified?.vaultRoot ?? request.target.vault);
  } catch (error: unknown) {
    const rejection = rejectionForLoad(error);
    if (rejection === null) throw error;
    return rejectedReport(rejection, templateId, verified?.notePath ?? null);
  }

  try {
    if (verified === null) return needsPath(describeApprovedContract(snapshot, templateId));
    return guided(prepareApprovedWrite({
      vaultRealPath: snapshot.vault,
      notePath: verified.notePath,
      snapshot,
      templateId,
    }));
  } catch (error: unknown) {
    const rejection = rejectionForGuidance(error);
    if (rejection === null) throw error;
    return rejectedReport(rejection, templateId, verified?.notePath ?? null);
  }
}
/** The template a saved note declares for itself, or null when it declares none. */
export async function declaredTemplateId(vault: string, notePath: string): Promise<string | null | undefined> {
  const verified = await verifyVaultNotePath(vault, notePath);
  if (!verified.ok) return undefined;
  try {
    const parsed = parseNote(await readFile(verified.absolutePath, "utf8"));
    const declared = parsed.frontmatter["template"];
    if (typeof declared === "string" && declared.trim() !== "") return declared;
    return declared === undefined ? null : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTemplateId(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value.length === 0) {
    throw new WriteGuidanceFailure(
      "TEMPLATE_ID_EMPTY",
      "TEMPLATE_ID_EMPTY: templateId is empty; omit it or pass null to use the default contract only",
      "omit templateId or pass null for the default contract",
    );
  }
  return value.normalize("NFC");
}

function lexicalNotePath(vaultRealPath: string, notePath: string): string {
  try {
    safeVaultNotePath(vaultRealPath, notePath);
    return normalizeTemplateSourcePath(notePath);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WriteGuidanceFailure(
      "PATH_UNSAFE",
      message,
      "pass an explicit vault-relative .md note path that stays inside the vault and is not hidden, internal, or reached through a symlink",
    );
  }
}

function describeApprovedContract(snapshot: ResolvedTemplateSnapshot, templateId: string | null): ApprovedContractDescription {
  const contract = contractFor(snapshot, templateId);
  const rubric = approvedRubric(contract.semanticCriteria);
  const diagnostics = [
    ...snapshot.diagnostics.filter(diagnostic => appliesToTemplate(diagnostic, contract.templateId)).map(viewDiagnostic),
    ...(rubric.diagnostic === null ? [] : [stampTemplate(rubric.diagnostic, contract.templateId)]),
  ];
  return {
    templateId: contract.templateId,
    placementHint: placementHintFor(snapshot, contract.templateId),
    headingOrder: contract.headingOrder,
    fields: contract.fields,
    headings: contract.headings,
    semanticCriteria: contract.semanticCriteria,
    approvedMarkdown: {
      defaultLayer: contract.approved.defaultLayer.approvedMarkdown,
      templateLayer: contract.approved.templateLayer?.approvedMarkdown ?? null,
    },
    contractDigest: contract.contractDigest,
    rubric: rubric.rubric,
    rubricDigest: rubric.rubricDigest,
    diagnostics,
  };
}

function contractFor(snapshot: ResolvedTemplateSnapshot, templateId: string | null): ResolvedContract {
  if (templateId === null) return snapshot.defaultContract;
  if (!Object.hasOwn(snapshot.templates, templateId)) {
    throw new WriteGuidanceFailure(
      "TEMPLATE_UNKNOWN",
      `TEMPLATE_UNKNOWN: template ${templateId} is not an approved template`,
      "omit templateId for the default contract, or pass an approved template id",
    );
  }
  const contract = snapshot.templates[templateId];
  if (contract === undefined) {
    throw new WriteGuidanceFailure(
      "TEMPLATE_UNKNOWN",
      `TEMPLATE_UNKNOWN: template ${templateId} is not an approved template`,
      "omit templateId for the default contract, or pass an approved template id",
    );
  }
  return contract;
}

function placementHintFor(snapshot: ResolvedTemplateSnapshot, templateId: string | null): string | null {
  if (templateId === null) return null;
  return snapshot.placement[templateId] ?? null;
}

function approvedRubric(criteria: readonly CompletionCriterion[]): {
  readonly rubric: CompletionRubric | null;
  readonly rubricDigest: CompletionDigest | null;
  readonly diagnostic: WriteGuidanceDiagnostic | null;
} {
  if (criteria.length === 0) {
    return {
      rubric: null,
      rubricDigest: null,
      diagnostic: {
        code: "RUBRIC_MISSING",
        message: "Approved semantic criteria are absent. A missing rubric is not a semantic pass.",
      },
    };
  }
  try {
    const rubric = validateRubric({ rubricId: FRAMEWORK_RUBRIC_ID, criteria });
    return { rubric, rubricDigest: computeRubricDigest(rubric), diagnostic: null };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WriteGuidanceFailure(
      "RUBRIC_INVALID",
      `RUBRIC_INVALID: ${message}`,
      "repair the approved semantic criteria before guide, check, or complete",
    );
  }
}

function appliesToTemplate(diagnostic: Diagnostic, templateId: string | null): boolean {
  if (diagnostic.code === "SOURCE_DRIFT") return templateId !== null && (diagnostic.templateId ?? null) === templateId;
  if (diagnostic.code !== "MANAGED_TEMPLATE_DRIFT") return false;
  return diagnostic.templateId === undefined || diagnostic.templateId === null || diagnostic.templateId === templateId;
}

function viewDiagnostic(diagnostic: Diagnostic): WriteGuidanceDiagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message ?? diagnostic.code,
    ...(diagnostic.templateId === undefined ? {} : { templateId: diagnostic.templateId }),
    ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
  };
}

function stampTemplate(diagnostic: WriteGuidanceDiagnostic, templateId: string | null): WriteGuidanceDiagnostic {
  if (templateId === null || diagnostic.templateId !== undefined) return diagnostic;
  return { ...diagnostic, templateId };
}

function notePathRequest(description: ApprovedContractDescription): { readonly code: "NOTE_PATH_REQUIRED"; readonly message: string } {
  const placement = description.placementHint === null
    ? "No template placement is declared."
    : `Declared placement is ${description.placementHint}.`;
  return {
    code: "NOTE_PATH_REQUIRED",
    message: `NOTE_PATH_REQUIRED: pass an explicit vault-relative .md notePath. ${placement} This guide does not choose a folder, title, date, or filename and does not start an interview.`,
  };
}

function guided(preparation: WritePreparation): WriteGuidanceReport {
  return {
    status: "guided",
    templateId: preparation.templateId,
    notePath: preparation.notePath,
    placementHint: preparation.placementHint,
    headingOrder: preparation.headingOrder,
    fields: preparation.fields,
    headings: preparation.headings,
    semanticCriteria: preparation.semanticCriteria,
    approvedMarkdown: preparation.approvedMarkdown,
    contractDigest: preparation.contractDigest,
    rubric: preparation.rubric,
    rubricDigest: preparation.rubricDigest,
    preparation,
    diagnostics: preparation.diagnostics,
    pathRequest: null,
    rejection: null,
  };
}

function needsPath(description: ApprovedContractDescription): WriteGuidanceReport {
  return {
    status: "needs-path",
    templateId: description.templateId,
    notePath: null,
    placementHint: description.placementHint,
    headingOrder: description.headingOrder,
    fields: description.fields,
    headings: description.headings,
    semanticCriteria: description.semanticCriteria,
    approvedMarkdown: description.approvedMarkdown,
    contractDigest: description.contractDigest,
    rubric: description.rubric,
    rubricDigest: description.rubricDigest,
    preparation: null,
    diagnostics: description.diagnostics,
    pathRequest: notePathRequest(description),
    rejection: null,
  };
}

function rejectedReport(rejection: WriteGuidanceRejection, templateId: string | null, notePath: string | null): WriteGuidanceReport {
  const fields: Readonly<Record<string, ResolvedField>> = {};
  return {
    status: "rejected",
    templateId,
    notePath,
    placementHint: null,
    headingOrder: null,
    fields,
    headings: [],
    semanticCriteria: [],
    approvedMarkdown: null,
    contractDigest: null,
    rubric: null,
    rubricDigest: null,
    preparation: null,
    diagnostics: [],
    pathRequest: null,
    rejection,
  };
}

function rejectionForGuidance(error: unknown): WriteGuidanceRejection | null {
  if (error instanceof WriteGuidanceFailure) {
    return { code: error.code, message: error.message, remediation: error.remediation };
  }
  if (error instanceof CompletionContractError) {
    const code = error.code === "RUBRIC_INVALID" ? "RUBRIC_INVALID" : "PATH_UNSAFE";
    return {
      code,
      message: `${error.code}: ${error.message}`,
      remediation: code === "RUBRIC_INVALID"
        ? "repair the approved semantic criteria before guide, check, or complete"
        : "pass an explicit vault-relative .md note path",
    };
  }
  return null;
}

function rejectionForLoad(error: unknown): WriteGuidanceRejection | null {
  const code = errno(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return {
      code: "TARGET_INVALID",
      message: `TARGET_INVALID: the vault target does not exist or is not a directory (${message})`,
      remediation: "pass an explicit existing vault directory, then retry guide, check, or complete",
    };
  }
  if (message.startsWith("CONTRACT_TRANSACTION_IN_PROGRESS:")) {
    return {
      code: "CONTRACT_TRANSACTION_IN_PROGRESS",
      message,
      remediation: "finish or resume template publication before guide, check, or complete",
    };
  }
  if (isContractLoadFailure(message)) {
    return {
      code: "CONTRACT_UNVERIFIABLE",
      message: message.startsWith("CONTRACT_UNVERIFIABLE:") ? message : `CONTRACT_UNVERIFIABLE: ${message}`,
      remediation: "restore the approved policy, taxonomy, and projection; guide does not replace them with an empty contract",
    };
  }
  return null;
}

function isContractLoadFailure(message: string): boolean {
  return message.startsWith("CONTRACT_UNVERIFIABLE:")
    || message.startsWith("TEMPLATE_POLICY_")
    || message.startsWith("TEMPLATE_SOURCE_")
    || message.startsWith("TEMPLATE_ID_")
    || message.startsWith("PROJECTION_")
    || message.startsWith("TEMPLATE_EXTENSION_")
    || message.startsWith("CONTRACT_COMPOSITION_")
    || message.startsWith("TEMPLATE_FOLDER_");
}

function errno(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
