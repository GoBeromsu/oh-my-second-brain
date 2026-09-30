import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stateDir } from "../kernel/contract/state-dir.js";
import { sealContract, storeRoot } from "../kernel/contract/store.js";
import { engineStorePath } from "../kernel/engine/paths.js";
import { serializeVaultSettings } from "../kernel/vault/settings.js";
import { doctorUsage, runDoctorCommand } from "./doctor-command.js";

const roots: string[] = [];
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

function stderr(): string {
  return error.mock.calls.map(call => String(call[0])).join("\n");
}

function stdout(): string {
  return log.mock.calls.map(call => String(call[0])).join("\n");
}

async function makeVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-doctor-status-"));
  roots.push(vault);
  await mkdir(path.join(vault, "notes"), { recursive: true });
  await writeFile(path.join(vault, "notes", "alpha.md"), "# Alpha\n\nAlpha body.\n");
  return vault;
}

beforeEach(async () => {
  const cache = await mkdtemp(path.join(tmpdir(), "oms-doctor-cache-"));
  roots.push(cache);
  vi.stubEnv("XDG_CACHE_HOME", cache);
  vi.stubEnv("HOME", path.join(cache, "home"));
  vi.stubEnv("OMS_EMBEDDING_PROVIDER", undefined);
  vi.stubEnv("OMS_EMBEDDING_MODEL", undefined);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  log.mockRestore();
  error.mockRestore();
  vi.unstubAllEnvs();
  process.exitCode = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("oms doctor", () => {
  it("prints usage: exit 1 with no leaf, exit 0 for --help", async () => {
    await runDoctorCommand([]);
    expect(process.exitCode).toBe(1);
    expect(String(log.mock.calls[0]?.[0])).toBe(doctorUsage());
    await runDoctorCommand(["--help"]);
    expect(process.exitCode).toBe(0);
  });

  it("rejects an unknown leaf and names the leaves", async () => {
    await runDoctorCommand(["repair"]);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("Unknown doctor leaf: repair");
    expect(stderr()).toContain("sync-embeddings");
  });

  it("routes lineage-recover and lineage-reanchor to their leaf", async () => {
    await runDoctorCommand(["lineage-recover", "--help"]);
    expect(stdout()).toContain("Usage: oms doctor lineage-recover [--vault <path>]");
    await runDoctorCommand(["lineage-reanchor", "--bogus"]);
    expect(process.exitCode).toBe(1);
    expect(stdout()).toContain("CONTRACT_ARGS_INVALID: doctor lineage-reanchor received unknown argument --bogus");
    expect(doctorUsage()).toContain("lineage-reanchor [--vault <path>]");
  });

  it("routes the evolution leaves to the contract repair leaf", async () => {
    for (const [leaf, usage] of [
      ["evolve", "Usage: oms doctor evolve --maker-session <id> [--vault <path>]"],
      ["evolve-verdict", "Usage: oms doctor evolve-verdict --verdict <file|-> [--vault <path>]"],
      ["revert-propose", "Usage: oms doctor revert-propose --target <digest> [--vault <path>]"],
      ["reclaim-evolution-lock", "Usage: oms doctor reclaim-evolution-lock [--vault <path>]"],
    ] as const) {
      await runDoctorCommand([leaf, "--help"]);
      expect(stdout()).toContain(usage);
      expect(doctorUsage()).toContain(`  ${leaf} `);
    }
    await runDoctorCommand(["repair"]);
    expect(stderr()).toContain("reclaim-evolution-lock.");
  });

  it("validates sync-embeddings modes before any index work", async () => {
    for (const [argv, message] of [
      [[], "--mode <sync|embed|repair> is required"],
      [["--mode"], "--mode requires a value"],
      [["--mode", "--dry-run"], "--mode requires a value"],
      [["--mode", "rebuild"], "unknown mode rebuild"],
      [["--mode", "sync", "--mode", "embed"], "duplicate flag --mode"],
      [["--mode", "sync", "--repair-mode", "fts"], "--repair-mode applies only to --mode repair"],
      [["--mode", "repair", "--repair-mode"], "--repair-mode requires a value"],
    ] as const) {
      error.mockClear();
      await runDoctorCommand(["sync-embeddings", ...argv]);
      expect(process.exitCode, argv.join(" ")).toBe(1);
      expect(stderr(), argv.join(" ")).toContain(`doctor sync-embeddings: ${message}`);
    }
    expect(log).not.toHaveBeenCalled();
  });

  it("routes status --view/--index/--collection to the read-only index view without creating a store", async () => {
    for (const flags of [["--view", "collections"], ["--view", "contexts"], ["--index", "default"], ["--collection", "notes"]]) {
      const vault = await makeVault();
      error.mockClear();
      log.mockClear();
      await runDoctorCommand(["status", ...flags, "--vault", vault]);
      expect(process.exitCode, flags.join(" ")).toBe(1);
      expect(stderr(), flags.join(" ")).toBe("No engine store; run `oms doctor sync-embeddings --mode sync`.");
      expect(stdout(), flags.join(" ")).not.toContain("STATUS_ARGS_INVALID");
      expect(existsSync(engineStorePath(vault)), flags.join(" ")).toBe(false);
    }
  });

  it("lists collections through doctor status --view collections once a store exists", async () => {
    const vault = await makeVault();
    await runDoctorCommand(["sync-embeddings", "--mode", "sync", "--vault", vault]);
    expect(process.exitCode).toBe(0);
    log.mockClear();

    await runDoctorCommand(["status", "--view", "collections", "--vault", vault]);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({ collections: expect.any(Array) });

    log.mockClear();
    await runDoctorCommand(["status", "--view", "status", "--vault", vault]);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout())).not.toHaveProperty("convention");
  });

  it("rejects an unknown status view with the matching usage", async () => {
    const vault = await makeVault();
    await runDoctorCommand(["status", "--view", "bogus", "--vault", vault]);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toBe("Usage: oms doctor status [--view status|collections|contexts] [--index <path>] [--collection <name>] [--vault <path>]");
    expect(doctorUsage()).toContain("status [--view status|collections|contexts] [--index <path>] [--collection <name>] [--vault <path>]");
    expect(existsSync(engineStorePath(vault))).toBe(false);
  });

  it("keeps plain status on the vault report", async () => {
    const vault = await makeVault();
    await runDoctorCommand(["status", "--vault", vault]);
    const report = JSON.parse(stdout()) as Record<string, unknown>;
    expect(report).toMatchObject({ vault, source: "explicit" });
    expect(report).toHaveProperty("convention");
    expect(report).toHaveProperty("graph");
    expect(existsSync(engineStorePath(vault))).toBe(false);
  });

  it("reports evolution as null for an unsealed vault and creates no store", async () => {
    const vault = await makeVault();
    await runDoctorCommand(["status", "--vault", vault]);
    expect((JSON.parse(stdout()) as Record<string, unknown>)["evolution"]).toBeNull();
    expect(existsSync(path.join(process.env["HOME"]!, ".oms"))).toBe(false);
  });

  it("reports the evolution section of a sealed vault, and degrades it alone when unreadable", async () => {
    const vault = await makeVault();
    const id = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
    await mkdir(path.join(vault, ".oms"));
    await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: id, templateFolder: "Templates" }));
    await sealContract({ vaultRealPath: await realpath(vault), vaultId: id, contract: { folders: { notes: { meaning: "notes", searchExclude: false } }, properties: {} } }, storeRoot());
    await runDoctorCommand(["status", "--vault", vault]);
    expect(JSON.parse(stdout())).toMatchObject({ evolution: { autonomous: false, awaitingHuman: 0, lineageGap: false, quorum: "host-attested", budget: { remaining: { day: 0, week: 0 } } } });
    expect(existsSync(path.join(stateDir(storeRoot(), id), "evolution"))).toBe(false);
    await writeFile(path.join(stateDir(storeRoot(), id), "evolution"), "not a directory");
    log.mockClear();
    await runDoctorCommand(["status", "--vault", vault]);
    const report = JSON.parse(stdout()) as Record<string, unknown>;
    expect(report["evolution"]).toEqual({ unavailable: "evolution status could not be read; run `oms doctor contract`" });
    expect(report).toHaveProperty("convention");
  });

  it("routes gaps to the read-only gap report and creates no store", async () => {
    const vault = await makeVault();
    await runDoctorCommand(["gaps", "--vault", vault]);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({ contract: "open", contractRevision: null, ledger: "ok", open: 0, gaps: [], contradictions: [] });
    expect(existsSync(path.join(process.env["HOME"]!, ".oms"))).toBe(false);
  });
});
