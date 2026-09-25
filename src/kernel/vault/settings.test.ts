import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseVaultSettings, readVaultSettings, serializeVaultSettings } from "./settings.js";

const roots: string[] = [];
const settings = { version: 1 as const, vaultId: "11111111-1111-4111-8111-111111111111", templateFolder: "Reference/Templates" };
async function fixture() {
  const vault = await mkdtemp(join(tmpdir(), "oms-vault-settings-"));
  roots.push(vault);
  return vault;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("portable vault settings", () => {
  it("round-trips the closed key set and leaves automatic repair off unless configured", () => {
    const declared = { ...settings, embedding: { model: "local-mini" }, agentRepair: { enabled: true, contexts: ["post-write"] } };
    const parsed = parseVaultSettings(JSON.stringify(declared));
    expect(JSON.parse(serializeVaultSettings(parsed))).toEqual(declared);
    expect(parseVaultSettings(JSON.stringify(settings)).agentRepair?.enabled === true).toBe(false);
    expect(parseVaultSettings(JSON.stringify({ version: 1, vaultId: settings.vaultId }))).toEqual({ version: 1, vaultId: settings.vaultId });
  });

  it.each([["template", "Roots"].join(""), "defaultRoot", "annotations", "owner"])("rejects the unknown key %s", key => {
    expect(() => parseVaultSettings(JSON.stringify({ ...settings, [key]: ["Templates"] }))).toThrow("VAULT_SETTINGS_INVALID");
  });

  it.each(["/Users/owner/Templates", "../Templates", ".oms/templates", "Templates//agent", "C:\\Templates", "", "Templates/../Other", "Templates/"])("rejects nonportable template folder %s", folder => {
    expect(() => parseVaultSettings(JSON.stringify({ ...settings, templateFolder: folder }))).toThrow("VAULT_SETTINGS_INVALID");
  });

  it("rejects unsupported versions, malformed identity, embedding shape and repair modes", () => {
    expect(() => parseVaultSettings("{")).toThrow("VAULT_SETTINGS_INVALID");
    expect(() => parseVaultSettings("[]")).toThrow("VAULT_SETTINGS_INVALID");
    expect(() => parseVaultSettings(JSON.stringify({ ...settings, version: 2 }))).toThrow("VERSION_UNSUPPORTED");
    for (const partial of [
      { vaultId: "not-a-vault-id" }, { templateFolder: null }, { templateFolder: ["Templates"] },
      { embedding: null }, { embedding: { model: "" } }, { embedding: { model: "m", dimensions: 3 } },
      { agentRepair: null }, { agentRepair: { enabled: "true" } }, { agentRepair: { enabled: true, contexts: ["always"] } },
      { agentRepair: { enabled: false, contexts: ["maintenance", "maintenance"] } }, { agentRepair: { enabled: false, extra: 1 } },
    ]) expect(() => parseVaultSettings(JSON.stringify({ ...settings, ...partial }))).toThrow("VAULT_SETTINGS_INVALID");
    expect(() => parseVaultSettings(" ".repeat(262_145))).toThrow("256 KiB");
  });

  it("rejects raw duplicate settings members instead of admitting last-wins identity", () => {
    const unique = JSON.stringify(settings);
    expect(parseVaultSettings(unique).vaultId).toBe(settings.vaultId);
    const other = "22222222-2222-4222-8222-222222222222";
    const ambiguous = (raw: string) => {
      expect(() => parseVaultSettings(raw)).toThrow(/VAULT_SETTINGS_INVALID: settings must be unique-member JSON/);
    };
    ambiguous(unique.replace('"vaultId":', `"vaultId":${JSON.stringify(other)},"vaultId":`));
    ambiguous(unique.replace('"vaultId":', `"vaultId":${JSON.stringify(settings.vaultId)},"vaultId":`));
    ambiguous(unique.replace('"version":1', '"version":2,"version":1'));
    ambiguous(unique.replace('"templateFolder":', '"templateFolder":"Templates","templateFolder":'));
    expect(parseVaultSettings(JSON.stringify({ ...settings, templateFolder: "a{b}" })).templateFolder).toBe("a{b}");
  });


  it("reads absent settings without initializing a convention or control folder", async () => {
    const vault = await fixture();
    expect(await readVaultSettings(vault)).toBeNull();
    expect(await readdir(vault)).toEqual([]);
  });

  it("reads existing settings without rewriting its bytes", async () => {
    const vault = await fixture();
    await mkdir(join(vault, ".oms"));
    const bytes = `${JSON.stringify(settings)}\r\n`;
    await writeFile(join(vault, ".oms/settings.json"), bytes);
    expect(await readVaultSettings(vault)).toEqual(settings);
    expect(await readFile(join(vault, ".oms/settings.json"), "utf8")).toBe(bytes);
  });

  it("refuses linked, malformed UTF-8 or oversized settings instead of supplying defaults", async () => {
    for (const kind of ["symlink", "hardlink", "utf8", "oversize"]) {
      const vault = await fixture();
      await mkdir(join(vault, ".oms"));
      const file = join(vault, ".oms/settings.json");
      const other = join(vault, "keep.json");
      await writeFile(other, JSON.stringify(settings));
      if (kind === "symlink") await symlink(other, file);
      else if (kind === "hardlink") await link(other, file);
      else await writeFile(file, kind === "utf8" ? Buffer.from([0xff]) : Buffer.alloc(262_145));
      await expect(readVaultSettings(vault)).rejects.toThrow();
      expect(await readFile(other, "utf8")).toBe(JSON.stringify(settings));
    }
  });

  it("refuses settings replaced while the descriptor is open and restores every injected hook", async () => {
    const cases = ["leaf", "parent", "growth", "short", "close"] as const;
    type Mode = typeof cases[number];
    const fired: Record<Mode, number> = { leaf: 0, parent: 0, growth: 0, short: 0, close: 0 };
    let mode: Mode = "leaf";
    const original = fs.promises.open;
    const spy = vi.spyOn(fs.promises, "open").mockImplementation(async (target, ...rest) => {
      const handle = await original(target, ...rest);
      if (!String(target).endsWith(join(".oms", "settings.json"))) return handle;
      fired[mode] += 1;
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      if (mode === "leaf") { await rm(String(target)); await symlink(outside, String(target)); }
      if (mode === "parent") { const parent = join(String(target), ".."); await rm(parent, { recursive: true }); await symlink(join(parent, ".."), parent); }
      if (mode === "growth") await writeFile(String(target), Buffer.alloc(262_145));
      handle.read = mode === "short" ? (async (buffer: Buffer) => ({ bytesRead: 0, buffer })) as typeof handle.read : read;
      handle.close = (async () => { if (mode === "close") throw new Error("close fault"); return close(); }) as typeof handle.close;
      return handle;
    });
    syncBuiltinESMExports();
    const outside = join(tmpdir(), `outside-settings-${process.pid}.json`);
    await writeFile(outside, JSON.stringify(settings));
    try {
      for (const current of cases) {
        mode = current;
        const vault = await fixture();
        await mkdir(join(vault, ".oms"));
        await writeFile(join(vault, ".oms/settings.json"), JSON.stringify(settings));
        await expect(readVaultSettings(vault)).rejects.toThrow();
        expect(fired[current]).toBe(1);
      }
      expect(await readFile(outside, "utf8")).toBe(JSON.stringify(settings));
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
      await rm(outside, { force: true });
    }
  });

  it("refuses a same-byte inode replacement and a private alias, while a public root alias still reads", async () => {
    const vault = await fixture();
    await mkdir(join(vault, ".oms"));
    const file = join(vault, ".oms/settings.json");
    const bytes = JSON.stringify(settings);
    await writeFile(file, bytes);
    const alias = join(vault, "..", `public-root-${process.pid}`);
    await symlink(vault, alias);
    expect((await readVaultSettings(alias))?.vaultId).toBe(settings.vaultId);
    await rm(alias);
    const observed = join(await realpath(vault), ".oms/settings.json");
    const original = fs.promises.open;
    let fired = 0;
    const spy = vi.spyOn(fs.promises, "open").mockImplementation(async (target, ...rest) => {
      const handle = await original(target, ...rest);
      if (String(target) !== observed) return handle;
      fired += 1;
      await rm(file);
      await writeFile(file, bytes);
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await expect(readVaultSettings(vault)).rejects.toThrow(/VAULT_SETTINGS_INVALID: settings identity changed before reading/);
      expect(fired).toBe(1);
      expect(await readFile(file, "utf8")).toBe(bytes);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    const outside = join(vault, "..", `private-alias-${process.pid}.json`);
    await writeFile(outside, bytes);
    await rm(join(vault, ".oms"), { recursive: true });
    await symlink(dirname(outside), join(vault, ".oms"));
    await expect(readVaultSettings(vault)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe(bytes);
    await rm(outside, { force: true });
  });
});
