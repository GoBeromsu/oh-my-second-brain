import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runContractCommand } from "../../src/cli/contract-command.js";
import { interpretVault } from "../../src/kernel/contract/interpretation-fixture.js";
import type { InterviewIO, Question } from "../../src/kernel/contract/interview.js";
import { readVaultSettings } from "../../src/kernel/vault/settings.js";

// slice f2: move to templateFolder — the answered Meeting template is reported as not stored.
const NOT_STORED = "CONTRACT_TEMPLATES_NOT_STORED: template answers are not stored until templates move to templateFolder";

/**
 * `oms setup --vault` finding the template folder from the vault's Obsidian
 * settings, with a temporary HOME. The CLI binary refuses a non-interactive terminal, so
 * the command runs in process with a scripted IO in place of the terminal.
 */

const previousHome = process.env["HOME"];
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let base: string;
let home: string;
let vault: string;

beforeEach(async () => {
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  base = await realpath(await mkdtemp(path.join(tmpdir(), "oms-template-discovery-")));
  home = path.join(base, "home");
  vault = path.join(base, "vault");
  await mkdir(home);
  process.env["HOME"] = home;
  await mkdir(path.join(vault, ".obsidian", "plugins", "templater-obsidian"), { recursive: true });
  await mkdir(path.join(vault, "Templates"));
  await writeFile(path.join(vault, "Templates", "Meeting.md"), "---\nstatus: open\n---\nbody\n");
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

/** Answers by id and records every question asked; folders and properties are declined. */
function scripted(answers: Readonly<Record<string, string>>): InterviewIO & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    say: () => undefined,
    ask: async (question: Question) => {
      asked.push(question.id);
      const answer = answers[question.id];
      if (answer !== undefined) return answer;
      if (question.kind === "confirm" && /^(folder|property):/.test(question.id)) return "n";
      throw new Error(`unscripted question ${question.id}`);
    },
  };
}

const TEMPLATE_ANSWERS = {
  "template:Meeting:interpretation": "y",
  "template:Meeting:register": "y",
  "template:Meeting:field:status:required": "n",
  "template:Meeting:field:status:literal": "example-only",
  "template:Meeting:apply-folder": "",
  "seal": "y",
} as const;

/**
 * The agent's half of the seal: OMS no longer reads template text, so the interview needs
 * an interpretation of every source it enumerated. The fixture plays the agent.
 */
async function interpreting(): Promise<readonly string[]> {
  const file = path.join(base, "interpretations.json");
  await writeFile(file, JSON.stringify(await interpretVault(vault, "Templates")));
  return ["--interpretations", file];
}

async function setup(io: InterviewIO, flags: readonly string[] = []): Promise<Record<string, unknown>> {
  await runContractCommand(["setup", ...flags, "--vault", vault], { io });
  return output();
}

describe("oms setup template-folder discovery", () => {
  it("offers the folder named by .obsidian/templates.json and seals its templates once confirmed", async () => {
    expect(homedir()).toBe(home);
    await writeFile(path.join(vault, ".obsidian", "templates.json"), JSON.stringify({ folder: "Templates" }));
    const io = scripted({ ...TEMPLATE_ANSWERS, "template-folder:confirm": "" });
    expect(await setup(io, await interpreting())).toEqual({ status: "sealed", vaultIdCreated: true, folders: 0, properties: 0, templates: [], warnings: [NOT_STORED] });
    expect(process.exitCode).toBe(0);
    expect(io.asked).toContain("template-folder:confirm");
    expect(io.asked).not.toContain("template-folder:path");
    expect((await readVaultSettings(vault))?.templateFolder).toBe("Templates");
    expect(await readdir(path.join(home, ".oms", "vaults"))).toContain("index.json");

    await runContractCommand(["status", "--vault", vault]);
    // A version 3 seal keeps no templates, so none is reported as legacy.
    expect(output()).toMatchObject({ contract: "sealed", legacyTemplates: 0 });
  });

  it("offers the Templater folder, with its slashes trimmed, when the core plugin names none", async () => {
    await writeFile(path.join(vault, ".obsidian", "plugins", "templater-obsidian", "data.json"), JSON.stringify({ templates_folder: "/Templates/" }));
    const io = scripted({ ...TEMPLATE_ANSWERS, "template-folder:confirm": "y" });
    expect(await setup(io, await interpreting())).toMatchObject({ status: "sealed", templates: [], warnings: [NOT_STORED] });
    expect(io.asked).not.toContain("template-folder:path");
    expect((await readVaultSettings(vault))?.templateFolder).toBe("Templates");
  });

  it("asks for the folder when no Obsidian template setting exists, and seals none on an empty answer", async () => {
    const io = scripted({ "template-folder:path": "", "seal": "y" });
    expect(await setup(io)).toEqual({ status: "sealed", vaultIdCreated: true, folders: 0, properties: 0, templates: [] });
    expect(io.asked).not.toContain("template-folder:confirm");
    expect(io.asked).toContain("template-folder:path");
    expect((await readVaultSettings(vault))?.templateFolder).toBeUndefined();
  });

  it.each([
    ["a folder that does not exist", JSON.stringify({ folder: "Missing" })],
    ["a hidden folder", JSON.stringify({ folder: ".obsidian" })],
    ["a folder outside the vault", JSON.stringify({ folder: "../outside" })],
    ["a file instead of a folder", JSON.stringify({ folder: "Templates/Meeting.md" })],
    ["a non-string folder", JSON.stringify({ folder: 42 })],
    ["malformed JSON", "{ folder: Templates"],
  ])("never offers %s from templates.json and asks for the folder instead", async (_case, settings) => {
    await mkdir(path.join(base, "outside"));
    await writeFile(path.join(vault, ".obsidian", "templates.json"), settings);
    const io = scripted({ ...TEMPLATE_ANSWERS, "template-folder:path": "Templates" });
    expect(await setup(io, await interpreting())).toMatchObject({ status: "sealed", templates: [], warnings: [NOT_STORED] });
    expect(io.asked).not.toContain("template-folder:confirm");
    expect(io.asked.filter(id => id === "template-folder:path")).toHaveLength(1);
    expect((await readVaultSettings(vault))?.templateFolder).toBe("Templates");
  });

  it("falls through a malformed templates.json to a configured Templater folder", async () => {
    await writeFile(path.join(vault, ".obsidian", "templates.json"), "not json");
    await writeFile(path.join(vault, ".obsidian", "plugins", "templater-obsidian", "data.json"), JSON.stringify({ templates_folder: "Templates" }));
    const io = scripted({ ...TEMPLATE_ANSWERS, "template-folder:confirm": "" });
    expect(await setup(io, await interpreting())).toMatchObject({ status: "sealed", templates: [], warnings: [NOT_STORED] });
    expect(io.asked).not.toContain("template-folder:path");
  });

  it("asks for another folder when the owner declines the configured one", async () => {
    await writeFile(path.join(vault, ".obsidian", "templates.json"), JSON.stringify({ folder: "Templates" }));
    const io = scripted({ "template-folder:confirm": "n", "template-folder:path": "", "seal": "y" });
    expect(await setup(io)).toMatchObject({ status: "sealed", templates: [] });
    expect(io.asked).toEqual(expect.arrayContaining(["template-folder:confirm", "template-folder:path"]));
    expect((await readVaultSettings(vault))?.templateFolder).toBeUndefined();
  });
});
