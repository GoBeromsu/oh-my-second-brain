import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseNote } from "../conventions/frontmatter.js";
import { writeResolvedTemplateNote } from "./safe.js";
import { canonicalJson } from "../templates/canonical.js";
import type { Digest, ResolvedConvention } from "../templates/types.js";

const roots: string[] = [];
const signature = "sha256:0000000000000000000000000000000000000000000000000000000000000000" as Digest;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-write-"));
  roots.push(root);
  return root;
}

function convention(naming = "{{date}}-{{slug}}.md"): ResolvedConvention {
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
  it("keeps dry-run and persisted create preparation byte-for-byte equal", async () => {
    const root = await vault();
    const dryRun = await writeResolvedTemplateNote({ ...createInput(root), dryRun: true });
    const written = await writeResolvedTemplateNote({ ...createInput(root), dryRun: false });
    expect(written.status).toBe("written");
    expect(written.prepared).toEqual(dryRun.prepared);
    expect(written.notePath).toBe("notes/2026-08-30-hello-world.md");
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
      { ...current.templates.note!, renderer: "templater" as const, body: "malformed %> body\n" },
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
    expect(result.receipt).toEqual({
      resolvedVault: root,
      resolutionSource: "explicit",
      templateId: "note",
      notePath: "notes/2026-08-30-hello-world.md",
      mode: "create",
      resolvedAt: "2026-08-30T10:11:12.000Z",
      writtenPaths: ["notes/2026-08-30-hello-world.md"],
      inputSignature: signature,
      templateSignature: signature,
      postconditionVerified: true,
    });
    expect(canonicalJson({ ...result.receipt, resolvedVault: "<vault>" })).toBe(
      `{"inputSignature":"${signature}","mode":"create","notePath":"notes/2026-08-30-hello-world.md","postconditionVerified":true,"resolutionSource":"explicit","resolvedAt":"2026-08-30T10:11:12.000Z","resolvedVault":"<vault>","templateId":"note","templateSignature":"${signature}","writtenPaths":["notes/2026-08-30-hello-world.md"]}`,
    );
  });
});
