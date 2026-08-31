import { HOST_RUNTIMES } from "./adapter-source.js";
import { commandExists } from "./common.js";
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
  hostSurfaceForRuntime,
  resolveHostAdapterSource,
} from "./adapter-source.js";
export {
  HostVaultPointerError,
  canonicalHostVault,
  deleteHostVaultPointer,
  hostVaultPointerPath,
  readHostVaultPointer,
  readHostVaultPointerForRepair,
  writeHostVaultPointer,
  type HostVaultPointer,
} from "./pointer.js";
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

export type HostOperationRunner = (
  options: HostOperationOptions,
  runtime: HostRuntime,
) => Promise<HostOperationResult>;

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

export async function runHostOperation(
  options: HostOperationOptions,
  runSingleHostOperation: HostOperationRunner,
): Promise<HostOperationResult[]> {
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
