import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { formatDenyReason, type VaultContract } from "../../src/kernel/contract/types.js";
import type { SealRow } from "../../src/kernel/contract/vault-id.js";
import { buildTruthTableRow, TRUTH_TABLE_ROWS, type TruthTableFixture } from "../fixtures/contract-truth-table.js";

/**
 * The installed wrapper run in place against the built CLI (`dist/cli/oms.js`), with a
 * temporary HOME. Nothing here touches the real `~/.oms`.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const WRAPPER = path.join(REPO_ROOT, "assets", "claude", "hooks", "oms-guard.mjs");
const ALLOW = '{"continue":true,"suppressOutput":true}\n';
const WARNING = "[oms] guard could not reach the judge; write allowed. Run: oms contract doctor\n";
const CONTROL_DENY = formatDenyReason([{ field: "path", kind: "control-path" }]);
const SEARCH_DENY = `[oms] write denied: ${JSON.stringify([{ field: "path", kind: "control-path" }])} Narrow the search path or glob so it cannot reach ~/.oms. Run: oms status`;
const UNSAFE_DENY = formatDenyReason([{ field: "path", kind: "path-unsafe" }]);
const INPUT_DENY = formatDenyReason([{ field: "input", kind: "unsupported-input" }]);

const CONTRACT: VaultContract = {
  folders: { Projects: { meaning: "project notes", searchExclude: false } },
  properties: { status: { meaning: "state", type: "text", default: false, required: true, rules: [{ kind: "allowed", values: ["open", "done"] }] } },
  templates: {},
};
const GOOD = "---\nstatus: open\n---\nbody\n";
const BAD = "---\nstatus: maybe\n---\nbody\n";

const EXPECTED_VIEW: Readonly<Record<SealRow, "open" | "unreadable" | "sealed">> = {
  "never-sealed": "open",
  "synced-second-machine": "open",
  "store-without-index": "sealed",
  "vault-moved": "sealed",
  "sealed": "sealed",
  "index-without-store": "unreadable",
  "vault-id-tampered": "unreadable",
  "index-corrupt": "sealed",
};

const fixtures: TruthTableFixture[] = [];
const directories: string[] = [];

interface Run {
  decision: "allow" | "deny";
  reason: string | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  vault?: string;
  agentVault?: string;
  home: string;
  wrapper?: string;
  pathEnv?: string;
}

function run(input: unknown, options: RunOptions): Run {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: options.home, OMS_AGENT_VAULT: options.agentVault ?? "" };
  if (options.vault === undefined) delete env["OMS_VAULT"];
  else env["OMS_VAULT"] = options.vault;
  if (options.pathEnv !== undefined) env["PATH"] = options.pathEnv;
  const result = spawnSync(process.execPath, [options.wrapper ?? WRAPPER], {
    encoding: "utf-8",
    input: typeof input === "string" ? input : JSON.stringify(input),
    env,
    timeout: 30000,
  });
  expect(result.status).toBe(0);
  const printed = JSON.parse(result.stdout) as Record<string, unknown>;
  const specific = printed["hookSpecificOutput"] as { permissionDecisionReason?: string } | undefined;
  if (specific) {
    expect(Object.hasOwn(printed, "continue")).toBe(false);
    return { decision: "deny", reason: specific.permissionDecisionReason ?? null, stdout: result.stdout, stderr: result.stderr };
  }
  expect(result.stdout).toBe(ALLOW);
  return { decision: "allow", reason: null, stdout: result.stdout, stderr: result.stderr };
}

async function row(name: SealRow): Promise<TruthTableFixture & { home: string }> {
  const fixture = await buildTruthTableRow(name, CONTRACT);
  fixtures.push(fixture);
  return { ...fixture, home: path.join(fixture.base, "home") };
}

function tempDir(prefix: string, parent = tmpdir()): string {
  const dir = mkdtempSync(path.join(parent, prefix));
  directories.push(dir);
  return dir;
}

function tool(name: string, input: Record<string, unknown>, cwd?: string) {
  return { hook_event_name: "PreToolUse", tool_name: name, tool_input: input, ...(cwd === undefined ? {} : { cwd }) };
}

function guardEvents(home: string): string[] {
  const file = path.join(home, ".oms", "guard-events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8").trim().split("\n").map(line => (JSON.parse(line) as { kind: string }).kind);
}

beforeAll(() => {
  if (!existsSync(path.join(REPO_ROOT, "dist", "cli", "oms.js"))) throw new Error("run `npm run build` before the wrapper e2e tests");
});

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("oms-guard wrapper over the truth table", () => {
  for (const name of TRUTH_TABLE_ROWS) {
    it(`judges vault writes in row ${name} by its view (${EXPECTED_VIEW[name]})`, async () => {
      const { vault, home } = await row(name);
      const note = path.join(vault, "Projects", "a.md");
      const good = run(tool("Write", { file_path: note, content: GOOD }), { vault, home });
      const bad = run(tool("Write", { file_path: note, content: BAD }), { vault, home });
      const view = EXPECTED_VIEW[name];
      if (view === "open") {
        expect([good.decision, bad.decision]).toEqual(["allow", "allow"]);
      } else if (view === "unreadable") {
        expect(good.reason).toBe(formatDenyReason([{ field: "contract", kind: "contract-unreadable" }]));
        expect(bad.decision).toBe("deny");
      } else {
        expect(good.decision).toBe("allow");
        expect(bad.reason).toBe(formatDenyReason([{ field: "status", kind: "not-allowed" }]));
      }
      expect(guardEvents(home)).toEqual([]);
    });
  }
});

describe("oms-guard wrapper read side", () => {
  it("denies native reads and searches of the home control store", async () => {
    const { vault, home, vaultId } = await row("sealed");
    const store = path.join(home, ".oms", "vaults");
    const alias = path.join(tempDir("oms-guard-alias-"), "alias");
    symlinkSync(path.join(home, ".oms"), alias);
    const denied = [
      tool("Read", { file_path: path.join(store, vaultId, "folders.json") }),
      tool("read", { file_path: path.join(store, vaultId, "folders.json") }),
      tool("Read", { file_path: path.join(alias, "vaults", vaultId, "folders.json") }),
      tool("Grep", { pattern: "status", path: store }),
    ];
    for (const payload of denied) {
      expect(run(payload, { vault, home }).reason).toBe(CONTROL_DENY);
    }
    const searches = [
      tool("Glob", { pattern: "**/.oms/**", path: home }),
      tool("Grep", { pattern: "status", glob: "**/.oms/**", path: home }),
      tool("Grep", { pattern: "status", glob: "**/.oms/**" }, home),
    ];
    for (const payload of searches) {
      expect(run(payload, { vault, home }).reason).toBe(SEARCH_DENY);
    }
  });

  it("expands ~ before the control-path check and denies ~user spellings", async () => {
    const { vault, home, vaultId } = await row("sealed");
    const control = [
      tool("Read", { file_path: `~/.oms/vaults/${vaultId}/folders.json` }),
      tool("Write", { file_path: "~/.oms/vaults/index.json", content: "{}" }),
      tool("Edit", { file_path: "~/.oms/vaults/index.json", old_string: "a", new_string: "b" }),
      tool("Grep", { pattern: "status", path: "~/.oms" }),
    ];
    for (const payload of control) {
      expect(run(payload, { vault, home }).reason).toBe(CONTROL_DENY);
    }
    expect(run(tool("Grep", { pattern: "status", path: "~" }), { vault, home }).reason).toBe(SEARCH_DENY);
    expect(run(tool("Glob", { pattern: "**/*.json", path: "~" }), { vault, home }).reason).toBe(SEARCH_DENY);
    expect(run(tool("Read", { file_path: "~other/.oms/vaults/index.json" }), { vault, home }).reason).toBe(UNSAFE_DENY);
    expect(run(tool("Write", { file_path: "~other/.oms/vaults/index.json", content: "{}" }), { vault, home }).reason).toBe(UNSAFE_DENY);
    expect(run(tool("Grep", { pattern: "status", path: "~other" }), { vault, home }).reason).toBe(UNSAFE_DENY);
  });

  it("denies searches from an ancestor of the store whose glob could reach it", async () => {
    const { vault, home } = await row("sealed");
    const reaching = [
      tool("Glob", { pattern: ".o[m]s/**", path: home }),
      tool("Glob", { pattern: ".om?/**", path: home }),
      tool("Glob", { pattern: "**/properties.json", path: home }),
      tool("Glob", { pattern: "*.json", path: home }),
      tool("Glob", { pattern: "{notes,.oms}/**", path: home }),
      tool("Glob", { pattern: "./.OMS/vaults/*", path: home }),
      tool("Glob", { pattern: `${home}/.oms/**` }, vault),
      tool("Glob", { pattern: `${home}/*/vaults/*`, path: vault }),
      tool("Glob", { pattern: "~/.oms/**", path: vault }),
      tool("Glob", { pattern: "~other/**", path: vault }),
      tool("Glob", { pattern: `../home/.oms/**`, path: vault }),
      tool("Grep", { pattern: "status", glob: `${home}/**/*.json`, path: vault }),
      tool("Glob", { path: home }),
      tool("Grep", { pattern: "status", path: home }),
      tool("Grep", { pattern: ".oms", path: home }),
      tool("Grep", { pattern: "status", glob: "*.json", path: home }),
      tool("Grep", { pattern: "status" }, home),
      tool("Grep", { pattern: "status", path: path.dirname(home) }),
    ];
    for (const payload of reaching) {
      expect(run(payload, { vault, home }).reason).toBe(SEARCH_DENY);
    }
  });

  it("allows ordinary reads and searches that cannot reach the control store", async () => {
    const { vault, home } = await row("sealed");
    const allowed = [
      tool("Glob", { pattern: "notes/**/*.md", path: home }),
      tool("Glob", { pattern: "./notes/*.md", path: home }),
      tool("Grep", { pattern: "status", glob: "Projects/**/*.md", path: home }),
      tool("Glob", { pattern: "**/*.md", path: vault }),
      tool("Glob", { pattern: `${vault}/**/*.md`, path: home }),
      tool("Glob", { pattern: "~/notes/**/*.md", path: vault }),
      tool("Grep", { pattern: ".oms", path: vault }),
      tool("Read", { file_path: path.join(vault, "Projects", "a.md") }),
    ];
    for (const payload of allowed) {
      expect(run(payload, { vault, home })).toMatchObject({ decision: "allow", stderr: "" });
    }
  });

  it("treats a vault at HOME: notes are readable, its .oms directory is not", () => {
    const home = realpathSync(tempDir("oms-guard-home-"));
    mkdirSync(path.join(home, ".oms"), { recursive: true });
    writeFileSync(path.join(home, "note.md"), GOOD);
    expect(run(tool("Read", { file_path: path.join(home, "note.md") }), { vault: home, home }).decision).toBe("allow");
    expect(run(tool("Read", { file_path: path.join(home, ".oms", "settings.json") }), { vault: home, home }).reason).toBe(CONTROL_DENY);
  });

  it("denies a read of the store with OMS_VAULT unset", async () => {
    const { home } = await row("sealed");
    expect(run(tool("Read", { file_path: path.join(home, ".oms", "vaults", "x") }), { home }).reason).toBe(CONTROL_DENY);
  });
});

describe("oms-guard wrapper write routing", () => {
  it("routes a write to the deepest configured vault", async () => {
    const { vault, home, base } = await row("sealed");
    const note = path.join(vault, "Projects", "a.md");
    expect(run(tool("Write", { file_path: note, content: BAD }), { vault: base, agentVault: vault, home }).reason)
      .toBe(formatDenyReason([{ field: "status", kind: "not-allowed" }]));
    expect(run(tool("Write", { file_path: note, content: BAD }), { vault, agentVault: base, home }).decision).toBe("deny");
  });

  it("denies writes to the guard itself and the oms package that holds its entry", () => {
    const home = realpathSync(tempDir("oms-guard-self-"));
    const denied = [
      tool("Write", { file_path: WRAPPER, content: "process.stdout.write('{}')" }),
      tool("Edit", { file_path: WRAPPER, old_string: "deny(", new_string: "allow(" }),
      tool("Write", { file_path: path.join(REPO_ROOT, "dist", "cli", "oms.js"), content: "" }),
      tool("MultiEdit", { file_path: path.join(REPO_ROOT, "package.json"), edits: [{ old_string: "a", new_string: "b" }] }),
      tool("NotebookEdit", { notebook_path: path.join(REPO_ROOT, "assets", "x.ipynb"), new_source: "x" }),
    ];
    for (const payload of denied) {
      expect(run(payload, { home }).reason).toBe(CONTROL_DENY);
    }
    expect(run(tool("Read", { file_path: WRAPPER }), { home }).decision).toBe("allow");
    expect(run(tool("Write", { file_path: path.join(home, "note.md"), content: "x" }), { home }).decision).toBe("allow");
  });

  it("denies writes into the oms package that PATH resolves", () => {
    const home = realpathSync(tempDir("oms-guard-path-home-"));
    const dir = realpathSync(tempDir("oms-guard-path-pkg-"));
    const hooks = path.join(dir, "hooks");
    const packageRoot = path.join(dir, "lib", "oh-my-second-brain");
    const bin = path.join(dir, "bin");
    mkdirSync(hooks, { recursive: true });
    mkdirSync(path.join(packageRoot, "dist", "cli"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    copyFileSync(WRAPPER, path.join(hooks, "oms-guard.mjs"));
    writeFileSync(path.join(packageRoot, "dist", "cli", "oms.js"), "");
    symlinkSync(path.join(packageRoot, "dist", "cli", "oms.js"), path.join(bin, "oms"));
    const options = { home, wrapper: path.join(hooks, "oms-guard.mjs"), pathEnv: bin };
    expect(run(tool("Write", { file_path: path.join(packageRoot, "dist", "cli", "oms.js"), content: "" }), options).reason).toBe(CONTROL_DENY);
    expect(run(tool("Write", { file_path: path.join(hooks, "oms-guard.mjs"), content: "" }), options).reason).toBe(CONTROL_DENY);
    expect(run(tool("Write", { file_path: path.join(packageRoot, "README.md"), content: "" }), options).decision).toBe("allow");
  });

  it("denies a target it cannot resolve inside a vault and warns outside one", async () => {
    const { vault, home, base } = await row("never-sealed");
    const lockedInVault = path.join(vault, "locked");
    const lockedOutside = path.join(base, "locked");
    mkdirSync(path.join(lockedInVault, "inner"), { recursive: true });
    mkdirSync(path.join(lockedOutside, "inner"), { recursive: true });
    chmodSync(lockedInVault, 0o000);
    chmodSync(lockedOutside, 0o000);
    try {
      expect(run(tool("Write", { file_path: path.join(lockedInVault, "inner", "a.md"), content: GOOD }), { vault, home }).reason).toBe(UNSAFE_DENY);
      const outside = run(tool("Write", { file_path: path.join(lockedOutside, "inner", "a.md"), content: GOOD }), { vault, home });
      expect(outside).toMatchObject({ decision: "allow", stderr: "[oms] guard could not resolve the target; allowed.\n" });
    } finally {
      chmodSync(lockedInVault, 0o755);
      chmodSync(lockedOutside, 0o755);
    }
  });

  it("routes MultiEdit and NotebookEdit and accepts lowercase names", async () => {
    const { vault, home } = await row("sealed");
    mkdirSync(path.join(vault, "Projects"), { recursive: true });
    writeFileSync(path.join(vault, "Projects", "a.md"), GOOD);
    const note = path.join(vault, "Projects", "a.md");
    expect(run(tool("MultiEdit", { file_path: note, edits: [{ old_string: "status: open", new_string: "status: maybe" }] }), { vault, home }).decision).toBe("deny");
    expect(run(tool("write", { file_path: note, content: BAD }), { vault, home }).decision).toBe("deny");
    expect(run(tool("NotebookEdit", { notebook_path: path.join(vault, "Projects", "a.ipynb"), new_source: "x" }), { vault, home }).decision).toBe("allow");
    expect(run(tool("NotebookEdit", { notebook_path: path.join(vault, ".oms", "x.ipynb"), new_source: "x" }), { vault, home }).reason).toBe(CONTROL_DENY);
  });

  it("denies a write to the store index", async () => {
    const { vault, home } = await row("sealed");
    expect(run(tool("Write", { file_path: path.join(home, ".oms", "vaults", "index.json"), content: "{}" }), { vault, home }).reason).toBe(CONTROL_DENY);
  });

  it("routes through symlinked vault and target spellings", async () => {
    const { vault, home, base } = await row("sealed");
    const alias = path.join(base, "vault-alias");
    symlinkSync(vault, alias);
    expect(run(tool("Write", { file_path: path.join(vault, "Projects", "a.md"), content: BAD }), { vault: alias, home }).decision).toBe("deny");
    expect(run(tool("Write", { file_path: path.join(alias, "Projects", "a.md"), content: BAD }), { vault, home }).decision).toBe("deny");
    expect(run(tool("Write", { file_path: "Projects/a.md", content: BAD }, alias), { vault, home }).decision).toBe("deny");

    const tmpVault = tempDir("oms-guard-tmp-", "/tmp");
    const realVault = realpathSync(tmpVault);
    expect(run(tool("Write", { file_path: path.join(realVault, ".oms", "settings.json"), content: "{}" }), { vault: tmpVault, home }).reason).toBe(CONTROL_DENY);
    expect(run(tool("Write", { file_path: path.join(tmpVault, ".oms", "settings.json"), content: "{}" }), { vault: realVault, home }).reason).toBe(CONTROL_DENY);
  });
});

describe("oms-guard wrapper transport failures", () => {
  function detachedWrapper(script: string | null): { wrapper: string; pathEnv: string } {
    const dir = realpathSync(tempDir("oms-guard-detached-"));
    const hooks = path.join(dir, "hooks");
    const bin = path.join(dir, "bin");
    mkdirSync(hooks, { recursive: true });
    mkdirSync(bin, { recursive: true });
    copyFileSync(WRAPPER, path.join(hooks, "oms-guard.mjs"));
    if (script !== null) {
      writeFileSync(path.join(bin, "oms"), script);
      chmodSync(path.join(bin, "oms"), 0o755);
    }
    return { wrapper: path.join(hooks, "oms-guard.mjs"), pathEnv: bin };
  }

  const failures: Array<[string, string | null, string]> = [
    ["no oms on PATH", null, "spawn-failed"],
    ["a judge that prints something other than JSON", "#!/bin/sh\necho not-json\n", "malformed-output"],
  ];
  for (const [label, script, kind] of failures) {
    for (const name of ["sealed", "never-sealed"] as const) {
      it(`allows with one warning and one guard event on ${label} (${name})`, async () => {
        const { vault, home } = await row(name);
        const detached = detachedWrapper(script);
        const result = run(tool("Write", { file_path: path.join(vault, "Projects", "a.md"), content: BAD }), { vault, home, ...detached });
        expect(result).toMatchObject({ decision: "allow", stderr: WARNING });
        expect(guardEvents(home)).toEqual([kind]);
      });
    }

    it(`never reaches the judge for a target outside the vault (${label})`, async () => {
      const { vault, home, base } = await row("sealed");
      const detached = detachedWrapper(script);
      const result = run(tool("Write", { file_path: path.join(base, "elsewhere.md"), content: BAD }), { vault, home, ...detached });
      expect(result).toMatchObject({ decision: "allow", stderr: "" });
      expect(guardEvents(home)).toEqual([]);
    });
  }

  it("allows with one warning and one guard event when the judge times out", async () => {
    const { vault, home } = await row("sealed");
    const detached = detachedWrapper("#!/bin/sh\nexec /bin/sleep 30\n");
    const result = run(tool("Write", { file_path: path.join(vault, "Projects", "a.md"), content: BAD }), { vault, home, ...detached });
    expect(result).toMatchObject({ decision: "allow", stderr: WARNING });
    expect(guardEvents(home)).toEqual(["timeout"]);
  }, 30000);

  it("allows unparseable input with one warning", async () => {
    const { vault, home } = await row("sealed");
    const result = run("{not json", { vault, home });
    expect(result.decision).toBe("allow");
    expect(result.stderr).toMatch(/^\[oms\] .*\n$/);
  });

  it("denies unparseable input that names a vault or the control store", async () => {
    const { vault, home } = await row("sealed");
    const escaped = JSON.stringify(path.join(vault, "Projects", "a.md")).slice(1, -1).replaceAll("/", "\\/");
    const payloads = [
      `{"tool_name":"Write","tool_input":{"file_path":"${path.join(vault, "Projects", "a.md")}"`,
      `{"tool_name":"Write","tool_input":{"file_path":"${escaped}"`,
      '{"tool_name":"Read","tool_input":{"file_path":"~/.oms/vaults/index.json"',
      `{"tool_name":"Read","tool_input":{"file_path":"${path.join(home, ".oms", "vaults")}"`,
    ];
    for (const payload of payloads) {
      expect(run(payload, { vault, home })).toMatchObject({ decision: "deny", reason: INPUT_DENY, stderr: "" });
    }
  });

  it("treats a payload past the stdin cap as unparseable", async () => {
    const { vault, home, base } = await row("never-sealed");
    const filler = "x".repeat(9 * 1024 * 1024);
    const inside = run(tool("Write", { file_path: path.join(vault, "a.md"), content: filler }), { vault, home });
    expect(inside).toMatchObject({ decision: "deny", reason: INPUT_DENY });
    const outside = run(tool("Write", { file_path: path.join(base, "elsewhere.md"), content: filler }), { vault, home });
    expect(outside.decision).toBe("allow");
    expect(outside.stderr).toMatch(/^\[oms\] .*\n$/);
  });

  it("forwards only [oms] lines of the judge's stderr", async () => {
    const { vault, home } = await row("sealed");
    const dir = realpathSync(tempDir("oms-guard-stderr-"));
    const hooks = path.join(dir, "hooks");
    const bin = path.join(dir, "bin");
    mkdirSync(hooks, { recursive: true });
    mkdirSync(bin, { recursive: true });
    copyFileSync(WRAPPER, path.join(hooks, "oms-guard.mjs"));
    writeFileSync(path.join(bin, "oms"), `#!/bin/sh\ncat >/dev/null\necho "leak ${vault}" >&2\necho "[oms] notice" >&2\necho '{"continue":true,"suppressOutput":true}'\n`);
    chmodSync(path.join(bin, "oms"), 0o755);
    const result = run(tool("Write", { file_path: path.join(vault, "Projects", "a.md"), content: GOOD }), { vault, home, wrapper: path.join(hooks, "oms-guard.mjs"), pathEnv: `${bin}:/bin:/usr/bin` });
    expect(result).toMatchObject({ decision: "allow", stderr: "[oms] notice\n" });
  });
});
