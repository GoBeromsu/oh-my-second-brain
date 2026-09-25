import { canonicalJson, digestBytes as digestCanonicalBytes, hashCanonical } from "./canonical.js";

/** The completion contract is deliberately independent of host, model, and storage APIs. */
export const COMPLETION_SCHEMA_VERSION = 1 as const;
export type CompletionSchemaVersion = typeof COMPLETION_SCHEMA_VERSION;
export type CompletionDigest = `sha256:${string}`;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TEXT_ENCODER = new TextEncoder();

export type EvidenceKind = "note-span" | "vault-file" | "external";
export type MachineStatus = "pass" | "fail" | "incomplete";

export type CompletionErrorCode =
  | "TASK_BINDING_INVALID"
  | "TASK_BINDING_MISMATCH"
  | "SNAPSHOT_STALE"
  | "RUBRIC_INVALID"
  | "EVIDENCE_INVALID";

export class CompletionContractError extends TypeError {
  readonly code: CompletionErrorCode;

  constructor(code: CompletionErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CompletionContractError";
    this.code = code;
  }
}

export interface LineSpan {
  /** One-based inclusive line numbers. A line slice includes its terminating LF when present. */
  readonly start: number;
  readonly end: number;
}

export interface NoteSpanEvidence {
  readonly kind: "note-span";
  readonly lineSpan: LineSpan;
  readonly sliceDigest: CompletionDigest;
}

export interface VaultFileEvidence {
  readonly kind: "vault-file";
  readonly path: string;
  readonly digest: CompletionDigest;
  readonly lineSpan?: LineSpan;
  readonly sliceDigest?: CompletionDigest;
}

export interface ExternalEvidence {
  readonly kind: "external";
  readonly uri: string;
  readonly summary: string;
}

export type EvidenceRef = NoteSpanEvidence | VaultFileEvidence | ExternalEvidence;

export interface CompletionCriterion {
  readonly criterionId: string;
  readonly statement: string;
  readonly evidenceRequirement: string;
  readonly required?: boolean;
  readonly acceptableEvidenceKinds?: readonly EvidenceKind[];
  readonly requireByteVerification?: boolean;
  readonly sourceRefs: readonly EvidenceRef[];
}

export interface CompletionRubric {
  readonly rubricId: string;
  readonly criteria: readonly CompletionCriterion[];
}

export interface TaskBinding {
  readonly schemaVersion: CompletionSchemaVersion;
  /** Caller-provided identity of the canonical real vault root; this is not authentication. */
  readonly vaultFingerprint: string;
  readonly templateId: string | null;
  /** Vault-relative note path. */
  readonly notePath: string;
  readonly contractDigest: CompletionDigest;
  readonly rubricDigest: CompletionDigest | null;
}

export interface TaskBindingInput {
  readonly schemaVersion?: CompletionSchemaVersion;
  readonly vaultFingerprint: string;
  readonly templateId: string | null;
  readonly notePath: string;
  readonly contractDigest: CompletionDigest;
  readonly rubricDigest: CompletionDigest | null;
}

export interface ReadSnapshot {
  /** Vault-relative path for notes and vault evidence; caller performs realpath/symlink checks before supplying it. */
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly digest: CompletionDigest;
}

export interface MachineFinding {
  readonly ruleId: string;
  readonly targetId: string;
  readonly message: string;
  readonly severity?: "error" | "warning";
}

export interface MachineEvaluation {
  readonly status: MachineStatus;
  readonly taskId: CompletionDigest;
  readonly noteDigest: CompletionDigest;
  readonly contractDigest: CompletionDigest;
  readonly findings: readonly MachineFinding[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], code: CompletionErrorCode, label: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown !== undefined) throw new CompletionContractError(code, `${label} contains unsupported member ${unknown}`);
}

function assertString(value: unknown, label: string, code: CompletionErrorCode = "TASK_BINDING_INVALID"): string {
  if (typeof value !== "string" || value.length === 0) throw new CompletionContractError(code, `${label} must be a non-empty string`);
  return value.normalize("NFC");
}

function assertDigest(value: unknown, label: string, code: CompletionErrorCode = "TASK_BINDING_INVALID"): CompletionDigest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new CompletionContractError(code, `${label} must be lowercase sha256:<64hex>`);
  }
  return value as CompletionDigest;
}

function assertSchemaVersion(value: unknown): CompletionSchemaVersion {
  if (value !== COMPLETION_SCHEMA_VERSION) throw new CompletionContractError("TASK_BINDING_INVALID", "unsupported completion schema version");
  return COMPLETION_SCHEMA_VERSION;
}

function normalizedRelativePath(value: unknown, label: string, code: CompletionErrorCode = "TASK_BINDING_INVALID"): string {
  const pathname = assertString(value, label, code).replaceAll("\\", "/");
  if (pathname.includes("\0") || pathname.startsWith("/") || /^[A-Za-z]:\//.test(pathname)) {
    throw new CompletionContractError(code, `${label} must be vault-relative`);
  }
  const parts = pathname.split("/");
  if (parts.some(part => part === "..")) throw new CompletionContractError(code, `${label} must not traverse the vault`);
  const normalized = parts.filter(part => part !== "." && part.length > 0).join("/");
  if (normalized.length === 0) throw new CompletionContractError(code, `${label} must not be empty`);
  return normalized;
}

function normalizedLineSpan(value: unknown): LineSpan {
  if (!isRecord(value)) throw new CompletionContractError("EVIDENCE_INVALID", "lineSpan must be an object");
  const start = value["start"];
  const end = value["end"];
  if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    throw new CompletionContractError("EVIDENCE_INVALID", "lineSpan must use one-based inclusive positive integers");
  }
  return { start, end };
}

function bytesOf(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? TEXT_ENCODER.encode(value) : new Uint8Array(value);
}

function compareText(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0) ?? 0);
  const b = Array.from(right, character => character.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function snapshotDigest(snapshot: ReadSnapshot): CompletionDigest {
  return digestCanonicalBytes(snapshot.bytes) as CompletionDigest;
}

function normalizedEvidence(value: unknown): EvidenceRef {
  if (!isRecord(value) || typeof value["kind"] !== "string") throw new CompletionContractError("EVIDENCE_INVALID", "evidence kind is required");
  const kind = value["kind"];
  if (kind === "note-span") {
    return {
      kind,
      lineSpan: normalizedLineSpan(value["lineSpan"]),
      sliceDigest: assertDigest(value["sliceDigest"], "note-span.sliceDigest", "EVIDENCE_INVALID"),
    };
  }
  if (kind === "vault-file") {
    const lineSpan = value["lineSpan"] === undefined ? undefined : normalizedLineSpan(value["lineSpan"]);
    const sliceDigest = value["sliceDigest"] === undefined ? undefined : assertDigest(value["sliceDigest"], "vault-file.sliceDigest", "EVIDENCE_INVALID");
    if (lineSpan === undefined && sliceDigest !== undefined) throw new CompletionContractError("EVIDENCE_INVALID", "vault-file.sliceDigest requires lineSpan");
    return {
      kind,
      path: normalizedRelativePath(value["path"], "vault-file.path", "EVIDENCE_INVALID"),
      digest: assertDigest(value["digest"], "vault-file.digest", "EVIDENCE_INVALID"),
      ...(lineSpan === undefined ? {} : { lineSpan }),
      ...(sliceDigest === undefined ? {} : { sliceDigest }),
    };
  }
  if (kind === "external") {
    return {
      kind,
      uri: assertString(value["uri"], "external.uri", "EVIDENCE_INVALID"),
      summary: assertString(value["summary"], "external.summary", "EVIDENCE_INVALID"),
    };
  }
  throw new CompletionContractError("EVIDENCE_INVALID", `unknown evidence kind: ${String(kind)}`);
}

function evidenceKey(value: EvidenceRef): string {
  return canonicalJson(value);
}

function normalizeManifest(values: readonly EvidenceRef[]): EvidenceRef[] {
  const unique = new Map<string, EvidenceRef>();
  for (const value of values) {
    const normalized = normalizedEvidence(value);
    unique.set(evidenceKey(normalized), normalized);
  }
  return [...unique.values()].sort((left, right) => compareText(evidenceKey(left), evidenceKey(right)));
}

function normalizedCriterion(value: unknown): CompletionCriterion {
  if (!isRecord(value)) throw new CompletionContractError("RUBRIC_INVALID", "criterion must be an object");
  const criterionId = assertString(value["criterionId"], "criterion.criterionId", "RUBRIC_INVALID");
  const statement = assertString(value["statement"], `criterion ${criterionId}.statement`, "RUBRIC_INVALID");
  const evidenceRequirement = assertString(value["evidenceRequirement"], `criterion ${criterionId}.evidenceRequirement`, "RUBRIC_INVALID");
  const required = value["required"] === undefined ? true : value["required"];
  if (typeof required !== "boolean") throw new CompletionContractError("RUBRIC_INVALID", `criterion ${criterionId}.required must be boolean`);
  const acceptableRaw = value["acceptableEvidenceKinds"];
  let acceptableEvidenceKinds: EvidenceKind[] | undefined;
  if (acceptableRaw !== undefined) {
    if (!Array.isArray(acceptableRaw) || acceptableRaw.length === 0) throw new CompletionContractError("RUBRIC_INVALID", `criterion ${criterionId}.acceptableEvidenceKinds must be non-empty`);
    const acceptableValues: unknown[] = acceptableRaw;
    acceptableEvidenceKinds = [...new Set(acceptableValues)].map(kind => {
      if (kind !== "note-span" && kind !== "vault-file" && kind !== "external") throw new CompletionContractError("RUBRIC_INVALID", `criterion ${criterionId} has unknown evidence kind`);
      return kind;
    });
    acceptableEvidenceKinds.sort(compareText);
  }
  const requireByteVerification = value["requireByteVerification"] === undefined ? false : value["requireByteVerification"];
  if (typeof requireByteVerification !== "boolean") throw new CompletionContractError("RUBRIC_INVALID", `criterion ${criterionId}.requireByteVerification must be boolean`);
  const sourceRefsRaw = value["sourceRefs"];
  if (!Array.isArray(sourceRefsRaw)) throw new CompletionContractError("RUBRIC_INVALID", `criterion ${criterionId}.sourceRefs must be an array`);
  const sourceRefs = normalizeManifest(sourceRefsRaw);
  return {
    criterionId,
    statement,
    evidenceRequirement,
    ...(required ? {} : { required: false }),
    ...(acceptableEvidenceKinds === undefined ? {} : { acceptableEvidenceKinds }),
    ...(requireByteVerification ? { requireByteVerification: true } : {}),
    sourceRefs,
  };
}

function normalizedRubric(value: unknown): CompletionRubric {
  if (!isRecord(value)) throw new CompletionContractError("RUBRIC_INVALID", "rubric must be an object");
  const rubricId = assertString(value["rubricId"], "rubric.rubricId", "RUBRIC_INVALID");
  const criteriaRaw = value["criteria"];
  if (!Array.isArray(criteriaRaw) || criteriaRaw.length === 0) throw new CompletionContractError("RUBRIC_INVALID", "rubric.criteria must be non-empty");
  const criteria = criteriaRaw.map(normalizedCriterion).sort((left, right) => compareText(left.criterionId, right.criterionId));
  const ids = new Set<string>();
  for (const criterion of criteria) {
    if (ids.has(criterion.criterionId)) throw new CompletionContractError("RUBRIC_INVALID", `duplicate criterion: ${criterion.criterionId}`);
    ids.add(criterion.criterionId);
  }
  return { rubricId, criteria };
}

export function validateRubric(value: unknown): CompletionRubric {
  return normalizedRubric(value);
}

function rubricDigest(rubric: CompletionRubric): CompletionDigest {
  return hashCanonical("oms.completion.rubric.v1", { rubric: rubric }) as CompletionDigest;
}

function normalizedTaskBinding(value: unknown): TaskBinding {
  if (!isRecord(value)) throw new CompletionContractError("TASK_BINDING_INVALID", "task binding must be an object");
  assertKnownKeys(value, ["schemaVersion", "vaultFingerprint", "templateId", "notePath", "contractDigest", "rubricDigest"], "TASK_BINDING_INVALID", "task binding");
  return {
    schemaVersion: assertSchemaVersion(value["schemaVersion"]),
    vaultFingerprint: assertString(value["vaultFingerprint"], "vaultFingerprint"),
    templateId: value["templateId"] === null ? null : assertString(value["templateId"], "templateId"),
    notePath: normalizedRelativePath(value["notePath"], "notePath"),
    contractDigest: assertDigest(value["contractDigest"], "contractDigest"),
    rubricDigest: value["rubricDigest"] === null ? null : assertDigest(value["rubricDigest"], "rubricDigest"),
  };
}

/** Normalizes and validates a binding without consulting a vault, secret, or host. */
export function createTaskBinding(input: TaskBindingInput): TaskBinding {
  return normalizedTaskBinding({ ...input, schemaVersion: input.schemaVersion ?? COMPLETION_SCHEMA_VERSION });
}

export function validateTaskBinding(value: unknown): TaskBinding {
  return normalizedTaskBinding(value);
}

/** The digest binds content and location; it is not a signature or authentication token. */
export function computeTaskId(binding: TaskBinding): CompletionDigest {
  const normalized = validateTaskBinding(binding);
  return hashCanonical("oms.completion.task-binding.v1", normalized) as CompletionDigest;
}

export function computeFindingId(ruleId: string, targetId: string): CompletionDigest {
  const normalizedRuleId = assertString(ruleId, "ruleId");
  const normalizedTargetId = assertString(targetId, "targetId");
  return hashCanonical("oms.completion.finding.v1", { ruleId: normalizedRuleId, targetId: normalizedTargetId }) as CompletionDigest;
}

export function createReadSnapshot(pathname: string, content: string | Uint8Array): ReadSnapshot {
  const bytes = bytesOf(content);
  return { path: normalizedRelativePath(pathname, "snapshot.path"), bytes, digest: digestCanonicalBytes(bytes) as CompletionDigest };
}

export function validateReadSnapshot(value: unknown): ReadSnapshot {
  if (!isRecord(value)) throw new CompletionContractError("SNAPSHOT_STALE", "read snapshot must contain path and Uint8Array bytes");
  const bytes = value["bytes"];
  if (typeof value["path"] !== "string" || !(bytes instanceof Uint8Array)) {
    throw new CompletionContractError("SNAPSHOT_STALE", "read snapshot must contain path and Uint8Array bytes");
  }
  const snapshot: ReadSnapshot = {
    path: normalizedRelativePath(value["path"], "snapshot.path", "SNAPSHOT_STALE"),
    bytes: new Uint8Array(bytes),
    digest: assertDigest(value["digest"], "snapshot.digest", "SNAPSHOT_STALE"),
  };
  if (snapshotDigest(snapshot) !== snapshot.digest) throw new CompletionContractError("SNAPSHOT_STALE", `snapshot digest does not match ${snapshot.path}`);
  return snapshot;
}

export function computeRubricDigest(rubric: CompletionRubric | null): CompletionDigest | null {
  return rubric === null ? null : rubricDigest(normalizedRubric(rubric));
}

