import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";
import {
  createVaultLink,
  ensureGitignore,
  expandHome,
  LINKED_GITIGNORE_PATTERN,
  LINK_RECORD_VERSION,
  readLinkRecord,
  resolveEffectiveVault,
  writeLinkRecord,
} from "./link.js";

let tmp: string;
let vault: string;
let repo: string;

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "oms-link-test-"));
  vault = path.join(tmp, "vault");
  repo = path.join(tmp, "repo");
  await mkdir(vault, { recursive: true });
  await mkdir(repo, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("expandHome", () => {
  it("expands a leading ~/ to the home directory", () => {
    expect(expandHome("~/Documents/vault")).toBe(path.resolve(os.homedir(), "Documents/vault"));
  });

  it("resolves a bare ~ to the home directory", () => {
    expect(expandHome("~")).toBe(os.homedir());
  });

  it("resolves a relative path to an absolute path", () => {
    expect(path.isAbsolute(expandHome("./some/where"))).toBe(true);
  });

  it("passes an absolute path through unchanged", () => {
    expect(expandHome("/opt/vaults/v")).toBe("/opt/vaults/v");
  });
});

describe("readLinkRecord / writeLinkRecord", () => {
  it("returns null when links.yaml is missing", async () => {
    expect(await readLinkRecord(path.join(repo, ".oms"))).toBeNull();
  });

  it("round-trips a record through disk", async () => {
    const omsDir = path.join(repo, ".oms");
    await writeLinkRecord(omsDir, { version: 1, vault, scope: ["notes", "references"] });
    const record = await readLinkRecord(omsDir);
    expect(record).toEqual({ version: 1, vault, scope: ["notes", "references"] });
  });

  it("throws when links.yaml is present but the vault field is absent", async () => {
    const omsDir = path.join(repo, ".oms");
    await mkdir(omsDir, { recursive: true });
    await writeFile(path.join(omsDir, "links.yaml"), "version: 1\nscope: [a]\n", "utf-8");
    await expect(readLinkRecord(omsDir)).rejects.toThrow(/missing required string field "vault"/);
  });

  it("defaults scope to an empty array and version to current", async () => {
    const omsDir = path.join(repo, ".oms");
    await mkdir(omsDir, { recursive: true });
    await writeFile(path.join(omsDir, "links.yaml"), `vault: ${vault}\n`, "utf-8");
    expect(await readLinkRecord(omsDir)).toEqual({
      version: LINK_RECORD_VERSION,
      vault,
      scope: [],
    });
  });
});

describe("ensureGitignore", () => {
  it("creates .gitignore with the pattern when absent", async () => {
    expect(await ensureGitignore(repo, LINKED_GITIGNORE_PATTERN)).toBe(true);
    const content = await readFile(path.join(repo, ".gitignore"), "utf-8");
    expect(content).toContain(LINKED_GITIGNORE_PATTERN);
  });

  it("appends the pattern to an existing .gitignore", async () => {
    await writeFile(path.join(repo, ".gitignore"), "node_modules\n", "utf-8");
    expect(await ensureGitignore(repo, LINKED_GITIGNORE_PATTERN)).toBe(true);
    const content = await readFile(path.join(repo, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules");
    expect(content).toContain(LINKED_GITIGNORE_PATTERN);
  });

  it("is idempotent when the pattern is already present", async () => {
    await ensureGitignore(repo, LINKED_GITIGNORE_PATTERN);
    expect(await ensureGitignore(repo, LINKED_GITIGNORE_PATTERN)).toBe(false);
  });
});

describe("resolveEffectiveVault", () => {
  it("treats a dir with .oms/template-policy.json as the vault itself", async () => {
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    await writeFile(path.join(vault, ".oms", "template-policy.json"), "{}\n");
    const resolved = await resolveEffectiveVault(vault, {});
    expect(resolved).toEqual({ vault: path.resolve(vault), scope: null, source: "vault" });
  });

  it("treats a dir with .oms/taxonomy.yaml as the vault itself", async () => {
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    await writeFile(path.join(vault, ".oms", "taxonomy.yaml"), "version: 1\nfolders: {}\n", "utf-8");
    const resolved = await resolveEffectiveVault(vault, {});
    expect(resolved.source).toBe("vault");
    expect(resolved.scope).toBeNull();
  });

  it("resolves a bridge repo to the recorded vault and scope", async () => {
    const omsDir = path.join(repo, ".oms");
    await writeLinkRecord(omsDir, { version: 1, vault, scope: ["notes"] });
    const resolved = await resolveEffectiveVault(repo, {});
    expect(resolved).toEqual({ vault: path.resolve(vault), scope: ["notes"], source: "bridge" });
  });

  it("expands a ~ vault path stored in the bridge record before validating existence", async () => {
    const omsDir = path.join(repo, ".oms");
    await writeLinkRecord(omsDir, { version: 1, vault: "~/v", scope: [] });
    await expect(resolveEffectiveVault(repo, {})).rejects.toThrow(path.resolve(os.homedir(), "v"));
  });

  it("falls back to OMS_VAULT when no local ontology or bridge exists", async () => {
    const resolved = await resolveEffectiveVault(repo, { OMS_VAULT: vault });
    expect(resolved).toEqual({ vault: path.resolve(vault), scope: null, source: "env" });
  });

  it("falls back to the start dir when nothing else resolves", async () => {
    const resolved = await resolveEffectiveVault(repo, {});
    expect(resolved).toEqual({ vault: path.resolve(repo), scope: null, source: "cwd" });
  });

  it("prefers local template controls over a bridge record", async () => {
    await mkdir(path.join(repo, ".oms"), { recursive: true });
    await writeFile(path.join(repo, ".oms", "template-policy.json"), "{}\n");
    await writeLinkRecord(path.join(repo, ".oms"), { version: 1, vault, scope: ["notes"] });
    const resolved = await resolveEffectiveVault(repo, { OMS_VAULT: "/somewhere/else" });
    expect(resolved.source).toBe("vault");
  });

  it("prefers a bridge record over OMS_VAULT", async () => {
    await writeLinkRecord(path.join(repo, ".oms"), { version: 1, vault, scope: [] });
    const resolved = await resolveEffectiveVault(repo, { OMS_VAULT: "/somewhere/else" });
    expect(resolved.source).toBe("bridge");
    expect(resolved.vault).toBe(path.resolve(vault));
  });
  it("errors on malformed bridge records instead of falling back to OMS_VAULT", async () => {
    const omsDir = path.join(repo, ".oms");
    await mkdir(omsDir, { recursive: true });
    await writeFile(path.join(omsDir, "links.yaml"), "vault: [not valid\n", "utf-8");

    await expect(resolveEffectiveVault(repo, { OMS_VAULT: vault })).rejects.toThrow(/not valid YAML/);
  });

  it("errors when a bridge record omits the required vault field instead of falling back to cwd", async () => {
    const omsDir = path.join(repo, ".oms");
    await mkdir(omsDir, { recursive: true });
    await writeFile(path.join(omsDir, "links.yaml"), "version: 1\nscope: [notes]\n", "utf-8");

    await expect(resolveEffectiveVault(repo, {})).rejects.toThrow(/missing required string field "vault"/);
  });

  it("errors when the linked vault path no longer exists", async () => {
    const omsDir = path.join(repo, ".oms");
    await writeLinkRecord(omsDir, { version: 1, vault: path.join(tmp, "deleted-vault"), scope: ["notes"] });

    await expect(resolveEffectiveVault(repo, { OMS_VAULT: vault })).rejects.toThrow(/Linked vault path does not exist/);
  });

});

describe("createVaultLink", () => {
  beforeEach(async () => {
    await mkdir(path.join(vault, "notes"), { recursive: true });
    await mkdir(path.join(vault, "references"), { recursive: true });
  });

  it("creates a symlink, link record, and gitignore entry", async () => {
    const result = await createVaultLink({ cwd: repo, vault, folders: ["notes"] });

    const linkPath = path.join(repo, ".oms", "linked", "notes");
    const info = await lstat(linkPath);
    expect(info.isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(linkPath), await readlink(linkPath))).toBe(
      path.join(vault, "notes"),
    );

    expect(result.linked).toEqual([path.join("linked", "notes")]);
    expect(result.gitignoreUpdated).toBe(true);

    const record = yamlParse(await readFile(result.recordPath, "utf-8")) as Record<string, unknown>;
    expect(record["vault"]).toBe(path.resolve(vault));
    expect(record["scope"]).toEqual(["notes"]);
  });

  it("stores the vault as an absolute path even when given ~ or relative input", async () => {
    const relativeVault = path.relative(repo, vault);
    const result = await createVaultLink({ cwd: repo, vault: relativeVault, folders: ["notes"] });
    expect(path.isAbsolute(result.record.vault)).toBe(true);
    expect(result.record.vault).toBe(path.resolve(vault));
  });

  it("is idempotent: re-linking the same folder reports it unchanged", async () => {
    await createVaultLink({ cwd: repo, vault, folders: ["notes"] });
    const second = await createVaultLink({ cwd: repo, vault, folders: ["notes"] });
    expect(second.unchanged).toEqual([path.join("linked", "notes")]);
    expect(second.linked).toEqual([]);
  });

  it("merges scope across successive link calls", async () => {
    await createVaultLink({ cwd: repo, vault, folders: ["notes"] });
    const second = await createVaultLink({ cwd: repo, vault, folders: ["references"] });
    expect(second.record.scope).toEqual(["notes", "references"]);
  });

  it("refuses to overwrite an existing non-symlink at the target path", async () => {
    await mkdir(path.join(repo, ".oms", "linked"), { recursive: true });
    await writeFile(path.join(repo, ".oms", "linked", "notes"), "real file", "utf-8");
    await expect(createVaultLink({ cwd: repo, vault, folders: ["notes"] })).rejects.toThrow(
      /Refusing to overwrite/,
    );
  });

  it("rejects a vault folder that does not exist", async () => {
    await expect(createVaultLink({ cwd: repo, vault, folders: ["missing"] })).rejects.toThrow(
      /does not exist/,
    );
  });

  it("links a nested vault subpath, naming the symlink by basename", async () => {
    await mkdir(path.join(vault, "15. Work", "01 Project", "eldercare"), { recursive: true });
    const result = await createVaultLink({
      cwd: repo,
      vault,
      folders: ["15. Work/01 Project/eldercare"],
    });
    expect(result.linked).toEqual([path.join("linked", "eldercare")]);
    expect(result.record.scope).toEqual(["15. Work/01 Project/eldercare"]);
    const linkPath = path.join(repo, ".oms", "linked", "eldercare");
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(linkPath), await readlink(linkPath))).toBe(
      path.join(vault, "15. Work", "01 Project", "eldercare"),
    );
  });

  it("rejects a folder that escapes the vault root", async () => {
    await expect(createVaultLink({ cwd: repo, vault, folders: [".."] })).rejects.toThrow(
      /vault root|escapes the vault/,
    );
    await expect(
      createVaultLink({ cwd: repo, vault, folders: ["../../etc"] }),
    ).rejects.toThrow(/escapes the vault/);
  });

  it("rejects a link-name collision between two subpaths", async () => {
    await mkdir(path.join(vault, "a", "shared"), { recursive: true });
    await mkdir(path.join(vault, "b", "shared"), { recursive: true });
    await expect(
      createVaultLink({ cwd: repo, vault, folders: ["a/shared", "b/shared"] }),
    ).rejects.toThrow(/collision/);
  });

  it("rejects an empty folder list", async () => {
    await expect(createVaultLink({ cwd: repo, vault, folders: [] })).rejects.toThrow(
      /At least one --folder/,
    );
  });

  it("rejects a vault path that is not a directory", async () => {
    await expect(
      createVaultLink({ cwd: repo, vault: path.join(vault, "nope"), folders: ["notes"] }),
    ).rejects.toThrow(/not a directory/);
  });

  it("re-points a stale symlink to the current vault target", async () => {
    const linkedDir = path.join(repo, ".oms", "linked");
    await mkdir(linkedDir, { recursive: true });
    await symlink(path.join(tmp, "old-target"), path.join(linkedDir, "notes"), "dir");
    const result = await createVaultLink({ cwd: repo, vault, folders: ["notes"] });
    expect(result.linked).toEqual([path.join("linked", "notes")]);
    expect(path.resolve(linkedDir, await readlink(path.join(linkedDir, "notes")))).toBe(
      path.join(vault, "notes"),
    );
  });
});
