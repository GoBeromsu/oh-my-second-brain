import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";

import { admitWriteTarget } from "../capture/safe.js";
import type { WriteTargetSource } from "../conventions/write-protocol.js";
import { approvalDigest, inputDigest, outputDigest } from "./canonical.js";
import { parseNote } from "../conventions/frontmatter.js";
import { planTemplateMigration } from "./migration.js";
import { normalizeTemplateSourcePath, verifyTemplateSourcePath } from "./paths.js";
import { parseDerivedProjection, parseTemplatePolicy } from "./policy.js";
import { buildTemplateCompositionManifest, loadResolvedTemplates } from "./resolver.js";
import { executeTemplateTransaction, templateMigrationAdmission, templateMigrationMarkerState } from "./transaction.js";
import type { AuthorityEntry, Digest, FileExpectation, GuardedTemplateRequest, InputV2, TemplateCompositionManifest, TemplateId, TemplatePolicy, TemplateSourcePath, TemplateTransactionReceipt, VerifiedFileState } from "./types.js";

export interface TemplateDoctorTarget { readonly vault: string; readonly source: WriteTargetSource; readonly maxPerTemplate?: number; }
export interface TemplateDoctorDiagnostic { readonly code: string; readonly path?: string; readonly templateId?: TemplateId; readonly remediation: string; }
export interface TemplateDoctorDiagnosis { readonly status: "healthy" | "needs-repair"; readonly diagnostics: readonly TemplateDoctorDiagnostic[]; readonly managedSourceExclusions: readonly string[]; readonly unresolvedLegacyNotes: readonly string[]; readonly migrationMarker: "absent" | "in-progress" | "complete" | "invalid"; }
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

/** Read-only health report for template authorities, projection, legacy notes, and transaction state. */
export async function diagnoseTemplates(target: TemplateDoctorTarget): Promise<TemplateDoctorDiagnosis> {
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
  const diagnostics: TemplateDoctorDiagnostic[] = [];
  let policy: TemplatePolicy | null = null;
  try { policy = parseTemplatePolicy(await readFile(join(root, ".oms/template-policy.json"), "utf8")); }
  catch (error: unknown) { diagnostics.push({ code: code(error), path: ".oms/template-policy.json", remediation: "restore a valid template policy before repairing the projection" }); }
  try { parseDerivedProjection(await readFile(join(root, ".oms/types.json"), "utf8")); }
  catch (error: unknown) { diagnostics.push({ code: code(error), path: ".oms/types.json", remediation: "run regenerate-types with the returned approval digest" }); }
  if (policy !== null) {
    try { await loadResolvedTemplates(root); }
    catch (error: unknown) { diagnostics.push({ code: code(error), remediation: "run regenerate-types after correcting the named authority or template source" }); }
  }
  const proposal = await planTemplateMigration(root, { templateFolder: policy?.templateFolder });
  const unresolvedLegacyNotes = proposal.existingNotes.filter(note => note.templateId === null && note.legacyConcept !== null).map(note => note.path);
  for (const item of proposal.unresolved) diagnostics.push({ code: item.code, ...(item.path === undefined ? {} : { path: item.path }), ...(item.templateId === undefined ? {} : { templateId: item.templateId }), remediation: "resolve this legacy mapping explicitly with backfill-defaults" });
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
  return { status: unique.size === 0 ? "healthy" : "needs-repair", diagnostics: bounded, managedSourceExclusions: proposal.managedSourcePaths, unresolvedLegacyNotes, migrationMarker };
}

/** Recomputes only the derived projection and delegates all publication to the guarded transaction. */
export async function regenerateTypes(input: RegenerateTypesRequest): Promise<TemplateDoctorRepair> {
  const admission = await admitted(input.target);
  if (admission !== null) return admission;
  const root = resolve(input.target.vault);
  let policy: TemplatePolicy;
  try { policy = parseTemplatePolicy(await readFile(join(root, ".oms/template-policy.json"), "utf8")); }
  catch { return rejected("TEMPLATE_POLICY_INVALID", "restore .oms/template-policy.json before regenerating types"); }
  try {
    const controls = await Promise.all([state(root, ".oms/template-policy.json"), state(root, ".oms/taxonomy.yaml"), state(root, ".oms/types.json"), state(root, ".obsidian/types.json")]);
    if (controls[0]?.state === "absent" || controls[1]?.state === "absent" || controls[3]?.state === "absent") return rejected("TEMPLATE_CONTROL_MISSING", "restore template policy, taxonomy, and Obsidian types before regenerating types");
    const sources = await Promise.all(Object.values(policy.templates).map(async binding => {
      const current = await state(root, binding.sourcePath);
      return { templateId: binding.templateId, path: binding.sourcePath, expected: expectation(current), current };
    }));
    const authority: AuthorityEntry[] = [
      { kind: "policy", logicalId: "template-policy", vaultRelativePath: ".oms/template-policy.json", contentDigest: (controls[0] as Extract<VerifiedFileState, { state: "present" }>).signature },
      { kind: "taxonomy", logicalId: "taxonomy", vaultRelativePath: ".oms/taxonomy.yaml", contentDigest: (controls[1] as Extract<VerifiedFileState, { state: "present" }>).signature },
      { kind: "obsidian-types", logicalId: "obsidian-types", vaultRelativePath: ".obsidian/types.json", contentDigest: (controls[3] as Extract<VerifiedFileState, { state: "present" }>).signature },
    ];
    for (const source of sources) {
      if (source.current.state === "absent") throw new Error("TEMPLATE_SOURCE_INVALID");
      authority.push({ kind: "template", logicalId: source.templateId, vaultRelativePath: source.path, contentDigest: source.current.signature });
    }
    const regenerationInput: InputV2 = { version: 2, authority: authority.sort((left, right) => left.kind.localeCompare(right.kind) || left.logicalId.localeCompare(right.logicalId)), placement: Object.values(policy.templates).map(binding => ({ templateId: binding.templateId, destinationClass: binding.destinationClass, templateFolder: binding.destinationClass === "managed-default" ? policy.templateFolder : null, sourcePath: binding.sourcePath })) };
    const manifest = await buildTemplateCompositionManifest(root, { mode: "relocate-folder", templateFolder: policy.templateFolder }, {
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
  const taxonomy = parseDocument(taxonomyRaw, { prettyErrors: false });
  const root = taxonomy.toJS();
  if (taxonomy.errors.length > 0 || typeof root !== "object" || root === null || Array.isArray(root)) return null;
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
  const controlPaths = [".oms/template-policy.json", ".oms/taxonomy.yaml", ".oms/types.json"] as const;
  const values = await Promise.all(controlPaths.map(path => state(root, path)));
  if (values.some(value => value.state === "absent")) throw new Error("TEMPLATE_CONTROL_MISSING");
  const controls = controlPaths.map((path, index) => {
    const value = values[index]! as Extract<VerifiedFileState, { readonly state: "present" }>;
    return { kind: path === ".oms/template-policy.json" ? "policy" as const : path === ".oms/taxonomy.yaml" ? "taxonomy" as const : "projection" as const, path, expectedCurrent: expectation(value), current: value, proposed: value, action: "verify-only" as const };
  }) as unknown as TemplateCompositionManifest["controls"];
  const authority: InputV2 = { version: 2, authority: [{ kind: "template", logicalId: templateId, vaultRelativePath: notePath, contentDigest: digest(after) }], placement: [] };
  const transition = { templateId, path: notePath, expectedCurrent: expectation(before), current: before, proposed: { state: "present" as const, bytes: after, signature: digest(after) }, action: "write" as const };
  const outputs = [...controls.map(control => ({ finalVaultRelativePath: control.path, payloadDigest: control.proposed.signature })), { finalVaultRelativePath: notePath, payloadDigest: digest(after) }];
  const operations = [{ kind: "update" as const, templateId, destinationClass: "registered-existing" as const, payloadDigest: digest(after), stableRelativeSuffix: null }];
  return {
    version: 1, mode: "update", current: { input: authority, inputDigest: inputDigest(authority), bindings: [], resolvedTemplates: [] }, proposed: { input: authority, inputDigest: inputDigest(authority), bindings: [], resolvedTemplates: [] },
    controls, sources: [transition], operations, diagnostics: [], moves: [], outputs,
    approvalDigest: approvalDigest(inputDigest(authority), operations, []), outputDigest: outputDigest(outputs),
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
    const [before, policyRaw, taxonomyRaw] = await Promise.all([state(root, path), readFile(join(root, ".oms/template-policy.json"), "utf8"), readFile(join(root, ".oms/taxonomy.yaml"), "utf8")]);
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
