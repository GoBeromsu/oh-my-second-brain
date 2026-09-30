import { appendFile, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestBytes } from "../conventions/canonical.js";
import { digestHex } from "../contract/digest.js";
import { writeSnapshot } from "../contract/generation-snapshot.js";
import { existingStateDir } from "../contract/state-dir.js";
import { sealContract } from "../contract/store.js";
import type { VaultContract } from "../contract/types.js";
import { readSnapshotContract } from "./snapshot-contract.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const OTHER = "4f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const CONTRACT: VaultContract = { folders: { Projects: { meaning: "projects", searchExclude: false } }, properties: null };
let base: string;
let root: string;
let digest: string;
const saved = { home: process.env.HOME, profile: process.env.USERPROFILE };

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-snap-contract-")));
  root = join(base, "home", ".oms", "vaults");
  process.env.HOME = join(base, "home");
  process.env.USERPROFILE = join(base, "home");
  const vault = join(base, "vault");
  await mkdir(vault, { recursive: true });
  digest = (await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root)).digest;
});
afterEach(async () => {
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  if (saved.profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.profile;
  await rm(base, { recursive: true, force: true });
});

describe("readSnapshotContract", () => {
  it("reads a sealed generation back from its snapshot", async () => {
    const read = await readSnapshotContract(root, ID, digest);
    expect(read).toMatchObject({ state: "ok", contract: CONTRACT, digest });
  });

  it("is missing without a snapshot directory or without that digest", async () => {
    expect(await readSnapshotContract(root, OTHER, digest)).toEqual({ state: "missing" });
    expect(await readSnapshotContract(root, ID, `sha256:${"0".repeat(64)}`)).toEqual({ state: "missing" });
  });

  it("is corrupt for a non-digest, tampered bytes, or a snapshot that is not a contract", async () => {
    expect(await readSnapshotContract(root, ID, "none")).toEqual({ state: "corrupt" });

    const junk = "{}";
    const manifest = JSON.stringify({ files: { "junk.json": digestBytes(Buffer.from(junk)) } });
    const { hex } = await writeSnapshot(root, ID, new Map([["junk.json", junk]]), manifest);
    expect(await readSnapshotContract(root, ID, `sha256:${hex}`)).toEqual({ state: "corrupt" });

    const directory = join((await existingStateDir(root, ID, "generations"))!, digestHex(digest as never));
    const file = (await readdir(directory, { recursive: true, withFileTypes: true })).find(entry => entry.isFile() && entry.name !== "manifest.json")!;
    await appendFile(join(file.parentPath, file.name), " ");
    expect(await readSnapshotContract(root, ID, digest)).toEqual({ state: "corrupt" });
  });
});
