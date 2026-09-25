import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../templates/file-lock.js";
import {
  compareCodePoint, FIELD_TYPES, UUID_PATTERN,
  type Digest, type PublicCommon, type PublicField, type PublicManifest, type PublicTemplate,
} from "./types.js";

/**
 * `.oms/contract-public.json`: the only contract file inside the vault. It holds
 * names, types, required flags, descriptions, apply folders and required headings.
 * Hidden rules never reach it: the writer copies public keys explicitly.
 */

export const PUBLIC_MANIFEST_PATH = ".oms/contract-public.json";
const MAX_PUBLIC_MANIFEST_BYTES = 1_048_576;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export type PublicManifestRead =
  | { readonly state: "absent" }
  | { readonly state: "invalid"; readonly reason: string }
  | { readonly state: "ok"; readonly manifest: PublicManifest };

export const EMPTY_PUBLIC_MANIFEST: PublicManifest = { version: 1, common: null, templates: [] };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(member => typeof member === "string");
}

export function isPublicField(value: unknown): value is PublicField {
  return record(value)
    && typeof value["name"] === "string" && value["name"] !== ""
    && typeof value["type"] === "string" && (FIELD_TYPES as readonly string[]).includes(value["type"])
    && typeof value["required"] === "boolean"
    && typeof value["description"] === "string";
}

function uniqueNames(fields: readonly PublicField[]): boolean {
  return new Set(fields.map(field => field.name)).size === fields.length;
}

function parseFields(value: unknown): PublicField[] | null {
  if (!Array.isArray(value) || !value.every(isPublicField) || !uniqueNames(value)) return null;
  return value.map(publicField);
}

function publicField(field: PublicField): PublicField {
  return { name: field.name, type: field.type, required: field.required, description: field.description };
}

/** Shape check. Returns null for anything that is not exactly a public manifest. */
export function parsePublicManifest(value: unknown): PublicManifest | null {
  if (!record(value) || value["version"] !== 1 || !Array.isArray(value["templates"])) return null;
  let common: PublicCommon | null = null;
  if (value["common"] !== null) {
    const raw = value["common"];
    if (!record(raw) || typeof raw["sealId"] !== "string" || !UUID_PATTERN.test(raw["sealId"])) return null;
    const fields = parseFields(raw["fields"]);
    if (fields === null) return null;
    common = { fields, sealId: raw["sealId"] };
  }
  const templates: PublicTemplate[] = [];
  for (const raw of value["templates"] as unknown[]) {
    if (!record(raw)) return null;
    const { id, name, applyFolder, requiredHeadings, sourceHash, sealId } = raw;
    if (typeof id !== "string" || id === "" || typeof name !== "string" || name === "") return null;
    if (applyFolder !== null && typeof applyFolder !== "string") return null;
    if (!stringArray(requiredHeadings)) return null;
    if (typeof sourceHash !== "string" || !DIGEST.test(sourceHash)) return null;
    if (typeof sealId !== "string" || !UUID_PATTERN.test(sealId)) return null;
    const fields = parseFields(raw["fields"]);
    if (fields === null) return null;
    templates.push({ id, name, applyFolder, fields, requiredHeadings: [...requiredHeadings], sourceHash: sourceHash as Digest, sealId });
  }
  if (new Set(templates.map(template => template.id)).size !== templates.length) return null;
  const sealIds = [common?.sealId, ...templates.map(template => template.sealId)].filter(id => id !== undefined);
  if (new Set(sealIds).size !== sealIds.length) return null;
  return { version: 1, common, templates: templates.sort((left, right) => compareCodePoint(left.id, right.id)) };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Read-only. A present but unreadable manifest is `invalid`, never empty. */
export async function readPublicManifest(vault: string): Promise<PublicManifestRead> {
  const directory = join(vault, ".oms");
  const target = join(vault, PUBLIC_MANIFEST_PATH);
  try {
    const parent = await lstat(directory);
    if (parent.isSymbolicLink() || !parent.isDirectory()) return { state: "invalid", reason: ".oms is not a real directory" };
    const leaf = await lstat(target);
    if (leaf.isSymbolicLink() || !leaf.isFile()) return { state: "invalid", reason: "contract-public.json is not a regular file" };
    if (leaf.size > MAX_PUBLIC_MANIFEST_BYTES) return { state: "invalid", reason: "contract-public.json exceeds 1 MiB" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(target, "utf8"));
    } catch {
      return { state: "invalid", reason: "contract-public.json is not valid JSON" };
    }
    const manifest = parsePublicManifest(parsed);
    return manifest === null ? { state: "invalid", reason: "contract-public.json has an invalid shape" } : { state: "ok", manifest };
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return { state: "absent" };
    return { state: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Builds the output from public keys only, so a sealed layer passed by mistake loses its rules. */
export function serializePublicManifest(manifest: PublicManifest): string {
  const fields = (list: readonly PublicField[]): PublicField[] => [...list].map(publicField).sort((left, right) => compareCodePoint(left.name, right.name));
  const output: PublicManifest = {
    version: 1,
    common: manifest.common === null ? null : { fields: fields(manifest.common.fields), sealId: manifest.common.sealId },
    templates: [...manifest.templates]
      .map(template => ({
        id: template.id,
        name: template.name,
        applyFolder: template.applyFolder,
        fields: fields(template.fields),
        requiredHeadings: [...template.requiredHeadings],
        sourceHash: template.sourceHash,
        sealId: template.sealId,
      }))
      .sort((left, right) => compareCodePoint(left.id, right.id)),
  };
  return `${JSON.stringify(output, null, 2)}\n`;
}

/** CLI only (seal time). */
export async function writePublicManifest(vault: string, manifest: PublicManifest): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const bytes = serializePublicManifest(manifest);
  if (parsePublicManifest(JSON.parse(bytes)) === null) return { ok: false, reason: "manifest has an invalid shape" };
  try {
    await atomicWrite(join(vault, PUBLIC_MANIFEST_PATH), bytes);
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function fieldLine(field: PublicField): string {
  const head = `- ${field.name} (${field.type}, ${field.required ? "required" : "optional"})`;
  return field.description === "" ? head : `${head}: ${field.description}`;
}

/** What an agent may see before writing. Built from the public manifest alone. */
export function renderPublicGuidance(manifest: PublicManifest | null): string {
  const lines = ["Every note needs valid YAML frontmatter and a path inside the vault."];
  if (manifest === null) return lines.join("\n");
  if (manifest.common !== null && manifest.common.fields.length > 0) {
    lines.push("", "Common fields (every note):", ...manifest.common.fields.map(fieldLine));
  }
  for (const template of manifest.templates) {
    lines.push("", `Template ${template.name} (${template.id})`);
    lines.push(`Apply folder: ${template.applyFolder ?? "any folder"}`);
    if (template.fields.length > 0) lines.push("Fields:", ...template.fields.map(fieldLine));
    if (template.requiredHeadings.length > 0) lines.push("Required headings:", ...template.requiredHeadings.map(title => `- ${title}`));
  }
  return lines.join("\n");
}
