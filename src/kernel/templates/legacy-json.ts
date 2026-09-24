import { Lexer, parseDocument } from "yaml";

export type LegacyJsonMemberStatus = "unique" | "duplicate" | "uninspectable";

export interface LegacyJsonParse {
  readonly value: unknown;
  readonly members: LegacyJsonMemberStatus;
}

const MAX_UTF8_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_MEMBERS = 50_000;
const MAX_TOKENS = 100_000;

function withinBudget(value: unknown): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let members = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > MAX_DEPTH || ++members > MAX_MEMBERS) return false;
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) stack.push({ value: current.value[index], depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === "object") {
      const entries = Object.entries(current.value);
      for (let index = entries.length - 1; index >= 0; index -= 1) stack.push({ value: entries[index]![1], depth: current.depth + 1 });
    }
  }
  return true;
}

/**
 * JSON.parse owns values; YAML's JSON schema only checks raw member uniqueness.
 * Never replace the original text or parsed value with a reserialized document.
 */
export function parseLegacyJson(text: string): LegacyJsonParse {
  if (typeof text !== "string") throw new Error("LEGACY_JSON_INVALID: input must be a string");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error("LEGACY_JSON_INVALID: input must be JSON", { cause: error }); }
  if (Buffer.byteLength(text, "utf8") > MAX_UTF8_BYTES || !withinBudget(value)) return { value, members: "uninspectable" };
  try {
    // Parsed-value limits alone miss repeated raw keys erased by JSON.parse.
    let tokens = 0;
    for (const _token of new Lexer().lex(text)) {
      if (++tokens > MAX_TOKENS) return { value, members: "uninspectable" };
    }
    const document = parseDocument(text, { schema: "json", uniqueKeys: true, strict: true, prettyErrors: false });
    const diagnostics = [...document.errors, ...document.warnings];
    if (diagnostics.some(error => error.code === "DUPLICATE_KEY")) return { value, members: "duplicate" };
    return { value, members: diagnostics.length === 0 ? "unique" : "uninspectable" };
  } catch {
    return { value, members: "uninspectable" };
  }
}
