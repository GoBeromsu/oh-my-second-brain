import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeContractVault } from "../../../test/fixtures/contract-vault-fixture.js";
import { contractRevision } from "./revision.js";
import { readStore, sealContract } from "./store.js";
import type { VaultContract } from "./types.js";
import { resolveSealState } from "./vault-id.js";

const CONTRACT: VaultContract = { folders: { Inbox: { meaning: "", searchExclude: false } }, properties: null };
const REVISION = `sha256:${"a".repeat(64)}` as const;

describe("contractRevision", () => {
  it("digests a sealed contract deterministically and tells contracts apart", () => {
    const revision = contractRevision({ state: "sealed", contract: CONTRACT });
    expect(revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contractRevision({ state: "sealed", contract: structuredClone(CONTRACT) })).toBe(revision);
    expect(contractRevision({ state: "sealed", contract: { ...CONTRACT, folders: {} } })).not.toBe(revision);
  });

  it("names a sealed view by the revision it was read with", () => {
    expect(contractRevision({ state: "sealed", contract: CONTRACT, revision: REVISION })).toBe(REVISION);
  });

  it("has no revision for an open or unreadable contract", () => {
    expect(contractRevision({ state: "open" })).toBeNull();
    expect(contractRevision({ state: "unreadable", reason: "broken" })).toBeNull();
  });
});

describe("contractRevision of a stored contract", () => {
  let base: string;
  let root: string;
  let vault: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "oms-revision-")));
    root = join(base, "store");
    vault = join(base, "vault");
    await mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("is the manifest digest of the sealed generation, the digest the lineage records", async () => {
    const vaultId = randomUUID();
    const first = await sealContract({ vaultRealPath: vault, vaultId, contract: CONTRACT }, root);
    const read = await readStore(vaultId, root);
    expect(read.state).toBe("ok");
    if (read.state !== "ok") return;
    expect(read.digest).toBe(first.digest);
    expect(contractRevision({ state: "sealed", contract: read.contract, revision: read.digest })).toBe(first.digest);

    const resealed = await sealContract({ vaultRealPath: vault, vaultId, contract: CONTRACT }, root);
    expect(resealed.digest).toBe(first.digest);
    const changed = await sealContract({ vaultRealPath: vault, vaultId, contract: { ...CONTRACT, folders: {} } }, root);
    expect(changed.digest).not.toBe(first.digest);
    const reread = await readStore(vaultId, root);
    expect(reread.state === "ok" ? reread.digest : null).toBe(changed.digest);
  });

  it("reaches the resolved seal state of a sealed vault", async () => {
    await writeContractVault(vault, { contractStoreRoot: root, folders: { Inbox: { intent: "capture" } } });
    const state = await resolveSealState(vault, root);
    expect(state.row).toBe("sealed");
    const read = await readStore(state.vaultId!, root);
    expect(read.state).toBe("ok");
    expect(contractRevision(state.view)).toBe(read.state === "ok" ? read.digest : null);
    expect(contractRevision(state.view)).not.toBe(state.view.state === "sealed" ? contractRevision({ state: "sealed", contract: state.view.contract }) : null);
  });
});
