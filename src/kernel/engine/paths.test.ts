import { execFileSync } from "node:child_process";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestBytes } from "../templates/canonical.js";
import {
  assertExternalCachePath,
  assertExternalDatabasePath,
  ENGINE_STORE_FILENAME,
  engineAxisCachePath,
  engineGraphCachePath,
  engineNodeCachePath,
  engineStorePath,
  vaultCacheRoot,
} from "./paths.js";

const scratch: string[] = [];

function temp(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function digestOf(localRoot: string): string {
  return digestBytes(realpathSync(localRoot)).slice("sha256:".length);
}

describe("engine cache paths", () => {
  it("keeps engine, graph, node, and axis paths under one external root", () => {
    const home = temp("oms-cache-home-");
    const vault = temp("oms-cache-vault-");
    const options = { env: {}, homeDir: home };
    const root = path.join(home, ".cache", "oms", "vaults", "v1", digestOf(vault));

    expect(ENGINE_STORE_FILENAME).toBe("engine-store.sqlite");
    expect(vaultCacheRoot(vault, options)).toBe(root);
    expect(engineStorePath(vault, options)).toBe(path.join(root, ENGINE_STORE_FILENAME));
    expect(engineGraphCachePath(vault, options)).toBe(path.join(root, "engine", "graph.json"));
    expect(engineNodeCachePath(vault, options)).toBe(path.join(root, "engine", "node-index.json"));
    expect(engineAxisCachePath(vault, options)).toBe(path.join(root, "axes.sqlite"));
    expect(engineStorePath(`${vault}${path.sep}`, options)).toBe(engineStorePath(vault, options));
  });

  it("uses an absolute XDG_CACHE_HOME and ignores empty or relative values", () => {
    const home = temp("oms-cache-home-");
    const xdg = temp("oms-cache-xdg-");
    const vault = temp("oms-cache-vault-");
    const digest = digestOf(vault);

    expect(vaultCacheRoot(vault, { env: { XDG_CACHE_HOME: xdg }, homeDir: home })).toBe(
      path.join(xdg, "oms", "vaults", "v1", digest),
    );
    expect(vaultCacheRoot(vault, { env: { XDG_CACHE_HOME: "" }, homeDir: home })).toBe(
      path.join(home, ".cache", "oms", "vaults", "v1", digest),
    );
    expect(vaultCacheRoot(vault, { env: { XDG_CACHE_HOME: "relative-cache" }, homeDir: home })).toBe(
      path.join(home, ".cache", "oms", "vaults", "v1", digest),
    );
    const spaced = `${xdg} `;
    mkdirSync(spaced);
    scratch.push(spaced);
    expect(vaultCacheRoot(vault, { env: { XDG_CACHE_HOME: spaced }, homeDir: home })).toBe(
      path.join(spaced, "oms", "vaults", "v1", digest),
    );
  });

  it("lets an explicit empty env and homeDir override inherited XDG and HOME", () => {
    const home = temp("oms-cache-home-");
    const inheritedHome = temp("oms-cache-inherited-home-");
    const inheritedXdg = temp("oms-cache-inherited-xdg-");
    const vault = temp("oms-cache-vault-");
    const previousHome = process.env.HOME;
    const previousXdg = process.env.XDG_CACHE_HOME;
    process.env.HOME = inheritedHome;
    process.env.XDG_CACHE_HOME = inheritedXdg;
    try {
      const digest = digestOf(vault);
      expect(vaultCacheRoot(vault, { env: {}, homeDir: home })).toBe(
        path.join(home, ".cache", "oms", "vaults", "v1", digest),
      );
      expect(vaultCacheRoot(vault, { env: { HOME: home } })).toBe(
        path.join(home, ".cache", "oms", "vaults", "v1", digest),
      );
      expect(vaultCacheRoot(vault)).toBe(path.join(inheritedXdg, "oms", "vaults", "v1", digest));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdg === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousXdg;
    }
  });

  it("shares aliases and separates physical copies", () => {
    const home = temp("oms-cache-home-");
    const parent = temp("oms-cache-parent-");
    const vault = path.join(parent, "vault");
    const copy = path.join(parent, "copy");
    mkdirSync(vault);
    mkdirSync(copy);
    const alias = path.join(parent, "alias");
    symlinkSync(vault, alias);
    const options = { env: {}, homeDir: home };

    expect(vaultCacheRoot(`${alias}${path.sep}`, options)).toBe(vaultCacheRoot(vault, options));
    expect(engineStorePath(alias, options)).toBe(engineStorePath(vault, options));
    expect(vaultCacheRoot(copy, options)).not.toBe(vaultCacheRoot(vault, options));
  });

  it("resolves a missing vault from its nearest existing ancestor without creating it", () => {
    const home = temp("oms-cache-home-");
    const parent = temp("oms-cache-missing-");
    const missing = path.join(parent, "absent", "vault");
    const root = vaultCacheRoot(missing, { env: {}, homeDir: home });

    expect(root).toBe(path.join(home, ".cache", "oms", "vaults", "v1", digestBytes(path.resolve(realpathSync(parent), "absent", "vault")).slice("sha256:".length)));
    expect(() => realpathSync(missing)).toThrow();
    expect(() => realpathSync(root)).toThrow();
  });

  it("rejects a cache base that resolves inside the vault, including a symlink alias", () => {
    const parent = temp("oms-cache-unsafe-");
    const vault = path.join(parent, "vault");
    const outside = path.join(parent, "outside");
    mkdirSync(vault);
    mkdirSync(outside);
    const inside = path.join(vault, "cache-link");
    symlinkSync(outside, inside);

    expect(() => vaultCacheRoot(vault, { env: { XDG_CACHE_HOME: path.join(vault, "cache") }, homeDir: outside })).toThrow(/inside the vault/);
    expect(() => engineStorePath(vault, { env: { XDG_CACHE_HOME: inside }, homeDir: outside })).toThrow(/inside the vault/);
    const danglingInside = path.join(vault, "dangling-cache");
    symlinkSync(path.join(outside, "not-yet"), danglingInside);
    expect(() => vaultCacheRoot(vault, { env: { XDG_CACHE_HOME: danglingInside }, homeDir: outside })).toThrow(/inside the vault/);
    expect(() => realpathSync(path.join(outside, "not-yet"))).toThrow();

    const nested = path.join(parent, "nested-link");
    symlinkSync(danglingInside, nested);
    expect(() => engineGraphCachePath(vault, { env: { XDG_CACHE_HOME: nested }, homeDir: outside })).toThrow(/inside the vault/);

    const loopA = path.join(parent, "loop-a");
    const loopB = path.join(parent, "loop-b");
    symlinkSync(loopB, loopA);
    symlinkSync(loopA, loopB);
    expect(() => vaultCacheRoot(vault, { env: { XDG_CACHE_HOME: loopA }, homeDir: outside })).toThrow(/symlink loop/);
  });

  it("resolves a symlinked cache base outside the vault and does not write", () => {
    const parent = temp("oms-cache-link-root-");
    const vault = path.join(parent, "vault");
    const realCache = path.join(parent, "real-cache");
    mkdirSync(vault);
    mkdirSync(realCache);
    const link = path.join(parent, "cache-link");
    symlinkSync(realCache, link);
    const marker = path.join(realCache, "untouched");
    writeFileSync(marker, "keep");
    const before = realpathSync(marker);

    const root = vaultCacheRoot(vault, { env: { XDG_CACHE_HOME: link }, homeDir: parent });
    expect(root.startsWith(path.resolve(link))).toBe(true);
    expect(realpathSync(path.dirname(path.dirname(path.dirname(path.dirname(root)))))).toBe(realpathSync(realCache));
    expect(realpathSync(marker)).toBe(before);
    expect(() => realpathSync(root)).toThrow();
    const unresolvedOutside = path.join(parent, "unresolved-outside");
    symlinkSync(path.join(parent, "missing-cache-target"), unresolvedOutside);
    const unresolved = vaultCacheRoot(vault, { env: { XDG_CACHE_HOME: unresolvedOutside }, homeDir: parent });
    expect(unresolved.startsWith(path.resolve(unresolvedOutside))).toBe(true);
    expect(() => realpathSync(unresolvedOutside)).toThrow();
    expect(() => realpathSync(unresolved)).toThrow();
  });

  it("rejects an engine-directory symlink that routes a graph cache leaf into the vault", () => {
    const parent = temp("oms-cache-engine-dir-");
    const home = path.join(parent, "home");
    const vault = path.join(parent, "vault");
    const outside = path.join(parent, "outside");
    mkdirSync(home);
    mkdirSync(vault);
    mkdirSync(outside);
    const options = { env: {}, homeDir: home };
    const root = vaultCacheRoot(vault, options);
    const engineDir = path.join(root, "engine");
    mkdirSync(root, { recursive: true });
    symlinkSync(path.join(vault, "captured-graph"), engineDir);
    const graph = path.join(engineDir, "graph.json");

    expect(() => engineGraphCachePath(vault, options)).toThrow(/inside the vault/);
    expect(() => engineNodeCachePath(vault, options)).toThrow(/inside the vault/);
    expect(() => assertExternalCachePath(vault, graph)).toThrow(/inside the vault/);
    expect(() => realpathSync(graph)).toThrow();
    expect(lstatSync(engineDir).isSymbolicLink()).toBe(true);
  });

  it("rejects an engine-store leaf symlink and a dangling final link into the vault", () => {
    const parent = temp("oms-cache-leaf-link-");
    const home = path.join(parent, "home");
    const vault = path.join(parent, "vault");
    mkdirSync(home);
    mkdirSync(vault);
    const options = { env: {}, homeDir: home };
    const store = engineStorePath(vault, options);
    mkdirSync(path.dirname(store), { recursive: true });
    symlinkSync(path.join(vault, "captured.sqlite"), store);

    expect(() => engineStorePath(vault, options)).toThrow(/inside the vault/);
    expect(() => assertExternalCachePath(vault, store)).toThrow(/inside the vault/);
    expect(lstatSync(store).isSymbolicLink()).toBe(true);

    const exited = path.join(parent, "exit-link");
    symlinkSync(path.join(parent, "outside-target"), path.join(vault, "through"));
    symlinkSync(path.join(vault, "through"), exited);
    expect(() => assertExternalCachePath(vault, exited)).toThrow(/inside the vault/);

    const dangling = path.join(parent, "dangling-leaf");
    symlinkSync(path.join(vault, "not-yet.sqlite"), dangling);
    expect(() => assertExternalCachePath(vault, dangling)).toThrow(/inside the vault/);
    expect(() => realpathSync(dangling)).toThrow();
    expect(() => realpathSync(path.join(vault, "not-yet.sqlite"))).toThrow();
  });

  it("rejects a hardlinked regular cache file and a NUL cache path", () => {
    const parent = temp("oms-cache-hardlink-");
    const home = path.join(parent, "home");
    const vault = path.join(parent, "vault");
    const outside = path.join(parent, "outside");
    mkdirSync(home);
    mkdirSync(vault);
    mkdirSync(outside);
    const options = { env: {}, homeDir: home };
    const axis = engineAxisCachePath(vault, options);
    mkdirSync(path.dirname(axis), { recursive: true });
    writeFileSync(axis, "axis");
    const twin = path.join(outside, "axis-twin.sqlite");
    linkSync(axis, twin);

    expect(lstatSync(axis).nlink).toBeGreaterThan(1);
    expect(() => engineAxisCachePath(vault, options)).toThrow(/hard-linked/);
    expect(() => assertExternalCachePath(vault, axis)).toThrow(/hard-linked/);
    expect(() => assertExternalCachePath(vault, `cache-\0.sqlite`)).toThrow(/NUL/);
    expect(() => assertExternalCachePath(`vault-\0`, axis)).toThrow(/NUL/);
  });

  it("accepts valid external overrides and lexical aliases without writing", () => {
    const parent = temp("oms-cache-override-");
    const home = path.join(parent, "home");
    const vault = path.join(parent, "vault");
    const other = path.join(parent, "other-vault");
    const outside = path.join(parent, "outside");
    mkdirSync(home);
    mkdirSync(vault);
    mkdirSync(other);
    mkdirSync(outside);
    const options = { env: {}, homeDir: home };
    const external = path.join(outside, "db", "engine-store.sqlite");
    const aliasParent = path.join(parent, "alias-parent");
    symlinkSync(outside, aliasParent);
    const aliased = path.join(aliasParent, "db", "engine-store.sqlite");
    const marker = path.join(outside, "untouched");
    writeFileSync(marker, "keep");
    const before = realpathSync(marker);
    const otherRoot = vaultCacheRoot(other, options);

    expect(assertExternalCachePath(vault, external)).toBe(path.resolve(external));
    expect(assertExternalCachePath(vault, `${external}${path.sep}`)).toBe(path.resolve(external));
    expect(assertExternalCachePath(vault, aliased)).toBe(path.resolve(aliased));
    expect(assertExternalCachePath(vault, path.join(outside, "missing", "..", "db", "engine-store.sqlite"))).toBe(path.resolve(external));
    expect(engineStorePath(vault, options)).toBe(path.join(vaultCacheRoot(vault, options), ENGINE_STORE_FILENAME));
    expect(engineStorePath(other, options)).not.toBe(engineStorePath(vault, options));
    expect(otherRoot).not.toBe(vaultCacheRoot(vault, options));
    expect(realpathSync(marker)).toBe(before);
    expect(() => realpathSync(external)).toThrow();
    expect(() => realpathSync(otherRoot)).toThrow();
  });
  it("inherits isolated HOME and XDG values in a child without host writes", () => {
    const child = execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({home:process.env.HOME,xdg:process.env.XDG_CACHE_HOME,runtime:process.env.OMS_RUNTIME_ROOT}))"], {
      encoding: "utf8",
      env: process.env,
    });
    const inherited = JSON.parse(child) as { home?: string; xdg?: string; runtime?: string };
    expect(inherited.home).toBe(process.env.HOME);
    expect(inherited.xdg).toBe(process.env.XDG_CACHE_HOME);
    expect(inherited.runtime).toBe(process.env.OMS_RUNTIME_ROOT);
    expect(process.env.OMS_TEST_HOST_HOME).toBeTruthy();
    expect(inherited.home).not.toBe(process.env.OMS_TEST_HOST_HOME);
    expect(inherited.runtime?.includes("oms-test-runtime-")).toBe(true);
  });
  it("rejects a symlink whose resolved regular file is a hard link of a vault file", () => {
    const parent = temp("oms-cache-resolved-hardlink-");
    const vault = path.join(parent, "vault");
    const outside = path.join(parent, "outside");
    mkdirSync(vault);
    mkdirSync(outside);
    const vaultFile = path.join(vault, "captured.sqlite");
    const twin = path.join(outside, "twin.sqlite");
    writeFileSync(vaultFile, "vault-bytes");
    linkSync(vaultFile, twin);
    const alias = path.join(outside, "alias.sqlite");
    symlinkSync(twin, alias);
    const before = readFileSync(vaultFile);

    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(lstatSync(alias).nlink).toBe(1);
    expect(lstatSync(realpathSync(alias)).nlink).toBeGreaterThan(1);
    expect(() => assertExternalCachePath(vault, alias)).toThrow(/hard-linked/);
    expect(readFileSync(vaultFile)).toEqual(before);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(() => realpathSync(path.join(outside, "not-created"))).toThrow();
  });

  it("rejects each database companion symlink into the vault before any side effect", () => {
    const parent = temp("oms-db-companion-symlink-");
    const vault = path.join(parent, "vault");
    const outside = path.join(parent, "outside");
    mkdirSync(vault);
    mkdirSync(outside);
    const database = path.join(outside, "store.sqlite");
    writeFileSync(database, "db");
    const beforeTree = readdirSync(vault).sort();
    for (const suffix of ["-wal", "-shm", "-journal", ".lock"]) {
      const vaultTarget = path.join(vault, `captured${suffix}`);
      writeFileSync(vaultTarget, `vault${suffix}`);
      const companion = `${database}${suffix}`;
      symlinkSync(vaultTarget, companion);
      const before = readFileSync(vaultTarget);
      expect(() => assertExternalDatabasePath(vault, database)).toThrow(/companion/);
      expect(readFileSync(vaultTarget)).toEqual(before);
      expect(lstatSync(companion).isSymbolicLink()).toBe(true);
      rmSync(companion);
    }
    expect(readFileSync(database)).toEqual(Buffer.from("db"));
    expect(() => realpathSync(path.join(outside, "not-created"))).toThrow();
    expect(readdirSync(vault).sort()).toEqual(["captured-journal", "captured-shm", "captured-wal", "captured.lock"]);
    expect(beforeTree).toEqual([]);
  });

  it("rejects a resolved alias companion that escapes into the vault", () => {
    const parent = temp("oms-db-alias-companion-");
    const vault = path.join(parent, "vault");
    const outside = path.join(parent, "outside");
    mkdirSync(vault);
    mkdirSync(outside);
    const realDatabase = path.join(outside, "real.sqlite");
    writeFileSync(realDatabase, "db");
    const aliasDir = path.join(parent, "alias-dir");
    symlinkSync(outside, aliasDir);
    const alias = path.join(aliasDir, "real.sqlite");
    const vaultWal = path.join(vault, "escaped-wal");
    writeFileSync(vaultWal, "vault-wal");
    symlinkSync(vaultWal, `${realDatabase}-wal`);
    const before = readFileSync(vaultWal);

    expect(lstatSync(alias).isSymbolicLink()).toBe(false);
    expect(() => assertExternalDatabasePath(vault, alias)).toThrow(/companion/);
    expect(readFileSync(vaultWal)).toEqual(before);
    expect(lstatSync(`${realDatabase}-wal`).isSymbolicLink()).toBe(true);
    expect(() => realpathSync(path.join(outside, "not-created"))).toThrow();
  });

  it("rejects hard-linked and non-regular database and companion leaves without opening them", () => {
    const parent = temp("oms-db-unsafe-leaf-");
    const vault = path.join(parent, "vault");
    const outside = path.join(parent, "outside");
    mkdirSync(vault);
    mkdirSync(outside);
    const database = path.join(outside, "store.sqlite");
    const twin = path.join(outside, "store-twin.sqlite");
    writeFileSync(database, "db");
    linkSync(database, twin);
    expect(() => assertExternalDatabasePath(vault, database)).toThrow(/hard-linked|safe regular file/);
    rmSync(twin);

    const directoryDatabase = path.join(outside, "dir.sqlite");
    mkdirSync(directoryDatabase);
    expect(() => assertExternalDatabasePath(vault, directoryDatabase)).toThrow(/safe regular file/);
    expect(lstatSync(directoryDatabase).isDirectory()).toBe(true);

    writeFileSync(database, "db");
    const fifo = `${database}-journal`;
    execFileSync("mkfifo", [fifo]);
    expect(lstatSync(fifo).isFIFO()).toBe(true);
    expect(() => assertExternalDatabasePath(vault, database)).toThrow(/safe regular file/);
    expect(lstatSync(fifo).isFIFO()).toBe(true);
    rmSync(fifo);

    const companion = `${database}-wal`;
    const companionTwin = path.join(outside, "wal-twin");
    writeFileSync(companion, "wal");
    linkSync(companion, companionTwin);
    expect(lstatSync(companion).nlink).toBeGreaterThan(1);
    expect(() => assertExternalDatabasePath(vault, database)).toThrow(/safe regular file/);
    expect(readFileSync(companion)).toEqual(Buffer.from("wal"));
    rmSync(companionTwin);
    rmSync(companion);

    mkdirSync(`${database}.lock`);
    expect(lstatSync(`${database}.lock`).isDirectory()).toBe(true);
    expect(() => assertExternalDatabasePath(vault, database)).toThrow(/safe regular file/);
    expect(lstatSync(`${database}.lock`).isDirectory()).toBe(true);
  });

  it("accepts a missing or regular external database and a safe alias without writing", () => {
    const parent = temp("oms-db-safe-");
    const home = path.join(parent, "home");
    const vault = path.join(parent, "vault");
    const outside = path.join(parent, "outside");
    mkdirSync(home);
    mkdirSync(vault);
    mkdirSync(outside);
    const options = { env: {}, homeDir: home };
    const missing = path.join(outside, "missing", "store.sqlite");
    const marker = path.join(outside, "untouched");
    writeFileSync(marker, "keep");
    const before = readFileSync(marker);

    expect(assertExternalDatabasePath(vault, missing)).toBe(path.resolve(missing));
    expect(engineStorePath(vault, options)).toBe(path.join(vaultCacheRoot(vault, options), ENGINE_STORE_FILENAME));
    expect(engineAxisCachePath(vault, options)).toBe(path.join(vaultCacheRoot(vault, options), "axes.sqlite"));
    expect(() => realpathSync(missing)).toThrow();
    expect(() => realpathSync(engineStorePath(vault, options))).toThrow();

    const database = path.join(outside, "store.sqlite");
    writeFileSync(database, "db");
    writeFileSync(`${database}-wal`, "wal");
    const aliasDir = path.join(parent, "alias-dir");
    symlinkSync(outside, aliasDir);
    const alias = path.join(aliasDir, "store.sqlite");
    expect(assertExternalDatabasePath(vault, database)).toBe(path.resolve(database));
    expect(assertExternalDatabasePath(vault, alias)).toBe(path.resolve(alias));
    expect(readFileSync(marker)).toEqual(before);
    expect(readFileSync(database)).toEqual(Buffer.from("db"));
    expect(readFileSync(`${database}-wal`)).toEqual(Buffer.from("wal"));
    expect(lstatSync(database).nlink).toBe(1);
    expect(() => realpathSync(path.join(outside, "not-created"))).toThrow();
  });
  it("accepts a portable external parent-directory symlink without writing", () => {
    const parent = temp("oms-db-parent-alias-");
    const vault = path.join(parent, "vault");
    const realOutside = path.join(parent, "real-outside");
    mkdirSync(vault);
    mkdirSync(realOutside);
    const aliasParent = path.join(parent, "alias-parent");
    symlinkSync(realOutside, aliasParent);
    const database = path.join(aliasParent, "nested", "store.sqlite");
    const marker = path.join(realOutside, "untouched");
    writeFileSync(marker, "keep");
    const before = readFileSync(marker);
    const beforeVault = readdirSync(vault);

    expect(lstatSync(aliasParent).isSymbolicLink()).toBe(true);
    expect(() => lstatSync(database)).toThrow();
    expect(assertExternalDatabasePath(vault, database)).toBe(path.resolve(database));
    expect(readFileSync(marker)).toEqual(before);
    expect(readdirSync(vault)).toEqual(beforeVault);
    expect(() => realpathSync(database)).toThrow();
    expect(() => realpathSync(path.join(realOutside, "nested"))).toThrow();
  });
});
