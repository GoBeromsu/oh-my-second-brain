import { lstat, mkdir, open, readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { compareCodePoints, digestBytes, type Digest } from "../conventions/canonical.js";
import { parseStrictJson } from "../conventions/strict-json.js";
import { VAULT_ID_PATTERN } from "../vault/settings.js";
import { ensureDirectory, syncDirectory, writePrivate } from "./fs-private.js";
import { isFieldType } from "./obsidian.js";
import { patternRefusal } from "./pattern.js";
import type { FolderContract, JsonScalar, PropertyContract, Rule, TemplateContract, VaultContract } from "./types.js";

/**
 * Store outside the vault: `~/.oms/vaults/index.json` maps a vault realpath to its id;
 * `<id>` is a relative symlink to `.<id>.<seq>/` holding `folders.json`, `properties.json`,
 * `templates/<name>.json`, an optional `declined.json` (what the owner chose not to register)
 * and `manifest.json` (sha256 per file). Directories 0700, files 0600.
 * Reads never create anything.
 */

const MAX_STORE_FILE_BYTES = 4 * 1024 * 1024;
const MANIFEST = "manifest.json";
const FOLDERS = "folders.json";
const PROPERTIES = "properties.json";
const TEMPLATES = "templates";
const DECLINED = "declined.json";
const INDEX_LOCK = ".index.lock";
const INDEX_LOCK_ATTEMPTS = 50;
const INDEX_LOCK_WAIT_MS = 20;

export type IndexRead =
  | { readonly state: "absent" }
  | { readonly state: "corrupt" }
  | { readonly state: "ok"; readonly entries: Readonly<Record<string, string>> };

export type StoreRead =
  | { readonly state: "absent" }
  | { readonly state: "unreadable" }
  | { readonly state: "ok"; readonly contract: VaultContract };

/** What the owner declined at seal time; a template is keyed by the source hash it was declined at. */
export interface DeclinedSet {
  readonly folders: readonly string[];
  readonly properties: readonly string[];
  readonly templates: Readonly<Record<string, string>>;
}

export const NO_DECLINED: DeclinedSet = { folders: [], properties: [], templates: {} };

/** No environment override: tests point HOME at a temporary directory. */
export function storeRoot(): string {
  return join(homedir(), ".oms", "vaults");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
}

/** A template name is a plain file name: no separator, NUL or leading dot. */
export function isSafeName(name: string): boolean {
  return name.length > 0 && name.length <= 200 && !name.startsWith(".") && !/[/\\\0]/.test(name) && name.normalize("NFC") === name;
}

function isScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
}

function isBound(value: unknown): boolean {
  return value === undefined || typeof value === "string" || typeof value === "number" && Number.isFinite(value);
}

function isRule(value: unknown): value is Rule {
  if (!record(value)) return false;
  switch (value["kind"]) {
    case "allowed": return onlyKeys(value, ["kind", "values"]) && Array.isArray(value["values"]) && value["values"].every(isScalar);
    case "fixed": return onlyKeys(value, ["kind", "value"]) && isScalar(value["value"]);
    case "pattern": {
      if (!onlyKeys(value, ["kind", "regex"]) || typeof value["regex"] !== "string") return false;
      try { new RegExp(value["regex"], "u"); return true; } catch { return false; }
    }
    case "range": return onlyKeys(value, ["kind"], ["min", "max"]) && isBound(value["min"]) && isBound(value["max"]);
    default: return false;
  }
}

function isRules(value: unknown): value is Rule[] {
  return Array.isArray(value) && value.every(isRule);
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(member => typeof member === "string");
}

function isFolderContract(value: unknown): value is FolderContract {
  return record(value) && onlyKeys(value, ["meaning", "searchExclude"])
    && typeof value["meaning"] === "string" && typeof value["searchExclude"] === "boolean";
}

function isPropertyContract(value: unknown): value is PropertyContract {
  return record(value) && onlyKeys(value, ["meaning", "type", "default", "required", "rules"])
    && typeof value["meaning"] === "string" && typeof value["type"] === "string" && isFieldType(value["type"])
    && typeof value["default"] === "boolean" && typeof value["required"] === "boolean" && isRules(value["rules"]);
}

function isTemplateContract(value: unknown): value is TemplateContract {
  if (!record(value) || !onlyKeys(value, ["source", "sourceHash", "requiredProperties", "narrowedRules", "requiredHeadings"], ["applyFolder"])) return false;
  const narrowed = value["narrowedRules"];
  return typeof value["source"] === "string"
    && typeof value["sourceHash"] === "string" && /^sha256:[0-9a-f]{64}$/.test(value["sourceHash"])
    && (value["applyFolder"] === undefined || typeof value["applyFolder"] === "string")
    && isStrings(value["requiredProperties"]) && isStrings(value["requiredHeadings"])
    && record(narrowed) && Object.values(narrowed).every(isRules);
}

function isDeclined(value: unknown): value is DeclinedSet & { readonly version: 1 } {
  if (!record(value) || !onlyKeys(value, ["version", "folders", "properties", "templates"]) || value["version"] !== 1) return false;
  const templates = value["templates"];
  return isStrings(value["folders"]) && isStrings(value["properties"])
    && record(templates) && Object.values(templates).every(hash => typeof hash === "string");
}

function isRecordOf<T>(value: unknown, member: (entry: unknown) => entry is T): value is Record<string, T> {
  return record(value) && Object.values(value).every(member);
}

/** Refuses a non-regular file or one over the size limit. */
async function readBounded(path: string): Promise<{ readonly state: "absent" } | { readonly state: "bad" } | { readonly state: "ok"; readonly bytes: Buffer }> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error: unknown) {
    const code = errorCode(error);
    return code === "ENOENT" || code === "ENOTDIR" ? { state: "absent" } : { state: "bad" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_STORE_FILE_BYTES) return { state: "bad" };
    const bytes = await handle.readFile();
    if (bytes.length > MAX_STORE_FILE_BYTES) return { state: "bad" };
    return { state: "ok", bytes };
  } catch {
    return { state: "bad" };
  } finally {
    await handle.close();
  }
}

function parseBytes(bytes: Buffer): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return parseStrictJson(text, MAX_STORE_FILE_BYTES);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort(compareCodePoints).filter(key => value[key] !== undefined).map(key => [key, sortKeys(value[key])]));
}

/** Stable key order; floats and undefined members are allowed (unlike canonical JSON). */
function stringify(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export async function readIndex(root: string = storeRoot()): Promise<IndexRead> {
  const read = await readBounded(join(root, "index.json"));
  if (read.state === "absent") return { state: "absent" };
  if (read.state === "bad") return { state: "corrupt" };
  try {
    const value = parseBytes(read.bytes);
    if (!record(value) || !onlyKeys(value, ["version", "vaults"]) || value["version"] !== 1) return { state: "corrupt" };
    const vaults = value["vaults"];
    if (!record(vaults) || !Object.values(vaults).every(id => typeof id === "string" && VAULT_ID_PATTERN.test(id))) return { state: "corrupt" };
    return { state: "ok", entries: vaults as Record<string, string> };
  } catch {
    return { state: "corrupt" };
  }
}

async function writeIndex(root: string, entries: Readonly<Record<string, string>>): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(entries).sort(([left], [right]) => compareCodePoints(left, right)));
  await ensureDirectory(root);
  await writePrivate(join(root, "index.json"), stringify({ version: 1, vaults: sorted }));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return false;
    throw error;
  }
}

/** St(id): the `<id>` link exists, whatever it points at. */
export async function storeExists(vaultId: string, root: string = storeRoot()): Promise<boolean> {
  if (!VAULT_ID_PATTERN.test(vaultId)) return false;
  return pathExists(join(root, vaultId));
}

/** The link must be a relative symlink to a sibling `.<id>.<seq>` directory. */
async function resolveGeneration(root: string, vaultId: string): Promise<string | null | "absent"> {
  let target: string;
  try {
    target = await readlink(join(root, vaultId));
  } catch (error: unknown) {
    const code = errorCode(error);
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : null;
  }
  const match = new RegExp(`^\\.${vaultId}\\.(\\d{1,9})$`).exec(target);
  return match === null ? null : target;
}

async function listFiles(directory: string, prefix = ""): Promise<string[] | null> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = await listFiles(join(directory, entry.name), relative);
      if (nested === null) return null;
      found.push(...nested);
    } else if (entry.isFile()) {
      found.push(relative);
    } else {
      return null;
    }
  }
  return found;
}

/** Why a store that exists cannot be read. Names no path, directory or id. */
export type StoreCause = "link-dangling" | "manifest-mismatch" | "schema-invalid";

type GenerationRead =
  | { readonly state: "ok"; readonly contract: VaultContract; readonly declined: DeclinedSet }
  | { readonly state: "unreadable"; readonly cause: StoreCause };

function unreadable(cause: StoreCause): GenerationRead {
  return { state: "unreadable", cause };
}

/** Throws ENOENT when the generation directory itself is gone, so the caller can re-resolve. */
async function readGeneration(directory: string): Promise<GenerationRead> {
  const info = await lstat(directory);
  if (!info.isDirectory()) return unreadable("link-dangling");
  const manifestRead = await readBounded(join(directory, MANIFEST));
  if (manifestRead.state !== "ok") return unreadable("manifest-mismatch");
  let manifest: unknown;
  try { manifest = parseBytes(manifestRead.bytes); } catch { return unreadable("manifest-mismatch"); }
  if (!record(manifest) || !onlyKeys(manifest, ["version", "files"]) || manifest["version"] !== 1) return unreadable("manifest-mismatch");
  const files = manifest["files"];
  if (!record(files) || !Object.values(files).every(digest => typeof digest === "string")) return unreadable("manifest-mismatch");
  const listed = await listFiles(directory);
  if (listed === null) return unreadable("manifest-mismatch");
  const present = listed.filter(path => path !== MANIFEST);
  const named = Object.keys(files);
  if (present.length !== named.length || !present.every(path => Object.hasOwn(files, path))) return unreadable("manifest-mismatch");

  const values = new Map<string, unknown>();
  for (const path of named) {
    const read = await readBounded(join(directory, ...path.split("/")));
    if (read.state !== "ok" || digestBytes(read.bytes) !== files[path]) return unreadable("manifest-mismatch");
    try { values.set(path, parseBytes(read.bytes)); } catch { return unreadable("schema-invalid"); }
  }

  let folders: Record<string, FolderContract> | null = null;
  let properties: Record<string, PropertyContract> | null = null;
  const templates: Record<string, TemplateContract> = {};
  let declined: DeclinedSet = NO_DECLINED;
  for (const [path, value] of values) {
    if (path === FOLDERS) {
      if (!record(value) || !onlyKeys(value, ["version", "folders"]) || value["version"] !== 1 || !isRecordOf(value["folders"], isFolderContract)) return unreadable("schema-invalid");
      folders = value["folders"];
    } else if (path === PROPERTIES) {
      if (!record(value) || !onlyKeys(value, ["version", "properties"]) || value["version"] !== 1 || !isRecordOf(value["properties"], isPropertyContract)) return unreadable("schema-invalid");
      properties = value["properties"];
    } else if (path === DECLINED) {
      if (!isDeclined(value)) return unreadable("schema-invalid");
      declined = { folders: value.folders, properties: value.properties, templates: value.templates };
    } else if (path.startsWith(`${TEMPLATES}/`) && path.endsWith(".json")) {
      const name = path.slice(TEMPLATES.length + 1, -".json".length);
      if (!isSafeName(name) || !isTemplateContract(value)) return unreadable("schema-invalid");
      templates[name] = value;
    } else {
      return unreadable("schema-invalid");
    }
  }
  return { state: "ok", contract: { folders, properties, templates }, declined };
}

async function readResolved(vaultId: string, root: string): Promise<{ readonly state: "absent" } | GenerationRead> {
  if (!VAULT_ID_PATTERN.test(vaultId)) return unreadable("link-dangling");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const generation = await resolveGeneration(root, vaultId);
    if (generation === "absent") return { state: "absent" };
    if (generation === null) return unreadable("link-dangling");
    try {
      return await readGeneration(join(root, generation));
    } catch (error: unknown) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") return unreadable("manifest-mismatch");
    }
  }
  return unreadable("link-dangling");
}

/**
 * Read path: readlink once → every file regular and ≤ 4 MiB → digest per manifest →
 * strict schema. A generation that vanishes mid-read is re-resolved once.
 */
export async function readStore(vaultId: string, root: string = storeRoot()): Promise<StoreRead> {
  const read = await readResolved(vaultId, root);
  if (read.state === "ok") return { state: "ok", contract: read.contract };
  return read.state === "unreadable" ? { state: "unreadable" } : read;
}

/** The declined set of the linked generation; empty when there is none or it cannot be read. */
export async function readDeclined(vaultId: string, root: string = storeRoot()): Promise<DeclinedSet> {
  const read = await readResolved(vaultId, root);
  return read.state === "ok" ? read.declined : NO_DECLINED;
}

/** The unreadable cause for doctor; `absent` when there is no link, `ok` when it reads. */
export async function diagnoseStore(vaultId: string, root: string = storeRoot()): Promise<"absent" | "ok" | StoreCause> {
  const read = await readResolved(vaultId, root);
  return read.state === "unreadable" ? read.cause : read.state;
}

/** Every pattern rule must pass the interview's screen; the error never echoes the source. */
function assertSealablePatterns(contract: VaultContract): void {
  const ruleSets = [
    ...Object.values(contract.properties ?? {}).map(property => property.rules),
    ...Object.values(contract.templates).flatMap(template => Object.values(template.narrowedRules)),
  ];
  for (const rules of ruleSets) {
    for (const rule of rules) {
      if (rule.kind !== "pattern") continue;
      const refusal = patternRefusal(rule.regex);
      if (refusal !== null) throw new TypeError(`CONTRACT_PATTERN_UNSAFE: a pattern rule is ${refusal}`);
    }
  }
}

function contractFiles(contract: VaultContract, declined: DeclinedSet = NO_DECLINED): Map<string, string> {
  assertSealablePatterns(contract);
  const files = new Map<string, string>();
  if (declined.folders.length + declined.properties.length + Object.keys(declined.templates).length > 0) {
    files.set(DECLINED, stringify({
      version: 1,
      folders: [...new Set(declined.folders)].sort(compareCodePoints),
      properties: [...new Set(declined.properties)].sort(compareCodePoints),
      templates: declined.templates,
    }));
  }
  if (contract.folders !== null) files.set(FOLDERS, stringify({ version: 1, folders: contract.folders }));
  if (contract.properties !== null) files.set(PROPERTIES, stringify({ version: 1, properties: contract.properties }));
  for (const [name, template] of Object.entries(contract.templates)) {
    if (!isSafeName(name)) throw new TypeError("CONTRACT_TEMPLATE_NAME_UNSAFE: template name must be a plain file name");
    files.set(`${TEMPLATES}/${name}.json`, stringify(template));
  }
  return files;
}

function sequenceOf(name: string, vaultId: string): number | null {
  const match = new RegExp(`^\\.${vaultId}\\.(\\d{1,9})$`).exec(name);
  return match === null ? null : Number(match[1]);
}

/** Generation directories present under the root, by sequence. */
async function listGenerations(root: string, vaultId: string): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return [];
    throw error;
  }
  return entries.map(entry => sequenceOf(entry, vaultId)).filter((seq): seq is number => seq !== null).sort((left, right) => left - right);
}

/** What `<id>` currently is: the linked sequence, none, a real directory, or something else. */
export type SequenceObservation = number | "none" | "directory" | "invalid";

export async function currentSequence(vaultId: string, root: string = storeRoot()): Promise<SequenceObservation> {
  if (!VAULT_ID_PATTERN.test(vaultId)) return "invalid";
  let info;
  try {
    info = await lstat(join(root, vaultId));
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return "none";
    throw error;
  }
  if (info.isDirectory()) return "directory";
  if (!info.isSymbolicLink()) return "invalid";
  const target = await resolveGeneration(root, vaultId);
  if (target === "absent") return "none";
  if (target === null) return "invalid";
  return sequenceOf(target, vaultId) ?? "invalid";
}

/** Generations to keep: the linked one and the one directly below it (N-1). */
function retained(generations: readonly number[], linked: SequenceObservation): Set<number> {
  if (typeof linked !== "number") return new Set();
  const below = generations.filter(seq => seq < linked);
  return new Set(below.length === 0 ? [linked] : [linked, below[below.length - 1]!]);
}

export const SEAL_LOCK_STALE_MS = 10 * 60 * 1000;

export interface SealFs {
  readonly rename: typeof rename;
  readonly symlink: typeof symlink;
  readonly rm: typeof rm;
}

/** Everything the seal touches outside its inputs, injectable for tests. */
export interface SealDeps {
  readonly now: () => number;
  readonly pid: number;
  readonly host: string;
  readonly isPidAlive: (pid: number) => boolean;
  /** Absent in a non-interactive run: a stale lock then aborts. */
  readonly confirmStaleReclaim?: () => Promise<boolean>;
  readonly fs: SealFs;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) === "EPERM";
  }
}

function sealDeps(overrides: Partial<SealDeps>): SealDeps {
  return { now: Date.now, pid: process.pid, host: hostname(), isPidAlive: pidAlive, fs: { rename, symlink, rm }, ...overrides };
}

function lockPath(root: string, vaultId: string): string {
  return join(root, `.${vaultId}.lock`);
}

/** A lock is stale on this host when its pid is gone or it is too old; elsewhere only by age. */
async function lockIsStale(path: string, deps: SealDeps): Promise<boolean> {
  let owner: unknown = null;
  let age: number;
  try {
    const read = await readBounded(path);
    if (read.state === "ok") owner = parseBytes(read.bytes);
  } catch {
    owner = null;
  }
  if (record(owner) && typeof owner["pid"] === "number" && typeof owner["host"] === "string" && typeof owner["startedAt"] === "number") {
    age = deps.now() - owner["startedAt"];
    if (owner["host"] === deps.host && !deps.isPidAlive(owner["pid"])) return true;
  } else {
    try {
      age = deps.now() - (await lstat(path)).mtimeMs;
    } catch (error: unknown) {
      // Released between our failed create and this check: not stale, the caller retries.
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  }
  return age > SEAL_LOCK_STALE_MS;
}

async function createLock(path: string, deps: SealDeps): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error: unknown) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: deps.pid, host: deps.host, startedAt: deps.now() }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

async function acquireLock(root: string, vaultId: string, deps: SealDeps): Promise<void> {
  const path = lockPath(root, vaultId);
  if (await createLock(path, deps)) return;
  // The holder may release between the create and the staleness check; try once more then.
  if (!await pathExists(path) && await createLock(path, deps)) return;
  if (!await lockIsStale(path, deps)) throw new Error("CONTRACT_SEAL_BUSY: another seal in progress; try oms setup again later");
  if (deps.confirmStaleReclaim === undefined || !await deps.confirmStaleReclaim()) {
    throw new Error("CONTRACT_SEAL_LOCK_STALE: a stale seal lock remains; run oms setup interactively to reclaim it");
  }
  await deps.fs.rename(path, `${path}.stale-${deps.now()}`);
  if (!await createLock(path, deps)) throw new Error("CONTRACT_SEAL_BUSY: another seal in progress; try oms setup again later");
}

export interface SealRequest {
  readonly vaultRealPath: string;
  readonly vaultId: string;
  readonly contract: VaultContract;
  /** What `<id>` was when the interview read the contract; a different value after locking aborts. */
  readonly baseSeq?: SequenceObservation;
  /** Folders, properties and templates the owner declined; kept so a rerun does not ask again. */
  readonly declined?: DeclinedSet;
}

/**
 * CLI only. Under the `.<id>.lock`: check nothing sealed since `baseSeq`, drop orphan
 * generations, write `.<id>.<seq>/` (manifest last), swap the `<id>` link by rename,
 * record the index entry, keep only N and N-1. A failure before the swap leaves the
 * previous contract in place.
 */
export async function sealContract(request: SealRequest, root: string = storeRoot(), overrides: Partial<SealDeps> = {}): Promise<void> {
  const id = request.vaultId;
  if (!VAULT_ID_PATTERN.test(id)) throw new TypeError("CONTRACT_VAULT_ID_INVALID: vault id is not a UUID");
  const files = contractFiles(request.contract, request.declined);
  const deps = sealDeps(overrides);
  await ensureDirectory(root);
  await acquireLock(root, id, deps);
  try {
    if ((await readIndex(root)).state === "corrupt") throw indexCorrupt();
    const linked = await currentSequence(id, root);
    if (request.baseSeq !== undefined && linked !== request.baseSeq) {
      throw new Error("CONTRACT_SEAL_CHANGED: the contract was sealed elsewhere meanwhile; run oms setup again to review the differences");
    }

    const keep = retained(await listGenerations(root, id), linked);
    for (const seq of await listGenerations(root, id)) {
      if (!keep.has(seq)) await deps.fs.rm(join(root, `.${id}.${seq}`), { recursive: true, force: true });
    }
    for (const entry of await readdir(root)) {
      if (entry.startsWith(`.${id}.lock.stale-`)) await deps.fs.rm(join(root, entry), { force: true });
    }
    const temporary = join(root, `.${id}.link-tmp`);
    await deps.fs.rm(temporary, { force: true });

    // A legacy `<id>` directory moves to the sequence just below the new one and becomes N-1. With a
    // directory linked nothing is retained, so every generation is gone by now and `seq - 1` is unused.
    const migrating = linked === "directory";
    const seq = Math.max(0, ...await listGenerations(root, id), typeof linked === "number" ? linked : 0) + 1;
    const generation = `.${id}.${seq}`;
    const directory = join(root, generation);
    const migrated = join(root, `.${id}.${seq - 1}`);
    let movedAside = false;
    let swapped = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      await ensureDirectory(directory);
      const digests: Record<string, Digest> = {};
      for (const [path, content] of [...files].sort(([left], [right]) => compareCodePoints(left, right))) {
        if (path.includes("/")) await ensureDirectory(join(directory, TEMPLATES));
        await writePrivate(join(directory, ...path.split("/")), content);
        digests[path] = digestBytes(content);
      }
      await writePrivate(join(directory, MANIFEST), stringify({ version: 1, files: digests }));
      await syncDirectory(directory);

      await deps.fs.symlink(generation, temporary);
      if (migrating) {
        await deps.fs.rename(join(root, id), migrated);
        movedAside = true;
      }
      await deps.fs.rename(temporary, join(root, id));
      swapped = true;
      await syncDirectory(root);
    } finally {
      if (!swapped) {
        if (movedAside) await deps.fs.rename(migrated, join(root, id));
        await deps.fs.rm(temporary, { force: true });
        await deps.fs.rm(directory, { recursive: true, force: true });
      }
    }

    await writeIndexEntry(request.vaultRealPath, id, root);

    const survivors = retained(await listGenerations(root, id), seq);
    for (const old of await listGenerations(root, id)) {
      if (!survivors.has(old)) await deps.fs.rm(join(root, `.${id}.${old}`), { recursive: true, force: true });
    }
    await syncDirectory(root);
  } finally {
    await deps.fs.rm(lockPath(root, id), { force: true });
  }
}

/** Counts only: stale locks (live-but-stale and reclaimed leftovers) and orphan generations. */
export async function storeHousekeeping(vaultId: string, root: string = storeRoot(), overrides: Partial<SealDeps> = {}): Promise<{ readonly staleLocks: number; readonly orphans: number }> {
  if (!VAULT_ID_PATTERN.test(vaultId)) return { staleLocks: 0, orphans: 0 };
  const deps = sealDeps(overrides);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return { staleLocks: 0, orphans: 0 };
    throw error;
  }
  let staleLocks = entries.filter(entry => entry.startsWith(`.${vaultId}.lock.stale-`)).length;
  if (entries.includes(`.${vaultId}.lock`) && await lockIsStale(lockPath(root, vaultId), deps)) staleLocks += 1;
  const generations = await listGenerations(root, vaultId);
  const keep = retained(generations, await currentSequence(vaultId, root));
  return { staleLocks, orphans: generations.filter(seq => !keep.has(seq)).length };
}

function indexCorrupt(): Error {
  return new Error("CONTRACT_INDEX_CORRUPT: the vault index is unreadable; run oms contract doctor --fix to rebuild it");
}

/** The index is shared by every vault, so its read-modify-write runs under one root-wide lock. */
async function withIndexLock<T>(root: string, deps: SealDeps, action: () => Promise<T>): Promise<T> {
  await ensureDirectory(root);
  const path = join(root, INDEX_LOCK);
  let held = false;
  for (let attempt = 0; attempt < INDEX_LOCK_ATTEMPTS && !held; attempt += 1) {
    held = await createLock(path, deps);
    if (held) break;
    if (await lockIsStale(path, deps)) {
      await deps.fs.rm(path, { force: true });
      continue;
    }
    await new Promise(resolve => setTimeout(resolve, INDEX_LOCK_WAIT_MS));
  }
  if (!held) throw new Error("CONTRACT_INDEX_BUSY: another process is updating the vault index; try again");
  try {
    return await action();
  } finally {
    await deps.fs.rm(path, { force: true });
  }
}

export interface IndexWriteOptions {
  /** doctor --fix only: move a corrupt index aside and start a new one instead of refusing. */
  readonly rebuildCorrupt?: boolean;
  readonly deps?: Partial<SealDeps>;
}

/** Maps a vault realpath to an id; stale entries for the same id are pruned. A corrupt index is never silently reset. */
export async function writeIndexEntry(vaultRealPath: string, vaultId: string, root: string = storeRoot(), options: IndexWriteOptions = {}): Promise<void> {
  if (!VAULT_ID_PATTERN.test(vaultId)) throw new TypeError("CONTRACT_VAULT_ID_INVALID: vault id is not a UUID");
  const deps = sealDeps(options.deps ?? {});
  await withIndexLock(root, deps, async () => {
    const index = await readIndex(root);
    if (index.state === "corrupt") {
      if (options.rebuildCorrupt !== true) throw indexCorrupt();
      await deps.fs.rename(join(root, "index.json"), join(root, `index.json.corrupt-${deps.now()}`));
    }
    const entries: Record<string, string> = {};
    if (index.state === "ok") {
      for (const [path, id] of Object.entries(index.entries)) {
        if (path === vaultRealPath) continue;
        if (id === vaultId && !await pathExists(path)) continue;
        entries[path] = id;
      }
    }
    entries[vaultRealPath] = vaultId;
    await writeIndex(root, entries);
  });
}

