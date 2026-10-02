import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireRealEmbeddingProvider } from "./provider.js";

const native = vi.hoisted(() => ({ getLlama: vi.fn() }));
vi.mock("node-llama-cpp", () => ({ LlamaLogLevel: { error: "error" }, getLlama: native.getLlama }));
beforeEach(() => {
  native.getLlama.mockResolvedValue({
    loadModel: async () => ({
      tokenize: (text: string) => [text], detokenize: (tokens: string[]) => tokens.join(""),
      createEmbeddingContext: async () => ({ getEmbeddingFor: async () => ({ vector: [3, 4] }), dispose: async () => undefined }),
      dispose: async () => undefined,
    }),
  });
});
afterEach(() => native.getLlama.mockReset());

describe("maintenance native embedding policy", () => {
  it("passes never-build and skip-download to the actual native loader call", async () => {
    const provider = requireRealEmbeddingProvider({ provider: "gguf", model: "/synthetic/already-installed.gguf", dimensions: 2, localOnly: true });
    try {
      expect(await provider.embed("synthetic local input")).toEqual(new Float32Array([0.6, 0.8]));
      expect(native.getLlama).toHaveBeenCalledOnce();
      expect(native.getLlama.mock.calls[0]?.[0]).toMatchObject({ build: "never", skipDownload: true, logLevel: "error" });
    } finally { await provider.dispose(); }
  });
  it("returns explicit setup guidance when no installed native backend works", async () => {
    native.getLlama.mockRejectedValue(new Error("NoBinaryFoundError"));
    const provider = requireRealEmbeddingProvider({ provider: "gguf", model: "/synthetic/already-installed.gguf", dimensions: 2, localOnly: true });
    try { await expect(provider.embed("synthetic local input")).rejects.toThrow("automatic maintenance does not download or build"); }
    finally { await provider.dispose(); }
    expect(native.getLlama.mock.calls[0]?.[0]).toMatchObject({ build: "never", skipDownload: true });
  });
  it("leaves the existing explicit provider policy unchanged when maintenance is absent", async () => {
    const provider = requireRealEmbeddingProvider({ provider: "gguf", model: "/synthetic/already-installed.gguf", dimensions: 2 });
    try {
      await provider.embed("synthetic local input");
      expect(native.getLlama.mock.calls[0]?.[0]).not.toHaveProperty("build");
      expect(native.getLlama.mock.calls[0]?.[0]).not.toHaveProperty("skipDownload");
    } finally { await provider.dispose(); }
  });
});
