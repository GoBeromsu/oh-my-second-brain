import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { inputDigest, approvalDigest, outputDigest } from "./canonical.js";
import { normalizeTemplateControlPath, normalizeTemplateSourcePath, verifyTemplateControlPath, verifyTemplateSourcePath } from "./paths.js";
import { readBundledPackageVersion } from "../runtime/assets.js";
import { appendRuntimeEvent, createRuntimeEvent, createRuntimeInvocation } from "../runtime/event-journal.js";
import type { RuntimeEvent, RuntimeEventOutcome, RuntimeInvocation } from "../runtime/event-types.js";
import type { ControlPath, Digest, FileExpectation, GuardedTemplateRequest, TemplateCompositionManifest, TemplateTransactionMarkerPath, TemplateTransactionReceipt, TransactionPath, TransactionVerifiedPath, VerifiedFileState } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_MARKER_PATH: TemplateTransactionMarkerPath = ".oms/template-migration.json";
export const TEMPLATE_MUTATION_MARKER_PATH: TemplateTransactionMarkerPath = ".oms/template-transaction.json";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
type ManagedPath = TransactionPath | TemplateTransactionMarkerPath;
type Boundary = { readonly path: TransactionPath; readonly expected: FileExpectation; readonly proposed: VerifiedFileState };
type DurablePlan = { readonly version: 1; readonly transactionId: string; readonly approvalDigest: Digest; readonly outputDigest: Digest; readonly current: unknown; readonly proposed: unknown; readonly operations: unknown; readonly moves: unknown; readonly outputs: unknown; readonly manifest: string; readonly boundaries: readonly Boundary[]; };
type Marker = { readonly status: "in-progress" | "complete"; readonly transactionId: string; readonly inputDigest: Digest; readonly approvalDigest: Digest; readonly outputDigest: Digest; readonly planDigest: Digest; readonly checksum: Digest; };

function sha(value: Uint8Array | string): Digest { return `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest; }
function bytes(value: string): Uint8Array { return encoder.encode(value); }
function canonical(value: unknown): string {
  if (value instanceof Uint8Array) return JSON.stringify({ bytes: Buffer.from(value).toString("base64") });
  if (value === null || typeof value !== "object") { const encoded = JSON.stringify(value); return encoded === undefined ? "null" : encoded; }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
function diagnostic(code: "MIGRATION_APPROVAL_MISMATCH" | "MIGRATION_RETRY_MISMATCH" | "MIGRATION_PUBLISHED_OUTPUT_CONFLICT" | "TEMPLATE_TRANSACTION_INCONSISTENT" | "TEMPLATE_TRANSACTION_MANIFEST_INVALID" | "migration-incomplete") { return [{ code }] as const; }
function rejected(manifest: TemplateCompositionManifest, code: "MIGRATION_APPROVAL_MISMATCH" | "MIGRATION_RETRY_MISMATCH" | "MIGRATION_PUBLISHED_OUTPUT_CONFLICT" | "TEMPLATE_TRANSACTION_MANIFEST_INVALID" | "migration-incomplete", repair: readonly TransactionPath[] = []): TemplateTransactionReceipt { return { status: "rejected", mode: manifest.mode, currentInputDigest: manifest.current.inputDigest, proposedInputDigest: manifest.proposed.inputDigest, approvalDigest: manifest.approvalDigest, outputDigest: manifest.outputDigest, diagnostics: diagnostic(code), repair }; }
function inconsistent(manifest: TemplateCompositionManifest, repair: readonly TransactionPath[]): TemplateTransactionReceipt { return { status: "inconsistent", mode: manifest.mode, currentInputDigest: manifest.current.inputDigest, proposedInputDigest: manifest.proposed.inputDigest, approvalDigest: manifest.approvalDigest, outputDigest: manifest.outputDigest, diagnostics: diagnostic("TEMPLATE_TRANSACTION_INCONSISTENT"), repair }; }
async function state(vault: string, path: ManagedPath): Promise<VerifiedFileState> { try { const content = new Uint8Array(await readFile(join(vault, path))); return { state: "present", bytes: content, signature: sha(content) }; } catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return { state: "absent" }; throw error; } }
function matches(actual: VerifiedFileState, expected: FileExpectation): boolean { return actual.state === "absent" || expected.state === "absent" ? actual.state === expected.state : actual.signature === expected.signature; }
async function verifyPath(vault: string, path: TransactionPath, expectation: FileExpectation): Promise<boolean> { if (path.startsWith(".oms/")) await verifyTemplateControlPath(vault, normalizeTemplateControlPath(path), { expected: "either" }); else await verifyTemplateSourcePath(vault, normalizeTemplateSourcePath(path), { expected: "either" }); return matches(await state(vault, path), expectation); }
function manifestValid(manifest: TemplateCompositionManifest): boolean {
  if (manifest.version !== 1 || manifest.controls.length !== 3 || Object.hasOwn(manifest, "legacyCleanup")) return false;
  const paths: readonly ControlPath[] = [".oms/template-policy.json", ".oms/taxonomy.json", ".oms/types.json"];
  if (!manifest.controls.every((control, index) => control.path === paths[index] && control.proposed.signature === sha(control.proposed.bytes))) return false;
  try {
    if (manifest.current.inputDigest !== inputDigest(manifest.current.input) || manifest.proposed.inputDigest !== inputDigest(manifest.proposed.input)) return false;
    if (manifest.approvalDigest !== approvalDigest(manifest.proposed.inputDigest, manifest.operations, manifest.diagnostics, manifest)) return false;
    if (manifest.outputDigest !== outputDigest(manifest.outputs)) return false;
  } catch {
    return false;
  }
  const ordered = <T>(values: readonly T[], key: (value: T) => string): boolean => values.every((value, index) => index === 0 || key(values[index - 1]!) <= key(value));
  if (!ordered(manifest.sources, source => `${source.templateId}\0${source.path}`) || !ordered(manifest.moves, move => move.templateId)) return false;
  const sourcePaths = new Set<string>();
  if (manifest.sources.some(source => sourcePaths.has(source.path) || !sourcePaths.add(source.path))) return false;
  const outputPaths = new Set<string>();
  if (manifest.outputs.some(output => outputPaths.has(output.finalVaultRelativePath) || !outputPaths.add(output.finalVaultRelativePath))) return false;
  return manifest.operations.every(operation => operation.stableRelativeSuffix === null);
}
function unchanged(manifest: TemplateCompositionManifest): boolean { return manifest.sources.every(source => source.action === "verify-only") && manifest.controls.every(control => control.action === "verify-only"); }
function transactionId(manifest: TemplateCompositionManifest): string { return createHash("sha256").update(`${manifest.approvalDigest}\0${manifest.outputDigest}`).digest("hex").slice(0, 32); }
function isMarkerPath(path: unknown): path is TemplateTransactionMarkerPath { return path === ".oms/template-migration.json" || path === ".oms/template-transaction.json" || path === ".oms/template-backfill.json" || path === ".oms/template-regenerate.json"; }
function isTransactionPath(path: ManagedPath): path is TransactionPath { return !isMarkerPath(path); }
function markerDirectory(markerPath: TemplateTransactionMarkerPath): string { return markerPath.slice(".oms/".length, -".json".length); }
function transactionDirectory(vault: string, id: string, marker: TemplateTransactionMarkerPath): string { return join(vault, ".oms", ".template-transactions", id, markerDirectory(marker)); }
async function cleanupCommittedStaging(vault: string, id: string, marker: TemplateTransactionMarkerPath): Promise<void> {
  const staging = join(transactionDirectory(vault, id, marker), "staging");
  try {
    await rm(staging, { recursive: true, force: true });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      process.emitWarning(
        `Committed template transaction ${id} could not remove staging payloads: ${detail}`,
        { code: "TEMPLATE_TRANSACTION_STAGING_CLEANUP_FAILED" },
      );
    } catch {
      // Cleanup reporting cannot change an already committed vault outcome.
    }
  }
}
function appendJournalEvent(vault: string, event: RuntimeEvent): void {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      appendRuntimeEvent(event, { vaultPath: vault });
      return;
    } catch (error: unknown) {
      failure = error;
    }
  }
  const detail = failure instanceof Error ? failure.message : String(failure);
  try {
    process.emitWarning(`LEDGER_APPEND_FAILED: ${detail}`, { code: "LEDGER_APPEND_FAILED" });
  } catch {
    // Runtime history is non-blocking after the vault outcome is known.
  }
}
function journalInvocation(operation: string): RuntimeInvocation {
  return createRuntimeInvocation({ surface: "kernel", operation, packageVersion: readBundledPackageVersion() });
}
function receiptOutcome(receipt: TemplateTransactionReceipt): RuntimeEventOutcome {
  if (receipt.status === "rejected") return "rejected";
  if (receipt.status === "unchanged" || receipt.status === "already-complete") return "unchanged";
  if (receipt.status === "inconsistent") return "failure";
  return "success";
}
function recordTransactionReceipt(vault: string, invocation: RuntimeInvocation, receipt: TemplateTransactionReceipt, manifest: TemplateCompositionManifest): void {
  const transactionId = receipt.status === "applied" || receipt.status === "already-complete" ? receipt.transactionId : null;
  appendJournalEvent(vault, createRuntimeEvent(invocation, {
    kind: "template-transaction-invocation",
    outcome: receiptOutcome(receipt),
    transactionId,
    inputSignature: "inputDigest" in receipt ? receipt.inputDigest : receipt.proposedInputDigest,
  }));
  if (receipt.status !== "applied") return;
  const signatures = new Map(manifest.proposed.resolvedTemplates.map(template => [template.templateId, template.templateSignature]));
  const currentBindings = new Map(manifest.current.bindings.map(binding => [binding.templateId, binding]));
  const proposedBindings = new Map(manifest.proposed.bindings.map(binding => [binding.templateId, binding]));
  const changedSources = new Set(
    manifest.sources
      .filter(source => source.action === "write" || source.action === "delete")
      .map(source => source.templateId),
  );
  const projectionChanged = manifest.controls.some(control => control.kind === "projection" && control.action === "write");
  for (const operation of receipt.operations) {
    let kind: string | null = null;
    if (operation.kind === "create") {
      kind = currentBindings.has(operation.templateId) ? null : "template-create";
    } else if (operation.kind === "update") {
      const before = currentBindings.get(operation.templateId);
      const after = proposedBindings.get(operation.templateId);
      if (changedSources.has(operation.templateId) || canonical(before) !== canonical(after)) kind = "template-update";
    } else if (operation.kind === "reclassify") {
      const before = currentBindings.get(operation.templateId);
      const after = proposedBindings.get(operation.templateId);
      if (before?.destinationClass !== after?.destinationClass) kind = "template-reclassify";
    } else if (operation.kind === "regenerate" && projectionChanged) {
      kind = "template-regenerate";
    }
    if (kind === null) continue;
    appendJournalEvent(vault, createRuntimeEvent(invocation, {
      kind,
      outcome: "success",
      transactionId,
      templateId: operation.templateId,
      inputSignature: receipt.inputDigest,
      templateSignature: signatures.get(operation.templateId) ?? operation.payloadDigest,
    }));
  }
  for (const move of receipt.moves) {
    if (move.strategy === "no-op") continue;
    appendJournalEvent(vault, createRuntimeEvent(invocation, {
      kind: "template-move",
      outcome: "success",
      transactionId,
      templateId: move.templateId,
      inputSignature: receipt.inputDigest,
      templateSignature: move.sourceSignature,
    }));
  }
}
function recordTransactionFailure(vault: string, invocation: RuntimeInvocation): void {
  appendJournalEvent(vault, createRuntimeEvent(invocation, { kind: "template-transaction-invocation", outcome: "failure" }));
}
function planFor(manifest: TemplateCompositionManifest): DurablePlan {
  const boundaries: Boundary[] = [
    ...manifest.sources.filter(source => source.action === "write").sort((left, right) => left.templateId.localeCompare(right.templateId)).map(source => ({ path: source.path as TransactionPath, expected: source.expectedCurrent, proposed: source.proposed })),
    ...manifest.controls.filter(control => control.action === "write").map(control => ({ path: control.path as TransactionPath, expected: control.expectedCurrent, proposed: control.proposed })),
    ...manifest.sources.filter(source => source.action === "delete").sort((left, right) => left.templateId.localeCompare(right.templateId)).map(source => ({ path: source.path as TransactionPath, expected: source.expectedCurrent, proposed: source.proposed })),
  ];
  return { version: 1, transactionId: transactionId(manifest), approvalDigest: manifest.approvalDigest, outputDigest: manifest.outputDigest, current: manifest.current.input, proposed: manifest.proposed.input, operations: manifest.operations, moves: manifest.moves, outputs: manifest.outputs, manifest: canonical(manifest), boundaries };
}
function planDigest(plan: DurablePlan): Digest { return sha(canonical(plan)); }
function markerFor(status: Marker["status"], manifest: TemplateCompositionManifest, plan: DurablePlan): Marker {
  const bare = { status, transactionId: plan.transactionId, inputDigest: manifest.proposed.inputDigest, approvalDigest: manifest.approvalDigest, outputDigest: manifest.outputDigest, planDigest: planDigest(plan) };
  return { ...bare, checksum: sha(canonical(bare)) };
}
function markerBytes(value: Marker): Uint8Array { return bytes(`${canonical(value)}\n`); }
async function writeDurablePlan(vault: string, marker: TemplateTransactionMarkerPath, plan: DurablePlan): Promise<void> {
  const directory = transactionDirectory(vault, plan.transactionId, marker);
  const staging = join(directory, "staging");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "plan.json"), `${canonical(plan)}\n`, { mode: 0o600 });
  await writeFile(join(directory, "progress.json"), "[]\n", { mode: 0o600 });
  for (const boundary of plan.boundaries) {
    if (boundary.proposed.state === "absent") continue;
    const target = join(staging, boundary.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, boundary.proposed.bytes, { mode: 0o600 });
  }
}
async function durablePlan(vault: string, marker: TemplateTransactionMarkerPath, value: Marker): Promise<DurablePlan | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(transactionDirectory(vault, value.transactionId, marker), "plan.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || sha(canonical(parsed)) !== value.planDigest) return null;
    const raw = parsed as DurablePlan;
    const boundaries = raw.boundaries.map((boundary): Boundary => {
      if (boundary.proposed.state === "absent") return boundary;
      const encoded = boundary.proposed.bytes as unknown;
      if (
        typeof encoded !== "object" ||
        encoded === null ||
        Array.isArray(encoded) ||
        typeof (encoded as { readonly bytes?: unknown }).bytes !== "string"
      ) {
        throw new Error("invalid staged bytes");
      }
      const revived = new Uint8Array(Buffer.from((encoded as { readonly bytes: string }).bytes, "base64"));
      if (sha(revived) !== boundary.proposed.signature) throw new Error("invalid staged digest");
      return { ...boundary, proposed: { ...boundary.proposed, bytes: revived } };
    });
    const plan = { ...raw, boundaries };
    if (plan.version !== 1 || plan.transactionId !== value.transactionId || plan.approvalDigest !== value.approvalDigest || plan.outputDigest !== value.outputDigest || !Array.isArray(plan.boundaries) || typeof plan.manifest !== "string" || !("current" in plan) || !("proposed" in plan) || !("operations" in plan) || !("moves" in plan) || !("outputs" in plan)) return null;
    return plan;
  } catch { return null; }
}
async function readMarker(vault: string, marker: TemplateTransactionMarkerPath): Promise<{ readonly state: "absent" } | { readonly state: "invalid" } | { readonly state: "valid"; readonly marker: Marker; readonly plan: DurablePlan | null }> {
  const value = await state(vault, marker);
  if (value.state === "absent") return { state: "absent" };
  try {
    const parsed: unknown = JSON.parse(decoder.decode(value.bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { state: "invalid" };
    const candidate = parsed as Marker;
    const bare = { status: candidate.status, transactionId: candidate.transactionId, inputDigest: candidate.inputDigest, approvalDigest: candidate.approvalDigest, outputDigest: candidate.outputDigest, planDigest: candidate.planDigest };
    if (
      (candidate.status !== "in-progress" && candidate.status !== "complete") ||
      !/^[0-9a-f]{32}$/.test(candidate.transactionId) ||
      !DIGEST.test(candidate.inputDigest) ||
      !DIGEST.test(candidate.approvalDigest) ||
      !DIGEST.test(candidate.outputDigest) ||
      !DIGEST.test(candidate.planDigest) ||
      !DIGEST.test(candidate.checksum) ||
      sha(canonical(bare)) !== candidate.checksum
    ) return { state: "invalid" };
    const plan = await durablePlan(vault, marker, candidate);
    return plan === null && candidate.status === "in-progress"
      ? { state: "invalid" }
      : { state: "valid", marker: candidate, plan };
  } catch { return { state: "invalid" }; }
}
export async function templateMigrationAdmission(vault: string): Promise<"clear" | "migration-incomplete"> { const value = await readMarker(vault, DEFAULT_MARKER_PATH); return value.state === "valid" && value.marker.status === "complete" || value.state === "absent" ? "clear" : "migration-incomplete"; }
export async function templateMigrationMarkerState(vault: string): Promise<"absent" | "in-progress" | "complete" | "invalid"> { const value = await readMarker(vault, DEFAULT_MARKER_PATH); return value.state === "valid" ? value.marker.status : value.state; }
type Published = { readonly path: ManagedPath; readonly old: VerifiedFileState; readonly newState: VerifiedFileState };
async function atomicWrite(target: string, content: Uint8Array | string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function publish(vault: string, path: ManagedPath, proposed: VerifiedFileState, published: Published[]): Promise<void> {
  const old = await state(vault, path);
  if (proposed.state === "absent") await rm(join(vault, path), { force: true });
  else await atomicWrite(join(vault, path), proposed.bytes);
  published.push({ path, old, newState: proposed });
}
async function rollback(vault: string, published: readonly Published[]): Promise<boolean> {
  for (const item of [...published].reverse()) {
    try {
      const current = await state(vault, item.path);
      if (!matches(current, item.newState)) return false;
      if (item.old.state === "absent") await rm(join(vault, item.path), { force: true });
      else await atomicWrite(join(vault, item.path), item.old.bytes);
      if (!matches(await state(vault, item.path), item.old)) return false;
    } catch { return false; }
  }
  return true;
}
function verified(path: TransactionPath, value: VerifiedFileState): TransactionVerifiedPath { return value.state === "absent" ? { path, state: "absent" } : { path, state: "present", payloadDigest: value.signature }; }
function reviveState(value: unknown): VerifiedFileState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid durable state");
  const record = value as Record<string, unknown>;
  if (record["state"] === "absent") return { state: "absent" };
  const encoded = record["bytes"];
  if (
    record["state"] !== "present" ||
    typeof record["signature"] !== "string" ||
    typeof encoded !== "object" ||
    encoded === null ||
    Array.isArray(encoded) ||
    typeof (encoded as { readonly bytes?: unknown }).bytes !== "string"
  ) {
    throw new Error("invalid durable state");
  }
  const content = new Uint8Array(Buffer.from((encoded as { readonly bytes: string }).bytes, "base64"));
  if (sha(content) !== record["signature"]) throw new Error("invalid durable state digest");
  return { state: "present", bytes: content, signature: record["signature"] as Digest };
}
function manifestFromPlan(plan: DurablePlan): TemplateCompositionManifest | null {
  try {
    const parsed = JSON.parse(plan.manifest) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record["controls"]) || !Array.isArray(record["sources"])) return null;
    const controls = record["controls"].map((control) => {
      if (typeof control !== "object" || control === null || Array.isArray(control)) throw new Error("invalid durable control");
      const item = control as Record<string, unknown>;
      return { ...item, current: reviveState(item["current"]), proposed: reviveState(item["proposed"]) };
    });
    const sources = record["sources"].map((source) => {
      if (typeof source !== "object" || source === null || Array.isArray(source)) throw new Error("invalid durable source");
      const item = source as Record<string, unknown>;
      return { ...item, current: reviveState(item["current"]), proposed: reviveState(item["proposed"]) };
    });
    const manifest = { ...record, controls, sources } as unknown as TemplateCompositionManifest;
    return manifestValid(manifest) ? manifest : null;
  } catch {
    return null;
  }
}

interface TransactionLockOwner { readonly pid: number; readonly token: string; }
async function acquireTransactionLock(directory: string, lock: string): Promise<string | null> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  try {
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, token })}\n`, { flag: "wx", mode: 0o600 });
    return token;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  let owner: TransactionLockOwner;
  try {
    const parsed = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as TransactionLockOwner;
    if (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.token !== "string") return null;
    owner = parsed;
  } catch {
    return null;
  }
  try {
    process.kill(owner.pid, 0);
    return null;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") return null;
  }
  try {
    await writeFile(join(lock, "takeover"), `${process.pid}\n${token}\n`, { flag: "wx", mode: 0o600 });
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === "ENOENT")) return null;
    throw error;
  }
  try {
    const claimed = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as TransactionLockOwner;
    if (claimed.pid !== owner.pid || claimed.token !== owner.token) return null;
  } catch {
    return null;
  }
  const stale = `${lock}.stale.${token}`;
  try {
    await rename(lock, stale);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EEXIST")) return null;
    throw error;
  }
  await rm(stale, { recursive: true, force: true });
  return acquireTransactionLock(directory, lock);
}
async function releaseTransactionLock(lock: string, token: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as TransactionLockOwner;
    if (owner.token !== token || owner.pid !== process.pid) return;
    const released = `${lock}.released.${token}`;
    await rename(lock, released);
    await rm(released, { recursive: true, force: true });
  } catch {
    // A missing or replaced lock is never removed by a non-owner.
  }
}

/** Resumes one persisted in-progress transaction without rebuilding stale filesystem preflight state. */
async function resumeTemplateTransactionInternal(
  vault: string,
  transactionId: string,
  approvedDigest: Digest,
  markerPath: TemplateTransactionMarkerPath = DEFAULT_MARKER_PATH,
): Promise<TemplateTransactionReceipt> {
  const active = await readMarker(vault, markerPath);
  if (
    active.state !== "valid" ||
    active.marker.status !== "in-progress" ||
    active.marker.transactionId !== transactionId ||
    active.marker.approvalDigest !== approvedDigest
  ) {
    throw new Error("MIGRATION_RETRY_MISMATCH");
  }
  const manifest = active.plan === null ? null : manifestFromPlan(active.plan);
  if (manifest === null) throw new Error("TEMPLATE_TRANSACTION_MANIFEST_INVALID");
  return executeTemplateTransactionInternal(vault, manifest, { approvedDigest }, markerPath);
}

export async function resumeTemplateTransaction(
  vault: string,
  transactionId: string,
  approvedDigest: Digest,
  markerPath: TemplateTransactionMarkerPath = DEFAULT_MARKER_PATH,
): Promise<TemplateTransactionReceipt> {
  const invocation = journalInvocation("resume-template-transaction");
  try {
    const receipt = await resumeTemplateTransactionInternal(vault, transactionId, approvedDigest, markerPath);
    const active = await readMarker(vault, markerPath);
    const manifest = active.state === "valid" && active.plan !== null ? manifestFromPlan(active.plan) : null;
    if (manifest === null) recordTransactionFailure(vault, invocation);
    else recordTransactionReceipt(vault, invocation, receipt, manifest);
    return receipt;
  } catch (error: unknown) {
    recordTransactionFailure(vault, invocation);
    throw error;
  }
}

/** Returns a verified receipt for an already completed durable transaction. */
export interface CompletedTemplateTransaction {
  readonly transactionId: string;
  readonly inputDigest: Digest;
  readonly approvalDigest: Digest;
  readonly outputDigest: Digest;
  readonly verified: readonly TransactionVerifiedPath[];
}

export interface CompletedTemplateTransactionExpectation {
  readonly inputDigest: Digest;
  readonly outputs: readonly { readonly finalVaultRelativePath: TransactionPath; }[];
}

export async function completedTemplateTransaction(
  vault: string,
  approvedDigest: Digest,
  expected: CompletedTemplateTransactionExpectation,
  markerPath: TemplateTransactionMarkerPath = DEFAULT_MARKER_PATH,
): Promise<CompletedTemplateTransaction | null> {
  const active = await readMarker(vault, markerPath);
  if (
    active.state !== "valid" ||
    active.marker.status !== "complete" ||
    active.marker.approvalDigest !== approvedDigest
  ) {
    return null;
  }
  const states = await Promise.all(expected.outputs.map(async (item) => ({ path: item.finalVaultRelativePath, state: await state(vault, item.finalVaultRelativePath) })));
  if (states.some((item) => item.state.state === "absent")) return null;
  const currentOutputs = states.map((item) => {
    if (item.state.state === "absent") throw new Error("unreachable absent completed output");
    return { finalVaultRelativePath: item.path, payloadDigest: item.state.signature };
  });
  const currentOutputDigest = outputDigest(currentOutputs);
  if (active.marker.inputDigest !== expected.inputDigest || active.marker.outputDigest !== currentOutputDigest) return null;
  return {
    transactionId: active.marker.transactionId,
    inputDigest: active.marker.inputDigest,
    approvalDigest: active.marker.approvalDigest,
    outputDigest: active.marker.outputDigest,
    verified: states.map((item) => verified(item.path, item.state)),
  };
}

/** Publishes a pre-composed manifest; semantic composition is intentionally outside this module. */
async function executeTemplateTransactionInternal(vault: string, manifest: TemplateCompositionManifest, request: GuardedTemplateRequest, markerPath: TemplateTransactionMarkerPath = DEFAULT_MARKER_PATH): Promise<TemplateTransactionReceipt> {
  if (!isMarkerPath(markerPath)) throw new TypeError("TEMPLATE_SOURCE_UNSAFE: marker path is not approved");
  if (!manifestValid(manifest)) return rejected(manifest, "TEMPLATE_TRANSACTION_MANIFEST_INVALID");
  if (request.dryRun && request.approvedDigest !== undefined || !request.dryRun && request.approvedDigest !== manifest.approvalDigest) return rejected(manifest, "MIGRATION_APPROVAL_MISMATCH");
  const plan = planFor(manifest);
  const active = await readMarker(vault, markerPath);
  if (active.state === "invalid") return rejected(manifest, "migration-incomplete");
  if (active.state === "valid" && active.marker.status === "in-progress" && request.dryRun) return rejected(manifest, "migration-incomplete");
  if (markerPath !== DEFAULT_MARKER_PATH && await templateMigrationAdmission(vault) === "migration-incomplete") return rejected(manifest, "migration-incomplete");
  if (unchanged(manifest)) { for (const control of manifest.controls) if (!(await verifyPath(vault, control.path, control.expectedCurrent))) return rejected(manifest, "MIGRATION_APPROVAL_MISMATCH"); return { status: "unchanged", mode: manifest.mode, currentInputDigest: manifest.current.inputDigest, proposedInputDigest: manifest.proposed.inputDigest, approvalDigest: manifest.approvalDigest, outputDigest: manifest.outputDigest, operations: manifest.operations, moves: manifest.moves, outputs: manifest.outputs, writtenPaths: [], deletedPaths: [] }; }
  if (active.state === "valid" && active.marker.status === "complete") {
    if (active.marker.approvalDigest !== manifest.approvalDigest || active.marker.outputDigest !== manifest.outputDigest) {
      // A completed record is history: a distinct approved transaction may replace it.
    } else {
      const final = [...manifest.controls.map(control => ({ path: control.path as TransactionPath, value: control.proposed })), ...manifest.sources.map(source => ({ path: source.path as TransactionPath, value: source.proposed }))];
      if (!(await Promise.all(final.map(async item => matches(await state(vault, item.path), item.value)))).every(Boolean)) return rejected(manifest, "MIGRATION_RETRY_MISMATCH");
      await cleanupCommittedStaging(vault, plan.transactionId, markerPath);
      return { status: "already-complete", mode: manifest.mode, transactionId: plan.transactionId, currentInputDigest: manifest.current.inputDigest, inputDigest: manifest.proposed.inputDigest, approvedDigest: request.approvedDigest!, outputDigest: manifest.outputDigest, operations: manifest.operations, moves: manifest.moves, writtenPaths: [], deletedPaths: [], verified: await Promise.all(final.map(async item => verified(item.path, await state(vault, item.path)))), markerState: "complete" };
    }
  }
  if (active.state === "valid" && active.marker.status === "in-progress" && (active.plan === null || canonical(active.plan) !== canonical(plan))) return rejected(manifest, "migration-incomplete");
  for (const control of manifest.controls) if (!(await verifyPath(vault, control.path, control.expectedCurrent)) && !(active.state === "valid" && active.marker.status === "in-progress" && matches(await state(vault, control.path), control.proposed))) return rejected(manifest, active.state === "valid" ? "MIGRATION_RETRY_MISMATCH" : "MIGRATION_APPROVAL_MISMATCH");
  for (const source of manifest.sources) if (!(await verifyPath(vault, source.path, source.expectedCurrent)) && !(active.state === "valid" && active.marker.status === "in-progress" && matches(await state(vault, source.path), source.proposed))) return rejected(manifest, active.state === "valid" ? "MIGRATION_RETRY_MISMATCH" : "MIGRATION_APPROVAL_MISMATCH");
  if (request.dryRun) return { status: "planned", mode: manifest.mode, currentInputDigest: manifest.current.inputDigest, proposedInputDigest: manifest.proposed.inputDigest, approvalDigest: manifest.approvalDigest, outputDigest: manifest.outputDigest, operations: manifest.operations, moves: manifest.moves, outputs: manifest.outputs, writtenPaths: [], deletedPaths: [] };
  const directory = transactionDirectory(vault, plan.transactionId, markerPath);
  const lock = join(directory, "lock");
  let lockToken: string | null;
  try {
    lockToken = await acquireTransactionLock(directory, lock);
    if (lockToken === null) return rejected(manifest, "MIGRATION_RETRY_MISMATCH");
  } catch {
    return rejected(manifest, "MIGRATION_RETRY_MISMATCH");
  }
  const published: Published[] = [];
  try {
    if (active.state === "absent" || active.state === "valid" && active.marker.status === "complete") await writeDurablePlan(vault, markerPath, plan);
    const progressPath = join(directory, "progress.json");
    let completed: string[];
    try { const parsed: unknown = JSON.parse(await readFile(progressPath, "utf8")); if (!Array.isArray(parsed) || parsed.some(value => typeof value !== "string")) throw new Error("invalid progress"); completed = [...parsed]; } catch { throw new Error("invalid progress"); }
    const boundaryKeys = new Set(plan.boundaries.map(boundary => `${boundary.path}\0${boundary.proposed.state === "present" ? boundary.proposed.signature : "absent"}`));
    if (completed.some((key, index) => !boundaryKeys.has(key) || completed.indexOf(key) !== index)) throw new Error("invalid progress");
    const inProgress = markerFor("in-progress", manifest, plan);
    if (active.state === "absent" || active.state === "valid" && active.marker.status === "complete") await publish(vault, markerPath, { state: "present", bytes: markerBytes(inProgress), signature: sha(markerBytes(inProgress)) }, published);
    for (const boundary of plan.boundaries) {
      const key = `${boundary.path}\0${boundary.proposed.state === "present" ? boundary.proposed.signature : "absent"}`;
      const actual = await state(vault, boundary.path);
      if (matches(actual, boundary.proposed)) { if (!completed.includes(key)) { completed.push(key); await atomicWrite(progressPath, `${canonical(completed)}\n`); } continue; }
      if (!matches(actual, boundary.expected)) throw new Error("boundary mismatch");
      await publish(vault, boundary.path, boundary.proposed, published);
      if (!matches(await state(vault, boundary.path), boundary.proposed)) throw new Error("read-back");
      completed.push(key); await atomicWrite(progressPath, `${canonical(completed)}\n`);
    }
    const final = [...manifest.controls.map(control => ({ path: control.path as TransactionPath, value: control.proposed })), ...manifest.sources.map(source => ({ path: source.path as TransactionPath, value: source.proposed }))];
    if (!(await Promise.all(final.map(async item => matches(await state(vault, item.path), item.value)))).every(Boolean)) throw new Error("read-back");
    const complete = markerFor("complete", manifest, plan);
    await publish(vault, markerPath, { state: "present", bytes: markerBytes(complete), signature: sha(markerBytes(complete)) }, published);
    const verifiedFinal = await Promise.all(final.map(async item => verified(item.path, await state(vault, item.path))));
    await cleanupCommittedStaging(vault, plan.transactionId, markerPath);
    return { status: "applied", mode: manifest.mode, transactionId: plan.transactionId, currentInputDigest: manifest.current.inputDigest, inputDigest: manifest.proposed.inputDigest, approvedDigest: request.approvedDigest!, outputDigest: manifest.outputDigest, operations: manifest.operations, moves: manifest.moves, writtenPaths: published.map(item => item.path).filter(isTransactionPath), deletedPaths: manifest.sources.filter(source => source.action === "delete").map(source => source.path), verified: verifiedFinal, markerState: "complete" };
  } catch {
    if (active.state === "valid" && active.marker.status === "in-progress") {
      return inconsistent(manifest, plan.boundaries.map(boundary => boundary.path));
    }
    const restored = await rollback(vault, published);
    if (restored) { await rm(directory, { recursive: true, force: true }); return rejected(manifest, "MIGRATION_PUBLISHED_OUTPUT_CONFLICT"); }
    return inconsistent(manifest, published.map(item => item.path).filter(isTransactionPath));
  } finally { await releaseTransactionLock(lock, lockToken); }
}

/** Executes one guarded transaction and records external runtime history without changing vault semantics. */
export async function executeTemplateTransaction(vault: string, manifest: TemplateCompositionManifest, request: GuardedTemplateRequest, markerPath: TemplateTransactionMarkerPath = DEFAULT_MARKER_PATH): Promise<TemplateTransactionReceipt> {
  const invocation = journalInvocation("execute-template-transaction");
  try {
    const receipt = await executeTemplateTransactionInternal(vault, manifest, request, markerPath);
    recordTransactionReceipt(vault, invocation, receipt, manifest);
    return receipt;
  } catch (error: unknown) {
    recordTransactionFailure(vault, invocation);
    throw error;
  }
}
