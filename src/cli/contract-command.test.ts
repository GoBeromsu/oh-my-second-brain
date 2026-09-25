import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InterviewIO } from "../kernel/contract/interview.js";

const { resolveEffectiveVault } = vi.hoisted(() => ({
  resolveEffectiveVault: vi.fn(async () => ({ vault: process.cwd(), source: "cwd", scope: null })),
}));
vi.mock("../kernel/link/link.js", () => ({ resolveEffectiveVault }));

import { contractUsage, runContractCommand } from "./contract-command.js";

const roots: string[] = [];
const previousRoot = process.env["OMS_CONTRACT_STORE_ROOT"];
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let store: string;
let vault: string;

beforeEach(async () => {
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  resolveEffectiveVault.mockClear();
  store = await mkdtemp(path.join(tmpdir(), "oms-contract-cli-store-"));
  vault = await mkdtemp(path.join(tmpdir(), "oms-contract-cli-vault-"));
  roots.push(store, vault);
  process.env["OMS_CONTRACT_STORE_ROOT"] = path.join(store, "vaults");
  await mkdir(path.join(vault, "Templates"), { recursive: true });
  await writeFile(path.join(vault, "Templates", "Meeting.md"), "---\nstatus: open\ncode: SECRET-42\n---\n# {{title}}\n");
});

afterEach(async () => {
  log.mockRestore();
  error.mockRestore();
  process.exitCode = 0;
  if (previousRoot === undefined) delete process.env["OMS_CONTRACT_STORE_ROOT"];
  else process.env["OMS_CONTRACT_STORE_ROOT"] = previousRoot;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function output(): any {
  return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
}

function printed(): string {
  return log.mock.calls.map(call => String(call[0])).join("\n");
}

/** Answers by question id; otherwise yes / first option / accept the draft. */
function scripted(script: Record<string, string> = {}): InterviewIO {
  return {
    async ask(question) {
      const answer = script[question.id];
      if (answer !== undefined) return answer;
      if (question.kind === "confirm") return "y";
      if (question.kind === "choice") return "1";
      return "";
    },
    say() {},
  };
}

const MEETING_ANSWERS = {
  "field:status:literal": "one-of-allowed",
  "field:status:allowed": "open, closed",
  "field:code:literal": "must-equal",
};

async function sealMeeting(): Promise<void> {
  await runContractCommand(["interview", "--template", "Templates/Meeting.md", "--vault", vault], { io: scripted(MEETING_ANSWERS) });
  expect(output()).toMatchObject({ status: "sealed", template: { id: "Templates/Meeting.md", name: "Meeting" } });
}

describe("oms contract", () => {
  it("prints usage for --help and for a missing subcommand", async () => {
    await runContractCommand(["--help"]);
    expect(log).toHaveBeenLastCalledWith(contractUsage());
    expect(process.exitCode).toBe(0);
    await runContractCommand([]);
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [["bogus"], /unknown subcommand bogus/],
    [["interview", "--vault", "/v"], /exactly one of --template <path> or --common/],
    [["interview", "--common", "--template", "T.md", "--vault", "/v"], /exactly one of/],
    [["interview", "--template"], /--template requires a value/],
    [["status", "--common"], /unknown argument --common/],
    [["status", "--vault", "/a", "--vault", "/b"], /duplicate flag --vault/],
    [["interview", "--template", "../Outside.md", "--vault", "/v"], /inside the vault/],
  ])("rejects invalid arguments %j", async (argv, message) => {
    await runContractCommand(argv, { io: scripted() });
    expect(process.exitCode).toBe(1);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "CONTRACT_ARGS_INVALID", remediation: expect.stringMatching(message) }] });
  });

  it("refuses the interview without a terminal and writes nothing", async () => {
    await runContractCommand(["interview", "--common", "--vault", vault], { interactive: false });
    expect(process.exitCode).toBe(1);
    expect(String(error.mock.calls.at(-1)?.[0])).toMatch(/needs an interactive terminal/);
    expect(await readdir(vault)).toEqual(["Templates"]);
    expect(await readdir(store)).toEqual([]);
  });

  it("refuses writing subcommands on the read-only current-directory fallback", async () => {
    for (const argv of [["interview", "--common"], ["reissue-id"]]) {
      await runContractCommand(argv, { io: scripted() });
      expect(process.exitCode).toBe(1);
      expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "CONTRACT_ARGS_INVALID", remediation: expect.stringMatching(/requires --vault/) }] });
    }
  });

  it("seals a template from scripted IO and reports status without hidden values", async () => {
    await sealMeeting();
    expect(process.exitCode).toBe(0);
    expect(output().vaultIdCreated).toBe(true);

    await runContractCommand(["status", "--vault", vault]);
    expect(process.exitCode).toBe(0);
    expect(output()).toMatchObject({
      vault,
      contract: { vault: "ok", location: "same", common: "none", templates: [{ id: "Templates/Meeting.md", name: "Meeting", state: "active" }] },
    });
    expect(printed()).not.toContain("SECRET-42");
    expect(printed()).not.toContain("closed");
    expect(await readFile(path.join(vault, ".oms", "contract-public.json"), "utf8")).not.toContain("SECRET-42");
  });

  it("reports a refused or aborted interview with exit code 1", async () => {
    await runContractCommand(["interview", "--template", "Templates/Meeting.md", "--vault", vault], {
      io: scripted({ ...MEETING_ANSWERS, "field:code:description": "Always SECRET-42." }),
    });
    expect(process.exitCode).toBe(1);
    expect(output()).toMatchObject({ status: "refused", reasons: [expect.stringMatching(/`code` contains a hidden value/)] });

    await runContractCommand(["interview", "--template", "Templates/Meeting.md", "--vault", vault], { io: scripted({ ...MEETING_ANSWERS, seal: "n" }) });
    expect(process.exitCode).toBe(1);
    expect(output()).toEqual({ status: "aborted", remediation: "Nothing was sealed." });
    expect(await readdir(store)).toEqual([]);
  });

  it("accepts an absolute template path inside the vault", async () => {
    await runContractCommand(["interview", "--template", path.join(vault, "Templates", "Meeting.md"), "--vault", vault], { io: scripted(MEETING_ANSWERS) });
    expect(output()).toMatchObject({ status: "sealed", template: { id: "Templates/Meeting.md" } });
  });

  it("reports no contract for an untouched vault", async () => {
    await runContractCommand(["status", "--vault", vault]);
    expect(output().contract).toMatchObject({ vault: "no-contract", templates: [], common: "none" });
    expect(await readdir(vault)).toEqual(["Templates"]);
  });

  it("reissues the vault id and keeps the sealed rules readable", async () => {
    await sealMeeting();
    const previous = (await readFile(path.join(vault, ".oms", "vault-id"), "utf8")).trim();
    await runContractCommand(["reissue-id", "--vault", vault]);
    expect(process.exitCode).toBe(0);
    const reissued = output();
    expect(reissued).toMatchObject({ status: "reissued", previousVaultId: previous });
    expect(reissued.vaultId).not.toBe(previous);
    expect((await readFile(path.join(vault, ".oms", "vault-id"), "utf8")).trim()).toBe(reissued.vaultId);
    expect((await readdir(path.join(store, "vaults"))).sort()).toEqual([previous, reissued.vaultId].sort());

    await runContractCommand(["status", "--vault", vault]);
    expect(output().contract).toMatchObject({ vault: "ok", location: "same", templates: [{ state: "active" }] });
  });

  it("refuses to reissue a vault without an id", async () => {
    await runContractCommand(["reissue-id", "--vault", vault]);
    expect(process.exitCode).toBe(1);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "CONTRACT_VAULT_ID_UNAVAILABLE" }] });
  });
});
