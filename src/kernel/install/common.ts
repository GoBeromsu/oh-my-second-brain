import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isAlias, isMap, isScalar, parseAllDocuments, stringify } from "yaml";
import type { HostOperationOptions } from "./types.js";

export class InstallTargetSymlinkError extends Error {
  readonly target: string;

  constructor(target: string) {
    super(`Refusing to replace symlinked Oh My Second Brain install target: ${target}`);
    this.name = "InstallTargetSymlinkError";
    this.target = target;
  }
}

export function commandExists(command: string): boolean {
  const result = spawnSync(
    process.platform === "win32" ? "where" : "command",
    process.platform === "win32" ? [command] : ["-v", command],
    {
      stdio: "ignore",
      shell: process.platform !== "win32",
    },
  );
  return result.status === 0;
}

export function hostHome(homeDir: string | undefined, dirname: string, envName: string): string {
  const override = process.env[envName];
  return override ? path.resolve(override) : path.join(homeDir ?? homedir(), dirname);
}

export function mcpArgs(options: HostOperationOptions): string[] {
  return ["mcp", "--vault", options.vault];
}

export function jsonString(value: string): string {
  return JSON.stringify(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeJsonObject(
  file: string,
  data: Record<string, unknown>,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  return true;
}

export type YamlEntryEdit =
  | { readonly kind: "set"; readonly value: Record<string, unknown> }
  | { readonly kind: "delete" };

export class UnsafeYamlEditError extends Error {
  constructor(message: string) {
    super(`Refusing unsafe YAML edit: ${message}`);
    this.name = "UnsafeYamlEditError";
  }
}

export interface YamlEntryRender {
  readonly changed: boolean;
  readonly text: string;
}

type YamlPair = {
  readonly key: unknown;
  readonly value: unknown;
};

function lineStart(text: string, offset: number): number {
  const index = text.lastIndexOf("\n", Math.max(0, offset - 1));
  return index === -1 ? 0 : index + 1;
}

function lineEndIncludingNewline(text: string, offset: number): number {
  const newline = text.indexOf("\n", offset);
  return newline === -1 ? text.length : newline + 1;
}

function entryEnd(text: string, start: number, indent: string): number {
  let cursor = lineEndIncludingNewline(text, start);
  while (cursor < text.length) {
    const end = lineEndIncludingNewline(text, cursor);
    const line = text.slice(cursor, end).replace(/\r?\n$/, "");
    if (line.trim() === "" || line.startsWith("#")) return cursor;
    const leading = line.match(/^ */)?.[0].length ?? 0;
    if (leading <= indent.length) return cursor;
    cursor = end;
  }
  return cursor;
}

function pairFor(map: { items: unknown[] }, key: string): YamlPair | undefined {
  let found: YamlPair | undefined;
  for (const item of map.items) {
    const pair = item as YamlPair;
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      throw new UnsafeYamlEditError("mapping keys must be unique scalars");
    }
    if (pair.key.value === key) {
      if (found) throw new UnsafeYamlEditError(`duplicate key ${key}`);
      found = pair;
    }
  }
  return found;
}

function rejectUnsafeNodes(node: unknown): void {
  if (node === null || typeof node !== "object") return;
  const yamlNode = node as { anchor?: unknown; items?: unknown[]; value?: unknown };
  if (yamlNode.anchor || isAlias(node)) throw new UnsafeYamlEditError("anchors and aliases are not supported");
  if (Array.isArray(yamlNode.items)) {
    for (const item of yamlNode.items) {
      const pair = item as YamlPair;
      if ("key" in pair) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          throw new UnsafeYamlEditError("mapping keys must be unique scalars");
        }
        if (pair.key.value === "<<") throw new UnsafeYamlEditError("merge keys are not supported");
        rejectUnsafeNodes(pair.key);
        rejectUnsafeNodes(pair.value);
      } else {
        rejectUnsafeNodes(item);
      }
    }
  }
  if ("value" in yamlNode) rejectUnsafeNodes(yamlNode.value);
}

function pairSpan(text: string, pair: YamlPair): readonly [number, number] {
  if (!isScalar(pair.key) || !pair.key.range || !pair.value || typeof pair.value !== "object") {
    throw new UnsafeYamlEditError("entry does not have a ranged scalar key and value");
  }
  const value = pair.value as { range?: readonly number[] };
  if (!value.range || value.range.length < 3) throw new UnsafeYamlEditError("entry value has no source range");
  const start = lineStart(text, pair.key.range[0]);
  const valueEnd = value.range[1] ?? value.range[2];
  if (valueEnd === undefined) throw new UnsafeYamlEditError("entry value has no source range");
  const indent = text.slice(start, pair.key.range[0]);
  const end = entryEnd(text, start, indent);
  const beforeKey = text.slice(start, pair.key.range[0]);
  if (!/^[ ]*$/.test(beforeKey)) {
    throw new UnsafeYamlEditError("entry boundaries are ambiguous");
  }
  return [start, end];
}

function indentation(text: string, pair: YamlPair): string {
  if (!isScalar(pair.key) || !pair.key.range) throw new UnsafeYamlEditError("mapping key has no source range");
  return text.slice(lineStart(text, pair.key.range[0]), pair.key.range[0]);
}

function sectionWithEntry(
  entryPath: readonly [string, string],
  value: Record<string, unknown>,
  indent: string,
  eol: string,
): string {
  return `${indent}${entryPath[0]}:${eol}${indent}  ${entryPath[1]}:${eol}${renderValue(value, `${indent}  `, eol)}`;
}

function renderValue(value: Record<string, unknown>, indent: string, eol: string): string {
  const rendered = stringify(value).replace(/\n$/, "");
  return rendered
    .split("\n")
    .map((line) => `${indent}  ${line}`)
    .join(eol);
}

/**
 * Creates a surgical YAML edit. Callers that need transactional writes can
 * commit `text` with their own atomic-write primitive.
 */
export function renderYamlEntryPreservingComments(
  raw: string,
  entryPath: readonly [string, string],
  edit: YamlEntryEdit,
): YamlEntryRender {
  if (!Buffer.from(raw, "utf8").equals(Buffer.from(Buffer.from(raw, "utf8").toString("utf8"), "utf8"))) {
    throw new UnsafeYamlEditError("file is not losslessly representable as UTF-8");
  }
  if (/(^|\n)[ ]*\t/m.test(raw)) throw new UnsafeYamlEditError("tab indentation is not supported");
  if (raw.trim() === "") {
    if (edit.kind === "delete") return { changed: false, text: raw };
    const emptyEol = raw.includes("\r\n") ? "\r\n" : "\n";
    return { changed: true, text: `${sectionWithEntry(entryPath, edit.value, "", emptyEol)}${emptyEol}` };
  }
  const documents = parseAllDocuments(raw, { keepSourceTokens: true });
  const doc = documents[0];
  if (documents.length !== 1 || !doc || doc.errors.length > 0) {
    throw new UnsafeYamlEditError("document must be one valid YAML document");
  }
  if (doc.contents !== null && !isMap(doc.contents)) throw new UnsafeYamlEditError("root must be a mapping");
  rejectUnsafeNodes(doc.contents);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  if (raw.includes("\r\n") && /(^|[^\r])\n/.test(raw)) throw new UnsafeYamlEditError("mixed line endings");
  const root = doc.contents;
  const section = root === null ? undefined : pairFor(root, entryPath[0]);

  if (section && section.value !== null && !isMap(section.value)) {
    throw new UnsafeYamlEditError(`${entryPath[0]} must be a mapping`);
  }
  const sectionMap = section && isMap(section.value) ? section.value : undefined;
  const entry = sectionMap ? pairFor(sectionMap, entryPath[1]) : undefined;
  if (edit.kind === "delete") {
    if (!entry) return { changed: false, text: raw };
    if (section && sectionMap && sectionMap.items.length === 1) {
      const [start, end] = pairSpan(raw, section);
      const indent = indentation(raw, section);
      const replacement = `${indent}${entryPath[0]}: {}${raw.slice(end - 1, end) === "\n" ? eol : ""}`;
      return { changed: true, text: `${raw.slice(0, start)}${replacement}${raw.slice(end)}` };
    }
    const [start, end] = pairSpan(raw, entry);
    const text = `${raw.slice(0, start)}${raw.slice(end)}`;
    if (`${raw.slice(0, start)}${raw.slice(end)}` !== text) throw new UnsafeYamlEditError("splice integrity check failed");
    return { changed: true, text };
  }
  if (entry) {
    const [start, end] = pairSpan(raw, entry);
    const indent = indentation(raw, entry);
    const replacement = `${indent}${entryPath[1]}:${eol}${renderValue(edit.value, indent, eol)}${raw.slice(end - 1, end) === "\n" ? eol : ""}`;
    const text = `${raw.slice(0, start)}${replacement}${raw.slice(end)}`;
    return { changed: text !== raw, text };
  }
  if (root && root.items.length === 0) {
    if (raw.trim() !== "{}") throw new UnsafeYamlEditError("empty mappings with source ambiguity are not supported");
    const prefix = raw.slice(0, raw.indexOf("{"));
    const suffix = raw.slice(raw.lastIndexOf("}") + 1);
    const text = `${prefix}${sectionWithEntry(entryPath, edit.value, "", eol)}${suffix}`;
    return { changed: true, text };
  }
  if (!root) throw new UnsafeYamlEditError("empty document was not handled");
  if (section && sectionMap && sectionMap.items.length === 0) {
    const [start, end] = pairSpan(raw, section);
    const indent = indentation(raw, section);
    const replacement = `${indent}${entryPath[0]}:${eol}${indent}  ${entryPath[1]}:${eol}${renderValue(edit.value, `${indent}  `, eol)}${raw.slice(end - 1, end) === "\n" ? eol : ""}`;
    return { changed: true, text: `${raw.slice(0, start)}${replacement}${raw.slice(end)}` };
  }
  const last = sectionMap?.items.at(-1) as YamlPair | undefined;
  if (last) {
    const [, end] = pairSpan(raw, last);
    const indent = indentation(raw, last);
    const fragment = `${indent}${entryPath[1]}:${eol}${renderValue(edit.value, indent, eol)}${raw.slice(end - 1, end) === "\n" ? eol : ""}`;
    return { changed: true, text: `${raw.slice(0, end)}${fragment}${raw.slice(end)}` };
  }
  const rootLast = root.items.at(-1) as YamlPair;
  const [, end] = pairSpan(raw, rootLast);
  const fragment = `${sectionWithEntry(entryPath, edit.value, "", eol)}${raw.slice(end - 1, end) === "\n" ? eol : ""}`;
  return { changed: true, text: `${raw.slice(0, end)}${fragment}${raw.slice(end)}` };
}

/**
 * Applies one `section.key` edit to a YAML file while leaving every other byte,
 * comment, and key ordering the document already had in place.
 */
export async function editYamlEntryPreservingComments(
  file: string,
  entryPath: readonly [string, string],
  edit: YamlEntryEdit,
): Promise<boolean> {
  const rawBytes = existsSync(file) ? await readFile(file) : Buffer.alloc(0);
  const raw = rawBytes.toString("utf8");
  if (!rawBytes.equals(Buffer.from(raw, "utf8"))) throw new UnsafeYamlEditError("file is not valid UTF-8");
  const rendered = renderYamlEntryPreservingComments(raw, entryPath, edit);
  if (!rendered.changed) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rendered.text, "utf-8");
  return true;
}

export function mcpServerEntry(options: HostOperationOptions): Record<string, unknown> {
  return {
    command: "oms",
    args: mcpArgs(options),
  };
}

export interface ExternalCommandResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly message: string;
}

export function runExternal(command: string, args: string[]): ExternalCommandResult {
  const result = spawnSync(command, args, { stdio: "pipe", encoding: "utf-8" });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const exitCode = result.status;
  const signal = result.signal;
  if (exitCode === 0) {
    return {
      ok: true,
      exitCode,
      signal,
      stdout,
      stderr,
      message: `${command} ${args.join(" ")}`,
    };
  }
  const spawnError = result.error instanceof Error ? result.error.message : "";
  return {
    ok: false,
    exitCode,
    signal,
    stdout,
    stderr,
    message: spawnError || stderr.trim() || stdout.trim() || `${command} exited ${exitCode ?? "unknown"}`,
  };
}

function refuseSymlinkedLeaf(target: string): void {
  if (!existsSync(target)) return;
  if (lstatSync(target).isSymbolicLink()) {
    throw new InstallTargetSymlinkError(target);
  }
}

export async function replaceDirectory(source: string, target: string, dryRun: boolean): Promise<boolean> {
  if (dryRun) return false;
  refuseSymlinkedLeaf(target);
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  return true;
}
