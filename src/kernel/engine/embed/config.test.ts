import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serializeVaultSettings } from "../../vault/settings.js";
import {
  canonicalModelIdentityKey,
  parseModelsConfig,
  readVaultEmbeddingModel,
  readVaultEmbeddingModelSync,
  resolveModelCapabilities,
  resolveModelCapability,
  type InstalledModelArtifact,
  type ModelCapability,
  type PortableModelSelection,
} from "./config.js";

const digest = "a".repeat(64);
const selection = (capability: ModelCapability, model = `${capability}.gguf`): PortableModelSelection => ({
  provider: "gguf",
  model,
  revision: "v1.0.0",
  sha256: digest,
  ...(capability === "embed" ? { promptScheme: "embeddinggemma-v1" } : {}),
  ...(capability === "generate" ? { promptScheme: "qmd-query-expansion-v2.8.3" } : {}),
});
const artifact = (capability: ModelCapability, model?: string): InstalledModelArtifact => ({
  capability,
  selection: selection(capability, model),
  path: `/models/${model ?? `${capability}.gguf`}`,
  ...(capability === "embed"
    ? { embedShape: { dimensions: 768, contextLength: 2048, mrlDim: 0, normalization: "l2" } }
    : {}),
});
const config = () => ({ schemaVersion: 1, embed: selection("embed") });

let vaults: string[] = [];
afterEach(async () => {
  await Promise.all(vaults.map((vault) => rm(vault, { recursive: true, force: true })));
  vaults = [];
});

describe("models configuration v1", () => {
  it("accepts the portable v1 document and rejects every schema boundary", () => {
    expect(parseModelsConfig(JSON.stringify(config()))).toEqual(config());
    const invalid = [
      "{",
      null,
      [],
      { schemaVersion: 2, embed: selection("embed") },
      { schemaVersion: 1 },
      { ...config(), extra: true },
      { ...config(), embed: { ...selection("embed"), extra: true } },
      { ...config(), embed: { ...selection("embed"), provider: "remote" } },
      { ...config(), embed: { ...selection("embed"), model: "" } },
      { ...config(), embed: { ...selection("embed"), model: "https://host/model.gguf" } },
      { ...config(), embed: { ...selection("embed"), model: "/model.gguf" } },
      { ...config(), embed: { ...selection("embed"), model: "~/.cache/model.gguf" } },
      { ...config(), embed: { ...selection("embed"), model: "../model.gguf" } },
      { ...config(), embed: { ...selection("embed"), model: "dir/model.gguf" } },
      { ...config(), embed: { ...selection("embed"), revision: "" } },
      { ...config(), embed: { ...selection("embed"), revision: "latest" } },
      { ...config(), embed: { ...selection("embed"), revision: "main" } },
      { ...config(), embed: { ...selection("embed"), revision: "master" } },
      { ...config(), embed: { ...selection("embed"), revision: "head" } },
      { ...config(), embed: { ...selection("embed"), sha256: "a".repeat(63) } },
      { ...config(), embed: { ...selection("embed"), sha256: digest.toUpperCase() } },
      { ...config(), embed: { ...selection("embed"), promptScheme: "other" } },
      { ...config(), rerank: { ...selection("rerank"), promptScheme: "forbidden" } },
      { ...config(), generate: selection("embed") },
    ];
    for (const value of invalid) expect(() => parseModelsConfig(value)).toThrow();
  });

  it("reads the vault embedding model only from settings.json and never from a retired model file", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-models-"));
    vaults.push(vault);
    expect(await readVaultEmbeddingModel(vault)).toBeNull();
    expect(readVaultEmbeddingModelSync(vault)).toBeNull();
    await mkdir(path.join(vault, ".oms"));
    await writeFile(path.join(vault, ".oms", ["models", "json"].join(".")), JSON.stringify(config()));
    expect(await readVaultEmbeddingModel(vault)).toBeNull();
    expect(readVaultEmbeddingModelSync(vault)).toBeNull();
    const settings = path.join(vault, ".oms", "settings.json");
    await writeFile(settings, serializeVaultSettings({ version: 1, vaultId: "11111111-2222-4333-8444-555555555555" }));
    expect(await readVaultEmbeddingModel(vault)).toBeNull();
    expect(readVaultEmbeddingModelSync(vault)).toBeNull();
    await writeFile(settings, serializeVaultSettings({ version: 1, vaultId: "11111111-2222-4333-8444-555555555555", embedding: { model: "embed.gguf" } }));
    expect(await readVaultEmbeddingModel(vault)).toBe("embed.gguf");
    expect(readVaultEmbeddingModelSync(vault)).toBe("embed.gguf");
    await writeFile(settings, "{");
    expect(() => readVaultEmbeddingModelSync(vault)).toThrow();
  });
});

describe("strict capability resolution", () => {
  for (const capability of ["embed", "rerank", "generate"] as const) {
    it(`uses strict precedence for ${capability} and discloses equivalent/shadowed sources`, () => {
      const requested = selection(capability, `request-${capability}.gguf`);
      const env = artifact(capability, `environment-${capability}.gguf`);
      const vault = artifact(capability, `vault-${capability}.gguf`);
      const setup = artifact(capability, `setup-${capability}.gguf`);
      const vaultEmbeddingModel = capability === "embed" ? vault.selection.model : null;
      const result = resolveModelCapability({
        capability,
        request: requested,
        env: capability === "embed"
          ? { OMS_EMBEDDING_PROVIDER: "gguf", OMS_EMBEDDING_MODEL: env.selection.model }
          : capability === "rerank"
            ? { OMS_RERANK_PROVIDER: "gguf", OMS_RERANK_MODEL: env.selection.model }
            : { OMS_GENERATE_PROVIDER: "gguf", OMS_GENERATE_MODEL: env.selection.model },
        vaultEmbeddingModel,
        installedArtifacts: [artifact(capability, requested.model), env, vault, setup],
        setupDefaults: [canonicalModelIdentityKey(setup.selection)],
      });
      expect(result.source).toBe("request");
      expect(result.shadowedSources).toEqual(capability === "embed"
        ? ["environment", "vault", "setup-default"]
        : ["environment", "setup-default"]);

      const equivalent = resolveModelCapability({
        capability,
        request: requested,
        vaultEmbeddingModel: capability === "embed" ? requested.model : null,
        installedArtifacts: [artifact(capability, requested.model)],
      });
      expect(equivalent.equivalentSources).toEqual(capability === "embed" ? ["vault"] : []);
    });
  }

  it("selects the settings.json embedding model as the vault source ahead of setup defaults", () => {
    const vault = artifact("embed", "vault-embed.gguf");
    const setup = artifact("embed", "setup-embed.gguf");
    const result = resolveModelCapability({
      capability: "embed",
      env: {},
      vaultEmbeddingModel: vault.selection.model,
      installedArtifacts: [vault, setup],
      setupDefaults: [canonicalModelIdentityKey(setup.selection)],
    });
    expect(result.source).toBe("vault");
    expect(result.artifact?.path).toBe(vault.path);
    expect(result.shadowedSources).toEqual(["setup-default"]);
    expect(() => resolveModelCapability({
      capability: "embed", env: {}, vaultEmbeddingModel: "absent.gguf", installedArtifacts: [setup],
    })).toThrow();
  });

  it("never falls through malformed or missing higher selections, and rejects duplicates", () => {
    expect(() => resolveModelCapability({
      capability: "embed",
      request: { ...selection("embed"), revision: "main" },
      installedArtifacts: [artifact("embed")],
    })).toThrow();
    expect(() => resolveModelCapability({
      capability: "embed",
      request: selection("embed", "absent.gguf"),
      installedArtifacts: [artifact("embed")],
    })).toThrow("exact artifact");
    expect(() => resolveModelCapability({
      capability: "embed",
      installedArtifacts: [artifact("embed"), artifact("embed")],
    })).toThrow("Duplicate installed artifact");
    expect(() => resolveModelCapability({
      capability: "embed",
      installedArtifacts: [{ ...artifact("embed"), embedShape: undefined }],
    })).toThrow("must declare embedShape");
    expect(() => resolveModelCapability({
      capability: "embed",
      installedArtifacts: [{ ...artifact("embed"), embedShape: { dimensions: 768, contextLength: 2048, mrlDim: -1, normalization: "l2" } }],
    })).toThrow("nonnegative integer mrlDim");
    expect(() => resolveModelCapability({
      capability: "embed",
      installedArtifacts: [{ ...artifact("embed"), embedShape: { dimensions: 768, contextLength: 2048, mrlDim: 0, normalization: " " } }],
    })).toThrow("nonblank normalization");
    const key = canonicalModelIdentityKey(artifact("embed").selection);
    expect(() => resolveModelCapability({
      capability: "embed", installedArtifacts: [artifact("embed")], setupDefaults: [key, key],
    })).toThrow("Duplicate setup default");
  });

  it("reports half environment pairs and exact unavailable guidance", () => {
    expect(() => resolveModelCapability({
      capability: "rerank", env: { OMS_RERANK_PROVIDER: "gguf" },
    })).toThrow(/OMS_RERANK_PROVIDER.*OMS_RERANK_MODEL/);
    const unavailable = resolveModelCapability({ capability: "generate", env: {} });
    expect(unavailable.guidance).toContain("OMS_GENERATE_PROVIDER");
    expect(unavailable.guidance).toContain("OMS_GENERATE_MODEL");
    expect(unavailable.guidance).not.toContain(["models", "json"].join("."));
    expect(resolveModelCapability({ capability: "embed", env: {} }).guidance).toContain(".oms/settings.json");
    expect(unavailable.guidance).toContain("oms model install --descriptor");
  });

  it("resolves all three capabilities independently", () => {
    const artifacts = [artifact("embed"), artifact("rerank"), artifact("generate")];
    const result = resolveModelCapabilities({
      requests: { embed: artifacts[0]!.selection, rerank: artifacts[1]!.selection, generate: artifacts[2]!.selection },
      installedArtifacts: artifacts,
    });
    expect(Object.values(result).every((entry) => entry.available)).toBe(true);
  });
});
