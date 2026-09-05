import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, realpath, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { mainUsageCommandNames } from "./usage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

// This suite calls `runCli(["setup", ...])` without `--dry-run`. `oms setup`
// writes a stamp-only pointer and host state under `$HOME` - e.g.
// `--install-claude` wires hook entries into
// `$HOME/.claude/settings.json` (see upsertClaudeHooks in
// src/vendors/claude/claude-hooks.ts) - so the isolation below is load-bearing
// today, not merely precautionary. Every runCli() call gets HOME/USERPROFILE
// pointed at `smokeHome` (a throwaway directory, see beforeAll below) instead
// of the real inherited one, so a command that writes host state cannot
// reach the real developer's home directory no matter which command a future
// test exercises. USERPROFILE is set alongside HOME so the same isolation
// holds on Windows, where os.homedir() reads USERPROFILE instead.
let smokeHome = "";

const realOmsDir = path.join(homedir(), ".oms");

// Metadata-only (size + mtime, not content) recursive snapshot, used to prove
// this suite never touches the real home directory. Reading full file
// content would be correct too, but `~/.oms` can hold a large downloaded
// embedding model, and hashing that on every test run would make the suite
// needlessly slow; size + mtime already changes on any write a real CLI
// invocation could make.
function snapshotDir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const entries: string[] = [];
  const walk = (current: string, rel: string) => {
    for (const name of readdirSync(current).sort()) {
      const absChild = path.join(current, name);
      const relChild = rel === "" ? name : `${rel}/${name}`;
      const st = statSync(absChild);
      if (st.isDirectory()) {
        entries.push(`${relChild}/`);
        walk(absChild, relChild);
      } else {
        entries.push(`${relChild}:${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(dir, "");
  return entries.join("\n");
}

let realOmsBefore: string | null = null;
let tempRoots: string[] = [];

beforeAll(async () => {
  realOmsBefore = snapshotDir(realOmsDir);
  smokeHome = await mkdtemp(path.join(tmpdir(), "oms-cli-dispatch-home-"));
});

afterAll(async () => {
  // The whole point of smokeHome: prove the real HOME's `.oms` directory was
  // never touched by any runCli() call above, however many ran. No `.oms`
  // before must mean no `.oms` after; an existing one must be byte-identical
  // (per the snapshotDir metadata comparison above).
  expect(snapshotDir(realOmsDir)).toBe(realOmsBefore);
  if (smokeHome) await rm(smokeHome, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
  await rm(smokeHome, { recursive: true, force: true });
  await mkdir(smokeHome, { recursive: true });
});

async function makeVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-cli-dispatch-"));
  tempRoots.push(vault);
  return vault;
}

async function approvedSetup(vault: string): Promise<ReturnType<typeof runCli>> {
  await mkdir(path.join(vault, ".obsidian"), { recursive: true });
  await mkdir(path.join(vault, ".oms"), { recursive: true });
  await mkdir(path.join(vault, "Templates"), { recursive: true });
  await writeFile(path.join(vault, ".obsidian", "types.json"), JSON.stringify({ types: { template: "text", title: "text" } }));
  await writeFile(path.join(vault, ".oms", "taxonomy.json"), JSON.stringify({
    folders: {},
    templates: { note: { templateFolder: "notes" } },
  }));
  await writeFile(
    path.join(vault, "Templates", "note.md"),
    "---\ntemplate: note\ntitle: Untitled\n---\n<!-- oms:content -->\n",
  );
  const dryRun = runCli(["setup", "--vault", vault, "--template-folder", "Templates", "--dry-run"]);
  expect(dryRun.status).toBe(0);
  expect(existsSync(path.join(vault, ".oms", "template-policy.json"))).toBe(false);
  const match = /"approvalDigest":\s*"(sha256:[0-9a-f]{64})"/u.exec(dryRun.stdout);
  expect(match?.[1]).toBeDefined();
  return runCli(["setup", "--vault", vault, "--template-folder", "Templates", "--yes", "--approved-digest", match![1]!]);
}

function runCli(
  args: readonly string[],
  input?: string,
  env?: Readonly<Record<string, string | undefined>>,
  cwd = repoRoot,
) {
  if (!existsSync(distCli)) {
    throw new Error("dist/cli/oms.js is missing; run npm run build before CLI dispatch tests.");
  }
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd,
    env: {
      ...process.env,
      OMS_UPDATE_NOTICE: "0",
      OMS_NO_UPDATE_NOTICE: "1",
      HOME: smokeHome,
      USERPROFILE: smokeHome,
      XDG_CONFIG_HOME: path.join(smokeHome, ".config"),
      XDG_CACHE_HOME: path.join(smokeHome, ".cache"),
      ...env,
    },
    input,
    encoding: "utf-8",
  });
}

function jsonObject(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected JSON object stdout.");
  }
  return parsed;
}

describe("oms CLI dispatch", () => {
  it("prints usage and exits 0 when no command is provided", () => {
    const result = runCli([]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("Compatibility alias: oms <command>");
    for (const command of ["setup", "template", "note", "link", "bridge", "search", "index", "graph", "host", "package", "model", "serve", "hook", "status"]) {
      expect(result.stdout).toContain(command);
    }
    expect(result.stdout).not.toMatch(/semantic/u);
  });

  it.each([
    { command: [] },
    ...mainUsageCommandNames().map((command) => ({ command: [command] })),
  ])("prints usage without side effects for $command --help", async ({ command }) => {
    const vault = await makeVault();
    const beforeVault = snapshotDir(vault);
    const beforeHome = snapshotDir(smokeHome);
    const result = runCli([...command, "--help", "--vault", vault]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/Usage:|OMS search and index:/u);
    expect(result.stdout).not.toContain("Update available");
    expect(snapshotDir(vault)).toBe(beforeVault);
    expect(snapshotDir(smokeHome)).toBe(beforeHome);
  });

  it("prints usage for -h without side effects", async () => {
    const vault = await makeVault();
    const beforeVault = snapshotDir(vault);
    const result = runCli(["-h", "--vault", vault]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(snapshotDir(vault)).toBe(beforeVault);
  });

  it("rejects an unknown command even when help is requested", () => {
    const result = runCli(["setpu", "--help"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[oms] Unknown command: setpu");
  });

  it.each([
    ["doctor", "oms template check"],
    ["audit", "oms note audit"],
    ["reconcile", "oms host sync"],
    ["linkify", "oms link suggest"],
    ["embed", "oms index embed"],
    ["doc", "oms note get"],
    ["mcp", "oms serve mcp"],
    ["lint", "oms link check"],
    ["install", "oms host install"],
    ["uninstall", "oms host remove"],
    ["update", "oms package update"],
  ])("rejects retired %s with actionable guidance", (command, guidance) => {
    const result = runCli([command]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Command \`${command}\` is retired`);
    expect(result.stderr).toContain(guidance);
  });

  it("reports unknown hook subcommand with exit code 1", () => {
    const result = runCli(["hook"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[oms] Usage: oms hook <pre|post> [--vault <path>]");
  });

  it("routes the pre hook and preserves bypass output", async () => {
    const vault = await makeVault();
    const result = runCli(["hook", "pre", "--vault", vault], "{}\n", { OMS_GUARD: "off" });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("{\"continue\":true,\"suppressOutput\":true}\n");
  });

  it("routes the post hook and rejects retired hook leaf names", async () => {
    const vault = await makeVault();
    const post = runCli(["hook", "post", "--vault", vault], "{}\n", { OMS_GUARD: "off" });
    const retired = runCli(["hook", "post-tool-use", "--vault", vault], "{}\n");

    expect(post.status).toBe(0);
    expect(post.stderr).toBe("");
    expect(post.stdout).toBe("");
    expect(retired.status).toBe(1);
    expect(retired.stderr).toContain("Use `oms hook post`");
  });

  it("rejects unsupported runtime before host operations", () => {
    const result = runCli(["host", "install", "--runtime", "banana", "--dry-run"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("unsupported runtime banana");
  });

  it("rejects unsupported package options in the package handler", () => {
    const result = runCli(["package", "update", "--bogus", "--dry-run"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unsupported package option: --bogus");
  });

  it("does not print an update notice after blocked setup", async () => {
    const vault = await makeVault();
    await mkdir(path.join(vault, ".obsidian"), { recursive: true });
    await writeFile(path.join(vault, ".obsidian", "types.json"), JSON.stringify({ types: { title: "text" } }));
    await mkdir(path.join(vault, "Notes"), { recursive: true });
    await writeFile(path.join(vault, "Notes", "broken.md"), "---\ntitle: [unterminated\n---\n");

    const result = runCli(
      ["setup", "--vault", vault, "--template-folder", "Templates", "--yes", "--approved-digest", `sha256:${"0".repeat(64)}`],
      undefined,
      {
        OMS_UPDATE_NOTICE: "1",
        OMS_NO_UPDATE_NOTICE: "0",
        OMS_UPDATE_LATEST_VERSION: "99.0.0",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"status": "blocked"');
    expect(result.stderr).not.toContain("Update available");
  });

  it("routes template and link diagnostics for an empty temp vault", async () => {
    const vault = await makeVault();
    const doctor = runCli(["template", "check", "--vault", vault]);
    const lint = runCli(["link", "check", "--vault", vault, "--json"]);

    expect(doctor.status).toBe(0);
    expect(doctor.stderr).toBe("");
    expect(jsonObject(doctor.stdout)).toEqual(
      expect.objectContaining({
        vault,
        status: "needs-repair",
        migrationMarker: "absent",
        unresolvedLegacyNotes: [],
      }),
    );

    expect(lint.status).toBe(0);
    expect(lint.stderr).toBe("");
    expect(jsonObject(lint.stdout)).toEqual(
      expect.objectContaining({
        totalNotes: 0,
        brokenLinks: [],
        orphanPaths: [],
      }),
    );
  });

  it("keeps a YAML-only taxonomy untouched and blocks setup without JSON authority", async () => {
    const vault = await makeVault();
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    const yaml = "this: [is not valid YAML\n";
    await writeFile(path.join(vault, ".oms", "taxonomy.yaml"), yaml);

    const doctor = runCli(["template", "check", "--vault", vault]);
    expect(doctor.status).toBe(0);
    expect(doctor.stderr).toBe("");
    expect(jsonObject(doctor.stdout)).toEqual(expect.objectContaining({
      vault,
      status: "needs-repair",
      diagnostics: [expect.objectContaining({
        code: "TEMPLATE_CONTROL_MISSING",
        path: ".oms/taxonomy.json",
      })],
    }));
    expect(doctor.stdout).not.toContain("LEGACY_TAXONOMY_YAML");
    expect(existsSync(path.join(vault, ".oms", "taxonomy.json"))).toBe(false);
    await expect(readFile(path.join(vault, ".oms", "taxonomy.yaml"), "utf8")).resolves.toBe(yaml);

    await mkdir(path.join(vault, ".obsidian"), { recursive: true });
    await writeFile(path.join(vault, ".obsidian", "types.json"), JSON.stringify({ types: { template: "text" } }));
    await mkdir(path.join(vault, "Templates"), { recursive: true });
    await writeFile(path.join(vault, "Templates", "note.md"), "---\ntemplate: note\n---\nbody\n");
    const dryRun = runCli(["setup", "--vault", vault, "--template-folder", "Templates", "--dry-run"]);
    expect(dryRun.status).toBe(1);
    expect(dryRun.stdout).toContain("TEMPLATE_PLACEMENT_UNDECLARED");
    expect(dryRun.stdout).not.toContain("approvalDigest");
    expect(existsSync(path.join(vault, ".oms", "taxonomy.json"))).toBe(false);
    await expect(readFile(path.join(vault, ".oms", "taxonomy.yaml"), "utf8")).resolves.toBe(yaml);
  });

  it("uses JSON-only taxonomy authority, leaves legacy YAML untouched, and blocks missing placement", async () => {
    const vault = await makeVault();
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    const yaml = "folders: {}\n";
    const json = "{\"folders\":{}}\n";
    await writeFile(path.join(vault, ".oms", "taxonomy.yaml"), yaml);
    await writeFile(path.join(vault, ".oms", "taxonomy.json"), json);

    const doctor = runCli(["template", "check", "--vault", vault]);
    expect(doctor.status).toBe(0);
    expect(jsonObject(doctor.stdout)).toEqual(expect.objectContaining({
      vault,
      status: "needs-repair",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "ENOENT",
          path: ".oms/template-policy.json",
        }),
        expect.objectContaining({
          code: "ENOENT",
          path: ".oms/types.json",
        }),
      ]),
    }));
    expect(doctor.stdout).not.toContain("LEGACY_TAXONOMY_YAML");

    await mkdir(path.join(vault, ".obsidian"), { recursive: true });
    await mkdir(path.join(vault, "Templates"), { recursive: true });
    await writeFile(path.join(vault, ".obsidian", "types.json"), JSON.stringify({ types: { template: "text" } }));
    await writeFile(path.join(vault, "Templates", "note.md"), "---\ntemplate: note\n---\nbody\n");
    const setup = runCli(["setup", "--vault", vault, "--template-folder", "Templates", "--dry-run"]);
    expect(setup.status).toBe(1);
    expect(setup.stdout).toContain("TEMPLATE_PLACEMENT_UNDECLARED");
    expect(setup.stdout).not.toContain("approvalDigest");
    expect(existsSync(path.join(vault, ".oms", "taxonomy.json"))).toBe(true);
    expect(existsSync(path.join(vault, ".oms", "taxonomy.yaml"))).toBe(true);
    await expect(readFile(path.join(vault, ".oms", "taxonomy.json"), "utf8")).resolves.toBe(json);
    await expect(readFile(path.join(vault, ".oms", "taxonomy.yaml"), "utf8")).resolves.toBe(yaml);
  });

  it("emits audit JSON and exits 0 for a clean template fixture folder", async () => {
    const vault = await makeVault();
    await mkdir(path.join(vault, "Templates"), { recursive: true });
    await writeFile(path.join(vault, "Templates", "note.md"), "---\ntemplate: note\ntitle: Untitled\n---\n<!-- oms:content -->\n");
    expect((await approvedSetup(vault)).status).toBe(0);
    await mkdir(path.join(vault, "notes"), { recursive: true });
    await writeFile(path.join(vault, "notes", "Alpha.md"), "---\ntemplate: note\ntitle: Alpha\n---\nAlpha.\n");
    const audit = runCli(["note", "audit", "--vault", vault, "--folder", "notes", "--json"]);
    expect(audit.status).toBe(0);
    expect(audit.stderr).toBe("");
    expect(jsonObject(audit.stdout)).toEqual(expect.objectContaining({ folder: "notes", scannedNotes: 1, clean: true, templateCounts: { note: 1 } }));
  });

  it("G002-CLI-001 rejects audit folder scopes that are not top-level folders", async () => {
    const fixtureVault = await makeVault();
    const audit = runCli(["note", "audit", "--vault", fixtureVault, "--folder", "references/missing", "--json"]);

    expect(audit.status).toBe(1);
    expect(audit.stdout).toBe("");
    expect(audit.stderr).toContain("path separators");
  });

  it("reports incomplete local .oms during audit instead of falling back to bundled defaults", async () => {
    const vault = await makeVault();
    await mkdir(path.join(vault, ".oms"), { recursive: true });

    const audit = runCli(["note", "audit", "--vault", vault, "--json"]);

    expect(audit.status).toBe(1);
    expect(audit.stdout).toBe("");
    expect(audit.stderr).toContain("TEMPLATE_SOURCE_INVALID");
    expect(audit.stderr).not.toContain("bundled");
  });

  it("dispatches index status and rejects retired command names", async () => {
    const vault = await makeVault();
    // A never-synced vault has no disk store: status must say so with sync
    // guidance rather than reporting an ephemeral in-memory store as available.
    const missing = runCli(["index", "status", "--vault", vault]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("oms index sync");

    expect(runCli(["index", "sync", "--vault", vault]).status).toBe(0);
    const nested = runCli(["index", "status", "--vault", vault]);
    const alias = runCli(["semantic", "--vault", vault]);

    expect(nested.status).toBe(0);
    expect(nested.stdout).toContain('"available": true');
    expect(alias.status).toBe(1);
    expect(alias.stderr).toContain("[oms] Unknown command: semantic");
  });

  it.each(["query", "get", "multi-get", "vsearch", "collection", "context", "cleanup", "http"])(
    "rejects the retired top-level %s alias",
    async (command) => {
      const vault = await makeVault();
      const result = runCli([command, "--vault", vault]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`[oms] Unknown command: ${command}`);
    },
  );

  it("permits the top-level status command", async () => {
    const vault = await makeVault();
    const result = runCli(["status", "--vault", vault]);

    expect(result.stderr).not.toContain("[oms] Unknown command: status");
    expect(jsonObject(result.stdout)).toEqual(expect.objectContaining({ vault }));
  });

  it("permits index embed as a family leaf", async () => {
    const result = runCli(["index", "embed"]);

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("unknown index command");
  });

  it("creates a vault bridge and resolves diagnostics through it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-cli-link-"));
    tempRoots.push(root);
    const vault = path.join(root, "vault");
    const repo = path.join(root, "repo");
    await mkdir(path.join(vault, "notes"), { recursive: true });
    await mkdir(repo, { recursive: true });
    await writeFile(
      path.join(vault, "notes", "Alpha.md"),
      "# Alpha\n\nAlpha bridge lexical search should work immediately after link.\n",
      "utf-8",
    );

    const setup = await approvedSetup(vault);
    expect(setup.status).toBe(0);

    const link = runCli(["bridge", "add", "--vault", vault, "--folder", "notes"], undefined, undefined, repo);
    expect(link.status).toBe(0);
    expect(link.stderr).toBe("");
    expect(link.stdout).toContain("Oh My Second Brain vault bridge ready.");
    expect(link.stdout).toContain("Convention: wrote");

    const linkPath = path.join(repo, ".oms", "linked", "notes");
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(linkPath), await readlink(linkPath))).toBe(path.join(vault, "notes"));
    expect(await readFile(path.join(repo, ".gitignore"), "utf-8")).toContain(".oms/linked/");
    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf-8");
    expect(agents).toContain("<!-- oms:begin -->");
    expect(agents).toContain(`- Connected vault: ${path.basename(vault)}`);
    expect(agents).not.toContain(vault);
    expect(agents).toContain("`oms search query \"what context should I know for this change?\"`");
    expect(agents).toContain("`oms serve mcp`");

    const doctor = runCli(["template", "check"], undefined, undefined, repo);
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain('"status":');
    const search = runCli(["search", "query", "--lex", "Alpha"], undefined, undefined, repo);
    expect(search.status).toBe(0);
    expect(search.stderr).toBe("");
    const searchJson = jsonObject(search.stdout);
    expect(searchJson).toEqual(expect.objectContaining({ available: true }));
    expect(searchJson.hits).toEqual([
      expect.objectContaining({ path: "notes/Alpha.md" }),
    ]);
  });

  it("routes link suggestion without touching the vault and applies approved candidates", async () => {
    const vault = await makeVault();
    await mkdir(path.join(vault, "Templates"), { recursive: true });
    await writeFile(path.join(vault, "Templates", "note.md"), "---\ntemplate: note\ntitle: Untitled\n---\n<!-- oms:content -->\n");
    expect((await approvedSetup(vault)).status).toBe(0);
    await mkdir(path.join(vault, "terms"), { recursive: true });
    await mkdir(path.join(vault, "notes"), { recursive: true });
    await writeFile(path.join(vault, "terms", "Ataraxia.md"), "---\ntemplate: note\ntitle: Ataraxia\n---\n\nCalm.\n", "utf-8");
    const notePath = path.join(vault, "notes", "Sage.md");
    await writeFile(notePath, "---\ntemplate: note\ntitle: Sage\n---\n\nThe sage pursues Ataraxia daily.\n", "utf-8");
    const before = await readFile(notePath, "utf-8");

    const report = runCli(["link", "suggest", "notes/Sage.md", "--vault", vault, "--json"]);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("notes/Sage.md");
    const proposal = jsonObject(report.stdout) as {
      baseContentHash: string;
      candidates: Array<{ id: string; renderedReplacement: string }>;
    };
    expect(proposal.candidates[0]?.renderedReplacement).toBe("[[Ataraxia]]");
    expect(await readFile(notePath, "utf-8")).toBe(before);

    const applied = runCli([
      "link", "apply", "notes/Sage.md", "--vault", vault,
      "--base-content-hash", proposal.baseContentHash,
      "--candidate-id", proposal.candidates[0]!.id,
      "--yes",
    ]);
    expect(applied.status).toBe(0);
    const after = await readFile(notePath, "utf-8");
    expect(after).toContain("[[Ataraxia]]");
    expect(after).not.toBe(before);
  });

  it("routes host sync dry-run through the scoped Claude cleanup plan", async () => {
    const vault = await makeVault();
    const result = runCli(["host", "sync", "--runtime", "claude", "--vault", vault, "--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("claude mcp remove oms --scope local");
    expect(result.stdout).toContain("claude mcp remove oms --scope project");
    expect(result.stdout).toContain("claude mcp remove oms --scope user");
  });

  it("routes host remove through the host family", async () => {
    const result = runCli(["host", "remove", "--runtime", "claude", "--dry-run", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(jsonObject(result.stdout)).toEqual(expect.objectContaining({ dryRun: true }));
  });

  it("given installed vault A moved away, when all hosts install B, then the signed pointer and stamps contain only B", async () => {
    const first = await makeVault();
    const second = await makeVault();
    expect(runCli(["host", "install", "--runtime", "all", "--vault", first, "--yes", "--json"]).status).toBe(0);
    const canonicalFirst = await realpath(first);
    await rm(first, { recursive: true });
    expect(runCli(["host", "install", "--runtime", "all", "--vault", second, "--yes", "--json"]).status).toBe(0);
    const canonicalSecond = await realpath(second);
    const pointer = JSON.parse(
      await readFile(path.join(smokeHome, ".config", "oms", "vault.json"), "utf-8"),
    ) as { readonly vault: string; readonly signature: string };
    expect(pointer.vault).toBe(canonicalSecond);
    expect(pointer.signature).toMatch(/^[0-9a-f]{64}$/u);
    for (const config of [
      await readFile(path.join(smokeHome, ".claude.json"), "utf-8"),
      await readFile(path.join(smokeHome, ".codex", "config.toml"), "utf-8"),
    ]) {
      expect(config).toContain(canonicalSecond);
      expect(config).not.toContain(canonicalFirst);
    }
    const hermes = parse(
      await readFile(path.join(smokeHome, ".hermes", "config.yaml"), "utf-8"),
    ) as { readonly mcp_servers: { readonly oms: { readonly args: readonly string[] } } };
    expect(hermes.mcp_servers.oms.args).toEqual(["serve", "mcp", "--vault", canonicalSecond]);
    expect(existsSync(path.join(smokeHome, ".oms"))).toBe(false);
  });

  it("returns stable cleanup fields for host JSON output", async () => {
    const vault = await makeVault();
    const result = runCli(["host", "install", "--runtime", "claude", "--vault", vault, "--dry-run", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = jsonObject(result.stdout) as {
      dryRun: boolean;
      results: Array<{ cleanup: unknown[]; messages: string[] }>;
    };
    expect(output.dryRun).toBe(true);
    expect(output.results[0]?.cleanup).toEqual([]);
    expect(output.results[0]?.messages.join(" ")).toContain("scope local");
  });
});
