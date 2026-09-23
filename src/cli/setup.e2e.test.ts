import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { writeApprovedVault } from "../kernel/templates/approved-vault-fixture.js";

/**
 * Setup end to end, against the built CLI.
 *
 * Setup proposes an empty version 4 policy. It adopts no template, writes no
 * note, and publishes only after the user approves the exact digest its own dry
 * run printed.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function vault(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-setup-e2e-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.join(root, relative, ".."), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  return root;
}

function runSetupCli(args: readonly string[]) {
  if (!existsSync(distCli)) {
    throw new Error("dist/cli/oms.js is missing; run npm run build before setup CLI tests.");
  }
  return spawnSync(process.execPath, [distCli, "setup", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, OMS_NO_UPDATE_NOTICE: "1" },
  });
}

function parse(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function tree(root: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await tree(root, relative));
    else result[relative] = await readFile(path.join(root, relative), "utf8");
  }
  return result;
}

describe("oms setup end to end", () => {
  it("shows an empty version 4 proposal and writes nothing", async () => {
    const root = await vault({ "notes/existing.md": "Existing note.\n" });
    const before = await tree(root);

    const dryRun = runSetupCli(["--vault", root, "--dry-run"]);

    expect(dryRun.status).toBe(0);
    const proposal = parse(dryRun.stdout);
    expect(proposal.questionnaire).toMatchObject({
      policyVersion: 4,
      properties: [],
      templates: [],
      nextStep: "interview",
    });
    expect(proposal.approvalDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(await tree(root)).toEqual(before);
  });

  it("reports folder hints without adopting a template or reading its syntax", async () => {
    const source = "---\ntitle: <%* throw new Error(\"executed\") %>\n---\nbody\n";
    const root = await vault({
      "Templates/note.md": source,
      ".obsidian/templates.json": JSON.stringify({ folder: "Templates" }),
    });

    const dryRun = runSetupCli(["--vault", root, "--dry-run"]);

    expect(dryRun.status).toBe(0);
    const questionnaire = parse(dryRun.stdout).questionnaire as Record<string, unknown>;
    const hints = questionnaire.templateFolderHints as { readonly path: string }[];
    expect(hints.map(hint => hint.path)).toContain("Templates");
    // A hint is an observation: no template is adopted and no syntax is executed.
    expect(questionnaire.templates).toEqual([]);
    expect(await readFile(path.join(root, "Templates", "note.md"), "utf8")).toBe(source);
  });

  it("refuses to publish without the digest its dry run printed", async () => {
    const root = await vault();
    const before = await tree(root);

    const forged = runSetupCli(["--vault", root, "--yes", "--approved-digest", `sha256:${"0".repeat(64)}`]);

    expect(forged.status).toBe(1);
    expect(await tree(root)).toEqual(before);
    expect(existsSync(path.join(root, ".oms", "template-policy.json"))).toBe(false);
  });

  it("refuses to apply without an approval digest at all", async () => {
    const root = await vault();
    const applied = runSetupCli(["--vault", root, "--yes"]);
    expect(applied.status).toBe(1);
    expect(existsSync(path.join(root, ".oms", "template-policy.json"))).toBe(false);
  });

  it("publishes the empty contract through the approved digest", async () => {
    const root = await vault({ "notes/existing.md": "Existing note.\n" });
    const dryRun = runSetupCli(["--vault", root, "--dry-run"]);
    expect(dryRun.status).toBe(0);
    const approvalDigest = parse(dryRun.stdout).approvalDigest as string;

    const applied = runSetupCli(["--vault", root, "--yes", "--approved-digest", approvalDigest]);

    expect(applied.status).toBe(0);
    const policy = JSON.parse(await readFile(path.join(root, ".oms", "template-policy.json"), "utf8")) as Record<string, unknown>;
    expect(policy.version).toBe(4);
    expect(policy.templates).toEqual({});
    expect(await readFile(path.join(root, ".oms", "templates", "default.md"), "utf8")).toBe("");
    // The publication touches controls only; the ordinary note is untouched.
    expect(await readFile(path.join(root, "notes", "existing.md"), "utf8")).toBe("Existing note.\n");
  });

  it("leaves an already approved contract byte-identical", async () => {
    const root = await vault();
    await writeApprovedVault(root, {
      properties: { status: { type: "text", intent: "Workflow state." } },
      templates: { note: { fields: ["status"], targetFolder: "notes" } },
      folders: { notes: { intent: "Notes." } },
    });
    const before = await tree(root);

    const dryRun = runSetupCli(["--vault", root, "--dry-run"]);
    expect(dryRun.status).toBe(0);
    const approvalDigest = parse(dryRun.stdout).approvalDigest as string;
    const applied = runSetupCli(["--vault", root, "--yes", "--approved-digest", approvalDigest]);

    expect(applied.status).toBe(0);
    // Setup never replaces an approved contract with the empty one.
    expect(await tree(root)).toEqual(before);
  });

  it("ignores legacy YAML instead of migrating it", async () => {
    const yaml = "folders: {}\n";
    const root = await vault({ ".oms/taxonomy.yaml": yaml });

    const dryRun = runSetupCli(["--vault", root, "--dry-run"]);
    expect(dryRun.status).toBe(0);
    const approvalDigest = parse(dryRun.stdout).approvalDigest as string;
    expect(runSetupCli(["--vault", root, "--yes", "--approved-digest", approvalDigest]).status).toBe(0);

    expect(await readFile(path.join(root, ".oms", "taxonomy.yaml"), "utf8")).toBe(yaml);
    expect(JSON.parse(await readFile(path.join(root, ".oms", "taxonomy.json"), "utf8"))).toMatchObject({ templates: {}, folders: {} });
  });
});
