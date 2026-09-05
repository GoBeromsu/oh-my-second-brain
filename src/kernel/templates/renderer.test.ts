import { describe, expect, it } from "vitest";
import { parseDerivedProjection, parseTemplatePolicy, serializeDerivedProjection, serializeTemplatePolicy } from "./policy.js";
import { classifyTemplateRenderer } from "./renderer.js";

const bytes = (value: string): Uint8Array => Buffer.from(value);

describe("template renderer classification", () => {
  it("classifies Core Templates-only input and returns its extracted contract", () => {
    const result = classifyTemplateRenderer("Templates/core.md", bytes("---\ntitle: '{{title}}'\ncreated: '{{date:YYYY-MM-DD}}'\n---\n{{time}}\n"));
    expect(result).toMatchObject({ renderer: "obsidian-core", filledBy: [], bodyExternal: false, diagnostics: [] });
    expect(result.template?.keyOrder).toEqual(["title", "created"]);
  });

  it("classifies quoted Templater tags without converting host-owned proposal bytes", () => {
    const result = classifyTemplateRenderer("Templates/templater.md", bytes('---\ntitle: "<% tp.file.title %>"\ncreated: "<% tp.date.now(\\"YYYY-MM-DD\\") %>"\nclock: \'<% tp.date.now("HH:mm:ss") %>\'\n---\n# <% tp.file.title %> at <% tp.date.now("HH:mm") %>\n'));
    expect(result.renderer).toBe("templater");
    expect(result.filledBy).toEqual(["title", "created", "clock"]);
    expect(result.bodyExternal).toBe(true);
    expect(result.template?.frontmatter).toMatchObject({
      title: "<% tp.file.title %>",
      created: '<% tp.date.now("YYYY-MM-DD") %>',
      clock: '<% tp.date.now("HH:mm:ss") %>',
    });
    expect(result.template?.body).toBe('# <% tp.file.title %> at <% tp.date.now("HH:mm") %>\n');
  });

  it("keeps mixed and unsupported Templater programs external without executing them", () => {
    const mixed = classifyTemplateRenderer("Templates/mixed.md", bytes('---\ntitle: "<% tp.file.title %>"\nowner: "{{title}}"\n---\n<% tp.system.prompt() %>\n'));
    expect(mixed).toMatchObject({ renderer: "templater", bodyExternal: true });
    expect(mixed.template?.frontmatter.owner).toBe("{{title}}");
    expect(mixed.template?.body).toBe("<% tp.system.prompt() %>\n");
  });

  it("keeps malformed and unmatched Templater delimiters external rather than safe literals", () => {
    const frontmatter = classifyTemplateRenderer("Templates/unmatched.md", bytes('---\ntitle: "<% tp.file.title"\n---\nbody\n'));
    expect(frontmatter).toMatchObject({ renderer: "templater", filledBy: ["title"], bodyExternal: false });
    expect(frontmatter.template?.frontmatter.title).toBe("<% tp.file.title");
    const body = classifyTemplateRenderer("Templates/unmatched-body.md", bytes("---\ntitle: literal\n---\n%> unmatched\n"));
    expect(body).toMatchObject({ renderer: "templater", bodyExternal: true });
  });

  it("preserves invalid Core expression and malformed YAML diagnostics", () => {
    const expression = classifyTemplateRenderer("Templates/invalid-expression.md", bytes("---\ncreated: '{{date:YYYY[year]}}'\n---\nbody\n"));
    expect(expression).toMatchObject({
      renderer: "obsidian-core",
      diagnostics: [{ code: "TEMPLATE_EXPRESSION_UNSUPPORTED", path: "Templates/invalid-expression.md", field: "created", message: "{{date:YYYY[year]}}" }],
    });
    expect(expression.template).toBeUndefined();

    const yaml = classifyTemplateRenderer("Templates/invalid-yaml.md", bytes("---\ntitle: [unclosed\n---\nbody\n"));
    expect(yaml.renderer).toBe("obsidian-core");
    expect(yaml.diagnostics).toEqual([
      expect.objectContaining({ code: "TEMPLATE_SOURCE_INVALID", path: "Templates/invalid-yaml.md" }),
    ]);
    expect(yaml.diagnostics[0]?.message).toContain("frontmatter must be a valid YAML mapping");
  });

  it("marks malformed external delimiters recursively in nested frontmatter values", () => {
    const result = classifyTemplateRenderer("Templates/nested-external.md", bytes("---\nmetadata:\n  generated:\n    - '%> unmatched'\n---\nbody\n"));
    expect(result).toMatchObject({ renderer: "templater", filledBy: ["metadata"], bodyExternal: false });
  });

  it("rejects more than 64 observed fields without truncating", () => {
    const fields = Array.from({ length: 65 }, (_, index) => `field-${index}: value`).join("\n");
    const result = classifyTemplateRenderer("Templates/wide.md", bytes(`---\n${fields}\n---\nbody\n`));
    expect(result).toEqual({ renderer: "none", filledBy: [], bodyExternal: false, diagnostics: [{ code: "TEMPLATE_PROPOSAL_OVERSIZE", path: "Templates/wide.md" }] });
  });

  it("classifies missing-frontmatter and script-first files as none", () => {
    for (const source of ["plain text\n", "<%* const x = 1 %>\n---\ntitle: value\n---\n"]) {
      const result = classifyTemplateRenderer("Templates/unobserved.md", bytes(source));
      expect(result.renderer).toBe("none");
      expect(result.template).toBeUndefined();
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "TEMPLATE_CONTRACT_UNOBSERVED" }));
    }
  });

  it("rejects oversize proposals without truncating or parsing", () => {
    const result = classifyTemplateRenderer("Templates/large.md", new Uint8Array(262_145));
    expect(result).toEqual({ renderer: "none", filledBy: [], bodyExternal: false, diagnostics: [{ code: "TEMPLATE_PROPOSAL_OVERSIZE", path: "Templates/large.md" }] });
  });

  it("normalizes an absent policy renderer to the documented baseline and always serializes it", () => {
    const parsed = parseTemplatePolicy({
      version: 3,
      templateFolders: [{ path: "Templates", mode: "manual", default: true }],
      base: { fields: { created: { type: "date", filledBy: "obsidian", owner: "vault" } } },
      contracts: { note: { intent: "note", fields: {}, views: [] } },
      templates: { note: { templateId: "note", destinationClass: "managed-default", sourceFolder: "Templates", sourcePath: "Templates/note.md", contract: "note", naming: "{{title}}" } },
    });
    expect(parsed.templates.note?.renderer).toBe("obsidian-core");
    expect(parsed.base.fields.created).toMatchObject({ filledBy: "obsidian", extensions: { owner: "vault" } });
    expect(JSON.parse(serializeTemplatePolicy(parsed)).templates.note.renderer).toBe("obsidian-core");
  });

  it.each(["obsidian-core", "templater", "none"] as const)("round-trips %s as managed projection data", renderer => {
    const projection = {
      version: "oms.types.v1" as const,
      generatedFrom: { algorithm: "sha256-lp-v1" as const, inputSignature: `sha256:${"a".repeat(64)}`, sources: [] },
      managed: {
        base: { fields: {} },
        globalAxes: {},
        templates: {
          note: {
            templateId: "note",
            destinationClass: "registered-existing" as const,
            renderer,
            sourcePath: "Templates/note.md",
            targetFolder: "Notes",
            keyOrder: [],
            fields: {},
            views: [],
            naming: "{{title}}",
            bodySignature: `sha256:${"b".repeat(64)}`,
          },
        },
      },
    };
    const parsed = parseDerivedProjection(projection);
    expect(parsed.managed.templates.note?.renderer).toBe(renderer);
    expect(parsed.managed.templates.note?.extensions).toBeUndefined();
    expect(parseDerivedProjection(serializeDerivedProjection(parsed))).toEqual(parsed);
  });

  it("rejects an invalid managed projection renderer", () => {
    expect(() => parseDerivedProjection({
      version: "oms.types.v1",
      generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: `sha256:${"a".repeat(64)}`, sources: [] },
      managed: {
        base: { fields: {} },
        globalAxes: {},
        templates: {
          note: {
            templateId: "note", destinationClass: "registered-existing", renderer: "host-script",
            sourcePath: "Templates/note.md", targetFolder: "Notes", keyOrder: [], fields: {}, views: [],
            naming: "{{title}}", bodySignature: `sha256:${"b".repeat(64)}`,
          },
        },
      },
    })).toThrow(/PROJECTION_INVALID.*renderer/);
  });
});
