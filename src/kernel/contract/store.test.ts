import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contractStoreRoot, loadLayers, readStoreMeta, recordSeen, reissue, sealLayer } from "./store.js";
import type { PublicManifest, SealedLayer } from "./types.js";

const roots: string[] = [];
const previousRoot = process.env["OMS_CONTRACT_STORE_ROOT"];
const VAULT = "abcdef00-0000-4000-8000-000000000001";
const OTHER = "abcdef00-0000-4000-8000-000000000002";
const COMMON = "00000000-0000-4000-8000-0000000000c0";
const TEMPLATE = "00000000-0000-4000-8000-0000000000d0";
const RESEAL = "00000000-0000-4000-8000-0000000000d1";
const HASH = `sha256:${"b".repeat(64)}`;
let store: string;

beforeEach(async () => {
  store = await mkdtemp(join(tmpdir(), "oms-contract-store-"));
  roots.push(store);
  process.env["OMS_CONTRACT_STORE_ROOT"] = join(store, "vaults");
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env["OMS_CONTRACT_STORE_ROOT"];
  else process.env["OMS_CONTRACT_STORE_ROOT"] = previousRoot;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function layer(sealId: string, sourcePath: string | null): SealedLayer {
  return {
    sealId,
    fields: [{ name: "status", type: "text", required: true, description: "", variable: null, rules: [{ kind: "allowed", values: ["open"] }] }],
    requiredHeadings: [],
    applyFolder: null,
    sourcePath,
    sourceHash: sourcePath === null ? null : HASH,
    answers: { status: "only open" },
  };
}

function manifest(templateSeal = TEMPLATE): PublicManifest {
  return {
    version: 1,
    common: { sealId: COMMON, fields: [{ name: "status", type: "text", required: true, description: "" }] },
    templates: [{ id: "T/Meeting.md", name: "Meeting", applyFolder: null, fields: [], requiredHeadings: [], sourceHash: HASH, sealId: templateSeal }],
  };
}

async function sealBoth(): Promise<void> {
  expect(await sealLayer(VAULT, layer(COMMON, null), "/vault")).toEqual({ ok: true });
  expect(await sealLayer(VAULT, layer(TEMPLATE, "T/Meeting.md"), "/vault")).toEqual({ ok: true });
}

const vaultDir = (id = VAULT): string => join(store, "vaults", id);

describe("contractStoreRoot", () => {
  it("honours the override and rejects a relative root", () => {
    expect(contractStoreRoot({ OMS_CONTRACT_STORE_ROOT: "/abs/root" })).toBe("/abs/root");
    expect(() => contractStoreRoot({ OMS_CONTRACT_STORE_ROOT: "relative/root" })).toThrow(/absolute/);
    expect(contractStoreRoot({})).toMatch(/\.oms[\\/]vaults$/);
  });

  it("reports invalid-root on read and refuses to seal", async () => {
    process.env["OMS_CONTRACT_STORE_ROOT"] = "relative/root";
    expect(await readStoreMeta(VAULT)).toEqual({ state: "invalid", reason: "invalid-root" });
    expect((await sealLayer(VAULT, layer(COMMON, null), "/vault")).ok).toBe(false);
  });
});

describe("sealLayer and loadLayers", () => {
  it("writes private directories and files, only under the root", async () => {
    await sealBoth();
    for (const directory of [join(store, "vaults"), vaultDir(), join(vaultDir(), "layers")]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    for (const file of [join(vaultDir(), "meta.json"), join(vaultDir(), "layers", `${COMMON}.json`), join(vaultDir(), "layers", `${TEMPLATE}.json`)]) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    expect(await readdir(store)).toEqual(["vaults"]);
    const meta = await readStoreMeta(VAULT);
    expect(meta).toEqual({ state: "ok", meta: { version: 1, vaultId: VAULT, lastSeenRealpath: "/vault", layers: [COMMON, TEMPLATE] } });
  });

  it("loads every layer the manifest names", async () => {
    await sealBoth();
    const loaded = await loadLayers(VAULT, manifest());
    expect(loaded.orphaned).toBe(false);
    expect(loaded.common).toEqual({ state: "ok", layer: layer(COMMON, null) });
    expect(loaded.templates.get("T/Meeting.md")).toEqual({ state: "ok", layer: layer(TEMPLATE, "T/Meeting.md") });
  });

  it("reports missing-store without creating it", async () => {
    const loaded = await loadLayers(VAULT, manifest());
    expect(loaded.common).toEqual({ state: "unreadable", reason: "missing-store" });
    expect(loaded.templates.get("T/Meeting.md")).toEqual({ state: "unreadable", reason: "missing-store" });
    expect(await readdir(store)).toEqual([]);
  });

  it("reports corrupt, missing-layer and id-mismatch per layer", async () => {
    await sealBoth();
    await writeFile(join(vaultDir(), "layers", `${COMMON}.json`), "{");
    await rm(join(vaultDir(), "layers", `${TEMPLATE}.json`));
    let loaded = await loadLayers(VAULT, manifest());
    expect(loaded.common).toEqual({ state: "unreadable", reason: "corrupt" });
    expect(loaded.templates.get("T/Meeting.md")).toEqual({ state: "unreadable", reason: "missing-layer" });

    await writeFile(join(vaultDir(), "layers", `${COMMON}.json`), JSON.stringify({ version: 1, layer: layer(COMMON, "T/Other.md") }));
    await writeFile(join(vaultDir(), "layers", `${TEMPLATE}.json`), JSON.stringify({ version: 1, layer: layer(RESEAL, "T/Meeting.md") }));
    loaded = await loadLayers(VAULT, manifest());
    expect(loaded.common).toEqual({ state: "unreadable", reason: "id-mismatch" });
    expect(loaded.templates.get("T/Meeting.md")).toEqual({ state: "unreadable", reason: "id-mismatch" });
  });

  it("reports missing-layer for a manifest seal the store does not list", async () => {
    await sealBoth();
    const loaded = await loadLayers(VAULT, { ...manifest(), templates: [...manifest().templates, { ...manifest().templates[0]!, id: "T/New.md", sealId: RESEAL }] });
    expect(loaded.templates.get("T/New.md")).toEqual({ state: "unreadable", reason: "missing-layer" });
    expect(loaded.templates.get("T/Meeting.md")?.state).toBe("ok");
  });

  it("fails every layer when the store holds an orphan seal", async () => {
    await sealBoth();
    const loaded = await loadLayers(VAULT, { ...manifest(), templates: [] });
    expect(loaded.orphaned).toBe(true);
    expect(loaded.common).toEqual({ state: "unreadable", reason: "manifest-mismatch" });
  });

  it("treats corrupt or foreign meta as unreadable", async () => {
    await sealBoth();
    await writeFile(join(vaultDir(), "meta.json"), "[]");
    expect(await readStoreMeta(VAULT)).toEqual({ state: "invalid", reason: "corrupt" });
    expect((await loadLayers(VAULT, manifest())).common).toEqual({ state: "unreadable", reason: "corrupt" });
    expect((await sealLayer(VAULT, layer(RESEAL, "T/Meeting.md"), "/vault")).ok).toBe(false);
    await writeFile(join(vaultDir(), "meta.json"), JSON.stringify({ version: 1, vaultId: OTHER, lastSeenRealpath: null, layers: [] }));
    expect(await readStoreMeta(VAULT)).toEqual({ state: "invalid", reason: "id-mismatch" });
  });

  it("reseals by replacing the old seal and refuses duplicates", async () => {
    await sealBoth();
    expect((await sealLayer(VAULT, layer(TEMPLATE, "T/Meeting.md"), "/vault")).ok).toBe(false);
    expect(await sealLayer(VAULT, layer(RESEAL, "T/Meeting.md"), "/vault", { replaces: TEMPLATE })).toEqual({ ok: true });
    expect((await readdir(join(vaultDir(), "layers"))).sort()).toEqual([`${COMMON}.json`, `${RESEAL}.json`]);
    const loaded = await loadLayers(VAULT, manifest(RESEAL));
    expect(loaded.templates.get("T/Meeting.md")?.state).toBe("ok");
  });

  it("rejects an invalid layer shape or vault id", async () => {
    expect((await sealLayer("not-a-uuid", layer(COMMON, null), "/vault")).ok).toBe(false);
    expect((await sealLayer(VAULT, { ...layer(COMMON, null), sealId: "x" }, "/vault")).ok).toBe(false);
    expect(await readdir(store)).toEqual([]);
  });
});

describe("recordSeen", () => {
  it("creates meta when absent and keeps layers", async () => {
    expect(await recordSeen(VAULT, "/first")).toEqual({ ok: true });
    expect(await readStoreMeta(VAULT)).toEqual({ state: "ok", meta: { version: 1, vaultId: VAULT, lastSeenRealpath: "/first", layers: [] } });
    await sealBoth();
    await recordSeen(VAULT, "/second");
    const meta = await readStoreMeta(VAULT);
    expect(meta.state === "ok" && meta.meta).toMatchObject({ lastSeenRealpath: "/second", layers: [COMMON, TEMPLATE] });
  });
});

describe("reissue", () => {
  it("copies the store to a new id and keeps the old one", async () => {
    await sealBoth();
    expect(await reissue(VAULT, OTHER)).toEqual({ ok: true });
    const meta = await readStoreMeta(OTHER);
    expect(meta.state === "ok" && meta.meta.vaultId).toBe(OTHER);
    expect((await loadLayers(OTHER, manifest())).templates.get("T/Meeting.md")?.state).toBe("ok");
    expect((await readStoreMeta(VAULT)).state).toBe("ok");
    expect((await stat(vaultDir(OTHER))).mode & 0o777).toBe(0o700);
    expect((await stat(join(vaultDir(OTHER), "meta.json"))).mode & 0o777).toBe(0o600);
    expect((await readdir(join(store, "vaults"))).sort()).toEqual([VAULT, OTHER].sort());
  });

  it("refuses an existing target, a missing source and equal ids", async () => {
    await sealBoth();
    await mkdir(vaultDir(OTHER), { recursive: true });
    expect((await reissue(VAULT, OTHER)).ok).toBe(false);
    expect((await reissue(OTHER, VAULT)).ok).toBe(false);
    expect((await reissue(VAULT, VAULT)).ok).toBe(false);
    expect(JSON.parse(await readFile(join(vaultDir(), "meta.json"), "utf8")).vaultId).toBe(VAULT);
  });
});
