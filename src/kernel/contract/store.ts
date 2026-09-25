import { randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { atomicWrite } from "../templates/file-lock.js";
import { isPublicField } from "./public.js";
import { UUID_PATTERN, type HiddenRule, type PublicManifest, type SealedField, type SealedLayer } from "./types.js";

/**
 * Hidden store outside the vault: `<root>/<vaultId>/meta.json` plus
 * `layers/<sealId>.json`. Directories are 0700 and files 0600. Reads create nothing.
 */

export interface StoreMeta {
  readonly version: 1;
  readonly vaultId: string;
  readonly lastSeenRealpath: string | null;
  /** Seal ids. */
  readonly layers: readonly string[];
}

export type UnreadableReason = "invalid-root" | "missing-store" | "corrupt" | "missing-layer" | "id-mismatch" | "manifest-mismatch";

export type LoadState =
  | { readonly state: "ok"; readonly layer: SealedLayer }
  | { readonly state: "unreadable"; readonly reason: UnreadableReason };

export interface LoadedLayers {
  readonly common: LoadState | null;
  /** Keyed by template id. */
  readonly templates: ReadonlyMap<string, LoadState>;
  /** True when the store holds a layer the manifest does not name. Every layer is then unreadable. */
  readonly orphaned: boolean;
}

export type MetaRead =
  | { readonly state: "absent" }
  | { readonly state: "invalid"; readonly reason: UnreadableReason }
  | { readonly state: "ok"; readonly meta: StoreMeta };

export type StoreResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_STORE_FILE_BYTES = 4_194_304;

export function contractStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["OMS_CONTRACT_STORE_ROOT"];
  const root = configured === undefined || configured === "" ? join(homedir(), ".oms", "vaults") : configured;
  if (!isAbsolute(root)) throw new Error("OMS_CONTRACT_STORE_ROOT must be an absolute path");
  return root;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
}

function bound(value: unknown): boolean {
  return value === undefined || typeof value === "string" || typeof value === "number" && Number.isFinite(value);
}

function isHiddenRule(value: unknown): value is HiddenRule {
  if (!record(value)) return false;
  switch (value["kind"]) {
    case "allowed": return Array.isArray(value["values"]) && value["values"].every(scalar);
    case "fixed": return Object.hasOwn(value, "value") && scalar(value["value"]);
    case "pattern": return typeof value["regex"] === "string";
    case "range": return bound(value["min"]) && bound(value["max"]);
    default: return false;
  }
}

function isSealedField(value: unknown): value is SealedField {
  if (!isPublicField(value) || !record(value)) return false;
  const variable = value["variable"];
  return Array.isArray(value["rules"]) && value["rules"].every(isHiddenRule)
    && (variable === null || variable === "date" || variable === "datetime" || variable === "title" || variable === "free");
}

export function isSealedLayer(value: unknown): value is SealedLayer {
  if (!record(value)) return false;
  const answers = value["answers"];
  return typeof value["sealId"] === "string" && UUID_PATTERN.test(value["sealId"])
    && Array.isArray(value["fields"]) && value["fields"].every(isSealedField)
    && Array.isArray(value["requiredHeadings"]) && value["requiredHeadings"].every(member => typeof member === "string")
    && (value["applyFolder"] === null || typeof value["applyFolder"] === "string")
    && (value["sourcePath"] === null || typeof value["sourcePath"] === "string")
    && (value["sourceHash"] === null || typeof value["sourceHash"] === "string" && DIGEST.test(value["sourceHash"]))
    && record(answers) && Object.values(answers).every(member => typeof member === "string");
}

function isStoreMeta(value: unknown): value is StoreMeta {
  return record(value) && value["version"] === 1
    && typeof value["vaultId"] === "string"
    && (value["lastSeenRealpath"] === null || typeof value["lastSeenRealpath"] === "string")
    && Array.isArray(value["layers"]) && value["layers"].every(member => typeof member === "string" && UUID_PATTERN.test(member))
    && new Set(value["layers"]).size === value["layers"].length;
}

/** Regular files only; a symlink or oversize file is corrupt. */
async function readJson(path: string): Promise<{ readonly state: "absent" } | { readonly state: "corrupt" } | { readonly state: "ok"; readonly value: unknown }> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_STORE_FILE_BYTES) return { state: "corrupt" };
    return { state: "ok", value: JSON.parse(await readFile(path, "utf8")) };
  } catch (error: unknown) {
    const code = errorCode(error);
    return code === "ENOENT" || code === "ENOTDIR" ? { state: "absent" } : { state: "corrupt" };
  }
}

function vaultDirectory(vaultId: string): string {
  return join(contractStoreRoot(), vaultId);
}

/** Read-only. Never creates the store. */
export async function readStoreMeta(vaultId: string): Promise<MetaRead> {
  if (!UUID_PATTERN.test(vaultId)) return { state: "invalid", reason: "id-mismatch" };
  let directory: string;
  try {
    directory = vaultDirectory(vaultId);
  } catch {
    return { state: "invalid", reason: "invalid-root" };
  }
  const read = await readJson(join(directory, "meta.json"));
  if (read.state === "absent") return { state: "absent" };
  if (read.state === "corrupt" || !isStoreMeta(read.value)) return { state: "invalid", reason: "corrupt" };
  if (read.value.vaultId !== vaultId) return { state: "invalid", reason: "id-mismatch" };
  return { state: "ok", meta: read.value };
}

async function loadOne(directory: string, meta: StoreMeta, sealId: string, sourcePath: string | null): Promise<LoadState> {
  if (!meta.layers.includes(sealId)) return { state: "unreadable", reason: "missing-layer" };
  const read = await readJson(join(directory, "layers", `${sealId}.json`));
  if (read.state === "absent") return { state: "unreadable", reason: "missing-layer" };
  if (read.state === "corrupt" || !record(read.value) || read.value["version"] !== 1 || !isSealedLayer(read.value["layer"])) {
    return { state: "unreadable", reason: "corrupt" };
  }
  const layer = read.value["layer"];
  if (layer.sealId !== sealId || layer.sourcePath !== sourcePath) return { state: "unreadable", reason: "id-mismatch" };
  return { state: "ok", layer };
}

/**
 * Loads every layer the manifest names. Both lists are cross-checked: a manifest seal
 * the store lacks is `missing-layer`; a store seal the manifest lacks fails every layer.
 */
export async function loadLayers(vaultId: string, manifest: PublicManifest): Promise<LoadedLayers> {
  const all = (reason: UnreadableReason, orphaned = false): LoadedLayers => ({
    common: manifest.common === null ? null : { state: "unreadable", reason },
    templates: new Map(manifest.templates.map(template => [template.id, { state: "unreadable", reason } as const])),
    orphaned,
  });
  const meta = await readStoreMeta(vaultId);
  if (meta.state === "absent") return all("missing-store");
  if (meta.state === "invalid") return all(meta.reason);
  const named = new Set([...(manifest.common === null ? [] : [manifest.common.sealId]), ...manifest.templates.map(template => template.sealId)]);
  if (meta.meta.layers.some(sealId => !named.has(sealId))) return all("manifest-mismatch", true);
  const directory = vaultDirectory(vaultId);
  const common = manifest.common === null ? null : await loadOne(directory, meta.meta, manifest.common.sealId, null);
  const templates = new Map<string, LoadState>();
  for (const template of manifest.templates) {
    templates.set(template.id, await loadOne(directory, meta.meta, template.sealId, template.id));
  }
  return { common, templates, orphaned: false };
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
  await chmod(path, 0o600);
}

async function metaForWrite(vaultId: string): Promise<{ readonly ok: true; readonly meta: StoreMeta | null } | { readonly ok: false; readonly reason: string }> {
  const meta = await readStoreMeta(vaultId);
  if (meta.state === "invalid") return { ok: false, reason: `store meta is unreadable (${meta.reason})` };
  return { ok: true, meta: meta.state === "ok" ? meta.meta : null };
}

/** CLI only (seal time). A reseal names the seal it replaces; its file is removed after meta moves on. */
export async function sealLayer(vaultId: string, layer: SealedLayer, realpath: string, options: { readonly replaces?: string } = {}): Promise<StoreResult> {
  if (!UUID_PATTERN.test(vaultId)) return { ok: false, reason: "vault id is not a UUID" };
  if (!isSealedLayer(layer)) return { ok: false, reason: "layer has an invalid shape" };
  if (options.replaces !== undefined && !UUID_PATTERN.test(options.replaces)) return { ok: false, reason: "replaced seal id is not a UUID" };
  try {
    const root = contractStoreRoot();
    const current = await metaForWrite(vaultId);
    if (!current.ok) return current;
    if (current.meta?.layers.includes(layer.sealId) === true) return { ok: false, reason: "seal id already exists" };
    const directory = join(root, vaultId);
    await ensureDirectory(root);
    await ensureDirectory(directory);
    await ensureDirectory(join(directory, "layers"));
    await writePrivate(join(directory, "layers", `${layer.sealId}.json`), { version: 1, layer });
    const layers = (current.meta?.layers ?? []).filter(sealId => sealId !== options.replaces);
    const meta: StoreMeta = { version: 1, vaultId, lastSeenRealpath: realpath, layers: [...layers, layer.sealId] };
    await writePrivate(join(directory, "meta.json"), meta);
    if (options.replaces !== undefined && options.replaces !== layer.sealId) {
      await rm(join(directory, "layers", `${options.replaces}.json`), { force: true });
    }
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, reason: message(error) };
  }
}

/** CLI only; never from write or read paths (ADR-009 §4). */
export async function recordSeen(vaultId: string, realpath: string): Promise<StoreResult> {
  if (!UUID_PATTERN.test(vaultId)) return { ok: false, reason: "vault id is not a UUID" };
  try {
    const root = contractStoreRoot();
    const current = await metaForWrite(vaultId);
    if (!current.ok) return current;
    const directory = join(root, vaultId);
    await ensureDirectory(root);
    await ensureDirectory(directory);
    const meta: StoreMeta = { version: 1, vaultId, lastSeenRealpath: realpath, layers: current.meta?.layers ?? [] };
    await writePrivate(join(directory, "meta.json"), meta);
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, reason: message(error) };
  }
}

async function tightenTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await tightenTree(join(path, entry));
  } else if (info.isFile()) {
    await chmod(path, 0o600);
  }
}

/** Copies the store to a new vault id. The old store is kept; an existing target is refused. */
export async function reissue(oldId: string, newId: string): Promise<StoreResult> {
  if (!UUID_PATTERN.test(oldId) || !UUID_PATTERN.test(newId)) return { ok: false, reason: "vault id is not a UUID" };
  if (oldId === newId) return { ok: false, reason: "new vault id equals the old one" };
  try {
    const root = contractStoreRoot();
    const meta = await readStoreMeta(oldId);
    if (meta.state !== "ok") return { ok: false, reason: meta.state === "absent" ? "source store is absent" : `source store is unreadable (${meta.reason})` };
    const target = join(root, newId);
    try {
      await lstat(target);
      return { ok: false, reason: "target store already exists" };
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const staging = join(root, `.reissue-${randomUUID()}`);
    try {
      await cp(join(root, oldId), staging, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      const next: StoreMeta = { ...meta.meta, vaultId: newId };
      await writeFile(join(staging, "meta.json"), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await tightenTree(staging);
      await rename(staging, target);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, reason: message(error) };
  }
}
