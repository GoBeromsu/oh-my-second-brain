import { createHash } from "node:crypto";

export type Digest = `sha256:${string}`;

const encoder = new TextEncoder();
const DIGEST = /^sha256:[0-9a-f]{64}$/;
type Canonical = null | boolean | number | string | readonly Canonical[] | { readonly [key: string]: Canonical };

function scalar(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError("String contains an unpaired surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("String contains an unpaired surrogate");
    }
  }
  return value.normalize("NFC");
}

export function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0)!);
  const b = Array.from(right, character => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function quote(value: string): string {
  let output = '"';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === '"') output += '\\"';
    else if (character === "\\") output += "\\\\";
    else if (code <= 0x1f) output += `\\u${code.toString(16).padStart(4, "0")}`;
    else output += character;
  }
  return `${output}"`;
}

function normalize(value: unknown): Canonical {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return scalar(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError("Canonical JSON permits only safe integers other than -0");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("Canonical JSON value is unsupported");
  }
  const result: Record<string, Canonical> = Object.create(null);
  for (const [key, member] of Object.entries(value)) {
    const normalizedKey = scalar(key);
    if (Object.hasOwn(result, normalizedKey)) throw new TypeError("Object keys collide after NFC normalization");
    result[normalizedKey] = normalize(member);
  }
  return result;
}

function serialize(value: Canonical): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return quote(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  const object = value as { readonly [key: string]: Canonical };
  return `{${Object.keys(object).sort(compareCodePoints).map(key => `${quote(key)}:${serialize(object[key]!)}`).join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return serialize(normalize(value));
}

export function parseDigest(value: string): Digest {
  if (!DIGEST.test(value)) throw new TypeError("Digest must be lowercase sha256:<64hex>");
  return value as Digest;
}

function frameHash(domain: string, value: unknown): Uint8Array {
  const domainBytes = encoder.encode(scalar(domain));
  const valueBytes = encoder.encode(canonicalJson(value));
  const prefix = encoder.encode("oms-hash-frame-v1\0");
  const length = (bytes: Uint8Array): Uint8Array => encoder.encode(`${bytes.byteLength}\0`);
  const parts = [prefix, length(domainBytes), domainBytes, length(valueBytes), valueBytes];
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function hashCanonical(domain: string, value: unknown): Digest {
  return digestBytes(frameHash(domain, value));
}

/** Raw bytes, not Unicode-normalized contract values. */
export function digestBytes(value: string | Uint8Array): Digest {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
