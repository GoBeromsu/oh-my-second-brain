import { createHash } from "node:crypto";
/**
 * Test-only evaluator pinned to historical source, not to a future v5 decoder.
 *
 * v3 rules are copied from 46e8703e4c9f446a1d6eebaa7cd585b6adf0516f:
 * policy.parseTemplatePolicy/parseField, defaults.resolveDefaults/
 * validateBaseSpecialization, conventions/write-contract.evaluateResolvedTemplateContract,
 * and content-contract.evaluateTemplateBodyContract for the heading/order/fence cases used here.
 *
 * v4 structural rules are copied from 3294876f49463a42d38747f34d3f284951ff7538:
 * policy.parseTemplatePolicy/effectiveHeadingOrder and defaults.composeFields.
 * Note admission reuses the same historical required/type/allowed/url/heading checks.
 * contractDigest is not recomputed here; the corpus pins the independently framed values.
 */

export const V3_PROVENANCE = {
  commit: "46e8703e4c9f446a1d6eebaa7cd585b6adf0516f",
  paths: [
    "src/kernel/templates/policy.ts",
    "src/kernel/templates/defaults.ts",
    "src/kernel/templates/content-contract.ts",
    "src/kernel/templates/resolver.ts",
    "src/kernel/conventions/write-contract.ts",
  ],
} as const;

export const V4_PROVENANCE = {
  commit: "3294876f49463a42d38747f34d3f284951ff7538",
  paths: [
    "src/kernel/templates/policy.ts",
    "src/kernel/templates/defaults.ts",
    "src/kernel/templates/types.ts",
    "src/kernel/templates/content-contract.ts",
    "src/kernel/conventions/write-contract.ts",
  ],
} as const;

export interface LegacyViolation {
  readonly field: string;
  readonly rule: "required" | "type" | "allowed-values" | "format" | "writer-identity" | "heading";
  readonly message: string;
}

export interface LegacyAdmission {
  readonly valid: boolean;
  readonly violations: readonly LegacyViolation[];
  readonly normalized?: Readonly<Record<string, unknown>>;
  readonly preservedBody?: string;
}

export type LegacyDisposition =
  | {
      readonly disposition: "evaluated";
      readonly version: 3 | 4;
      readonly fields: Readonly<Record<string, unknown>>;
      readonly headings: readonly Readonly<Record<string, unknown>>;
      readonly headingOrder?: "unordered" | "strict";
      readonly extras: Readonly<Record<string, unknown>>;
    }
  | {
      readonly disposition: "review-required";
      readonly code: string;
      readonly message: string;
    };

const STRING_TYPES = new Set(["text", "string", "select", "file"]);
const LIST_TYPES = new Set(["list", "multitext", "multi", "tags", "aliases"]);

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`TEMPLATE_POLICY_INVALID: ${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function empty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function v3Compatible(type: string | undefined, value: unknown): boolean {
  if (type === undefined) return true;
  if (STRING_TYPES.has(type)) return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean" || type === "checkbox") return typeof value === "boolean";
  if (type === "date") return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (type === "datetime") return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
  return LIST_TYPES.has(type) && Array.isArray(value) && (type === "list" || type === "multi" || value.every(item => typeof item === "string"));
}

function normalize(value: unknown, policy: Record<string, unknown>): unknown {
  if (typeof policy.normalize !== "string" || typeof value !== "string") return value;
  if (policy.normalize === "trim") return value.trim();
  if (policy.normalize === "lower") return value.toLowerCase();
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}
const DYNAMIC_TOKEN = /{{(?:title|date(?::[^{}]*)?|time(?::[^{}]*)?)}}/g;

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function sourceLines(body: string): { readonly text: string; readonly start: number; readonly end: number; readonly number: number }[] {
  const lines: { text: string; start: number; end: number; number: number }[] = [];
  let start = 0;
  let number = 1;
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;
    const separatorLength = code === 13 && body.charCodeAt(index + 1) === 10 ? 2 : 1;
    lines.push({ text: body.slice(start, index), start, end: index, number });
    number += 1;
    index += separatorLength - 1;
    start = index + 1;
  }
  if (start < body.length || lines.length === 0) lines.push({ text: body.slice(start), start, end: body.length, number });
  return lines;
}

function dynamicHeadingPattern(source: string): RegExp {
  let pattern = "^";
  let last = 0;
  for (const match of source.matchAll(DYNAMIC_TOKEN)) {
    pattern += source.slice(last, match.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern += "[\\s\\S]+?";
    last = (match.index ?? 0) + match[0].length;
  }
  pattern += source.slice(last).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${pattern}$`);
}

function scanV3Nodes(input: string): { readonly kind: string; readonly level?: number; readonly text?: string; readonly closed?: boolean }[] {
  const body = input.startsWith("\uFEFF") ? input.slice(1) : input;
  const lines = sourceLines(body);
  const nodes: { kind: string; level?: number; text?: string; closed?: boolean }[] = [];
  let fence: { readonly char: string; readonly length: number } | undefined;
  for (const line of lines) {
    if (fence !== undefined) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line.text);
      if (closing !== null && closing[1]?.[0] === fence.char && closing[1].length >= fence.length) {
        nodes.push({ kind: "fenced-code", closed: true });
        fence = undefined;
      }
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (opening !== null && !(opening[1]?.[0] === "`" && (opening[2] ?? "").includes("`"))) {
      fence = { char: opening[1]?.[0] ?? "`", length: opening[1]?.length ?? 3 };
      continue;
    }
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line.text);
    if (heading !== null) {
      nodes.push({ kind: "heading", level: heading[1]?.length, text: (heading[2] ?? "").trim().replace(/[ \t]+#+[ \t]*$/, "").trim() });
    }
  }
  if (fence !== undefined) nodes.push({ kind: "fenced-code", closed: false });
  return nodes;
}

function evaluateV3Body(body: string, content: Record<string, unknown>, mode: string): readonly LegacyViolation[] {
  const nodes = Array.isArray(content.nodes) ? content.nodes : [];
  const scanned = scanV3Nodes(body);
  const violations: LegacyViolation[] = [];
  if (scanned.some(node => node.kind === "fenced-code" && node.closed === false)) {
    violations.push({ field: "body:fence", rule: "format", message: "Fenced code has no valid closing fence." });
  }
  if (mode === "append" || violations.length > 0) return violations;
  const matches: { readonly index: number; readonly subject: string }[] = [];
  const consumed = new Set<number>();
  for (const raw of nodes) {
    const wanted = record(raw, "content node");
    if (wanted.kind === "placeholder" || wanted.required !== true) continue;
    let found = -1;
    for (let index = 0; index < scanned.length; index += 1) {
      const candidate = scanned[index];
      if (candidate === undefined || consumed.has(index) || candidate.kind !== wanted.kind) continue;
      const matchesHeading = wanted.kind === "heading" && candidate.level === wanted.level && dynamicHeadingPattern(String(wanted.text)).test(candidate.text ?? "");
      if (!matchesHeading) continue;
      found = index;
      break;
    }
    const subject = `${String(wanted.kind)}:${String(wanted.level)}:${String(wanted.text)}`;
    if (found < 0) violations.push({ field: `body:${subject}`, rule: "required", message: `Required ${subject} is missing from the body.` });
    else {
      consumed.add(found);
      matches.push({ index: found, subject });
    }
  }
  if (content.order === "strict") {
    for (let index = 1; index < matches.length; index += 1) {
      const previous = matches[index - 1];
      const current = matches[index];
      if (previous !== undefined && current !== undefined && current.index < previous.index) {
        violations.push({ field: "body:document-order", rule: "format", message: `Required body sections are out of order: ${previous.subject} must precede ${current.subject}.` });
        break;
      }
    }
  }
  return violations;
}

function mergeV3Fields(base: Record<string, unknown>, contract: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const baseFields = record(base.fields, "base.fields");
  const contractFields = record(contract.fields, "contract.fields");
  for (const [field, rawBase] of Object.entries(baseFields)) {
    const raw = contractFields[field];
    if (raw === undefined) continue;
    const basePolicy = record(rawBase, field);
    const policy = record(raw, field);
    if (basePolicy.required === true && policy.required === false) fail("BASE_CONTRACT_CONFLICT", `${field} weakens required`);
    if (basePolicy.immutable === true && policy.immutable === false) fail("BASE_CONTRACT_CONFLICT", `${field} weakens immutable`);
    if (basePolicy.type !== undefined && policy.type !== undefined && basePolicy.type !== policy.type) fail("BASE_CONTRACT_CONFLICT", `${field} changes type`);
    const baseAllowed = basePolicy.allowedValues;
    const nextAllowed = policy.allowedValues;
    if (Array.isArray(baseAllowed) && Array.isArray(nextAllowed) && nextAllowed.some(value => !baseAllowed.includes(value))) {
      fail("BASE_CONTRACT_CONFLICT", `${field} widens allowed values`);
    }
  }
  const merged: Record<string, Record<string, unknown>> = {};
  for (const [field, raw] of Object.entries({ ...baseFields, ...contractFields })) merged[field] = record(raw, field);
  for (const [field, raw] of Object.entries(baseFields)) {
    merged[field] = { ...record(raw, field), ...(contractFields[field] === undefined ? {} : record(contractFields[field], field)) };
  }
  return merged;
}

function review(code: string, message: string): LegacyDisposition {
  return { disposition: "review-required", code, message };
}

export function evaluateV3Policy(policy: unknown): LegacyDisposition {
  const root = record(policy, "policy");
  if (root.version !== 3 || Object.hasOwn(root, "templateFolder")) {
    return review("TEMPLATE_POLICY_VERSION_UNSUPPORTED", "only policy version 3 with templateFolders is supported");
  }
  try {
    const folders = root.templateFolders;
    if (!Array.isArray(folders)) fail("TEMPLATE_POLICY_INVALID", "policy.templateFolders must be an array");
    for (const folder of folders) {
      const path = record(folder, "templateFolder").path;
      if (typeof path !== "string" || path.includes("..") || path.startsWith("/") || path.includes("\0")) {
        fail("TEMPLATE_SOURCE_UNSAFE", "template folder is unsafe");
      }
    }
    const contracts = record(root.contracts, "policy.contracts");
    const templates = record(root.templates, "policy.templates");
    const evaluated: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(contracts)) {
      const contract = record(raw, name);
      if (Object.keys(contract).some(key => !["intent", "fields", "views", "extensions"].includes(key))) {
        return review("TEMPLATE_EXTENSION_CONFLICT", `${name} contains metadata outside the proven v3 contract shape`);
      }
      evaluated[name] = mergeV3Fields(record(root.base, "policy.base"), contract);
    }
    for (const [key, raw] of Object.entries(templates)) {
      const binding = record(raw, key);
      const sourcePath = binding.sourcePath;
      if (typeof sourcePath === "string" && (sourcePath.includes("..") || sourcePath.includes("\0") || sourcePath.startsWith("/"))) {
        return review("TEMPLATE_SOURCE_UNSAFE", `${sourcePath} is not a vault-relative source path`);
      }
      if (!Object.hasOwn(contracts, String(binding.contract))) {
        return review("TEMPLATE_POLICY_INVALID", `${key} references an unknown contract`);
      }
    }
    return {
      disposition: "evaluated",
      version: 3,
      fields: evaluated,
      headings: [],
      extras: {
        writers: root.writers ?? null,
        defaultTemplate: root.defaultTemplate ?? null,
        templateCount: Object.keys(templates).length,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.split(":")[0] ?? "TEMPLATE_POLICY_INVALID";
    return review(code, message);
  }
}

export function admitV3Note(
  policy: unknown,
  contractName: string,
  frontmatter: Readonly<Record<string, unknown>>,
  body: string | undefined,
  mode: "create" | "update" | "append" = "update",
): LegacyAdmission {
  const evaluated = evaluateV3Policy(policy);
  if (evaluated.disposition !== "evaluated") throw new Error(evaluated.message);
  const fields = record(evaluated.fields[contractName], contractName);
  const violations: LegacyViolation[] = [];
  const normalized: Record<string, unknown> = {};
  for (const [field, raw] of Object.entries(fields)) {
    const rule = record(raw, field);
    const value = frontmatter[field];
    if (mode === "create") {
      if (empty(value)) {
        if (rule.required === true) violations.push({ field, rule: "required", message: `Field "${field}" is required.` });
        continue;
      }
      const next = normalize(value, rule);
      if (!v3Compatible(typeof rule.type === "string" ? rule.type : undefined, next)) {
        violations.push({ field, rule: "type", message: `Field "${field}" must be ${String(rule.type)}.` });
        continue;
      }
      if (Array.isArray(rule.allowedValues) && (typeof next !== "string" || !rule.allowedValues.includes(next))) {
        violations.push({ field, rule: "allowed-values", message: `Field "${field}" is not an allowed value.` });
      }
      normalized[field] = next;
      continue;
    }
    if (rule.required === true && empty(value)) {
      violations.push({ field, rule: "required", message: `Field "${field}" is required.` });
      continue;
    }
    if (value === undefined || value === null) continue;
    if (!v3Compatible(typeof rule.type === "string" ? rule.type : undefined, value)) {
      violations.push({ field, rule: "type", message: `Field "${field}" must be ${String(rule.type)}.` });
      continue;
    }
    if (Array.isArray(rule.allowedValues) && (typeof value !== "string" || !rule.allowedValues.includes(value))) {
      violations.push({ field, rule: "allowed-values", message: `Field "${field}" is not an allowed value.` });
    }
    if (rule.format === "url" && (typeof value !== "string" || !validUrl(value))) {
      violations.push({ field, rule: "format", message: `Field "${field}" must be an http(s) URL.` });
    }
  }
  for (const [field, value] of Object.entries(frontmatter)) if (!Object.hasOwn(fields, field) && field !== "created_by") normalized[field] = value;
  const root = record(policy, "policy");
  if (mode !== "create" && root.writers !== undefined) {
    const writers = record(root.writers, "writers");
    const field = String(writers.field);
    const value = frontmatter[field];
    const identifiers = writers.identifiers;
    if (empty(value)) violations.push({ field, rule: "writer-identity", message: `Writer field "${field}" is required.` });
    else if (typeof value !== "string" || !Array.isArray(identifiers) || !identifiers.includes(value)) {
      violations.push({ field, rule: "writer-identity", message: `Value "${String(value)}" for writer field "${field}" is not a registered writer identifier.` });
    }
  }
  if (body !== undefined) {
    const templates = record(root.templates, "templates");
    const binding = Object.values(templates).map(value => record(value, "template")).find(value => value.contract === contractName);
    if (binding?.content !== undefined) violations.push(...evaluateV3Body(body, record(binding.content, "content"), mode));
  }
  return { valid: violations.length === 0, violations, normalized, preservedBody: body };
}

function composeV4(policy: unknown, templateId: string | null, options: { readonly allowReviewBoundaries?: boolean } = {}): LegacyDisposition {
  const root = record(policy, "policy");
  if (root.version !== 4) return review("TEMPLATE_POLICY_VERSION_UNSUPPORTED", `version ${JSON.stringify(root.version)} is unsupported. Automatic migration is not available.`);
  for (const key of ["templateFolder", "templateFolders", "defaultTemplate", "base", "contracts", "writers"]) {
    if (Object.hasOwn(root, key)) return review("TEMPLATE_POLICY_VERSION_UNSUPPORTED", `policy.${key} is a version 3 authoring field and is not part of version 4`);
  }
  const unknown = Object.keys(root).filter(key => !["version", "properties", "default", "templates", "completion"].includes(key));
  if (unknown.length > 0) return review("unknown-metadata", `policy.${unknown.join(",")} has no proven version 4 mapping`);
  const properties = record(root.properties, "properties");
  const base = record(root.default, "default");
  const templates = record(root.templates, "templates");
  const selected = templateId === null ? undefined : templates[templateId];
  if (templateId !== null && selected === undefined) return review("TEMPLATE_POLICY_INVALID", `template ${templateId} is not registered`);
  const layer = selected === undefined ? undefined : record(selected, String(templateId));
  for (const [where, candidate] of [["policy.default", base], [`policy.templates.${String(templateId)}`, layer]] as const) {
    if (candidate === undefined || typeof candidate.approvedMarkdown !== "string") continue;
    const declared = candidate.approvedMarkdownDigest;
    if (typeof declared !== "string" || !/^sha256:[0-9a-f]{64}$/.test(declared) || sha256Text(candidate.approvedMarkdown) !== declared) {
      return review("CONTRACT_UNVERIFIABLE", `${where}.approvedMarkdownDigest does not match the exact approved markdown bytes`);
    }
  }
  const baseOrder = base.headingOrder === "strict" ? "strict" : "unordered";
  if (baseOrder === "strict" && layer?.headingOrder === "unordered") {
    return review("CONTRACT_COMPOSITION_CONFLICT", `template ${String(templateId)} cannot weaken headingOrder from strict to unordered`);
  }
  if (options.allowReviewBoundaries === true) {
    if (layer?.source !== undefined) {
      const source = record(layer.source, "source");
      return review("missing-source-bytes", `${String(source.path)} is named by ${String(source.rawDigest)} but its bytes are not in the corpus`);
    }
    const criteria = base.semanticCriteria;
    if (Array.isArray(criteria) && criteria.length > 0) return review("semantic-review-required", "semantic criteria require separate review and have no machine-equivalent mapping");
  }
  const baseFields = record(base.fields ?? {}, "default.fields");
  const extraFields = layer?.fields === undefined ? {} : record(layer.fields, "template.fields");
  const fields: Record<string, unknown> = {};
  for (const name of [...Object.keys(baseFields), ...Object.keys(extraFields).filter(name => !Object.hasOwn(baseFields, name))]) {
    if (properties[name] === undefined) return review("TEMPLATE_POLICY_DANGLING_FIELD", `${name} is not in the property pool`);
    const definition = record(properties[name], name);
    const parent = baseFields[name] === undefined ? undefined : record(baseFields[name], name);
    const child = extraFields[name] === undefined ? undefined : record(extraFields[name], name);
    const allowedValues = child?.allowedValues ?? parent?.allowedValues ?? definition.allowedValues;
    fields[name] = {
      property: name,
      type: definition.type,
      intent: definition.intent,
      required: parent?.required === true || child?.required === true,
      ...(allowedValues === undefined ? {} : { allowedValues }),
      ...(definition.format === undefined ? {} : { format: definition.format }),
    };
  }
  const headings = [
    ...(Array.isArray(base.headings) ? base.headings.map(heading => ({ ...record(heading, "heading"), origin: "default" })) : []),
    ...(layer !== undefined && Array.isArray(layer.headings) ? layer.headings.map(heading => ({ ...record(heading, "heading"), origin: "template" })) : []),
  ];
  const headingOrder = layer?.headingOrder === "strict" || layer?.headingOrder === "unordered" ? layer.headingOrder : baseOrder;
  return {
    disposition: "evaluated",
    version: 4,
    fields,
    headings,
    headingOrder,
    extras: {
      completionExcludedFromContractDigest: root.completion !== undefined,
      sourcePreservedNotConverted: layer?.source ?? null,
      semanticCriteriaPreservedNotConverted: base.semanticCriteria ?? [],
    },
  };
}

export function evaluateV4Policy(policy: unknown, templateId: string | null = null): LegacyDisposition {
  try {
    return composeV4(policy, templateId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return review(message.split(":")[0] ?? "TEMPLATE_POLICY_INVALID", message);
  }
}
export function classifyV4Boundary(policy: unknown, templateId: string | null = null): LegacyDisposition {
  return composeV4(policy, templateId, { allowReviewBoundaries: true });
}

function headingObserved(body: string, title: string, level: number): "match" | "level" | "missing" {
  const source = body.startsWith("\uFEFF") ? body.slice(1) : body;
  const lines = source.split(/\r\n|\n|\r/);
  let fence = false;
  let wrong = false;
  for (const line of lines) {
    if (fence) {
      if (/^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(line)) fence = false;
      continue;
    }
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      fence = true;
      continue;
    }
    const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (match === null) continue;
    const text = (match[2] ?? "").trim().replace(/[ \t]+#+[ \t]*$/, "").trim();
    if (text !== title) continue;
    if (match[1]?.length === level) return "match";
    wrong = true;
  }
  return wrong ? "level" : "missing";
}

export function admitV4Note(
  policy: unknown,
  templateId: string | null,
  frontmatter: Readonly<Record<string, unknown>>,
  body: string,
): LegacyAdmission {
  const evaluated = evaluateV4Policy(policy, templateId);
  if (evaluated.disposition !== "evaluated") throw new Error(evaluated.message);
  const violations: LegacyViolation[] = [];
  for (const [field, raw] of Object.entries(evaluated.fields)) {
    const rule = record(raw, field);
    const value = Object.hasOwn(frontmatter, field) ? frontmatter[field] : undefined;
    if (rule.required === true && empty(value)) {
      violations.push({ field, rule: "required", message: `Field "${field}" is required.` });
      continue;
    }
    if (value === undefined || value === null) continue;
    const type = String(rule.type);
    const listLike = ["list", "multitext", "multi", "tags", "aliases"].includes(type);
    const matches = type === "date"
      ? typeof value === "string" && validDate(value)
      : listLike
        ? Array.isArray(value) && (type === "list" || type === "multi" || value.every(item => typeof item === "string"))
        : v3Compatible(type, value);
    if (!matches) {
      violations.push({ field, rule: "type", message: `Field "${field}" must be ${type}.` });
      continue;
    }
    if (Array.isArray(rule.allowedValues)) {
      const values = Array.isArray(value) ? value : [value];
      if (!values.every(member => typeof member === "string" && rule.allowedValues?.includes(member))) {
        violations.push({ field, rule: "allowed-values", message: `Field "${field}" contains a value outside the approved set.` });
      }
    }
    if (rule.format === "url" && (typeof value !== "string" || !validUrl(value))) {
      violations.push({ field, rule: "format", message: `Field "${field}" must be an http(s) URL.` });
    }
  }
  const positions: number[] = [];
  const source = body.startsWith("\uFEFF") ? body.slice(1) : body;
  const lines = source.split(/\r\n|\n|\r/);
  for (const heading of evaluated.headings) {
    const title = String(heading.title);
    const level = Number(heading.level);
    const state = headingObserved(body, title, level);
    if (state !== "match") {
      violations.push({ field: `body:${String(heading.headingId)}`, rule: "heading", message: `Required heading ${String(heading.headingId)} (${title}) is ${state}.` });
      positions.push(-1);
      continue;
    }
    positions.push(lines.findIndex(line => line.includes(title)));
  }
  if (evaluated.headingOrder === "strict") {
    let previous = -1;
    for (const position of positions) {
      if (position < 0) continue;
      if (previous >= 0 && position < previous) {
        violations.push({ field: "body:order", rule: "heading", message: "Heading order is strict and the observed order is reversed." });
        break;
      }
      previous = position;
    }
  }
  return { valid: violations.length === 0, violations, preservedBody: body };
}
