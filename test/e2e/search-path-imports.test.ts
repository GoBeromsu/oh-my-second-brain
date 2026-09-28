import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Proves the `oms search --path` route stays off the engine's import graph: the built CLI is
 * spawned under an ESM `load` hook that records every `file:` module it loads, in an isolated
 * home, and the recorded list must hold read-exact and none of the MCP, HTTP or engine modules.
 */

const REPO = path.resolve(import.meta.dirname, "..", "..");
const OMS = path.join(REPO, "dist", "cli", "oms.js");

let base = "";
let vault = "";
let register = "";
let env: NodeJS.ProcessEnv = {};

function tracedRun(args: readonly string[], traceName: string): { status: number | null; stdout: string; loaded: string[] } {
  const traceFile = path.join(base, traceName);
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(register).href, OMS, ...args], {
    cwd: base,
    env: { ...env, TRACE_FILE: traceFile },
    encoding: "utf8",
    timeout: 20_000,
  });
  const loaded = existsSync(traceFile) ? readFileSync(traceFile, "utf8").split("\n").filter(Boolean) : [];
  return { status: result.status, stdout: result.stdout, loaded };
}

const FORBIDDEN = [
  "/dist/mcp/",
  "/dist/cli/serve-http.js",
  "/dist/cli/engine-session.js",
  "/dist/cli/index-command.js",
  "/dist/kernel/engine/",
  "/node_modules/better-sqlite3/",
  "/node_modules/sqlite-vec",
];

beforeAll(async () => {
  if (!existsSync(OMS)) throw new Error("run `npm run build` before the search-path import e2e test (dist/cli/oms.js missing)");
  base = await realpath(await mkdtemp(path.join(tmpdir(), "oms-search-path-imports-")));
  const home = path.join(base, "home");
  const isolated: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    OMS_RUNTIME_ROOT: path.join(base, "runtime"),
    OMS_AUTO_UPDATE_STATE_DIR: path.join(base, "auto-update"),
    OMS_CLAUDE_HOME: path.join(base, "claude"),
    OMS_CODEX_HOME: path.join(base, "codex"),
    OMS_HERMES_HOME: path.join(base, "hermes"),
    XDG_CONFIG_HOME: path.join(base, "xdg-config"),
    XDG_CACHE_HOME: path.join(base, "xdg-cache"),
    XDG_DATA_HOME: path.join(base, "xdg-data"),
  };
  for (const dir of Object.values(isolated)) await mkdir(dir, { recursive: true });
  env = { ...process.env, ...isolated };
  delete env["OMS_VAULT"];

  vault = path.join(base, "vault");
  await mkdir(path.join(vault, "n"), { recursive: true });
  await writeFile(path.join(vault, "n", "a.md"), "# a\n\nbody\n");

  const hooks = path.join(base, "trace-hooks.mjs");
  await writeFile(
    hooks,
    [
      'import { appendFileSync } from "node:fs";',
      "export async function load(url, context, nextLoad) {",
      '  if (url.startsWith("file:")) appendFileSync(process.env.TRACE_FILE, url + "\\n");',
      "  return nextLoad(url, context);",
      "}",
      "",
    ].join("\n"),
  );
  register = path.join(base, "trace-register.mjs");
  await writeFile(register, `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`);
});

afterAll(async () => {
  if (base !== "") await rm(base, { recursive: true, force: true });
});

describe("oms search --path import graph (built CLI, isolated home)", () => {
  it("loads read-exact and none of the MCP, HTTP or engine modules", () => {
    const run = tracedRun(["search", "--path", "n/a.md", "--vault", vault], "path.trace");
    expect(run.status).toBe(0);
    expect((JSON.parse(run.stdout) as { available: boolean }).available).toBe(true);
    expect(run.loaded.some(url => url.endsWith("/dist/kernel/search/read-exact.js"))).toBe(true);
    for (const needle of FORBIDDEN) expect(run.loaded.filter(url => url.includes(needle))).toEqual([]);
  });

  it("control: a plain search does load the engine, so the trace can see it", () => {
    const run = tracedRun(["search", "body", "--vault", vault], "query.trace");
    expect(run.status).toBe(0);
    expect(run.loaded.some(url => url.includes("/dist/cli/engine-session.js"))).toBe(true);
  });
});
