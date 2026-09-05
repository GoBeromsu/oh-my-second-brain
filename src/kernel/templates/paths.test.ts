import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalPathKey,
  deriveManagedSourcePath,
  deriveTemplateSourcePath,
  isTemplateSourceInFolder,
  normalizeTemplateControlPath,
  normalizeTemplateFolderPath,
  normalizeTemplateSourcePath,
  selectTemplateFolder,
  validateTemplateId,
  verifyTemplateSourcePath,
} from "./paths.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("template path contract", () => {
  it("normalizes canonically equivalent folder spellings to one key", () => {
    const left = normalizeTemplateFolderPath("Templates//OMS/./Daily");
    const right = normalizeTemplateFolderPath("Templates/OMS/Daily");
    expect(left).toBe(right);
    expect(canonicalPathKey(left)).toBe(canonicalPathKey(right));
  });

  it("normalizes Windows separators without changing vault-relative meaning", () => {
    expect(normalizeTemplateSourcePath("Templates\\OMS\\daily.md")).toBe("Templates/OMS/daily.md");
  });

  it("derives managed paths from configurable folder and stable identity", () => {
    expect(deriveManagedSourcePath(normalizeTemplateFolderPath("My Templates"), validateTemplateId("daily-note"))).toBe("My Templates/daily-note.md");
  });

  it("keeps a registered-existing source in its explicit registered folder", () => {
    const sourceFolder = normalizeTemplateFolderPath("External");
    const sourcePath = normalizeTemplateSourcePath("External/existing.md");
    expect(deriveTemplateSourcePath({ destinationClass: "registered-existing", templateId: validateTemplateId("existing"), sourceFolder, sourcePath })).toBe(sourcePath);
    expect(isTemplateSourceInFolder(sourcePath, sourceFolder)).toBe(true);
    expect(isTemplateSourceInFolder(normalizeTemplateSourcePath("Externality/existing.md"), sourceFolder)).toBe(false);
  });

  it("selects an explicit registered folder without requiring a default", () => {
    const manual = { path: normalizeTemplateFolderPath("Templates/Manual"), mode: "manual" as const };
    expect(selectTemplateFolder([manual], manual.path)).toBe(manual);
    expect(() => selectTemplateFolder([manual])).toThrow("TEMPLATE_FOLDER_DEFAULT_UNDECLARED");
    expect(() => selectTemplateFolder([manual], normalizeTemplateFolderPath("Templates/Missing"))).toThrow("TEMPLATE_SOURCE_INVALID");
  });

  it("resolves an omitted selection only to the declared default", () => {
    const generated = { path: normalizeTemplateFolderPath("Templates/Generated"), mode: "auto" as const };
    const curated = { path: normalizeTemplateFolderPath("Templates/Curated"), mode: "manual" as const, default: true as const };
    expect(selectTemplateFolder([generated, curated])).toBe(curated);
  });

  it("rejects parent, absolute, hidden and non-Markdown source paths", () => {
    for (const path of ["../escape.md", "/absolute.md", ".oms/types.json", "Templates/note.txt"]) {
      expect(() => normalizeTemplateSourcePath(path)).toThrow(/TEMPLATE_SOURCE_(?:UNSAFE|INVALID)/);
    }
  });

  it("allows exactly the approved internal controls, not arbitrary hidden paths", () => {
    expect(normalizeTemplateControlPath(".oms/template-policy.json")).toBe(".oms/template-policy.json");
    expect(normalizeTemplateControlPath(".oms/types.json")).toBe(".oms/types.json");
    expect(() => normalizeTemplateControlPath(".oms/taxonomy.yaml")).toThrow(/TEMPLATE_SOURCE_UNSAFE/);
    expect(() => normalizeTemplateControlPath(".oms/other.json")).toThrow(/TEMPLATE_SOURCE_UNSAFE/);
  });

  it("rejects a symlinked template source", async () => {
    const root = await mkdtemp(join(tmpdir(), "oms-template-path-"));
    const outside = await mkdtemp(join(tmpdir(), "oms-template-path-outside-"));
    roots.push(root, outside);
    await mkdir(join(root, "Templates"), { recursive: true });
    await writeFile(join(outside, "note.md"), "outside");
    await symlink(join(outside, "note.md"), join(root, "Templates", "note.md"));
    await expect(verifyTemplateSourcePath(root, normalizeTemplateSourcePath("Templates/note.md"))).rejects.toThrow(/TEMPLATE_SOURCE_UNSAFE.*symlink/);
  });
});
