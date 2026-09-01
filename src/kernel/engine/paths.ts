import path from "node:path";

export const ENGINE_STORE_FILENAME = "engine-store.sqlite";

export function engineStorePath(vaultPath: string): string {
  return path.join(vaultPath, ".oms", ENGINE_STORE_FILENAME);
}
