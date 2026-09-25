import { FIELD_TYPES } from "./obsidian.js";
import type { JsonScalar, Rule, VaultContract } from "./types.js";

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

function ruleValues(rule: Rule, values: JsonScalar[]): void {
  if (rule.kind === "allowed") values.push(...rule.values);
  else if (rule.kind === "fixed") values.push(rule.value);
  else if (rule.kind === "pattern") values.push(rule.regex);
  else {
    if (rule.min !== undefined) values.push(rule.min);
    if (rule.max !== undefined) values.push(rule.max);
  }
}

/** Every value a sealed rule holds: allowed and fixed values, range bounds and patterns. */
export function hiddenValuesOf(contract: VaultContract): JsonScalar[] {
  const values: JsonScalar[] = [];
  for (const property of Object.values(contract.properties ?? {})) {
    for (const rule of property.rules) ruleValues(rule, values);
  }
  for (const template of Object.values(contract.templates)) {
    for (const rules of Object.values(template.narrowedRules)) {
      for (const rule of rules) ruleValues(rule, values);
    }
  }
  return values;
}

/** Words the agent may already see; a hidden value equal to one is not worth hiding. */
export function publicTokensOf(contract: VaultContract | null): string[] {
  const tokens: string[] = [...FIELD_TYPES];
  if (contract === null) return tokens;
  tokens.push(...Object.keys(contract.folders ?? {}), ...Object.keys(contract.properties ?? {}));
  for (const [name, template] of Object.entries(contract.templates)) {
    tokens.push(name, ...template.requiredProperties, ...template.requiredHeadings);
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
