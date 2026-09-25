import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguredTemplatePaths } from "./template-paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeVault(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "oms-template-paths-"));
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

    const outside = await mkdtemp(path.join(os.tmpdir(), "oms-template-paths-outside-"));
    roots.push(outside);
    const escaped = await makeVault({
      ".obsidian/templates.json": JSON.stringify({ folder: "linked/templates" }),
    });
    await symlink(outside, path.join(escaped, "linked"));
    await expect(loadConfiguredTemplatePaths(escaped)).rejects.toThrow(/outside the vault through a symlink/);
  });
});
