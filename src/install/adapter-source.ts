import path from "node:path";
import { harnessSurfaceRegistry } from "../harness/surface-registry.js";
import type { HarnessHostSurface } from "../harness/surface-registry.js";
import type { HostRuntime } from "./types.js";

/**
 * The single authored skill source. Every host installs from here; no host
 * ships its own copy. Kept as a literal so a typo cannot silently resolve to a
 * different tree.
 */
export const SHARED_SKILLS_SOURCE = "assets/skills";

/**
 * Exhaustive allowlist of legal `adapterDir` values.
 *
 * `adapterDir` names where a host's MANIFEST lives, which is now decoupled from
 * where its SKILLS live (always SHARED_SKILLS_SOURCE). Claude and Codex read
 * repo-root plugin manifests, so their manifest location is the repository root
 * itself; Hermes has no repo plugin manifest and its metadata sits under
 * `assets`.
 *
 * This is an exhaustive allowlist rather than a prefix rule on purpose. A
 * prefix rule admits an open-ended family of paths and has to defend every one
 * of them; two literal values cannot be traversed out of.
 */
const ALLOWED_ADAPTER_DIRS: readonly string[] = [".", "assets"];

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

/**
 * Resolve a host's manifest directory beneath `packageRoot`.
 *
 * Rejection order is load-bearing. `path.posix.normalize` collapses `assets/..`
 * and `""` to `"."`, so a legal-value check placed before the traversal and
 * emptiness checks would accept both. Every rejection therefore runs against
 * the RAW value first, and only a value that survives all of them is compared
 * against the allowlist.
 */
export function resolveHostAdapterSource(
  packageRoot: string,
  host: Pick<HarnessHostSurface, "runtime" | "adapterDir">,
): string {
  const raw = host.adapterDir;

  // 1. Absolute paths escape the package entirely.
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new HostAdapterSourceError(host);
  }

  // 2. Empty is not a path. Checked on the raw value: normalize() turns "" into ".".
  if (raw.trim().length === 0) {
    throw new HostAdapterSourceError(host);
  }

  const slashed = raw.replace(/\\/g, "/");

  // 3. Any traversal segment at all. Checked on the raw value: normalize() would
  //    collapse "assets/.." to ".", which is itself a legal value, so deferring
  //    this check until after normalization would silently admit it.
  if (slashed.split("/").some((segment) => segment === "..")) {
    throw new HostAdapterSourceError(host);
  }

  // 4. Only now is normalization safe: it can no longer mask a rejected input.
  const normalized = path.posix.normalize(slashed).replace(/\/+$/, "") || ".";

  if (!ALLOWED_ADAPTER_DIRS.includes(normalized)) {
    throw new HostAdapterSourceError(host);
  }

  return normalized === "." ? packageRoot : path.join(packageRoot, normalized);
}

/** Absolute path to the single shared skill source beneath `packageRoot`. */
export function resolveSharedSkillsSource(packageRoot: string): string {
  return path.join(packageRoot, ...SHARED_SKILLS_SOURCE.split("/"));
}

export function hostSurfaceForRuntime(runtime: HostRuntime): HarnessHostSurface {
  const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === runtime);
  if (host === undefined) {
    throw new UnsupportedHostRuntimeError(runtime);
  }
  return host;
}
