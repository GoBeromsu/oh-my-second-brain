import { hostSurfaceForRuntime, HOST_RUNTIMES } from "./adapter-source.js";
import { commandExists } from "./common.js";
import { installClaude, uninstallClaude } from "./claude.js";
import { installCodex, uninstallCodex } from "./codex.js";
import { installHermes, uninstallHermes } from "./hermes.js";
import type { HostOperationOptions, HostOperationResult, HostRuntime, RuntimeSelection } from "./types.js";

export type {
  HostAction,
  HostOperationOptions,
  HostOperationResult,
  HostRuntime,
  RuntimeSelection,
} from "./types.js";
export { HostAdapterSourceError, UnsupportedHostRuntimeError, resolveHostAdapterSource } from "./adapter-source.js";
export {
  buildGuardCommandString,
  isOmsHookEntry,
  removeClaudeHooks,
  toShellVaultPath,
  upsertClaudeHooks,
} from "./claude-hooks.js";

export function detectAvailableHosts(): HostRuntime[] {
  return HOST_RUNTIMES.filter((runtime) => commandExists(runtime));
}

export function resolveRuntimeSelection(selection: RuntimeSelection): HostRuntime[] {
  if (selection === "all") return [...HOST_RUNTIMES];
  if (selection === "auto") {
    const detected = detectAvailableHosts();
    return detected.length > 0 ? detected : ["claude"];
  }
  return [selection];
}

export async function runHostOperation(options: HostOperationOptions): Promise<HostOperationResult[]> {
  const runtimes = resolveRuntimeSelection(options.runtime);
  const results: HostOperationResult[] = [];
  for (const runtime of runtimes) {
    const host = hostSurfaceForRuntime(runtime);
    if (options.action === "install") {
      switch (runtime) {
        case "claude":
          results.push(await installClaude(options, host));
          break;
        case "codex":
          results.push(await installCodex(options, host));
          break;
        case "hermes":
          results.push(await installHermes(options, host));
          break;
      }
    } else {
      switch (runtime) {
        case "claude":
          results.push(await uninstallClaude(options));
          break;
        case "codex":
          results.push(await uninstallCodex(options));
          break;
        case "hermes":
          results.push(await uninstallHermes(options));
          break;
      }
    }
  }
  return results;
}

export function formatHostOperationResults(results: HostOperationResult[], dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(dryRun ? "Oh My Second Brain host operation plan (dry-run)." : "Oh My Second Brain host operation complete.");
  for (const result of results) {
    const resultPrefix = `- ${result.runtime} ${result.action}:`;
    if (result.skipped) {
      lines.push(`${resultPrefix} skipped`);
    } else if (result.changed || dryRun) {
      lines.push(`${resultPrefix} ok`);
    } else {
      lines.push(`${resultPrefix} no changes`);
    }
    for (const message of result.messages) lines.push(`  ${message}`);
    for (const filePath of result.paths) lines.push(`  path: ${filePath}`);
    for (const command of result.commands) lines.push(`  command: ${command}`);
  }
  return lines.join("\n");
}
