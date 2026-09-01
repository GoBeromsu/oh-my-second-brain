import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
  readInstalledModelsReceipt,
  readInstalledModelsReceiptSync,
  resolveEmbeddingModel,
  resolveEmbeddingModelFromCache,
  type InstalledModelsReceipt,
} from "./model.js";
import { canonicalModelIdentityKey } from "./config.js";

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
