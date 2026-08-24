import type { HarnessHostRuntime } from "../harness/surface-registry.js";

export type HostRuntime = HarnessHostRuntime;
export type RuntimeSelection = HostRuntime | "auto" | "all";
export type HostAction = "install" | "uninstall";

export type ClaudeMcpScope = "local" | "project" | "user";
export type LegacyCleanupStatus = "removed" | "not_found" | "failed";

export interface LegacyCleanupResult {
  readonly scope: ClaudeMcpScope;
  readonly status: LegacyCleanupStatus;
  readonly reasonCode: string;
  readonly manualCommand: string;
}

export interface HostOperationOptions {
  readonly action: HostAction;
  readonly runtime: RuntimeSelection;
  readonly vault: string;
  readonly agentVault?: string;
  readonly packageSpec?: string;
  readonly dryRun?: boolean;
  readonly executeExternal?: boolean;
  readonly yes?: boolean;
  readonly homeDir?: string;
  readonly adapterRoot: string;
}

export interface HostOperationResult {
  readonly runtime: HostRuntime;
  readonly action: HostAction;
  readonly changed: boolean;
  readonly skipped: boolean;
  readonly paths: string[];
  readonly commands: string[];
  readonly messages: string[];
  readonly cleanup?: readonly LegacyCleanupResult[];
}
