import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealLegacyGeneration } from "../../src/kernel/contract/legacy-store-fixture.js";
import type { TemplatedContract } from "../../src/kernel/contract/legacy.js";
import { bootstrapSnapshots, sealContract, writeIndexEntry } from "../../src/kernel/contract/store.js";
import type { VaultContract } from "../../src/kernel/contract/types.js";
import type { SealRow } from "../../src/kernel/contract/vault-id.js";
import { serializeVaultSettings, SETTINGS_PATH } from "../../src/kernel/vault/settings.js";

/**
 * Builds one vault + store root per row of the index truth table. Everything lives
 * under a fresh temporary directory; the real `~/.oms` is never touched.
 */

export const TRUTH_TABLE_ROWS: readonly SealRow[] = [
  "never-sealed",
  "synced-second-machine",
  "store-without-index",
  "vault-moved",
  "sealed",
  "index-without-store",
  "settings-missing",
  "vault-id-tampered",
  "index-corrupt",
];

export const FIXTURE_CONTRACT: VaultContract = {
  folders: { Projects: { meaning: "project notes", searchExclude: false } },
  properties: null,
};

export interface TruthTableFixture {
  readonly base: string;
  readonly vault: string;
  readonly root: string;
  readonly vaultId: string;
  cleanup(): Promise<void>;
}

export async function writeSettings(vault: string, vaultId: string): Promise<void> {
  await mkdir(join(vault, ".oms"), { recursive: true });
  await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId }));
}

/** A contract that carries templates seals as a legacy version 2 generation; otherwise version 3. */
async function sealAt(vault: string, vaultId: string, root: string, contract: VaultContract | TemplatedContract): Promise<void> {
  await writeSettings(vault, vaultId);
  const vaultRealPath = await realpath(vault);
  const templates = "templates" in contract ? contract.templates : {};
  const split: VaultContract = { folders: contract.folders, properties: contract.properties };
  if (Object.keys(templates).length === 0) {
    await sealContract({ vaultRealPath, vaultId, contract: split }, root);
    return;
  }
  await sealLegacyGeneration({ vaultRealPath, vaultId, contract: split, templates }, root);
  await bootstrapSnapshots(root, vaultId);
}

export async function buildTruthTableRow(row: SealRow, contract: VaultContract | TemplatedContract = FIXTURE_CONTRACT): Promise<TruthTableFixture> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "oms-truth-")));
  const vault = join(base, "vault");
  const root = join(base, "home", ".oms", "vaults");
  await mkdir(vault, { recursive: true });
  const vaultId = randomUUID();

  switch (row) {
    case "never-sealed":
      break;
    case "synced-second-machine":
      await writeSettings(vault, vaultId);
      break;
    case "store-without-index":
      await sealAt(vault, vaultId, root, contract);
      await writeFile(join(root, "index.json"), JSON.stringify({ version: 1, vaults: {} }));
      break;
    case "vault-moved": {
      const old = join(base, "old-vault");
      await mkdir(old);
      await sealAt(old, vaultId, root, contract);
      await writeSettings(vault, vaultId);
      await rm(old, { recursive: true });
      break;
    }
    case "sealed":
      await sealAt(vault, vaultId, root, contract);
      break;
    case "index-without-store":
      await sealAt(vault, vaultId, root, contract);
      await rm(join(root, vaultId));
      break;
    case "settings-missing":
      await sealAt(vault, vaultId, root, contract);
      await rm(join(vault, SETTINGS_PATH));
      break;
    case "vault-id-tampered":
      await sealAt(vault, vaultId, root, contract);
      await writeSettings(vault, randomUUID());
      break;
    case "index-corrupt":
      await sealAt(vault, vaultId, root, contract);
      await writeFile(join(root, "index.json"), "{not json");
      break;
  }
  return { base, vault, root, vaultId, cleanup: () => rm(base, { recursive: true, force: true }) };
}

/** A second existing vault path mapped to the same id (a copied vault). */
export async function addSharedCopy(fixture: TruthTableFixture): Promise<string> {
  const copy = join(fixture.base, "copy");
  await mkdir(copy);
  await writeSettings(copy, fixture.vaultId);
  await writeIndexEntry(await realpath(copy), fixture.vaultId, fixture.root);
  return copy;
}
