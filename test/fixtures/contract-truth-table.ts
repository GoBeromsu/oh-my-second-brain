import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealContract, writeIndexEntry } from "../../src/kernel/contract/store.js";
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
  "vault-id-tampered",
  "index-corrupt",
];

export const FIXTURE_CONTRACT: VaultContract = {
  folders: { Projects: { meaning: "project notes", searchExclude: false } },
  properties: null,
  templates: {},
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

async function sealAt(vault: string, vaultId: string, root: string, contract: VaultContract): Promise<void> {
  await writeSettings(vault, vaultId);
  await sealContract({ vaultRealPath: await realpath(vault), vaultId, contract }, root);
}

export async function buildTruthTableRow(row: SealRow, contract: VaultContract = FIXTURE_CONTRACT): Promise<TruthTableFixture> {
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
