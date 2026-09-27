import { compareCodePoints } from "../conventions/canonical.js";
import { parseNote } from "../conventions/frontmatter.js";
import { enumerateTemplateSources, type TemplateInterpretation } from "./interpretation.js";
import { scanContractHeadings, scanTemplateSources } from "./scan.js";
import type { FieldType, JsonScalar, VariableKind } from "./types.js";

/**
 * Plays the agent for tests: reads the template sources OMS enumerated and submits an
 * interpretation of each one.
 *
 * This is deliberately a fixture and not kernel code. Reading template text is exactly
 * what OMS no longer does — the reading is the agent's job, so the only thing that may
 * still parse a template in this repository is something standing in for an agent. Its
 * shortcuts (frontmatter only, Templater treated as an opaque variable) are an agent's
 * business, not a contract rule.
 */

const VARIABLE = /\{\{[\s\S]*?\}\}|<%[\s\S]*?%>/g;
/**
 * A fixture-local token, not a contract sentinel: the kernel derives nothing from it and
 * never sees it. It is a plain YAML scalar so that substituting it where a value belongs
 * leaves the document parseable; a variable in a structural position (a key's colon, or
 * column zero inside a block mapping) is not parseable under any token, which is why a
 * template like that needs a hand-written interpretation instead of this shortcut.
 */
const TOKEN = (index: number): string => `omsFixtureVar${index}`;
const PLACEHOLDER = /omsFixtureVar(\d+)/g;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function classifyVariable(token: string): VariableKind {
  if (token.startsWith("<%")) return "free";
  const inner = token.slice(2, -2).trim();
  if (/^title$/i.test(inner)) return "title";
  const date = /^date(?::(.*))?$/i.exec(inner);
  if (date === null) return "free";
  return /[Hhms]/.test(date[1] ?? "") ? "datetime" : "date";
}

function isScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
}

function inferType(name: string, value: unknown, variable: VariableKind | null): FieldType {
  if (name === "tags") return "tags";
  if (name === "aliases") return "aliases";
  if (variable === "date" || variable === "datetime") return variable;
  if (variable !== null) return "text";
  if (Array.isArray(value)) return value.every(member => typeof member === "string") ? "multitext" : "list";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (typeof value === "string" && DATE.test(value)) return "date";
  if (typeof value === "string" && DATETIME.test(value)) return "datetime";
  return "text";
}

/** One source's interpretation, as an agent that had read the bytes would submit it. */
export async function interpretSource(vault: string, sourcePath: string): Promise<TemplateInterpretation> {
  const inventory = await scanTemplateSources(vault, [{ path: sourcePath, kind: "file" }]);
  const source = inventory.sources[0];
  if (source === undefined || source.text === null) throw new Error(`fixture cannot read ${sourcePath}`);

  const tokens: string[] = [];
  const parsed = parseNote(source.text.replace(VARIABLE, token => TOKEN(tokens.push(token) - 1)));
  const fields = Object.keys(parsed.frontmatter).sort(compareCodePoints).map(name => {
    const value = parsed.frontmatter[name];
    const text = typeof value === "string" ? value : Array.isArray(value) ? value.filter(member => typeof member === "string").join(" ") : "";
    const found = [...text.matchAll(PLACEHOLDER)].map(match => tokens[Number(match[1])] ?? "");
    const whole = typeof value === "string" && /^omsFixtureVar\d+$/.test(value.trim());
    const variable = found.length === 0 ? null : whole ? classifyVariable(found[0]!) : "free";
    const literal = variable !== null || value === undefined
      ? null
      : Array.isArray(value)
        ? value.every(isScalar) ? value as JsonScalar[] : null
        : isScalar(value) ? value : null;
    return { name, inferredType: inferType(name, value, variable), literal, variable };
  });
  const headings = scanContractHeadings(parsed.body, true).map(heading => {
    const variable = PLACEHOLDER.test(heading.title);
    PLACEHOLDER.lastIndex = 0;
    return { title: heading.title.replace(PLACEHOLDER, (_match, index: string) => tokens[Number(index)] ?? ""), level: heading.level, variable };
  });
  return { source: String(source.path), observedHash: source.rawDigest, fields, headings };
}

/** Every template source in the folder, interpreted. An absent folder interprets nothing. */
export async function interpretVault(vault: string, templateFolder = "Templates"): Promise<readonly TemplateInterpretation[]> {
  const enumerated = await enumerateTemplateSources(vault, { path: templateFolder, kind: "folder" });
  if (!enumerated.ok) return [];
  return Promise.all(enumerated.sources.map(source => interpretSource(vault, source.path)));
}
