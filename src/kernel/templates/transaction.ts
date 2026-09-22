import { mkdir, lstat, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { approvalDigest, canonicalJson, digestBytes, hashCanonical, outputDigest, parseDigest } from "./canonical.js";
import { acquireTransactionLock, atomicWrite, releaseTransactionLock } from "./file-lock.js";
import { normalizeManagedTemplatePath, normalizeTemplateControlPath, validateTemplateId, verifyManagedTemplatePath, verifyTemplateControlPath } from "./paths.js";
import { readBundledPackageVersion } from "../runtime/assets.js";
import { appendRuntimeEvent, createRuntimeEvent, createRuntimeInvocation } from "../runtime/event-journal.js";
import type {
  ControlPath,
  Diagnostic,
  DiagnosticCode,
  Digest,
  FileExpectation,
  GuardedTemplateRequest,
  LogicalOperation,
  ManagedTemplatePath,
  PlannedPhysicalOutput,
  TemplateCompositionManifest,
  TemplateId,
  TemplateTransactionMarker,
  TemplateTransactionMarkerPath,
  TemplateTransactionReceipt,
  TransactionPath,
  TransactionVerifiedPath,
  VerifiedFileState,
} from "./types.js";

/**
 * Sole publication marker. On disk, canonical JSON plus a newline, with required
 * status, transactionId, approvalDigest, outputDigest, planDigest, and checksum.
 * checksum is hashCanonical("oms.contract-publish.marker.v1", every field except checksum).
 * transactionId is the first 32 hex digits of digestBytes(`${approvalDigest}\0${outputDigest}`).
 * The durable plan is `.oms/.template-transactions/<transactionId>/plan.json`.
 */
export const TEMPLATE_TRANSACTION_MARKER_PATH: TemplateTransactionMarkerPath = ".oms/template-transaction.json";

const CONTROL_SPECS = [
  { kind: "policy", path: ".oms/template-policy.json" },
  { kind: "taxonomy", path: ".oms/taxonomy.json" },
  { kind: "projection", path: ".oms/types.json" },
] as const;

const DIAGNOSTIC_CODES = new Set<DiagnosticCode>([
  "TEMPLATE_ID_DUPLICATE",
  "TEMPLATE_SOURCE_DUPLICATE",
  "TEMPLATE_SOURCE_UNSAFE",
  "TEMPLATE_SOURCE_INVALID",
  "TEMPLATE_POLICY_INVALID",
  "TEMPLATE_POLICY_VERSION_UNSUPPORTED",
  "TEMPLATE_POLICY_DANGLING_FIELD",
  "TEMPLATE_EXTENSION_RESERVED",
  "TEMPLATE_EXTENSION_CONFLICT",
  "CONTRACT_COMPOSITION_CONFLICT",
  "CONTRACT_UNVERIFIABLE",
  "SOURCE_DRIFT",
  "MANAGED_TEMPLATE_DRIFT",
  "CONTRACT_TRANSACTION_IN_PROGRESS",
  "PROJECTION_INVALID",
  "PROJECTION_PAYLOAD_TAMPERED",
  "OBSIDIAN_TYPE_CONFLICT",
  "RUBRIC_INVALID",
  "TEMPLATE_TRANSACTION_INCONSISTENT",
  "TEMPLATE_TRANSACTION_MANIFEST_INVALID",
]);

interface Transition {
  readonly path: TransactionPath;
  readonly templateId: TemplateId | null;
  readonly expectedCurrent: FileExpectation;
  readonly proposed: VerifiedFileState;
  readonly action: "write" | "verify-only";
}

interface PlanBoundary {
  readonly path: TransactionPath;
  readonly templateId: TemplateId | null;
  readonly expected: FileExpectation;
  readonly proposed: FileExpectation;
}

interface DurablePlan {
  readonly version: 1;
  readonly transactionId: string;
  readonly approvalDigest: Digest;
  readonly outputDigest: Digest;
  readonly planDigest: Digest;
  readonly boundaries: readonly PlanBoundary[];
  readonly outputs: readonly PlannedPhysicalOutput[];
}

interface StoredMarker {
  readonly status: "in-progress" | "complete";
  readonly transactionId: string;
  readonly approvalDigest: Digest;
  readonly outputDigest: Digest;
  readonly planDigest: Digest;
}

type MarkerRead =
  | { readonly state: "absent"; readonly root: string }
  | { readonly state: "invalid"; readonly root: string }
  | { readonly state: "in-progress"; readonly root: string; readonly marker: StoredMarker; readonly plan: DurablePlan }
  | { readonly state: "complete"; readonly root: string; readonly marker: StoredMarker; readonly plan: DurablePlan };

export interface TemplateTransactionMarkerInspection {
  readonly admission: "clear" | "blocked";
  readonly state: "absent" | "in-progress" | "complete" | "invalid";
  readonly marker: TemplateTransactionMarker | null;
}

class PublicationHalt extends Error {
  constructor(readonly item: Diagnostic) {
    super(item.message ?? item.code);
    this.name = "PublicationHalt";
  }
}

function diagnostic(code: DiagnosticCode, message: string, path?: string): Diagnostic {
  return path === undefined ? { code, message } : { code, message, path };
}

function problem(
  status: "rejected" | "resume-required" | "inconsistent",
  approval: Digest | null,
  output: Digest | null,
  item: Diagnostic,
): TemplateTransactionReceipt {
  return { status, approvalDigest: approval, outputDigest: output, diagnostics: [item] };
}

function rejected(approval: Digest | null, output: Digest | null, item: Diagnostic): TemplateTransactionReceipt {
  return problem("rejected", approval, output, item);
}

function resumeRequired(approval: Digest, output: Digest, message: string): TemplateTransactionReceipt {
  return problem("resume-required", approval, output, diagnostic("CONTRACT_TRANSACTION_IN_PROGRESS", message));
}

function inconsistent(approval: Digest | null, output: Digest | null, item: Diagnostic): TemplateTransactionReceipt {
  return problem("inconsistent", approval, output, item);
}

function manifestRejected(manifest: TemplateCompositionManifest, item: Diagnostic): TemplateTransactionReceipt {
  return rejected(digestOrNull(manifest.approvalDigest), digestOrNull(manifest.outputDigest), item);
}

function pathDiagnostic(error: unknown): Diagnostic {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("TEMPLATE_SOURCE_UNSAFE")) return diagnostic("TEMPLATE_SOURCE_UNSAFE", message);
  if (message.startsWith("TEMPLATE_SOURCE_INVALID")) return diagnostic("TEMPLATE_SOURCE_INVALID", message);
  return diagnostic("TEMPLATE_TRANSACTION_INCONSISTENT", message);
}

function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function digestOrNull(value: unknown): Digest | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = parseDigest(value);
    return parsed === value ? parsed : null;
  } catch {
    return null;
  }
}

function isControlPath(path: string): path is ControlPath {
  return path === ".oms/template-policy.json" || path === ".oms/taxonomy.json" || path === ".oms/types.json";
}

function canonicalManaged(path: string): ManagedTemplatePath | null {
  try {
    const managed = normalizeManagedTemplatePath(path);
    return managed === path ? managed : null;
  } catch {
    return null;
  }
}

function canonicalTransactionPath(path: string): TransactionPath | null {
  if (isControlPath(path)) return path;
  return canonicalManaged(path);
}

function expectationOf(value: FileExpectation | VerifiedFileState): FileExpectation {
  return value.state === "absent" ? { state: "absent" } : { state: "present", signature: value.signature };
}

function sameFile(actual: VerifiedFileState, expected: FileExpectation | VerifiedFileState): boolean {
  const left = expectationOf(actual);
  const right = expectationOf(expected);
  return left.state === "absent" || right.state === "absent" ? left.state === right.state : left.signature === right.signature;
}

function publicationId(approval: Digest, output: Digest): string {
  return digestBytes(`${approval}\0${output}`).slice("sha256:".length, "sha256:".length + 32);
}

function rank(path: string): number {
  if (path === ".oms/template-policy.json") return 0;
  if (path === ".oms/taxonomy.json") return 1;
  if (path === ".oms/types.json") return 2;
  return 3;
}

function byPublication(left: { readonly path: string }, right: { readonly path: string }): number {
  const difference = rank(left.path) - rank(right.path);
  if (difference !== 0) return difference;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function coherentExpectation(value: FileExpectation): boolean {
  return value.state === "absent" ? true : digestOrNull(value.signature) === value.signature;
}

function coherentState(value: VerifiedFileState): boolean {
  if (value.state === "absent") return true;
  if (!(value.bytes instanceof Uint8Array) || digestOrNull(value.signature) !== value.signature) return false;
  return digestBytes(value.bytes) === value.signature;
}

function canonicalTemplateId(value: TemplateId | null): TemplateId | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value === "default") return undefined;
  try {
    const canonical = validateTemplateId(value);
    return canonical === value ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function invalidManifest(message: string, path?: string): Diagnostic {
  return diagnostic("TEMPLATE_TRANSACTION_MANIFEST_INVALID", message, path);
}

function validateManifest(manifest: TemplateCompositionManifest): { readonly ok: true; readonly transitions: readonly Transition[] } | { readonly ok: false; readonly diagnostic: Diagnostic } {
  if (manifest.version !== 1 || manifest.markerPath !== TEMPLATE_TRANSACTION_MARKER_PATH) {
    return { ok: false, diagnostic: invalidManifest("publication manifest must be version 1 with the single template transaction marker") };
  }
  if (!Array.isArray(manifest.controls) || manifest.controls.length !== 3 || !Array.isArray(manifest.drafts) || !Array.isArray(manifest.operations) || !Array.isArray(manifest.diagnostics) || !Array.isArray(manifest.outputs)) {
    return { ok: false, diagnostic: invalidManifest("publication manifest collections are invalid") };
  }
  const transitions: Transition[] = [];
  for (let index = 0; index < CONTROL_SPECS.length; index += 1) {
    const spec = CONTROL_SPECS[index];
    if (spec === undefined) return { ok: false, diagnostic: invalidManifest("controls must be policy, taxonomy, and projection in that order") };
    const control = manifest.controls[index];
    if (control === undefined || control.kind !== spec.kind || control.path !== spec.path || (control.action !== "write" && control.action !== "verify-only")) {
      return { ok: false, diagnostic: invalidManifest("controls must be policy, taxonomy, and projection in that order", spec.path) };
    }
    if (!coherentExpectation(control.expectedCurrent) || !coherentState(control.current) || !coherentState(control.proposed) || control.proposed.state !== "present") {
      return { ok: false, diagnostic: invalidManifest("control preimage or proposed bytes are not internally hashed", spec.path) };
    }
    if (control.action === "verify-only" && !sameFile(control.proposed, control.expectedCurrent)) {
      return { ok: false, diagnostic: invalidManifest("verify-only control proposes different bytes", spec.path) };
    }
    transitions.push({ path: spec.path, templateId: null, expectedCurrent: control.expectedCurrent, proposed: control.proposed, action: control.action });
  }
  const seen = new Set<string>();
  for (const draft of manifest.drafts) {
    const path = canonicalManaged(draft.path);
    if (path === null) return { ok: false, diagnostic: diagnostic("TEMPLATE_SOURCE_UNSAFE", "draft output is not .oms/templates/<id>.md", draft.path) };
    if (seen.has(path) || (draft.action !== "write" && draft.action !== "verify-only")) {
      return { ok: false, diagnostic: invalidManifest("managed drafts must be unique write or verify-only paths", path) };
    }
    const templateId = canonicalTemplateId(draft.templateId);
    if (templateId === undefined) return { ok: false, diagnostic: invalidManifest("draft templateId is not canonical", path) };
    if (path !== `.oms/templates/${templateId ?? "default"}.md`) {
      return { ok: false, diagnostic: invalidManifest("draft path does not match its template identity", path) };
    }
    if (!coherentExpectation(draft.expectedCurrent) || !coherentState(draft.current) || !coherentState(draft.proposed)) {
      return { ok: false, diagnostic: invalidManifest("draft preimage or proposed bytes are not internally hashed", path) };
    }
    if (draft.action === "verify-only" && !sameFile(draft.proposed, draft.expectedCurrent)) {
      return { ok: false, diagnostic: invalidManifest("verify-only draft proposes different bytes", path) };
    }
    seen.add(path);
    transitions.push({ path, templateId, expectedCurrent: draft.expectedCurrent, proposed: draft.proposed, action: draft.action });
  }
  const expectedOutputs = new Map<string, Digest>();
  for (const transition of transitions) {
    if (transition.action === "write" && transition.proposed.state === "present") expectedOutputs.set(transition.path, transition.proposed.signature);
  }
  const seenOutputs = new Set<string>();
  for (const output of manifest.outputs) {
    const path = canonicalTransactionPath(output.finalVaultRelativePath);
    if (path === null) return { ok: false, diagnostic: diagnostic("TEMPLATE_SOURCE_UNSAFE", "output is not a policy, taxonomy, projection, or managed draft path", output.finalVaultRelativePath) };
    const payload = digestOrNull(output.payloadDigest);
    if (payload === null || seenOutputs.has(path) || expectedOutputs.get(path) !== payload) {
      return { ok: false, diagnostic: invalidManifest("outputs are not the unique set of present write actions", path) };
    }
    seenOutputs.add(path);
    expectedOutputs.delete(path);
  }
  if (expectedOutputs.size !== 0) return { ok: false, diagnostic: invalidManifest("a present write action is missing from outputs") };
  for (const operation of manifest.operations) {
    if (!validOperation(operation)) return { ok: false, diagnostic: invalidManifest("operation is not a commit-contract publication") };
  }
  for (const item of manifest.diagnostics) {
    if (!DIAGNOSTIC_CODES.has(item.code) || (item.message !== undefined && typeof item.message !== "string") || (item.path !== undefined && typeof item.path !== "string")) {
      return { ok: false, diagnostic: invalidManifest("diagnostic is not a known publication diagnostic") };
    }
  }
  try {
    const outputsDigest = outputDigest(manifest.outputs);
    const approved = approvalDigest(manifest);
    if (outputsDigest !== manifest.outputDigest || approved !== manifest.approvalDigest) {
      return { ok: false, diagnostic: invalidManifest("approvalDigest or outputDigest does not match the proposed bytes") };
    }
  } catch (error: unknown) {
    return { ok: false, diagnostic: pathDiagnostic(error) };
  }
  return { ok: true, transitions };
}

function validOperation(operation: LogicalOperation): boolean {
  if (operation.kind !== "commit-contract" || digestOrNull(operation.payloadDigest) !== operation.payloadDigest) return false;
  return canonicalTemplateId(operation.templateId) === operation.templateId;
}

function requestAccepted(request: GuardedTemplateRequest, approved: Digest): boolean {
  if (typeof request !== "object" || request === null) return false;
  if (request.dryRun === true) return !("approvedDigest" in request) || request.approvedDigest === undefined;
  return request.approvedDigest === approved;
}

function boundaryOf(transition: Transition): PlanBoundary {
  return { path: transition.path, templateId: transition.templateId, expected: transition.expectedCurrent, proposed: expectationOf(transition.proposed) };
}

function planMaterial(plan: Omit<DurablePlan, "planDigest">): object {
  return {
    version: plan.version,
    transactionId: plan.transactionId,
    approvalDigest: plan.approvalDigest,
    outputDigest: plan.outputDigest,
    boundaries: plan.boundaries.map(boundary => ({
      path: boundary.path,
      templateId: boundary.templateId,
      expected: boundary.expected,
      proposed: boundary.proposed,
    })),
    outputs: plan.outputs.map(output => ({ finalVaultRelativePath: output.finalVaultRelativePath, payloadDigest: output.payloadDigest })),
  };
}

function digestPlan(plan: Omit<DurablePlan, "planDigest">): Digest {
  return hashCanonical("oms.contract-publish.plan.v1", planMaterial(plan));
}

function createPlan(manifest: TemplateCompositionManifest, writes: readonly Transition[]): DurablePlan {
  const boundaries = writes.map(boundaryOf);
  const material = {
    version: 1 as const,
    transactionId: publicationId(manifest.approvalDigest, manifest.outputDigest),
    approvalDigest: manifest.approvalDigest,
    outputDigest: manifest.outputDigest,
    boundaries,
    outputs: manifest.outputs,
  };
  return { ...material, planDigest: digestPlan(material) };
}

function markerMaterial(marker: StoredMarker): object {
  return {
    status: marker.status,
    transactionId: marker.transactionId,
    approvalDigest: marker.approvalDigest,
    outputDigest: marker.outputDigest,
    planDigest: marker.planDigest,
  };
}

function publicMarker(marker: StoredMarker): TemplateTransactionMarker {
  return { status: marker.status, transactionId: marker.transactionId, approvalDigest: marker.approvalDigest, outputDigest: marker.outputDigest };
}

function verifiedFrom(path: TransactionPath, state: VerifiedFileState): TransactionVerifiedPath {
  return state.state === "absent" ? { path, state: "absent" } : { path, state: "present", payloadDigest: state.signature };
}

function transactionRelative(id: string, suffix = ""): string {
  const root = `.oms/.template-transactions/${id}`;
  return suffix.length === 0 ? root : `${root}/${suffix}`;
}

async function openControl(root: string, relativePath: string, options: { readonly expected: "existing-file" | "absent" | "either" }): Promise<{ readonly vaultRoot: string; readonly absolutePath: string; readonly targetRealPath: string | null }> {
  return verifyTemplateControlPath(root, normalizeTemplateControlPath(relativePath), options);
}

async function verifyFinal(root: string, relativePath: string): Promise<string> {
  if (isControlPath(relativePath)) return (await openControl(root, relativePath, { expected: "either" })).absolutePath;
  const managed = canonicalManaged(relativePath);
  if (managed === null) throw new TypeError("TEMPLATE_SOURCE_UNSAFE: publication path is not an approved output");
  return (await verifyManagedTemplatePath(root, managed, { expected: "either" })).absolutePath;
}

async function confinePublication(root: string, id: string, targets: readonly { readonly path: string; readonly stage: boolean }[]): Promise<void> {
  await openControl(root, transactionRelative(id), { expected: "either" });
  await openControl(root, transactionRelative(id, "plan.json"), { expected: "either" });
  for (const target of targets) {
    await verifyFinal(root, target.path);
    if (target.stage) await openControl(root, transactionRelative(id, `staging/${target.path}`), { expected: "either" });
  }
}

function confinementTargets(transitions: readonly Transition[]): { readonly path: string; readonly stage: boolean }[] {
  return transitions.map(transition => ({ path: transition.path, stage: transition.action === "write" && transition.proposed.state === "present" }));
}

async function readState(absolute: string): Promise<VerifiedFileState> {
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new TypeError("TEMPLATE_SOURCE_UNSAFE: symlink is not allowed");
    if (!stat.isFile()) throw new TypeError("TEMPLATE_SOURCE_INVALID: publication target must be a regular file");
    const bytes = new Uint8Array(await readFile(absolute));
    return { state: "present", bytes, signature: digestBytes(bytes) };
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return { state: "absent" };
    throw error;
  }
}

async function assertReplaceable(absolute: string): Promise<void> {
  const state = await readState(absolute);
  if (state.state === "absent") return;
}

function parseExpectation(value: unknown): FileExpectation | null {
  const record = asRecord(value);
  if (record === null) return null;
  if (record["state"] === "absent") return { state: "absent" };
  if (record["state"] !== "present" || typeof record["signature"] !== "string") return null;
  const signature = digestOrNull(record["signature"]);
  return signature === null ? null : { state: "present", signature };
}

function parseBoundary(value: unknown): PlanBoundary | null {
  const record = asRecord(value);
  if (record === null || typeof record["path"] !== "string") return null;
  const path = canonicalTransactionPath(record["path"]);
  const expected = parseExpectation(record["expected"]);
  const proposed = parseExpectation(record["proposed"]);
  if (path === null || path !== record["path"] || expected === null || proposed === null) return null;
  if (isControlPath(path) && proposed.state !== "present") return null;
  const templateId = record["templateId"] === null ? null : canonicalTemplateId(record["templateId"] as TemplateId);
  if (templateId === undefined) return null;
  if (isControlPath(path) ? templateId !== null : path !== `.oms/templates/${templateId ?? "default"}.md`) return null;
  return { path, templateId, expected, proposed };
}

function outputsMatch(boundaries: readonly PlanBoundary[], outputs: readonly PlannedPhysicalOutput[]): boolean {
  const present = new Map<string, Digest>();
  for (const boundary of boundaries) {
    if (boundary.proposed.state === "present") present.set(boundary.path, boundary.proposed.signature);
  }
  if (present.size !== outputs.length) return false;
  const seen = new Set<string>();
  for (const output of outputs) {
    if (seen.has(output.finalVaultRelativePath) || present.get(output.finalVaultRelativePath) !== output.payloadDigest) return false;
    seen.add(output.finalVaultRelativePath);
  }
  return true;
}

async function loadPlan(root: string, marker: StoredMarker): Promise<DurablePlan | null> {
  if (!/^[0-9a-f]{32}$/.test(marker.transactionId)) return null;
  try {
    const located = await openControl(root, transactionRelative(marker.transactionId, "plan.json"), { expected: "existing-file" });
    const parsed = asRecord(JSON.parse(await readFile(located.absolutePath, "utf8")));
    if (parsed === null) return null;
    const rawBoundaries = parsed["boundaries"];
    const rawOutputs = parsed["outputs"];
    if (parsed["version"] !== 1 || !Array.isArray(rawBoundaries) || !Array.isArray(rawOutputs)) return null;
    if (parsed["transactionId"] !== marker.transactionId || parsed["approvalDigest"] !== marker.approvalDigest || parsed["outputDigest"] !== marker.outputDigest || parsed["planDigest"] !== marker.planDigest) return null;
    const boundaries = rawBoundaries.map(parseBoundary);
    if (boundaries.some(boundary => boundary === null)) return null;
    const strictBoundaries: PlanBoundary[] = [];
    for (const boundary of boundaries) {
      if (boundary === null) return null;
      strictBoundaries.push(boundary);
    }
    const outputs: PlannedPhysicalOutput[] = [];
    for (const output of rawOutputs) {
      const record = asRecord(output);
      if (record === null || typeof record["finalVaultRelativePath"] !== "string") return null;
      const path = canonicalTransactionPath(record["finalVaultRelativePath"]);
      const payload = typeof record["payloadDigest"] === "string" ? digestOrNull(record["payloadDigest"]) : null;
      if (path === null || path !== record["finalVaultRelativePath"] || payload === null) return null;
      outputs.push({ finalVaultRelativePath: path, payloadDigest: payload });
    }
    const material = { version: 1 as const, transactionId: marker.transactionId, approvalDigest: marker.approvalDigest, outputDigest: marker.outputDigest, boundaries: strictBoundaries, outputs };
    if (digestPlan(material) !== marker.planDigest || !outputsMatch(strictBoundaries, outputs)) return null;
    const recomputed = outputDigest(outputs);
    if (recomputed !== marker.outputDigest) return null;
    return { ...material, planDigest: marker.planDigest };
  } catch {
    return null;
  }
}

async function readMarker(vault: string): Promise<MarkerRead> {
  const located = await openControl(vault, TEMPLATE_TRANSACTION_MARKER_PATH, { expected: "either" });
  if (located.targetRealPath === null) return { state: "absent", root: located.vaultRoot };
  try {
    const parsed = asRecord(JSON.parse(await readFile(located.absolutePath, "utf8")));
    if (parsed === null) return { state: "invalid", root: located.vaultRoot };
    const status = parsed["status"];
    if (status !== "in-progress" && status !== "complete") return { state: "invalid", root: located.vaultRoot };
    const approval = typeof parsed["approvalDigest"] === "string" ? digestOrNull(parsed["approvalDigest"]) : null;
    const output = typeof parsed["outputDigest"] === "string" ? digestOrNull(parsed["outputDigest"]) : null;
    const planDigest = typeof parsed["planDigest"] === "string" ? digestOrNull(parsed["planDigest"]) : null;
    const checksum = typeof parsed["checksum"] === "string" ? digestOrNull(parsed["checksum"]) : null;
    const transactionId = parsed["transactionId"];
    if (approval === null || output === null || planDigest === null || checksum === null || typeof transactionId !== "string" || transactionId !== publicationId(approval, output)) {
      return { state: "invalid", root: located.vaultRoot };
    }
    const marker: StoredMarker = { status, transactionId, approvalDigest: approval, outputDigest: output, planDigest };
    if (hashCanonical("oms.contract-publish.marker.v1", markerMaterial(marker)) !== checksum) return { state: "invalid", root: located.vaultRoot };
    // Marker checksum and durable plan only. Do not stat published controls or managed drafts.
    const plan = await loadPlan(located.vaultRoot, marker);
    if (plan === null) return { state: "invalid", root: located.vaultRoot };
    return status === "in-progress"
      ? { state: "in-progress", root: located.vaultRoot, marker, plan }
      : { state: "complete", root: located.vaultRoot, marker, plan };
  } catch (error: unknown) {
    if (errorCode(error) !== null && errorCode(error) !== "ENOENT") throw error;
    return { state: "invalid", root: located.vaultRoot };
  }
}

/** Receipt-only. Read admission must not call this; a drifted managed draft stays admissible. */
async function revalidateProposed(root: string, boundaries: readonly PlanBoundary[], expectedOutput: Digest): Promise<readonly TransactionVerifiedPath[] | null> {
  const verified: TransactionVerifiedPath[] = [];
  const outputs: PlannedPhysicalOutput[] = [];
  for (const boundary of [...boundaries].sort(byPublication)) {
    const actual = await readState(await verifyFinal(root, boundary.path));
    if (!sameFile(actual, boundary.proposed)) return null;
    verified.push(verifiedFrom(boundary.path, actual));
    if (boundary.proposed.state === "present") {
      if (actual.state !== "present") return null;
      outputs.push({ finalVaultRelativePath: boundary.path, payloadDigest: actual.signature });
    }
  }
  return outputDigest(outputs) === expectedOutput ? verified : null;
}

async function writeJson(root: string, relativePath: string, value: unknown): Promise<void> {
  const located = await openControl(root, relativePath, { expected: "either" });
  await assertReplaceable(located.absolutePath);
  await atomicWrite(located.absolutePath, `${canonicalJson(value)}\n`);
}

async function writeMarkerFile(root: string, status: StoredMarker["status"], plan: DurablePlan): Promise<void> {
  const marker: StoredMarker = { status, transactionId: plan.transactionId, approvalDigest: plan.approvalDigest, outputDigest: plan.outputDigest, planDigest: plan.planDigest };
  const checksum = hashCanonical("oms.contract-publish.marker.v1", markerMaterial(marker));
  await writeJson(root, TEMPLATE_TRANSACTION_MARKER_PATH, { ...markerMaterial(marker), checksum });
}

async function stageWrites(root: string, id: string, writes: readonly Transition[]): Promise<void> {
  for (const transition of writes) {
    if (transition.proposed.state !== "present") continue;
    const relativePath = transactionRelative(id, `staging/${transition.path}`);
    const located = await openControl(root, relativePath, { expected: "either" });
    await assertReplaceable(located.absolutePath);
    await atomicWrite(located.absolutePath, transition.proposed.bytes);
    const staged = await readState(located.absolutePath);
    if (!sameFile(staged, transition.proposed)) throw new TypeError("TEMPLATE_TRANSACTION_INCONSISTENT: staged bytes do not match the proposed digest");
  }
}

async function publishBoundary(root: string, id: string, boundary: PlanBoundary): Promise<boolean> {
  const finalPath = await verifyFinal(root, boundary.path);
  const current = await readState(finalPath);
  if (sameFile(current, boundary.proposed)) return false;
  if (!sameFile(current, boundary.expected)) {
    throw new PublicationHalt(diagnostic("TEMPLATE_TRANSACTION_INCONSISTENT", "current bytes match neither the expected preimage nor the proposed bytes", boundary.path));
  }
  if (boundary.proposed.state === "absent") {
    await rm(finalPath, { force: true });
  } else {
    const staged = await openControl(root, transactionRelative(id, `staging/${boundary.path}`), { expected: "existing-file" });
    const stagedState = await readState(staged.absolutePath);
    if (!sameFile(stagedState, boundary.proposed)) {
      throw new PublicationHalt(diagnostic("TEMPLATE_TRANSACTION_INCONSISTENT", "staged bytes do not match the proposed digest", boundary.path));
    }
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    await assertReplaceable(finalPath);
    await rename(staged.absolutePath, finalPath);
  }
  const readBack = await readState(finalPath);
  if (!sameFile(readBack, boundary.proposed)) throw new TypeError("TEMPLATE_TRANSACTION_INCONSISTENT: published bytes do not match the proposed digest");
  return true;
}

function journalPublication(vault: string, operation: string, plan: DurablePlan): void {
  try {
    const invocation = createRuntimeInvocation({ surface: "kernel", operation, packageVersion: readBundledPackageVersion() });
    const events = [
      createRuntimeEvent(invocation, {
        kind: "template-contract-commit",
        outcome: "success",
        transactionId: plan.transactionId,
        inputSignature: plan.approvalDigest,
        templateSignature: plan.outputDigest,
      }),
      ...plan.boundaries.map(boundary => createRuntimeEvent(invocation, {
        kind: "template-contract-commit-control",
        outcome: "success",
        transactionId: plan.transactionId,
        templateId: boundary.templateId,
        notePath: boundary.path,
        inputSignature: plan.approvalDigest,
        templateSignature: boundary.proposed.state === "present" ? boundary.proposed.signature : null,
      })),
    ];
    for (const event of events) appendRuntimeEvent(event, { vaultPath: vault });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      process.emitWarning(`LEDGER_APPEND_FAILED: ${detail}`, { code: "LEDGER_APPEND_FAILED" });
    } catch {
      // External history must not change a publication that has already reached its complete marker.
    }
  }
}

function warnStaging(id: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  try {
    process.emitWarning(`Committed template transaction ${id} could not remove staging payloads: ${detail}`, { code: "TEMPLATE_TRANSACTION_STAGING_CLEANUP_FAILED" });
  } catch {
    // Cleanup reporting cannot change an already committed vault outcome.
  }
}

async function finishPublication(root: string, plan: DurablePlan, boundaries: readonly PlanBoundary[], operation: string, written: readonly TransactionPath[]): Promise<TemplateTransactionReceipt> {
  const verified = await revalidateProposed(root, boundaries, plan.outputDigest);
  if (verified === null) throw new TypeError("TEMPLATE_TRANSACTION_INCONSISTENT: published outputs failed revalidation");
  await writeMarkerFile(root, "complete", plan);
  journalPublication(root, operation, plan);
  await rm(join(root, ...transactionRelative(plan.transactionId, "staging").split("/")), { recursive: true, force: true }).catch(error => warnStaging(plan.transactionId, error));
  return { status: "applied", transactionId: plan.transactionId, approvalDigest: plan.approvalDigest, outputDigest: plan.outputDigest, writtenPaths: written, verified, markerState: "complete" };
}

async function publishPrepared(root: string, plan: DurablePlan, boundaries: readonly PlanBoundary[], operation: string): Promise<TemplateTransactionReceipt> {
  const written: TransactionPath[] = [];
  for (const boundary of [...boundaries].sort(byPublication)) {
    if (await publishBoundary(root, plan.transactionId, boundary)) written.push(boundary.path);
  }
  return finishPublication(root, plan, boundaries, operation, written);
}

async function withPublicationLock(root: string, id: string, approval: Digest, output: Digest, body: () => Promise<TemplateTransactionReceipt>): Promise<TemplateTransactionReceipt> {
  const directory = (await openControl(root, transactionRelative(id), { expected: "either" })).absolutePath;
  const lock = join(directory, "lock");
  const token = await acquireTransactionLock(directory, lock);
  if (token === null) return rejected(approval, output, diagnostic("CONTRACT_TRANSACTION_IN_PROGRESS", "template transaction lock is held"));
  try {
    return await body();
  } catch (error: unknown) {
    if (error instanceof PublicationHalt) return inconsistent(approval, output, error.item);
    throw error;
  } finally {
    await releaseTransactionLock(lock, token);
  }
}

function alreadyComplete(marker: StoredMarker, verified: readonly TransactionVerifiedPath[]): TemplateTransactionReceipt {
  return { status: "already-complete", transactionId: marker.transactionId, approvalDigest: marker.approvalDigest, outputDigest: marker.outputDigest, writtenPaths: [], verified, markerState: "complete" };
}

function completedReceipt(root: string, marker: Extract<MarkerRead, { readonly state: "complete" }>, manifest: TemplateCompositionManifest): Promise<TemplateTransactionReceipt> {
  if (marker.marker.approvalDigest !== manifest.approvalDigest) {
    return Promise.resolve(inconsistent(manifest.approvalDigest, manifest.outputDigest, diagnostic("TEMPLATE_TRANSACTION_INCONSISTENT", "completed publication does not match this approval")));
  }
  if (marker.marker.outputDigest !== manifest.outputDigest) {
    return Promise.resolve(inconsistent(manifest.approvalDigest, manifest.outputDigest, diagnostic("TEMPLATE_TRANSACTION_INCONSISTENT", "completed publication failed fresh output revalidation")));
  }
  return revalidateProposed(root, marker.plan.boundaries, marker.plan.outputDigest).then(verified => verified === null
    ? inconsistent(manifest.approvalDigest, manifest.outputDigest, diagnostic("TEMPLATE_TRANSACTION_INCONSISTENT", "completed publication failed fresh output revalidation"))
    : alreadyComplete(marker.marker, verified));
}

async function publishNew(root: string, manifest: TemplateCompositionManifest, transitions: readonly Transition[]): Promise<TemplateTransactionReceipt> {
  const writes = transitions.filter(transition => transition.action === "write").sort(byPublication);
  if (writes.length === 0) {
    return { status: "unchanged", approvalDigest: manifest.approvalDigest, outputDigest: manifest.outputDigest, outputs: manifest.outputs };
  }
  const plan = createPlan(manifest, writes);
  let markerDurable = false;
  try {
    return await withPublicationLock(root, plan.transactionId, manifest.approvalDigest, manifest.outputDigest, async () => {
      const marker = await readMarker(root);
      if (marker.state === "invalid") return manifestRejected(manifest, diagnostic("CONTRACT_TRANSACTION_IN_PROGRESS", "template transaction marker is invalid"));
      if (marker.state === "in-progress") return resumeRequired(manifest.approvalDigest, manifest.outputDigest, "an in-progress template transaction must be resumed");
      if (marker.state === "complete" && marker.marker.approvalDigest === manifest.approvalDigest) return completedReceipt(root, marker, manifest);
      for (const transition of transitions) {
        const actual = await readState(await verifyFinal(root, transition.path));
        if (!sameFile(actual, transition.expectedCurrent)) {
          const code = isControlPath(transition.path) ? "CONTRACT_UNVERIFIABLE" : "MANAGED_TEMPLATE_DRIFT";
          return manifestRejected(manifest, diagnostic(code, "observed bytes do not match expectedCurrent", transition.path));
        }
      }
      await stageWrites(root, plan.transactionId, writes);
      await writeJson(root, transactionRelative(plan.transactionId, "plan.json"), { ...planMaterial(plan), planDigest: plan.planDigest });
      await writeMarkerFile(root, "in-progress", plan);
      markerDurable = true;
      return await publishPrepared(root, plan, plan.boundaries, "publish-template-contract");
    });
  } catch (error: unknown) {
    if (markerDurable) return resumeRequired(manifest.approvalDigest, manifest.outputDigest, "publication stopped after the marker was durable; resume is required");
    await rm(join(root, ...transactionRelative(plan.transactionId, "staging").split("/")), { recursive: true, force: true }).catch(() => undefined);
    return manifestRejected(manifest, pathDiagnostic(error));
  }
}

async function resumeLocked(root: string, marker: StoredMarker, plan: DurablePlan): Promise<TemplateTransactionReceipt> {
  try {
    return await withPublicationLock(root, marker.transactionId, marker.approvalDigest, marker.outputDigest, async () => {
      const current = await readMarker(root);
      if (current.state !== "in-progress" || current.marker.transactionId !== marker.transactionId || current.plan.planDigest !== plan.planDigest) {
        return inconsistent(marker.approvalDigest, marker.outputDigest, diagnostic("TEMPLATE_TRANSACTION_INCONSISTENT", "durable marker changed before resume"));
      }
      return await publishPrepared(root, plan, plan.boundaries, "resume-template-contract");
    });
  } catch {
    return resumeRequired(marker.approvalDigest, marker.outputDigest, "resume stopped after the marker was durable");
  }
}

/**
 * P05 read admission. Reads only: no lock, journal, staging, or other writes.
 * Missing is clear. Invalid and in-progress are never admitted.
 * Complete is clear only when the marker checksum and durable plan agree.
 * A managed draft that later differs from the published bytes does not block admission.
 * That is MANAGED_TEMPLATE_DRIFT and the approved snapshot remains usable.
 * An already-complete receipt revalidates output bytes separately.
 */
export async function inspectTemplateTransactionMarker(vault: string): Promise<TemplateTransactionMarkerInspection> {
  try {
    const marker = await readMarker(vault);
    if (marker.state === "absent") return { admission: "clear", state: "absent", marker: null };
    if (marker.state === "invalid") return { admission: "blocked", state: "invalid", marker: null };
    if (marker.state === "in-progress") return { admission: "blocked", state: "in-progress", marker: publicMarker(marker.marker) };
    return { admission: "clear", state: "complete", marker: publicMarker(marker.marker) };
  } catch {
    return { admission: "blocked", state: "invalid", marker: null };
  }
}

/** Publishes one approved v4 manifest. Dry-run only reads. A torn apply stays resume-required or inconsistent. */
export async function executeTemplateTransaction(vault: string, manifest: TemplateCompositionManifest, request: GuardedTemplateRequest): Promise<TemplateTransactionReceipt> {
  const validated = validateManifest(manifest);
  if (!validated.ok) return manifestRejected(manifest, validated.diagnostic);
  if (!requestAccepted(request, manifest.approvalDigest)) {
    return manifestRejected(manifest, invalidManifest("approvedDigest must exactly equal the recomputed approval digest"));
  }
  let root: string;
  try {
    root = (await openControl(vault, TEMPLATE_TRANSACTION_MARKER_PATH, { expected: "either" })).vaultRoot;
    await confinePublication(root, publicationId(manifest.approvalDigest, manifest.outputDigest), confinementTargets(validated.transitions));
  } catch (error: unknown) {
    return manifestRejected(manifest, pathDiagnostic(error));
  }
  try {
    const marker = await readMarker(root);
    if (marker.state === "invalid") return manifestRejected(manifest, diagnostic("CONTRACT_TRANSACTION_IN_PROGRESS", "template transaction marker is invalid"));
    if (marker.state === "in-progress") return resumeRequired(manifest.approvalDigest, manifest.outputDigest, "an in-progress template transaction must be resumed");
    if (marker.state === "complete" && marker.marker.approvalDigest === manifest.approvalDigest) return completedReceipt(root, marker, manifest);
    for (const transition of [...validated.transitions].sort(byPublication)) {
      const actual = await readState(await verifyFinal(root, transition.path));
      if (!sameFile(actual, transition.expectedCurrent)) {
        const code = isControlPath(transition.path) ? "CONTRACT_UNVERIFIABLE" : "MANAGED_TEMPLATE_DRIFT";
        return manifestRejected(manifest, diagnostic(code, "observed bytes do not match expectedCurrent", transition.path));
      }
    }
  } catch (error: unknown) {
    return manifestRejected(manifest, pathDiagnostic(error));
  }
  if (request.dryRun === true || validated.transitions.every(transition => transition.action === "verify-only")) {
    const status = validated.transitions.every(transition => transition.action === "verify-only") ? "unchanged" : "planned";
    return { status, approvalDigest: manifest.approvalDigest, outputDigest: manifest.outputDigest, outputs: manifest.outputs };
  }
  return publishNew(root, manifest, validated.transitions);
}

/** Continues one durable marker from staged and published bytes. External bytes that match neither old nor new stop resume. */
export async function resumeTemplateTransaction(vault: string, transactionId: string, approvedDigest: Digest): Promise<TemplateTransactionReceipt> {
  let marker: MarkerRead;
  try {
    marker = await readMarker(vault);
  } catch (error: unknown) {
    return rejected(digestOrNull(approvedDigest), null, pathDiagnostic(error));
  }
  if (marker.state === "absent" || marker.state === "invalid") {
    return rejected(digestOrNull(approvedDigest), null, diagnostic("CONTRACT_TRANSACTION_IN_PROGRESS", "template transaction marker is missing or invalid"));
  }
  if (marker.marker.transactionId !== transactionId || marker.marker.approvalDigest !== approvedDigest) {
    return rejected(marker.marker.approvalDigest, marker.marker.outputDigest, invalidManifest("resume does not match the durable marker"));
  }
  try {
    await confinePublication(marker.root, marker.plan.transactionId, marker.plan.boundaries.map(boundary => ({
      path: boundary.path,
      stage: boundary.proposed.state === "present",
    })));
    if (marker.state === "complete") {
      const verified = await revalidateProposed(marker.root, marker.plan.boundaries, marker.plan.outputDigest);
      return verified === null
        ? inconsistent(marker.marker.approvalDigest, marker.marker.outputDigest, diagnostic("TEMPLATE_TRANSACTION_INCONSISTENT", "completed publication failed fresh output revalidation"))
        : alreadyComplete(marker.marker, verified);
    }
    return await resumeLocked(marker.root, marker.marker, marker.plan);
  } catch (error: unknown) {
    return inconsistent(marker.marker.approvalDigest, marker.marker.outputDigest, pathDiagnostic(error));
  }
}
