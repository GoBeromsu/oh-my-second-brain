import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitWriteTarget, safeVaultNotePath, verifyVaultNotePath } from "./safe.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("write target admission", () => {
  it("admits explicit, vault, bridge, and env targets and refuses cwd", async () => {
    for (const source of ["explicit", "vault", "bridge", "env"] as const) {
      expect(await admitWriteTarget({ vault: "/tmp/oms-vault", source })).toBeUndefined();
    }
    const refused = await admitWriteTarget({ vault: "/tmp/oms-vault", source: "cwd" });
    expect(refused?.code).toBe("target-unverified");
    expect(refused?.message).toMatch(/guide or check/);
    expect(refused?.message).not.toMatch(/\bcomplete\b/u);
    expect(refused?.message).toMatch(/explicit vault target/i);
    expect(refused?.message).not.toMatch(/Refusing to write/);
  });
});

describe("lexical note confinement", () => {
  it("keeps a vault-relative markdown path inside the vault", async () => {
    const vault = await makeRoot("oms-safe-lexical-");
    expect(safeVaultNotePath(vault, "Notes/note.md")).toBe(resolve(vault, "Notes/note.md"));
    expect(safeVaultNotePath(vault, "Notes\\note.md")).toBe(resolve(vault, "Notes/note.md"));
  });

  it("rejects absolute, traversal, hidden, dependency, and non-markdown paths", async () => {
    const vault = await makeRoot("oms-safe-reject-");
    expect(() => safeVaultNotePath(vault, "/etc/passwd.md")).toThrow(/vault-relative/);
    expect(() => safeVaultNotePath(vault, "Notes/../note.md")).toThrow(/unsafe path segments/);
    expect(() => safeVaultNotePath(vault, "Notes/./note.md")).toThrow(/unsafe path segments/);
    expect(() => safeVaultNotePath(vault, "Notes//note.md")).toThrow(/unsafe path segments/);
    expect(() => safeVaultNotePath(vault, ".hidden/note.md")).toThrow(/hidden/);
    expect(() => safeVaultNotePath(vault, "node_modules/pkg.md")).toThrow(/hidden, internal, or dependency/);
    expect(() => safeVaultNotePath(vault, "Notes/note.txt")).toThrow(/\.md/);
    expect(() => safeVaultNotePath(vault, "Notes")).toThrow(/\.md/);
  });
});

describe("realpath and symlink note checks", () => {
  it("accepts an absent note under a real parent without creating it", async () => {
    const vault = await makeRoot("oms-safe-absent-");
    await mkdir(join(vault, "Notes"));
    const result = await verifyVaultNotePath(vault, "Notes/new.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notePath).toBe("Notes/new.md");
    expect(result.vaultRoot).toBe(await realpath(vault));
    expect(result.absolutePath).toBe(join(result.vaultRoot, "Notes", "new.md"));
    await expect(stat(join(vault, "Notes", "new.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts an existing regular note file", async () => {
    const vault = await makeRoot("oms-safe-file-");
    await mkdir(join(vault, "Notes"));
    await writeFile(join(vault, "Notes", "kept.md"), "hello");
    const result = await verifyVaultNotePath(vault, "Notes/kept.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notePath).toBe("Notes/kept.md");
  });

  it("rejects a directory, a symlink leaf, and a symlink parent of an absent note", async () => {
    const vault = await makeRoot("oms-safe-link-");
    const outside = await makeRoot("oms-safe-outside-");
    await mkdir(join(vault, "Notes"));
    await mkdir(join(vault, "Notes", "note.md"));
    const directory = await verifyVaultNotePath(vault, "Notes/note.md");
    expect(directory.ok).toBe(false);
    if (!directory.ok) expect(directory.rejection.code).toBe("path-unsafe");

    await writeFile(join(outside, "secret.md"), "secret");
    await symlink(join(outside, "secret.md"), join(vault, "Notes", "linked.md"));
    const leaf = await verifyVaultNotePath(vault, "Notes/linked.md");
    expect(leaf.ok).toBe(false);
    if (!leaf.ok) {
      expect(leaf.rejection.code).toBe("path-unsafe");
      expect(leaf.rejection.message).toMatch(/symlink/);
    }

    await symlink(outside, join(vault, "Alias"));
    const before = await readdir(outside);
    const parent = await verifyVaultNotePath(vault, "Alias/new.md");
    expect(parent.ok).toBe(false);
    if (!parent.ok) expect(parent.rejection.message).toMatch(/symlink/);
    expect(await readdir(outside)).toEqual(before);
    await expect(stat(join(outside, "new.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects hidden and dependency paths before touching the vault", async () => {
    const vault = await makeRoot("oms-safe-hidden-");
    const hidden = await verifyVaultNotePath(vault, ".hidden/note.md");
    const dependency = await verifyVaultNotePath(vault, "node_modules/pkg.md");
    expect(hidden.ok).toBe(false);
    expect(dependency.ok).toBe(false);
    if (!hidden.ok) expect(hidden.rejection.message).toMatch(/hidden/);
    if (!dependency.ok) expect(dependency.rejection.message).toMatch(/dependency/);
    expect(await readdir(vault)).toEqual([]);
  });
});
