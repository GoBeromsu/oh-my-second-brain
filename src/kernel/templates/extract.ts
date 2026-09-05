import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isMap, isScalar, parseDocument } from "yaml";
import { parseObsidianTimeFormat, TemplateExpressionError } from "./obsidian-core-time.js";
import { normalizeTemplateSourcePath, verifyTemplateSourcePath } from "./paths.js";
import type { Digest, JsonValue, TemplateSourcePath } from "./types.js";

export type TemplateExpression =
  | { readonly kind: "title" }
  | { readonly kind: "date"; readonly format?: string }
  | { readonly kind: "time"; readonly format?: string };

export { TemplateExpressionError } from "./obsidian-core-time.js";

export interface ExtractedTemplate {
  readonly sourcePath: TemplateSourcePath;
  readonly sourceDigest: Digest;
  readonly bom: boolean;
  readonly eol: "lf" | "crlf";
  readonly finalNewline: boolean;
  readonly keyOrder: readonly string[];
  readonly frontmatter: Readonly<Record<string, JsonValue>>;
  readonly expressions: Readonly<Record<string, TemplateExpression>>;
  readonly body: string;
  readonly contentMarker: boolean;
}
export interface ParseTemplateOptions { readonly renderer?: "obsidian-core" | "templater"; }

const EXPRESSION: Readonly<Record<string, TemplateExpression>> = {
  "{{title}}": { kind: "title" },
  "{{date}}": { kind: "date" },
  "{{time}}": { kind: "time" },
};

function fail(path: string, field: string, expression: string): never {
  throw new TemplateExpressionError(path, field, expression);
}

function digest(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Digest;
}

function value(input: unknown, path: string, field: string): JsonValue {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input;
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (Array.isArray(input)) return input.map((item, index) => value(item, path, `${field}[${index}]`));
  if (typeof input === "object") {
    return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, member]) => [key, value(member, path, `${field}.${key}`)]));
  }
  throw new Error(`TEMPLATE_SOURCE_INVALID: ${path}:${field} is not a JSON-compatible YAML value`);
}

function expression(input: string, path: string, field: string): TemplateExpression | undefined {
  const templater = /<%[\s\S]*?%>/.exec(input)?.[0] ?? /<%|%>/.exec(input)?.[0];
  if (templater !== undefined) return fail(path, field, templater);
  if (!input.includes("{{")) return undefined;
  const supported = EXPRESSION[input];
  if (supported !== undefined) return supported;
  const token = /{{[\s\S]*?}}/.exec(input)?.[0] ?? input;
  const formatted = /^{{(date|time):(.+)}}$/.exec(input);
  if (formatted !== null) {
    try {
      parseObsidianTimeFormat(formatted[2]!);
    } catch {
      return fail(path, field, token);
    }
    return { kind: formatted[1] as "date" | "time", format: formatted[2]! };
  }
  return fail(path, field, token);
}

function validateExpressions(input: JsonValue, path: string, location: string): void {
  if (typeof input === "string") {
    expression(input, path, location);
    return;
  }
  if (Array.isArray(input)) {
    input.forEach((item, index) => validateExpressions(item, path, `${location}[${index}]`));
    return;
  }
  if (input !== null && typeof input === "object") {
    for (const [key, member] of Object.entries(input)) {
      validateExpressions(member, path, `${location}.${key}`);
    }
  }
}

/** YAML treats an unquoted {{...}} as a flow mapping. Template placeholders are
 * scalar syntax, so quote only a complete bare value for parsing and restore its
 * authored token immediately afterwards. */
function preprocessBareExpressions(yaml: string): { readonly yaml: string; readonly values: ReadonlyMap<string, string> } {
  const values = new Map<string, string>();
  let index = 0;
  const prepared = yaml.replace(/^(\s*(?:[^\r\n:#][^\r\n:]*):[\t ]*)(\{\{[^{}\r\n]*\}\})([\t ]*(?:#[^\r\n]*)?)(\r?)$/gm, (_line, prefix: string, token: string, suffix: string, carriageReturn: string) => {
    const marker = `__oms_template_expression_${index}__`;
    index += 1;
    values.set(marker, token);
    return `${prefix}${JSON.stringify(marker)}${suffix}${carriageReturn}`;
  });
  return { yaml: prepared, values };
}

/** Parses a template without normalizing authored bytes or YAML key order. */
export function parseTemplate(sourcePath: string, bytes: Uint8Array, options: ParseTemplateOptions = {}): ExtractedTemplate {
  const normalized = normalizeTemplateSourcePath(sourcePath);
  const raw = Buffer.from(bytes).toString("utf8");
  const bom = raw.startsWith("\ufeff");
  const content = bom ? raw.slice(1) : raw;
  const eol = content.includes("\r\n") ? "crlf" : "lf";
  const finalNewline = content.endsWith("\n");
  const open = /^(?:---)(?:\r?\n)/.exec(content);
  if (open === null) throw new Error(`TEMPLATE_SOURCE_INVALID: ${normalized} must begin with YAML frontmatter`);
  const close = /^(?:---)\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (close === null) throw new Error(`TEMPLATE_SOURCE_INVALID: ${normalized} has unclosed frontmatter`);
  const yaml = close[1] ?? "";
  const prepared = preprocessBareExpressions(yaml);
  const document = parseDocument(prepared.yaml, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0 || document.contents === null || !isMap(document.contents)) {
    throw new Error(`TEMPLATE_SOURCE_INVALID: ${normalized} frontmatter must be a valid YAML mapping${document.errors[0] === undefined ? "" : ` (${document.errors[0].message})`}`);
  }
  const keyOrder: string[] = [];
  const frontmatter: Record<string, JsonValue> = {};
  const expressions: Record<string, TemplateExpression> = {};
  for (const pair of document.contents.items) {
    const keyNode = pair.key;
    if (!isScalar(keyNode) || typeof keyNode.value !== "string" || keyNode.value === "") throw new Error(`TEMPLATE_SOURCE_INVALID: ${normalized} frontmatter key must be a non-empty string`);
    const key = keyNode.value;
    if (Object.hasOwn(frontmatter, key)) throw new Error(`TEMPLATE_SOURCE_INVALID: ${normalized} contains duplicate frontmatter key ${key}`);
    const parsed = value(pair.value?.toJSON(), normalized, key);
    const authored = typeof parsed === "string" ? prepared.values.get(parsed) ?? parsed : parsed;
    keyOrder.push(key);
    frontmatter[key] = authored;
    if (options.renderer !== "templater") validateExpressions(authored, normalized, key);
    if (options.renderer !== "templater" && typeof authored === "string") {
      const parsedExpression = expression(authored, normalized, key);
      if (parsedExpression !== undefined) expressions[key] = parsedExpression;
    }
  }
  const body = content.slice(close[0].length);
  const markers = body.match(/(?:^|\r?\n)<!-- oms:content -->(?=\r?\n|$)/g) ?? [];
  if (markers.length > 1) throw new Error(`TEMPLATE_SOURCE_INVALID: ${normalized} contains multiple oms content markers`);
  if (options.renderer !== "templater") {
    const matches = body.match(/{{[\s\S]*?}}/g) ?? [];
    for (const token of matches) expression(token, normalized, "body");
    const templater = /<%[\s\S]*?%>/.exec(body)?.[0] ?? /<%|%>/.exec(body)?.[0];
    if (templater !== undefined) fail(normalized, "body", templater);
  }
  return { sourcePath: normalized, sourceDigest: digest(bytes), bom, eol, finalNewline, keyOrder, frontmatter, expressions, body, contentMarker: markers.length === 1 };
}

/** Reads one already-registered template through the same path confinement used by resolution. */
export async function extractTemplate(vault: string, sourcePath: string): Promise<ExtractedTemplate> {
  const normalized = normalizeTemplateSourcePath(sourcePath);
  const verified = await verifyTemplateSourcePath(vault, normalized);
  return parseTemplate(normalized, await readFile(verified.absolutePath));
}
