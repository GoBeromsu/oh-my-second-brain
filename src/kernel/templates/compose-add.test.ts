import { describe, expect, it } from "vitest";
import { composeTemplateAdd, starterTemplateBytes } from "./compose-add.js";
import type { TemplateFolderRegistration } from "./types.js";

const folders = [{ path: "Custom", mode: "auto", default: true }, { path: "Other", mode: "manual" }] as unknown as readonly TemplateFolderRegistration[];
const encoder = new TextEncoder();
const request = { templateId: "note", bytes: starterTemplateBytes("note"), contract: "base", naming: "{{date}}-{{slug}}.md" };

describe("composeTemplateAdd", () => {
  it("derives a managed path inside the default folder and returns a write proposal", () => {
    const composed = composeTemplateAdd(folders, request);
    expect(composed.binding).toEqual({ templateId: "note", destinationClass: "managed-default", renderer: "obsidian-core", sourceFolder: "Custom", sourcePath: "Custom/note.md", contract: "base", naming: "{{date}}-{{slug}}.md" });
    expect(composed.source).toMatchObject({ path: "Custom/note.md", publication: "write" });
    expect(composed.template.frontmatter).toEqual({ template: "note" });
    expect(composed.template.contentMarker).toBe(true);
  });
  it("targets an explicitly selected registered folder without needing a default", () => {
    const composed = composeTemplateAdd(folders.filter(folder => folder.default !== true), { ...request, sourceFolder: "Other" });
    expect(composed.binding.sourceFolder).toBe("Other");
    expect(composed.binding.sourcePath).toBe("Other/note.md");
  });
  it("classifies a custom path inside the folder as registered-existing", () => {
    const composed = composeTemplateAdd(folders, { ...request, sourcePath: "Custom/nested/Note Draft.md" });
    expect(composed.binding).toMatchObject({ destinationClass: "registered-existing", sourcePath: "Custom/nested/Note Draft.md" });
  });
  it.each([
    ["unregistered folder", { ...request, sourceFolder: "Elsewhere" }, /not a registered template folder/],
    ["path outside the folder", { ...request, sourcePath: "Other/note.md" }, /outside registered folder/],
    ["missing default", { ...request }, /TEMPLATE_FOLDER_DEFAULT_UNDECLARED/, folders.filter(folder => folder.default !== true)],
    ["invalid id", { ...request, templateId: "Bad Id" }, /templateId/],
    ["blank contract", { ...request, contract: " " }, /TEMPLATE_POLICY_INVALID/],
    ["unsupported syntax", { ...request, bytes: encoder.encode("---\ntitle: <% tp.file.title %>\n---\n") }, /TEMPLATE_EXPRESSION_UNSUPPORTED/],
    ["no frontmatter", { ...request, bytes: encoder.encode("plain\n") }, /TEMPLATE_SOURCE_INVALID/],
  ])("rejects %s", (_name, input, pattern, registrations = folders) => {
    expect(() => composeTemplateAdd(registrations, input)).toThrow(pattern);
  });
  it("starter bytes validate the identity they embed", () => {
    expect(() => starterTemplateBytes("Bad Id")).toThrow(/templateId/);
    expect(new TextDecoder().decode(starterTemplateBytes("daily"))).toBe("---\ntemplate: daily\n---\n<!-- oms:content -->\n");
  });
});
