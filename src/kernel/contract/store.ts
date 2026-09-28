import { lstat, mkdir, open, readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { compareCodePoints, digestBytes, type Digest } from "../conventions/canonical.js";
import { parseStrictJson } from "../conventions/strict-json.js";
import { VAULT_ID_PATTERN } from "../vault/settings.js";
import { manifestDigestOf, NO_DIGEST, type ContractDigest } from "./digest.js";
import { ensureDirectory, syncDirectory, writePrivate } from "./fs-private.js";
import { readSnapshot, readVerifiedDirectory, removeSnapshotTemporaries, SnapshotCorrupt, snapshotInventory, writeSnapshot, type SnapshotRead } from "./generation-snapshot.js";
import {
  classifyLineageTail, LineageAppendFailed, lineageAppender, LineageGap, planLineageTail, readLineage, tailDigest, appendLineageEvents,
  type LineageDraft, type LineageEvent, type LineageGapPolicy, type LineageRead, type LineageReadMode, type LineageTailInput, type SealedGeneration,
} from "./lineage.js";
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
/** Version 2 adds the optional `TemplateContract.meaning`; a version 1 manifest still reads. */
const MANIFEST_VERSION = 2;
const READABLE_MANIFEST_VERSIONS: readonly unknown[] = [1, MANIFEST_VERSION];
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
  /** `digest` is the manifest digest of the generation read: the contract revision. */
  | { readonly state: "ok"; readonly contract: VaultContract; readonly digest: Digest };

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

/** A count bound is a member count: absent, or a whole number no less than zero. */
function isCountBound(value: unknown): boolean {
  return value === undefined || Number.isSafeInteger(value) && (value as number) >= 0;
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
    case "count": return onlyKeys(value, ["kind"], ["min", "max"]) && isCountBound(value["min"]) && isCountBound(value["max"]);
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
  if (!record(value) || !onlyKeys(value, ["source", "sourceHash", "requiredProperties", "narrowedRules", "requiredHeadings"], ["applyFolder", "meaning"])) return false;
  const narrowed = value["narrowedRules"];
  return typeof value["source"] === "string"
    && typeof value["sourceHash"] === "string" && /^sha256:[0-9a-f]{64}$/.test(value["sourceHash"])
    && (value["applyFolder"] === undefined || typeof value["applyFolder"] === "string")
    && (value["meaning"] === undefined || typeof value["meaning"] === "string")
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
  | { readonly state: "ok"; readonly contract: VaultContract; readonly declined: DeclinedSet; readonly digest: Digest }
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
  if (!record(manifest) || !onlyKeys(manifest, ["version", "files"]) || !READABLE_MANIFEST_VERSIONS.includes(manifest["version"])) return unreadable("manifest-mismatch");
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
  return { state: "ok", contract: { folders, properties, templates }, declined, digest: manifestDigestOf(manifestRead.bytes) };
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
  if (read.state === "ok") return { state: "ok", contract: read.contract, digest: read.digest };
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
  /** The directory fsync after the snapshot publish and after the link swap. */
  readonly sync?: (directory: string) => Promise<void>;
  /** The rename that publishes a generation snapshot; kept apart from `rename` (the link swap). */
  readonly snapshotRename?: typeof rename;
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
  /**
   * Re-checks under the seal lock that the inputs the contract was built from still hold,
   * before anything is written. A returned reason aborts the seal with nothing written.
   * The check belongs inside the lock: outside it, the window between the check and the
   * swap is a TOCTOU hole.
   */
  readonly freshness?: () => Promise<string | null>;
  /**
   * The manifest digest the caller built on ("none" for no contract). Checked under the
   * lock after `baseSeq`: a different or unreadable linked generation aborts with
   * CONTRACT_SEAL_CHANGED. Unlike `baseSeq` it also catches a same-seq replacement (ABA).
   */
  readonly expectedParentDigest?: ContractDigest;
  /**
   * Records the seal once the link is swapped, with the lock still held; defaults to a
   * `sealed` lineage event attributed to `human-cli`. A failure throws
   * CONTRACT_LINEAGE_APPEND_FAILED and skips the index write and the GC.
   */
  readonly onSealed?: (sealed: SealedGeneration) => Promise<void>;
  /**
   * What to do when the lineage does not end at the linked generation. `reanchor`
   * (default) records an anchor and warns; `refuse` throws CONTRACT_LINEAGE_GAP with
   * nothing written.
   */
  readonly lineageGapPolicy?: LineageGapPolicy;
}

export interface SealResult {
  readonly seq: number;
  /** The linked generation's manifest digest, read under the lock; "none" when there was none. */
  readonly parentDigest: ContractDigest;
  readonly digest: Digest;
  readonly warnings: readonly string[];
  /** Anchors this seal recorded before its own `sealed` event. */
  readonly anchors: readonly LineageEvent[];
}

interface ParentObservation {
  readonly digest: ContractDigest;
  readonly generation: number | null;
  readonly read: SnapshotRead;
  /** Something is linked but does not verify against its manifest. */
  readonly unreadable: boolean;
}

async function observeParent(root: string, vaultId: string, linked: SequenceObservation): Promise<ParentObservation> {
  if (linked === "none" || linked === "invalid") return { digest: NO_DIGEST, generation: null, read: { state: "missing" }, unreadable: false };
  const read = await readVerifiedDirectory(join(root, linked === "directory" ? vaultId : `.${vaultId}.${linked}`));
  if (read.state !== "ok") return { digest: NO_DIGEST, generation: null, read, unreadable: true };
  return { digest: read.digest, generation: linked === "directory" ? null : linked, read, unreadable: false };
}

function manifestOf(read: SnapshotRead): Record<string, Digest> {
  return read.state === "ok" ? Object.fromEntries([...read.files].map(([path, bytes]) => [path, digestBytes(bytes)])) : {};
}

export interface LineageObservation {
  readonly parent: ParentObservation;
  readonly lineage: LineageRead;
  readonly input: LineageTailInput;
  /** Retained generations that verify, by ascending sequence (a legacy directory has none). */
  readonly sources: readonly { readonly generation: number | null; readonly read: Extract<SnapshotRead, { state: "ok" }> }[];
}

/**
 * Everything the lineage plan reads, all read-only. The seal reads the lineage in
 * `append` mode (a bad line throws); doctor reads it in `display` mode to report it.
 */
export async function observeLineage(root: string, vaultId: string, linked: SequenceObservation, mode: LineageReadMode = "append"): Promise<LineageObservation> {
  const parent = await observeParent(root, vaultId, linked);
  const sources: { generation: number | null; read: Extract<SnapshotRead, { state: "ok" }> }[] = [];
  let previousDigest: Digest | null = null;
  if (typeof linked === "number") {
    for (const seq of [...retained(await listGenerations(root, vaultId), linked)].sort((left, right) => left - right)) {
      const read = seq === linked ? parent.read : await readVerifiedDirectory(join(root, `.${vaultId}.${seq}`));
      if (read.state !== "ok") continue;
      sources.push({ generation: seq, read });
      if (seq !== linked) previousDigest = read.digest;
    }
  } else if (parent.read.state === "ok") {
    sources.push({ generation: null, read: parent.read });
  }
  const lineage = await readLineage(root, vaultId, mode);
  const kept = new Set<string>([...(await snapshotInventory(root, vaultId)).digests, ...sources.map(source => source.read.digest)]);
  return {
    parent,
    lineage,
    sources,
    input: { parentDigest: parent.digest, parentGeneration: parent.generation, parentManifest: manifestOf(parent.read), previousDigest, retained: kept },
  };
}

/**
 * Under the seal lock: snapshot the retained generations (an existing snapshot is only
 * verified), clear `.tmp-*` leftovers, and, when the lineage is empty and something is
 * linked, draft the `bootstrap` anchors that start it. A corrupt snapshot of the linked
 * generation throws CONTRACT_SNAPSHOT_CORRUPT before anything is written; one of N-1
 * is left alone and skipped.
 */
async function bootstrapUnderLock(root: string, vaultId: string, observed: LineageObservation): Promise<{ readonly created: number; readonly anchors: LineageDraft[] }> {
  const P = observed.parent.digest;
  if (P !== NO_DIGEST && (await readSnapshot(root, vaultId, P)).state === "corrupt") throw new SnapshotCorrupt(P);
  let created = 0;
  const anchors: LineageDraft[] = [];
  for (const source of observed.sources) {
    try {
      if ((await writeSnapshot(root, vaultId, source.read.files, source.read.manifestBytes)).created) created += 1;
    } catch (error: unknown) {
      if (error instanceof SnapshotCorrupt && source.read.digest !== P) continue;
      throw error;
    }
    anchors.push({
      kind: "recovered",
      reason: "bootstrap",
      proposer: "pre-lineage",
      generation: source.generation,
      parentDigest: anchors.at(-1)?.digest ?? NO_DIGEST,
      digest: source.read.digest,
      mutations: [],
      manifestDigests: manifestOf(source.read),
    });
  }
  await removeSnapshotTemporaries(root, vaultId);
  const start = observed.lineage.events.length === 0 && P !== NO_DIGEST;
  return { created, anchors: start ? anchors : [] };
}

export interface LineageRecovery {
  /** Snapshots written (existing ones are only verified). */
  readonly snapshots: number;
  readonly anchors: readonly LineageEvent[];
}

async function underSealLock<T>(root: string, vaultId: string, action: () => Promise<T>): Promise<T> {
  if (!VAULT_ID_PATTERN.test(vaultId)) throw new TypeError("CONTRACT_VAULT_ID_INVALID: vault id is not a UUID");
  const deps = sealDeps({});
  await ensureDirectory(root);
  await acquireLock(root, vaultId, deps);
  try {
    return await action();
  } finally {
    await deps.fs.rm(lockPath(root, vaultId), { force: true });
  }
}

/**
 * Snapshots every retained generation (and a legacy `<id>` directory) under the seal lock
 * and, when the lineage is empty, records `bootstrap` anchors for them in sequence order.
 * Generations the seal collected before this ran are gone and cannot be recovered.
 */
export async function bootstrapSnapshots(root: string, vaultId: string): Promise<LineageRecovery> {
  return underSealLock(root, vaultId, async () => {
    const observed = await observeLineage(root, vaultId, await currentSequence(vaultId, root));
    const boot = await bootstrapUnderLock(root, vaultId, observed);
    const anchors = await appendLineageEvents(root, vaultId, boot.anchors, { expectTail: tailDigest(observed.lineage.events) });
    return { snapshots: boot.created, anchors };
  });
}

/**
 * The doctor repair: bootstrap, then bring the lineage up to the linked generation. A
 * seal that crashed before its event and a lost link are recorded under either policy;
 * any other gap is anchored only under `reanchor`, and `refuse` throws
 * CONTRACT_LINEAGE_GAP before anything is written. A lineage already current is a no-op.
 */
export async function recoverLineage(root: string, vaultId: string, options: { readonly policy: LineageGapPolicy }): Promise<LineageRecovery> {
  return underSealLock(root, vaultId, async () => {
    const observed = await observeLineage(root, vaultId, await currentSequence(vaultId, root));
    const classified = classifyLineageTail(observed.lineage.events, observed.input);
    if (classified.outcome === "gap" && options.policy === "refuse") throw new LineageGap(tailDigest(observed.lineage.events), observed.parent.digest);
    const boot = await bootstrapUnderLock(root, vaultId, observed);
    const drafts = classified.outcome === "current" ? boot.anchors : [classified.anchor];
    const anchors = await appendLineageEvents(root, vaultId, drafts, { expectTail: tailDigest(observed.lineage.events) });
    return { snapshots: boot.created, anchors };
  });
}

/**
 * CLI + evolution seal-gate. Under the `.<id>.lock`: check nothing sealed since `baseSeq`
 * and that the linked generation is `expectedParentDigest`, plan the lineage tail (a gap
 * under `refuse` stops here), check freshness, snapshot the retained generations and
 * record any anchors, drop orphan generations, write `.<id>.<seq>/` (manifest last),
 * then keep this durability order: publish its snapshot and fsync `generations/`, swap
 * the `<id>` link by rename and fsync the root, append the lineage event (`onSealed`),
 * record the index entry, keep only N and N-1. A failure before the swap leaves the
 * previous contract in place (and possibly an unsealed snapshot, which is never removed).
 */
export async function sealContract(request: SealRequest, root: string = storeRoot(), overrides: Partial<SealDeps> = {}): Promise<SealResult> {
  const id = request.vaultId;
  if (!VAULT_ID_PATTERN.test(id)) throw new TypeError("CONTRACT_VAULT_ID_INVALID: vault id is not a UUID");
  const files = contractFiles(request.contract, request.declined);
  const deps = sealDeps(overrides);
  await ensureDirectory(root);
  await acquireLock(root, id, deps);
  try {
    if ((await readIndex(root)).state === "corrupt") throw indexCorrupt();
    const linked = await currentSequence(id, root);
    if (request.baseSeq !== undefined && linked !== request.baseSeq) throw sealChanged();
    const observed = await observeLineage(root, id, linked);
    const parentDigest = observed.parent.digest;
    if (request.expectedParentDigest !== undefined && (observed.parent.unreadable || parentDigest !== request.expectedParentDigest)) throw sealChanged();
    const warnings: string[] = [];
    if (observed.parent.unreadable) warnings.push("lineage-parent-unreadable");
    if (observed.lineage.truncatedTail) warnings.push("lineage-truncated-tail");
    const plan = planLineageTail(observed.lineage.events, observed.input, request.lineageGapPolicy ?? "reanchor");
    if (plan.action === "refuse") throw new LineageGap(plan.tailDigest, plan.parentDigest);
    // Under the lock and before the first write, so a source that moved during the
    // interview cannot be sealed as the bytes the owner was asked about.
    const stale = request.freshness === undefined ? null : await request.freshness();
    if (stale !== null) throw new Error(`CONTRACT_SEAL_STALE: ${stale}`);

    const boot = await bootstrapUnderLock(root, id, observed);
    if (plan.action === "append") warnings.push(...plan.warnings);
    const anchors = await appendLineageEvents(root, id, [...boot.anchors, ...(plan.action === "append" ? plan.anchors : [])], { expectTail: tailDigest(observed.lineage.events) });

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
    const sync = deps.fs.sync ?? syncDirectory;
    const digests: Record<string, Digest> = {};
    let manifestText = "";
    try {
      await mkdir(directory, { mode: 0o700 });
      await ensureDirectory(directory);
      for (const [path, content] of [...files].sort(([left], [right]) => compareCodePoints(left, right))) {
        if (path.includes("/")) await ensureDirectory(join(directory, TEMPLATES));
        await writePrivate(join(directory, ...path.split("/")), content);
        digests[path] = digestBytes(content);
      }
      manifestText = stringify({ version: MANIFEST_VERSION, files: digests });
      await writePrivate(join(directory, MANIFEST), manifestText);
      await syncDirectory(directory);
      await writeSnapshot(root, id, files, manifestText, { ...(deps.fs.snapshotRename === undefined ? {} : { rename: deps.fs.snapshotRename }), sync });

      await deps.fs.symlink(generation, temporary);
      if (migrating) {
        await deps.fs.rename(join(root, id), migrated);
        movedAside = true;
      }
      await deps.fs.rename(temporary, join(root, id));
      swapped = true;
      await sync(root);
    } finally {
      if (!swapped) {
        if (movedAside) await deps.fs.rename(migrated, join(root, id));
        await deps.fs.rm(temporary, { force: true });
        await deps.fs.rm(directory, { recursive: true, force: true });
      }
    }

    const digest = manifestDigestOf(manifestText);
    const sealed: SealedGeneration = { root, vaultId: id, seq, parentDigest, digest, manifestDigests: digests };
    try {
      await (request.onSealed ?? lineageAppender())(sealed);
    } catch (error: unknown) {
      throw new LineageAppendFailed(seq, digest, error);
    }

    await writeIndexEntry(request.vaultRealPath, id, root);

    const survivors = retained(await listGenerations(root, id), seq);
    for (const old of await listGenerations(root, id)) {
      if (!survivors.has(old)) await deps.fs.rm(join(root, `.${id}.${old}`), { recursive: true, force: true });
    }
    await syncDirectory(root);
    return { seq, parentDigest, digest, warnings, anchors };
  } finally {
    await deps.fs.rm(lockPath(root, id), { force: true });
  }
}

function sealChanged(): Error {
  return new Error("CONTRACT_SEAL_CHANGED: the contract was sealed elsewhere meanwhile; run oms setup again to review the differences");
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
  return new Error("CONTRACT_INDEX_CORRUPT: the vault index is unreadable; run oms doctor contract --fix to rebuild it");
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

