import type { JsonValue } from "./types.js";

export interface RenderNameRequest {
  readonly pattern: string;
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly resolvedAt: string;
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "untitled";
}

function scalar(value: JsonValue | undefined, token: string): string {
  if (typeof value !== "string" || value.trim() === "") fail("NAMING_TOKEN_MISSING", `${token} requires a non-empty string field`);
  return value.trim();
}

function tokenValue(token: string, fields: Readonly<Record<string, JsonValue>>, resolvedAt: string): string {
  if (token === "date") return resolvedAt.slice(0, 10);
  if (token === "title") return scalar(fields.title, token);
  if (token === "slug") return slugify(scalar(fields.title, token));
  if (token.startsWith("field:")) {
    const key = token.slice("field:".length);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) fail("NAMING_TOKEN_UNSUPPORTED", token);
    return scalar(fields[key], token);
  }
  fail("NAMING_TOKEN_UNSUPPORTED", token);
}

function safeLeaf(name: string): string {
  if (name === "" || name === "." || name === ".." || name.includes("\0") || name.includes("/") || name.includes("\\")) fail("NAMING_CANDIDATE_UNSAFE", "rendered name is not a safe leaf");
  return name;
}

/** Renders only the closed naming grammar; path joining and filesystem checks remain separate. */
export function renderNoteName(request: RenderNameRequest): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(request.resolvedAt) || Number.isNaN(Date.parse(request.resolvedAt))) fail("RESOLVED_AT_INVALID", "resolvedAt must be an ISO instant");
  const candidate = request.pattern.replace(/{{([^{}]+)}}/g, (_match, token: string) => tokenValue(token, request.fields, request.resolvedAt));
  if (/[{}]/.test(candidate)) fail("NAMING_TOKEN_UNSUPPORTED", "unbalanced or unsupported expression");
  return safeLeaf(candidate);
}

export { slugify };
