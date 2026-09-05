import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  canonicalModelIdentityKey,
  MODEL_CAPABILITY_ENV_PAIRS,
  parseModelsConfig,
  readModelsConfig,
  resolveModelCapabilities,
  resolveModelCapability,
  type InstalledModelArtifact,
  type ModelCapability,
  type ModelCapabilityResolution,
  type ModelsConfigV1,
  type PortableModelSelection,
} from "./config.js";

export const EMBEDDING_PROVIDER_ENV = MODEL_CAPABILITY_ENV_PAIRS.embed[0];
export const EMBEDDING_MODEL_ENV = MODEL_CAPABILITY_ENV_PAIRS.embed[1];
export const INSTALLED_MODELS_RECEIPT = "installed-models.json" as const;
export const INSTALLED_MODELS_SCHEMA_VERSION = 1 as const;

export interface EmbeddingModelDescriptor {
  readonly provider: "gguf";
  readonly model: string;
  readonly revision: string;
  readonly sha256: string;
  readonly dimensions: number;
  readonly context: number;
  readonly mrlDim: number;
  readonly normalization: string;
  readonly prefixScheme: "embeddinggemma-v1" | "qwen3-embedding-v1";
  readonly url?: string;
  readonly filename?: string;
  readonly path?: string;
}

export interface InstalledModelsReceipt {
  readonly schemaVersion: 1;
  readonly artifacts: readonly InstalledModelArtifact[];
  readonly defaults: readonly string[];
}

export interface ResolveEmbeddingModelOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly request?: PortableModelSelection;
  readonly vaultConfig?: ModelsConfigV1 | null;
  readonly installedReceipt?: InstalledModelsReceipt;
  readonly cacheDir?: string;
}

export interface EmbeddingModelResolution {
  readonly available: boolean;
  readonly source: ModelCapabilityResolution["source"];
  readonly descriptor?: EmbeddingModelDescriptor;
  readonly equivalentSources: ModelCapabilityResolution["equivalentSources"];
  readonly shadowedSources: ModelCapabilityResolution["shadowedSources"];
  readonly guidance?: string;
}

export interface AcquireEmbeddingModelOptions {
  readonly descriptor: EmbeddingModelDescriptor & { readonly url: string };
  readonly cacheDir?: string;
  readonly vault?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface AcquiredEmbeddingModel {
  readonly descriptor: EmbeddingModelDescriptor;
  readonly cachePath: string;
}

interface ModelSetAcquisitionCommon {
  readonly provider: "gguf";
  readonly model: string;
  readonly revision: string;
  readonly sha256: string;
  readonly promptScheme?: string;
  readonly filename?: string;
}

/**
 * Where the bytes come from: downloaded, or already on the user's disk.
 *
 * Modelled as a union rather than two optional fields so the compiler enforces what
 * the parser enforces at runtime — exactly one source. With both optional, code that
 * forgot to handle the local case would still typecheck and then fetch `undefined`.
 */
export type ModelSetAcquisitionSource =
  | { readonly url: string; readonly path?: undefined }
  | { readonly path: string; readonly url?: undefined };

export type ModelSetAcquisitionArtifact = ModelSetAcquisitionCommon & ModelSetAcquisitionSource;

export type EmbedModelSetAcquisitionArtifact = ModelSetAcquisitionCommon & ModelSetAcquisitionSource & {
  readonly promptScheme: "embeddinggemma-v1" | "qwen3-embedding-v1";
  readonly dimensions: number;
  readonly contextLength: number;
  readonly mrlDim: number;
  readonly normalization: string;
};

export interface ModelSetAcquisitionManifest {
  readonly schemaVersion: 1;
  readonly embed: EmbedModelSetAcquisitionArtifact;
  readonly rerank?: ModelSetAcquisitionArtifact;
  readonly generate?: ModelSetAcquisitionArtifact & { readonly promptScheme: "qmd-query-expansion-v2.8.3" };
}

export interface AcquireModelSetOptions {
  readonly manifest: ModelSetAcquisitionManifest | unknown;
  readonly cacheDir?: string;
  readonly vault?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface AcquiredModelSet {
  readonly config: ModelsConfigV1;
  readonly receipt: InstalledModelsReceipt;
  readonly artifacts: readonly InstalledModelArtifact[];
}

export interface ModelSelectionProposal {
  readonly vault: string;
  readonly current: ModelsConfigV1 | null;
  readonly proposed: ModelsConfigV1;
  readonly approvalDigest: `sha256:${string}`;
  readonly changed: boolean;
}

export interface ModelSelectionReceipt extends ModelSelectionProposal {
  readonly status: "written" | "unchanged";
  readonly path: string;
  readonly verified: true;
}

const SHA256 = /^[a-f0-9]{64}$/;
const MUTABLE_REVISIONS = new Set(["latest", "main", "master", "head"]);

export const PINNED_DEFAULT_EMBEDDING_MODEL: EmbeddingModelDescriptor & { readonly url: string } = {
  provider: "gguf",
  model: "embeddinggemma-300M-Q8_0.gguf",
  revision: "0f741b5a6585bd53aeb15cd1372c56f2a0f65e12",
  sha256: "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63",
  dimensions: 768,
  context: 2048,
  mrlDim: 0,
  normalization: "l2",
  prefixScheme: "embeddinggemma-v1",
  filename: "embeddinggemma-300M-Q8_0.gguf",
  url: "https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/0f741b5a6585bd53aeb15cd1372c56f2a0f65e12/embeddinggemma-300M-Q8_0.gguf",
};

function fail(message: string): never {
  throw new Error(`Invalid ${INSTALLED_MODELS_RECEIPT}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} contains unknown key "${key}".`);
  }
}

function nonblank(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    fail(`${label} must be a nonblank string without surrounding whitespace.`);
  }
  return value;
}

function descriptorError(message: string): never {
  throw new Error(`Invalid embedding model descriptor: ${message}`);
}

function descriptorString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    descriptorError(`${label} must be a nonblank string without surrounding whitespace.`);
  }
  return value;
}

function descriptorPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    descriptorError(`${label} must be a positive integer.`);
  }
  return value;
}

function descriptorNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    descriptorError(`${label} must be a nonnegative integer.`);
  }
  return value;
}

function assertDescriptor(value: unknown, requirePath: boolean): EmbeddingModelDescriptor {
  if (!isRecord(value)) descriptorError("must be an object.");
  const allowed = ["provider", "model", "revision", "sha256", "dimensions", "context", "mrlDim", "normalization", "prefixScheme", "url", "filename", "path"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) descriptorError(`contains unknown key "${key}".`);
  }
  if (value.provider !== "gguf") descriptorError('provider must be "gguf".');
  const model = descriptorString(value.model, "model");
  const revision = descriptorString(value.revision, "revision");
  if (MUTABLE_REVISIONS.has(revision.toLowerCase())) descriptorError("revision must be immutable.");
  const sha256 = descriptorString(value.sha256, "sha256");
  if (!SHA256.test(sha256)) descriptorError("sha256 must be lowercase 64-character hexadecimal.");
  const dimensions = descriptorPositiveInteger(value.dimensions, "dimensions");
  const context = descriptorPositiveInteger(value.context, "context");
  const mrlDim = descriptorNonnegativeInteger(value.mrlDim, "mrlDim");
  const normalization = descriptorString(value.normalization, "normalization");
  const prefixScheme = value.prefixScheme;
  if (prefixScheme !== "embeddinggemma-v1" && prefixScheme !== "qwen3-embedding-v1") {
    descriptorError("prefixScheme must be embeddinggemma-v1 or qwen3-embedding-v1.");
  }
  try {
    canonicalModelIdentityKey({ provider: "gguf", model, revision, sha256, promptScheme: prefixScheme });
  } catch {
    descriptorError("provider/model/revision/sha256/prefixScheme must be a strict portable selection.");
  }
  const url = value.url === undefined ? undefined : descriptorString(value.url, "url");
  const filename = value.filename === undefined ? undefined : descriptorString(value.filename, "filename");
  const pathname = value.path === undefined ? undefined : descriptorString(value.path, "path");
  if (pathname !== undefined && !path.isAbsolute(pathname)) descriptorError("path must be absolute.");
  if (requirePath && pathname === undefined) descriptorError("path is required at runtime.");
  return {
    provider: "gguf", model, revision, sha256, dimensions, context,
    mrlDim, normalization, prefixScheme,
    ...(url === undefined ? {} : { url }), ...(filename === undefined ? {} : { filename }), ...(pathname === undefined ? {} : { path: pathname }),
  };
}

/** Validate a strict acquisition/runtime embedding descriptor. */
export function parseEmbeddingModelDescriptor(input: unknown, options: { readonly requirePath?: boolean } = {}): EmbeddingModelDescriptor {
  return assertDescriptor(input, options.requirePath === true);
}

function parseSelection(value: unknown, index: number): PortableModelSelection {
  if (!isRecord(value)) fail(`artifacts[${index}].selection must be an object.`);
  exactKeys(value, ["provider", "model", "revision", "sha256", "promptScheme"], `artifacts[${index}].selection`);
  if (value.provider !== "gguf") fail(`artifacts[${index}].selection.provider must be "gguf".`);
  const model = nonblank(value.model, `artifacts[${index}].selection.model`);
  const revision = nonblank(value.revision, `artifacts[${index}].selection.revision`);
  const sha256 = nonblank(value.sha256, `artifacts[${index}].selection.sha256`);
  const promptScheme = value.promptScheme;
  if (promptScheme !== undefined && typeof promptScheme !== "string") {
    fail(`artifacts[${index}].selection.promptScheme must be a string.`);
  }
  return {
    provider: "gguf",
    model,
    revision,
    sha256,
    ...(promptScheme === undefined ? {} : { promptScheme }),
  };
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    fail(`${label} must be a positive integer.`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    fail(`${label} must be a nonnegative integer.`);
  }
  return value;
}

function parseArtifact(value: unknown, index: number): InstalledModelArtifact {
  if (!isRecord(value)) fail(`artifacts[${index}] must be an object.`);
  exactKeys(value, ["capability", "selection", "path", "embedShape"], `artifacts[${index}]`);
  if (value.capability !== "embed" && value.capability !== "rerank" && value.capability !== "generate") {
    fail(`artifacts[${index}].capability is invalid.`);
  }
  const selection = parseSelection(value.selection, index);
  try {
    canonicalModelIdentityKey(selection);
  } catch (error: unknown) {
    fail(`artifacts[${index}].selection is invalid: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (
    (value.capability === "embed" && selection.promptScheme !== "embeddinggemma-v1" && selection.promptScheme !== "qwen3-embedding-v1") ||
    (value.capability === "rerank" && selection.promptScheme !== undefined) ||
    (value.capability === "generate" && selection.promptScheme !== "qmd-query-expansion-v2.8.3")
  ) {
    fail(`artifacts[${index}].selection does not match its capability.`);
  }
  const pathname = nonblank(value.path, `artifacts[${index}].path`);
  if (!path.isAbsolute(pathname)) fail(`artifacts[${index}].path must be absolute.`);
  if (value.capability !== "embed") {
    if (value.embedShape !== undefined) fail(`artifacts[${index}].embedShape is only valid for embed.`);
    return { capability: value.capability, selection, path: pathname };
  }
  if (!isRecord(value.embedShape)) fail(`artifacts[${index}].embedShape is required for embed.`);
  exactKeys(value.embedShape, ["dimensions", "contextLength", "mrlDim", "normalization"], `artifacts[${index}].embedShape`);
  const dimensions = positiveInteger(value.embedShape.dimensions, `artifacts[${index}].embedShape.dimensions`);
  const contextLength = positiveInteger(value.embedShape.contextLength, `artifacts[${index}].embedShape.contextLength`);
  const mrlDim = nonnegativeInteger(value.embedShape.mrlDim, `artifacts[${index}].embedShape.mrlDim`);
  const normalization = nonblank(value.embedShape.normalization, `artifacts[${index}].embedShape.normalization`);
  return { capability: "embed", selection, path: pathname, embedShape: { dimensions, contextLength, mrlDim, normalization } };
}

function acquisitionUrl(value: unknown, label: string): string {
  const url = nonblank(value, `${label}.url`);
  let parsed: URL;
  try { parsed = new URL(url); } catch { fail(`${label}.url must be an absolute https URL.`); }
  if (parsed.protocol !== "https:") fail(`${label}.url must be an absolute https URL.`);
  return url;
}

/**
 * Validate an absolute path to a model file the user already has on disk.
 *
 * This exists because download was the only way in. Anyone who already runs these
 * models locally — the common case, since the weights are shared with other tools —
 * had to re-download gigabytes that were sitting on their filesystem, or hand-write
 * the installed receipt through an internal API. A capability reachable only by
 * hand-editing internal state is not a shipped capability.
 *
 * Registration is by reference, not by copy: re-copying a 2.9 GB GGUF to say "I have
 * this file" wastes the disk the feature exists to save. The receipt readers already
 * re-verify every artifact's path and checksum on load, so a file that later moves
 * or changes fails loudly instead of silently serving different vectors.
 */
function acquisitionLocalPath(value: unknown, label: string): string {
  const pathname = nonblank(value, `${label}.path`);
  if (!path.isAbsolute(pathname)) fail(`${label}.path must be an absolute filesystem path.`);
  if (pathname !== path.normalize(pathname)) {
    fail(`${label}.path must be normalized, without "." or ".." segments.`);
  }
  return pathname;
}

function acquisitionFilename(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const filename = nonblank(value, `${label}.filename`);
  if (filename === "." || filename === ".." || /[\\/]/.test(filename) || path.basename(filename) !== filename) {
    fail(`${label}.filename must be a portable basename.`);
  }
  return filename;
}

function portableManifestSelection(value: {
  readonly provider: unknown;
  readonly model: unknown;
  readonly revision: unknown;
  readonly sha256: unknown;
  readonly promptScheme?: unknown;
}, capability: ModelCapability): PortableModelSelection {
  const selection = {
    provider: value.provider,
    model: value.model,
    revision: value.revision,
    sha256: value.sha256,
    ...(value.promptScheme === undefined ? {} : { promptScheme: value.promptScheme }),
  };
  const parsed = parseModelsConfig({
    schemaVersion: 1,
    embed: capability === "embed"
      ? selection
      : { provider: "gguf", model: "placeholder.gguf", revision: "v1", sha256: "0".repeat(64), promptScheme: "embeddinggemma-v1" },
    ...(capability === "rerank" ? { rerank: selection } : {}),
    ...(capability === "generate" ? { generate: selection } : {}),
  })[capability];
  if (parsed === undefined) fail(`manifest.${capability} selection is required.`);
  return parsed;
}

function parseManifestArtifact(value: unknown, capability: ModelCapability): ModelSetAcquisitionArtifact {
  const label = `manifest.${capability}`;
  if (!isRecord(value)) fail(`${label} must be an object.`);
  const allowed = capability === "embed"
    ? ["provider", "model", "revision", "sha256", "promptScheme", "url", "path", "filename", "dimensions", "contextLength", "mrlDim", "normalization"]
    : ["provider", "model", "revision", "sha256", "promptScheme", "url", "path", "filename"];
  exactKeys(value, allowed, label);
  const selection = portableManifestSelection({
    provider: value.provider,
    model: value.model,
    revision: value.revision,
    sha256: value.sha256,
    promptScheme: value.promptScheme,
  }, capability);
  // Exactly one source. Accepting both would leave it ambiguous which bytes the
  // checksum refers to, and accepting neither gives nothing to install.
  if (value.url !== undefined && value.path !== undefined) {
    fail(`${label} must set either url or path, not both.`);
  }
  if (value.url === undefined && value.path === undefined) {
    fail(`${label} must set either url (to download) or path (already on disk).`);
  }
  const source = value.path === undefined
    ? { url: acquisitionUrl(value.url, label) }
    : { path: acquisitionLocalPath(value.path, label) };
  const filename = acquisitionFilename(value.filename, label);
  const base = { ...selection, ...source, ...(filename === undefined ? {} : { filename }) };
  if (capability !== "embed") return base;
  return {
    ...base,
    dimensions: positiveInteger(value.dimensions, `${label}.dimensions`),
    contextLength: positiveInteger(value.contextLength, `${label}.contextLength`),
    mrlDim: nonnegativeInteger(value.mrlDim, `${label}.mrlDim`),
    normalization: nonblank(value.normalization, `${label}.normalization`),
  } as EmbedModelSetAcquisitionArtifact;
}

/** Parse a strict setup-only, portable multi-capability acquisition manifest. */
export function parseModelSetAcquisitionManifest(input: string | unknown): ModelSetAcquisitionManifest {
  let value: unknown = input;
  if (typeof input === "string") {
    try { value = JSON.parse(input); } catch { fail("acquisition manifest is not valid JSON."); }
  }
  if (!isRecord(value)) fail("acquisition manifest must be an object.");
  exactKeys(value, ["schemaVersion", "embed", "rerank", "generate"], "acquisition manifest");
  if (value.schemaVersion !== 1) fail("acquisition manifest schemaVersion must be 1.");
  if (!("embed" in value)) fail("acquisition manifest embed is required.");
  const embed = parseManifestArtifact(value.embed, "embed") as EmbedModelSetAcquisitionArtifact;
  const rerank = value.rerank === undefined ? undefined : parseManifestArtifact(value.rerank, "rerank");
  const generate = value.generate === undefined ? undefined : parseManifestArtifact(value.generate, "generate") as ModelSetAcquisitionManifest["generate"];
  const entries: Array<[ModelCapability, ModelSetAcquisitionArtifact]> = [
    ["embed", embed],
    ...(rerank === undefined ? [] : [["rerank", rerank] as [ModelCapability, ModelSetAcquisitionArtifact]]),
    ...(generate === undefined ? [] : [["generate", generate] as [ModelCapability, ModelSetAcquisitionArtifact]]),
  ];
  if (new Set(entries.map(([capability, entry]) => canonicalModelIdentityKey(
    portableManifestSelection(entry, capability),
  ))).size !== entries.length) {
    fail("acquisition manifest must not contain duplicate model identities.");
  }
  return { schemaVersion: 1, embed, ...(rerank === undefined ? {} : { rerank }), ...(generate === undefined ? {} : { generate }) };
}

/** Convert a strict setup acquisition manifest into its portable runtime selection config. */
export function modelsConfigFromAcquisitionManifest(input: ModelSetAcquisitionManifest | unknown): ModelsConfigV1 {
  const manifest = parseModelSetAcquisitionManifest(input);
  return parseModelsConfig({
    schemaVersion: 1,
    embed: portableManifestSelection(manifest.embed, "embed"),
    ...(manifest.rerank === undefined ? {} : { rerank: portableManifestSelection(manifest.rerank, "rerank") }),
    ...(manifest.generate === undefined ? {} : { generate: portableManifestSelection(manifest.generate, "generate") }),
  });
}

/** Parse the strict setup-owned installed model-set receipt. */
export function parseInstalledModelsReceipt(input: string | unknown): InstalledModelsReceipt {
  let value: unknown = input;
  if (typeof input === "string") {
    try { value = JSON.parse(input); } catch { fail("is not valid JSON."); }
  }
  if (!isRecord(value)) fail("must be an object.");
  exactKeys(value, ["schemaVersion", "artifacts", "defaults"], "top level");
  if (value.schemaVersion !== INSTALLED_MODELS_SCHEMA_VERSION) fail(`schemaVersion must be ${INSTALLED_MODELS_SCHEMA_VERSION}.`);
  if (!Array.isArray(value.artifacts)) fail("artifacts must be an array.");
  if (!Array.isArray(value.defaults)) fail("defaults must be an array of nonblank identity keys.");
  const artifacts = value.artifacts.map(parseArtifact);
  const artifactKeys = artifacts.map((artifact) => `${artifact.capability}\u0000${canonicalModelIdentityKey(artifact.selection)}`);
  if (new Set(artifactKeys).size !== artifactKeys.length) fail("artifacts must not contain duplicate capability and identity pairs.");
  const defaults = value.defaults.map((entry, index) => {
    if (typeof entry !== "string" || entry === "") {
      fail(`defaults[${index}] must be a nonblank identity key.`);
    }
    return entry;
  });
  if (new Set(defaults).size !== defaults.length) fail("defaults must not contain duplicates.");
  for (const identity of defaults) {
    if (artifacts.filter((artifact) => canonicalModelIdentityKey(artifact.selection) === identity).length !== 1) {
      fail("each default must identify exactly one artifact.");
    }
  }
  return { schemaVersion: INSTALLED_MODELS_SCHEMA_VERSION, artifacts, defaults };
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyArtifactSync(artifact: InstalledModelArtifact): void {
  let status;
  try { status = statSync(artifact.path); } catch { fail("an installed artifact is missing or unreadable."); }
  if (!status.isFile()) fail("an installed artifact is not a regular file.");
  if (sha256Bytes(readFileSync(artifact.path)) !== artifact.selection.sha256) fail("an installed artifact checksum does not match its selection.");
}

async function verifyArtifact(artifact: InstalledModelArtifact): Promise<void> {
  let status;
  try { status = await stat(artifact.path); } catch { fail("an installed artifact is missing or unreadable."); }
  if (!status.isFile()) fail("an installed artifact is not a regular file.");
  if (sha256Bytes(await readFile(artifact.path)) !== artifact.selection.sha256) fail("an installed artifact checksum does not match its selection.");
}

export function embeddingModelCacheDir(options: { readonly cacheDir?: string; readonly env?: Readonly<Record<string, string | undefined>>; readonly homeDir?: string } = {}): string {
  if (options.cacheDir?.trim()) return path.resolve(options.cacheDir);
  const xdg = options.env?.XDG_CACHE_HOME?.trim() ?? process.env.XDG_CACHE_HOME?.trim() ?? "";
  return path.resolve(xdg || path.join(options.homeDir ?? homedir(), ".cache"), "oms", "models");
}

/** Read and verify all installed model artifacts synchronously. Only a missing receipt is empty. */
export function readInstalledModelsReceiptSync(options: { readonly cacheDir?: string } = {}): InstalledModelsReceipt {
  const filename = path.join(embeddingModelCacheDir(options), INSTALLED_MODELS_RECEIPT);
  let raw: string;
  try { raw = readFileSync(filename, "utf8"); } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return { schemaVersion: 1, artifacts: [], defaults: [] };
    throw error;
  }
  const receipt = parseInstalledModelsReceipt(raw);
  receipt.artifacts.forEach(verifyArtifactSync);
  return receipt;
}

/** Read and verify all installed model artifacts. Only a missing receipt is empty. */
export async function readInstalledModelsReceipt(options: { readonly cacheDir?: string } = {}): Promise<InstalledModelsReceipt> {
  const filename = path.join(embeddingModelCacheDir(options), INSTALLED_MODELS_RECEIPT);
  let raw: string;
  try { raw = await readFile(filename, "utf8"); } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return { schemaVersion: 1, artifacts: [], defaults: [] };
    throw error;
  }
  const receipt = parseInstalledModelsReceipt(raw);
  await Promise.all(receipt.artifacts.map(verifyArtifact));
  return receipt;
}

function descriptorFromArtifact(artifact: InstalledModelArtifact): EmbeddingModelDescriptor {
  if (artifact.capability !== "embed" || artifact.embedShape === undefined) throw new Error("Installed embed artifact is missing embed metadata.");
  const shape: unknown = artifact.embedShape;
  if (!isRecord(shape)) throw new Error("Installed embed artifact has invalid embed metadata.");
  return parseEmbeddingModelDescriptor({
    provider: artifact.selection.provider, model: artifact.selection.model, revision: artifact.selection.revision,
    sha256: artifact.selection.sha256, dimensions: shape.dimensions, context: shape.contextLength,
    mrlDim: shape.mrlDim, normalization: shape.normalization,
    prefixScheme: artifact.selection.promptScheme, path: artifact.path,
  }, { requirePath: true });
}

function resolutionFromCapability(result: ModelCapabilityResolution): EmbeddingModelResolution {
  if (!result.available) return { available: false, source: result.source, equivalentSources: result.equivalentSources, shadowedSources: result.shadowedSources, ...(result.guidance === undefined ? {} : { guidance: result.guidance }) };
  if (result.artifact === undefined) throw new Error("Resolved embedding model has no installed artifact.");
  return { available: true, source: result.source, descriptor: descriptorFromArtifact(result.artifact), equivalentSources: result.equivalentSources, shadowedSources: result.shadowedSources };
}

/** Resolve embedding through the shared strict capability resolver; this never downloads. */
export function resolveEmbeddingModel(options: ResolveEmbeddingModelOptions = {}): EmbeddingModelResolution {
  const receipt = options.installedReceipt ?? readInstalledModelsReceiptSync({ cacheDir: options.cacheDir });
  return resolutionFromCapability(resolveModelCapability({ capability: "embed", request: options.request, env: options.env, vaultConfig: options.vaultConfig, installedArtifacts: receipt.artifacts, setupDefaults: receipt.defaults }));
}

/** Async cache adapter over the shared strict capability resolver; this never downloads. */
export async function resolveEmbeddingModelFromCache(options: ResolveEmbeddingModelOptions = {}): Promise<EmbeddingModelResolution> {
  const receipt = options.installedReceipt ?? await readInstalledModelsReceipt({ cacheDir: options.cacheDir });
  return resolutionFromCapability(resolveModelCapability({ capability: "embed", request: options.request, env: options.env, vaultConfig: options.vaultConfig, installedArtifacts: receipt.artifacts, setupDefaults: receipt.defaults }));
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function writeAtomic(filename: string, contents: Uint8Array | string): Promise<void> {
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  try { await writeFile(temporary, contents, { flag: "wx" }); await rename(temporary, filename); } finally { await rm(temporary, { force: true }); }
}

function manifestEntries(manifest: ModelSetAcquisitionManifest): readonly [ModelCapability, ModelSetAcquisitionArtifact][] {
  return [
    ["embed", manifest.embed],
    ...(manifest.rerank === undefined ? [] : [["rerank", manifest.rerank] as [ModelCapability, ModelSetAcquisitionArtifact]]),
    ...(manifest.generate === undefined ? [] : [["generate", manifest.generate] as [ModelCapability, ModelSetAcquisitionArtifact]]),
  ];
}

function installedArtifact(capability: ModelCapability, acquisition: ModelSetAcquisitionArtifact, pathname: string): InstalledModelArtifact {
  const selection: PortableModelSelection = {
    provider: acquisition.provider, model: acquisition.model, revision: acquisition.revision, sha256: acquisition.sha256,
    ...(acquisition.promptScheme === undefined ? {} : { promptScheme: acquisition.promptScheme }),
  };
  if (capability !== "embed") return { capability, selection, path: pathname };
  const embed = acquisition as EmbedModelSetAcquisitionArtifact;
  return {
    capability: "embed", selection, path: pathname,
    embedShape: { dimensions: embed.dimensions, contextLength: embed.contextLength, mrlDim: embed.mrlDim, normalization: embed.normalization },
  };
}

/** Download, verify, and atomically publish a strict multi-capability setup receipt. */
export async function acquireModelSet(options: AcquireModelSetOptions): Promise<AcquiredModelSet> {
  const manifest = parseModelSetAcquisitionManifest(options.manifest);
  const cacheRoot = embeddingModelCacheDir({ cacheDir: options.cacheDir });
  if (options.vault !== undefined && isInside(cacheRoot, path.resolve(options.vault))) throw new Error("Model cache must be outside the vault.");
  await mkdir(cacheRoot, { recursive: true });
  const current = await readInstalledModelsReceipt({ cacheDir: options.cacheDir });
  const entries = manifestEntries(manifest);
  const planned = entries.map(([capability, acquisition]) => {
    // A local file is registered where it already lives. Copying it into the cache
    // would double the disk cost of models that are often shared with other tools,
    // which is the whole reason to point at them instead of re-downloading.
    if (acquisition.path !== undefined) {
      return {
        capability,
        acquisition,
        cachePath: acquisition.path,
        local: true as const,
        artifact: installedArtifact(capability, acquisition, acquisition.path),
      };
    }
    const filename = acquisition.filename ?? acquisition.model;
    const cachePath = path.join(cacheRoot, `${capability}-${acquisition.sha256}-${filename}`);
    return { capability, acquisition, cachePath, local: false as const, artifact: installedArtifact(capability, acquisition, cachePath) };
  });
  const staged: string[] = [];
  try {
    for (let index = 0; index < planned.length; index += 1) {
      const item = planned[index]!;
      if (item.local) {
        // Verify the declared checksum against the real bytes. Registration by
        // reference is only safe because a wrong or moved file fails here rather
        // than silently producing vectors from a different model.
        let bytes: Uint8Array;
        try {
          const canonicalPath = await realpath(item.cachePath);
          const metadata = await stat(canonicalPath);
          if (!metadata.isFile()) {
            throw new Error(`Model path for ${item.capability} is not a regular file: ${canonicalPath}`);
          }
          if (
            options.vault !== undefined
            && isInside(canonicalPath, await realpath(path.resolve(options.vault)))
          ) {
            throw new Error(
              `Model file for ${item.capability} must stay outside the vault: ${canonicalPath}`,
            );
          }
          // Persist the canonical target, not a mutable symlink spelling. Receipt
          // verification therefore checks the exact file approved here.
          item.cachePath = canonicalPath;
          item.artifact = installedArtifact(item.capability, item.acquisition, canonicalPath);
          bytes = await readFile(canonicalPath);
        } catch (error: unknown) {
          if (isRecord(error) && error.code === "ENOENT") {
            throw new Error(`Model file not found for ${item.capability}: ${item.cachePath}`);
          }
          throw error;
        }
        if (sha256Bytes(bytes) !== item.acquisition.sha256) {
          throw new Error(
            `Model SHA-256 checksum mismatch for ${item.capability} at ${item.cachePath}.`,
          );
        }
        continue;
      }
      try {
        const existing = await readFile(item.cachePath);
        if (sha256Bytes(existing) === item.acquisition.sha256) continue;
      } catch (error: unknown) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      }
      const response = await (options.fetchImpl ?? fetch)(item.acquisition.url);
      if (!response.ok) throw new Error(`Model download failed: ${response.status} ${response.statusText}.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (sha256Bytes(bytes) !== item.acquisition.sha256) throw new Error("Model SHA-256 checksum mismatch.");
      const temporary = `${item.cachePath}.stage-${index}.tmp`;
      await writeFile(temporary, bytes, { flag: "wx" });
      staged.push(temporary);
    }
    for (const temporary of staged) {
      const destination = temporary.replace(/\.stage-\d+\.tmp$/, "");
      await rename(temporary, destination);
    }
    await Promise.all(planned.map((item) => verifyArtifact(item.artifact)));
    const replacementKeys = new Set(planned.map((item) => `${item.capability}\u0000${canonicalModelIdentityKey(item.artifact.selection)}`));
    const artifacts = [...current.artifacts.filter((item) => !replacementKeys.has(`${item.capability}\u0000${canonicalModelIdentityKey(item.selection)}`)), ...planned.map((item) => item.artifact)];
    const manifestCapabilities = new Set(planned.map((item) => item.capability));
    const oldDefaults = new Set(
      current.artifacts.filter((item) => manifestCapabilities.has(item.capability)).map((item) => canonicalModelIdentityKey(item.selection)),
    );
    const defaults = [...current.defaults.filter((identity) => !oldDefaults.has(identity)), ...planned.map((item) => canonicalModelIdentityKey(item.artifact.selection))];
    const receipt = parseInstalledModelsReceipt({ schemaVersion: 1, artifacts, defaults });
    const config = modelsConfigFromAcquisitionManifest(manifest);
    await writeAtomic(path.join(cacheRoot, INSTALLED_MODELS_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`);
    return { config, receipt, artifacts: planned.map((item) => item.artifact) };
  } finally {
    await Promise.all(staged.map((temporary) => rm(temporary, { force: true })));
  }
}

/** Download, verify, and atomically merge one embed artifact through the model-set installer. */
export async function acquireEmbeddingModel(options: AcquireEmbeddingModelOptions): Promise<AcquiredEmbeddingModel> {
  const descriptor = parseEmbeddingModelDescriptor(options.descriptor);
  if (descriptor.url === undefined) throw new Error("Embedding model URL is required for setup acquisition.");
  const acquired = await acquireModelSet({
    cacheDir: options.cacheDir, vault: options.vault, fetchImpl: options.fetchImpl,
    manifest: {
      schemaVersion: 1,
      embed: {
        provider: descriptor.provider, model: descriptor.model, revision: descriptor.revision, sha256: descriptor.sha256,
        promptScheme: descriptor.prefixScheme, url: descriptor.url, filename: descriptor.filename,
        dimensions: descriptor.dimensions, contextLength: descriptor.context, mrlDim: descriptor.mrlDim, normalization: descriptor.normalization,
      },
    },
  });
  const artifact = acquired.artifacts[0]!;
  return { descriptor: descriptorFromArtifact(artifact), cachePath: artifact.path };
}

function selectionBytes(config: ModelsConfigV1): string {
  return `${JSON.stringify(parseModelsConfig(config), null, 2)}\n`;
}

function approvalDigest(current: string | null, proposed: string): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update("oms-model-selection-v1\n")
    .update(current === null ? "absent\n" : current)
    .update("\nproposed\n")
    .update(proposed)
    .digest("hex")}`;
}

/** Stable approval digest for a strict acquisition manifest; acquiring still verifies every artifact checksum. */
export function modelAcquisitionApprovalDigest(input: ModelSetAcquisitionManifest | unknown): `sha256:${string}` {
  const manifest = parseModelSetAcquisitionManifest(input);
  return `sha256:${createHash("sha256")
    .update("oms-model-acquisition-v1\n")
    .update(JSON.stringify(manifest))
    .digest("hex")}`;
}

async function currentSelection(vault: string): Promise<{ readonly raw: string | null; readonly config: ModelsConfigV1 | null }> {
  const filename = path.join(vault, ".oms", "models.json");
  try {
    const raw = await readFile(filename, "utf8");
    return { raw, config: parseModelsConfig(raw) };
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return { raw: null, config: null };
    throw error;
  }
}

async function verifiedSelectionVault(vault: string): Promise<string> {
  const root = await realpath(vault);
  if (!(await stat(root)).isDirectory()) throw new Error(`Model selection target is not a directory: ${root}.`);
  const oms = path.join(root, ".oms");
  const omsEntry = await lstat(oms);
  if (!omsEntry.isDirectory() || omsEntry.isSymbolicLink()) {
    throw new Error(`Model selection target is not a verified OMS vault: ${root}.`);
  }
  try {
    if ((await lstat(path.join(oms, "models.json"))).isSymbolicLink()) {
      throw new Error("Model selection target .oms/models.json must not be a symbolic link.");
    }
  } catch (error: unknown) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  return root;
}

/** Build a side-effect-free, verified selection proposal from installed artifacts. */
export async function proposeModelSelection(options: {
  readonly vault: string;
  readonly config: ModelsConfigV1 | unknown;
  readonly cacheDir?: string;
}): Promise<ModelSelectionProposal> {
  const vault = await verifiedSelectionVault(options.vault);
  const proposed = parseModelsConfig(options.config);
  const installed = await readInstalledModelsReceipt({ cacheDir: options.cacheDir });
  const resolutions = resolveModelCapabilities({
    env: {},
    vaultConfig: proposed,
    installedArtifacts: installed.artifacts,
    setupDefaults: installed.defaults,
  });
  for (const capability of ["embed", "rerank", "generate"] as const) {
    if (proposed[capability] !== undefined && (!resolutions[capability].available || resolutions[capability].source !== "vault")) {
      throw new Error(`Model selection for ${capability} is not backed by a verified installed artifact.`);
    }
  }
  const current = await currentSelection(vault);
  const proposedRaw = selectionBytes(proposed);
  return {
    vault,
    current: current.config,
    proposed,
    approvalDigest: approvalDigest(current.raw, proposedRaw),
    changed: current.raw !== proposedRaw,
  };
}

/** CAS-publish an approved model selection and verify the persisted readback. */
export async function applyModelSelection(options: {
  readonly vault: string;
  readonly config: ModelsConfigV1 | unknown;
  readonly approvedDigest: string;
  readonly cacheDir?: string;
}): Promise<ModelSelectionReceipt> {
  const vault = await verifiedSelectionVault(options.vault);
  const lock = path.join(vault, ".oms", "models.json.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "EEXIST") {
      throw new Error("MODEL_SELECTION_CONCURRENT_CHANGE: another model selection is in progress.");
    }
    throw error;
  }
  try {
    const proposal = await proposeModelSelection({ ...options, vault });
    if (options.approvedDigest !== proposal.approvalDigest) {
      throw new Error(`MODEL_SELECTION_APPROVAL_MISMATCH: expected ${proposal.approvalDigest}.`);
    }
    const filename = path.join(proposal.vault, ".oms", "models.json");
    if (proposal.changed) {
      const temporary = path.join(path.dirname(filename), `.models.json.oms-${process.pid}-${randomUUID()}`);
      try {
        await writeFile(temporary, selectionBytes(proposal.proposed), { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, filename);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    const readback = await readModelsConfig(proposal.vault);
    if (JSON.stringify(readback) !== JSON.stringify(proposal.proposed)) {
      throw new Error("MODEL_SELECTION_READBACK_FAILED: persisted selection does not match the approved proposal.");
    }
    return { ...proposal, status: proposal.changed ? "written" : "unchanged", path: filename, verified: true };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
