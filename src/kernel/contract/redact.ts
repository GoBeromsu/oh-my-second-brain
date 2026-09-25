import { FIELD_TYPES, type JsonScalar, type PublicManifest, type SealedLayer, type Violation, type ViolationKind } from "./types.js";

/**
 * Last line of defence for OMS-generated text: hidden values are replaced at token
 * boundaries in every common encoding. Tokens that are also public are left alone.
 */

export type Redactor = (text: string) => string;

export const REDACTED = "[redacted]";

function asciiEscape(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function variants(value: string): string[] {
  const forms = new Set<string>();
  for (const base of new Set([value, value.normalize("NFC"), value.normalize("NFD"), value.normalize("NFKC")])) {
    const quoted = JSON.stringify(base);
    forms.add(base);
    forms.add(quoted);
    forms.add(quoted.slice(1, -1));
    forms.add(asciiEscape(quoted.slice(1, -1)));
    forms.add(`'${base.replaceAll("'", "''")}'`);
  }
  return [...forms].filter(form => form !== "");
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function publicKey(text: string): string {
  return text.normalize("NFC").toLowerCase();
}

/** Only strings and numbers can leak; null, booleans and empty strings are skipped. */
export function buildRedactor(hidden: readonly JsonScalar[], options: { readonly publicTokens?: readonly string[] } = {}): Redactor {
  const publicSet = new Set((options.publicTokens ?? []).map(publicKey));
  const alternatives = new Set<string>();
  for (const value of hidden) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value);
    if (text.trim() === "") continue;
    for (const form of variants(text)) {
      if (!publicSet.has(publicKey(form))) alternatives.add(form);
    }
  }
  if (alternatives.size === 0) return text => text;
  const source = [...alternatives].sort((left, right) => right.length - left.length || (left < right ? -1 : 1)).map(escapeRegex).join("|");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`, "giu");
  return text => text.replace(pattern, REDACTED);
}

/** Every value a sealed rule holds: allowed and fixed values, range bounds and patterns. */
export function hiddenValuesOf(layers: readonly SealedLayer[]): JsonScalar[] {
  const values: JsonScalar[] = [];
  for (const layer of layers) {
    for (const field of layer.fields) {
      for (const rule of field.rules) {
        if (rule.kind === "allowed") values.push(...rule.values);
        else if (rule.kind === "fixed") values.push(rule.value);
        else if (rule.kind === "pattern") values.push(rule.regex);
        else {
          if (rule.min !== undefined) values.push(rule.min);
          if (rule.max !== undefined) values.push(rule.max);
        }
      }
    }
  }
  return values;
}

/** Words the agent may already see; a hidden value equal to one is not worth hiding. */
export function publicTokensOf(manifest: PublicManifest | null): string[] {
  const tokens: string[] = [...FIELD_TYPES];
  if (manifest === null) return tokens;
  for (const field of manifest.common?.fields ?? []) tokens.push(field.name);
  for (const template of manifest.templates) {
    tokens.push(template.id, template.name, ...template.fields.map(field => field.name), ...template.requiredHeadings);
  }
  return tokens;
}

/** Walks arrays and plain objects; only string leaves change. The input is not mutated. */
export function redactResponse<T>(value: T, redactor: Redactor): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return redactor(node);
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object" && node !== null && Object.getPrototypeOf(node) === Object.prototype) {
      return Object.fromEntries(Object.entries(node).map(([key, member]) => [key, walk(member)]));
    }
    return node;
  };
  return walk(value) as T;
}

const WORDING: Readonly<Record<ViolationKind, (field: string) => string>> = {
  "yaml-syntax": () => "Frontmatter is not valid YAML.",
  "path-unsafe": () => "The note path is not a safe vault-relative Markdown path.",
  "path-required": () => "This template has no apply folder; give a full note path.",
  "outside-vault": () => "The note path resolves outside the vault.",
  "outside-apply-folder": () => "The note path is outside the template's apply folder.",
  "required": field => `Field '${field}' is required.`,
  "type": field => `Field '${field}' has the wrong type.`,
  "not-allowed": field => `Field '${field}' is not one of the defined values.`,
  "not-fixed": field => `Field '${field}' does not have its defined value.`,
  "pattern": field => `Field '${field}' does not match its defined format.`,
  "range": field => `Field '${field}' is outside its defined range.`,
  "unsubstituted-variable": field => field === "" ? "The body still contains a template variable." : `Field '${field}' still contains a template variable.`,
  "heading-missing": field => `Required heading '${field}' is missing.`,
  "contract-unreadable": () => "The vault contract cannot be read; run the contract doctor.",
  "template-unknown": () => "No template with that name or id exists.",
  "template-ambiguous": () => "More than one template has that name; use its id.",
  "exists": () => "A note already exists at that path.",
};

/** Fixed wording built from the field name and the kind only. */
export function rejectionMessage(violation: Violation): string {
  return WORDING[violation.kind](violation.field ?? "");
}
