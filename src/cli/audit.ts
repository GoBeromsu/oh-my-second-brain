import { access } from "node:fs/promises";
import path from "node:path";
import { buildTemplateNoteIndex, diagnoseTemplates, loadResolvedTemplates } from "../kernel/templates/index.js";
import type { TemplateDoctorDiagnostic } from "../kernel/templates/doctor.js";

function validatedFolder(folder: string | undefined): string | undefined {
  if (folder === undefined) return undefined;
  if (folder.length === 0 || folder === "." || folder === ".." || folder.includes("/") || folder.includes("\\")) {
    throw new Error("Audit folder must be one safe top-level name without path separators.");
  }
  return folder;
}

function boundedDiagnostics(
  diagnostics: readonly TemplateDoctorDiagnostic[],
  maxPerTemplate: number | undefined,
): readonly TemplateDoctorDiagnostic[] {
  if (maxPerTemplate === undefined) return diagnostics;
  const counts = new Map<string, number>();
  return diagnostics.filter(item => {
    const key = item.templateId ?? "<vault>";
    const count = counts.get(key) ?? 0;
    counts.set(key, count + 1);
    return count < maxPerTemplate;
  });
}

export async function runAudit(opts: {
  readonly vault: string;
  readonly json?: boolean;
  readonly folder?: string;
  readonly maxPerTemplate?: number;
}): Promise<number> {
  try {
    if (opts.maxPerTemplate !== undefined && (!Number.isSafeInteger(opts.maxPerTemplate) || opts.maxPerTemplate < 1)) {
      throw new Error("Audit maxPerTemplate must be a safe positive integer.");
    }
    const folder = validatedFolder(opts.folder);
    if (folder !== undefined) await access(path.join(opts.vault, folder));
    const convention = await loadResolvedTemplates(opts.vault);
    const index = await buildTemplateNoteIndex(opts.vault, convention);
    const diagnosis = await diagnoseTemplates({ vault: opts.vault, source: "explicit" });
    const notes = folder === undefined ? index.notes : index.notes.filter(note => note.path === folder || note.path.startsWith(`${folder}/`));
    const unresolvedNotes = folder === undefined ? index.unresolvedNotes : index.unresolvedNotes.filter(note => note.path === folder || note.path.startsWith(`${folder}/`));
    const identityDiagnostics: readonly TemplateDoctorDiagnostic[] = unresolvedNotes.map(note => ({
      code: "TEMPLATE_NOTE_IDENTITY_UNRESOLVED",
      path: note.path,
      remediation: `persist a valid template identity (${note.reason})`,
    }));
    const scopedDiagnosis = folder === undefined
      ? diagnosis.diagnostics
      : diagnosis.diagnostics.filter(item => item.code !== "MIGRATION_NOTE_IDENTITY_UNRESOLVED" || item.path === undefined || item.path === folder || item.path.startsWith(`${folder}/`));
    const diagnostics = boundedDiagnostics([...scopedDiagnosis, ...identityDiagnostics], opts.maxPerTemplate);
    const templateCounts: Record<string, number> = {};
    for (const note of notes) templateCounts[note.templateId] = (templateCounts[note.templateId] ?? 0) + 1;
    const result = {
      vault: opts.vault,
      folder: folder ?? null,
      projectionSignature: convention.inputSignature,
      templates: Object.keys(convention.templates).length,
      scannedNotes: notes.length,
      excludedTemplateSources: convention.managedSourcePaths,
      templateCounts,
      status: scopedDiagnosis.length === 0 && unresolvedNotes.length === 0 ? "healthy" : "needs-repair",
      diagnostics,
      unresolvedNotes,
      unresolvedLegacyNotes: folder === undefined ? diagnosis.unresolvedLegacyNotes : diagnosis.unresolvedLegacyNotes.filter(notePath => notePath === folder || notePath.startsWith(`${folder}/`)),
      clean: scopedDiagnosis.length === 0 && unresolvedNotes.length === 0,
    };
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`\nOh My Second Brain audit: ${result.scannedNotes} template-bound note(s), ${result.templates} template(s), status ${result.status}.`);
      for (const item of result.diagnostics) console.log(`  [${item.code}]${item.path === undefined ? "" : ` ${item.path}`} — ${item.remediation}`);
      console.log("");
    }
    return result.clean ? 0 : 1;
  } catch (error) {
    console.error(`[oms] audit could not complete: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
