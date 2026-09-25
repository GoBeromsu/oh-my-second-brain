import { parseNote } from "../conventions/frontmatter.js";
import { compareCodePoints } from "../conventions/canonical.js";
import { scanContractHeadings, scanTemplateSources, type CensusDiagnostic } from "./scan.js";
import type { Digest, FieldType, JsonScalar, VariableKind } from "./types.js";

/**
 * Read-only template extraction for the interview. Templater is never run and
 * nothing is created: the source is read once through the bounded census reader.
 */

export interface ExtractedField {
  readonly name: string;
  readonly inferredType: FieldType;
  /** The literal value in the template, or null when it is a variable or empty. */
  readonly literal: JsonScalar | readonly JsonScalar[] | null;
  readonly variable: VariableKind | null;
}

export interface ExtractedHeading {
  readonly title: string;
  readonly level: number;
  /** True when the heading text contains a template variable. */
  readonly variable: boolean;
}

export interface Extraction {
  readonly fields: readonly ExtractedField[];
  readonly headings: readonly ExtractedHeading[];
  readonly sourceHash: Digest;
}

export interface ExtractionDiagnostic {
  readonly code: string;
  readonly message: string;
}

export type ExtractionResult =
  | { readonly ok: true; readonly extraction: Extraction }
  | { readonly ok: false; readonly diagnostics: readonly ExtractionDiagnostic[] };

const VARIABLE = /\{\{[\s\S]*?\}\}|<%[\s\S]*?%>/g;
const PLACEHOLDER = /__oms_variable_(\d+)__/g;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** `{{date}}` and `{{title}}` are core Templates variables; everything else is free-form. */
export function classifyVariable(token: string): VariableKind {
  if (token.startsWith("<%")) return "free";
  const inner = token.slice(2, -2).trim();
  if (/^title$/i.test(inner)) return "title";
  const date = /^date(?::(.*))?$/i.exec(inner);
  if (date === null) return "free";
  const format = date[1] ?? "";
  return /[Hhms]/.test(format) ? "datetime" : "date";
}

function isScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
}

function inferType(name: string, value: unknown, variable: VariableKind | null): FieldType {
  if (name === "tags") return "tags";
  if (name === "aliases") return "aliases";
  if (variable === "date") return "date";
  if (variable === "datetime") return "datetime";
  if (variable !== null) return "text";
  if (Array.isArray(value)) return value.every(member => typeof member === "string") ? "multitext" : "list";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (typeof value === "string" && DATE.test(value)) return "date";
  if (typeof value === "string" && DATETIME.test(value)) return "datetime";
  return "text";
}

export async function extractTemplate(vault: string, sourcePath: string): Promise<ExtractionResult> {
  let inventory;
  try {
    inventory = await scanTemplateSources(vault, [{ path: sourcePath, kind: "file" }]);
  } catch (error: unknown) {
    return { ok: false, diagnostics: [{ code: "TEMPLATE_SOURCE_READ_FAILED", message: error instanceof Error ? error.message : String(error) }] };
  }
  const source = inventory.sources[0];
  const reported = [...inventory.diagnostics, ...(source?.diagnostics ?? [])];
  if (!inventory.complete || source === undefined || reported.length > 0) {
    const diagnostics = reported.map((item: CensusDiagnostic) => ({ code: item.code, message: item.message }));
    return { ok: false, diagnostics: diagnostics.length > 0 ? diagnostics : [{ code: "TEMPLATE_SOURCE_MISSING", message: "Template source is absent" }] };
  }
  if (source.text === null) return { ok: false, diagnostics: [{ code: "TEMPLATE_SOURCE_MALFORMED", message: "Template source is not valid UTF-8" }] };

  const tokens: string[] = [];
  const substituted = source.text.replace(VARIABLE, token => `__oms_variable_${tokens.push(token) - 1}__`);
  const parsed = parseNote(substituted);
  if (parsed.diagnostics.length > 0) {
    return { ok: false, diagnostics: parsed.diagnostics.map(item => ({ code: item.code, message: item.message })) };
  }

  const fields: ExtractedField[] = [];
  for (const name of Object.keys(parsed.frontmatter).sort(compareCodePoints)) {
    const value = parsed.frontmatter[name];
    const text = typeof value === "string" ? value : Array.isArray(value) ? value.filter(member => typeof member === "string").join(" ") : "";
    const found = [...text.matchAll(PLACEHOLDER)].map(match => tokens[Number(match[1])] ?? "");
    let variable: VariableKind | null = null;
    if (found.length > 0) {
      const whole = typeof value === "string" && /^__oms_variable_\d+__$/.test(value.trim());
      variable = whole ? classifyVariable(found[0]!) : "free";
    }
    const literal = variable !== null || value === undefined
      ? null
      : Array.isArray(value)
        ? value.every(isScalar) ? value as JsonScalar[] : null
        : isScalar(value) ? value : null;
    fields.push({ name, inferredType: inferType(name, value, variable), literal, variable });
  }

  let observed;
  try {
    observed = scanContractHeadings(parsed.body, true);
  } catch (error: unknown) {
    return { ok: false, diagnostics: [{ code: "TEMPLATE_PROPOSAL_OVERSIZE", message: error instanceof Error ? error.message : String(error) }] };
  }
  const headings = observed.map(heading => {
    const variable = PLACEHOLDER.test(heading.title);
    PLACEHOLDER.lastIndex = 0;
    const title = heading.title.replace(PLACEHOLDER, (_match, index: string) => tokens[Number(index)] ?? "");
    return { title, level: heading.level, variable };
  });
  return { ok: true, extraction: { fields, headings, sourceHash: source.rawDigest } };
}
