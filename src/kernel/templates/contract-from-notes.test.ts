import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { deriveContractFromNotes } from "./contract-from-notes.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function vault(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "oms-contract-notes-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

function note(frontmatter: string): string {
  return `---\n${frontmatter}\n---\nBody\n`;
}

describe("deriveContractFromNotes", () => {
  it("samples default identity keys and derives requiredness and coverage", async () => {
    const root = await vault({
      "People/ada.md": note("type: people\nname: Ada\nscore: 10\nactive: true"),
      "People/grace.md": note("type: people\nname: Grace\nactive: false\ntags: [computer, pioneer]"),
      "People/other.md": note("type: project\nname: Other"),
    });

    const result = await deriveContractFromNotes(root, { templateId: "people" });

    expect(result.status).toBe("observed");
    expect(result.samples).toBe(2);
    expect(result.fields).toEqual({
      active: { type: "checkbox", required: true },
      name: { type: "text", required: true },
      score: { type: "number" },
      tags: { type: "list" },
      type: { type: "text", required: true },
    });
    expect(result.coverage).toEqual({ active: 1, name: 1, score: 0.5, tags: 0.5, type: 1 });
  });

  it("samples taxonomy folders even when notes have no identity key", async () => {
    const root = await vault({
      "Contacts/a.md": note("name: A\nbirthday: 2000-01-02"),
      "Elsewhere/b.md": note("name: B"),
    });

    const result = await deriveContractFromNotes(root, {
      templateId: "people",
      folders: ["Contacts"],
    });

    expect(result.samples).toBe(1);
    expect(result.fields).toEqual({
      birthday: { type: "date", required: true },
      name: { type: "text", required: true },
    });
  });

  it("uses custom sample keys and gives Obsidian type authority precedence", async () => {
    const root = await vault({
      "Events/a.md": note("kind: event\nwhen: 2026-09-05T10:30:00Z\nattendees: Ada"),
      "Events/b.md": note("kind: event\nwhen: 2026-09-06T11:00:00Z\nattendees: Grace"),
    });

    const result = await deriveContractFromNotes(root, {
      templateId: "event",
      sampleKeys: ["kind"],
      obsidianTypes: { attendees: "aliases", when: "text" },
    });

    expect(result.fields.attendees).toEqual({ type: "aliases", required: true });
    expect(result.fields.when).toEqual({ type: "text", required: true });
  });

  it("reports an unobserved template instead of calling it unused", async () => {
    const result = await deriveContractFromNotes(await vault(), { templateId: "missing" });
    expect(result).toMatchObject({
      templateId: "missing",
      samples: 0,
      fields: {},
      coverage: {},
      status: "unobserved",
      capped: false,
    });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_CONTRACT_UNOBSERVED",
    }));
    expect(result.diagnostics.some(item => item.message.includes("unused"))).toBe(false);
  });

  it("rejects more than 50 eligible samples instead of approving a partial contract", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 55 }, (_, index) => [
        `Notes/${String(index).padStart(2, "0")}.md`,
        note(`template: note\nsequence: ${index}`),
      ]),
    );
    const result = await deriveContractFromNotes(await vault(files), { templateId: "note" });
    expect(result.samples).toBe(50);
    expect(result.capped).toBe(true);
    expect(result.status).toBe("oversize");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_PROPOSAL_OVERSIZE",
      path: "Notes/50.md",
    }));
    expect(result.fields.sequence).toEqual({ type: "number", required: true });
  });

  it("marks proposals over 64 fields without truncating them", async () => {
    const entries = Array.from({ length: 65 }, (_, index) => `field-${String(index).padStart(2, "0")}: value`);
    const root = await vault({ "Notes/wide.md": note(["template: wide", ...entries].join("\n")) });

    const result = await deriveContractFromNotes(root, { templateId: "wide" });

    expect(result.status).toBe("oversize");
    expect(Object.keys(result.fields)).toHaveLength(66);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_PROPOSAL_OVERSIZE",
    }));
  });

  it("skips invalid notes with per-file evidence", async () => {
    const root = await vault({
      "Notes/broken.md": "---\ntemplate: [broken\n---\n",
      "Notes/good.md": note("template: note\ntitle: Good"),
    });

    const result = await deriveContractFromNotes(root, { templateId: "note" });

    expect(result.samples).toBe(1);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_CONTRACT_NOTE_INVALID",
      path: "Notes/broken.md",
    }));
  });

  it("rejects oversized eligible source bytes before reading an unbounded note", async () => {
    const root = await vault({
      "People/huge.md": `${note("title: Huge")}${"x".repeat(262_145)}`,
    });
    const result = await deriveContractFromNotes(root, {
      templateId: "people",
      folders: ["People"],
    });
    expect(result.status).toBe("oversize");
    expect(result.samples).toBe(0);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_PROPOSAL_OVERSIZE",
      path: "People/huge.md",
    }));
  });

  it("applies the source-byte limit per file rather than inventing an aggregate limit", async () => {
    const body = "x".repeat(140_000);
    const root = await vault({
      "People/a.md": `${note("type: people\nname: A")}${body}`,
      "People/b.md": `${note("type: people\nname: B")}${body}`,
    });
    const result = await deriveContractFromNotes(root, { templateId: "people" });
    expect(result.status).toBe("observed");
    expect(result.samples).toBe(2);
    expect(result.diagnostics).toEqual([]);
  });

  it("excludes explicitly selected template sources and reports deterministic sample digests", async () => {
    const root = await vault({
      "Templates/people.md": note("type: people\nshape: source"),
      "People/b.md": note("type: people\nname: B"),
      "People/a.md": note("type: people\nname: A"),
    });
    const first = await deriveContractFromNotes(root, {
      templateId: "people",
      excludedPaths: ["Templates/people.md"],
    });
    const second = await deriveContractFromNotes(root, {
      templateId: "people",
      excludedPaths: ["Templates/people.md"],
    });
    expect(first.sampleSources.map(source => source.path)).toEqual(["People/a.md", "People/b.md"]);
    expect(first.sampleSources).toEqual(second.sampleSources);
    expect(first.sampleSources.every(source => /^sha256:[a-f0-9]{64}$/.test(source.digest))).toBe(true);
    expect(first.fields.shape).toBeUndefined();
  });

  it("diagnoses incompatible heterogeneous values instead of coercing them to text", async () => {
    const root = await vault({
      "Notes/a.md": note("type: mixed\nvalue: 1"),
      "Notes/b.md": note("type: mixed\nvalue: words"),
    });
    const result = await deriveContractFromNotes(root, { templateId: "mixed" });
    expect(result.status).toBe("unresolved");
    expect(result.fields.value).toBeUndefined();
    expect(result.coverage.value).toBe(1);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_PROPOSAL_TYPE_CONFLICT",
    }));
  });

  it("diagnoses null, objects, and non-string lists as unsupported instead of text", async () => {
    const root = await vault({
      "Notes/a.md": note("type: unsupported\nempty: null\nobject:\n  nested: true\nmixed: [one, 2]"),
    });
    const result = await deriveContractFromNotes(root, { templateId: "unsupported" });
    expect(result.status).toBe("unresolved");
    expect(result.fields.empty).toBeUndefined();
    expect(result.fields.object).toBeUndefined();
    expect(result.fields.mixed).toBeUndefined();
    expect(result.diagnostics.filter(item => item.code === "TEMPLATE_PROPOSAL_TYPE_CONFLICT")).toHaveLength(3);
  });

  it("marks an uninspectable directory beyond depth 16 as oversize", async () => {
    const segments = Array.from({ length: 17 }, (_, index) => `level-${index}`);
    const relative = `${segments.join("/")}/note.md`;
    const result = await deriveContractFromNotes(await vault({
      [relative]: note("template: deep\nname: Hidden"),
    }), { templateId: "deep" });
    expect(result.status).toBe("oversize");
    expect(result.samples).toBe(0);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_PROPOSAL_OVERSIZE",
      path: segments.join("/"),
    }));
  });

  it("ignores symlinks, including aliases to files outside the vault", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "oms-contract-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "outside.md"), note("template: people\nsecret: private"));
    const root = await vault({ "People/local.md": note("template: people\nname: Local") });
    await symlink(path.join(outside, "outside.md"), path.join(root, "People", "outside.md"));
    await symlink(path.join(root, "People", "local.md"), path.join(root, "People", "alias.md"));
    await symlink(outside, path.join(root, "People", "outside-directory"));

    const result = await deriveContractFromNotes(root, { templateId: "people" });

    expect(result.samples).toBe(1);
    expect(result.fields.secret).toBeUndefined();
  });

  it("rejects unsafe configured folder and exclusion paths before scanning", async () => {
    const root = await vault();
    await expect(deriveContractFromNotes(root, {
      templateId: "people",
      folders: ["../outside"],
    })).rejects.toThrow("TEMPLATE_PROPOSAL_PATH_UNSAFE");
    await expect(deriveContractFromNotes(root, {
      templateId: "people",
      excludedPaths: ["/outside.md"],
    })).rejects.toThrow("TEMPLATE_PROPOSAL_PATH_UNSAFE");
  });
});
