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

  it("does not claim a graph-only engine, which most of its callers are not", async () => {
    // The defect this pins: the message hardcoded "graph-only engine", but this
    // provider is wired by the core, ephemeral, and read-only assemblies too. A
    // user running `oms search --vec "query"` on an ordinary model-less vault was told
    // they were on a graph-only engine they never asked for. A guard that
    // misreports the runtime it guards is its own kind of dishonest output.
    const provider = makeDeferredProvider();
    const reason = await provider.embed("x").then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(reason).not.toMatch(/graph-only/i);
    // It must still say what is actually true and actionable.
    expect(reason).toMatch(/embedding provider unavailable/i);
    expect(reason).toMatch(/OMS_EMBEDDING_PROVIDER/);
  });

  it("lets the store guard name graph-only, because that is its only caller", () => {
    // The asymmetry is deliberate rather than an oversight: `makeDeferredStore` is
    // wired by `assembleGraphOnlyEngine` alone, so naming that engine is accurate
    // there and helps whoever hits it.
    const store = makeDeferredStore();
    expect(() => store.queryLex("x", 5)).toThrow(/graph-only engine/i);
  });

  it("tells the user every way to configure embeddings, not just the env pair", async () => {
    // This guard is the message a graph-only engine shows when a semantic path is
    // reached. It previously named the environment pair alone, which is two of the
    // three routes: it omitted the vault contract file and the one-step install,
    // so a user with neither variable set was not told the simplest remedy exists.
    const provider = makeDeferredProvider();
    const reason = await provider.embed("x").then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(reason).toMatch(/OMS_EMBEDDING_PROVIDER/);
    expect(reason).toMatch(/OMS_EMBEDDING_MODEL/);
    expect(reason).toMatch(/\.oms\/models\.json/);
    expect(reason).toMatch(/oms setup --models-default/);
    expect(reason).not.toMatch(/UPSTAGE_API_KEY/);
    // It must not advertise the rerank/generate remedies, which would not help.
    expect(reason).not.toMatch(/OMS_RERANK_PROVIDER|OMS_GENERATE_PROVIDER/);
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
