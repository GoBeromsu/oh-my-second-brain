import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendLineageEvents } from "../contract/lineage.js";
import { stateDir } from "../contract/state-dir.js";
import { sealContract } from "../contract/store.js";
import type { VaultContract } from "../contract/types.js";
import { writePolicy } from "../evolution/policy.js";
import { createRequest, lineageTail } from "../evolution/request-state.js";
import { serializeVaultSettings } from "../vault/settings.js";
import { evolutionStatus } from "./evolution-status.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const NOW = 1_700_000_000_000;
const FOREIGN = `sha256:${"e".repeat(64)}` as const;
const CONTRACT: VaultContract = { folders: { Projects: { meaning: "projects", searchExclude: false } }, properties: {} };

let base: string;
let root: string;
let vault: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-evolution-status-")));
  root = join(base, "home", ".oms", "vaults");
  vault = join(base, "vault");
  await mkdir(join(vault, ".oms"), { recursive: true });
  await writeFile(join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: ID, templateFolder: "Templates" }));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const seal = async () => (await sealContract({ vaultRealPath: vault, vaultId: ID, contract: CONTRACT }, root)).digest;
let counter = 0;
const requestDeps = {
  now: () => NOW,
  newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  newToken: () => (++counter).toString(16).padStart(32, "0"),
};

describe("evolutionStatus", () => {
  it("is null for an unsealed vault and creates no store", async () => {
    expect(await evolutionStatus(vault, NOW, root)).toBeNull();
    expect(existsSync(root)).toBe(false);
  });

  it("reports an idle sealed vault with autonomy off and creates no evolution state", async () => {
    await seal();
    expect(await evolutionStatus(vault, NOW, root)).toEqual({
      autonomous: false,
      policy: "absent",
      counters: expect.objectContaining({ "request.issued": 0, "seal.autonomous": 0, "seal.human-approved": 0, "lineage.gap-refused": 0 }),
      awaitingHuman: 0,
      budget: { limits: { perDay: 1, perWeek: 3 }, used: { day: 0, week: 0 }, remaining: { day: 0, week: 0 } },
      lineageGap: false,
      quorum: "host-attested",
    });
    expect(existsSync(join(stateDir(root, ID), "evolution"))).toBe(false);
  });

  it("counts awaiting-human requests and shows the budget left when autonomy is on", async () => {
    await seal();
    await writePolicy(root, ID, { version: 1, autonomous: true, limits: { perDay: 1, perWeek: 3 } }, { interactive: true });
    const folder = { meaning: "archive", searchExclude: false };
    const candidate: VaultContract = { ...CONTRACT, folders: { ...CONTRACT.folders, Archive: folder } };
    const { tail } = await lineageTail(root, ID);
    await createRequest(root, ID, {
      kind: "evolve", contract: candidate, mutations: [{ op: "ADD", axis: "folder", key: "Archive", after: folder }], parent: tail, state: "awaiting-human",
    }, requestDeps);
    const status = await evolutionStatus(vault, NOW, root);
    expect(status).toMatchObject({
      autonomous: true, policy: "ok", awaitingHuman: 1,
      counters: { "request.issued": 1 },
      budget: { used: { day: 0, week: 0 }, remaining: { day: 1, week: 3 } },
      lineageGap: false,
    });
  });

  it("spends the budget on an autonomous seal and reports a current lineage gap", async () => {
    const digest = await seal();
    await writePolicy(root, ID, { version: 1, autonomous: true, limits: { perDay: 1, perWeek: 3 } }, { interactive: true });
    await appendLineageEvents(root, ID, [{ kind: "sealed", generation: 99, parentDigest: digest as typeof FOREIGN, digest: FOREIGN, mutations: [], manifestDigests: {}, autonomous: true }]);
    expect(await evolutionStatus(vault, NOW, root)).toMatchObject({
      budget: { used: { day: 1, week: 1 }, remaining: { day: 0, week: 2 } },
      lineageGap: true,
    });
  });
});
