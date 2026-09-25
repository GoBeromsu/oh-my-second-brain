import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestBytes } from "../conventions/canonical.js";
import { PATTERN_SOURCE_LIMIT } from "./pattern.js";
import { currentSequence, diagnoseStore, readDeclined, readIndex, readStore, SEAL_LOCK_STALE_MS, sealContract, storeExists, storeHousekeeping, writeIndexEntry } from "./store.js";
import type { VaultContract } from "./types.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const OTHER = "9b1d2c3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e";

const CONTRACT: VaultContract = {
  folders: { Projects: { meaning: "projects", searchExclude: false } },
  properties: { rating: { meaning: "score", type: "number", default: false, required: true, rules: [{ kind: "range", min: 0.5, max: 4.5 }] } },
  templates: {
    Meeting: { source: "Templates/Meeting.md", sourceHash: `sha256:${"a".repeat(64)}`, applyFolder: "Meetings", requiredProperties: ["rating"], narrowedRules: {}, requiredHeadings: ["Agenda"] },
  },
};

let base: string;
let root: string;
let vault: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-store-")));
  root = join(base, "home", ".oms", "vaults");
  vault = join(base, "vault");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function generation(): Promise<string> {
  return join(root, await readlink(join(root, ID)));
}

describe("contract store", () => {
  it("seals a pattern at the length cap and refuses one past it without echoing it", async () => {
    const withPattern = (regex: string): VaultContract => ({
      ...CONTRACT,
      properties: { code: { meaning: "code", type: "text", default: false, required: false, rules: [{ kind: "pattern", regex }] } },
    });
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: withPattern("b".repeat(PATTERN_SOURCE_LIMIT)) }, root);
    expect(await currentSequence(ID, root)).toBe(1);
    const over = "c".repeat(PATTERN_SOURCE_LIMIT + 1);
    const refused = sealContract({ vaultRealPath: vault, vaultId: ID, contract: withPattern(over) }, root);
    await expect(refused).rejects.toThrow(/^CONTRACT_PATTERN_UNSAFE: a pattern rule is too-long$/);
    expect(await currentSequence(ID, root)).toBe(1);
  });

  it("refuses an unsafe pattern in a template's narrowed rules before touching the store", async () => {
    const meeting = CONTRACT.templates["Meeting"]!;
    for (const regex of ["d".repeat(PATTERN_SOURCE_LIMIT + 1), "(a+)+", "("]) {
      const contract: VaultContract = { ...CONTRACT, templates: { Meeting: { ...meeting, narrowedRules: { rating: [{ kind: "pattern", regex }] } } } };
      await expect(sealContract({ vaultRealPath: vault, vaultId: ID, contract }, root)).rejects.toThrow(/^CONTRACT_PATTERN_UNSAFE: /);
    }
    await expect(stat(root)).rejects.toThrow();
  });

  it("round-trips a sealed contract", async () => {
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root);
    expect(await readStore(ID, root)).toEqual({ state: "ok", contract: CONTRACT });
    expect(await readIndex(root)).toEqual({ state: "ok", entries: { [vault]: ID } });
    expect(await storeExists(ID, root)).toBe(true);
    expect((await lstat(join(root, ID))).isSymbolicLink()).toBe(true);
  });

  it("writes private directories and files", async () => {
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root);
    const dir = await generation();
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    for (const file of ["folders.json", "properties.json", "manifest.json", "templates/Meeting.json"]) {
      expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(join(root, "index.json"))).mode & 0o777).toBe(0o600);
  });

  it("keeps an absent axis absent", async () => {
    const open: VaultContract = { folders: null, properties: null, templates: {} };
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: open }, root);
    expect(await readStore(ID, root)).toEqual({ state: "ok", contract: open });
  });

  it("treats an altered file as unreadable", async () => {
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root);
    await writeFile(join(await generation(), "folders.json"), "{\"version\":1,\"folders\":{}}\n");
    expect(await readStore(ID, root)).toEqual({ state: "unreadable" });
  });

  it("treats an altered manifest as unreadable", async () => {
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root);
    const manifest = join(await generation(), "manifest.json");
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as { files: Record<string, string> };
    parsed.files["folders.json"] = `sha256:${"0".repeat(64)}`;
    await writeFile(manifest, JSON.stringify(parsed));
    expect(await readStore(ID, root)).toEqual({ state: "unreadable" });
  });

  it("treats an extra file as unreadable", async () => {
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root);
    await writeFile(join(await generation(), "extra.json"), "{}");
    expect(await readStore(ID, root)).toEqual({ state: "unreadable" });
  });

  it("reads nothing into existence", async () => {
    expect(await readStore(ID, root)).toEqual({ state: "absent" });
    expect(await readIndex(root)).toEqual({ state: "absent" });
    expect(await storeExists(ID, root)).toBe(false);
    await expect(stat(root)).rejects.toThrow();
  });

  it("refuses an id that is not a UUID", async () => {
    await expect(sealContract({ vaultRealPath: vault, vaultId: "../x", contract: CONTRACT }, root)).rejects.toThrow(/CONTRACT_VAULT_ID_INVALID/);
    expect(await readStore("../x", root)).toEqual({ state: "unreadable" });
  });

  it("reseals into a new generation", async () => {
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root);
    const next: VaultContract = { ...CONTRACT, folders: { Areas: { meaning: "areas", searchExclude: true } } };
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: next }, root);
    expect(await readStore(ID, root)).toEqual({ state: "ok", contract: next });
  });

  it("reports a corrupt index", async () => {
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root);
    await writeFile(join(root, "index.json"), "{not json");
    expect(await readIndex(root)).toEqual({ state: "corrupt" });
  });

  it("refuses to reset a corrupt index and rebuilds it only when asked, keeping the old bytes aside", async () => {
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root);
    await writeFile(join(root, "index.json"), "{not json");
    await expect(writeIndexEntry(vault, ID, root)).rejects.toThrow(/^CONTRACT_INDEX_CORRUPT: /);
    await expect(sealContract({ vaultRealPath: vault, vaultId: ID, contract: NEXT }, root)).rejects.toThrow(/^CONTRACT_INDEX_CORRUPT: /);
    expect(await readStore(ID, root)).toEqual({ state: "ok", contract: CONTRACT });
    expect(await readFile(join(root, "index.json"), "utf8")).toBe("{not json");
    await writeIndexEntry(vault, ID, root, { rebuildCorrupt: true });
    expect(await readIndex(root)).toEqual({ state: "ok", entries: { [vault]: ID } });
    const aside = (await readdir(root)).filter(name => name.startsWith("index.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(root, aside[0]!), "utf8")).toBe("{not json");
  });

  it("serializes concurrent index updates so no entry is lost", async () => {
    const paths = Array.from({ length: 8 }, (_, index) => join(base, `vault-${index}`));
    await Promise.all(paths.map(path => mkdir(path)));
    await Promise.all(paths.map((path, index) => writeIndexEntry(path, index % 2 === 0 ? ID : OTHER, root)));
    const read = await readIndex(root);
    expect(read.state === "ok" ? Object.keys(read.entries).sort() : []).toEqual([...paths].sort());
    expect((await readdir(root)).filter(name => name.includes("lock"))).toEqual([]);
  });

  it("keeps declined answers with the generation, outside the contract", async () => {
    const declined = { folders: ["Inbox"], properties: ["mood"], templates: { Daily: `sha256:${"b".repeat(64)}` } };
    expect(await readDeclined(ID, root)).toEqual({ folders: [], properties: [], templates: {} });
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT, declined }, root);
    expect(await readStore(ID, root)).toEqual({ state: "ok", contract: CONTRACT });
    expect(await readDeclined(ID, root)).toEqual(declined);
    expect((await stat(join(await generation(), "declined.json"))).mode & 0o777).toBe(0o600);
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root);
    expect(await readDeclined(ID, root)).toEqual({ folders: [], properties: [], templates: {} });
  });

  it("prunes stale entries for the same id but keeps other vaults", async () => {
    await writeIndexEntry(join(base, "gone"), ID, root);
    await writeIndexEntry(join(base, "other"), OTHER, root);
    await writeIndexEntry(vault, ID, root);
    expect(await readIndex(root)).toEqual({ state: "ok", entries: { [join(base, "other")]: OTHER, [vault]: ID } });
  });
});

async function generations(): Promise<string[]> {
  return (await readdir(root)).filter(name => /^\.[0-9a-f-]+\.\d+$/.test(name)).sort();
}

const NEXT: VaultContract = { ...CONTRACT, folders: { Areas: { meaning: "areas", searchExclude: true } } };
const HOST = "this-host";

async function plantLock(owner: { pid: number; host: string; startedAt: number }): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `.${ID}.lock`), JSON.stringify(owner));
}

describe("locked atomic reseal", () => {
  it("aborts on a live lock without touching the store", async () => {
    await plantLock({ pid: 4242, host: HOST, startedAt: 1_000 });
    const deps = { host: HOST, now: () => 2_000, isPidAlive: () => true, confirmStaleReclaim: async () => true };
    await expect(sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root, deps)).rejects.toThrow(/CONTRACT_SEAL_BUSY: another seal in progress/);
    expect(await readStore(ID, root)).toEqual({ state: "absent" });
    expect(await storeHousekeeping(ID, root, deps)).toEqual({ staleLocks: 0, orphans: 0 });
  });

  it("reclaims a same-host lock whose pid is gone, only after confirmation", async () => {
    await plantLock({ pid: 4242, host: HOST, startedAt: 1_000 });
    const dead = { host: HOST, now: () => 2_000, isPidAlive: () => false };
    expect(await storeHousekeeping(ID, root, dead)).toEqual({ staleLocks: 1, orphans: 0 });
    await expect(sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root, dead)).rejects.toThrow(/CONTRACT_SEAL_LOCK_STALE/);
    await expect(sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root, { ...dead, confirmStaleReclaim: async () => false })).rejects.toThrow(/CONTRACT_SEAL_LOCK_STALE/);
    expect(await readStore(ID, root)).toEqual({ state: "absent" });

    let asked = 0;
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root, { ...dead, confirmStaleReclaim: async () => { asked += 1; return true; } });
    expect(asked).toBe(1);
    expect(await readStore(ID, root)).toEqual({ state: "ok", contract: CONTRACT });
    expect((await readdir(root)).filter(name => name.includes(".lock"))).toEqual([]);
  });

  it("judges a lock from another host by age alone", async () => {
    await plantLock({ pid: 4242, host: "elsewhere", startedAt: 1_000 });
    const young = { host: HOST, now: () => 1_000 + SEAL_LOCK_STALE_MS, isPidAlive: () => false, confirmStaleReclaim: async () => true };
    await expect(sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root, young)).rejects.toThrow(/CONTRACT_SEAL_BUSY/);
    const old = { ...young, now: () => 1_001 + SEAL_LOCK_STALE_MS, isPidAlive: () => true };
    expect(await storeHousekeeping(ID, root, old)).toEqual({ staleLocks: 1, orphans: 0 });
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root, old);
    expect(await readStore(ID, root)).toEqual({ state: "ok", contract: CONTRACT });
  });

  it("aborts when another seal finished after the interview read the contract", async () => {
    const baseSeq = await currentSequence(ID, root);
    expect(baseSeq).toBe("none");
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root);
    await expect(sealContract({ vaultRealPath: vault, vaultId: ID, contract: NEXT, baseSeq }, root)).rejects.toThrow(/CONTRACT_SEAL_CHANGED: .*oms setup again/);
    expect(await readStore(ID, root)).toEqual({ state: "ok", contract: CONTRACT });
    expect(await currentSequence(ID, root)).toBe(1);
    expect((await readdir(root)).some(name => name.endsWith(".lock"))).toBe(false);
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: NEXT, baseSeq: 1 }, root);
    expect(await readStore(ID, root)).toEqual({ state: "ok", contract: NEXT });
  });

  it("keeps N-1 so a read that resolved before a reseal still completes", async () => {
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root);
    const resolved = await generation();
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: NEXT }, root);
    expect(JSON.parse(await readFile(join(resolved, "folders.json"), "utf8"))).toEqual({ version: 1, folders: CONTRACT.folders });
    expect(await generations()).toEqual([`.${ID}.1`, `.${ID}.2`]);
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root);
    expect(await generations()).toEqual([`.${ID}.2`, `.${ID}.3`]);
    expect(await readStore(ID, root)).toEqual({ state: "ok", contract: CONTRACT });
  });

  it("moves a real directory aside on the first seal", async () => {
    await mkdir(join(root, ID), { recursive: true });
    await writeFile(join(root, ID, "folders.json"), "{}");
    expect(await currentSequence(ID, root)).toBe("directory");
    expect(await diagnoseStore(ID, root)).toBe("link-dangling");
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root);
    expect((await lstat(join(root, ID))).isSymbolicLink()).toBe(true);
    expect(await generations()).toEqual([`.${ID}.0`, `.${ID}.1`]);
    expect(await readFile(join(root, `.${ID}.0`, "folders.json"), "utf8")).toBe("{}");
    expect(await readStore(ID, root)).toEqual({ state: "ok", contract: CONTRACT });
  });

  it("puts a legacy directory back when the link swap fails", async () => {
    await mkdir(join(root, ID), { recursive: true });
    await writeFile(join(root, ID, "folders.json"), "{}");
    let renames = 0;
    const failing = { fs: { rename: (async (from: string, to: string) => {
      renames += 1;
      if (from.endsWith(".link-tmp")) throw new Error("disk gone");
      await rename(from, to);
    }) as never, symlink, rm } };
    await expect(sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root, failing)).rejects.toThrow(/disk gone/);
    expect(renames).toBe(3);
    expect((await lstat(join(root, ID))).isDirectory()).toBe(true);
    expect(await readFile(join(root, ID, "folders.json"), "utf8")).toBe("{}");
    expect(await generations()).toEqual([]);
    expect((await readdir(root)).filter(name => name.includes("link-tmp") || name.includes(".lock"))).toEqual([]);
  });

  it("removes orphan generations and reclaimed lock leftovers under the lock", async () => {
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root);
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: NEXT }, root);
    await mkdir(join(root, `.${ID}.9`));
    await writeFile(join(root, `.${ID}.lock.stale-5`), "{}");
    expect(await storeHousekeeping(ID, root)).toEqual({ staleLocks: 1, orphans: 1 });
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root);
    expect(await generations()).toEqual([`.${ID}.2`, `.${ID}.3`]);
    expect(await storeHousekeeping(ID, root)).toEqual({ staleLocks: 0, orphans: 0 });
  });

  it("leaves the previous contract intact when the swap fails midway", async () => {
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root);
    const failing = { fs: { rename: (async () => { throw new Error("disk gone"); }) as never, symlink, rm } };
    await expect(sealContract({ vaultRealPath: vault, vaultId: ID, contract: NEXT }, root, failing)).rejects.toThrow(/disk gone/);
    expect(await readStore(ID, root)).toEqual({ state: "ok", contract: CONTRACT });
    expect(await generations()).toEqual([`.${ID}.1`]);
    expect((await readdir(root)).filter(name => name.includes(".lock") || name.includes("link-tmp"))).toEqual([]);
  });
});

describe("store diagnosis", () => {
  it("names the cause of an unreadable store and nothing else", async () => {
    expect(await diagnoseStore(ID, root)).toBe("absent");
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root);
    expect(await diagnoseStore(ID, root)).toBe("ok");

    const dir = await generation();
    const manifestPath = join(dir, "manifest.json");
    const manifest = await readFile(manifestPath, "utf8");
    const invalid = "{\"version\":1,\"folders\":{\"Projects\":{\"meaning\":1}}}\n";
    await writeFile(join(dir, "folders.json"), invalid);
    expect(await diagnoseStore(ID, root)).toBe("manifest-mismatch");
    const parsed = JSON.parse(manifest) as { files: Record<string, string> };
    parsed.files["folders.json"] = digestBytes(invalid);
    await writeFile(manifestPath, JSON.stringify(parsed));
    expect(await diagnoseStore(ID, root)).toBe("schema-invalid");
    expect(await readStore(ID, root)).toEqual({ state: "unreadable" });

    await rm(dir, { recursive: true });
    expect(await diagnoseStore(ID, root)).toBe("link-dangling");
    expect(await readStore(ID, root)).toEqual({ state: "unreadable" });
    await rm(join(root, ID));
    await symlink("elsewhere", join(root, ID));
    expect(await diagnoseStore(ID, root)).toBe("link-dangling");
  });
});
