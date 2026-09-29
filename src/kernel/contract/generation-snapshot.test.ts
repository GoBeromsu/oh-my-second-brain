import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTruthTableRow } from "../../../test/fixtures/contract-truth-table.js";
import type { Digest } from "../conventions/canonical.js";
import { digestHex, manifestDigestOf } from "./digest.js";
import { readSnapshot, readVerifiedDirectory, removeSnapshotTemporaries, snapshotDigests, snapshotInventory, SNAPSHOT_TEMPORARY_PREFIX, writeSnapshot } from "./generation-snapshot.js";
import { sealLegacyGeneration } from "../../../test/fixtures/legacy-store-fixture.js";
import { lineageHealth, lineageNeedsAttention } from "./lineage-health.js";
import { readLineage } from "./lineage.js";
import { stateDir } from "./state-dir.js";
import { contractDoctor } from "./status.js";
import { bootstrapSnapshots, currentSequence, readIndex, sealContract, storeHousekeeping } from "./store.js";
import type { VaultContract } from "./types.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";

function contract(max: number): VaultContract {
  return {
    folders: { Projects: { meaning: "projects", searchExclude: false } },
    properties: { rating: { meaning: "score", type: "number", default: false, required: true, rules: [{ kind: "range", min: 0, max }] } },
  };
}

let base: string;
let root: string;
let vault: string;
const saved = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] };

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-snapshot-")));
  root = join(base, "home", ".oms", "vaults");
  vault = join(base, "vault");
  process.env["HOME"] = join(base, "home");
  process.env["USERPROFILE"] = join(base, "home");
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env["HOME"] = saved.HOME;
  process.env["USERPROFILE"] = saved.USERPROFILE;
  await rm(base, { recursive: true, force: true });
});

function seal(max: number, extra: Partial<Parameters<typeof sealContract>[0]> = {}, overrides: Parameters<typeof sealContract>[2] = {}) {
  return sealContract({ vaultRealPath: vault, vaultId: ID, contract: contract(max), ...extra }, root, overrides);
}

function generationsDir(): string {
  return join(stateDir(root, ID), "generations");
}

async function generationDirs(): Promise<string[]> {
  return (await readdir(root)).filter(entry => /^\.[0-9a-f-]{36}\.\d{1,9}$/.test(entry)).sort();
}

/** Every path under `directory` with its kind, bytes digest and mtime: any write shows up. */
async function treeDigest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (path: string, relative: string): Promise<void> => {
    const info = await lstat(path);
    hash.update(`${relative}\0${info.mode}\0${info.mtimeMs}\0`);
    if (info.isSymbolicLink()) hash.update(await readlink(path));
    else if (info.isFile()) hash.update(await readFile(path));
    else if (info.isDirectory()) for (const entry of (await readdir(path)).sort()) await walk(join(path, entry), `${relative}/${entry}`);
  };
  await walk(directory, "");
  return hash.digest("hex");
}

describe("generation snapshots", () => {
  it("keeps one verified snapshot per seal, named by its manifest digest, while the store keeps two generations", async () => {
    const digests: Digest[] = [];
    for (let max = 1; max <= 5; max += 1) digests.push((await seal(max)).digest);
    const inventory = await snapshotInventory(root, ID);
    expect(inventory.digests).toEqual([...digests].sort());
    expect(inventory.unexpected).toEqual([]);
    expect(await readdir(generationsDir())).toEqual(digests.map(digestHex).sort());
    for (const digest of digests) {
      const read = await readSnapshot(root, ID, digest);
      expect(read.state).toBe("ok");
      if (read.state === "ok") expect(manifestDigestOf(read.manifestBytes)).toBe(digest);
    }
    expect(await generationDirs()).toEqual([`.${ID}.4`, `.${ID}.5`]);
  });

  it("lists the seal's snapshot digests by name alone, matching the doctor inventory", async () => {
    expect(await snapshotDigests(root, ID)).toEqual([]);
    await seal(1);
    await seal(2);
    await writeFile(join(generationsDir(), "f".repeat(64)), "not a snapshot");
    await mkdir(join(generationsDir(), "stray"));
    const inventory = await snapshotInventory(root, ID);
    expect(await snapshotDigests(root, ID)).toEqual(inventory.digests);
    expect(inventory.digests).toHaveLength(2);
    expect(inventory.unexpected).toEqual(["f".repeat(64), "stray"].sort());
  });

  it("is never collected by the seal GC, storeHousekeeping or a seq restart", async () => {
    const first = await seal(1);
    await seal(2);
    await seal(3);
    const before = await treeDigest(join(generationsDir(), digestHex(first.digest)));
    expect(await storeHousekeeping(ID, root)).toEqual({ staleLocks: 0, orphans: 0 });
    // The link is lost: the next seal drops every generation as an orphan.
    await rm(join(root, ID));
    const restarted = await seal(4);
    expect(restarted.parentDigest).toBe("none");
    expect(restarted.seq).toBe(1);
    expect(await generationDirs()).toEqual([`.${ID}.1`]);
    expect(await treeDigest(join(generationsDir(), digestHex(first.digest)))).toBe(before);
    expect((await snapshotInventory(root, ID)).digests).toHaveLength(4);
  });

  it("snapshots a legacy generation with its nested template files byte for byte", async () => {
    const template = { source: "Templates/Meeting.md", sourceHash: `sha256:${"a".repeat(64)}` as const, requiredProperties: ["rating"], narrowedRules: {}, requiredHeadings: ["Agenda"] };
    const digest = await sealLegacyGeneration({ vaultRealPath: vault, vaultId: ID, contract: contract(1), templates: { Meeting: template } }, root);
    await bootstrapSnapshots(root, ID);
    const read = await readSnapshot(root, ID, digest);
    if (read.state !== "ok") throw new Error(`snapshot is ${read.state}`);
    expect([...read.files.keys()].sort()).toEqual(["folders.json", "properties.json", "templates/Meeting.json"]);
    expect(read.files.get("templates/Meeting.json")).toEqual(await readFile(join(root, `.${ID}.1`, "templates", "Meeting.json")));
  });

  it("reads a changed byte, an extra file or a changed manifest as corrupt", async () => {
    const { digest } = await seal(1);
    const directory = join(generationsDir(), digestHex(digest));
    const pristine = join(base, "pristine");
    const reset = async (): Promise<void> => {
      await rm(directory, { recursive: true, force: true });
      const read = await readVerifiedDirectory(pristine);
      if (read.state !== "ok") throw new Error(`pristine copy is ${read.state}`);
      await writeSnapshot(root, ID, read.files, read.manifestBytes);
    };
    await mkdir(pristine);
    for (const file of ["folders.json", "properties.json", "manifest.json"]) await writeFile(join(pristine, file), await readFile(join(directory, file)));
    expect((await readVerifiedDirectory(pristine, digest)).state).toBe("ok");

    const folders = join(directory, "folders.json");
    const bytes = await readFile(folders);
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(folders, bytes);
    expect(await readSnapshot(root, ID, digest)).toEqual({ state: "corrupt" });

    await reset();
    expect((await readSnapshot(root, ID, digest)).state).toBe("ok");
    await writeFile(join(directory, "extra.json"), "{}");
    expect(await readSnapshot(root, ID, digest)).toEqual({ state: "corrupt" });

    await reset();
    await writeFile(join(directory, "manifest.json"), `${await readFile(join(directory, "manifest.json"), "utf8")} `);
    expect(await readSnapshot(root, ID, digest)).toEqual({ state: "corrupt" });
    expect(await readSnapshot(root, ID, `sha256:${"0".repeat(64)}`)).toEqual({ state: "missing" });
    expect(await readSnapshot(root, ID, "sha256:nothex" as Digest)).toEqual({ state: "corrupt" });
  });

  it("reads a manifest that is not JSON, names a bad digest or sits beside a link as corrupt", async () => {
    const directory = join(base, "shaped");
    await mkdir(directory);
    await writeFile(join(directory, "manifest.json"), "not json");
    expect(await readVerifiedDirectory(directory)).toEqual({ state: "corrupt" });
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ files: { "a.json": "sha256:short" } }));
    expect(await readVerifiedDirectory(directory)).toEqual({ state: "corrupt" });
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ files: {} }));
    await symlink(join(base, "vault"), join(directory, "link"));
    expect(await readVerifiedDirectory(directory)).toEqual({ state: "corrupt" });
    await writeFile(join(base, "plain"), "x");
    expect(await readVerifiedDirectory(join(base, "plain"))).toEqual({ state: "corrupt" });
    expect(await readVerifiedDirectory(join(base, "absent"))).toEqual({ state: "missing" });
  });

  it("aborts the seal when the snapshot cannot be published, leaving the link, generations, index and lineage as they were", async () => {
    await seal(1);
    const before = { link: await readlink(join(root, ID)), generations: await generationDirs(), index: await readIndex(root), lineage: await readLineage(root, ID) };
    const snapshotRename = vi.fn(async () => { throw new Error("disk full"); });
    await expect(seal(2, {}, { fs: { rename, symlink, rm, snapshotRename } })).rejects.toThrow("disk full");
    expect(snapshotRename).toHaveBeenCalledTimes(1);
    expect(await readlink(join(root, ID))).toBe(before.link);
    expect(await generationDirs()).toEqual(before.generations);
    expect(await readIndex(root)).toEqual(before.index);
    expect(await readLineage(root, ID)).toEqual(before.lineage);
    expect((await readdir(generationsDir())).filter(entry => entry.startsWith(SNAPSHOT_TEMPORARY_PREFIX))).toEqual([]);
    expect((await snapshotInventory(root, ID)).digests).toHaveLength(1);
    await expect(stat(join(root, `.${ID}.lock`))).rejects.toThrow();
  });

  it("keeps the snapshot of a seal whose swap failed and reports it as snapshot-unsealed", async () => {
    const first = await seal(1);
    const swap = vi.fn(async (from: string, to: string) => {
      if (to === join(root, ID)) throw new Error("swap failed");
      await rename(from, to);
    });
    await expect(seal(2, {}, { fs: { rename: swap as typeof rename, symlink, rm } })).rejects.toThrow("swap failed");
    expect(await currentSequence(ID, root)).toBe(1);
    const inventory = await snapshotInventory(root, ID);
    expect(inventory.digests).toHaveLength(2);
    const orphan = inventory.digests.find(digest => digest !== first.digest)!;
    const health = await lineageHealth(ID, root);
    expect(health.findings).toEqual([{ kind: "snapshot-unsealed", detail: `${orphan} was snapshotted but never sealed; it is kept`, recovery: null }]);
    expect(lineageNeedsAttention(health)).toBe(false);
  });

  it("verifies an existing snapshot instead of rewriting it, keeping its inode and mtime", async () => {
    const first = await seal(1);
    const manifest = join(generationsDir(), digestHex(first.digest), "manifest.json");
    const before = await stat(manifest);
    await seal(2);
    const again = await seal(1);
    expect(again.digest).toBe(first.digest);
    const after = await stat(manifest);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect((await snapshotInventory(root, ID)).digests).toHaveLength(2);
  });

  it("refuses to seal over a corrupt snapshot of the same digest and leaves it untouched", async () => {
    const first = await seal(1);
    await seal(2);
    const folders = join(generationsDir(), digestHex(first.digest), "folders.json");
    await writeFile(folders, "tampered");
    const link = await readlink(join(root, ID));
    await expect(seal(1)).rejects.toMatchObject({ code: "CONTRACT_SNAPSHOT_CORRUPT" });
    expect(await readFile(folders, "utf8")).toBe("tampered");
    expect(await readlink(join(root, ID))).toBe(link);
  });

  it("bootstraps N and N-1 of a pre-lineage store and skips an N-1 that does not verify", async () => {
    await seal(1);
    await seal(2);
    await rm(stateDir(root, ID), { recursive: true });
    const next = await seal(3);
    expect((await snapshotInventory(root, ID)).digests).toHaveLength(3);
    const lineage = await readLineage(root, ID);
    expect(lineage.events.map(event => [event.kind, event.reason, event.generation])).toEqual([
      ["recovered", "bootstrap", 1], ["recovered", "bootstrap", 2], ["sealed", undefined, 3],
    ]);
    expect(lineage.events[2]!.digest).toBe(next.digest);

    await rm(stateDir(root, ID), { recursive: true });
    await writeFile(join(root, `.${ID}.2`, "folders.json"), "tampered");
    await seal(4);
    const skipped = await readLineage(root, ID);
    expect(skipped.events.map(event => [event.kind, event.generation])).toEqual([["recovered", 3], ["sealed", 4]]);
    expect((await snapshotInventory(root, ID)).digests).toHaveLength(2);
  });

  it("snapshots a pre-lineage store on request and records nothing twice", async () => {
    await seal(1);
    await seal(2);
    await rm(stateDir(root, ID), { recursive: true });
    const first = await bootstrapSnapshots(root, ID);
    expect(first.snapshots).toBe(2);
    expect(first.anchors.map(anchor => anchor.reason)).toEqual(["bootstrap", "bootstrap"]);
    const second = await bootstrapSnapshots(root, ID);
    expect(second).toEqual({ snapshots: 0, anchors: [] });
    await mkdir(join(generationsDir(), `${SNAPSHOT_TEMPORARY_PREFIX}crashed`));
    expect(await removeSnapshotTemporaries(root, ID)).toBe(1);
    expect(await removeSnapshotTemporaries(join(base, "elsewhere"), ID)).toBe(0);
  });

  it("changes nothing on disk when status and doctor read the lineage", async () => {
    const fixture = await buildTruthTableRow("sealed");
    try {
      const before = await treeDigest(fixture.base);
      const report = await contractDoctor(fixture.vault, "agent", fixture.root);
      expect(report.audience).toBe("agent");
      await lineageHealth(fixture.vaultId, fixture.root);
      await snapshotInventory(fixture.root, fixture.vaultId);
      expect(await treeDigest(fixture.base)).toBe(before);
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses a generations directory that is a symlink", async () => {
    await seal(1);
    const elsewhere = join(base, "elsewhere");
    await rename(generationsDir(), elsewhere);
    await symlink(elsewhere, generationsDir());
    await expect(seal(2)).rejects.toMatchObject({ code: "STATE_DIR_UNSAFE" });
    await expect(readSnapshot(root, ID, `sha256:${"0".repeat(64)}`)).rejects.toMatchObject({ code: "STATE_DIR_UNSAFE" });
    expect(await currentSequence(ID, root)).toBe(1);
  });
});
