import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const thrown = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../kernel/doctor/service.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../kernel/doctor/service.js")>();
  return {
    ...actual,
    repairDoctor: async (...args: Parameters<typeof actual.repairDoctor>) => {
      if (thrown.value !== undefined) throw thrown.value;
      return actual.repairDoctor(...args);
    },
  };
});

import { writeContractVault } from "../kernel/contract/contract-vault-fixture.js";
import { resolveSealState } from "../kernel/contract/vault-id.js";
import { storeRoot } from "../kernel/contract/store.js";
import { runLineageCommand } from "./lineage-command.js";

const saved = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"], OMS_VAULT: process.env["OMS_VAULT"] };
let log: ReturnType<typeof vi.spyOn>;
let base: string;
let vault: string;

beforeEach(async () => {
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  base = await realpath(await mkdtemp(path.join(tmpdir(), "oms-lineage-cli-")));
  process.env["HOME"] = path.join(base, "home");
  process.env["USERPROFILE"] = path.join(base, "home");
  delete process.env["OMS_VAULT"];
  vault = path.join(base, "vault");
  await writeContractVault(vault, {
    properties: { title: { type: "text", intent: "Note title." } },
    templates: { note: { fields: ["title"], approvedMarkdown: "---\ntemplate: note\ntitle: Untitled\n---\n\nBody\n", targetFolder: "notes" } },
    folders: { notes: { intent: "Notes." } },
    obsidianTypes: { title: "text" },
  });
});

afterEach(async () => {
  thrown.value = undefined;
  vi.restoreAllMocks();
  process.exitCode = 0;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(base, { recursive: true, force: true });
});

function output(): Record<string, unknown> {
  return JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
}

describe("oms doctor lineage-recover and lineage-reanchor", () => {
  it("prints the leaf's usage for --help and -h", async () => {
    await runLineageCommand("lineage-recover", ["--help"]);
    expect(log).toHaveBeenLastCalledWith("Usage: oms doctor lineage-recover [--vault <path>]");
    await runLineageCommand("lineage-reanchor", ["-h"]);
    expect(log).toHaveBeenLastCalledWith("Usage: oms doctor lineage-reanchor [--vault <path>]");
    expect(process.exitCode).toBe(0);
  });

  it.each([
    [["--force"], "CONTRACT_ARGS_INVALID: doctor lineage-recover received unknown argument --force"],
    [["--vault", "a", "--vault", "b"], "CONTRACT_ARGS_INVALID: duplicate flag --vault"],
    [["--vault"], "CONTRACT_ARGS_INVALID: --vault requires a value"],
    [["--vault", "--help"], "CONTRACT_ARGS_INVALID: --vault requires a value"],
  ])("rejects %j before touching the store", async (argv, remediation) => {
    await runLineageCommand("lineage-recover", argv);
    expect(process.exitCode).toBe(1);
    expect(output()).toEqual({ status: "rejected", diagnostics: [{ code: "CONTRACT_ARGS_INVALID", remediation }] });
  });

  it("repairs an explicit vault and prints the receipt", async () => {
    await runLineageCommand("lineage-reanchor", ["--vault", vault]);
    expect(process.exitCode).toBe(0);
    expect(output()).toMatchObject({ anchors: [], resolutionSource: "explicit", receipt: { operation: "lineage-reanchor", postcondition: { kind: "contract-lineage", events: 1 } } });
  });

  it("resolves the vault from OMS_VAULT when no --vault is given", async () => {
    process.env["OMS_VAULT"] = vault;
    await runLineageCommand("lineage-recover", []);
    expect(process.exitCode).toBe(0);
    expect(output()).toMatchObject({ resolvedVault: vault, receipt: { operation: "lineage-recover" } });
  });

  it("reports a vault that is not sealed as an error", async () => {
    const state = await resolveSealState(vault);
    await rm(path.join(storeRoot(), state.vaultId!));
    await runLineageCommand("lineage-recover", ["--vault", vault]);
    expect(process.exitCode).toBe(1);
    expect(output()).toEqual({ status: "error", message: expect.stringMatching(/^CONTRACT_NOT_SEALED: /) });
  });

  it("reports a failure thrown while resolving the target as a rejected diagnostic", async () => {
    const missing = path.join(base, "missing");
    await runLineageCommand("lineage-recover", ["--vault", missing]);
    expect(process.exitCode).toBe(1);
    expect(output()).toEqual({ status: "rejected", diagnostics: [{ code: "ENOENT", remediation: expect.stringContaining("no such file or directory") }] });
    expect(JSON.stringify(output())).not.toContain(base);
  });

  it("reports a non-Error failure under the generic code with its paths redacted", async () => {
    thrown.value = `store write failed at ${path.join(base, "home", ".oms", "vaults", "index.json")} and '${path.join(base, "with space", "x")}'`;
    await runLineageCommand("lineage-recover", ["--vault", vault]);
    expect(process.exitCode).toBe(1);
    expect(output()).toEqual({ status: "rejected", diagnostics: [{ code: "CONTRACT_LINEAGE_REPAIR_FAILED", remediation: "store write failed at <path> and '<path>'" }] });
  });

  it("keeps an Error's code only when its prefix is a code, and redacts its paths", async () => {
    thrown.value = new Error(`Contract lineage postcondition failed at ${path.join(base, "store")}`);
    await runLineageCommand("lineage-recover", ["--vault", vault]);
    expect(output()).toEqual({ status: "rejected", diagnostics: [{ code: "CONTRACT_LINEAGE_REPAIR_FAILED", remediation: "Contract lineage postcondition failed at <path>" }] });
    thrown.value = new Error("CONTRACT_LINEAGE_GAP: the lineage/events.jsonl chain has a gap");
    await runLineageCommand("lineage-recover", ["--vault", vault]);
    expect(output()).toEqual({ status: "rejected", diagnostics: [{ code: "CONTRACT_LINEAGE_GAP", remediation: "CONTRACT_LINEAGE_GAP: the lineage/events.jsonl chain has a gap" }] });
  });

  it("rejects a vault inferred from the working directory", async () => {
    const cwd = process.cwd();
    const elsewhere = path.join(base, "elsewhere");
    await mkdir(elsewhere);
    process.chdir(elsewhere);
    try {
      await runLineageCommand("lineage-reanchor", []);
    } finally {
      process.chdir(cwd);
    }
    expect(process.exitCode).toBe(1);
    expect(output()).toMatchObject({ status: "rejected", resolutionSource: "cwd" });
  });
});
