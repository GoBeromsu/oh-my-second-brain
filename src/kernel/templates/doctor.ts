import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { admitWriteTarget } from "../capture/safe.js";
import type { WriteTargetSource } from "../conventions/write-protocol.js";
import { readBundledPackageVersion } from "../runtime/assets.js";
import { appendRuntimeEvent, createRuntimeEvent, createRuntimeInvocation } from "../runtime/event-journal.js";
import { readRuntimeEvents } from "../runtime/event-read.js";
import { summarizeRuntimeHistory, type RuntimeHistorySummary } from "../runtime/event-summary.js";
import { approvalDigest, inputDigest, outputDigest, templateInput } from "./canonical.js";
import { parseNote } from "../conventions/frontmatter.js";
import { excludedNoteMatcher } from "../conventions/note-exclude.js";
import { deriveTemplateSourcePath, normalizeTemplateSourcePath, verifyTemplateSourcePath } from "./paths.js";
import { parseDerivedProjection, parseTemplatePolicy } from "./policy.js";
import { buildTemplateCompositionManifest, loadResolvedTemplates } from "./resolver.js";
import { executeTemplateTransaction, templateMigrationAdmission, templateMigrationMarkerState } from "./transaction.js";
import type { DerivedProjection, Digest, FileExpectation, GuardedTemplateRequest, InputV2, TemplateCompositionManifest, TemplateId, TemplatePolicy, TemplateSourcePath, TemplateTransactionReceipt, VerifiedFileState } from "./types.js";

export interface TemplateDoctorTarget { readonly vault: string; readonly source: WriteTargetSource; readonly maxPerTemplate?: number; }
export interface TemplateDoctorDiagnostic { readonly code: string; readonly path?: string; readonly templateId?: TemplateId; readonly expected?: Digest; readonly actual?: Digest; readonly remediation: string; }
export interface TemplateDoctorDiagnosis { readonly status: "healthy" | "needs-repair"; readonly diagnostics: readonly TemplateDoctorDiagnostic[]; readonly managedSourceExclusions: readonly string[]; readonly unresolvedLegacyNotes: readonly string[]; readonly migrationMarker: "absent" | "in-progress" | "complete" | "invalid"; readonly history?: RuntimeHistorySummary; readonly runtimeWarnings?: readonly string[]; }
export interface RegenerateTypesRequest { readonly target: TemplateDoctorTarget; readonly request: GuardedTemplateRequest; }
export interface BackfillDefaultsRequest { readonly target: TemplateDoctorTarget; readonly notePath: string; readonly request: GuardedTemplateRequest; }
export type TemplateDoctorRepair = TemplateTransactionReceipt | { readonly status: "rejected"; readonly code: string; readonly remediation: string; };

const encoder = new TextEncoder();
const REGENERATE_MARKER = ".oms/template-regenerate.json";
const BACKFILL_MARKER = ".oms/template-backfill.json";
function digest(value: Uint8Array): Digest { return `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest; }
function expectation(value: VerifiedFileState): FileExpectation { return value.state === "absent" ? value : { state: "present", signature: value.signature }; }
function bytes(value: string): Uint8Array { return encoder.encode(value); }
async function state(vault: string, path: string): Promise<VerifiedFileState> {
  try { const value = new Uint8Array(await readFile(join(vault, path))); return { state: "present", bytes: value, signature: digest(value) }; }
  catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return { state: "absent" }; throw error; }
}
function rejected(code: string, remediation: string): TemplateDoctorRepair { return { status: "rejected", code, remediation }; }
async function admitted(target: TemplateDoctorTarget): Promise<TemplateDoctorRepair | null> {
  const failure = await admitWriteTarget(target);
  if (failure !== undefined) return rejected(failure.code, failure.remediation);
  return await templateMigrationAdmission(resolve(target.vault)) === "clear"
    ? null
    : rejected("migration-incomplete", "resume or repair the validated template migration transaction before reading or repairing conventions");
}
function code(error: unknown): string { return error instanceof Error ? error.message.split(":", 1)[0] ?? "TEMPLATE_DOCTOR_INVALID" : "TEMPLATE_DOCTOR_INVALID"; }
async function exists(vault: string, path: string): Promise<boolean> {
  try { return (await lstat(join(vault, path))).isFile(); }
  catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
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

const LOGICAL_SOURCE_PATHS: Readonly<Record<string, string>> = {
  "template-policy": ".oms/template-policy.json",
  taxonomy: ".oms/taxonomy.json",
  "obsidian-types": ".obsidian/types.json",
};

async function projectionDriftDiagnostics(
  vault: string,
  projection: DerivedProjection,
  policy: TemplatePolicy,
): Promise<readonly TemplateDoctorDiagnostic[]> {
  const templateIds = new Map<string, TemplateId>(
    Object.values(policy.templates).map(binding => [binding.sourcePath, binding.templateId]),
  );
  const diagnostics: TemplateDoctorDiagnostic[] = [];
  for (const source of projection.generatedFrom.sources) {
    const path = source.path ?? (source.logicalId === undefined ? undefined : LOGICAL_SOURCE_PATHS[source.logicalId] ?? source.logicalId);
    if (path === undefined) continue;
    const current = await state(vault, path);
    if (current.state !== "present" || current.signature === source.signature) continue;
    const templateId = source.path === undefined ? undefined : templateIds.get(source.path);
    diagnostics.push({
      code: "TEMPLATE_SOURCE_DRIFT",
      path,
      ...(templateId === undefined ? {} : { templateId }),
      expected: source.signature,
      actual: current.signature,
      remediation: "run regenerate-types with the returned approval digest",
    });
  }
  return diagnostics;
}

/** Read-only health report for template authorities, projection, legacy notes, and transaction state. */
async function diagnoseTemplatesInternal(target: TemplateDoctorTarget): Promise<TemplateDoctorDiagnosis> {
  const root = resolve(target.vault);
  const migrationMarker = await templateMigrationMarkerState(root);
  if (migrationMarker === "in-progress" || migrationMarker === "invalid") {
    return {
      status: "needs-repair",
      diagnostics: [{ code: "migration-incomplete", path: ".oms/template-migration.json", remediation: "resume or repair the validated template migration transaction before reading conventions" }],
      managedSourceExclusions: [],
      unresolvedLegacyNotes: [],
      migrationMarker,
    };
  }
  const jsonExists = await exists(root, ".oms/taxonomy.json");
  if (!jsonExists) return { status: "needs-repair", diagnostics: [{ code: "TEMPLATE_CONTROL_MISSING", path: ".oms/taxonomy.json", remediation: "restore the JSON taxonomy authority before reading or repairing conventions" }], managedSourceExclusions: [], unresolvedLegacyNotes: [], migrationMarker };
  if (jsonExists) {
    try { JSON.parse(await readFile(join(root, ".oms/taxonomy.json"), "utf8")); }
    catch { return { status: "needs-repair", diagnostics: [{ code: "TEMPLATE_SOURCE_INVALID", path: ".oms/taxonomy.json", remediation: "restore valid .oms/taxonomy.json, then rerun doctor" }], managedSourceExclusions: [], unresolvedLegacyNotes: [], migrationMarker }; }
  }
  const diagnostics: TemplateDoctorDiagnostic[] = [];
  let policy: TemplatePolicy | null = null;
  let projection: DerivedProjection | null = null;
  try { policy = parseTemplatePolicy(await readFile(join(root, ".oms/template-policy.json"), "utf8")); }
  catch (error: unknown) { diagnostics.push({ code: code(error), path: ".oms/template-policy.json", remediation: "restore a valid template policy before repairing the projection" }); }
  try { projection = parseDerivedProjection(await readFile(join(root, ".oms/types.json"), "utf8")); }
  catch (error: unknown) { diagnostics.push({ code: code(error), path: ".oms/types.json", remediation: "run regenerate-types with the returned approval digest" }); }
  if (policy !== null) {
    const drift = projection === null ? [] : await projectionDriftDiagnostics(root, projection, policy);
    diagnostics.push(...drift);
    try { await loadResolvedTemplates(root); }
    catch (error: unknown) {
      const errorCode = code(error);
      if (errorCode !== "TEMPLATE_SOURCE_DRIFT") {
        diagnostics.push({ code: errorCode, remediation: "run regenerate-types after correcting the named authority or template source" });
      }
    }
  }
  for (const path of await invalidNotes(root)) diagnostics.push({ code: "MIGRATION_NOTE_INVALID", path, remediation: "repair the note frontmatter before migration" });
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
  return { status: unique.size === 0 ? "healthy" : "needs-repair", diagnostics: bounded, managedSourceExclusions: policy === null ? [] : Object.values(policy.templates).map(deriveTemplateSourcePath), unresolvedLegacyNotes: [], migrationMarker };
}

function ledgerWarning(error: unknown): string {
  const detail = error instanceof Error ? error.message.replace(/^LEDGER_APPEND_FAILED:\s*/, "") : String(error);
  return `LEDGER_APPEND_FAILED: ${detail}. Runtime history is incomplete; verify the external OMS runtime ledger.`;
}

/** Diagnoses current bytes, then records the check and each authority/source observation externally. */
export async function diagnoseTemplates(target: TemplateDoctorTarget): Promise<TemplateDoctorDiagnosis> {
  const root = resolve(target.vault);
  const invocation = createRuntimeInvocation({ surface: "kernel", operation: "template-check", packageVersion: readBundledPackageVersion() });
  let diagnosis: TemplateDoctorDiagnosis;
  try {
    diagnosis = await diagnoseTemplatesInternal(target);
  } catch (error: unknown) {
    try {
      appendRuntimeEvent(createRuntimeEvent(invocation, {
        kind: "template-check",
        outcome: "failure",
      }), { vaultPath: root });
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
    let policy: TemplatePolicy | null = null;
    try { policy = parseTemplatePolicy(await readFile(join(root, ".oms/template-policy.json"), "utf8")); }
    catch { /* The failed authority observation below remains explicit. */ }
    const observations = [
      { path: ".oms/template-policy.json", templateId: null },
      { path: ".oms/taxonomy.json", templateId: null },
      { path: ".obsidian/types.json", templateId: null },
      ...(policy === null ? [] : Object.values(policy.templates).map(binding => ({
        path: deriveTemplateSourcePath(binding),
        templateId: binding.templateId as string,
      }))),
    ];
    for (const observation of observations) {
      const current = await state(root, observation.path);
      const prior = previous.find(event =>
        event.notePath === observation.path &&
        event.templateId === observation.templateId
      );
      const currentSignature = current.state === "present" ? current.signature : null;
      const priorSignature = prior?.templateSignature ?? prior?.inputSignature ?? null;
      const changed = prior !== undefined && priorSignature !== currentSignature;
      const event = createRuntimeEvent(invocation, {
        kind: "template-verification",
        outcome: current.state === "present" ? "success" : "observation-gap",
        eventTime: null,
        templateId: observation.templateId,
        notePath: observation.path,
        ...(observation.templateId === null ? { inputSignature: currentSignature } : { templateSignature: currentSignature }),
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

/** Recomputes only the derived projection and delegates all publication to the guarded transaction. */
export async function regenerateTypes(input: RegenerateTypesRequest): Promise<TemplateDoctorRepair> {
  const admission = await admitted(input.target);
  if (admission !== null) return admission;
  const root = resolve(input.target.vault);
  let policy: TemplatePolicy;
  try { policy = parseTemplatePolicy(await readFile(join(root, ".oms/template-policy.json"), "utf8")); }
  catch (error: unknown) { return rejected(code(error), "restore a supported v3 .oms/template-policy.json before regenerating types"); }
  try {
    const controls = await Promise.all([state(root, ".oms/template-policy.json"), state(root, ".oms/taxonomy.json"), state(root, ".oms/types.json"), state(root, ".obsidian/types.json")]);
    if (controls[0]?.state === "absent" || controls[1]?.state === "absent" || controls[3]?.state === "absent") return rejected("TEMPLATE_CONTROL_MISSING", "restore template policy, taxonomy, and Obsidian types before regenerating types");
    const sources = await Promise.all(Object.values(policy.templates).map(async binding => {
      const path = deriveTemplateSourcePath(binding);
      const current = await state(root, path);
      return { templateId: binding.templateId, path, expected: expectation(current), current };
    }));
    const sourceDigests = new Map<string, Digest>();
    for (const source of sources) {
      if (source.current.state === "absent") throw new Error("TEMPLATE_SOURCE_INVALID");
      sourceDigests.set(source.templateId, source.current.signature);
    }
    const regenerationInput = templateInput(
      policy,
      {
        policy: (controls[0] as Extract<VerifiedFileState, { state: "present" }>).signature,
        taxonomy: (controls[1] as Extract<VerifiedFileState, { state: "present" }>).signature,
        obsidianTypes: (controls[3] as Extract<VerifiedFileState, { state: "present" }>).signature,
        obsidianTypesPath: ".obsidian/types.json",
      },
      Object.values(policy.templates),
      (binding) => {
        const source = sourceDigests.get(binding.templateId);
        if (source === undefined) throw new Error("TEMPLATE_SOURCE_INVALID");
        return source;
      },
    );
    const manifest = await buildTemplateCompositionManifest(root, { mode: "regenerate" }, {
      expected: { input: inputDigest(regenerationInput), controls: { policy: expectation(controls[0]!), taxonomy: expectation(controls[1]!), projection: expectation(controls[2]!) }, sources: sources.map(({ templateId, path, expected }) => ({ templateId, path, expected })) },
      taxonomy: { expectedCurrent: expectation(controls[1]!), proposedBytes: (controls[1] as Extract<VerifiedFileState, { state: "present" }>).bytes, action: "verify-only" },
      allowProjectionRepair: true,
    });
    return executeTemplateTransaction(root, manifest, input.request, REGENERATE_MARKER);
  } catch (error: unknown) { return rejected(code(error), "correct the named template authority or source, then request a new dry-run digest"); }
}

function legacyTemplateId(policy: TemplatePolicy, raw: string, taxonomyRaw: string, notePath: TemplateSourcePath): TemplateId | null {
  const parsed = parseNote(raw);
  if (!parsed.hasFrontmatter || parsed.diagnostics.length > 0 || parsed.frontmatter["template"] !== undefined) return null;
  const concept = parsed.frontmatter["concept"];
  if (typeof concept !== "string") return null;
  let root: unknown;
  try { root = JSON.parse(taxonomyRaw) as unknown; }
  catch { return null; }
  if (typeof root !== "object" || root === null || Array.isArray(root)) return null;
  const folders = (root as Record<string, unknown>)["folders"];
  if (typeof folders !== "object" || folders === null || Array.isArray(folders)) return null;
  const candidates = Object.entries(folders).filter(([folder, binding]) => {
    if (typeof binding !== "object" || binding === null || Array.isArray(binding)) return false;
    const mapped = (binding as Record<string, unknown>)["concept"];
    return (typeof mapped === "string" ? [mapped] : Array.isArray(mapped) ? mapped : []).includes(concept)
      && (notePath === folder || notePath.startsWith(`${folder}/`));
  });
  if (candidates.length !== 1) return null;
  const matches = Object.values(policy.templates).filter(binding => binding.templateId === concept);
  if (matches.length !== 1) return null;
  const escaped = concept.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = new RegExp(`^concept:[ \t]*(?:"${escaped}"|'${escaped}'|${escaped})[ \t]*(?:\r?\n)`, "m");
  return line.test(parsed.frontmatterRaw) ? matches[0]!.templateId : null;
}
async function noteManifest(root: string, notePath: TemplateSourcePath, before: Extract<VerifiedFileState, { readonly state: "present" }>, after: Uint8Array, templateId: TemplateId): Promise<TemplateCompositionManifest> {
  const controlPaths = [".oms/template-policy.json", ".oms/taxonomy.json", ".oms/types.json"] as const;
  const values = await Promise.all(controlPaths.map(path => state(root, path)));
  if (values.some(value => value.state === "absent")) throw new Error("TEMPLATE_CONTROL_MISSING");
  const controls = controlPaths.map((path, index) => {
    const value = values[index]! as Extract<VerifiedFileState, { readonly state: "present" }>;
    return { kind: path === ".oms/template-policy.json" ? "policy" as const : path === ".oms/taxonomy.json" ? "taxonomy" as const : "projection" as const, path, expectedCurrent: expectation(value), current: value, proposed: value, action: "verify-only" as const };
  }) as unknown as TemplateCompositionManifest["controls"];
  const authority: InputV2 = { version: 2, templateFolders: [], authority: [{ kind: "template", logicalId: templateId, vaultRelativePath: notePath, contentDigest: digest(after) }], placement: [] };
  const transition = { templateId, path: notePath, expectedCurrent: expectation(before), current: before, proposed: { state: "present" as const, bytes: after, signature: digest(after) }, action: "write" as const };
  const outputs = [...controls.map(control => ({ finalVaultRelativePath: control.path, payloadDigest: control.proposed.signature })), { finalVaultRelativePath: notePath, payloadDigest: digest(after) }];
  const operations = [{ kind: "update" as const, templateId, destinationClass: "registered-existing" as const, payloadDigest: digest(after), stableRelativeSuffix: null }];
  const snapshot = { input: authority, inputDigest: inputDigest(authority), bindings: [], resolvedTemplates: [] };
  return {
    version: 1, mode: "update", current: snapshot, proposed: snapshot,
    controls, sources: [transition], operations, diagnostics: [], moves: [], outputs,
    approvalDigest: approvalDigest(inputDigest(authority), operations, [], { current: snapshot, controls, sources: [transition] }), outputDigest: outputDigest(outputs),
  };
}

/** Backfills one explicitly named legacy note; it never enumerates or bulk-writes notes. */
export async function backfillDefaults(input: BackfillDefaultsRequest): Promise<TemplateDoctorRepair> {
  const admission = await admitted(input.target);
  if (admission !== null) return admission;
  const root = resolve(input.target.vault);
  let path: TemplateSourcePath;
  try { path = normalizeTemplateSourcePath(input.notePath); await verifyTemplateSourcePath(root, path); }
  catch { return rejected("TEMPLATE_SOURCE_UNSAFE", "provide one existing regular markdown note path inside the verified vault"); }
  try {
    const [before, policyRaw, taxonomyRaw] = await Promise.all([state(root, path), readFile(join(root, ".oms/template-policy.json"), "utf8"), readFile(join(root, ".oms/taxonomy.json"), "utf8")]);
    if (before.state === "absent") return rejected("TEMPLATE_SOURCE_INVALID", "provide one existing note path");
    const policy = parseTemplatePolicy(policyRaw);
    const raw = Buffer.from(before.bytes).toString("utf8");
    const templateId = legacyTemplateId(policy, raw, taxonomyRaw, path);
    if (templateId === null) return rejected("MIGRATION_NOTE_IDENTITY_UNRESOLVED", "resolve this note's legacy concept to exactly one stable template before applying");
    const original = parseNote(raw);
    if (!original.hasFrontmatter || original.diagnostics.length > 0) return rejected("TEMPLATE_SOURCE_INVALID", "repair this note's frontmatter before backfilling identity");
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const conceptLine = /^concept:[ \t]*(?:"[^"]*"|'[^']*'|[^\r\n]*)[ \t]*$/m;
    const edited = conceptLine.test(raw)
      ? raw.replace(conceptLine, `template: ${templateId}`)
      : raw.replace(/^(\ufeff?---\r?\n)/, `$1template: ${templateId}${eol}`);
    const reparsed = parseNote(edited);
    if (reparsed.frontmatter["template"] !== templateId || reparsed.body !== original.body) return rejected("TEMPLATE_TRANSACTION_INCONSISTENT", "identity backfill did not preserve the note body exactly");
    const manifest = await noteManifest(root, path, before, bytes(edited), templateId);
    return executeTemplateTransaction(root, manifest, input.request, BACKFILL_MARKER);
  } catch (error: unknown) { return rejected(code(error), "correct the note or template controls, then request a new dry-run digest"); }
}
