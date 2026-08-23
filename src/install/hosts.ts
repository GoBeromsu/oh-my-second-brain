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
export {
  HostAdapterSourceError,
  UnsupportedHostRuntimeError,
  resolveHostAdapterSource,
  resolveSharedSkillsSource,
} from "./adapter-source.js";
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

async function runSingleHostOperation(
  options: HostOperationOptions,
  runtime: HostRuntime,
): Promise<HostOperationResult> {
  const host = hostSurfaceForRuntime(runtime);
  if (options.action === "install") {
    if (runtime === "claude") return installClaude(options, host);
    if (runtime === "codex") return installCodex(options, host);
    return installHermes(options, host);
  }
  if (runtime === "claude") return uninstallClaude(options);
  if (runtime === "codex") return uninstallCodex(options);
  return uninstallHermes(options);
}

function failedHostOperationResult(
  options: HostOperationOptions,
  runtime: HostRuntime,
  error: unknown,
): HostOperationResult {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    runtime,
    action: options.action,
    changed: false,
    skipped: false,
    paths: [],
    commands: [],
    messages: [`FAILED: ${runtime} ${options.action} did not complete: ${reason}`],
  };
}

export async function runHostOperation(options: HostOperationOptions): Promise<HostOperationResult[]> {
  const runtimes = resolveRuntimeSelection(options.runtime);
  const results: HostOperationResult[] = [];
  for (const runtime of runtimes) {
    try {
      results.push(await runSingleHostOperation(options, runtime));
    } catch (error) {
      results.push(failedHostOperationResult(options, runtime, error));
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
