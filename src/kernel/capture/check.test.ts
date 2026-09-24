import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestBytes } from "../templates/canonical.js";
import { parseTemplatePolicy, serializeDerivedProjection } from "../templates/policy.js";
import { controlGenerationDigest, expectedProjectionManaged, taxonomyRouting } from "../templates/resolver.js";
import { checkSavedNote } from "./check.js";

const roots: string[] = [];
const encoder = new TextEncoder();
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const NOTE = "---\ntemplate: note\nstatus: open\n---\n\n## Summary\n\nThe saved body an agent wrote.\n";

/** Same slicing rule the contract uses: a line keeps its terminating newline. */
function sliceOf(text: string, start: number, end: number) {
  return digestBytes(text.split(/(?<=\n)/u).slice(start - 1, end).join(""));
}

const SUMMARY_SPAN = { kind: "note-span" as const, lineSpan: { start: 6, end: 8 }, sliceDigest: sliceOf(NOTE, 6, 8) };
const TEMPLATE_MARKDOWN = "---\ntemplate: note\nstatus: open\n---\n\n## Summary\n";

function layer(templatePath: string, markdown: string, extra: Record<string, unknown> = {}) {
  return {
    templatePath,
    approvedMarkdown: markdown,
    approvedMarkdownDigest: digestBytes(markdown),
    fields: {},
    headings: [],
    semanticCriteria: [],
    ...extra,
  };
}

function policyDocument(criteria: readonly unknown[]) {
  return {
    version: 4,
    properties: { status: { type: "select", intent: "Workflow state.", allowedValues: ["open", "closed"] } },
    default: layer(".oms/templates/default.md", ""),
    templates: {
      note: layer(".oms/templates/note.md", TEMPLATE_MARKDOWN, {
        templateId: "note",
        fields: { status: { property: "status", required: true } },
        headings: [{ headingId: "summary", title: "Summary", level: 2, required: true }],
        semanticCriteria: criteria,
      }),
    },
  };
}

async function vault(options: { readonly criteria?: readonly unknown[]; readonly note?: string | null } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-check-"));
  roots.push(root);
  const policyText = JSON.stringify(policyDocument(options.criteria ?? [{
    criterionId: "summary-supported",
    statement: "The summary reflects the cited evidence.",
    evidenceRequirement: "Cite the summary lines.",
    required: true,
    sourceRefs: [SUMMARY_SPAN],
  }]));
  const taxonomyText = JSON.stringify({ templates: { note: { templateFolder: "notes" } }, folders: { notes: { intent: "Notes." } } });
  const generationDigest = controlGenerationDigest(encoder.encode(policyText), encoder.encode(taxonomyText));
  await mkdir(join(root, ".oms", "templates"), { recursive: true });
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, ".oms", "template-policy.json"), policyText);
  await writeFile(join(root, ".oms", "taxonomy.json"), taxonomyText);
  await writeFile(join(root, ".oms", "types.json"), serializeDerivedProjection({
    version: "oms.types.v2",
    generatedFrom: generationDigest,
    managed: expectedProjectionManaged(parseTemplatePolicy(policyText), taxonomyRouting(".oms/taxonomy.json", encoder.encode(taxonomyText)), generationDigest),
  }));
  await writeFile(join(root, ".oms", "templates", "default.md"), "");
  await writeFile(join(root, ".oms", "templates", "note.md"), TEMPLATE_MARKDOWN);
  const note = options.note === undefined ? NOTE : options.note;
  if (note !== null) await writeFile(join(root, "notes", "one.md"), note);
  return root;
}

function target(root: string) {
  return { vault: root, source: "explicit" as const };
}

async function passingCheck(root: string) {
  return checkSavedNote({ target: target(root), notePath: "notes/one.md", templateId: "note" });
}

async function vaultSignature(root: string): Promise<string> {
  const files = [".oms/template-policy.json", ".oms/taxonomy.json", ".oms/types.json", ".oms/templates/note.md", "notes/one.md"];
  const rows = await Promise.all(files.map(async file => {
    try {
      return `${file} ${digestBytes(await readFile(join(root, file)))}`;
    } catch {
      return `${file} absent`;
    }
  }));
  return rows.join("\n");
}

describe("checkSavedNote", () => {
  it("reads the saved file and reports only observed mechanics", async () => {
    const root = await vault();
    const before = await vaultSignature(root);
    const report = await passingCheck(root);
    expect(report.status).toBe("pass");
    expect(report.machine?.status).toBe("pass");
    expect(report.machine?.noteDigest).toBe(digestBytes(NOTE));
    expect(report.notePath).toBe("notes/one.md");
    expect(report.binding?.notePath).toBe("notes/one.md");
    expect(report.machine?.findings).toEqual([]);
    // Check is structural. It carries no rubric, reviewer prompt, review
    // request, or completion checkpoint.
    expect(Object.keys(report).sort()).toEqual(["binding", "machine", "notePath", "rejection", "status", "taskId", "templateId"]);
    expect(await vaultSignature(root)).toBe(before);
  });

  it("fails mechanics on the saved bytes without repairing the note", async () => {
    const root = await vault({ note: "---\ntemplate: note\nstatus: unknown\n---\n\nNo summary heading.\n" });
    const report = await passingCheck(root);
    expect(report.status).toBe("fail");
    expect(report.machine?.findings.map(finding => finding.targetId)).toEqual(
      expect.arrayContaining(["field/status", "heading/summary"]),
    );
    expect(await readFile(join(root, "notes/one.md"), "utf8")).toContain("status: unknown");
  });

  it("refuses a current-directory target before reading the vault", async () => {
    const root = await vault();
    const report = await checkSavedNote({ target: { vault: root, source: "cwd" }, notePath: "notes/one.md" });
    expect(report.status).toBe("rejected");
    expect(report.rejection?.code).toBe("TARGET_UNVERIFIED");
  });

  it("reports an unsaved note instead of creating one", async () => {
    const root = await vault({ note: null });
    const report = await passingCheck(root);
    expect(report.rejection?.code).toBe("NOTE_MISSING");
    await expect(readFile(join(root, "notes/one.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks an unbound note against the default layer alone", async () => {
    const root = await vault({ note: "---\ntitle: Plain\n---\n\nOrdinary note.\n" });
    const report = await checkSavedNote({ target: target(root), notePath: "notes/one.md" });
    expect(report.status).toBe("pass");
    expect(report.templateId).toBeNull();
  });

  it("rejects a binding from another note and a stale contract digest", async () => {
    const root = await vault();
    const report = await passingCheck(root);
    const binding = report.binding!;
    const otherNote = await checkSavedNote({
      target: target(root), notePath: "notes/one.md", templateId: "note",
      binding: { ...binding, notePath: "notes/other.md" },
    });
    expect(otherNote.rejection?.code).toBe("TASK_BINDING_MISMATCH");
    const stale = await checkSavedNote({
      target: target(root), notePath: "notes/one.md", templateId: "note",
      binding: { ...binding, contractDigest: digestBytes("different") },
    });
    expect(stale.rejection?.code).toBe("SNAPSHOT_STALE");
  });

  it("stops the evaluation while a contract publication is in progress", async () => {
    const root = await vault();
    await writeFile(join(root, ".oms", "template-transaction.json"), JSON.stringify({ status: "in-progress" }));
    expect((await passingCheck(root)).rejection?.code).toBe("CONTRACT_TRANSACTION_IN_PROGRESS");
  });

  it("reports a missing approved authority instead of an empty contract", async () => {
    const root = await vault();
    await rm(join(root, ".oms", "template-policy.json"));
    expect((await passingCheck(root)).rejection?.code).toBe("CONTRACT_UNVERIFIABLE");
  });

  it("survives a JSON round trip of the binding it returns", async () => {
    const root = await vault();
    const report = await passingCheck(root);
    const restored = JSON.parse(JSON.stringify(report.binding)) as NonNullable<typeof report.binding>;
    expect(restored).toEqual(report.binding);
    const again = await checkSavedNote({ target: target(root), notePath: "notes/one.md", templateId: "note", binding: restored });
    expect(again.status).toBe("pass");
    expect(again.rejection).toBeNull();
  });
});
