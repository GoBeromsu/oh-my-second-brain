import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseStrictJson } from "../conventions/strict-json.js";

/** Obsidian property types plus the aliases older contracts used for them. */
export type ObsidianContractType = "text" | "string" | "select" | "number" | "boolean" | "checkbox" | "date" | "datetime" | "list" | "multitext" | "multi" | "tags" | "aliases" | "file";
export const FIELD_TYPES: readonly ObsidianContractType[] = [
  "text", "string", "select", "number", "boolean", "checkbox", "date", "datetime",
  "list", "multitext", "multi", "tags", "aliases", "file",
];
const MAX_TYPES_BYTES = 1_048_576;

export function isFieldType(value: unknown): value is ObsidianContractType {
  return typeof value === "string" && (FIELD_TYPES as readonly string[]).includes(value);
}

/** Obsidian tags are unprefixed property values, not wikilinks; Unicode symbols are supported. */
export function isObsidianTag(value: string): boolean {
  return /^[\p{L}\p{M}\p{N}\p{S}_/-]+$/u.test(value) && /[^\p{N}]/u.test(value) && !value.startsWith("/") && !value.endsWith("/") && !value.includes("//");
}

/** `{ "types": { name: type } }`. Entries whose type OMS does not know are left out, not guessed. */
export function parseObsidianTypes(text: string): Readonly<Record<string, ObsidianContractType>> {
  const value = parseStrictJson(text, MAX_TYPES_BYTES);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("OBSIDIAN_TYPES_INVALID: root must be an object");
  const types = (value as Record<string, unknown>).types;
  if (types === undefined) return {};
  if (types === null || typeof types !== "object" || Array.isArray(types)) throw new TypeError("OBSIDIAN_TYPES_INVALID: types must be an object");
  const result: Record<string, ObsidianContractType> = {};
  for (const [name, type] of Object.entries(types)) if (isFieldType(type)) result[name] = type;
  return result;
}

/** Read-only: OMS never writes `.obsidian/`. A missing file means no declared types. */
export async function readObsidianTypes(vault: string): Promise<Readonly<Record<string, ObsidianContractType>>> {
  let text: string;
  try { text = await readFile(join(vault, ".obsidian", "types.json"), "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  return parseObsidianTypes(text);
}

/**
 * Read-only: the folder Obsidian's core Templates plugin (`templates.json` "folder") or
 * Templater (`templates_folder`) is set to, or null. Unreadable files are skipped; the
 * caller still confirms and validates the candidate.
 */
export async function readObsidianTemplateFolder(vault: string): Promise<string | null> {
  const sources: readonly (readonly [readonly string[], string])[] = [
    [["templates.json"], "folder"],
    [["plugins", "templater-obsidian", "data.json"], "templates_folder"],
  ];
  for (const [file, key] of sources) {
    try {
      const value = parseStrictJson(await readFile(join(vault, ".obsidian", ...file), "utf8"), MAX_TYPES_BYTES);
      const folder = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
      if (typeof folder === "string" && folder.trim().replace(/^\/+|\/+$/g, "") !== "") return folder.trim().replace(/^\/+|\/+$/g, "");
    } catch {
      // A missing or malformed plugin file offers no candidate.
    }
  }
  return null;
}
