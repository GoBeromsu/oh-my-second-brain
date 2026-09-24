import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { link, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireModelSet,
  acquireEmbeddingModel,
  EMBEDDING_MODEL_ENV,
  EMBEDDING_PROVIDER_ENV,
  INSTALLED_MODELS_RECEIPT,
  modelsConfigFromAcquisitionManifest,
  parseEmbeddingModelDescriptor,
  parseModelSetAcquisitionManifest,
  parseInstalledModelsReceipt,
  PINNED_DEFAULT_EMBEDDING_MODEL,
  commitFreshModelSelection,
  prepareFreshModelSelection,
  observeFreshModelSelectionFault,
  readInstalledModelsReceipt,
  readInstalledModelsReceiptSync,
  resolveEmbeddingModel,
  resolveEmbeddingModelFromCache,
  type InstalledModelsReceipt,
} from "./model.js";
import { canonicalModelIdentityKey } from "./config.js";
import { parseModelsConfig } from "./config.js";
import { readVaultSettings } from "../../templates/vault-settings.js";
import type { WriteTarget } from "../../capture/safe.js";

const bytes = new TextEncoder().encode("verified model bytes");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const selection = { provider: "gguf" as const, model: "test.gguf", revision: "v1.2.3", sha256, promptScheme: "embeddinggemma-v1" as const };
const artifact = (pathname: string) => ({
  capability: "embed" as const,
  selection,
  path: pathname,
  embedShape: { dimensions: 768, contextLength: 2048, mrlDim: 0, normalization: "l2" },
});
const receipt = (pathname: string): InstalledModelsReceipt => ({
  schemaVersion: 1,
  artifacts: [artifact(pathname)],
  defaults: [canonicalModelIdentityKey(selection)],
});

async function cacheWithArtifact(): Promise<{ readonly cache: string; readonly model: string }> {
  const cache = await mkdtemp(path.join(tmpdir(), "oms-installed-models-"));
  const model = path.join(cache, "test.gguf");
  await writeFile(model, bytes);
  await writeFile(path.join(cache, INSTALLED_MODELS_RECEIPT), JSON.stringify(receipt(model)));
  return { cache, model };
}

describe("pinned embedding model", () => {
  it("pins an immutable revision, revision URL, and named prompt scheme", () => {
    expect(PINNED_DEFAULT_EMBEDDING_MODEL.revision).toBe("0f741b5a6585bd53aeb15cd1372c56f2a0f65e12");
    expect(PINNED_DEFAULT_EMBEDDING_MODEL.url).toContain(`/resolve/${PINNED_DEFAULT_EMBEDDING_MODEL.revision}/embeddinggemma-300M-Q8_0.gguf`);
    expect(PINNED_DEFAULT_EMBEDDING_MODEL.prefixScheme).toBe("embeddinggemma-v1");
  });

  it("rejects descriptor aliases, permissive providers, and non-named prompt schemes", () => {
    const base = { ...PINNED_DEFAULT_EMBEDDING_MODEL, path: "/models/pinned.gguf" };
    for (const invalid of [
      { ...base, modelPath: base.path },
      { ...base, contextLength: base.context },
      { ...base, contextTokens: base.context },
      { ...base, provider: "remote" },
      { ...base, revision: "main" },
      { ...base, sha256: base.sha256.toUpperCase() },
      { ...base, prefixScheme: "none" },
      { ...base, prefixScheme: '{"query":"x"}' },
    ]) expect(() => parseEmbeddingModelDescriptor(invalid, { requirePath: true })).toThrow();
  });
});

describe("installed model receipt", () => {
  it("rejects malformed, unknown, unsupported, non-absolute, and invalid-default receipts", () => {
    const valid = receipt("/models/test.gguf");
    for (const invalid of [
      "{",
      { ...valid, schemaVersion: 2 },
      { ...valid, unknown: true },
      { ...valid, artifacts: [{ ...artifact("relative.gguf") }] },
      { ...valid, artifacts: [{ ...artifact("/models/test.gguf"), selection: { ...selection, sha256: "A".repeat(64) } }] },
      { ...valid, defaults: ["not-an-artifact"] },
    ]) expect(() => parseInstalledModelsReceipt(invalid)).toThrow();
  });

  it("only treats ENOENT as empty and verifies path, file kind, checksum, and bytes", async () => {
    const cache = await mkdtemp(path.join(tmpdir(), "oms-receipt-"));
    try {
      await expect(readInstalledModelsReceipt({ cacheDir: cache })).resolves.toEqual({ schemaVersion: 1, artifacts: [], defaults: [] });
      expect(readInstalledModelsReceiptSync({ cacheDir: cache })).toEqual({ schemaVersion: 1, artifacts: [], defaults: [] });
      const model = path.join(cache, "test.gguf");
      await writeFile(model, "wrong bytes");
      await writeFile(path.join(cache, INSTALLED_MODELS_RECEIPT), JSON.stringify(receipt(model)));
      await expect(readInstalledModelsReceipt({ cacheDir: cache })).rejects.toThrow(/checksum/);
      expect(() => readInstalledModelsReceiptSync({ cacheDir: cache })).toThrow(/checksum/);
      await writeFile(model, bytes);
      await rm(model);
      await expect(readInstalledModelsReceipt({ cacheDir: cache })).rejects.toThrow(/missing|unreadable/);
      await mkdir(model);
      await expect(readInstalledModelsReceipt({ cacheDir: cache })).rejects.toThrow(/regular file/);
      await writeFile(path.join(cache, INSTALLED_MODELS_RECEIPT), "{");
      await expect(readInstalledModelsReceipt({ cacheDir: cache })).rejects.toThrow(/valid JSON/);
    } finally { await rm(cache, { recursive: true, force: true }); }
  });
});

describe("acquisition", () => {
  it("merges artifacts, makes the acquired embed model the default, and stays outside the vault", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-acquire-"));
    const cache = path.join(root, "cache");
    const vault = path.join(root, "vault");
    let downloads = 0;
    try {
      const acquired = await acquireEmbeddingModel({
        cacheDir: cache, vault,
        descriptor: { ...PINNED_DEFAULT_EMBEDDING_MODEL, model: "test.gguf", revision: "v1.2.3", sha256, url: "https://models.invalid/test.gguf", filename: "test.gguf" },
        fetchImpl: async () => { downloads += 1; return new Response(bytes); },
      });
      expect(acquired.cachePath.startsWith(path.resolve(vault))).toBe(false);
      expect(downloads).toBe(1);
      const installed = await readInstalledModelsReceipt({ cacheDir: cache });
      expect(installed.defaults).toEqual([canonicalModelIdentityKey(installed.artifacts[0]!.selection)]);
      expect(installed.artifacts[0]?.path).toBe(acquired.cachePath);
      expect(Array.from(await readFile(acquired.cachePath))).toEqual(Array.from(bytes));
      await expect(acquireEmbeddingModel({
        cacheDir: cache, descriptor: { ...acquired.descriptor, url: "https://models.invalid/test.gguf" },
        fetchImpl: async () => { downloads += 1; return new Response(new Uint8Array([0])); },
      })).resolves.toMatchObject({ cachePath: acquired.cachePath });
      expect(downloads).toBe(1);
      await expect(acquireEmbeddingModel({ cacheDir: vault, vault, descriptor: { ...PINNED_DEFAULT_EMBEDDING_MODEL, sha256 } })).rejects.toThrow(/outside the vault/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("model-set acquisition manifest", () => {
  const rerankSelection = { provider: "gguf" as const, model: "rerank.gguf", revision: "v1.2.3", sha256 };
  const generateSelection = { provider: "gguf" as const, model: "generate.gguf", revision: "v1.2.3", sha256, promptScheme: "qmd-query-expansion-v2.8.3" as const };
  const manifest = () => ({
    schemaVersion: 1,
    embed: {
      provider: "gguf" as const, model: "embed.gguf", revision: "v1.2.3", sha256, promptScheme: "embeddinggemma-v1" as const,
      url: "https://models.invalid/embed.gguf", filename: "embed.gguf",
      dimensions: 768, contextLength: 2048, mrlDim: 0, normalization: "l2",
    },
    rerank: { ...rerankSelection, url: "https://models.invalid/rerank.gguf", filename: "rerank.gguf" },
    generate: { ...generateSelection, url: "https://models.invalid/generate.gguf", filename: "generate.gguf" },
  });

  /**
   * Registration of weights the user already has on disk.
   *
   * These run against a real temp file rather than a fake filesystem: the feature's
   * entire safety argument is "the declared checksum is verified against the real
   * bytes", and a fake would only confirm that the fake returned what the test told
   * it to. Real files are cheap here (a few bytes) and `mkdtemp` is already this
   * repo's incumbent pattern for filesystem-touching tests.
   */
  describe("local-path registration", () => {
    /** Write the payload somewhere real and hand back its absolute path. */
    async function onDisk(dir: string, name: string, payload: Uint8Array = bytes): Promise<string> {
      const target = path.join(dir, name);
      await writeFile(target, payload);
      return target;
    }

    /** Embed-only manifest pointing at a file already present, not a URL. */
    function localManifest(modelPath: string, overrides: Record<string, unknown> = {}) {
      const { url: _dropUrl, ...embedWithoutUrl } = manifest().embed;
      return {
        schemaVersion: 1,
        embed: { ...embedWithoutUrl, path: modelPath, ...overrides },
      };
    }

    it("installs an on-disk model without fetching anything", async () => {
      // The reason this exists: these weights are commonly shared with other tools,
      // so re-downloading gigabytes that are already on the filesystem is pure waste.
      const root = await mkdtemp(path.join(tmpdir(), "oms-local-"));
      try {
        const cache = path.join(root, "cache");
        const modelPath = await onDisk(root, "already-here.gguf");
        let fetches = 0;

        const acquired = await acquireModelSet({
          manifest: localManifest(modelPath),
          cacheDir: cache,
          fetchImpl: async () => { fetches += 1; return new Response(bytes); },
        });

        expect(fetches).toBe(0);
        expect(acquired.receipt.artifacts[0]?.path).toBe(await realpath(modelPath));
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it("registers by reference instead of copying the file into the cache", async () => {
      // Copying a multi-gigabyte GGUF to record "I have this file" would double the
      // disk cost the feature exists to avoid.
      const root = await mkdtemp(path.join(tmpdir(), "oms-local-"));
      try {
        const cache = path.join(root, "cache");
        const modelPath = await onDisk(root, "stays-put.gguf");

        await acquireModelSet({ manifest: localManifest(modelPath), cacheDir: cache });

        // Only the receipt lands in the cache; the weights are not duplicated.
        expect(await readdir(cache)).toEqual([INSTALLED_MODELS_RECEIPT]);
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it("refuses a file whose real bytes contradict the declared checksum", async () => {
      // Registration by reference is only safe because of this check. Skipping it
      // would let a mislabelled file silently produce vectors from another model.
      const root = await mkdtemp(path.join(tmpdir(), "oms-local-"));
      try {
        const cache = path.join(root, "cache");
        const wrong = await onDisk(root, "different.gguf", new TextEncoder().encode("other bytes"));

        await expect(acquireModelSet({ manifest: localManifest(wrong), cacheDir: cache }))
          .rejects.toThrow(/checksum mismatch/i);
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it("publishes no receipt when the declared file is absent", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "oms-local-"));
      try {
        const cache = path.join(root, "cache");
        const missing = path.join(root, "never-written.gguf");

        await expect(acquireModelSet({ manifest: localManifest(missing), cacheDir: cache }))
          .rejects.toThrow(/not found/i);

        // A failed install must leave no partial state behind to resolve from.
        await expect(readFile(path.join(cache, INSTALLED_MODELS_RECEIPT), "utf8")).rejects.toThrow();
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it("rejects a model file inside the vault, including through a symlink", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "oms-local-"));
      try {
        const vault = path.join(root, "vault");
        const cache = path.join(root, "cache");
        await mkdir(vault);
        const inside = await onDisk(vault, "model.gguf");
        const link = path.join(root, "looks-outside.gguf");
        await symlink(inside, link);

        for (const modelPath of [inside, link]) {
          await expect(acquireModelSet({
            manifest: localManifest(modelPath),
            cacheDir: cache,
            vault,
          })).rejects.toThrow(/must stay outside the vault/);
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it("records a symlink's canonical outside-vault target", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "oms-local-"));
      try {
        const cache = path.join(root, "cache");
        const target = await onDisk(root, "canonical.gguf");
        const link = path.join(root, "alias.gguf");
        await symlink(target, link);

        const acquired = await acquireModelSet({
          manifest: localManifest(link),
          cacheDir: cache,
        });

        expect(acquired.receipt.artifacts[0]?.path).toBe(await realpath(target));
        expect(acquired.receipt.artifacts[0]?.path).not.toBe(link);
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it("requires exactly one source, rejecting both url+path and neither", () => {
      const valid = manifest();
      const { url: _drop, ...noSource } = valid.embed;

      expect(() => parseModelSetAcquisitionManifest({
        schemaVersion: 1,
        embed: { ...valid.embed, path: "/abs/model.gguf" },
      })).toThrow(/either url or path, not both/);

      expect(() => parseModelSetAcquisitionManifest({ schemaVersion: 1, embed: noSource }))
        .toThrow(/either url \(to download\) or path/);
    });

    it("rejects a relative or unnormalized path", () => {
      // A relative path would resolve against whatever cwd the caller happened to
      // have; `..` segments make the receipt's recorded path unverifiable later.
      for (const bad of ["models/model.gguf", "./model.gguf", "/models/../model.gguf"]) {
        expect(() => parseModelSetAcquisitionManifest({
          schemaVersion: 1,
          embed: { ...localManifest("/tmp/x.gguf").embed, path: bad },
        })).toThrow(/absolute filesystem path|normalized/);
      }
    });

    it("keeps the host path out of the portable vault config", async () => {
      // `.oms/models.json` travels with the vault, so a machine-specific path in it
      // would break every other machine that opened the same vault.
      const root = await mkdtemp(path.join(tmpdir(), "oms-local-"));
      try {
        const cache = path.join(root, "cache");
        const modelPath = await onDisk(root, "portable.gguf");

        const acquired = await acquireModelSet({ manifest: localManifest(modelPath), cacheDir: cache });

        const serialized = JSON.stringify(acquired.config);
        expect(serialized).not.toContain(modelPath);
        expect(serialized).not.toContain(root);
        // The identity that does travel is provider/model/revision/checksum.
        expect(acquired.config.embed).toMatchObject({ provider: "gguf", sha256 });
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it("resolves the registered model through the ordinary resolver", async () => {
      // End-to-end proof that this is a real install path and not a parser-only
      // feature: the resolver must select it exactly as it would a downloaded model.
      const root = await mkdtemp(path.join(tmpdir(), "oms-local-"));
      try {
        const cache = path.join(root, "cache");
        const modelPath = await onDisk(root, "resolvable.gguf");

        await acquireModelSet({ manifest: localManifest(modelPath), cacheDir: cache });
        const resolution = await resolveEmbeddingModelFromCache({ cacheDir: cache, env: {} });

        expect(resolution).toMatchObject({ available: true, source: "setup-default" });
        expect(resolution.descriptor?.path).toBe(await realpath(modelPath));
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });

  it("rejects unknown keys, versions, unsafe URLs and filenames, missing embed shape, and invalid prompts", () => {
    const valid = manifest();
    for (const invalid of [
      { ...valid, schemaVersion: 2 },
      { ...valid, unknown: true },
      { ...valid, embed: { ...valid.embed, unknown: true } },
      { ...valid, embed: { ...valid.embed, url: "http://models.invalid/model.gguf" } },
      { ...valid, embed: { ...valid.embed, filename: "../model.gguf" } },
      { ...valid, embed: { ...valid.embed, dimensions: undefined } },
      { ...valid, rerank: { ...valid.rerank, promptScheme: "none" } },
      { ...valid, generate: { ...valid.generate, promptScheme: "none" } },
    ]) expect(() => parseModelSetAcquisitionManifest(invalid)).toThrow();
  });

  it("converts only exact portable selection keys and redacts acquisition paths", () => {
    const config = modelsConfigFromAcquisitionManifest(manifest());
    expect(config).toEqual({
      schemaVersion: 1,
      embed: {
        provider: "gguf", model: "embed.gguf", revision: "v1.2.3", sha256,
        promptScheme: "embeddinggemma-v1",
      },
      rerank: rerankSelection,
      generate: generateSelection,
    });
    expect(Object.keys(config)).toEqual(["schemaVersion", "embed", "rerank", "generate"]);
    expect(Object.keys(config.embed)).toEqual(["provider", "model", "revision", "sha256", "promptScheme"]);
    expect(Object.keys(config.rerank!)).toEqual(["provider", "model", "revision", "sha256"]);
    expect(Object.keys(config.generate!)).toEqual(["provider", "model", "revision", "sha256", "promptScheme"]);
    expect(JSON.stringify(config)).not.toMatch(/https:|filename|dimensions|contextLength|mrlDim|normalization|path/);
    expect(() => modelsConfigFromAcquisitionManifest({ ...manifest(), embed: { ...manifest().embed, path: "/models/embed.gguf" } })).toThrow();
  });

  it("installs all capabilities, preserves unrelated artifacts, replaces defaults, and is idempotent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-model-set-"));
    const cache = path.join(root, "cache");
    let fetches = 0;
    try {
      const first = await acquireModelSet({
        manifest: manifest(), cacheDir: cache,
        fetchImpl: async () => { fetches += 1; return new Response(bytes); },
      });
      expect(fetches).toBe(3);
      expect(first.config).toEqual({ schemaVersion: 1, embed: first.config.embed, rerank: first.config.rerank, generate: first.config.generate });
      expect(JSON.stringify(first.config)).not.toContain("https://");
      expect(JSON.stringify(first.config)).not.toContain(path.resolve(cache));
      for (const selection of [first.config.embed, first.config.rerank, first.config.generate]) {
        expect(selection).toBeDefined();
        expect(selection).not.toHaveProperty("url");
        expect(selection).not.toHaveProperty("filename");
        expect(selection).not.toHaveProperty("embedShape");
      }
      expect(first.receipt.artifacts).toHaveLength(3);
      for (const artifact of first.receipt.artifacts) {
        expect(artifact.selection).not.toHaveProperty("url");
        expect(artifact.selection).not.toHaveProperty("filename");
        expect(artifact.selection).not.toHaveProperty("embedShape");
      }
      expect(first.receipt.defaults).toHaveLength(3);
      expect(first.receipt.artifacts.every((item) => path.isAbsolute(item.path))).toBe(true);

      const extra = {
        capability: "rerank" as const,
        selection: { provider: "gguf" as const, model: "other-rerank.gguf", revision: "v2", sha256 },
        path: path.join(cache, "other-rerank.gguf"),
      };
      await writeFile(extra.path, bytes);
      await writeFile(path.join(cache, INSTALLED_MODELS_RECEIPT), JSON.stringify({
        ...first.receipt,
        artifacts: [...first.receipt.artifacts, extra],
        defaults: [...first.receipt.defaults, canonicalModelIdentityKey(extra.selection)],
      }));
      const merged = await acquireModelSet({
        manifest: manifest(), cacheDir: cache,
        fetchImpl: async () => { fetches += 1; return new Response(bytes); },
      });
      expect(fetches).toBe(3);
      expect(merged.receipt.artifacts).toContainEqual(extra);
      expect(merged.receipt.defaults).not.toContain(canonicalModelIdentityKey(extra.selection));
      expect(merged.receipt.defaults).toHaveLength(3);
      await expect(readInstalledModelsReceipt({ cacheDir: cache })).resolves.toEqual(merged.receipt);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not publish a receipt or leave staged files when a fetch or checksum fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-model-set-rollback-"));
    const cache = path.join(root, "cache");
    try {
      await expect(acquireModelSet({
        manifest: manifest(), cacheDir: cache,
        fetchImpl: async (url) => url.toString().includes("rerank") ? new Response("no", { status: 500 }) : new Response(bytes),
      })).rejects.toThrow(/download failed/);
      await expect(readFile(path.join(cache, INSTALLED_MODELS_RECEIPT))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(cache)).some((filename) => filename.endsWith(".tmp"))).toBe(false);
      await expect(acquireModelSet({
        manifest: manifest(), cacheDir: cache,
        fetchImpl: async () => new Response(new Uint8Array([0])),
      })).rejects.toThrow(/checksum/);
      await expect(readFile(path.join(cache, INSTALLED_MODELS_RECEIPT))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(cache)).some((filename) => filename.endsWith(".tmp"))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("strict embed adapter", () => {
  it("uses request, environment, vault, setup default, then unavailable precedence", async () => {
    const { cache, model } = await cacheWithArtifact();
    try {
      const installed = receipt(model);
      expect(resolveEmbeddingModel({ installedReceipt: installed, request: selection }).source).toBe("request");
      expect(resolveEmbeddingModel({ installedReceipt: installed, env: { [EMBEDDING_PROVIDER_ENV]: "gguf", [EMBEDDING_MODEL_ENV]: "test.gguf" } }).source).toBe("environment");
      expect(resolveEmbeddingModel({ installedReceipt: installed, vaultConfig: { schemaVersion: 1, embed: selection } }).source).toBe("vault");
      expect(resolveEmbeddingModel({ installedReceipt: installed, env: {} }).source).toBe("setup-default");
      const unavailable = resolveEmbeddingModel({ installedReceipt: { schemaVersion: 1, artifacts: [], defaults: [] }, env: {} });
      expect(unavailable).toMatchObject({ available: false, source: "unavailable" });
      expect(unavailable.guidance).toContain(EMBEDDING_PROVIDER_ENV);
      await expect(resolveEmbeddingModelFromCache({ cacheDir: cache, env: {} })).resolves.toMatchObject({ available: true, source: "setup-default" });
    } finally { await rm(cache, { recursive: true, force: true }); }
  });

  it("does not fall back from half pairs, bad receipts, or a selected missing artifact", async () => {
    const { cache, model } = await cacheWithArtifact();
    try {
      const installed = receipt(model);
      expect(() => resolveEmbeddingModel({ installedReceipt: installed, env: { [EMBEDDING_PROVIDER_ENV]: "gguf" } })).toThrow(new RegExp(`${EMBEDDING_PROVIDER_ENV}.*${EMBEDDING_MODEL_ENV}`));
      expect(() => resolveEmbeddingModel({ installedReceipt: { ...installed, artifacts: [], defaults: [] }, request: selection })).toThrow(/exact artifact/);
      await writeFile(path.join(cache, INSTALLED_MODELS_RECEIPT), "{");
      await expect(resolveEmbeddingModelFromCache({ cacheDir: cache })).rejects.toThrow(/valid JSON/);
    } finally { await rm(cache, { recursive: true, force: true }); }
  });

  it("does not include filesystem paths in unavailable status", () => {
    const result = resolveEmbeddingModel({ installedReceipt: { schemaVersion: 1, artifacts: [], defaults: [] }, env: {} });
    expect(JSON.stringify(result)).not.toContain("/Users/");
    expect(JSON.stringify(result)).not.toContain("/tmp/");
  });
});

describe("fresh model selection", () => {
  const roots: string[] = [];
  const vaultId = "11111111-1111-4111-8111-111111111111";
  const otherId = "22222222-2222-4222-8222-222222222222";
  const modelConfig = {
    schemaVersion: 1 as const,
    embed: { provider: "gguf" as const, model: "test.gguf", revision: "v1.2.3", sha256, promptScheme: "embeddinggemma-v1" as const },
  };
  const canonicalText = `${JSON.stringify(modelConfig, null, 2)}\n`;

  async function temp(prefix: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  async function settings(vault: string, id = vaultId): Promise<void> {
    await writeFile(path.join(vault, ".oms", "settings.json"), `${JSON.stringify({ version: 1, vaultId: id, templateRoots: [] }, null, 2)}\n`);
  }

  async function vault(withOms = true): Promise<string> {
    const root = await temp("oms-fresh-model-");
    const directory = path.join(root, "vault");
    await mkdir(withOms ? path.join(directory, ".oms") : directory, { recursive: true });
    return realpath(directory);
  }

  function target(value: string, source: WriteTarget["source"] | "unsafe" = "explicit"): WriteTarget {
    return { vault: value, source: source as WriteTarget["source"] };
  }

  async function names(directory: string): Promise<string[]> {
    return (await readdir(directory, { withFileTypes: true })).map(entry => entry.name).sort();
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it("prepares an absent vault and absent .oms without writes, before settings exist", async () => {
    const root = await temp("oms-fresh-absent-");
    const missing = path.join(root, "missing");
    await expect(prepareFreshModelSelection({ target: target(missing), config: modelConfig })).rejects.toMatchObject({ reason: "missing-parent" });
    expect(await names(root)).toEqual([]);
    const bare = await vault(false);
    const prepared = await prepareFreshModelSelection({ target: target(bare), config: structuredClone(modelConfig) });
    expect(prepared).toMatchObject({ canonicalVault: bare, expectedCurrent: "sha256:absent", disposition: "create", config: modelConfig });
    expect(await names(bare)).toEqual([]);
    expect(await readVaultSettings(bare)).toBeNull();
    await expect(commitFreshModelSelection({
      target: target(bare), config: modelConfig, expectedCurrent: prepared.expectedCurrent, expectedConfigDigest: prepared.configDigest, expectedVaultId: vaultId,
    })).rejects.toMatchObject({ reason: "missing-parent" });
    expect(await names(bare)).toEqual([]);
  });

  it("creates once from an existing .oms, reads canonical bytes back, and repeats the original absent token", async () => {
    const present = await vault();
    await settings(present);
    const prepared = await prepareFreshModelSelection({ target: target(present), config: modelConfig });
    const filename = path.join(present, ".oms", "models.json");
    const request = {
      target: target(present), config: modelConfig, expectedCurrent: "sha256:absent" as const, expectedConfigDigest: prepared.configDigest, expectedVaultId: vaultId,
    };
    const first = await commitFreshModelSelection(request);
    expect(first).toEqual({ status: "written", path: filename, configDigest: prepared.configDigest, verified: true });
    const written = await lstat(filename);
    expect(written.nlink).toBe(1);
    expect((await names(path.join(present, ".oms"))).filter(name => name.startsWith(".models.json.oms-"))).toEqual([]);
    const persisted = await readFile(filename);
    expect(persisted.toString("utf8")).toBe(canonicalText);
    expect(parseModelsConfig(persisted.toString("utf8"))).toEqual(modelConfig);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(commitFreshModelSelection(request)).resolves.toEqual({ status: "unchanged", path: filename, configDigest: prepared.configDigest, verified: true });
    }
    expect((await lstat(filename)).ino).toBe(written.ino);
    expect(await readFile(filename)).toEqual(persisted);
    expect((await readVaultSettings(present))?.vaultId).toBe(vaultId);
  });

  it("commits an exact existing selection through the prepared non-absent digest without rewriting it", async () => {
    const present = await vault();
    await settings(present);
    const filename = path.join(present, ".oms", "models.json");
    await writeFile(filename, canonicalText);
    const before = await lstat(filename);
    const prepared = await prepareFreshModelSelection({ target: target(present), config: modelConfig });
    expect(prepared.disposition).toBe("unchanged");
    expect(prepared.expectedCurrent).not.toBe("sha256:absent");
    const committed = await commitFreshModelSelection({
      target: target(present), config: modelConfig, expectedCurrent: prepared.expectedCurrent, expectedConfigDigest: prepared.configDigest, expectedVaultId: vaultId,
    });
    expect(committed).toEqual({ status: "unchanged", path: filename, configDigest: prepared.configDigest, verified: true });
    const after = await lstat(filename);
    expect(after.ino).toBe(before.ino);
    expect(after.nlink).toBe(1);
    expect(await readFile(filename, "utf8")).toBe(canonicalText);
  });

  it("preserves different formatting, canonical bytes, and malformed JSON", async () => {
    const present = await vault();
    await settings(present);
    const filename = path.join(present, ".oms", "models.json");
    for (const existing of [JSON.stringify(modelConfig), "{", `${JSON.stringify({ ...modelConfig, embed: { ...modelConfig.embed, revision: "v9" } }, null, 2)}\n`]) {
      await writeFile(filename, existing);
      const before = await lstat(filename);
      const prepared = await prepareFreshModelSelection({ target: target(present), config: modelConfig });
      expect(prepared.disposition).toBe("conflict");
      await expect(commitFreshModelSelection({
        target: target(present), config: modelConfig, expectedCurrent: prepared.expectedCurrent, expectedConfigDigest: prepared.configDigest, expectedVaultId: vaultId,
      })).rejects.toMatchObject({ reason: "conflict" });
      expect(await readFile(filename, "utf8")).toBe(existing);
      expect((await lstat(filename)).ino).toBe(before.ino);
    }
  });

  it("rejects stale expected state and config digest without writing", async () => {
    const present = await vault();
    await settings(present);
    const prepared = await prepareFreshModelSelection({ target: target(present), config: modelConfig });
    await expect(commitFreshModelSelection({
      target: target(present), config: modelConfig, expectedCurrent: prepared.configDigest, expectedConfigDigest: prepared.configDigest, expectedVaultId: vaultId,
    })).rejects.toMatchObject({ reason: "stale" });
    await expect(commitFreshModelSelection({
      target: target(present), config: modelConfig, expectedCurrent: "sha256:absent", expectedConfigDigest: `sha256:${"ab".repeat(32)}`, expectedVaultId: vaultId,
    })).rejects.toMatchObject({ reason: "stale" });
    expect(await names(path.join(present, ".oms"))).toEqual(["settings.json"]);
  });

  it("refuses cwd, legacy-bridge, and unexpected sources before any model write", async () => {
    const present = await vault();
    const prepared = await prepareFreshModelSelection({ target: target(present), config: modelConfig });
    for (const source of ["cwd", "legacy-bridge", "unsafe"] as const) {
      await expect(prepareFreshModelSelection({ target: target(present, source), config: modelConfig })).rejects.toMatchObject({ reason: "target-unverified" });
      await expect(commitFreshModelSelection({
        target: target(present, source), config: modelConfig, expectedCurrent: "sha256:absent", expectedConfigDigest: prepared.configDigest, expectedVaultId: vaultId,
      })).rejects.toMatchObject({ reason: "target-unverified" });
    }
    expect(await names(path.join(present, ".oms"))).toEqual([]);
  });

  it("admits a public vault symlink and refuses private parent, leaf, and hardlink aliases", async () => {
    const root = await temp("oms-fresh-alias-");
    const present = path.join(root, "vault");
    await mkdir(path.join(present, ".oms"), { recursive: true });
    const canonical = await realpath(present);
    const alias = path.join(root, "public-alias");
    await symlink(canonical, alias);
    const prepared = await prepareFreshModelSelection({ target: target(alias), config: modelConfig });
    expect(prepared.canonicalVault).toBe(canonical);
    expect(prepared.disposition).toBe("create");
    await rm(path.join(canonical, ".oms"), { recursive: true });
    await symlink(path.join(root, "outside-oms"), path.join(canonical, ".oms"));
    await mkdir(path.join(root, "outside-oms"));
    await expect(prepareFreshModelSelection({ target: target(alias), config: modelConfig })).rejects.toMatchObject({ reason: "unsafe-target" });
    await rm(path.join(canonical, ".oms"));
    await mkdir(path.join(canonical, ".oms"));
    const outside = path.join(root, "outside.json");
    await writeFile(outside, "{\"not\":\"canonical\"}");
    await symlink(outside, path.join(canonical, ".oms", "models.json"));
    await expect(prepareFreshModelSelection({ target: target(alias), config: modelConfig })).rejects.toMatchObject({ reason: "unsafe-target" });
    expect(await readFile(outside, "utf8")).toBe("{\"not\":\"canonical\"}");
    await rm(path.join(canonical, ".oms", "models.json"));
    await writeFile(path.join(canonical, ".oms", "models.json"), canonicalText);
    const twin = path.join(root, "hardlink.json");
    await link(path.join(canonical, ".oms", "models.json"), twin);
    await expect(prepareFreshModelSelection({ target: target(alias), config: modelConfig })).rejects.toMatchObject({ reason: "unsafe-target" });
    expect(await readFile(twin, "utf8")).toBe(canonicalText);
  });

  it("reports equal and different real EEXIST races without replacing user bytes", async () => {
    const present = await vault();
    await settings(present);
    const prepared = await prepareFreshModelSelection({ target: target(present), config: modelConfig });
    const filename = path.join(present, ".oms", "models.json");
    const actualLink = fs.promises.link.bind(fs.promises);
    let fired = 0;
    const race = async (competitor: string) => {
      const spy = vi.spyOn(fs.promises, "link").mockImplementation(async (existing, destination) => {
        fired += 1;
        if (String(destination) === filename) await writeFile(filename, competitor);
        return actualLink(existing, destination);
      });
      syncBuiltinESMExports();
      try {
        return await commitFreshModelSelection({
          target: target(present), config: modelConfig, expectedCurrent: "sha256:absent", expectedConfigDigest: prepared.configDigest, expectedVaultId: vaultId,
        });
      } finally {
        spy.mockRestore();
        syncBuiltinESMExports();
      }
    };
    await expect(race(canonicalText)).resolves.toMatchObject({ status: "unchanged", verified: true, path: filename });
    expect(fired).toBe(1);
    expect((await lstat(filename)).nlink).toBe(1);
    expect(await readFile(filename, "utf8")).toBe(canonicalText);
    await rm(filename);
    await expect(race("{")).rejects.toMatchObject({ reason: "conflict", code: "EEXIST" });
    expect(await readFile(filename, "utf8")).toBe("{");
    expect(fired).toBe(2);
    expect((await names(path.join(present, ".oms"))).filter(name => name.startsWith(".models.json.oms-"))).toEqual([]);
  });

  it("cleans an owned staging fault and reports reconciliation uncertainty without deleting user files", async () => {
    const present = await vault();
    await settings(present);
    const prepared = await prepareFreshModelSelection({ target: target(present), config: modelConfig });
    const sentinel = path.join(present, ".oms", "user-note.txt");
    await writeFile(sentinel, "keep");
    observeFreshModelSelectionFault("fresh-model-fault", "after-staging");
    try {
      await expect(commitFreshModelSelection({
        target: target(present), config: modelConfig, expectedCurrent: "sha256:absent", expectedConfigDigest: prepared.configDigest, expectedVaultId: vaultId, faultToken: "fresh-model-fault",
      })).rejects.toMatchObject({ reason: "io", code: "injected-fault" });
    } finally {
      observeFreshModelSelectionFault("fresh-model-fault", undefined);
    }
    expect(await readFile(sentinel, "utf8")).toBe("keep");
    expect(await names(path.join(present, ".oms"))).toEqual(["settings.json", "user-note.txt"]);
  });

  it("cleans an owned write fault and does not adopt a same-byte staging replacement", async () => {
    const present = await vault();
    await settings(present);
    const prepared = await prepareFreshModelSelection({ target: target(present), config: modelConfig });
    const sentinel = path.join(present, ".oms", "user-note.txt");
    await writeFile(sentinel, "keep");
    const originalOpen = fs.promises.open.bind(fs.promises);
    let writeFired = 0;
    const writeSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).includes(".models.json.oms-") && String(args[1]).includes("w")) {
        writeFired += 1;
        vi.spyOn(handle, "writeFile").mockImplementation(async () => {
          const error = new Error("write failed") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await expect(commitFreshModelSelection({
        target: target(present), config: modelConfig, expectedCurrent: "sha256:absent", expectedConfigDigest: prepared.configDigest, expectedVaultId: vaultId,
      })).rejects.toMatchObject({ reason: "io", code: "EIO" });
    } finally {
      writeSpy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(writeFired).toBe(1);
    expect(await names(path.join(present, ".oms"))).toEqual(["settings.json", "user-note.txt"]);
    const replacedOpen = fs.promises.open.bind(fs.promises);
    let replaceFired = 0;
    let foreign = "";
    let replacement = "";
    const replaceSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await replacedOpen(...args);
      const staging = String(args[0]);
      if (staging.includes(".models.json.oms-") && String(args[1]).includes("w")) {
        replaceFired += 1;
        const originalWrite = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementation(async contents => {
          await originalWrite(contents);
          foreign = path.join(path.dirname(staging), "foreign-same-bytes.json");
          replacement = staging;
          await fs.promises.rename(staging, foreign);
          await writeFile(staging, canonicalText);
          const error = new Error("write failed after replacement") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await expect(commitFreshModelSelection({
        target: target(present), config: modelConfig, expectedCurrent: "sha256:absent", expectedConfigDigest: prepared.configDigest, expectedVaultId: vaultId,
      })).rejects.toMatchObject({ reason: "reconciliation-uncertain" });
    } finally {
      replaceSpy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(replaceFired).toBe(1);
    expect(await readFile(foreign, "utf8")).toBe(canonicalText);
    expect(await readFile(replacement, "utf8")).toBe(canonicalText);
    expect(await readFile(sentinel, "utf8")).toBe("keep");
    await rm(foreign);
    await rm(replacement);
  });

  it("refuses publication when identity or the staged file changes after staging", async () => {
    const present = await vault();
    await settings(present);
    const prepared = await prepareFreshModelSelection({ target: target(present), config: modelConfig });
    const foreign = path.join(present, ".oms", "foreign-stage.json");
    const actualOpen = fs.promises.open.bind(fs.promises);
    let identityFired = 0;
    const identitySpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      if (String(args[0]).includes(".models.json.oms-") && String(args[1]).includes("w")) {
        identityFired += 1;
        const originalSync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          await originalSync();
          await settings(present, otherId);
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await expect(commitFreshModelSelection({
        target: target(present), config: modelConfig, expectedCurrent: "sha256:absent", expectedConfigDigest: prepared.configDigest, expectedVaultId: vaultId,
      })).rejects.toMatchObject({ reason: "identity-mismatch" });
    } finally {
      identitySpy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(identityFired).toBe(1);
    expect(await names(path.join(present, ".oms"))).toEqual(["settings.json"]);
    await settings(present, vaultId);
    let parentFired = 0;
    const parentSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      const staging = String(args[0]);
      if (staging.includes(".models.json.oms-") && String(args[1]).includes("w")) {
        parentFired += 1;
        const originalSync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          await originalSync();
          await fs.promises.rename(staging, foreign);
          await writeFile(staging, "foreign");
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await expect(commitFreshModelSelection({
        target: target(present), config: modelConfig, expectedCurrent: "sha256:absent", expectedConfigDigest: prepared.configDigest, expectedVaultId: vaultId,
      })).rejects.toMatchObject({ reason: "reconciliation-uncertain" });
    } finally {
      parentSpy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(parentFired).toBe(1);
    expect(await readFile(foreign, "utf8")).toBe(canonicalText);
    expect((await names(path.join(present, ".oms"))).filter(name => name.startsWith(".models.json.oms-"))).not.toEqual([]);
    expect(await names(path.join(present, ".oms"))).toContain("foreign-stage.json");
    expect(await names(path.join(present, ".oms"))).not.toContain("models.json");
    await rm(foreign);
  });

  it("does not publish into a root or .oms replaced after the first model inspection", async () => {
    const root = await temp("oms-fresh-parent-race-");
    const present = path.join(root, "vault");
    await mkdir(path.join(present, ".oms"), { recursive: true });
    const canonical = await realpath(present);
    await settings(canonical);
    const prepared = await prepareFreshModelSelection({ target: target(canonical), config: modelConfig });
    const replacement = path.join(root, "replacement-vault");
    await mkdir(path.join(replacement, ".oms"), { recursive: true });
    await writeFile(path.join(replacement, ".oms", "settings.json"), `${JSON.stringify({ version: 1, vaultId, templateRoots: [] }, null, 2)}\n`);
    const actualLstat = fs.promises.lstat.bind(fs.promises);
    let fired = 0;
    const spy = vi.spyOn(fs.promises, "lstat").mockImplementation(async target => {
      const stat = await actualLstat(target);
      if (String(target) === path.join(canonical, ".oms", "models.json")) {
        fired += 1;
        if (fired === 1) await fs.promises.rename(canonical, path.join(root, "original-vault"));
        if (fired === 1) await fs.promises.rename(replacement, canonical);
      }
      return stat;
    });
    syncBuiltinESMExports();
    try {
      await expect(commitFreshModelSelection({
        target: target(canonical), config: modelConfig, expectedCurrent: prepared.expectedCurrent, expectedConfigDigest: prepared.configDigest, expectedVaultId: vaultId,
      })).rejects.toMatchObject({ reason: "external-change" });
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(fired).toBeGreaterThan(0);
    // The substituted directory never receives the publication, and the refusal
    // discloses that the approved directory identity is gone: the owned bytes
    // stay on the original inode, which is no longer reachable by this path.
    expect(await names(path.join(canonical, ".oms"))).toEqual(["settings.json"]);
    expect(await names(path.join(root, "original-vault", ".oms"))).toContain("settings.json");
    expect(await names(path.join(root, "original-vault", ".oms"))).not.toEqual(["settings.json"]);
  });

  it("refuses a byte-identical external symlink substituted for the verified model leaf", async () => {
    const present = await vault();
    await settings(present);
    const prepared = await prepareFreshModelSelection({ target: target(present), config: modelConfig });
    const outside = path.join(path.dirname(present), "external-models.json");
    await writeFile(outside, canonicalText);
    const filename = path.join(present, ".oms", "models.json");
    const actualLink = fs.promises.link.bind(fs.promises);
    let fired = 0;
    const spy = vi.spyOn(fs.promises, "link").mockImplementation(async (from, to) => {
      await actualLink(from, to);
      if (String(to) === filename) {
        fired += 1;
        await fs.promises.rename(filename, path.join(present, ".oms", "owned-stage.json"));
        await symlink(outside, filename);
      }
    });
    syncBuiltinESMExports();
    try {
      await expect(commitFreshModelSelection({
        target: target(present), config: modelConfig, expectedCurrent: prepared.expectedCurrent, expectedConfigDigest: prepared.configDigest, expectedVaultId: vaultId,
      })).rejects.toBeInstanceOf(Error);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(fired).toBe(1);
    expect((await lstat(filename)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe(canonicalText);
  });

  it("refuses when settings change during the final held model read and rejects oversize bytes", async () => {
    const present = await vault();
    await settings(present);
    const prepared = await prepareFreshModelSelection({ target: target(present), config: modelConfig });
    const filename = path.join(present, ".oms", "models.json");
    const actualOpen = fs.promises.open.bind(fs.promises);
    let readFired = 0;
    const readSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      if (String(args[0]) === filename && !String(args[1]).includes("w")) {
        readFired += 1;
        const originalRead = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
          await settings(present, otherId);
          return originalRead(...readArgs);
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await expect(commitFreshModelSelection({
        target: target(present), config: modelConfig, expectedCurrent: prepared.expectedCurrent, expectedConfigDigest: prepared.configDigest, expectedVaultId: vaultId,
      })).rejects.toMatchObject({ reason: "identity-mismatch" });
    } finally {
      readSpy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(readFired).toBeGreaterThan(0);
    expect((await readVaultSettings(present))?.vaultId).toBe(otherId);
    await settings(present, vaultId);
    await writeFile(filename, Buffer.alloc(256 * 1024 + 1, 0x61));
    await expect(prepareFreshModelSelection({ target: target(present), config: modelConfig })).rejects.toMatchObject({ reason: "malformed" });
    const oversized = { ...modelConfig, embed: { ...modelConfig.embed, model: "x".repeat(256 * 1024) } };
    await expect(prepareFreshModelSelection({ target: target(present), config: oversized })).rejects.toMatchObject({ reason: "malformed" });
    expect((await lstat(filename)).size).toBe(256 * 1024 + 1);
  });

  it("rejects identity drift between prepare and commit and keeps the settings file authoritative", async () => {
    const present = await vault();
    const prepared = await prepareFreshModelSelection({ target: target(present), config: modelConfig });
    expect(prepared.disposition).toBe("create");
    await expect(commitFreshModelSelection({
      target: target(present), config: modelConfig, expectedCurrent: prepared.expectedCurrent, expectedConfigDigest: prepared.configDigest, expectedVaultId: vaultId,
    })).rejects.toMatchObject({ reason: "missing-identity" });
    await settings(present, otherId);
    await expect(commitFreshModelSelection({
      target: target(present), config: modelConfig, expectedCurrent: prepared.expectedCurrent, expectedConfigDigest: prepared.configDigest, expectedVaultId: vaultId,
    })).rejects.toMatchObject({ reason: "identity-mismatch" });
    expect(await names(path.join(present, ".oms"))).toEqual(["settings.json"]);
    expect((await readVaultSettings(present))?.vaultId).toBe(otherId);
  });

  it("keeps concurrent independent vault operations from sharing publication state", async () => {
    const left = await vault();
    const right = await vault();
    await settings(left, vaultId);
    await settings(right, otherId);
    const leftPrepared = await prepareFreshModelSelection({ target: target(left), config: modelConfig });
    const rightConfig = { ...modelConfig, embed: { ...modelConfig.embed, revision: "right-v1" } };
    const rightPrepared = await prepareFreshModelSelection({ target: target(right), config: rightConfig });
    const [leftResult, rightResult] = await Promise.all([
      commitFreshModelSelection({ target: target(left), config: modelConfig, expectedCurrent: "sha256:absent", expectedConfigDigest: leftPrepared.configDigest, expectedVaultId: vaultId }),
      commitFreshModelSelection({ target: target(right), config: rightConfig, expectedCurrent: "sha256:absent", expectedConfigDigest: rightPrepared.configDigest, expectedVaultId: otherId }),
    ]);
    expect(leftResult.status).toBe("written");
    expect(rightResult.status).toBe("written");
    expect(leftResult.configDigest).not.toBe(rightResult.configDigest);
    expect(await readFile(leftResult.path, "utf8")).not.toBe(await readFile(rightResult.path, "utf8"));
    expect((await readVaultSettings(left))?.vaultId).toBe(vaultId);
    expect((await readVaultSettings(right))?.vaultId).toBe(otherId);
  });
});