import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type ModelCapability = "embed" | "rerank" | "generate";

export interface PortableModelSelection {
  readonly provider: "gguf";
  readonly model: string;
  readonly revision: string;
  readonly sha256: string;
  readonly promptScheme?: string;
}

export interface ModelsConfigV1 {
  readonly schemaVersion: 1;
  readonly embed: PortableModelSelection;
  readonly rerank?: PortableModelSelection;
  readonly generate?: PortableModelSelection;
}

export interface EmbedModelShape {
  readonly dimensions: number;
  readonly contextLength: number;
  readonly mrlDim: number;
  readonly normalization: string;
}

export interface InstalledModelArtifact {
  readonly capability: ModelCapability;
  readonly selection: PortableModelSelection;
  readonly path: string;
  readonly embedShape?: EmbedModelShape;
}

export const MODELS_CONFIG_FILENAME = "models.json" as const;
export const MODELS_CONFIG_VERSION = 1 as const;
export const MODEL_CAPABILITY_ENV_PAIRS: Readonly<Record<ModelCapability, readonly [string, string]>> = {
  embed: ["OMS_EMBEDDING_PROVIDER", "OMS_EMBEDDING_MODEL"],
  rerank: ["OMS_RERANK_PROVIDER", "OMS_RERANK_MODEL"],
  generate: ["OMS_GENERATE_PROVIDER", "OMS_GENERATE_MODEL"],
};

export type ModelSelectionSource = "request" | "environment" | "vault" | "setup-default" | "unavailable";

export interface ModelCapabilityResolution {
  readonly capability: ModelCapability;
  readonly available: boolean;
  readonly source: ModelSelectionSource;
  readonly selection?: PortableModelSelection;
  readonly artifact?: InstalledModelArtifact;
  readonly equivalentSources: readonly Exclude<ModelSelectionSource, "unavailable">[];
  readonly shadowedSources: readonly Exclude<ModelSelectionSource, "unavailable">[];
  readonly guidance?: string;
}

export interface ResolveModelCapabilityOptions {
  readonly capability: ModelCapability;
  readonly request?: PortableModelSelection;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly vaultConfig?: ModelsConfigV1 | null;
  readonly installedArtifacts?: readonly InstalledModelArtifact[];
  /** Canonical identity keys written by setup, at most one per capability. */
  readonly setupDefaults?: readonly string[];
}

export interface ResolveModelCapabilitiesOptions {
  readonly requests?: Readonly<Partial<Record<ModelCapability, PortableModelSelection>>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly vaultConfig?: ModelsConfigV1 | null;
  readonly installedArtifacts?: readonly InstalledModelArtifact[];
  readonly setupDefaults?: readonly string[];
}

const CAPABILITIES: readonly ModelCapability[] = ["embed", "rerank", "generate"];
const IDENTITY_SEPARATOR = "\u0000";
const SHA256 = /^[a-f0-9]{64}$/;
const UNSAFE_PORTABLE_VALUE = /[\\/]|^[A-Za-z][A-Za-z\d+.-]*:|^~|(^|\.)\.($|\.)/;
const MUTABLE_REVISIONS = new Set(["latest", "main", "master", "head"]);
const EMBED_PROMPTS = new Set(["qwen3-embedding-v1", "embeddinggemma-v1"]);
const GENERATE_PROMPT = "qmd-query-expansion-v2.8.3";

type SelectionSource = Exclude<ModelSelectionSource, "unavailable">;

function fail(message: string): never {
  throw new Error(`Invalid .oms/${MODELS_CONFIG_FILENAME}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} contains unknown key "${key}".`);
  }
}

function nonblank(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a nonblank string.`);
  if (value !== value.trim()) fail(`${label} must not have surrounding whitespace.`);
  return value;
}

function portableValue(value: unknown, label: string): string {
  const result = nonblank(value, label);
  if (UNSAFE_PORTABLE_VALUE.test(result)) {
    fail(`${label} must be a portable name, not a URL or path.`);
  }
  return result;
}

function parseSelection(value: unknown, capability: ModelCapability, label: string): PortableModelSelection {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  assertExactKeys(value, ["provider", "model", "revision", "sha256", "promptScheme"], label);
  if (value.provider !== "gguf") fail(`${label}.provider must be "gguf".`);
  const model = portableValue(value.model, `${label}.model`);
  const revision = portableValue(value.revision, `${label}.revision`);
  if (MUTABLE_REVISIONS.has(revision.toLowerCase())) {
    fail(`${label}.revision must be immutable, not "${revision}".`);
  }
  const sha256 = nonblank(value.sha256, `${label}.sha256`);
  if (!SHA256.test(sha256)) fail(`${label}.sha256 must be lowercase 64-character hexadecimal.`);

  const promptScheme = value.promptScheme;
  if (capability === "rerank") {
    if (promptScheme !== undefined) fail(`${label}.promptScheme is forbidden for rerank.`);
    return { provider: "gguf", model, revision, sha256 };
  }
  if (capability === "embed") {
    if (typeof promptScheme !== "string" || !EMBED_PROMPTS.has(promptScheme)) {
      fail(`${label}.promptScheme must be qwen3-embedding-v1 or embeddinggemma-v1.`);
    }
  } else if (promptScheme !== GENERATE_PROMPT) {
    fail(`${label}.promptScheme must be ${GENERATE_PROMPT}.`);
  }
  return { provider: "gguf", model, revision, sha256, promptScheme };
}

/** Parse a strict, portable `.oms/models.json` schema-version 1 document. */
export function parseModelsConfig(input: string | unknown): ModelsConfigV1 {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      fail("is not valid JSON.");
    }
  }
  if (!isRecord(value)) fail("must be an object.");
  assertExactKeys(value, ["schemaVersion", "embed", "rerank", "generate"], "top level");
  if (value.schemaVersion !== MODELS_CONFIG_VERSION) fail(`schemaVersion must be ${MODELS_CONFIG_VERSION}.`);
  if (!("embed" in value)) fail("embed is required.");

  const embed = parseSelection(value.embed, "embed", "embed");
  const rerank = value.rerank === undefined ? undefined : parseSelection(value.rerank, "rerank", "rerank");
  const generate = value.generate === undefined ? undefined : parseSelection(value.generate, "generate", "generate");
  return {
    schemaVersion: MODELS_CONFIG_VERSION,
    embed,
    ...(rerank === undefined ? {} : { rerank }),
    ...(generate === undefined ? {} : { generate }),
  };
}

/** Read and parse a vault-local models configuration. Missing configuration is unavailable, not an error. */
export async function readModelsConfig(vault: string): Promise<ModelsConfigV1 | null> {
  const filename = path.join(vault, ".oms", MODELS_CONFIG_FILENAME);
  try {
    return parseModelsConfig(await readFile(filename, "utf8"));
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Read and parse a vault-local models configuration synchronously. Missing configuration is unavailable, not an error. */
export function readModelsConfigSync(vault: string): ModelsConfigV1 | null {
  const filename = path.join(vault, ".oms", MODELS_CONFIG_FILENAME);
  try {
    return parseModelsConfig(readFileSync(filename, "utf8"));
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Stable identity for matching portable selections to local artifacts and setup defaults. */
export function canonicalModelIdentityKey(selection: PortableModelSelection): string {
  const validated = parseSelection(selection, promptCapability(selection), "selection");
  return [validated.provider, validated.model, validated.revision, validated.sha256, validated.promptScheme ?? ""].join(
    IDENTITY_SEPARATOR,
  );
}

function promptCapability(selection: PortableModelSelection): ModelCapability {
  if (selection.promptScheme === undefined) return "rerank";
  if (EMBED_PROMPTS.has(selection.promptScheme)) return "embed";
  if (selection.promptScheme === GENERATE_PROMPT) return "generate";
  // parseSelection provides the public validation error after this branch.
  return "embed";
}

function selectionForCapability(config: ModelsConfigV1 | null | undefined, capability: ModelCapability): PortableModelSelection | undefined {
  if (config === null || config === undefined) return undefined;
  return config[capability];
}

function validateArtifacts(artifacts: readonly InstalledModelArtifact[]): void {
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    if (!CAPABILITIES.includes(artifact.capability)) throw new Error("Installed artifact has an invalid capability.");
    const selection = parseSelection(artifact.selection, artifact.capability, "installed artifact selection");
    if (!path.isAbsolute(artifact.path)) throw new Error("Installed artifact path must be absolute.");
    if (artifact.capability !== "embed") {
      if (artifact.embedShape !== undefined) throw new Error("Only embed artifacts may declare embedShape.");
    } else {
      if (!isRecord(artifact.embedShape)) throw new Error("Installed embed artifact must declare embedShape.");
      const { dimensions, contextLength, mrlDim, normalization } = artifact.embedShape;
      if (
        !Number.isInteger(dimensions) || dimensions <= 0 ||
        !Number.isInteger(contextLength) || contextLength <= 0 ||
        !Number.isInteger(mrlDim) || mrlDim < 0 ||
        typeof normalization !== "string" || normalization.trim() === "" || normalization !== normalization.trim()
      ) {
        throw new Error(
          "Installed embed artifact shape must have positive integer dimensions and contextLength, nonnegative integer mrlDim, and nonblank normalization.",
        );
      }
    }
    const key = `${artifact.capability}${IDENTITY_SEPARATOR}${canonicalModelIdentityKey(selection)}`;
    if (seen.has(key)) throw new Error(`Duplicate installed artifact for ${artifact.capability}.`);
    seen.add(key);
  }
}

function artifactForSelection(
  capability: ModelCapability,
  selection: PortableModelSelection,
  artifacts: readonly InstalledModelArtifact[],
): InstalledModelArtifact {
  const key = canonicalModelIdentityKey(selection);
  const found = artifacts.filter((artifact) =>
    artifact.capability === capability && canonicalModelIdentityKey(artifact.selection) === key,
  );
  if (found.length !== 1) throw new Error(`Selected ${capability} model is not installed as an exact artifact.`);
  return found[0]!;
}

function artifactForEnvironment(
  capability: ModelCapability,
  provider: string,
  model: string,
  artifacts: readonly InstalledModelArtifact[],
): InstalledModelArtifact {
  if (provider !== "gguf") throw new Error(`Environment selection for ${capability} must use provider gguf.`);
  portableValue(model, `environment ${capability} model`);
  const found = artifacts.filter((artifact) => artifact.capability === capability &&
    artifact.selection.provider === provider && artifact.selection.model === model);
  if (found.length !== 1) {
    throw new Error(`Environment selection for ${capability} does not identify exactly one installed artifact.`);
  }
  return found[0]!;
}

function setupDefaultForCapability(
  capability: ModelCapability,
  defaults: readonly string[],
  artifacts: readonly InstalledModelArtifact[],
): InstalledModelArtifact | undefined {
  const found = artifacts.filter((artifact) =>
    artifact.capability === capability && defaults.includes(canonicalModelIdentityKey(artifact.selection)),
  );
  if (found.length > 1) throw new Error(`Duplicate setup defaults for ${capability}.`);
  return found[0];
}

function validateSetupDefaults(defaults: readonly string[], artifacts: readonly InstalledModelArtifact[]): void {
  if (new Set(defaults).size !== defaults.length) throw new Error("Duplicate setup default identity key.");
  for (const identity of defaults) {
    const matches = artifacts.filter((artifact) => canonicalModelIdentityKey(artifact.selection) === identity);
    if (matches.length !== 1) throw new Error("Setup default must identify exactly one installed artifact.");
  }
}

function envArtifact(
  capability: ModelCapability,
  env: Readonly<Record<string, string | undefined>>,
  artifacts: readonly InstalledModelArtifact[],
): InstalledModelArtifact | undefined {
  const [providerName, modelName] = MODEL_CAPABILITY_ENV_PAIRS[capability];
  const providerRaw = env[providerName];
  const modelRaw = env[modelName];
  const provider = providerRaw?.trim() ?? "";
  const model = modelRaw?.trim() ?? "";
  if ((providerRaw !== undefined && providerRaw !== provider) || (modelRaw !== undefined && modelRaw !== model)) {
    throw new Error(`Environment selection for ${capability} must not have surrounding whitespace.`);
  }
  if ((provider === "") !== (model === "")) {
    throw new Error(`Incomplete ${capability} environment selection: set both ${providerName} and ${modelName}.`);
  }
  return provider === "" ? undefined : artifactForEnvironment(capability, provider, model, artifacts);
}

/**
 * The one-step install path for each capability.
 *
 * `embed` has a pinned default, so an unconfigured vault can be told exactly how
 * to become usable in one command. `rerank` and `generate` have no pinned model,
 * so naming `--models-default` for them would point at a command that installs
 * something else. Each capability therefore names the remedy that actually
 * installs it, and never one that does not.
 */
const CAPABILITY_INSTALL_REMEDY: Readonly<Record<ModelCapability, string>> = {
  embed: "install the pinned default with `oms setup --models-default`",
  rerank: "install one with `oms setup --models-descriptor <path>`",
  generate: "install one with `oms setup --models-descriptor <path>`",
};

/**
 * The actionable guidance for an unconfigured capability.
 *
 * Exported so every surface that has to refuse a capability request — the
 * resolver here, and the MCP facade when an explicit `rerank: true` cannot be
 * served — emits the same remedy. Two hand-written copies would drift, and the
 * one that drifted would send users to the wrong place.
 */
export function capabilityGuidance(capability: ModelCapability): string {
  const [provider, model] = MODEL_CAPABILITY_ENV_PAIRS[capability];
  return (
    `No ${capability} model is configured. Set ${provider} and ${model}, ` +
    `declare ${capability} in .oms/${MODELS_CONFIG_FILENAME}, or ` +
    `${CAPABILITY_INSTALL_REMEDY[capability]}.`
  );
}

function unavailable(capability: ModelCapability): ModelCapabilityResolution {
  return {
    capability,
    available: false,
    source: "unavailable",
    equivalentSources: [],
    shadowedSources: [],
    guidance: capabilityGuidance(capability),
  };
}

/** Resolve one capability using request, environment, vault, then setup-default precedence. */
export function resolveModelCapability(options: ResolveModelCapabilityOptions): ModelCapabilityResolution {
  const artifacts = options.installedArtifacts ?? [];
  validateArtifacts(artifacts);
  const defaults = options.setupDefaults ?? [];
  validateSetupDefaults(defaults, artifacts);

  const candidates: Array<{ source: SelectionSource; selection: PortableModelSelection; artifact?: InstalledModelArtifact }> = [];
  if (options.request !== undefined) {
    const selection = parseSelection(options.request, options.capability, "request");
    candidates.push({ source: "request", selection });
  }
  const environment = envArtifact(options.capability, options.env ?? process.env, artifacts);
  if (environment !== undefined) candidates.push({ source: "environment", selection: environment.selection, artifact: environment });
  const vaultSelection = selectionForCapability(options.vaultConfig, options.capability);
  if (vaultSelection !== undefined) {
    candidates.push({
      source: "vault",
      selection: parseSelection(vaultSelection, options.capability, `vault ${options.capability}`),
    });
  }
  const setup = setupDefaultForCapability(options.capability, defaults, artifacts);
  if (setup !== undefined) candidates.push({ source: "setup-default", selection: setup.selection, artifact: setup });
  if (candidates.length === 0) return unavailable(options.capability);

  const selected = candidates[0]!;
  const artifact = selected.artifact ?? artifactForSelection(options.capability, selected.selection, artifacts);
  const selectedKey = canonicalModelIdentityKey(selected.selection);
  const lower = candidates.slice(1);
  return {
    capability: options.capability,
    available: true,
    source: selected.source,
    selection: selected.selection,
    artifact,
    equivalentSources: lower.filter((candidate) => canonicalModelIdentityKey(candidate.selection) === selectedKey).map((candidate) => candidate.source),
    shadowedSources: lower.filter((candidate) => canonicalModelIdentityKey(candidate.selection) !== selectedKey).map((candidate) => candidate.source),
  };
}

/** Resolve all capabilities independently under the same strict source precedence. */
export function resolveModelCapabilities(options: ResolveModelCapabilitiesOptions = {}): Readonly<Record<ModelCapability, ModelCapabilityResolution>> {
  return {
    embed: resolveModelCapability({ ...options, capability: "embed", request: options.requests?.embed }),
    rerank: resolveModelCapability({ ...options, capability: "rerank", request: options.requests?.rerank }),
    generate: resolveModelCapability({ ...options, capability: "generate", request: options.requests?.generate }),
  };
}
