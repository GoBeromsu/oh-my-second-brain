import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UUID_PATTERN } from "./types.js";
import { ensureVaultId, readVaultId, VAULT_ID_PATH } from "./vault-id.js";

const roots: string[] = [];
const ID = "abcdef12-2222-4333-8444-555555555555";

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-contract-vault-id-"));
  roots.push(root);
  return root;
}

describe("readVaultId", () => {
  it("reports absent without creating .oms", async () => {
    const root = await vault();
    expect(await readVaultId(root)).toEqual({ state: "absent" });
    expect(await readdir(root)).toEqual([]);
  });

  it("reads a valid id and rejects malformed or linked files", async () => {
    const root = await vault();
    await mkdir(join(root, ".oms"));
    await writeFile(join(root, VAULT_ID_PATH), `${ID}\n`);
    expect(await readVaultId(root)).toEqual({ state: "ok", id: ID });
    await writeFile(join(root, VAULT_ID_PATH), ID.toUpperCase());
    expect((await readVaultId(root)).state).toBe("invalid");
    await writeFile(join(root, VAULT_ID_PATH), "x".repeat(300));
    expect((await readVaultId(root)).state).toBe("invalid");
    await rm(join(root, VAULT_ID_PATH));
    await writeFile(join(root, "elsewhere"), ID);
    await symlink(join(root, "elsewhere"), join(root, VAULT_ID_PATH));
    expect((await readVaultId(root)).state).toBe("invalid");
  });

  it("rejects a .oms that is not a real directory", async () => {
    const root = await vault();
    await writeFile(join(root, ".oms"), "file");
    expect((await readVaultId(root)).state).toBe("invalid");
  });
});

describe("ensureVaultId", () => {
  it("seeds the first id from settings vaultId", async () => {
    const root = await vault();
    await mkdir(join(root, ".oms"));
    await writeFile(join(root, ".oms/settings.json"), JSON.stringify({ version: 1, vaultId: ID, templateRoots: [] }));
    expect(await ensureVaultId(root)).toEqual({ state: "ok", id: ID, created: true });
    expect(await readFile(join(root, VAULT_ID_PATH), "utf8")).toBe(`${ID}\n`);
    expect(await ensureVaultId(root)).toEqual({ state: "ok", id: ID, created: false });
  });

  it("falls back to a random id when settings are absent or unreadable", async () => {
    const root = await vault();
    const first = await ensureVaultId(root);
    expect(first.state === "ok" && UUID_PATTERN.test(first.id) && first.created).toBe(true);
    const other = await vault();
    await mkdir(join(other, ".oms"));
    await writeFile(join(other, ".oms/settings.json"), "{not json");
    const second = await ensureVaultId(other);
    expect(second.state === "ok" && UUID_PATTERN.test(second.id)).toBe(true);
  });

  it("never overwrites an invalid id file", async () => {
    const root = await vault();
    await mkdir(join(root, ".oms"));
    await writeFile(join(root, VAULT_ID_PATH), "garbage");
    expect((await ensureVaultId(root)).state).toBe("invalid");
    expect(await readFile(join(root, VAULT_ID_PATH), "utf8")).toBe("garbage");
  });
});
