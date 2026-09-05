import { parseTemplate, type ExtractedTemplate } from "./extract.js";
import { deriveManagedSourcePath, isTemplateSourceInFolder, normalizeTemplateFolderPath, normalizeTemplateSourcePath, selectTemplateFolder, validateTemplateId } from "./paths.js";
import type { SourceProposal, TemplateBinding, TemplateFolderRegistration, TemplateSourcePath } from "./types.js";

export interface TemplateAddRequest {
  readonly templateId: string;
  /** Registered folder that receives the new source; omitted selects the registered creation default. */
  readonly sourceFolder?: string;
  /** Explicit vault-relative path inside `sourceFolder`; omitted derives `<folder>/<templateId>.md`. */
  readonly sourcePath?: string;
  readonly bytes: Uint8Array;
  readonly contract: string;
  readonly naming: string;
}

export interface ComposedTemplateAdd {
  readonly binding: TemplateBinding;
  readonly source: SourceProposal & { readonly publication: "write" };
  readonly template: ExtractedTemplate;
}

const encoder = new TextEncoder();

/** Minimal Obsidian-core starter used when a selected default folder holds no compatible template yet. */
export function starterTemplateBytes(templateId: string): Uint8Array {
  return encoder.encode(`---\ntemplate: ${validateTemplateId(templateId)}\n---\n<!-- oms:content -->\n`);
}

/**
 * Shared kernel step for every "add a new template" path (setup starter, guarded template add).
 * It validates identity, folder membership, and Obsidian-core syntax, and returns a write proposal;
 * publication still goes through the guarded transaction with dry-run approval.
 */
export function composeTemplateAdd(folders: readonly TemplateFolderRegistration[], request: TemplateAddRequest): ComposedTemplateAdd {
  const templateId = validateTemplateId(request.templateId);
  const folder = selectTemplateFolder(folders, request.sourceFolder === undefined ? undefined : normalizeTemplateFolderPath(request.sourceFolder));
  const sourcePath: TemplateSourcePath = request.sourcePath === undefined ? deriveManagedSourcePath(folder.path, templateId) : normalizeTemplateSourcePath(request.sourcePath);
  if (!isTemplateSourceInFolder(sourcePath, folder.path)) throw new TypeError(`TEMPLATE_SOURCE_INVALID: ${sourcePath} is outside registered folder ${folder.path}`);
  if (request.contract.trim() === "" || request.naming.trim() === "") throw new TypeError("TEMPLATE_POLICY_INVALID: contract and naming must be non-empty");
  const template = parseTemplate(sourcePath, request.bytes);
  const destinationClass = sourcePath === deriveManagedSourcePath(folder.path, templateId) ? "managed-default" : "registered-existing";
  return {
    binding: { templateId, destinationClass, renderer: "obsidian-core", sourceFolder: folder.path, sourcePath, contract: request.contract, naming: request.naming },
    source: { path: sourcePath, bytes: request.bytes, publication: "write" },
    template,
  };
}
