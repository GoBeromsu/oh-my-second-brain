import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { admitWriteTarget } from "../capture/safe.js";
import type { WriteTargetSource } from "../conventions/write-protocol.js";
import { readBundledPackageVersion } from "../runtime/assets.js";
import { appendRuntimeEvent, createRuntimeEvent, createRuntimeInvocation } from "../runtime/event-journal.js";
import { readRuntimeEvents } from "../runtime/event-read.js";
import { summarizeRuntimeHistory, type RuntimeHistorySummary } from "../runtime/event-summary.js";
import { parseNote } from "../conventions/frontmatter.js";
import { excludedNoteMatcher } from "../conventions/note-exclude.js";
import { digestBytes } from "./canonical.js";
import { loadResolvedTemplates, type ResolvedTemplateSnapshot } from "./resolver.js";
import { commitTemplateContracts, nextTemplateInterview } from "./interview-service.js";
import { inspectTemplateTransactionMarker } from "./transaction.js";
import type { Digest, GuardedTemplateRequest, TemplateId, TemplateTransactionReceipt } from "./types.js";

/**
 * Doctor reads approved contract state and repairs only derived state.
 *
 * Diagnosis needs no verified target. Repair does, and it publishes exclusively
 * through the reviewed interview transaction. Ordinary notes and raw template
 * sources are never written here.
 */

export interface TemplateDoctorTarget {
  readonly vault: string;
  readonly source: WriteTargetSource;
  readonly maxPerTemplate?: number;
}
export interface TemplateDoctorDiagnostic {
  readonly code: string;
  readonly path?: string;
  readonly templateId?: TemplateId;
  readonly expected?: Digest;
  readonly actual?: Digest;
  readonly remediation: string;
  readonly reason?: string;
  readonly message?: string;
}
export interface TemplateDoctorDiagnosis {
  readonly status: "healthy" | "needs-repair";
  readonly diagnostics: readonly TemplateDoctorDiagnostic[];
  readonly managedSourceExclusions: readonly string[];
  readonly invalidNotes: readonly string[];
  readonly transactionMarker: "absent" | "in-progress" | "complete" | "invalid";
  readonly history?: RuntimeHistorySummary;
  readonly runtimeWarnings?: readonly string[];
}
export interface RegenerateTypesRequest {
  readonly target: TemplateDoctorTarget;
  readonly request: GuardedTemplateRequest;
}
export type TemplateDoctorRepair =
  | TemplateTransactionReceipt
  | { readonly status: "rejected"; readonly code: string; readonly remediation: string };

const REVIEW_REMEDIATION = "run oms template review, answer its questions, then commit the reviewed contract";
const INVALID_MARKER_REMEDIATION = "restore the durable marker and its matching plan from a known publication; deleting the marker or regenerating types does not repair it";
const IN_PROGRESS_REMEDIATION = "resume or complete the contract publication before reading or repairing contract state";
const VAULT_ACCESS_REMEDIATION = "restore access to the vault or template control path before retrying inspection";

function rejected(code: string, remediation: string): TemplateDoctorRepair {
  return { status: "rejected", code, remediation };
}

function code(error: unknown): string {
  return error instanceof Error ? error.message.split(":", 1)[0] ?? "TEMPLATE_DOCTOR_INVALID" : "TEMPLATE_DOCTOR_INVALID";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validGuardedRequest(request: GuardedTemplateRequest): boolean {
  if (request === null || typeof request !== "object") return false;
  const candidate = request as { readonly dryRun?: unknown; readonly approvedDigest?: unknown };
  if (candidate.dryRun === true) return candidate.approvedDigest === undefined;
  return typeof candidate.approvedDigest === "string" && /^sha256:[0-9a-f]{64}$/u.test(candidate.approvedDigest);
}

/** Repair needs a verified target; diagnosis does not. */
async function admitted(target: TemplateDoctorTarget): Promise<TemplateDoctorRepair | null> {
  const failure = await admitWriteTarget(target);
  return failure === undefined ? null : rejected(failure.code, failure.remediation);
}

async function invalidNotes(vault: string): Promise<readonly string[]> {
  const excluded = await excludedNoteMatcher(vault, false);
  const invalid: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(absolute); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = relative(vault, absolute).replaceAll("\\", "/");
      if (!excluded(path) && parseNote(await readFile(absolute, "utf8")).diagnostics.length > 0) invalid.push(path);
    }
  };
  await visit(vault);
  return invalid.sort();
}

function snapshotDiagnostics(snapshot: ResolvedTemplateSnapshot): readonly TemplateDoctorDiagnostic[] {
  return snapshot.diagnostics.map(diagnostic => ({
    code: diagnostic.code,
    ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
    ...(diagnostic.templateId === undefined || diagnostic.templateId === null
      ? {}
      : { templateId: diagnostic.templateId as TemplateId }),
    remediation: REVIEW_REMEDIATION,
  }));
}

/** Read-only health of the approved contract, its drafts, sources, and derived projection. */
async function diagnoseTemplatesInternal(target: TemplateDoctorTarget): Promise<TemplateDoctorDiagnosis> {
  const root = resolve(target.vault);
  const inspection = await inspectTemplateTransactionMarker(root);
  if (inspection.admission !== "clear") {
    const failure = inspection.failure;
    const invalid = inspection.state === "invalid";
    const vaultAccess = failure?.reason === "vault-inaccessible";
    return {
      status: "needs-repair",
      diagnostics: [{
        code: "CONTRACT_TRANSACTION_IN_PROGRESS",
        path: failure?.path ?? ".oms/template-transaction.json",
        remediation: vaultAccess ? VAULT_ACCESS_REMEDIATION : invalid ? INVALID_MARKER_REMEDIATION : IN_PROGRESS_REMEDIATION,
        ...(failure === undefined ? {} : { reason: failure.reason, message: failure.message }),
      }],
      managedSourceExclusions: [],
      invalidNotes: [],
      transactionMarker: inspection.state,
    };
  }
  const diagnostics: TemplateDoctorDiagnostic[] = [];
  let snapshot: ResolvedTemplateSnapshot | null = null;
  try {
    snapshot = await loadResolvedTemplates(root);
  } catch (error: unknown) {
    diagnostics.push({
      code: code(error),
      path: ".oms/template-policy.json",
      remediation: message(error).startsWith("CONTRACT_UNVERIFIABLE")
        ? "restore the approved .oms/template-policy.json or publish it again"
        : REVIEW_REMEDIATION,
    });
  }
  if (snapshot !== null) diagnostics.push(...snapshotDiagnostics(snapshot));
  const invalid = await invalidNotes(root);
  for (const path of invalid) {
    // An unreadable note is reported, never rewritten: the agent owns that file.
    diagnostics.push({ code: "NOTE_FRONTMATTER_INVALID", path, remediation: "repair the note frontmatter in the vault" });
  }
  const unique = new Map<string, TemplateDoctorDiagnostic>();
  for (const item of diagnostics) unique.set(`${item.code}\0${item.path ?? ""}`, item);
  const counts = new Map<string, number>();
  const bounded = [...unique.values()].filter(item => {
    if (target.maxPerTemplate === undefined) return true;
    const key = item.templateId ?? "<vault>";
    const count = counts.get(key) ?? 0;
    counts.set(key, count + 1);
    return count < target.maxPerTemplate;
  });
  const managedSourceExclusions = snapshot === null
    ? []
    : [...new Set(snapshot.sources.map(freshness => freshness.source.path as string))];
  return {
    status: unique.size === 0 ? "healthy" : "needs-repair",
    diagnostics: bounded,
    managedSourceExclusions,
    invalidNotes: invalid,
    transactionMarker: inspection.state,
  };
}

function ledgerWarning(error: unknown): string {
  const detail = error instanceof Error ? error.message.replace(/^LEDGER_APPEND_FAILED:\s*/, "") : String(error);
  return `LEDGER_APPEND_FAILED: ${detail}. Runtime history is incomplete; verify the external OMS runtime ledger.`;
}

/** Diagnoses current bytes, then records the check and each control observation externally. */
export async function diagnoseTemplates(target: TemplateDoctorTarget): Promise<TemplateDoctorDiagnosis> {
  const root = resolve(target.vault);
  const invocation = createRuntimeInvocation({ surface: "kernel", operation: "template-check", packageVersion: readBundledPackageVersion() });
  let diagnosis: TemplateDoctorDiagnosis;
  try {
    diagnosis = await diagnoseTemplatesInternal(target);
  } catch (error: unknown) {
    try {
      appendRuntimeEvent(createRuntimeEvent(invocation, { kind: "template-check", outcome: "failure" }), { vaultPath: root });
    } catch { /* The diagnosis failure remains authoritative. */ }
    throw error;
  }
  const warnings: string[] = [];
  try {
    const previous = readRuntimeEvents({ vaultPath: root, kinds: ["template-verification"] }).events;
    appendRuntimeEvent(createRuntimeEvent(invocation, {
      kind: "template-check",
      outcome: diagnosis.status === "healthy" ? "success" : "failure",
    }), { vaultPath: root });
    const observations = [
      { path: ".oms/template-policy.json", templateId: null },
      { path: ".oms/taxonomy.json", templateId: null },
      { path: ".oms/types.json", templateId: null },
      { path: ".obsidian/types.json", templateId: null },
    ];
    for (const observation of observations) {
      let currentSignature: Digest | null = null;
      try { currentSignature = digestBytes(new Uint8Array(await readFile(join(root, observation.path)))); }
      catch { currentSignature = null; }
      const prior = previous.find(event => event.notePath === observation.path && event.templateId === observation.templateId);
      const priorSignature = prior?.templateSignature ?? prior?.inputSignature ?? null;
      const changed = prior !== undefined && priorSignature !== currentSignature;
      const event = createRuntimeEvent(invocation, {
        kind: "template-verification",
        outcome: currentSignature === null ? "observation-gap" : "success",
        eventTime: null,
        templateId: observation.templateId,
        notePath: observation.path,
        inputSignature: currentSignature,
      });
      appendRuntimeEvent(changed ? {
        ...event,
        changedBetweenFrom: prior.observedAt,
        changedBetweenTo: event.observedAt,
      } : event, { vaultPath: root });
    }
  } catch (error: unknown) {
    warnings.push(ledgerWarning(error));
  }
  try {
    return {
      ...diagnosis,
      history: summarizeRuntimeHistory({ vaultPath: root }),
      ...(warnings.length === 0 ? {} : { runtimeWarnings: warnings }),
    };
  } catch (error: unknown) {
    return { ...diagnosis, runtimeWarnings: [...warnings, ledgerWarning(error)] };
  }
}

/** True when the published policy declares the explicit V5 contract. */
async function publishesExplicitContract(root: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, ".oms", "template-policy.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && (parsed as { version?: unknown }).version === 5;
  } catch {
    return false;
  }
}

function reviewRequired(remediation = REVIEW_REMEDIATION): TemplateDoctorRepair {
  return rejected("TEMPLATE_REVIEW_REQUIRED", remediation);
}

/**
 * Regenerates the derived projection through the reviewed interview transaction.
 * It never adopts changed source bytes or contract meaning on its own.
 */
export async function regenerateTypes(input: RegenerateTypesRequest): Promise<TemplateDoctorRepair> {
  const admission = await admitted(input.target);
  if (admission !== null) return admission;
  if (!validGuardedRequest(input.request)) {
    return rejected("TEMPLATE_REQUEST_INVALID", "pass dryRun:true for a proposal or the exact approvalDigest returned by the reviewed dry-run");
  }
  const root = resolve(input.target.vault);
  // A vault on the explicit contract has no derived projection to maintain:
  // the contract itself is the authority and Obsidian reads its own types file.
  if (await publishesExplicitContract(root)) {
    return rejected(
      "TYPES_PROJECTION_OBSOLETE",
      "this vault publishes .oms/template-policy.json version 5, which is the authority itself; no derived .oms/types.json is generated from it",
    );
  }
  try {
    const target = { vault: root, source: input.target.source };
    const review = await nextTemplateInterview(target);
    if (review.state === "question") {
      return reviewRequired("run oms template review, then answer the returned question before regenerating types");
    }
    if (review.state === "blocked") {
      const detail = review.diagnostics[0]?.message;
      return reviewRequired(
        detail === undefined
          ? "run oms template review, correct its diagnostics, then retry regeneration"
          : `run oms template review and correct its diagnostic: ${detail}`,
      );
    }
    return await commitTemplateContracts(target, input.request.dryRun === true
      ? { censusDigest: review.censusDigest, expectedLedgerDigest: review.expectedLedgerDigest, dryRun: true }
      : { censusDigest: review.censusDigest, expectedLedgerDigest: review.expectedLedgerDigest, approvedDigest: input.request.approvedDigest });
  } catch (error: unknown) {
    return rejected(code(error), "correct the named template authority or source, then request a new reviewed dry-run digest");
  }
}
