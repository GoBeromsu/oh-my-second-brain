import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parseNote } from "../conventions/frontmatter.js";
import { writeResolvedTemplateNote as writeResolvedTemplateNoteVerified } from "./safe.js";
import { canonicalJson } from "../templates/canonical.js";
import { loadResolvedTemplates, sourceSignature } from "../templates/resolver.js";
import { parseTemplate } from "../templates/extract.js";
import { readRuntimeEvents } from "../runtime/event-read.js";
import type { Digest, ResolvedConvention, TemplateId } from "../templates/types.js";

const roots: string[] = [];
const signature = "sha256:0000000000000000000000000000000000000000000000000000000000000000" as Digest;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

let activeConvention: ResolvedConvention | undefined;

async function emptyVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-write-"));
  roots.push(root);
  return root;
}

async function signedVault(): Promise<{ readonly root: string; readonly convention: ResolvedConvention }> {
  const root = await emptyVault();
  await Promise.all([
    mkdir(join(root, ".oms"), { recursive: true }),
    mkdir(join(root, ".obsidian"), { recursive: true }),
    mkdir(join(root, "Templates", "OMS"), { recursive: true }),
  ]);
  const policy = JSON.stringify({
    version: 3,
    templateFolders: [{ path: "Templates/OMS", mode: "manual", default: true }],
    base: { fields: { template: { type: "text", required: true, immutable: true } } },
    contracts: {
      note: {
        intent: "note",
        fields: {
          title: { type: "text", required: true, normalize: "trim" },
          created: { type: "date", default: { kind: "token", token: "today" } },
          status: { type: "select", required: true, normalize: "lower", allowedValues: ["open", "closed"] },
          source: { type: "text", format: "url" },
        },
        views: [{ name: "status", keys: ["status"] }],
      },
    },
    templates: {
      note: {
        templateId: "note",
        destinationClass: "managed-default",
        renderer: "obsidian-core",
        sourceFolder: "Templates/OMS",
        sourcePath: "Templates/OMS/note.md",
        contract: "note",
        naming: "{{date}}-{{slug}}.md",
      },
    },
  });
  const taxonomy = JSON.stringify({ templates: { note: { templateFolder: "notes" } } });
  const types = JSON.stringify({ types: { template: "text", title: "text", created: "date", status: "select", source: "text" } });
  const template = "---\ntemplate: note\ntitle: \"{{title}}\"\ncreated: \"{{date}}\"\nstatus: OPEN\nsource: https://template.invalid\n---\n# Note\n<!-- oms:content -->\n";
  const hash = (value: string): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;
  const sources = [
    { logicalId: "template-policy", signature: hash(policy) },
    { logicalId: "taxonomy", signature: hash(taxonomy) },
    { logicalId: "obsidian-types", signature: hash(types) },
    { path: "Templates/OMS/note.md", signature: hash(template) },
  ];
  const projection = JSON.stringify({
    version: "oms.types.v1",
    generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sources },
    managed: {
      base: { fields: { template: { type: "text", required: true, immutable: true } } },
      globalAxes: {},
      templates: {
        note: {
          templateId: "note",
          destinationClass: "managed-default",
          renderer: "obsidian-core",
          sourcePath: "Templates/OMS/note.md",
          targetFolder: "notes",
          keyOrder: ["template", "title", "created", "status", "source"],
          fields: {
            template: { type: "text", required: true, immutable: true },
            title: { type: "text", required: true, normalize: "trim" },
            created: { type: "date", default: { kind: "token", token: "today" } },
            status: { type: "select", required: true, normalize: "lower", allowedValues: ["open", "closed"] },
            source: { type: "text", format: "url" },
          },
          views: [{ name: "status", keys: ["status"] }],
          naming: "{{date}}-{{slug}}.md",
          bodySignature: hash("# Note\n<!-- oms:content -->\n"),
        },
      },
    },
  });
  await Promise.all([
    writeFile(join(root, ".oms", "template-policy.json"), policy),
    writeFile(join(root, ".oms", "taxonomy.json"), taxonomy),
    writeFile(join(root, ".oms", "types.json"), projection),
    writeFile(join(root, ".obsidian", "types.json"), types),
    writeFile(join(root, "Templates", "OMS", "note.md"), template),
  ]);
  return { root, convention: await loadResolvedTemplates(root) };
}

async function vault(): Promise<string> {
  const fixture = await signedVault();
  activeConvention = fixture.convention;
  return fixture.root;
}

async function tree(root: string, directory = root): Promise<readonly [string, string][]> {
  const result: [string, string][] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await tree(root, absolute));
    else result.push([absolute.slice(root.length + 1), (await readFile(absolute)).toString("hex")]);
  }
  return result.sort(([left], [right]) => left.localeCompare(right));
}

async function writeResolvedTemplateNote(
  input: Parameters<typeof writeResolvedTemplateNoteVerified>[0],
): ReturnType<typeof writeResolvedTemplateNoteVerified> {
  const desired = input.convention;
  const template = desired.templates.note!;
  if (!isDeepStrictEqual(desired, await loadResolvedTemplates(input.target.vault))) {
    const eol = template.eol === "crlf" ? "\r\n" : "\n";
    const authored = {
      template: "note",
      title: "{{title}}",
      created: "{{date}}",
      status: "OPEN",
      source: "https://template.invalid",
      ...template.frontmatterTemplate,
    };
    const yaml = template.keyOrder
      .filter(key => Object.hasOwn(authored, key))
      .map(key => `${key}: ${JSON.stringify(authored[key as keyof typeof authored])}`)
      .join(eol);
    let source = template.renderer === "none" ? "<%* host.propose()" : `---${eol}${yaml}${eol}---${eol}${template.body}`;
    if (template.finalNewline && !source.endsWith(eol)) source += eol;
    if (!template.finalNewline) source = source.replace(/(?:\r\n|\n)+$/g, "");
    if (template.bom) source = `\ufeff${source}`;
    const observed = template.renderer === "none"
      ? { keyOrder: [] as readonly string[], body: "" }
      : parseTemplate(template.sourcePath, Buffer.from(source), { renderer: template.renderer === "templater" ? "templater" : "obsidian-core" });
    const policy = JSON.stringify({
      version: 3,
      templateFolders: [{ path: "Templates/OMS", mode: "manual", default: true }],
      ...(desired.defaultTemplate === undefined ? {} : { defaultTemplate: desired.defaultTemplate }),
      base: desired.base,
      contracts: { note: { intent: "note", fields: Object.fromEntries(Object.entries(template.fields).filter(([key]) => !Object.hasOwn(desired.base.fields, key))), views: template.views } },
      templates: { note: { templateId: "note", destinationClass: template.destinationClass, renderer: template.renderer, sourceFolder: "Templates/OMS", sourcePath: template.sourcePath, contract: "note", naming: template.naming } },
    });
    const taxonomy = JSON.stringify({ templates: { note: { templateFolder: template.targetFolder } } });
    const types = JSON.stringify({ types: Object.fromEntries(Object.entries({ ...desired.base.fields, ...template.fields }).map(([key, field]) => [key, field.type])) });
    const hash = (value: string): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;
    const sources = [
      { logicalId: "template-policy", signature: hash(policy) },
      { logicalId: "taxonomy", signature: hash(taxonomy) },
      { logicalId: "obsidian-types", signature: hash(types) },
      { path: template.sourcePath, signature: hash(source) },
    ];
    const projection = JSON.stringify({
      version: "oms.types.v1",
      generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sources },
      managed: {
        base: desired.base,
        globalAxes: desired.globalAxes,
        templates: { note: {
          templateId: "note", destinationClass: template.destinationClass, renderer: template.renderer,
          sourcePath: template.sourcePath, targetFolder: template.targetFolder,
          keyOrder: observed.keyOrder, fields: template.fields,
          views: template.views, naming: template.naming,
          bodySignature: hash(observed.body),
        } },
      },
    });
    await Promise.all([
      writeFile(join(input.target.vault, ".oms", "template-policy.json"), policy),
      writeFile(join(input.target.vault, ".oms", "taxonomy.json"), taxonomy),
      writeFile(join(input.target.vault, ".oms", "types.json"), projection),
      writeFile(join(input.target.vault, ".obsidian", "types.json"), types),
      writeFile(join(input.target.vault, template.sourcePath), source),
    ]);
  }
  const convention = await loadResolvedTemplates(input.target.vault);
  activeConvention = convention;
  return writeResolvedTemplateNoteVerified({ ...input, convention });
}

function convention(naming = "{{date}}-{{slug}}.md"): ResolvedConvention {
  if (activeConvention !== undefined) {
    const template = activeConvention.templates.note!;
    return naming === template.naming
      ? activeConvention
      : { ...activeConvention, templates: { note: { ...template, naming } } };
  }
  return {
    base: { fields: { template: { type: "text", required: true, immutable: true } } },
    inputSignature: signature,
    managedSourcePaths: ["Templates/OMS/note.md"],
    globalAxes: {},
    templates: {
      note: {
        id: "note",
        destinationClass: "managed-default",
        renderer: "obsidian-core",
        sourcePath: "Templates/OMS/note.md",
        targetFolder: "notes",
        bom: false,
        eol: "lf",
        finalNewline: true,
        keyOrder: ["template", "title", "created", "status", "source"],
        fields: {
          template: { type: "text", required: true, immutable: true },
          title: { type: "text", required: true, normalize: "trim" },
          created: { type: "date", default: { kind: "token", token: "today" } },
          status: { type: "select", required: true, normalize: "lower", allowedValues: ["open", "closed"] },
          source: { type: "text", format: "url" },
        },
        frontmatterTemplate: { template: "note", status: "OPEN" },
        body: "# Note\n<!-- oms:content -->\n",
        naming,
        views: [{ name: "status", keys: ["status"] }],
        inputSignature: signature,
        templateSignature: signature,
        managedSourcePaths: ["Templates/OMS/note.md"],
      },
    },
  };
}

function createInput(root: string) {
  return {
    target: { vault: root, source: "explicit" as const },
    convention: convention(),
    templateId: "note",
    mode: "create" as const,
    body: "body text",
    resolvedAt: "2026-08-30T10:11:12.000Z",
    frontmatter: { title: "  Hello World  ", source: "https://example.test", extra: "preserved" },
  };
}

describe("template-first verified write modes", () => {
  it("records distinct external invocation history for success, dry-run, rejection, and failure", async () => {
    const root = await vault();
    const input = createInput(root);
    const dryBefore = await tree(root);
    const dry = await writeResolvedTemplateNote({ ...input, dryRun: true });
    expect(dry.status).toBe("written");
    expect(await tree(root)).toEqual(dryBefore);
    const written = await writeResolvedTemplateNote({ ...input, dryRun: false });
    expect(written.status).toBe("written");
    const rejected = await writeResolvedTemplateNote({ ...input, dryRun: false });
    expect(rejected.status).toBe("rejected");
    await expect(writeResolvedTemplateNote({
      ...input,
      dryRun: true,
      resolvedAt: "not-an-instant",
    })).resolves.toMatchObject({ status: "ask" });
    await expect(writeResolvedTemplateNoteVerified({
      target: { vault: root, source: "explicit" },
      convention: convention(),
      mode: "append",
      dryRun: false,
      notePath: written.notePath,
      body: "append before failed readback",
      readBack: async () => { throw new Error("readback failed"); },
    })).rejects.toThrow("readback failed");

    const events = readRuntimeEvents({ vaultPath: root }).events;
    expect(events.map(event => event.outcome).sort()).toEqual(["failure", "rejected", "rejected", "success", "unchanged"]);
    expect(new Set(events.map(event => event.invocationId)).size).toBe(5);
    expect(events.find(event => event.outcome === "success")).toMatchObject({
      kind: "note-write",
      templateId: "note",
      notePath: written.notePath,
      inputSignature: written.receipt?.inputSignature,
      templateSignature: written.receipt?.templateSignature,
    });
    expect(events.find(event => event.outcome === "success")?.eventTime).not.toBeNull();
    expect(events.filter(event => event.outcome !== "success").every(event => event.eventTime === null)).toBe(true);
  });

  it("keeps a successful note when the external ledger cannot append and returns a visible warning", async () => {
    const root = await vault();
    const previous = process.env.OMS_RUNTIME_ROOT;
    process.env.OMS_RUNTIME_ROOT = join(root, ".runtime-inside-vault");
    try {
      const result = await writeResolvedTemplateNote({ ...createInput(root), dryRun: false });
      expect(result.status).toBe("written");
      expect(result.runtimeWarnings?.[0]).toContain("LEDGER_APPEND_FAILED");
      expect(result.receipt?.runtimeWarnings).toEqual(result.runtimeWarnings);
      expect(await readFile(join(root, result.notePath), "utf8")).toContain("body text");
    } finally {
      if (previous === undefined) delete process.env.OMS_RUNTIME_ROOT;
      else process.env.OMS_RUNTIME_ROOT = previous;
    }
  });

  it.each(["policy", "source"] as const)("rejects same-day stale %s authority before dry-run or write", async changed => {
    const { root, convention: resolved } = await signedVault();
    if (changed === "policy") {
      const policyPath = join(root, ".oms", "template-policy.json");
      const policy = JSON.parse(await readFile(policyPath, "utf8")) as Record<string, unknown>;
      policy.extensions = { changed: true };
      await writeFile(policyPath, JSON.stringify(policy));
    } else {
      await writeFile(join(root, "Templates", "OMS", "note.md"), "---\ntitle: Changed\n---\n<!-- oms:content -->\n");
    }
    const before = await tree(root);
    for (const dryRun of [true, false]) {
      const result = await writeResolvedTemplateNoteVerified({
        target: { vault: root, source: "explicit" },
        convention: resolved,
        templateId: "note",
        mode: "create",
        dryRun,
        frontmatter: { title: "Fresh" },
        body: "body",
      });
      expect(result).toMatchObject({
        status: "rejected",
        rejection: {
          code: "contract-violation",
          remediation: "reload the resolved convention or run regenerate-types, then retry",
        },
      });
      expect(result.reason).toContain("TEMPLATE_SOURCE_DRIFT");
      expect(await tree(root)).toEqual(before);
    }
  });
  it("rejects a same-day stale resolved projection even when current authorities are internally valid", async () => {
    const { root, convention: stale } = await signedVault();
    const taxonomy = JSON.stringify({ templates: { note: { templateFolder: "daily-notes" } } });
    await writeFile(join(root, ".oms", "taxonomy.json"), taxonomy);
    const projectionPath = join(root, ".oms", "types.json");
    const projection = JSON.parse(await readFile(projectionPath, "utf8")) as {
      generatedFrom: { inputSignature: Digest; sources: Array<{ logicalId?: string; path?: string; signature: Digest }> };
      managed: { templates: { note: { targetFolder: string } } };
    };
    const taxonomySource = projection.generatedFrom.sources.find(source => source.logicalId === "taxonomy")!;
    taxonomySource.signature = `sha256:${createHash("sha256").update(taxonomy).digest("hex")}` as Digest;
    projection.generatedFrom.inputSignature = sourceSignature(projection.generatedFrom.sources);
    projection.managed.templates.note.targetFolder = "daily-notes";
    await writeFile(projectionPath, JSON.stringify(projection));
    await expect(loadResolvedTemplates(root)).resolves.toMatchObject({
      templates: { note: { targetFolder: "daily-notes" } },
    });
    const before = await tree(root);

    const result = await writeResolvedTemplateNoteVerified({
      target: { vault: root, source: "explicit" },
      convention: stale,
      templateId: "note",
      mode: "create",
      dryRun: false,
      frontmatter: { title: "Fresh" },
      body: "body",
    });
    expect(result).toMatchObject({
      status: "rejected",
      rejection: {
        code: "contract-violation",
        remediation: "reload the resolved convention and retry",
      },
    });
    expect(result.reason).toBe("TEMPLATE_SOURCE_DRIFT: supplied resolved convention does not match current template authorities");
    expect(await tree(root)).toEqual(before);
  });
  it("keeps dry-run and persisted create preparation byte-for-byte equal", async () => {
    const root = await vault();
    const dryRun = await writeResolvedTemplateNote({ ...createInput(root), dryRun: true });
    const written = await writeResolvedTemplateNote({ ...createInput(root), dryRun: false });
    expect(written.status).toBe("written");
    expect(written.prepared).toEqual(dryRun.prepared);
    expect(written.notePath).toBe("notes/2026-08-30-hello-world.md");
  });

  it("uses the declared default template when create omits templateId", async () => {
    const root = await vault();
    const current = convention();
    const withDefault: ResolvedConvention = { ...current, defaultTemplate: "note" as TemplateId };
    const result = await writeResolvedTemplateNote({
      ...createInput(root),
      convention: withDefault,
      templateId: undefined,
      dryRun: true,
    });
    expect(result).toMatchObject({
      status: "written",
      templateId: "note",
      prepared: { templateId: "note" },
    });
  });

  it("never falls back to the declared default when an explicit templateId is invalid", async () => {
    const root = await vault();
    const current = convention();
    const withDefault: ResolvedConvention = { ...current, defaultTemplate: "note" as TemplateId };
    const result = await writeResolvedTemplateNote({
      ...createInput(root),
      convention: withDefault,
      templateId: "missing",
      dryRun: true,
    });
    expect(result).toMatchObject({
      status: "rejected",
      templateId: null,
    });
    expect(result.reason).toContain("selected template missing");
  });

  it("refuses create without an explicit or declared default and does not mutate the vault", async () => {
    const root = await vault();
    const before = await tree(root);
    const result = await writeResolvedTemplateNote({
      ...createInput(root),
      templateId: undefined,
      dryRun: false,
    });
    expect(result).toMatchObject({
      status: "ask",
      reason: "TEMPLATE_DEFAULT_UNDECLARED: create requires an explicit templateId or declared defaultTemplate",
      rejection: { code: "contract-violation" },
    });
    expect(await tree(root)).toEqual(before);
  });

  it("rejects a stale default changed after resolution before choosing a template", async () => {
    const root = await vault();
    const current = convention();
    const withDefault: ResolvedConvention = { ...current, defaultTemplate: "note" as TemplateId };
    await writeResolvedTemplateNote({
      ...createInput(root),
      convention: withDefault,
      templateId: undefined,
      dryRun: true,
    });
    const stale = convention();
    const policyPath = join(root, ".oms", "template-policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as Record<string, unknown>;
    delete policy.defaultTemplate;
    const policyText = JSON.stringify(policy);
    await writeFile(policyPath, policyText);
    const projectionPath = join(root, ".oms", "types.json");
    const projection = JSON.parse(await readFile(projectionPath, "utf8")) as {
      generatedFrom: { inputSignature: Digest; sources: Array<{ logicalId?: string; path?: string; signature: Digest }> };
    };
    projection.generatedFrom.sources.find(source => source.logicalId === "template-policy")!.signature =
      `sha256:${createHash("sha256").update(policyText).digest("hex")}` as Digest;
    projection.generatedFrom.inputSignature = sourceSignature(projection.generatedFrom.sources);
    await writeFile(projectionPath, JSON.stringify(projection));
    const before = await tree(root);
    const result = await writeResolvedTemplateNoteVerified({
      ...createInput(root),
      convention: stale,
      templateId: undefined,
      dryRun: false,
    });
    expect(result).toMatchObject({
      status: "rejected",
      reason: "TEMPLATE_SOURCE_DRIFT: supplied resolved convention does not match current template authorities",
    });
    expect(await tree(root)).toEqual(before);
  });

  it("rejects an invalid default authority before note mutation", async () => {
    const root = await vault();
    const current = convention();
    const policyPath = join(root, ".oms", "template-policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as Record<string, unknown>;
    policy.defaultTemplate = "missing";
    await writeFile(policyPath, JSON.stringify(policy));
    const before = await tree(root);
    const result = await writeResolvedTemplateNoteVerified({
      ...createInput(root),
      convention: current,
      templateId: undefined,
      dryRun: false,
    });
    expect(result).toMatchObject({
      status: "rejected",
      rejection: {
        code: "contract-violation",
        remediation: "reload the resolved convention or run regenerate-types, then retry",
      },
    });
    expect(result.reason).toContain("TEMPLATE_SOURCE_DRIFT: current template authorities could not be verified");
    expect(await tree(root)).toEqual(before);
  });

  it("keeps append and update bound to persisted identity when defaultTemplate is absent", async () => {
    const root = await vault();
    const created = await writeResolvedTemplateNote({ ...createInput(root), dryRun: false });
    const appended = await writeResolvedTemplateNote({
      target: { vault: root, source: "explicit" },
      convention: convention(),
      mode: "append",
      dryRun: true,
      notePath: created.notePath,
      body: "append",
    });
    const updated = await writeResolvedTemplateNote({
      target: { vault: root, source: "explicit" },
      convention: convention(),
      mode: "update",
      dryRun: true,
      notePath: created.notePath,
      frontmatter: { status: "closed" },
    });
    expect(appended).toMatchObject({ status: "written", templateId: "note" });
    expect(updated).toMatchObject({ status: "written", templateId: "note" });
  });

  it("accepts a valid fractional field default in the authoritative convention", async () => {
    const root = await vault();
    const current = convention();
    const template = current.templates.note!;
    const fractional: ResolvedConvention = {
      ...current,
      templates: {
        note: {
          ...template,
          keyOrder: [...template.keyOrder, "confidence"],
          fields: {
            ...template.fields,
            confidence: { type: "number", default: { kind: "literal", value: 0.75 } },
          },
          frontmatterTemplate: { ...template.frontmatterTemplate, confidence: 0.75 },
        },
      },
    };
    const result = await writeResolvedTemplateNote({
      ...createInput(root),
      convention: fractional,
      dryRun: true,
    });
    expect(result).toMatchObject({ status: "written", frontmatter: { confidence: 0.75 } });
  });

  it("rejects a forged body even when it reuses authoritative signatures", async () => {
    const root = await vault();
    const current = convention();
    const forged: ResolvedConvention = {
      ...current,
      templates: {
        note: {
          ...current.templates.note!,
          body: "forged body\n",
        },
      },
    };
    const before = await tree(root);
    const result = await writeResolvedTemplateNoteVerified({
      ...createInput(root),
      convention: forged,
      dryRun: false,
    });
    expect(result).toMatchObject({
      status: "rejected",
      reason: "TEMPLATE_SOURCE_DRIFT: supplied resolved convention does not match current template authorities",
    });
    expect(await tree(root)).toEqual(before);
  });

  it("preserves resolved template BOM, CRLF, and final-newline layout", async () => {
    const root = await vault();
    const base = convention();
    const layoutConvention: ResolvedConvention = {
      ...base,
      templates: {
        note: {
          ...base.templates.note!,
          bom: true,
          eol: "crlf",
          finalNewline: false,
          body: "# Note\r\n<!-- oms:content -->\r\n",
        },
      },
    };
    const written = await writeResolvedTemplateNote({
      ...createInput(root),
      convention: layoutConvention,
      dryRun: false,
    });
    const bytes = await readFile(join(root, written.notePath));
    const text = bytes.toString("utf8");
    expect(text.startsWith("\ufeff---\r\n")).toBe(true);
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
    expect(text.endsWith("\n")).toBe(false);
  });

  it("resolves defaults once before type, normalize, allowed-value and URL validation", async () => {
    const root = await vault();
    const result = await writeResolvedTemplateNote({ ...createInput(root), dryRun: true });
    expect(result.frontmatter).toEqual({ template: "note", title: "Hello World", created: "2026-08-30", status: "open", source: "https://example.test", extra: "preserved" });
    expect(result.prepared?.resolvedAt).toBe("2026-08-30T10:11:12.000Z");
  });

  it("injects the selected stable template identity on create", async () => {
    const root = await vault();
    const result = await writeResolvedTemplateNote({
      ...createInput(root),
      dryRun: true,
      frontmatter: { title: "Hello", source: "https://example.test", template: "other" },
    });
    expect(result.status).toBe("written");
    expect(result.frontmatter.template).toBe("note");
    expect(result.prepared?.frontmatter.template).toBe("note");
  });

  it("asks for a required value when neither template nor policy supplies a default", async () => {
    const root = await vault();
    const result = await writeResolvedTemplateNote({ ...createInput(root), dryRun: true, frontmatter: { source: "https://example.test" } });
    expect(result.status).toBe("ask");
    expect(result.rejection?.code).toBe("contract-violation");
  });

  it("rejects an invalid URL before creating any note", async () => {
    const root = await vault();
    const result = await writeResolvedTemplateNote({ ...createInput(root), dryRun: false, frontmatter: { title: "Bad", source: "file:///tmp/x" } });
    expect(result.status).toBe("ask");
    await expect(readFile(join(root, "notes", "2026-08-30-bad.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe rendered naming without selecting a fallback path", async () => {
    const root = await vault();
    const result = await writeResolvedTemplateNote({ ...createInput(root), convention: convention("../{{slug}}.md"), dryRun: true });
    expect(result).toMatchObject({ status: "rejected", notePath: "" });
  });

  it("appends body only without changing frontmatter", async () => {
    const root = await vault();
    const created = await writeResolvedTemplateNote({ ...createInput(root), dryRun: false });
    const before = parseNote(await readFile(join(root, created.notePath), "utf8")).frontmatter;
    const appended = await writeResolvedTemplateNote({
      target: { vault: root, source: "explicit" }, convention: convention(), mode: "append", dryRun: false,
      notePath: created.notePath, body: "\nappended",
    });
    expect(appended.status).toBe("written");
    const after = parseNote(await readFile(join(root, created.notePath), "utf8"));
    expect(after.frontmatter).toEqual(before);
    expect(after.body).toContain("body text\n\nappended");
  });

  it("rejects append when the persisted template identity differs", async () => {
    const root = await vault();
    const created = await writeResolvedTemplateNote({ ...createInput(root), dryRun: false });
    const note = join(root, created.notePath);
    const original = await readFile(note, "utf8");
    await writeFile(note, original.replace("template: note", "template: other"));
    const result = await writeResolvedTemplateNote({
      target: { vault: root, source: "explicit" }, convention: convention(), mode: "append", dryRun: false,
      notePath: created.notePath, body: "append",
    });
    expect(result.rejection?.code).toBe("TEMPLATE_IDENTITY_IMMUTABLE");
    expect(await readFile(note, "utf8")).toContain("template: other");
  });

  it("rejects append frontmatter instead of mutating a managed note", async () => {
    const root = await vault();
    const created = await writeResolvedTemplateNote({ ...createInput(root), dryRun: false });
    const before = await readFile(join(root, created.notePath), "utf8");
    const result = await writeResolvedTemplateNote({
      target: { vault: root, source: "explicit" }, convention: convention(), mode: "append", dryRun: false,
      notePath: created.notePath, body: "append", frontmatter: { status: "closed" },
    });
    expect(result.rejection?.code).toBe("args-invalid");
    expect(await readFile(join(root, created.notePath), "utf8")).toBe(before);
  });

  it("updates only explicit fields and never revives a deleted default", async () => {
    const root = await vault();
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "existing.md"), "---\ntemplate: note\ntitle: Existing\nstatus: open\n---\nBody\n");
    const result = await writeResolvedTemplateNote({
      target: { vault: root, source: "explicit" }, convention: convention(), mode: "update", dryRun: false,
      notePath: "notes/existing.md", frontmatter: { status: "closed" },
    });
    expect(result.status).toBe("written");
    expect(result.frontmatter).toMatchObject({ template: "note", title: "Existing", status: "closed" });
    expect(result.frontmatter).not.toHaveProperty("created");
  });

  it("preserves existing BOM, CRLF, final-newline, and body bytes on frontmatter-only update", async () => {
    const root = await vault();
    await mkdir(join(root, "notes"), { recursive: true });
    const original = "\ufeff---\r\ntemplate: note\r\ntitle: Existing\r\nstatus: open\r\ncustom: keep\r\n---\r\nbody\r\n\r\n";
    await writeFile(join(root, "notes", "existing.md"), original);
    const result = await writeResolvedTemplateNote({
      target: { vault: root, source: "explicit" }, convention: convention(), mode: "update", dryRun: false,
      notePath: "notes/existing.md", frontmatter: { status: "closed" },
    });
    expect(result.status).toBe("written");
    const updated = await readFile(join(root, "notes", "existing.md"), "utf8");
    expect(updated.startsWith("\ufeff---\r\n")).toBe(true);
    expect(updated.slice(updated.indexOf("---\r\nbody") + 5)).toBe("body\r\n\r\n");
  });

  it("rejects an update that changes or removes the persisted template identity", async () => {
    const root = await vault();
    await mkdir(join(root, "notes"), { recursive: true });
    const original = "---\ntemplate: note\ntitle: Existing\nstatus: open\n---\nBody\n";
    await writeFile(join(root, "notes", "existing.md"), original);
    const result = await writeResolvedTemplateNote({
      target: { vault: root, source: "explicit" }, convention: convention(), mode: "update", dryRun: false,
      notePath: "notes/existing.md", frontmatter: { template: "other" },
    });
    expect(result.rejection?.code).toBe("TEMPLATE_IDENTITY_IMMUTABLE");
    expect(await readFile(join(root, "notes", "existing.md"), "utf8")).toBe(original);
  });

  it("renders frontmatter and body expressions from one trimmed title and UTC instant", async () => {
    const root = await vault();
    const current = convention();
    const expressionConvention: ResolvedConvention = {
      ...current,
      templates: {
        note: {
          ...current.templates.note!,
          frontmatterTemplate: { template: "note", title: "{{title}}", created: "{{date}}", status: "OPEN" },
          body: "# {{title}} at {{time}}\n<!-- oms:content -->\n",
        },
      },
    };
    const result = await writeResolvedTemplateNote({
      ...createInput(root),
      convention: expressionConvention,
      dryRun: true,
      resolvedAt: "2026-08-30T19:11:12+09:00",
    });
    expect(result.frontmatter).toMatchObject({ template: "note", title: "Hello World", created: "2026-08-30" });
    expect(result.body).toBe("# Hello World at 10:11\nbody text\n");
    expect(result.prepared?.resolvedAt).toBe("2026-08-30T10:11:12.000Z");
  });

  it("renders formatted date and time tags identically for dry-run and persistence", async () => {
    const root = await vault();
    const current = convention();
    const formattedConvention: ResolvedConvention = {
      ...current,
      templates: {
        note: {
          ...current.templates.note!,
          keyOrder: [...current.templates.note!.keyOrder, "formatted"],
          fields: { ...current.templates.note!.fields, formatted: { type: "text" } },
          frontmatterTemplate: { template: "note", status: "OPEN", formatted: "{{date:YYYY/MM/DD}}" },
          body: "At {{time:HH:mm:ss}}\n<!-- oms:content -->\n",
        },
      },
    };
    const input = { ...createInput(root), convention: formattedConvention, resolvedAt: "2026-08-30T19:11:12+09:00" };
    const dryRun = await writeResolvedTemplateNote({ ...input, dryRun: true });
    const persisted = await writeResolvedTemplateNote({ ...input, dryRun: false });
    expect(dryRun.frontmatter.formatted).toBe("2026/08/30");
    expect(dryRun.body).toBe("At 10:11:12\nbody text\n");
    expect(persisted.prepared).toEqual(dryRun.prepared);
    expect(await readFile(join(root, persisted.notePath), "utf8")).toContain("formatted: 2026/08/30");
  });

  it("requires caller values for Templater-filled fields and never persists raw external tags", async () => {
    const root = await vault();
    const current = convention();
    const templaterConvention: ResolvedConvention = {
      ...current,
      templates: {
        note: {
          ...current.templates.note!,
          renderer: "templater",
          fields: {
            ...current.templates.note!.fields,
            created: { type: "date", filledBy: "obsidian" },
          },
          frontmatterTemplate: {
            template: "note",
            status: "OPEN",
            created: "<% tp.date.now(\"YYYY-MM-DD\") %>",
          },
        },
      },
    };
    const missing = await writeResolvedTemplateNote({
      ...createInput(root),
      convention: templaterConvention,
      dryRun: false,
    });
    expect(missing).toMatchObject({
      status: "ask",
      reason: "FIELD_FILLED_BY_OBSIDIAN: caller values are required for created",
    });
    await expect(readFile(join(root, "notes", "2026-08-30-hello-world.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const input = {
      ...createInput(root),
      convention: templaterConvention,
      frontmatter: {
        ...createInput(root).frontmatter,
        created: "2026-08-30",
      },
    };
    const dryRun = await writeResolvedTemplateNote({ ...input, dryRun: true });
    const written = await writeResolvedTemplateNote({ ...input, dryRun: false });
    expect(written.prepared).toEqual(dryRun.prepared);
    expect(await readFile(join(root, written.notePath), "utf8")).not.toContain("<%");
  });

  it("rejects external Templater bodies and renderer-none templates without writing", async () => {
    const root = await vault();
    const current = convention();
    for (const template of [
      { ...current.templates.note!, renderer: "templater" as const, body: "<% tp.file.cursor() %>\n" },
      { ...current.templates.note!, renderer: "none" as const },
    ]) {
      const result = await writeResolvedTemplateNote({
        ...createInput(root),
        convention: { ...current, templates: { note: template } },
        dryRun: false,
      });
      expect(result).toMatchObject({ status: "rejected" });
      expect(result.reason).toContain("TEMPLATE_RENDERER_EXTERNAL");
    }
    await expect(readFile(join(root, "notes", "2026-08-30-hello-world.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { body: "raw <% malformed" },
    { body: "nested <% outer <% inner %> %>" },
    { frontmatter: { title: "Hello", source: "https://example.test", nested: ["raw %> delimiter"] } },
  ])("rejects caller-provided external delimiters before writing: %o", async external => {
    const root = await vault();
    const result = await writeResolvedTemplateNote({
      ...createInput(root),
      ...external,
      dryRun: false,
    });
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.reason).toContain("TEMPLATE_RENDERER_EXTERNAL");
    await expect(readFile(join(root, "notes", "2026-08-30-hello-world.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails loudly for an unsupported formatted token during rendering", async () => {
    const root = await vault();
    const current = convention();
    const invalidConvention: ResolvedConvention = {
      ...current,
      templates: {
        note: {
          ...current.templates.note!,
          body: "{{date:YYYY[year]}}\n<!-- oms:content -->\n",
        },
      },
    };
    await expect(writeResolvedTemplateNote({ ...createInput(root), convention: invalidConvention, dryRun: true }))
      .rejects.toMatchObject({
        code: "TEMPLATE_EXPRESSION_UNSUPPORTED",
        sourcePath: "Templates/OMS/note.md",
        location: "body",
        rawToken: "{{date:YYYY[year]}}",
      });
  });

  it("requires a non-empty title when the template renders title", async () => {
    const root = await vault();
    const current = convention();
    const result = await writeResolvedTemplateNote({
      ...createInput(root),
      convention: {
        ...current,
        templates: { note: { ...current.templates.note!, body: "# {{title}}\n" } },
      },
      frontmatter: { title: "   ", source: "https://example.test" },
      dryRun: true,
    });
    expect(result.reason).toContain("TEMPLATE_TITLE_REQUIRED");
  });

  it("treats an inline content marker as opaque template body", async () => {
    const root = await vault();
    const current = convention();
    const result = await writeResolvedTemplateNote({
      ...createInput(root),
      convention: {
        ...current,
        templates: { note: { ...current.templates.note!, body: "prefix <!-- oms:content --> suffix\n" } },
      },
      dryRun: true,
    });
    expect(result.body).toBe("prefix <!-- oms:content --> suffix\n\nbody text");
  });

  it("rejects an update that would violate allowed values without writing", async () => {
    const root = await vault();
    await mkdir(join(root, "notes"), { recursive: true });
    const original = "---\ntemplate: note\ntitle: Existing\nstatus: open\n---\nBody\n";
    await writeFile(join(root, "notes", "existing.md"), original);
    const result = await writeResolvedTemplateNote({
      target: { vault: root, source: "explicit" }, convention: convention(), mode: "update", dryRun: false,
      notePath: "notes/existing.md", frontmatter: { status: "invalid" },
    });
    expect(result.status).toBe("rejected");
    expect(await readFile(join(root, "notes", "existing.md"), "utf8")).toBe(original);
  });

  it("returns a postcondition receipt with exact template and projection signatures", async () => {
    const root = await vault();
    const result = await writeResolvedTemplateNote({ ...createInput(root), dryRun: false });
    const current = convention().templates.note!;
    expect(result.receipt).toEqual({
      resolvedVault: root,
      resolutionSource: "explicit",
      templateId: "note",
      notePath: "notes/2026-08-30-hello-world.md",
      mode: "create",
      resolvedAt: "2026-08-30T10:11:12.000Z",
      writtenPaths: ["notes/2026-08-30-hello-world.md"],
      inputSignature: current.inputSignature,
      templateSignature: current.templateSignature,
      postconditionVerified: true,
    });
    expect(canonicalJson({ ...result.receipt, resolvedVault: "<vault>" })).toBe(
      `{"inputSignature":"${current.inputSignature}","mode":"create","notePath":"notes/2026-08-30-hello-world.md","postconditionVerified":true,"resolutionSource":"explicit","resolvedAt":"2026-08-30T10:11:12.000Z","resolvedVault":"<vault>","templateId":"note","templateSignature":"${current.templateSignature}","writtenPaths":["notes/2026-08-30-hello-world.md"]}`,
    );
  });
});
