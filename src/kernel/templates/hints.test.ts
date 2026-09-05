import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguredTemplatePaths, proposeTemplateFolders } from "./hints.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeVault(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "oms-template-hints-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

describe("loadConfiguredTemplatePaths", () => {
  it("loads every Obsidian and Templater source with explicit, merged provenance", async () => {
    const root = await makeVault({
      ".obsidian/templates.json": JSON.stringify({ folder: "Shared" }),
      ".obsidian/plugins/templater-obsidian/data.json": JSON.stringify({
        templates_folder: "Shared",
        folder_templates: [{ folder: "Journal", template: "Files/daily.md" }],
        file_templates: [
          { regexp: ".*", template: "Files/daily.md" },
          { regexp: "special", template: "Files/special.md" },
        ],
        startup_templates: ["Files/start.md", "Files/daily.md"],
      }),
    });

    await expect(loadConfiguredTemplatePaths(root)).resolves.toEqual([
      {
        path: "Files/daily.md",
        kind: "file",
        provenance: ["templater-file-templates", "templater-folder", "templater-startup"],
      },
      { path: "Files/special.md", kind: "file", provenance: ["templater-file-templates"] },
      { path: "Files/start.md", kind: "file", provenance: ["templater-startup"] },
      { path: "Shared", kind: "folder", provenance: ["obsidian-core", "templater-folder"] },
    ]);
  });

  it("fails loudly with the config filename and field for malformed settings", async () => {
    const root = await makeVault({
      ".obsidian/plugins/templater-obsidian/data.json": JSON.stringify({ startup_templates: "startup.md" }),
    });
    await expect(loadConfiguredTemplatePaths(root)).rejects.toThrow(
      /TEMPLATE_HINT_RESOLUTION_FAILED.*data\.json.*startup_templates must be a list/,
    );
  });

  it("rejects traversal, absolute paths, and configured symlink escapes", async () => {
    const traversal = await makeVault({
      ".obsidian/templates.json": JSON.stringify({ folder: "../outside" }),
    });
    await expect(loadConfiguredTemplatePaths(traversal)).rejects.toThrow(/unsafe path/);

    const absolute = await makeVault({
      ".obsidian/templates.json": JSON.stringify({ folder: "/tmp/outside" }),
    });
    await expect(loadConfiguredTemplatePaths(absolute)).rejects.toThrow(/unsafe path/);

    const outside = await mkdtemp(path.join(os.tmpdir(), "oms-template-hints-outside-"));
    roots.push(outside);
    const escaped = await makeVault({
      ".obsidian/templates.json": JSON.stringify({ folder: "linked/templates" }),
    });
    await symlink(outside, path.join(escaped, "linked"));
    await expect(loadConfiguredTemplatePaths(escaped)).rejects.toThrow(/outside the vault through a symlink/);
  });
});

describe("proposeTemplateFolders", () => {
  it("merges structured explicit and saved-v3 selections without reading policy", async () => {
    const root = await makeVault({
      ".obsidian/templates.json": JSON.stringify({ folder: "Shared" }),
    });
    const result = await proposeTemplateFolders(root, {
      selected: [
        { path: "Shared", provenance: "explicit" },
        { path: "Shared", provenance: "stored-v3" },
      ],
    });
    expect(result.candidates).toContainEqual({
      path: "Shared",
      provenance: ["explicit", "obsidian-core", "stored-v3"],
    });
  });

  it("uses containing folders for configured files and merges candidate provenance", async () => {
    const root = await makeVault({
      ".obsidian/plugins/templater-obsidian/data.json": JSON.stringify({
        folder_templates: [{ folder: "Journal", template: "Shared/daily.md" }],
        file_templates: [{ regexp: ".*", template: "Shared/daily.md" }],
        startup_templates: ["Shared/start.md"],
      }),
    });
    const result = await proposeTemplateFolders(root);
    expect(result.candidates).toContainEqual({
      path: "Shared",
      provenance: ["templater-file-templates", "templater-folder", "templater-startup"],
    });
  });

  it("discovers plausible folders and template-like markdown without inventing default directories", async () => {
    const root = await makeVault({
      "Snippets/plain.md": "ordinary note",
      "Prompts/daily.md": "<% tp.date.now() %>",
      "Cards/meeting.template.md": "Meeting",
      "Notes/ordinary.md": "---\ntitle: ordinary\n---\n",
      ".obsidian/Hidden/template.md": "{{ignored}}",
      "node_modules/Templates/package.md": "{{ignored}}",
    });
    await mkdir(path.join(root, "My Templates"), { recursive: true });

    const result = await proposeTemplateFolders(root);
    expect(result.candidates).toEqual([
      { path: "Cards", provenance: ["vault-walk"] },
      { path: "My Templates", provenance: ["vault-walk"] },
      { path: "Prompts", provenance: ["vault-walk"] },
    ]);
    expect(result.candidates.some((candidate) => candidate.path === "Templates")).toBe(false);
    expect(result.candidates.some((candidate) => candidate.path === "Notes")).toBe(false);
  });

  it("reports broken walk entries and creates no vault state", async () => {
    const root = await makeVault({ "Notes/ordinary.md": "ordinary" });
    await symlink(path.join(root, "missing"), path.join(root, "broken-link"));
    const before = await readdir(root);

    const result = await proposeTemplateFolders(root);

    expect(result.diagnostics).toContainEqual({
      path: "broken-link",
      code: "TEMPLATE_HINT_READ_FAILED",
      message: expect.any(String),
    });
    expect(await readdir(root)).toEqual(before);
    await expect(readFile(path.join(root, ".oms", "engine-store.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a vault-walk symlink that escapes the vault", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "oms-template-hints-walk-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "template.md"), "{{value}}");
    const root = await makeVault();
    await symlink(path.join(outside, "template.md"), path.join(root, "external.md"));
    await expect(proposeTemplateFolders(root)).rejects.toThrow(/outside the vault through a symlink/);
  });
});
