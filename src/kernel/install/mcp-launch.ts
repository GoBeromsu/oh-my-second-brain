import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { resolveBundledAssetPaths } from "../runtime/assets.js";

export interface OmsMcpLaunch {
  readonly command: string;
  readonly args: string[];
}

export function omsCliPath(): string {
  return path.join(resolveBundledAssetPaths().packageRoot, "dist", "cli", "oms.js");
}

/** Prefer a major-scoped Homebrew link only after proving it is this exact runtime. */
export function omsNodePath(
  executable = process.execPath,
  version = process.versions.node,
  resolve: (pathname: string) => string = realpathSync,
): string {
  try {
    const real = resolve(executable);
    const keg = /^(.*)\/Cellar\/(node@\d+)\/[^/]+\/bin\/node$/.exec(real);
    if (keg !== null && keg[2] === `node@${version.split(".")[0]}`) {
      const stable = `${keg[1]}/opt/${keg[2]}/bin/node`;
      if (resolve(stable) === real) return stable;
    }
  } catch {
    // No verified stable alias exists. Keep the concrete executable, never PATH.
  }
  return executable;
}

/** Keep the package and the Node that loaded it together across host PATH changes. */
export function omsMcpLaunch(vault: string): OmsMcpLaunch {
  return { command: omsNodePath(), args: [omsCliPath(), "serve", "mcp", "--vault", vault] };
}

/** Legacy PATH registrations remain recognizable so an install can migrate them. */
export function omsMcpVault(command: unknown, args: unknown): string | null {
  if (!Array.isArray(args) || !args.every(arg => typeof arg === "string")) return null;
  let tail = args;
  if (command !== "oms") {
    if (typeof command !== "string" || !path.isAbsolute(command)
      || !/^node(?:\.exe)?$/i.test(path.basename(command)) || args[0] !== omsCliPath()) return null;
    tail = args.slice(1);
  }
  return tail.length === 4 && tail[0] === "serve" && tail[1] === "mcp"
    && tail[2] === "--vault" && typeof tail[3] === "string" ? tail[3] : null;
}

const NATIVE_SMOKE = `
const { createRequire } = require('node:module');
const req = createRequire(process.argv[1]);
const Database = req('better-sqlite3');
const db = new Database(':memory:');
try { db.prepare('select sqlite_version()').get(); }
finally { db.close(); }
`;

/** Read-only admission: never publish a registration whose required natives cannot load. */
export function assertOmsNativeRuntime(): void {
  const manifest = path.join(resolveBundledAssetPaths().packageRoot, "package.json");
  const result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", NATIVE_SMOKE, manifest], {
    encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  if (result.status !== 0) {
    const reason = result.error?.message || result.stderr?.trim() || `exit ${result.status}, signal ${result.signal}`;
    throw new Error(`OMS_NATIVE_RUNTIME_UNAVAILABLE: ${process.execPath} (Node ${process.versions.node}, ABI ${process.versions.modules}) cannot load this OMS package's SQLite core: ${reason}. Host registrations were not changed. Run setup with the Node that owns this installation; do not rebuild shared native modules for a different host PATH.`);
  }
}
