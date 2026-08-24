import { describe, expect, it } from "vitest";
import { makeDeferredProvider, makeDeferredStore } from "./deferred.js";

describe("deferred graph-only embedding primitives", () => {
  it("provider advertises dimensions/model but rejects on embed", async () => {
    const provider = makeDeferredProvider();
    expect(provider.dimensions).toBe(768);
    expect(provider.model).toContain("deferred");
    await expect(provider.embed("x")).rejects.toThrow(/embedding provider unavailable/i);
    await expect(provider.dispose()).resolves.toBeUndefined();
  });

  it("store throws on every persistence/query call but closes safely", () => {
    const store = makeDeferredStore();
    expect(() => store.upsert([])).toThrow(/store unavailable/i);
    expect(() => store.queryVec(new Float32Array(768), 5)).toThrow(/store unavailable/i);
    expect(() => store.queryLex("x", 5)).toThrow(/store unavailable/i);
    expect(() => store.getShas("a.md")).toThrow(/store unavailable/i);
    expect(() => store.clearDocument("a.md")).toThrow(/store unavailable/i);
    expect(() => store.listDocPaths()).toThrow(/store unavailable/i);
    expect(() => store.close()).not.toThrow();
  });
});
