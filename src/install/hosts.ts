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
  replaceRootJsonPropertyPreservingBytes,
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
      if (runtime === "claude") results.push(await installClaude(options, host));
      if (runtime === "codex") results.push(await installCodex(options, host));
      if (runtime === "hermes") results.push(await installHermes(options, host));
    } else {
      if (runtime === "claude") results.push(await uninstallClaude(options));
      if (runtime === "codex") results.push(await uninstallCodex(options));
      if (runtime === "hermes") results.push(await uninstallHermes(options));
    }
  }
  return results;
}

export function formatHostOperationResults(
  results: readonly HostOperationResult[],
  dryRun = false,
): string {
  return results.map((result) => {
    const status = result.skipped
      ? "skipped"
      : result.changed
        ? "changed"
        : "unchanged";
    const lines = [
      `[${result.runtime}] ${result.action} ${status}${dryRun ? " (dry-run)" : ""}`,
      ...result.paths.map((item) => `  path: ${item}`),
      ...result.commands.map((item) => `  command: ${item}`),
      ...result.messages.map((item) => `  note: ${item}`),
    ];
    return lines.join("\n");
  }).join("\n\n");
}

export function formatHostOperationResultsJson(
  results: readonly HostOperationResult[],
  dryRun = false,
): string {
  return JSON.stringify(
    {
      dryRun,
      results: results.map((result) => ({
        runtime: result.runtime,
        action: result.action,
        changed: result.changed,
        skipped: result.skipped,
        paths: result.paths,
        commands: result.commands,
        messages: result.messages,
        cleanup: result.cleanup ?? [],
      })),
    },
    null,
    2,
  );
}
