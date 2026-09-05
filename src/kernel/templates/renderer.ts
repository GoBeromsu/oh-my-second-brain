import { parseTemplate, type ExtractedTemplate } from "./extract.js";
import type { Diagnostic, TemplateRenderer } from "./types.js";

const MAX_PROPOSAL_BYTES = 262_144;
const MAX_PROPOSAL_FIELDS = 64;

export interface TemplateRendererClassification {
  readonly renderer: TemplateRenderer;
  readonly template?: ExtractedTemplate;
  readonly filledBy: readonly string[];
  readonly bodyExternal: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

function containsTemplater(value: unknown): boolean {
  if (typeof value === "string") return value.includes("<%") || value.includes("%>");
  if (Array.isArray(value)) return value.some(containsTemplater);
  return value !== null && typeof value === "object" && Object.values(value).some(containsTemplater);
}

function parseDiagnostic(sourcePath: string, error: unknown): Diagnostic {
  if (error instanceof Error && error.message.startsWith("TEMPLATE_EXPRESSION_UNSUPPORTED:")) {
    const located = error as Error & { readonly location?: unknown; readonly rawToken?: unknown };
    return {
      code: "TEMPLATE_EXPRESSION_UNSUPPORTED",
      path: sourcePath,
      ...(typeof located.location === "string" ? { field: located.location } : {}),
      message: typeof located.rawToken === "string" ? located.rawToken : error.message,
    };
  }
  return {
    code: "TEMPLATE_SOURCE_INVALID",
    path: sourcePath,
    message: error instanceof Error ? error.message : "template source is invalid",
  };
}

/** Classifies template syntax for a host-authored proposal; it never converts or executes template code. */
export function classifyTemplateRenderer(sourcePath: string, bytes: Uint8Array): TemplateRendererClassification {
  if (bytes.byteLength > MAX_PROPOSAL_BYTES) {
    return { renderer: "none", filledBy: [], bodyExternal: false, diagnostics: [{ code: "TEMPLATE_PROPOSAL_OVERSIZE", path: sourcePath }] };
  }
  const raw = Buffer.from(bytes).toString("utf8");
  const content = raw.startsWith("\ufeff") ? raw.slice(1) : raw;
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { renderer: "none", filledBy: [], bodyExternal: content.includes("<%") || content.includes("%>"), diagnostics: [{ code: "TEMPLATE_CONTRACT_UNOBSERVED", path: sourcePath }] };
  }
  const external = content.includes("<%") || content.includes("%>");
  if (!external) {
    try {
      const template = parseTemplate(sourcePath, bytes);
      if (template.keyOrder.length > MAX_PROPOSAL_FIELDS) {
        return { renderer: "none", filledBy: [], bodyExternal: false, diagnostics: [{ code: "TEMPLATE_PROPOSAL_OVERSIZE", path: sourcePath }] };
      }
      return { renderer: "obsidian-core", template, filledBy: [], bodyExternal: false, diagnostics: [] };
    }
    catch (error: unknown) {
      return { renderer: "obsidian-core", filledBy: [], bodyExternal: false, diagnostics: [parseDiagnostic(sourcePath, error)] };
    }
  }
  let template: ExtractedTemplate;
  try { template = parseTemplate(sourcePath, bytes, { renderer: "templater" }); }
  catch (error: unknown) {
    return { renderer: "templater", filledBy: [], bodyExternal: true, diagnostics: [parseDiagnostic(sourcePath, error)] };
  }
  if (template.keyOrder.length > MAX_PROPOSAL_FIELDS) {
    return { renderer: "none", filledBy: [], bodyExternal: template.body.includes("<%") || template.body.includes("%>"), diagnostics: [{ code: "TEMPLATE_PROPOSAL_OVERSIZE", path: sourcePath }] };
  }
  const filledBy = template.keyOrder.filter(key => containsTemplater(template.frontmatter[key]));
  const bodyExternal = template.body.includes("<%") || template.body.includes("%>");
  const diagnostics: Diagnostic[] = [{ code: "TEMPLATE_RENDERER_EXTERNAL", path: sourcePath }];
  for (const field of filledBy) diagnostics.push({ code: "FIELD_FILLED_BY_OBSIDIAN", path: sourcePath, field });
  return { renderer: "templater", template, filledBy, bodyExternal, diagnostics };
}
