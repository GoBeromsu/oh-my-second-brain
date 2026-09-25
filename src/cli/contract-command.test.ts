import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { digestBytes } from "../kernel/conventions/canonical.js";
import type { InterviewIO } from "../kernel/contract/interview.js";
import { PATTERN_SOURCE_LIMIT } from "../kernel/contract/pattern.js";

const { resolveEffectiveVault } = vi.hoisted(() => ({
  resolveEffectiveVault: vi.fn(async () => ({ vault: process.cwd(), source: "cwd", scope: null })),
}));
vi.mock("../kernel/link/link.js", () => ({ resolveEffectiveVault }));

import { VaultSettingsError } from "../kernel/vault/settings.js";
import { commandDiagnostic, contractUsage, runContractCommand } from "./contract-command.js";

const SECRET = "SECRET-42";
const previousHome = process.env["HOME"];
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let base: string;
let home: string;
let vault: string;

beforeEach(async () => {
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  resolveEffectiveVault.mockClear();
  base = await realpath(await mkdtemp(path.join(tmpdir(), "oms-contract-cli-")));
  home = path.join(base, "home");
  vault = path.join(base, "vault");
  await mkdir(home);
  process.env["HOME"] = home;
  await mkdir(path.join(vault, "Projects"), { recursive: true });
  await mkdir(path.join(vault, "Templates"));
  await writeFile(path.join(vault, "Templates", "Meeting.md"), `---\nstatus: open\ncode: ${SECRET}\n---\n# {{title}}\n`);
});

afterEach(async () => {
  log.mockRestore();
  error.mockRestore();
  process.exitCode = 0;
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
  await rm(base, { recursive: true, force: true });
});

function output(): Record<string, unknown> {
  return JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
}

function printed(): string {
  return [...log.mock.calls, ...error.mock.calls].map(call => String(call[0])).join("\n");
}

/** Registers Projects only and seals; everything else is declined. */
function sealingIO(): InterviewIO {
  return {
    say: () => undefined,
    ask: async question => {
      if (question.id === "folder:Projects:register" || question.id === "seal") return "y";
      if (question.id === "folder:Projects:meaning") return "project notes";
      if (question.id === "template-folder:path") return "";
      if (question.kind === "confirm") return "n";
      throw new Error(`unscripted question ${question.id}`);
    },
  };
}

describe("oms contract", () => {
  it("prints usage for no arguments (exit 1) and --help (exit 0)", async () => {
    await runContractCommand([]);
    expect(process.exitCode).toBe(1);
    expect(printed()).toContain(contractUsage());
    await runContractCommand(["status", "--help"]);
    expect(process.exitCode).toBe(0);
  });

  it("rejects bad arguments with a coded diagnostic", async () => {
    for (const argv of [["seal"], ["status", "--fix"], ["extract"], ["status", "--vault"], ["doctor", "--fix", "--fix", "--vault", vault]]) {
      await runContractCommand(argv);
      expect(process.exitCode).toBe(1);
      expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "CONTRACT_ARGS_INVALID" }] });
    }
  });

  it("refuses setup and doctor --fix against an unverified cwd target", async () => {
    for (const argv of [["setup"], ["doctor", "--fix"]]) {
      await runContractCommand(argv, { io: sealingIO() });
      expect(process.exitCode).toBe(1);
      expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "CONTRACT_ARGS_INVALID" }] });
    }
    await expect(readdir(path.join(home, ".oms"))).rejects.toThrow();
  });

  it("refuses non-interactive setup", async () => {
    await runContractCommand(["setup", "--vault", vault], { interactive: false });
    expect(process.exitCode).toBe(1);
    expect(String(error.mock.calls.at(-1)?.[0])).toContain("interactive terminal");
    await expect(readdir(path.join(home, ".oms"))).rejects.toThrow();
  });

  it("seals through setup into the temporary home, then reports status and doctor", async () => {
    await runContractCommand(["status", "--vault", vault]);
    expect(output()).toEqual({ contract: "none", findings: [{ message: "contract: none", guidance: "oms setup" }], templates: [] });

    await runContractCommand(["setup", "--vault", vault], { io: sealingIO() });
    expect(process.exitCode).toBe(0);
    expect(output()).toEqual({ status: "sealed", vaultIdCreated: true, folders: 1, properties: 0, templates: [] });
    expect(await readdir(path.join(home, ".oms", "vaults"))).toContain("index.json");

    await runContractCommand(["status", "--vault", vault]);
    expect(output()).toEqual({ contract: "sealed", findings: [{ message: "contract: sealed", guidance: null }], templates: [] });

    await runContractCommand(["doctor", "--vault", vault]);
    expect(process.exitCode).toBe(0);
    expect(output()).toEqual({
      contract: "sealed",
      findings: [{ message: "contract: sealed", guidance: null }],
      cause: null,
      recovery: null,
      unsafePatterns: [],
      staleLocks: 0,
      orphans: 0,
      transportFailures: { total: 0, kinds: {} },
      unexpectedControlFiles: [],
    });

    await runContractCommand(["doctor", "--fix", "--vault", vault]);
    expect(output()).toEqual({ status: "nothing-to-fix" });
    expect(printed()).not.toContain(SECRET);
    expect(printed()).not.toContain(home);
  });

  it("exits 1 from doctor on a row that needs attention", async () => {
    await runContractCommand(["setup", "--vault", vault], { io: sealingIO() });
    await writeFile(path.join(home, ".oms", "vaults", "index.json"), "{not json");
    await runContractCommand(["doctor", "--vault", vault]);
    expect(process.exitCode).toBe(1);
    expect(output()).toMatchObject({ contract: "sealed", findings: [{ message: "index unreadable" }] });
    await runContractCommand(["doctor", "--fix", "--vault", vault]);
    expect(output()).toEqual({ status: "reindexed" });
  });

  it("AC16: doctor names the unreadable cause and guides to oms setup, and lists unexpected control files", async () => {
    await runContractCommand(["setup", "--vault", vault], { io: sealingIO() });
    const root = path.join(home, ".oms", "vaults");
    const generation = (await readdir(root)).find(entry => /^\.[0-9a-f-]+\.\d+$/.test(entry))!;
    await writeFile(path.join(root, generation, "folders.json"), "{\"version\":1,\"folders\":{}}\n");
    await writeFile(path.join(vault, ".oms", "leftover.json"), "{}");

    await runContractCommand(["doctor", "--vault", vault]);
    expect(process.exitCode).toBe(1);
    expect(output()).toMatchObject({
      contract: "unreadable",
      cause: "manifest-mismatch",
      recovery: "oms setup",
      staleLocks: 0,
      orphans: 0,
      unexpectedControlFiles: [{ path: ".oms/leftover.json", kind: "unexpected-control-file" }],
    });
    expect(printed()).not.toContain(home);
    expect(printed()).not.toContain(generation);
  });

  it("doctor names a sealed pattern the seal screen now refuses by field and kind only and guides to oms setup", async () => {
    await runContractCommand(["setup", "--vault", vault], { io: sealingIO() });
    const root = path.join(home, ".oms", "vaults");
    const generation = path.join(root, (await readdir(root)).find(entry => /^\.[0-9a-f-]+\.\d+$/.test(entry))!);
    const legacy = `${SECRET}${"x".repeat(PATTERN_SOURCE_LIMIT)}`;
    const properties = `${JSON.stringify({ version: 1, properties: { code: { meaning: "", type: "text", default: false, required: false, rules: [{ kind: "pattern", regex: legacy }] } } })}\n`;
    await writeFile(path.join(generation, "properties.json"), properties);
    const manifest = JSON.parse(await readFile(path.join(generation, "manifest.json"), "utf8")) as { files: Record<string, string> };
    manifest.files["properties.json"] = digestBytes(properties);
    await writeFile(path.join(generation, "manifest.json"), `${JSON.stringify(manifest)}\n`);

    await runContractCommand(["doctor", "--vault", vault]);
    expect(process.exitCode).toBe(1);
    expect(output()).toMatchObject({
      contract: "sealed",
      cause: null,
      recovery: "oms setup",
      unsafePatterns: [{ field: "properties.code", kind: "pattern-unsafe" }],
    });
    expect(printed()).not.toContain(SECRET);
  });

  it("refuses an answers file inside the vault whose name starts with two dots", async () => {
    const file = path.join(vault, "..answers.json");
    await writeFile(file, JSON.stringify({ seal: true }));
    await runContractCommand(["setup", "--answers", file, "--vault", vault], { interactive: false });
    expect(process.exitCode).toBe(1);
    expect(printed()).toContain("keep the answers file outside the vault");
    await expect(readdir(path.join(home, ".oms"))).rejects.toThrow();
  });

  it("extracts shapes without printing literal values", async () => {
    await runContractCommand(["extract", "--template", "Templates/Meeting.md", "--vault", vault]);
    expect(process.exitCode).toBe(0);
    const result = output();
    expect(result["status"]).toBe("extracted");
    expect(result["fields"]).toEqual([
      { name: "code", type: expect.any(String), variable: null, literal: true },
      { name: "status", type: expect.any(String), variable: null, literal: true },
    ]);
    expect(printed()).not.toContain(SECRET);
  });

  it("refuses a template outside the vault", async () => {
    await runContractCommand(["extract", "--template", "../outside.md", "--vault", vault]);
    expect(process.exitCode).toBe(1);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "CONTRACT_ARGS_INVALID" }] });
  });

  it("reports a vault that cannot be resolved by a fixed code without its paths", async () => {
    resolveEffectiveVault.mockRejectedValueOnce(new Error(`[oms] Vault folder does not exist: ${home}/private`));
    await runContractCommand(["status"]);
    expect(process.exitCode).toBe(1);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "CONTRACT_VAULT_UNRESOLVED" }] });
    expect(printed()).not.toContain(home);
  });

  it("reports a filesystem failure by its errno only, with a cause-specific remediation", async () => {
    await writeFile(path.join(home, ".oms"), "not a directory");
    await runContractCommand(["setup", "--vault", vault], { io: sealingIO() });
    expect(process.exitCode).toBe(1);
    const diagnostic = (output()["diagnostics"] as Array<{ code: string; remediation: string }>)[0]!;
    expect(diagnostic.code).toBe("CONTRACT_FS_ERROR");
    expect(diagnostic.remediation).toMatch(/^E[A-Z]+: /);
    expect(printed()).not.toContain(home);
  });

  it("passes coded vault-settings and unsafe-source messages through and hides raw errors", () => {
    const settings = new VaultSettingsError("VAULT_SETTINGS_INVALID", "templateFolder must be a string");
    expect(commandDiagnostic(settings)).toEqual({ code: "VAULT_SETTINGS_INVALID", remediation: settings.message });
    expect(commandDiagnostic(new TypeError("TEMPLATE_SOURCE_UNSAFE: parent segments are not allowed")).code).toBe("TEMPLATE_SOURCE_UNSAFE");
    const denied = Object.assign(new Error(`EACCES: permission denied, open '${home}/.oms/vaults/index.json'`), { code: "EACCES" });
    expect(commandDiagnostic(denied)).toEqual({ code: "CONTRACT_FS_ERROR", remediation: expect.stringMatching(/^EACCES: Permission denied/) });
    expect(JSON.stringify(commandDiagnostic(denied))).not.toContain(home);
    expect(commandDiagnostic(new Error(`boom at ${home}`))).toEqual({ code: "CONTRACT_COMMAND_FAILED", remediation: expect.not.stringContaining(home) });
  });

  it("exits 1 from doctor on a sealed vault whose id another indexed vault shares", async () => {
    await runContractCommand(["setup", "--vault", vault], { io: sealingIO() });
    const copy = path.join(base, "copy");
    await cp(vault, copy, { recursive: true });
    await runContractCommand(["doctor", "--fix", "--vault", copy]);
    expect(output()).toEqual({ status: "reindexed" });
    await runContractCommand(["doctor", "--vault", vault]);
    expect(process.exitCode).toBe(1);
    expect(output()).toMatchObject({ contract: "sealed", findings: [{ message: "contract: sealed" }, { message: "vault id shared" }] });
  });

  it("accepts --reask for setup only and seals with it", async () => {
    await runContractCommand(["status", "--reask", "--vault", vault]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "CONTRACT_ARGS_INVALID" }] });
    await runContractCommand(["setup", "--reask", "--reask", "--vault", vault], { io: sealingIO() });
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "CONTRACT_ARGS_INVALID" }] });
    await runContractCommand(["setup", "--reask", "--vault", vault], { io: sealingIO() });
    expect(process.exitCode).toBe(0);
    expect(output()).toMatchObject({ status: "sealed" });
  });

  it("accepts --questions and --answers for setup only, once each and not together", async () => {
    const answers = path.join(base, "answers.json");
    await writeFile(answers, "{}");
    for (const argv of [
      ["status", "--questions", "--vault", vault],
      ["doctor", "--answers", answers, "--vault", vault],
      ["setup", "--questions", "--questions", "--vault", vault],
      ["setup", "--answers", answers, "--answers", answers, "--vault", vault],
      ["setup", "--answers", "--vault", vault],
      ["setup", "--questions", "--answers", answers, "--vault", vault],
    ]) {
      await runContractCommand(argv);
      expect(process.exitCode).toBe(1);
      expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "CONTRACT_ARGS_INVALID" }] });
    }
    await runContractCommand(["setup", "--questions"]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "CONTRACT_ARGS_INVALID" }] });
    await expect(readdir(path.join(home, ".oms"))).rejects.toThrow();
  });

  it("seals from scripted answers without a terminal and never prints a template literal", async () => {
    await runContractCommand(["setup", "--questions", "--vault", vault], { interactive: false });
    expect(process.exitCode).toBe(0);
    expect(output()).toMatchObject({ status: "questions" });
    await expect(readdir(path.join(home, ".oms"))).rejects.toThrow();

    type Asked = { id: string; kind: string; choices?: string[]; default?: string };
    const answers: Record<string, unknown> = {};
    const file = path.join(base, "answers.json");
    let asked = (output() as { questions: Asked[] }).questions;
    for (let round = 0; round < 20 && asked.length > 0; round += 1) {
      for (const question of asked) {
        answers[question.id] = question.id === "seal" ? true : question.kind === "confirm" ? false : question.default ?? question.choices?.[0] ?? "";
      }
      await writeFile(file, JSON.stringify(answers));
      process.exitCode = 0;
      await runContractCommand(["setup", "--answers", file, "--vault", vault], { interactive: false });
      const result = output() as { status: string; questions?: Asked[] };
      asked = result.status === "incomplete" ? result.questions ?? [] : [];
    }
    expect(process.exitCode).toBe(0);
    expect(output()).toMatchObject({ status: "sealed" });
    expect(printed()).not.toContain(SECRET);
  });
});
