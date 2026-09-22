import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalPathKey,
  deriveManagedSourcePath,
  deriveTemplateSourcePath,
  isTemplateSourceInFolder,
  normalizeManagedTemplatePath,
  normalizeTemplateControlPath,
  normalizeTemplateFolderPath,
  normalizeTemplateSourcePath,
  selectTemplateFolder,
  validateTemplateId,
  verifyManagedTemplatePath,
  verifyTemplateControlPath,
  verifyTemplateSourcePath,
  type TemplateControlPath,
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

  it("accepts NFC Unicode letters and digits while retaining the hyphen grammar", () => {
    expect(validateTemplateId("한글-노트")).toBe("한글-노트");
    expect(validateTemplateId("café-2024")).toBe("café-2024");
    expect(validateTemplateId("cafe\u0301-2024")).toBe("café-2024");
    expect(validateTemplateId("part--2")).toBe("part--2");
    expect(() => validateTemplateId("part---2")).toThrow(/TEMPLATE_SOURCE_INVALID/);
    expect(() => validateTemplateId("한글/노트")).toThrow(/TEMPLATE_SOURCE_INVALID/);
  });

  it("keeps a registered-existing source in its explicit registered folder", () => {
    const sourceFolder = normalizeTemplateFolderPath("External");
    const sourcePath = normalizeTemplateSourcePath("External/existing.md");
    expect(deriveTemplateSourcePath({ destinationClass: "registered-existing", templateId: validateTemplateId("existing"), sourceFolder, sourcePath })).toBe(sourcePath);
    expect(isTemplateSourceInFolder(sourcePath, sourceFolder)).toBe(true);
    expect(isTemplateSourceInFolder(normalizeTemplateSourcePath("Externality/existing.md"), sourceFolder)).toBe(false);
  });

  it("selects an explicit registered folder without requiring a default", () => {
    const registered = { path: normalizeTemplateFolderPath("Templates/Manual") };
    expect(selectTemplateFolder([registered], registered.path)).toBe(registered);
    expect(() => selectTemplateFolder([registered])).toThrow("TEMPLATE_FOLDER_DEFAULT_UNDECLARED");
    expect(() => selectTemplateFolder([registered], normalizeTemplateFolderPath("Templates/Missing"))).toThrow("TEMPLATE_SOURCE_INVALID");
  });

  it("resolves an omitted selection only to the declared default", () => {
    const generated = { path: normalizeTemplateFolderPath("Templates/Generated") };
    const curated = { path: normalizeTemplateFolderPath("Templates/Curated"), default: true as const };
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
    expect(normalizeTemplateControlPath(".oms/template-interview.json")).toBe(".oms/template-interview.json");
    expect(() => normalizeTemplateControlPath(".oms/taxonomy.yaml")).toThrow(/TEMPLATE_SOURCE_UNSAFE/);
    expect(() => normalizeTemplateControlPath(".oms/other.json")).toThrow(/TEMPLATE_SOURCE_UNSAFE/);
    expect(() => normalizeTemplateControlPath(".oms/template-migration.json")).toThrow(/TEMPLATE_SOURCE_UNSAFE/);
    expect(() => normalizeTemplateControlPath(".oms/.template-transactions/task/../../note.md")).toThrow(/TEMPLATE_SOURCE_UNSAFE/);
    expect(normalizeTemplateControlPath(".oms/.template-transactions/task/policy.json")).toBe(".oms/.template-transactions/task/policy.json");
  });

  it("confines managed drafts to the approved internal namespace", () => {
    expect(normalizeManagedTemplatePath(".oms/templates/default.md")).toBe(".oms/templates/default.md");
    expect(normalizeManagedTemplatePath(".oms\\templates\\한글-노트.md")).toBe(".oms/templates/한글-노트.md");
    for (const candidate of ["Notes/note.md", ".oms/types.json", ".oms/templates/../note.md", ".oms/templates/.md", ".oms/templates/a/b.md", "/.oms/templates/note.md", ".oms/templates/note.MD"]) {
      expect(() => normalizeManagedTemplatePath(candidate)).toThrow(/TEMPLATE_SOURCE_(?:UNSAFE|INVALID)/);
    }
  });

  it("verifies managed drafts without creating missing controls or drafts", async () => {
    const root = await mkdtemp(join(tmpdir(), "oms-managed-path-"));
    roots.push(root);
    const draft = ".oms/templates/default.md";
    expect((await verifyManagedTemplatePath(root, draft, { expected: "absent" })).targetRealPath).toBeNull();
    await expect(verifyManagedTemplatePath(root, draft)).rejects.toThrow("must exist");
    await mkdir(join(root, ".oms", "templates"), { recursive: true });
    await writeFile(join(root, draft), "approved");
    expect((await verifyManagedTemplatePath(root, draft)).absolutePath).toBe(await realpath(join(root, draft)));
    await expect(verifyManagedTemplatePath(root, draft, { expected: "absent" })).rejects.toThrow("must be absent");
    await mkdir(join(root, ".oms/templates/folder.md"));
    await expect(verifyManagedTemplatePath(root, ".oms/templates/folder.md", { expected: "either" })).rejects.toThrow("regular file");
    await expect(verifyTemplateControlPath(root, "notes.md" as TemplateControlPath, { expected: "either" })).rejects.toThrow("approved template control");
  });

  it("rejects symlinked managed draft leaves and ancestors", async () => {
    const root = await mkdtemp(join(tmpdir(), "oms-managed-path-"));
    const outside = await mkdtemp(join(tmpdir(), "oms-managed-outside-"));
    roots.push(root, outside);
    await mkdir(join(root, ".oms/templates"), { recursive: true });
    await writeFile(join(outside, "default.md"), "outside");
    await symlink(join(outside, "default.md"), join(root, ".oms/templates/default.md"));
    await expect(verifyManagedTemplatePath(root, ".oms/templates/default.md")).rejects.toThrow("symlink");
    await rm(join(root, ".oms/templates"), { recursive: true });
    await symlink(outside, join(root, ".oms/templates"));
    await expect(verifyManagedTemplatePath(root, ".oms/templates/new.md", { expected: "absent" })).rejects.toThrow("symlink");
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
