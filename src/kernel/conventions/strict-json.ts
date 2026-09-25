import { parseDocument } from "yaml";

const MAX_STRICT_JSON_BYTES = 1_048_576;

export class StrictJsonError extends Error {
  constructor(message: string) {
    super(`STRICT_JSON_INVALID: ${message}`);
    this.name = "StrictJsonError";
  }
}

/** JSON.parse owns values; the YAML JSON-schema pass only proves that raw members are unique. */
export function parseStrictJson(text: string, maxBytes: number = MAX_STRICT_JSON_BYTES): unknown {
  if (typeof text !== "string") throw new StrictJsonError("input must be a string");
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new StrictJsonError("input exceeds the size limit");
  if (text.charCodeAt(0) === 0xfeff) throw new StrictJsonError("byte order mark is not allowed");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new StrictJsonError("input must be JSON"); }
  let codes: string[];
  try {
    const document = parseDocument(text, { schema: "json", uniqueKeys: true, strict: true, prettyErrors: false });
    codes = [...document.errors, ...document.warnings].map(error => error.code);
  } catch { throw new StrictJsonError("members could not be inspected"); }
  if (codes.includes("DUPLICATE_KEY")) throw new StrictJsonError("duplicate members are not allowed");
  if (codes.length > 0) throw new StrictJsonError("members could not be inspected");
  return value;
}
