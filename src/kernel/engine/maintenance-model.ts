import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileMetadataWitness } from "../conventions/file-snapshot.js";
import { readVaultEmbeddingModelSync } from "./embed/config.js";
import { embeddingModelCacheDir, INSTALLED_MODELS_RECEIPT, parseInstalledModelsReceipt, readInstalledModelsReceiptSync, resolveEmbeddingModel } from "./embed/model.js";
import { makeEmbeddingIdentity } from "./embed/identity.js";
import { requireRealEmbeddingProvider } from "./embed/provider.js";
import { hashReadSnapshotFile } from "./embed/read-snapshot.js";
import type { EmbeddingIdentity } from "./embed/store.js";
import type { EmbeddingProvider } from "./types.js";

export interface MaintenanceEmbedding {
  readonly provider: EmbeddingProvider;
  readonly identity: EmbeddingIdentity;
  isCurrent(): boolean;
}

/** Reuses the strict local model resolver; never installs or downloads anything. */
export function createMaintenanceEmbedding(vault: string, options: {
  readonly modelCacheDir?: string;
  readonly modelEnv?: Readonly<Record<string, string | undefined>>;
} = {}): MaintenanceEmbedding {
  const receiptPath = path.join(embeddingModelCacheDir({ cacheDir: options.modelCacheDir }), INSTALLED_MODELS_RECEIPT);
  const selected = () => {
    let receipt: string;
    try { receipt = readFileSync(receiptPath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; receipt = JSON.stringify({ schemaVersion: 1, artifacts: [], defaults: [] }); }
    const env = options.modelEnv ?? process.env;
    return { receipt, vaultModel: readVaultEmbeddingModelSync(vault), provider: env.OMS_EMBEDDING_PROVIDER, model: env.OMS_EMBEDDING_MODEL };
  };
  const before = selected();
  const selection = JSON.stringify(before);
  // Resolve the selected path before integrity verification, then bind that
  // verified descriptor to the same observed artifact generation.
  const initial = resolveEmbeddingModel({ installedReceipt: parseInstalledModelsReceipt(before.receipt), vaultEmbeddingModel: before.vaultModel, env: options.modelEnv ?? process.env });
  if (!initial.available || initial.descriptor?.path === undefined) throw new Error(initial.guidance ?? "Full maintenance requires an installed embedding model. Run oms setup model install and an explicit embedding sync first.");
  const filename = initial.descriptor.path;
  const stamp = () => {
    const info = statSync(filename, { bigint: true });
    const witness = fileMetadataWitness(info);
    return JSON.stringify([realpathSync(filename), witness ?? `bytes:${hashReadSnapshotFile(filename)}`]);
  };
  const artifact = stamp();
  const verified = readInstalledModelsReceiptSync({ cacheDir: options.modelCacheDir });
  const resolved = resolveEmbeddingModel({ installedReceipt: verified, vaultEmbeddingModel: before.vaultModel, env: options.modelEnv ?? process.env });
  if (!resolved.available || resolved.descriptor?.path !== filename || JSON.stringify(selected()) !== selection || stamp() !== artifact) {
    throw new Error("Maintenance embedding selection changed while validating it; retry startup.");
  }
  const descriptor = resolved.descriptor;
  const identity = makeEmbeddingIdentity({ provider: descriptor.provider, model: descriptor.model, revision: descriptor.revision, sha256: descriptor.sha256,
    dimensions: descriptor.dimensions!, contextLength: descriptor.context!, mrlDim: descriptor.mrlDim!, normalization: descriptor.normalization!, prefixScheme: descriptor.prefixScheme! });
  const provider = requireRealEmbeddingProvider({ provider: descriptor.provider, model: filename, localOnly: true, dimensions: descriptor.dimensions, context: descriptor.context,
    mrlDim: descriptor.mrlDim, normalization: descriptor.normalization, prefixScheme: descriptor.prefixScheme });
  return {
    provider, identity,
    isCurrent() { try { return JSON.stringify(selected()) === selection && stamp() === artifact; } catch { return false; } },
  };
}
