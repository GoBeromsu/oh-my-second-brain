import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestBytes } from "../templates/canonical.js";
import { parseTemplatePolicy } from "../templates/policy.js";
import { writeApprovedVault } from "../templates/approved-vault-fixture.js";
import { applySetup, composeSetup, decideNonInteractiveSetup, emptyTemplatePolicy, inspectSetup, publishSetupModels } from "./service.js";

const roots: string[] = [];
let previousRuntime: string | undefined;

beforeEach(() => { previousRuntime = process.env.OMS_RUNTIME_ROOT; });
afterEach(async () => {
  if (previousRuntime === undefined) delete process.env.OMS_RUNTIME_ROOT;
  else process.env.OMS_RUNTIME_ROOT = previousRuntime;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function emptyVault(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-setup-"));
  roots.push(root);
  process.env.OMS_RUNTIME_ROOT = join(root, "runtime");
  const vault = join(root, "vault");
  await mkdir(vault, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(join(vault, relative, ".."), { recursive: true });
    await writeFile(join(vault, relative), content);
  }
  return vault;
}

describe("setup proposal", () => {
  it("proposes an empty always-on default layer and no templates", async () => {
    const vault = await emptyVault();
    const state = await inspectSetup({ vault });
    expect(state.policy.version).toBe(4);
    expect(Object.keys(state.policy.properties)).toEqual([]);
    expect(Object.keys(state.policy.templates)).toEqual([]);
    expect(state.policy.default.approvedMarkdown).toBe("");
    expect(state.document.questionnaire).toMatchObject({
      policyVersion: 4,
      defaultLayer: { templatePath: ".oms/templates/default.md", fields: [], headings: [], semanticCriteria: [] },
      properties: [],
      templates: [],
      nextStep: "interview",
    });
  });

  it("reports folder observations as raw hints without adopting any template", async () => {
    const vault = await emptyVault({
      "Templates/note.md": "---\ntitle: <% tp.file.title %>\n---\nBody\n",
      ".obsidian/templates.json": JSON.stringify({ folder: "Templates" }),
    });
    const state = await inspectSetup({ vault });
    expect(state.templateFolderCandidates.map(candidate => candidate.path)).toContain("Templates");
    // A hint is an observation, not a selection: no template was adopted.
    expect(Object.keys(state.policy.templates)).toEqual([]);
    expect(state.document.questionnaire.templateFolderHints.map(hint => hint.path)).toContain("Templates");
  });

  it("does not read or execute template syntax while inspecting", async () => {
    const source = "---\ntitle: <%* throw new Error(\"executed\") %>\n---\n";
    const vault = await emptyVault({ "Templates/danger.md": source });
    await inspectSetup({ vault });
    expect(await readFile(join(vault, "Templates", "danger.md"), "utf8")).toBe(source);
  });

  it("creates nothing on disk while inspecting", async () => {
    const vault = await emptyVault();
    await inspectSetup({ vault });
    expect(await readdir(vault)).toEqual([]);
  });
});

describe("setup publication", () => {
  it("dry-runs the approval manifest without writing the vault", async () => {
    const vault = await emptyVault();
    const decision = await decideNonInteractiveSetup(await inspectSetup({ vault }));
    const manifest = await composeSetup(decision);

    expect(manifest.controls.map(control => control.path)).toEqual([
      ".oms/template-policy.json",
      ".oms/taxonomy.json",
      ".oms/types.json",
    ]);
    expect(manifest.drafts.map(draft => draft.path)).toEqual([".oms/templates/default.md"]);
    // Ordinary notes and raw sources are never publication outputs.
    expect(manifest.outputs.every(output => output.finalVaultRelativePath.startsWith(".oms/"))).toBe(true);

    const receipt = await applySetup(decision, manifest, { dryRun: true });
    expect(receipt.status).toBe("planned");
    expect(await readdir(vault)).toEqual([]);
  });

  it("publishes the empty policy only with the exact approved digest", async () => {
    const vault = await emptyVault();
    const decision = await decideNonInteractiveSetup(await inspectSetup({ vault }));
    const manifest = await composeSetup(decision);

    const forged = await applySetup(decision, manifest, { approvedDigest: digestBytes("not the approval") });
    expect(forged.status).toBe("rejected");
    expect(await readdir(vault)).toEqual([]);

    const receipt = await applySetup(decision, manifest, { approvedDigest: manifest.approvalDigest });
    expect(receipt.status).toBe("applied");
    const policy = parseTemplatePolicy(await readFile(join(vault, ".oms", "template-policy.json"), "utf8"));
    expect(policy.version).toBe(4);
    expect(Object.keys(policy.templates)).toEqual([]);
    expect(await readFile(join(vault, ".oms", "templates", "default.md"), "utf8")).toBe("");
  });

  it("refuses to replace an approved contract that already exists", async () => {
    const vault = await emptyVault();
    await writeApprovedVault(vault, {
      properties: { status: { type: "text", intent: "Workflow state." } },
      templates: { note: { fields: ["status"], targetFolder: "notes" } },
      folders: { notes: { intent: "Notes." } },
    });
    const before = await readFile(join(vault, ".oms", "template-policy.json"), "utf8");

    const decision = await decideNonInteractiveSetup(await inspectSetup({ vault }));
    const manifest = await composeSetup(decision);
    // Every existing control is verify-only, so an approved vault is preserved.
    expect(manifest.controls.every(control => control.action === "verify-only")).toBe(true);
    const receipt = await applySetup(decision, manifest, { approvedDigest: manifest.approvalDigest });
    expect(receipt.status).not.toBe("rejected");
    expect(await readFile(join(vault, ".oms", "template-policy.json"), "utf8")).toBe(before);
  });

  it("never writes an ordinary note during setup", async () => {
    const vault = await emptyVault({ "notes/one.md": "Existing note.\n" });
    const decision = await decideNonInteractiveSetup(await inspectSetup({ vault }));
    const manifest = await composeSetup(decision);
    await applySetup(decision, manifest, { approvedDigest: manifest.approvalDigest });
    expect(await readFile(join(vault, "notes", "one.md"), "utf8")).toBe("Existing note.\n");
  });

  it("refuses to publish model selections before an approved, applied transaction", async () => {
    const vault = await emptyVault();
    const decision = await decideNonInteractiveSetup(await inspectSetup({ vault }));
    const config = { version: 1 as const, embedding: { provider: "gguf", model: "test-model" } };
    await expect(publishSetupModels(decision, { status: "planned" } as never, { dryRun: true }, config as never))
      .rejects.toThrow(/SETUP_APPROVAL_MISMATCH/);
  });
});

describe("empty policy", () => {
  it("is a valid v4 policy with an empty approved default draft", () => {
    const policy = emptyTemplatePolicy();
    expect(policy.default.approvedMarkdownDigest).toBe(digestBytes(""));
    expect(policy.default.fields).toEqual({});
    expect(policy.default.headings).toEqual([]);
  });
});
