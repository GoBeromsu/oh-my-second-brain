import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBridgeCommand } from "./link-command.js";

import { readProjectConnection } from "../kernel/install/project-connection.js";
import { readConnectionRegistry } from "../kernel/install/connection-registry.js";

let roots: string[] = [];
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalRuntimeRoot = process.env.OMS_RUNTIME_ROOT;

const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
  if (originalRuntimeRoot === undefined) delete process.env.OMS_RUNTIME_ROOT;
  else process.env.OMS_RUNTIME_ROOT = originalRuntimeRoot;

  process.exitCode = undefined;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

async function root(prefix: string): Promise<string> {
  const value = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(value);
  return value;
}

async function capture(run: () => Promise<void>): Promise<{ out: string; err: string; code: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...values: unknown[]) => out.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => err.push(values.map(String).join(" "));
  process.exitCode = undefined;
  try {
    await run();
    return { out: out.join("\n"), err: err.join("\n"), code: process.exitCode as number | undefined };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("bridge family", () => {
  it("adds, reports, and removes a repository bridge without touching vault notes", async () => {
    const repo = await root("oms-bridge-repo-");
    const vault = await root("oms-bridge-vault-");
    await mkdir(path.join(vault, "notes"));
    await writeFile(path.join(vault, "notes", "kept.md"), "keep me\n", "utf8");
    process.chdir(repo);

    const added = await capture(() => runBridgeCommand(["add", "--vault", vault, "--folder", "notes", "--no-convention-note"]));
    expect(added.code).toBe(0);
    const canonicalVault = await realpath(vault);
    const bridgeBytes = await readFile(path.join(repo, ".oms", "links.yaml"), "utf8");
    const reference = (await readProjectConnection(await realpath(repo))).reference;
    const settings = JSON.parse(await readFile(path.join(vault, ".oms", "settings.json"), "utf8"));
    expect(reference).toMatchObject({ version: 2, portableVaultId: settings.vaultId, scope: ["notes"] });
    expect(reference?.connectionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bridgeBytes).not.toContain(vault);
    expect(bridgeBytes).not.toContain(canonicalVault);
    expect(await realpath(path.join(repo, ".oms", "linked", "notes"))).toBe(path.join(canonicalVault, "notes"));

    const status = await capture(() => runBridgeCommand(["status", "--json"]));
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out)).toMatchObject({ state: "linked", vault: canonicalVault, scope: ["notes"], links: [{ folder: "notes", state: "linked" }] });

    const removed = await capture(() => runBridgeCommand(["remove", "--yes", "--json"]));
    expect(removed.code).toBe(0);
    await expect(readFile(path.join(repo, ".oms", "links.yaml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(vault, "notes", "kept.md"), "utf8")).toBe("keep me\n");
  });

  it("status is read-only and does not create bridge files", async () => {
    const repo = await root("oms-bridge-empty-");
    process.chdir(repo);
    const status = await capture(() => runBridgeCommand(["status", "--json"]));
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out)).toMatchObject({ state: "not-linked" });
    await expect(readFile(path.join(repo, ".oms", "links.yaml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses removal when the projection directory has an unowned file", async () => {
    const repo = await root("oms-bridge-owned-");
    const vault = await root("oms-bridge-owned-vault-");
    await mkdir(path.join(vault, "notes"));
    await writeFile(path.join(vault, "notes", "kept.md"), "keep me\n", "utf8");
    process.chdir(repo);
    expect((await capture(() => runBridgeCommand(["add", "--vault", vault, "--folder", "notes", "--no-convention-note"]))).code).toBe(0);
    const extra = path.join(repo, ".oms", "linked", "keep");
    await writeFile(extra, "user file\n", "utf8");
    await symlink(path.join(repo, "elsewhere"), path.join(repo, ".oms", "linked", "other"), "dir");
    const record = await readFile(path.join(repo, ".oms", "links.yaml"));
    const declared = await lstat(path.join(repo, ".oms", "linked", "notes"));
    const registryBefore = await readConnectionRegistry();
    const removed = await capture(() => runBridgeCommand(["remove", "--yes", "--json"]));
    expect(removed.code).toBe(1);
    expect(removed.err).toContain("outside the declared v2 scope");
    expect(await readFile(path.join(repo, ".oms", "links.yaml"))).toEqual(record);
    expect((await lstat(path.join(repo, ".oms", "linked", "notes"))).ino).toBe(declared.ino);
    expect(await readFile(extra, "utf8")).toBe("user file\n");
    expect(await readFile(path.join(vault, "notes", "kept.md"), "utf8")).toBe("keep me\n");
    expect(await readConnectionRegistry()).toEqual(registryBefore);
  });
});
describe("bridge failure formatting", () => {
  it("prints the actual global block code and reason and preserves the malformed registry", async () => {
    const home = await root("oms-bridge-bad-registry-");
    const repo = path.join(home, "repo");
    const vault = path.join(home, "vault");
    const corrupt = "{not-json\n";
    await mkdir(path.join(vault, "notes"), { recursive: true });
    await mkdir(repo);
    await mkdir(path.join(home, ".config", "oms"), { recursive: true });
    await writeFile(path.join(home, ".config", "oms", "vault.json"), corrupt, "utf8");
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.OMS_RUNTIME_ROOT = path.join(home, ".oms", "runtime", "v1");
    process.chdir(repo);

    const added = await capture(() => runBridgeCommand(["add", "--vault", vault, "--folder", "notes", "--no-convention-note"]));

    expect(added.code).toBe(1);
    expect(added.err).toContain("Vault publication: complete");
    expect(added.err).toContain("Global registration: blocked");
    expect(added.err).toContain("Project reference: unattempted");
    expect(added.err).toContain("Global registration: registry-blocked: ");
    expect(added.err).toContain("Connection registry is malformed:");
    expect(added.err).not.toContain("Project reference: project-blocked");
    expect(await readFile(path.join(home, ".config", "oms", "vault.json"), "utf8")).toBe(corrupt);
    expect(await readFile(path.join(vault, ".oms", "settings.json"), "utf8")).toContain("\"vaultId\"");
  });

  it("refuses malformed vault settings before publication or registration", async () => {
    const home = await root("oms-bridge-vault-blocked-");
    const repo = path.join(home, "repo");
    const vault = path.join(home, "vault");
    const malformed = "{not json\n";
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    await mkdir(path.join(vault, "notes"));
    await mkdir(repo);
    await writeFile(path.join(vault, ".oms", "settings.json"), malformed, "utf8");
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.OMS_RUNTIME_ROOT = path.join(home, ".oms", "runtime", "v1");
    process.chdir(repo);

    const added = await capture(() => runBridgeCommand(["add", "--vault", vault, "--folder", "notes", "--no-convention-note"]));

    expect(added.code).toBe(1);
    expect(added.err).toContain("VAULT_SETTINGS_INVALID");
    expect(existsSync(path.join(home, ".config", "oms", "vault.json"))).toBe(false);
    expect((await readProjectConnection(await realpath(repo))).reference).toBeUndefined();
    expect(existsSync(path.join(repo, ".oms", "links.yaml"))).toBe(false);
    expect(await readFile(path.join(vault, ".oms", "settings.json"), "utf8")).toBe(malformed);
  });

});
