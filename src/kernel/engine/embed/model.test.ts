import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  acquireEmbeddingModel,
  CAPABILITY_RECEIPT,
  EMBEDDING_MODEL_ENV,
  EMBEDDING_PROVIDER_ENV,
  embeddingModelCacheDir,
  INSTALLED_DEFAULT_DESCRIPTOR,
  PINNED_DEFAULT_EMBEDDING_MODEL,
  readInstalledEmbeddingDefault,
  resolveEmbeddingModel,
} from "./model.js";
import { openEngineStoreCore, openEngineStoreCoreReadOnly } from "./store.js";
import { syncEngineStore } from "./sync.js";
import { assembleEngineReadOnly } from "../assemble.js";

const envNames = [EMBEDDING_PROVIDER_ENV, EMBEDDING_MODEL_ENV] as const;
const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of envNames) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("resolveEmbeddingModel", () => {
  it("uses an explicit environment pair with its matching complete descriptor", () => {
    const resolved = resolveEmbeddingModel({
      env: {
        [EMBEDDING_PROVIDER_ENV]: "gguf",
        [EMBEDDING_MODEL_ENV]: "/configured/model.gguf",
      },
      installedDefault: {
        provider: "gguf",
        model: "configured",
        path: "/configured/model.gguf",
        dimensions: 1024,
        context: 8192,
        mrlDim: 0,
        normalization: "l2",
        prefixScheme: "none",
      },
    });

    expect(resolved).toMatchObject({
      available: true,
      source: "configured",
      provider: "gguf",
      model: "/configured/model.gguf",
    });
    expect(resolved.descriptor).toMatchObject({
      dimensions: 1024,
      context: 8192,
      mrlDim: 0,
      normalization: "l2",
      prefixScheme: "none",
    });
  });

  it("rejects an explicit environment pair with an incomplete descriptor", () => {
    expect(() => resolveEmbeddingModel({
      env: {
        [EMBEDDING_PROVIDER_ENV]: "gguf",
        [EMBEDDING_MODEL_ENV]: "/configured/model.gguf",
      },
      installedDefault: {
        provider: "gguf",
        model: "configured",
        path: "/configured/model.gguf",
      },
    })).toThrow(/descriptor is incomplete/);
  });

  it("uses an installed default when neither environment variable is set", () => {
    const resolved = resolveEmbeddingModel({
      env: {},
      installedDefault: {
        provider: "gguf",
        model: "bge-m3",
        path: "/cache/bge-m3.gguf",
      },
    });

    expect(resolved).toMatchObject({
      available: true,
      source: "installed-default",
      provider: "gguf",
      model: "bge-m3",
      modelPath: "/cache/bge-m3.gguf",
    });
    expect(resolved.receipt.guidance).toContain(EMBEDDING_PROVIDER_ENV);
    expect(resolved.receipt.guidance).toContain(EMBEDDING_MODEL_ENV);
    expect(resolved.receipt.guidance).toContain("/cache/bge-m3.gguf");
  });

  it("reports unconfigured embedding capability without claiming plain setup installs a model", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "oms-no-default-"));
    try {
      const resolved = resolveEmbeddingModel({ env: {}, cacheDir });
      expect(resolved).toMatchObject({ available: false, source: "none" });
      expect(resolved.provider).toBeUndefined();
      expect(resolved.model).toBeUndefined();
      expect(resolved.receipt.available).toBe(false);
      expect(resolved.receipt.guidance).toContain(EMBEDDING_PROVIDER_ENV);
      expect(resolved.receipt.guidance).toContain(EMBEDDING_MODEL_ENV);
      expect(resolved.receipt.guidance).toContain("oms setup --embedding-descriptor");
      expect(resolved.receipt.guidance).not.toContain("`oms setup` to install");
      await expect(readFile(path.join(cacheDir, INSTALLED_DEFAULT_DESCRIPTOR))).rejects.toThrow();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("never resolves the pinned default implicitly", async () => {
    // The E-1 no-default contract verifies at runtime that embedding capability
    // stays honestly unavailable with no env pair and an empty cache. Shipping a
    // pinned descriptor must not become an implicit fallback, or that contract
    // and ADR-007 P-B both break. The constant is for explicit acquisition only.
    const cacheDir = await mkdtemp(path.join(tmpdir(), "oms-pinned-implicit-"));
    try {
      const resolved = resolveEmbeddingModel({ env: {}, cacheDir });
      expect(resolved).toMatchObject({ available: false, source: "none" });
      expect(resolved.provider).toBeUndefined();
      expect(resolved.model).toBeUndefined();
      expect(resolved.descriptor).toBeUndefined();
      // Resolution is read-only: it must not publish the pinned descriptor.
      await expect(readFile(path.join(cacheDir, INSTALLED_DEFAULT_DESCRIPTOR))).rejects.toThrow();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("points an unconfigured vault at the one-step default install", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "oms-pinned-guidance-"));
    try {
      const guidance = resolveEmbeddingModel({ env: {}, cacheDir }).receipt.guidance;
      expect(guidance).toContain("oms setup --embedding-default");
      expect(guidance).toContain(EMBEDDING_PROVIDER_ENV);
      expect(guidance).toContain(EMBEDDING_MODEL_ENV);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("ships a pinned descriptor complete enough to resolve and sync", () => {
    // An incomplete descriptor throws in assertCompleteDescriptor / vector sync,
    // so the shipped constant must carry every identity field up front.
    const resolved = resolveEmbeddingModel({
      env: {
        [EMBEDDING_PROVIDER_ENV]: PINNED_DEFAULT_EMBEDDING_MODEL.provider,
        [EMBEDDING_MODEL_ENV]: PINNED_DEFAULT_EMBEDDING_MODEL.model,
      },
      installedDefault: PINNED_DEFAULT_EMBEDDING_MODEL,
    });

    expect(resolved.available).toBe(true);
    expect(resolved.descriptor?.dimensions).toBe(768);
    expect(PINNED_DEFAULT_EMBEDDING_MODEL.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(PINNED_DEFAULT_EMBEDDING_MODEL.url).toContain("embeddinggemma-300M-Q8_0.gguf");
  });

  it("declares qmd's EmbeddingGemma prompts with a per-chunk title slot", () => {
    // Byte-compatible with qmd's formatQueryForEmbedding /
    // formatDocForEmbedding so the same note embeds identically under either
    // toolchain. `{title}` is what carries the document title per chunk.
    const scheme = JSON.parse(PINNED_DEFAULT_EMBEDDING_MODEL.prefixScheme!) as {
      query: string;
      passage: string;
    };

    expect(scheme.query).toBe("task: search result | query: ");
    expect(scheme.passage).toBe("title: {title} | text: ");
  });

  it("rejects a half-configured pair and names both canonical variables", () => {
    expect(() => resolveEmbeddingModel({
      env: { [EMBEDDING_PROVIDER_ENV]: "gguf" },
      installedDefault: { provider: "gguf", model: "fallback" },
    })).toThrow(new RegExp(`${EMBEDDING_PROVIDER_ENV}.*${EMBEDDING_MODEL_ENV}`));

    expect(() => resolveEmbeddingModel({
      env: { [EMBEDDING_MODEL_ENV]: "model.gguf" },
    })).toThrow(new RegExp(`${EMBEDDING_PROVIDER_ENV}.*${EMBEDDING_MODEL_ENV}`));
  });
});

describe("failure and identity propagation", () => {
  it("does not convert a corrupt SQLite store into an absent index", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "oms-corrupt-store-"));
    const dbPath = path.join(directory, "engine-store.sqlite");
    try {
      await writeFile(dbPath, "not sqlite", "utf8");
      expect(() => openEngineStoreCoreReadOnly(dbPath)).toThrow(/corrupt|unreadable|unavailable/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports vault scan I/O errors rather than publishing an empty sync", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-sync-io-"));
    const dbPath = path.join(vault, "engine-store.sqlite");
    const nonDirectory = path.join(vault, "note.md");
    try {
      await writeFile(nonDirectory, "# note\n", "utf8");
      const result = await syncEngineStore({
        vault,
        dbPath,
        collectionPath: "note.md",
        embed: false,
      });
      expect(result).toMatchObject({ available: false, scanned: 0 });
      expect(result.reason).toMatch(/Unable to scan vault directory/);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it("rejects a configured identity that differs from a read-only vector store", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-readonly-identity-"));
    const dbPath = path.join(vault, "engine-store.sqlite");
    const store = openEngineStoreCore(dbPath);
    const previousKey = process.env["UPSTAGE_API_KEY"];
    try {
      store.writeEmbeddingIdentity({
        provider: "upstage",
        model: "stored-model",
        dimensions: 1024,
        contextLength: 8192,
        mrlDim: 0,
        normalization: "l2",
        prefixScheme: "none",
        fingerprint: "stored",
      });
      store.close();
      process.env["UPSTAGE_API_KEY"] = "test-key";
      expect(() => assembleEngineReadOnly({
        vault,
        dbPath,
        embeddingProvider: "upstage",
        embeddingModel: "configured-model",
        embeddingDescriptor: {
          provider: "upstage",
          model: "configured-model",
          dimensions: 1024,
          context: 8192,
          mrlDim: 0,
          normalization: "l2",
          prefixScheme: "none",
        },
      })).toThrow(/identity mismatch/i);
    } finally {
      if (previousKey === undefined) delete process.env["UPSTAGE_API_KEY"];
      else process.env["UPSTAGE_API_KEY"] = previousKey;
      await rm(vault, { recursive: true, force: true });
    }
  });
});

describe("acquireEmbeddingModel", () => {
  it("verifies downloaded bytes, caches outside the vault, and seeds a capability receipt", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-model-home-"));
    const vault = path.join(home, "vault");
    const cacheDir = path.join(home, "model-cache");
    const bytes = new TextEncoder().encode("model bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let downloads = 0;

    try {
      const result = await acquireEmbeddingModel({
        vault,
        cacheDir,
        descriptor: {
          provider: "gguf",
          model: "bge-m3",
          filename: "bge-m3.gguf",
          url: "https://models.invalid/bge-m3.gguf",
          sha256,
        },
        fetchImpl: async () => {
          downloads += 1;
          return new Response(bytes);
        },
      });

      expect(result.cachePath).toBe(path.join(cacheDir, "bge-m3.gguf"));
      expect(result.cachePath.startsWith(path.resolve(vault))).toBe(false);
      expect(result.receipt).toMatchObject({
        kind: "embedding-capability",
        available: true,
        source: "setup",
        modelPath: result.cachePath,
        cachePath: result.cachePath,
        sha256,
      });
      expect(result.receipt.guidance).toContain(EMBEDDING_PROVIDER_ENV);
      expect(result.receipt.guidance).toContain(EMBEDDING_MODEL_ENV);
      expect(await readFile(path.join(cacheDir, INSTALLED_DEFAULT_DESCRIPTOR), "utf8")).toContain(result.cachePath);
      expect(await readFile(path.join(cacheDir, CAPABILITY_RECEIPT), "utf8")).toContain("embedding-capability");
      expect(Array.from(await readFile(result.cachePath))).toEqual(Array.from(bytes));
      expect(await readInstalledEmbeddingDefault({ cacheDir })).toMatchObject({
        provider: "gguf",
        model: "bge-m3",
        path: result.cachePath,
        sha256,
      });
      expect(resolveEmbeddingModel({ env: {}, cacheDir })).toMatchObject({
        available: true,
        source: "installed-default",
        provider: "gguf",
        modelPath: result.cachePath,
      });

      const cached = await acquireEmbeddingModel({
        vault,
        cacheDir,
        descriptor: result.descriptor as typeof result.descriptor & { url: string; sha256: string },
        fetchImpl: async () => {
          downloads += 1;
          return new Response(new Uint8Array([0]));
        },
      });
      expect(cached.cachePath).toBe(result.cachePath);
      expect(downloads).toBe(1);
      await expect(readdir(vault)).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("fails closed on a checksum mismatch and does not publish a model", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "oms-model-cache-"));
    const bytes = new TextEncoder().encode("tampered model");
    try {
      await expect(acquireEmbeddingModel({
        cacheDir,
        descriptor: {
          provider: "gguf",
          model: "bad",
          url: "https://models.invalid/bad.gguf",
          sha256: "0".repeat(64),
        },
        fetchImpl: async () => new Response(bytes),
      })).rejects.toThrow(/SHA-256 checksum mismatch/);
      await expect(readFile(path.join(cacheDir, INSTALLED_DEFAULT_DESCRIPTOR))).rejects.toThrow();
      await expect(readFile(path.join(cacheDir, CAPABILITY_RECEIPT))).rejects.toThrow();
      const entries = await readdir(cacheDir);
      expect(entries).not.toContain("gguf-bad.bin");
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("uses a user-level cache root rather than deriving one from a vault", () => {
    const home = "/tmp/oms-user-home";
    const vault = path.join(home, "vault", "notes");
    const cache = embeddingModelCacheDir({ homeDir: home });
    expect(cache).toBe(path.join(home, ".cache", "oms", "models"));
    expect(cache.startsWith(vault)).toBe(false);
  });
});
