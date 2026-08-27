import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

/** The canonical environment variables for selecting an embedding model. */
export const EMBEDDING_PROVIDER_ENV = "OMS_EMBEDDING_PROVIDER" as const;
export const EMBEDDING_MODEL_ENV = "OMS_EMBEDDING_MODEL" as const;
export const INSTALLED_DEFAULT_DESCRIPTOR = "default-model.json";
export const CAPABILITY_RECEIPT = "capability-receipt.json";

/** Metadata needed to use an installed embedding model. */
export interface EmbeddingModelDescriptor {
  readonly provider: string;
  /** Provider model id. For local providers this may be a filename. */
  readonly model: string;
  /** Absolute path to a locally installed model, when applicable. */
  readonly path?: string;
  /** Alias accepted in descriptors produced by setup adapters. */
  readonly modelPath?: string;
  /** Source URL used by setup, when this model was acquired. */
  readonly url?: string;
  /** SHA-256 digest of the installed bytes, lowercase hexadecimal. */
  readonly sha256?: string;
  readonly dimensions?: number;
  /** Canonical model context window in tokens. */
  readonly context?: number;
  /** Canonical context-length alias used by some setup adapters. */
  readonly contextLength?: number;
  readonly contextTokens?: number;
  /** Optional Matryoshka (MRL) output width. */
  readonly mrlDim?: number;
  /** Declared output-vector normalization scheme. */
  readonly normalization?: string;
  /** Declared query/passage prefix scheme. */
  readonly prefixScheme?: string;
  /** Optional filename used for the cache artifact. */
  readonly filename?: string;
}

export type ModelResolutionSource = "configured" | "installed-default" | "none";

export interface EmbeddingCapabilityReceipt {
  readonly kind: "embedding-capability";
  readonly available: boolean;
  readonly source: ModelResolutionSource | "setup";
  readonly provider?: string;
  readonly model?: string;
  readonly modelPath?: string;
  readonly cachePath?: string;
  readonly sha256?: string;
  readonly dimensions?: number;
  readonly context?: number;
  readonly contextLength?: number;
  readonly contextTokens?: number;
  readonly mrlDim?: number;
  readonly normalization?: string;
  readonly prefixScheme?: string;
  readonly guidance: string;
}

export interface EmbeddingModelResolution {
  readonly available: boolean;
  readonly source: ModelResolutionSource;
  readonly provider?: string;
  readonly model?: string;
  readonly modelPath?: string;
  readonly descriptor?: EmbeddingModelDescriptor;
  readonly receipt: EmbeddingCapabilityReceipt;
}

export interface ResolveEmbeddingModelOptions {
  /** Environment snapshot. Defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Installed descriptor to use when the canonical env pair is absent. */
  readonly installedDefault?: EmbeddingModelDescriptor | null;
  /** Alias accepted for callers that call the descriptor a default model. */
  readonly defaultModel?: EmbeddingModelDescriptor | null;
  /** Optional cache root for automatic installed-default discovery. */
  readonly cacheDir?: string;
}

const INCOMPLETE_CONFIG_ERROR =
  `Embedding configuration is incomplete. Set both ${EMBEDDING_PROVIDER_ENV} and ${EMBEDDING_MODEL_ENV}.`;
const NO_MODEL_GUIDANCE =
  `No embedding model is configured. Set ${EMBEDDING_PROVIDER_ENV} and ${EMBEDDING_MODEL_ENV}, ` +
  "or install a local model with `oms setup --embedding-descriptor <descriptor>`.";

function trim(value: string | undefined): string {
  return (value ?? "").trim();
}

function assertCompleteDescriptor(descriptor: EmbeddingModelDescriptor): void {
  const context = descriptor.context ?? descriptor.contextLength ?? descriptor.contextTokens;
  if (
    !Number.isInteger(descriptor.dimensions) || descriptor.dimensions === undefined || descriptor.dimensions <= 0 ||
    !Number.isInteger(context) || context === undefined || context <= 0 ||
    !Number.isInteger(descriptor.mrlDim) || descriptor.mrlDim === undefined || descriptor.mrlDim < 0 ||
    !trim(descriptor.normalization) ||
    !trim(descriptor.prefixScheme)
  ) {
    throw new Error(
      "Embedding descriptor is incomplete. dimensions/context/mrlDim/normalization/prefixScheme are required.",
    );
  }
}

function receiptFor(
  resolution: Omit<EmbeddingModelResolution, "receipt">,
  guidance: string,
): EmbeddingCapabilityReceipt {
  return {
    kind: "embedding-capability",
    available: resolution.available,
    source: resolution.source,
    ...(resolution.provider ? { provider: resolution.provider } : {}),
    ...(resolution.model ? { model: resolution.model } : {}),
    ...(resolution.modelPath ? { modelPath: resolution.modelPath } : {}),
    ...(resolution.descriptor?.sha256 ? { sha256: resolution.descriptor.sha256 } : {}),
    ...(resolution.descriptor?.dimensions !== undefined
      ? { dimensions: resolution.descriptor.dimensions }
      : {}),
    ...(resolution.descriptor?.context !== undefined ? { context: resolution.descriptor.context } : {}),
    ...(resolution.descriptor?.contextLength !== undefined
      ? { contextLength: resolution.descriptor.contextLength }
      : {}),
    ...(resolution.descriptor?.contextTokens !== undefined
      ? { contextTokens: resolution.descriptor.contextTokens }
      : {}),
    ...(resolution.descriptor?.mrlDim !== undefined ? { mrlDim: resolution.descriptor.mrlDim } : {}),
    ...(resolution.descriptor?.normalization !== undefined
      ? { normalization: resolution.descriptor.normalization }
      : {}),
    ...(resolution.descriptor?.prefixScheme !== undefined
      ? { prefixScheme: resolution.descriptor.prefixScheme }
      : {}),
    guidance,
  };
}

function withReceipt(
  resolution: Omit<EmbeddingModelResolution, "receipt">,
  guidance: string,
): EmbeddingModelResolution {
  return { ...resolution, receipt: receiptFor(resolution, guidance) };
}

/**
 * Resolve the one canonical embedding selection.
 *
 * A complete environment pair always wins. A half-pair is an error rather than
 * an invitation to silently use a different model. If neither environment
 * variable is set, an explicitly supplied installed descriptor is used, then
 * the result is an honest unavailable capability.
 */
export function resolveEmbeddingModel(
  options: ResolveEmbeddingModelOptions = {},
): EmbeddingModelResolution {
  const env = options.env ?? process.env;
  const provider = trim(env[EMBEDDING_PROVIDER_ENV]);
  const model = trim(env[EMBEDDING_MODEL_ENV]);

  if ((provider === "") !== (model === "")) {
    throw new Error(INCOMPLETE_CONFIG_ERROR);
  }

  if (provider !== "" && model !== "") {
    const descriptor = options.installedDefault !== undefined
      ? options.installedDefault
      : options.defaultModel !== undefined
        ? options.defaultModel
        : readInstalledEmbeddingDefaultSync({ cacheDir: options.cacheDir });
    if (descriptor !== null && descriptor !== undefined) {
      const descriptorModel = trim(descriptor.path) || trim(descriptor.modelPath) || trim(descriptor.model);
      if (trim(descriptor.provider) !== provider || descriptorModel !== model) {
        throw new Error("Embedding descriptor does not match the configured provider/model.");
      }
      assertCompleteDescriptor(descriptor);
    }
    const resolution: Omit<EmbeddingModelResolution, "receipt"> = {
      available: true,
      source: "configured",
      provider,
      model,
      ...(descriptor !== null && descriptor !== undefined ? { descriptor } : {}),
    };
    return withReceipt(resolution, "Embedding model selected from the canonical environment pair.");
  }

  // `null` explicitly disables discovery. With no override, setup's
  // user-level descriptor is the second precedence tier.
  const descriptor = options.installedDefault !== undefined
    ? options.installedDefault
    : options.defaultModel !== undefined
      ? options.defaultModel
      : readInstalledEmbeddingDefaultSync({ cacheDir: options.cacheDir });
  if (descriptor !== null) {
    const installedProvider = trim(descriptor.provider);
    const installedModel = trim(descriptor.model);
    if (installedProvider === "" || installedModel === "") {
      throw new Error(
        `Installed embedding default is invalid. It must name both a provider and model (${EMBEDDING_PROVIDER_ENV} / ${EMBEDDING_MODEL_ENV}).`,
      );
    }
    const modelPath = trim(descriptor.path) || trim(descriptor.modelPath);
    const resolution: Omit<EmbeddingModelResolution, "receipt"> = {
      available: true,
      source: "installed-default",
      provider: installedProvider,
      model: installedModel,
      ...(modelPath ? { modelPath } : {}),
      descriptor,
    };
    return withReceipt(
      resolution,
      `Using the installed default model. Set ${EMBEDDING_PROVIDER_ENV}=${installedProvider} and ${EMBEDDING_MODEL_ENV}=${modelPath || installedModel} to select it explicitly.`,
    );
  }

  const resolution: Omit<EmbeddingModelResolution, "receipt"> = {
    available: false,
    source: "none",
  };
  return withReceipt(resolution, NO_MODEL_GUIDANCE);
}

/** Short alias for code that refers to this operation as model resolution. */
export const resolveModel = resolveEmbeddingModel;

/**
 * Cache root for downloaded model bytes. It is deliberately user-level and
 * never derived from a vault path. `cacheDir` can be supplied by setup/tests.
 */
export function embeddingModelCacheDir(options: {
  readonly cacheDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
} = {}): string {
  if (options.cacheDir?.trim()) return path.resolve(options.cacheDir);
  const env = options.env ?? process.env;
  const xdg = trim(env["XDG_CACHE_HOME"]);
  const root = xdg !== "" ? xdg : path.join(options.homeDir ?? homedir(), ".cache");
  return path.resolve(root, "oms", "models");
}

export const getEmbeddingModelCacheDir = embeddingModelCacheDir;

/** Read the setup-written descriptor synchronously for engine assembly. */
export function readInstalledEmbeddingDefaultSync(options: {
  readonly cacheDir?: string;
} = {}): EmbeddingModelDescriptor | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(embeddingModelCacheDir(options), INSTALLED_DEFAULT_DESCRIPTOR), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Partial<EmbeddingModelDescriptor>;
    if (typeof candidate.provider !== "string" || typeof candidate.model !== "string") return null;
    return candidate as EmbeddingModelDescriptor;
  } catch {
    return null;
  }
}

export interface AcquireEmbeddingModelOptions {
  /** Descriptor must include URL and expected SHA-256 for setup acquisition. */
  readonly descriptor: EmbeddingModelDescriptor & { readonly url: string; readonly sha256: string };
  /** Optional explicit cache root. It must be outside `vault`, when provided. */
  readonly cacheDir?: string;
  /** Used only to reject an accidental cache path inside the vault. */
  readonly vault?: string;
  /** Injection point for focused tests; production uses the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export interface AcquiredEmbeddingModel {
  readonly descriptor: EmbeddingModelDescriptor;
  readonly modelPath: string;
  readonly cachePath: string;
  readonly receipt: EmbeddingCapabilityReceipt;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeName(value: string): string {
  const result = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return result || "model";
}

function extensionFromDescriptor(descriptor: EmbeddingModelDescriptor): string {
  const candidate = descriptor.filename ?? descriptor.model;
  const extension = path.extname(candidate);
  return extension.length > 0 && extension.length <= 12 ? extension : ".bin";
}

function modelFilename(descriptor: EmbeddingModelDescriptor): string {
  const supplied = descriptor.filename?.trim();
  if (supplied) return path.basename(supplied);
  return `${safeName(descriptor.provider)}-${safeName(descriptor.model)}${extensionFromDescriptor(descriptor)}`;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSha256(expected: string | undefined): string {
  const normalized = (expected ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("Embedding model SHA-256 must be a 64-character hexadecimal digest.");
  }
  return normalized;
}

async function readVerified(pathname: string, expected: string): Promise<Uint8Array | null> {
  try {
    const bytes = await readFile(pathname);
    const actual = sha256Bytes(bytes);
    if (actual !== expected) {
      await rm(pathname, { force: true });
      throw new Error(`Embedding model SHA-256 checksum mismatch: expected ${expected}, got ${actual}.`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && /checksum mismatch/.test(error.message)) throw error;
    return null;
  }
}

async function writeAtomic(pathname: string, bytes: Uint8Array | string): Promise<void> {
  const temporary = `${pathname}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, pathname);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Download and install a model for setup only.
 *
 * This function is intentionally not imported by the MCP server. It writes
 * only to the user-level model cache, verifies bytes before publishing them,
 * and leaves an installed-default descriptor plus capability receipt there for
 * future model resolution.
 */
export async function acquireEmbeddingModel(
  options: AcquireEmbeddingModelOptions,
): Promise<AcquiredEmbeddingModel> {
  const descriptor = options.descriptor;
  const expected = assertSha256(descriptor.sha256);
  const url = typeof descriptor.url === "string" ? descriptor.url.trim() : "";
  if (url === "") {
    throw new Error("Embedding model URL is required for setup acquisition.");
  }
  const cacheRoot = embeddingModelCacheDir({ cacheDir: options.cacheDir });
  if (options.vault !== undefined && isInside(cacheRoot, path.resolve(options.vault))) {
    throw new Error("Embedding model cache must be outside the vault.");
  }

  await mkdir(cacheRoot, { recursive: true });
  const cachePath = path.join(cacheRoot, modelFilename(descriptor));
  let bytes = await readVerified(cachePath, expected);
  if (bytes === null) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Embedding model download failed: ${response.status} ${response.statusText}.`);
    }
    bytes = new Uint8Array(await response.arrayBuffer());
    const actual = sha256Bytes(bytes);
    if (actual !== expected) {
      throw new Error(`Embedding model SHA-256 checksum mismatch: expected ${expected}, got ${actual}.`);
    }
    await writeAtomic(cachePath, bytes);
  }

  const installed: EmbeddingModelDescriptor = {
    ...descriptor,
    path: cachePath,
    sha256: expected,
    filename: modelFilename(descriptor),
  };
  const descriptorPath = path.join(cacheRoot, INSTALLED_DEFAULT_DESCRIPTOR);
  const receiptPath = path.join(cacheRoot, CAPABILITY_RECEIPT);
  await writeAtomic(descriptorPath, `${JSON.stringify(installed, null, 2)}\n`);
  const receipt: EmbeddingCapabilityReceipt = {
    kind: "embedding-capability",
    available: true,
    source: "setup",
    provider: installed.provider,
    model: installed.model,
    modelPath: cachePath,
    cachePath,
    sha256: expected,
    ...(installed.dimensions !== undefined ? { dimensions: installed.dimensions } : {}),
    ...(installed.context !== undefined ? { context: installed.context } : {}),
    ...(installed.contextLength !== undefined ? { contextLength: installed.contextLength } : {}),
    ...(installed.contextTokens !== undefined ? { contextTokens: installed.contextTokens } : {}),
    ...(installed.mrlDim !== undefined ? { mrlDim: installed.mrlDim } : {}),
    ...(installed.normalization !== undefined ? { normalization: installed.normalization } : {}),
    ...(installed.prefixScheme !== undefined ? { prefixScheme: installed.prefixScheme } : {}),
    guidance: `Model installed. Set ${EMBEDDING_PROVIDER_ENV}=${installed.provider} and ${EMBEDDING_MODEL_ENV}=${installed.path || installed.model} to select it.`,
  };
  await writeAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  return { descriptor: installed, modelPath: cachePath, cachePath, receipt };
}

/** Read the setup-written default descriptor without touching a vault. */
export async function readInstalledEmbeddingDefault(options: {
  readonly cacheDir?: string;
} = {}): Promise<EmbeddingModelDescriptor | null> {
  try {
    const raw = await readFile(path.join(embeddingModelCacheDir(options), INSTALLED_DEFAULT_DESCRIPTOR), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Partial<EmbeddingModelDescriptor>;
    if (typeof candidate.provider !== "string" || typeof candidate.model !== "string") return null;
    return candidate as EmbeddingModelDescriptor;
  } catch {
    return null;
  }
}

/** Async resolver that consults the setup cache when no env pair is present. */
export async function resolveEmbeddingModelFromCache(options: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cacheDir?: string;
} = {}): Promise<EmbeddingModelResolution> {
  const provider = trim((options.env ?? process.env)[EMBEDDING_PROVIDER_ENV]);
  const model = trim((options.env ?? process.env)[EMBEDDING_MODEL_ENV]);
  if (provider !== "" || model !== "") return resolveEmbeddingModel({ env: options.env });
  const installedDefault = await readInstalledEmbeddingDefault({ cacheDir: options.cacheDir });
  return resolveEmbeddingModel({ env: options.env, installedDefault });
}

export const resolveModelFromCache = resolveEmbeddingModelFromCache;
