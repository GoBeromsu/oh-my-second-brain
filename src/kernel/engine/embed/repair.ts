import { existsSync, renameSync } from "node:fs";
import { openEngineStoreCore } from "./store.js";
import { engineStorePath } from "../paths.js";

export type EngineStoreRepairMode = "rebuild" | "drop";

export interface EngineStoreRepairPlan {
  readonly mode: EngineStoreRepairMode;
  readonly storePath: string;
  readonly backupPath: string | null;
  readonly reindexRequired: boolean;
  readonly dryRun: boolean;
}

export interface RepairEngineStoreOptions {
  readonly vault: string;
  readonly mode: EngineStoreRepairMode;
  readonly dryRun?: boolean;
  readonly now?: () => Date;
}

/**
 * This service owns only the engine SQLite file and its SQLite sidecars. It
 * never opens a legacy store and never writes vault Markdown or authoritative
 * `.oms` files (taxonomy, template-policy, types, or models).
 */
export function repairEngineStore(options: RepairEngineStoreOptions): EngineStoreRepairPlan {
  const storePath = engineStorePath(options.vault);
  const backupPath = existsSync(storePath) ? backupStorePath(storePath, options.now?.() ?? new Date()) : null;
  const plan: EngineStoreRepairPlan = {
    mode: options.mode,
    storePath,
    backupPath,
    reindexRequired: true,
    dryRun: options.dryRun === true,
  };
  if (options.dryRun) return plan;

  if (backupPath !== null) moveStoreWithSidecars(storePath, backupPath);
  if (options.mode === "rebuild") {
    const store = openEngineStoreCore(storePath);
    store.close();
  }
  return plan;
}

function backupStorePath(storePath: string, now: Date): string {
  const timestamp = now.toISOString().replace(/[-:.]/gu, "");
  return `${storePath}.backup-${timestamp}`;
}

function moveStoreWithSidecars(storePath: string, backupPath: string): void {
  renameSync(storePath, backupPath);
  for (const suffix of ["-wal", "-shm"] as const) {
    if (existsSync(`${storePath}${suffix}`)) renameSync(`${storePath}${suffix}`, `${backupPath}${suffix}`);
  }
}
