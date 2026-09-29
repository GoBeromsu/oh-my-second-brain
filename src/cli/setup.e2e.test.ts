import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { serializeVaultSettings, SETTINGS_PATH } from "../kernel/vault/settings.js";

/**
 * `oms setup` end to end, against the built CLI.
 *
 * Setup is the interactive seal (same as `oms setup`). The retired
 * approval-token flags are refused with the command that owns each concern,
 * and a non-terminal invocation is refused. None of these paths write to the
 * vault or to the (temporary) home store. The interview itself is exercised
 * in-process by contract-command.test.ts with scripted IO. The agent path
 * (`--questions`, then `--answers`) runs here against a temporary HOME.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ readonly home: string; readonly vault: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-setup-e2e-"));
  roots.push(root);
  const home = path.join(root, "home");
  const vault = path.join(root, "vault");
  await mkdir(home);
  await mkdir(path.join(vault, "notes"), { recursive: true });
  await writeFile(path.join(vault, "notes", "alpha.md"), "---\ntitle: Alpha\n---\n# Alpha\n");
  return { home, vault };
}

function runCli(home: string, args: readonly string[], input = "") {
  if (!existsSync(distCli)) throw new Error("dist/cli/oms.js is missing; run npm run build before setup CLI tests.");
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      OMS_NO_UPDATE_NOTICE: "1",
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      OMS_RUNTIME_ROOT: path.join(home, ".oms", "runtime", "v1"),
    },
  });
}

async function listing(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  return entries.map(String).sort();
}

const RETIRED: readonly (readonly [string, RegExp])[] = [
  ["--dry-run", /no dry-run/],
  ["--yes", /no approval flags/],
  ["--approval-token", /no approval flags/],
  ["--approved-digest", /no approval flags/],
  ["--install-claude", /oms setup host install/],
  ["--models-default", /oms setup model install --default/],
  ["--models-descriptor", /oms setup model install --descriptor/],
  ["--models-no-default", /oms setup model waive --yes/],
  ["--template-folder", /templateFolder/],
];

describe("oms setup end to end", () => {
  it("prints setup usage", async () => {
    const { home } = await fixture();
    const result = runCli(home, ["setup", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: oms setup [--reask] [--vault <path>]");
    expect(result.stdout).toContain("oms setup --answers <file|->");
    expect(result.stdout).toContain("oms setup");
  });

  it("refuses every retired approval-token flag with its owning command and writes nothing", async () => {
    const { home, vault } = await fixture();
    const before = await listing(vault);
    for (const [flag, guidance] of RETIRED) {
      const result = runCli(home, ["setup", "--vault", vault, flag]);
      expect(result.status, flag).toBe(1);
      expect(result.stderr, flag).toContain(`setup option ${flag} was removed.`);
      expect(result.stderr, flag).toMatch(guidance);
    }
    expect(await listing(vault)).toEqual(before);
    expect(existsSync(path.join(home, ".oms", "vaults"))).toBe(false);
  });

  it("refuses a non-terminal setup and interview without sealing or issuing settings", async () => {
    const { home, vault } = await fixture();
    const before = await listing(vault);
    for (const args of [["setup", "--vault", vault], ["interview", "--vault", vault]]) {
      const result = runCli(home, args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toContain("needs an interactive terminal");
    }
    expect(await listing(vault)).toEqual(before);
    expect(existsSync(path.join(vault, ".oms"))).toBe(false);
    expect(existsSync(path.join(home, ".oms", "vaults"))).toBe(false);
    expect(await readFile(path.join(vault, "notes", "alpha.md"), "utf8")).toBe("---\ntitle: Alpha\n---\n# Alpha\n");
  });

  describe("agent setup with --questions and --answers", () => {
    const VAULT_ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
    const HIDDEN = "zebra-hidden-value";
    const MEETING = `---\nstatus: ${HIDDEN}\n---\n## Agenda\n`;
    const FIRST = {
      "folder:Projects:register": true,
      "folder:Projects:meaning": "project notes",
      "folder:Projects:search-exclude": false,
      "folder:Templates:register": false,
      "folder:notes:register": false,
      "property:status:register": true,
      "property:status:type": "",
      "property:status:required": true,
      "property:status:rule": "none",
      "property:status:meaning": "workflow state",
      seal: true,
    };

    async function agentVault(): Promise<{
      readonly home: string;
      readonly vault: string;
      readonly answersFile: (answers: object) => Promise<string>;
    }> {
      const { home, vault } = await fixture();
      await mkdir(path.join(vault, "Projects"));
      await mkdir(path.join(vault, "Templates"));
      await mkdir(path.join(vault, ".oms"));
      await mkdir(path.join(vault, ".obsidian"));
      await writeFile(path.join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID, templateFolder: "Templates" }));
      await writeFile(path.join(vault, ".obsidian", "types.json"), JSON.stringify({ types: { status: "text" } }));
      await writeFile(path.join(vault, "Templates", "Meeting.md"), MEETING);
      let count = 0;
      const answersFile = async (answers: object): Promise<string> => {
        const file = path.join(path.dirname(vault), `answers-${count++}.json`);
        await writeFile(file, JSON.stringify(answers));
        return file;
      };
      return { home, vault, answersFile };
    }

    function json(result: { readonly stdout: string }): Record<string, unknown> {
      return JSON.parse(result.stdout) as Record<string, unknown>;
    }

    async function storeFiles(home: string): Promise<string[]> {
      const store = path.join(home, ".oms", "vaults");
      return existsSync(store) ? listing(store) : [];
    }

    it("prints the first questions without a terminal, asks nothing about a template, and seals nothing", async () => {
      const { home, vault } = await agentVault();
      const result = runCli(home, ["setup", "--questions", "--vault", vault]);
      expect(result.status, result.stderr).toBe(0);
      const output = json(result);
      expect(output["status"]).toBe("questions");
      expect((output["questions"] as { id: string }[]).map(question => question.id)).toEqual([
        "folder:Projects:register",
        "folder:Templates:register",
        "folder:notes:register",
        "property:status:register",
        "seal",
      ]);
      expect(result.stdout).not.toContain(HIDDEN);
      expect(await storeFiles(home)).toEqual([]);
    });

    it("seals a fresh vault as a version 3 generation of folders and properties, with no templates", async () => {
      const { home, vault, answersFile } = await agentVault();
      const first = runCli(home, ["setup", "--answers", await answersFile(FIRST), "--vault", vault]);
      expect(first.status, first.stdout + first.stderr).toBe(0);
      const output = json(first);
      expect(output).toEqual({ status: "sealed", vaultIdCreated: false, folders: 1, properties: 1 });
      expect(first.stdout).not.toContain(HIDDEN);

      const files = await storeFiles(home);
      const manifests = files.filter(file => file.endsWith("manifest.json"));
      expect(manifests.length).toBeGreaterThan(0);
      for (const manifest of manifests) {
        const parsed = JSON.parse(await readFile(path.join(home, ".oms", "vaults", manifest), "utf8")) as { version: number; files: Record<string, string> };
        expect(parsed.version).toBe(3);
        expect(Object.keys(parsed.files).sort()).toEqual(["declined.json", "folders.json", "properties.json"]);
      }
      expect(files.filter(file => file.split(path.sep).includes("templates"))).toEqual([]);
    });

    it("reseals after a template changes without asking about it, and refuses a template answer as unknown", async () => {
      const { home, vault, answersFile } = await agentVault();
      expect(runCli(home, ["setup", "--answers", await answersFile(FIRST), "--vault", vault]).status).toBe(0);

      await writeFile(path.join(vault, "Templates", "Meeting.md"), `${MEETING}## Notes\n`);
      const questions = runCli(home, ["setup", "--questions", "--vault", vault]);
      expect(questions.status, questions.stderr).toBe(0);
      // Nothing new since the seal: a changed template is not a question.
      expect((json(questions)["questions"] as { id: string }[]).map(question => question.id)).toEqual(["seal"]);
      expect(questions.stdout).not.toContain(HIDDEN);

      const resealed = runCli(home, ["setup", "--answers", await answersFile({ seal: true }), "--vault", vault]);
      expect(resealed.status, resealed.stdout + resealed.stderr).toBe(0);
      expect(json(resealed)).toEqual({ status: "sealed", vaultIdCreated: false, folders: 1, properties: 1 });

      const sealedFiles = await storeFiles(home);
      const templateAnswer = runCli(home, ["setup", "--answers", await answersFile({ "template:Meeting:remove": true, seal: true }), "--vault", vault]);
      expect(templateAnswer.status, templateAnswer.stdout + templateAnswer.stderr).toBe(1);
      const refused = json(templateAnswer);
      expect(refused["status"]).toBe("rejected");
      expect(refused["diagnostics"]).toEqual([expect.objectContaining({ code: "CONTRACT_ANSWER_UNKNOWN" })]);
      expect(templateAnswer.stdout + templateAnswer.stderr).not.toContain(HIDDEN);
      expect(await storeFiles(home)).toEqual(sealedFiles);
    });

    it("refuses invalid, unknown, malformed and in-vault answers and seals nothing", async () => {
      const { home, vault, answersFile } = await agentVault();
      const cases: readonly (readonly [readonly string[], string, string?])[] = [
        [["--answers", await answersFile({ ...FIRST, "property:status:rule": "sometimes" })], "CONTRACT_ANSWER_INVALID"],
        [["--answers", await answersFile({ ...FIRST, "folder:Nowhere:register": true })], "CONTRACT_ANSWER_UNKNOWN"],
        [["--answers", "-"], "CONTRACT_ANSWERS_INVALID", "not json"],
        [["--answers", await answersFile(["not", "an", "object"])], "CONTRACT_ANSWERS_INVALID"],
        [["--answers", path.join(vault, "missing.json")], "CONTRACT_ANSWERS_INVALID"],
        [["--answers", "--questions"], "CONTRACT_ARGS_INVALID"],
        [["--questions", "--answers", "-"], "CONTRACT_ARGS_INVALID"],
        // Setup takes no template interpretations any more.
        [["--answers", await answersFile(FIRST), "--interpretations", "-"], "CONTRACT_ARGS_INVALID"],
      ];
      for (const [flags, code, input] of cases) {
        const result = runCli(home, ["setup", ...flags, "--vault", vault], input);
        expect(result.status, flags.join(" ")).toBe(1);
        const output = json(result);
        expect(output["status"], flags.join(" ")).toBe("rejected");
        expect((output["diagnostics"] as { code: string }[])[0]?.code, flags.join(" ")).toBe(code);
      }
      await writeFile(path.join(vault, "answers.json"), JSON.stringify(FIRST));
      const inside = runCli(home, ["setup", "--answers", path.join(vault, "answers.json"), "--vault", vault]);
      expect(inside.status).toBe(1);
      expect(inside.stdout).toContain("keep the answers file outside the vault");
      expect(await storeFiles(home)).toEqual([]);
    });

    it("lists what is still unanswered and reads answers from stdin", async () => {
      const { home, vault } = await agentVault();
      const partial = runCli(home, ["setup", "--answers", "-", "--vault", vault], JSON.stringify({ "folder:Projects:register": true }));
      expect(partial.status).toBe(1);
      const output = json(partial);
      expect(output["status"]).toBe("incomplete");
      expect((output["questions"] as { id: string }[]).map(question => question.id)).toContain("folder:Projects:meaning");
      expect(await storeFiles(home)).toEqual([]);

      const full = runCli(home, ["setup", "--answers", "-", "--vault", vault], JSON.stringify(FIRST));
      expect(full.status, full.stdout).toBe(0);
      expect(json(full)["status"]).toBe("sealed");
    });
  });
});
