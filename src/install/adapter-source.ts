import path from "node:path";
import { harnessSurfaceRegistry } from "../harness/surface-registry.js";
import type { HarnessHostSurface } from "../harness/surface-registry.js";
import type { HostRuntime } from "./types.js";

const REGISTRY_ADAPTER_ROOT = "adapters";

export const HOST_RUNTIMES: readonly HostRuntime[] = harnessSurfaceRegistry.hosts.map((host) => host.runtime);

export class HostAdapterSourceError extends Error {
  readonly runtime: HostRuntime;
  readonly adapterDir: string;

  constructor(host: Pick<HarnessHostSurface, "runtime" | "adapterDir">) {
    super(`Invalid adapterDir for ${host.runtime}: ${host.adapterDir}`);
    this.name = "HostAdapterSourceError";
    this.runtime = host.runtime;
    this.adapterDir = host.adapterDir;
  }
}

export class UnsupportedHostRuntimeError extends Error {
  readonly runtime: string;

  constructor(runtime: string) {
    super(`Unsupported host runtime: ${runtime}`);
    this.name = "UnsupportedHostRuntimeError";
    this.runtime = runtime;
  }
}

export function resolveHostAdapterSource(
  adapterRoot: string,
  host: Pick<HarnessHostSurface, "runtime" | "adapterDir">,
): string {
  if (path.isAbsolute(host.adapterDir) || path.win32.isAbsolute(host.adapterDir)) {
    throw new HostAdapterSourceError(host);
  }
  const normalized = path.posix.normalize(host.adapterDir.replace(/\\/g, "/"));
  const adapterPrefix = `${REGISTRY_ADAPTER_ROOT}/`;
  if (!normalized.startsWith(adapterPrefix)) {
    throw new HostAdapterSourceError(host);
  }
  const adapterSubdir = normalized.slice(adapterPrefix.length);
  if (adapterSubdir.length === 0 || adapterSubdir.startsWith("../") || adapterSubdir === "..") {
    throw new HostAdapterSourceError(host);
  }
  return path.join(adapterRoot, adapterSubdir);
}

export function hostSurfaceForRuntime(runtime: HostRuntime): HarnessHostSurface {
  const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === runtime);
  if (host === undefined) {
    throw new UnsupportedHostRuntimeError(runtime);
  }
  return host;
}
