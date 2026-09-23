import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeRubricDigest, computeTaskId } from "../conventions/completion-contract.js";
import { digestBytes } from "../templates/canonical.js";
import { parseTemplatePolicy, serializeDerivedProjection } from "../templates/policy.js";
import { controlGenerationDigest, expectedProjectionManaged, loadResolvedTemplates, taxonomyRouting } from "../templates/resolver.js";
import {
  FRAMEWORK_RUBRIC_ID,
  WriteGuidanceFailure,
  canonicalVaultFingerprint,
  getWriteGuidance,
  prepareApprovedWrite,
  type WriteGuidanceReport,
} from "./guidance.js";
import type { WriteTarget } from "./safe.js";

const encoder = new TextEncoder();
const roots: string[] = [];
const DEFAULT_MARKDOWN = "\ufeff# Default\r\n\r\nKeep exact bytes.\r\n";
const LITERATURE_MARKDOWN = "\ufeff# Literature\r\n\r\n{{title}}\r\n<% tp.file.title %>\r\n";
const SOURCE_TEXT = "Source body\r\n";
const NOTE_PATH = "Custom/Explicit Note.md";

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

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

function policyDocument(criteria: boolean) {
  return {
    version: 4,
    properties: {
      status: { type: "select", intent: "Publication status.", allowedValues: ["open", "closed"] },
      topic: { type: "text", intent: "Subject of the note." },
    },
    default: layer(".oms/templates/default.md", DEFAULT_MARKDOWN, {
      fields: { status: { property: "status", required: true } },
      headings: [{ headingId: "summary", title: "Summary", level: 2, required: true }],
      ...(criteria ? { semanticCriteria: [defaultCriterion()] } : {}),
    }),
    templates: {
      literature: layer(".oms/templates/literature.md", LITERATURE_MARKDOWN, {
        templateId: "literature",
        fields: {
          status: { property: "status", allowedValues: ["open"] },
          topic: { property: "topic" },
        },
        headings: [{ headingId: "sources", title: "Sources", level: 2, required: true }],
        ...(criteria ? { semanticCriteria: [literatureCriterion()] } : {}),
        source: {
          path: "Sources/literature.md",
          identity: "literature-source",
          rawDigest: digestBytes(SOURCE_TEXT),
        },
      }),
    },
  };
}

function defaultCriterion() {
  return {
    criterionId: "summary-present",
    statement: "The note has a summary.",
    evidenceRequirement: "Quote the summary from the note.",
    sourceRefs: [],
  };
}

function literatureCriterion() {
  return {
    criterionId: "sources-present",
    statement: "The note identifies its sources.",
    evidenceRequirement: "Quote the sources from the note.",
    sourceRefs: [],
  };
}

function taxonomyDocument() {
  return { templates: { literature: { templateFolder: "Notes/Literature" } } };
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function installVault(criteria: boolean): Promise<string> {
  const root = await makeRoot("oms-write-guidance-");
  const policyText = JSON.stringify(policyDocument(criteria));
  const taxonomyText = JSON.stringify(taxonomyDocument());
  const policyBytes = encoder.encode(policyText);
  const taxonomyBytes = encoder.encode(taxonomyText);
  const generation = controlGenerationDigest(policyBytes, taxonomyBytes);
  const projectionText = serializeDerivedProjection({
    version: "oms.types.v2",
    generatedFrom: generation,
    managed: expectedProjectionManaged(parseTemplatePolicy(policyText), taxonomyRouting(".oms/taxonomy.json", taxonomyBytes), generation),
  });
  await mkdir(join(root, ".oms", "templates"), { recursive: true });
  await mkdir(join(root, "Sources"), { recursive: true });
  await writeFile(join(root, ".oms", "template-policy.json"), policyText);
  await writeFile(join(root, ".oms", "taxonomy.json"), taxonomyText);
  await writeFile(join(root, ".oms", "types.json"), projectionText);
  await writeFile(join(root, ".oms", "templates", "default.md"), DEFAULT_MARKDOWN);
  await writeFile(join(root, ".oms", "templates", "literature.md"), LITERATURE_MARKDOWN);
  await writeFile(join(root, "Sources", "literature.md"), SOURCE_TEXT);
  return root;
}

async function vaultSignature(root: string): Promise<string> {
  const rows: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const name = relative(root, full);
      if (entry.isSymbolicLink()) rows.push(`link ${name} ${await readlink(full)}`);
      else if (entry.isDirectory()) {
        rows.push(`dir ${name}`);
        await walk(full);
      } else if (entry.isFile()) rows.push(`file ${name} ${digestBytes(await readFile(full))}`);
      else rows.push(`other ${name}`);
    }
  }
  await walk(root);
  return rows.join("\n");
}

async function expectUnchanged<T>(root: string, body: () => Promise<T>): Promise<T> {
  const before = await vaultSignature(root);
  const result = await body();
  expect(await vaultSignature(root)).toBe(before);
  return result;
}

function target(vault: string, source: WriteTarget["source"] = "explicit"): WriteTarget {
  return { vault, source };
}

describe("write guidance", () => {
  it("preserves exact approved markdown bytes, including BOM, CRLF, and unevaluated tokens", async () => {
    const root = await installVault(true);
    const report = await expectUnchanged(root, () => getWriteGuidance({
      target: target(root),
      notePath: NOTE_PATH,
      templateId: "literature",
    }));
    expect(report.status).toBe("guided");
    expect(report.approvedMarkdown?.defaultLayer).toBe(DEFAULT_MARKDOWN);
    expect(report.approvedMarkdown?.templateLayer).toBe(LITERATURE_MARKDOWN);
    expect(report.approvedMarkdown?.defaultLayer.charCodeAt(0)).toBe(0xfeff);
    expect(report.approvedMarkdown?.defaultLayer.includes("\r\n")).toBe(true);
    expect(report.approvedMarkdown?.templateLayer?.includes("{{title}}")).toBe(true);
    expect(report.approvedMarkdown?.templateLayer?.includes("<% tp.file.title %>")).toBe(true);
  });

  it("returns the default contract when templateId is omitted or null and the path is unsaved", async () => {
    const root = await installVault(true);
    const omitted = await expectUnchanged(root, () => getWriteGuidance({ target: target(root), notePath: NOTE_PATH }));
    const explicitNull = await expectUnchanged(root, () => getWriteGuidance({
      target: target(root),
      notePath: NOTE_PATH,
      templateId: null,
    }));
    for (const report of [omitted, explicitNull]) {
      expect(report.status).toBe("guided");
      expect(report.templateId).toBeNull();
      expect(report.placementHint).toBeNull();
      expect(report.approvedMarkdown?.templateLayer).toBeNull();
      expect(Object.keys(report.fields)).toEqual(["status"]);
      expect(report.fields["status"]?.required).toBe(true);
      expect(report.fields["status"]?.allowedValues).toEqual(["closed", "open"]);
      expect(report.headings.map(heading => heading.headingId)).toEqual(["summary"]);
      expect(report.headings[0]?.origin).toBe("default");
      expect(report.semanticCriteria.map(criterion => criterion.criterionId)).toEqual(["summary-present"]);
      expect(report.preparation?.binding.templateId).toBeNull();
    }
    expect(omitted.contractDigest).toBe(explicitNull.contractDigest);
  });

  it("uses a saved note's declared template when templateId is omitted", async () => {
    const root = await installVault(true);
    await mkdir(join(root, "Custom"), { recursive: true });
    await writeFile(join(root, NOTE_PATH), "---\ntemplate: literature\n---\n");
    const omitted = await expectUnchanged(root, () => getWriteGuidance({ target: target(root), notePath: NOTE_PATH }));
    const explicitNull = await expectUnchanged(root, () => getWriteGuidance({
      target: target(root),
      notePath: NOTE_PATH,
      templateId: null,
    }));
    expect(omitted.status).toBe("guided");
    expect(omitted.templateId).toBe("literature");
    expect(omitted.approvedMarkdown?.templateLayer).toBe(LITERATURE_MARKDOWN);
    expect(explicitNull.status).toBe("guided");
    expect(explicitNull.templateId).toBeNull();
    expect(explicitNull.approvedMarkdown?.templateLayer).toBeNull();
  });

  it("adds the selected template onto the default contract and binds the explicit path", async () => {
    const root = await installVault(true);
    const snapshot = await loadResolvedTemplates(root);
    const prepared = prepareApprovedWrite({
      vaultRealPath: snapshot.vault,
      notePath: NOTE_PATH,
      snapshot,
      templateId: "literature",
    });
    const report = await expectUnchanged(root, () => getWriteGuidance({
      target: target(root),
      notePath: NOTE_PATH,
      templateId: "literature",
    }));
    expect(report.status).toBe("guided");
    expect(report.notePath).toBe(NOTE_PATH);
    expect(report.placementHint).toBe("Notes/Literature");
    expect(report.notePath?.startsWith("Notes/Literature/")).toBe(false);
    expect(report.fields["status"]?.required).toBe(true);
    expect(report.fields["status"]?.allowedValues).toEqual(["open"]);
    expect(report.fields["topic"]?.required).toBe(false);
    expect(report.fields["topic"]?.type).toBe("text");
    expect(report.headings.map(heading => [heading.headingId, heading.origin])).toEqual([
      ["summary", "default"],
      ["sources", "template"],
    ]);
    expect(report.semanticCriteria.map(criterion => criterion.criterionId)).toEqual(["summary-present", "sources-present"]);
    expect(report.rubric?.rubricId).toBe(FRAMEWORK_RUBRIC_ID);
    expect(report.rubric?.rubricId).not.toBe("oms-reviewer");
    expect(report.rubric?.criteria.map(criterion => criterion.criterionId)).toEqual(["sources-present", "summary-present"]);
    expect(report.contractDigest).toBe(snapshot.templates["literature"]?.contractDigest);
    expect(report.preparation?.taskId).toBe(prepared.taskId);
    expect(prepared.taskId).toBe(computeTaskId(prepared.binding));
    expect(prepared.binding.notePath).toBe(NOTE_PATH);
    expect(prepared.binding.templateId).toBe("literature");
    expect(prepared.binding.vaultFingerprint).toBe(canonicalVaultFingerprint(await realpath(root)));
    expect(prepared.vaultFingerprint).toBe(digestBytes(await realpath(root)).slice("sha256:".length));
    expect(prepared.rubricDigest).toBe(computeRubricDigest(prepared.rubric));
    expect(prepared.binding.rubricDigest).toBe(prepared.rubricDigest);
  });

  it("asks for an explicit note path and does not invent a filename", async () => {
    const root = await installVault(true);
    const report = await expectUnchanged(root, () => getWriteGuidance({
      target: target(root),
      templateId: "literature",
    }));
    expect(report.status).toBe("needs-path");
    expect(report.notePath).toBeNull();
    expect(report.preparation).toBeNull();
    expect(report.placementHint).toBe("Notes/Literature");
    expect(report.pathRequest?.code).toBe("NOTE_PATH_REQUIRED");
    expect(report.pathRequest?.message).toContain("Notes/Literature");
    expect(report.pathRequest?.message).toContain("does not choose a folder, title, date, or filename");
    expect(report.pathRequest?.message).not.toMatch(/Inbox|slug/);
    expect(report.fields["topic"]?.property).toBe("topic");
    expect(report.approvedMarkdown?.templateLayer).toBe(LITERATURE_MARKDOWN);
  });

  it("reports a missing rubric instead of a semantic pass", async () => {
    const root = await installVault(false);
    const report = await expectUnchanged(root, () => getWriteGuidance({
      target: target(root),
      notePath: NOTE_PATH,
      templateId: "literature",
    }));
    expect(report.status).toBe("guided");
    expect(report.rubric).toBeNull();
    expect(report.rubricDigest).toBeNull();
    expect(report.preparation?.binding.rubricDigest).toBeNull();
    expect(report.preparation?.taskId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["RUBRIC_MISSING"]);
    expect(report.rejection).toBeNull();
  });

  it("rejects an empty template id without creating vault files", async () => {
    const root = await makeRoot("oms-write-guidance-empty-");
    const report = await expectUnchanged(root, () => getWriteGuidance({
      target: target(root),
      notePath: NOTE_PATH,
      templateId: "",
    }));
    expect(report.status).toBe("rejected");
    expect(report.rejection?.code).toBe("TEMPLATE_ID_EMPTY");
    expect(report.preparation).toBeNull();
    expect(report.approvedMarkdown).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects an unknown template id, including the reserved word default", async () => {
    const root = await installVault(true);
    const unknown = await expectUnchanged(root, () => getWriteGuidance({
      target: target(root),
      notePath: NOTE_PATH,
      templateId: "missing-template",
    }));
    const reserved = await expectUnchanged(root, () => getWriteGuidance({
      target: target(root),
      notePath: NOTE_PATH,
      templateId: "default",
    }));
    expect(unknown.rejection?.code).toBe("TEMPLATE_UNKNOWN");
    expect(reserved.rejection?.code).toBe("TEMPLATE_UNKNOWN");
    expect(unknown.approvedMarkdown).toBeNull();
    expect(reserved.preparation).toBeNull();
  });

  it("rejects unsafe, hidden, and symlinked note paths", async () => {
    const root = await installVault(true);
    const outside = await makeRoot("oms-write-guidance-outside-");
    const traversal = await expectUnchanged(root, () => getWriteGuidance({
      target: target(root),
      notePath: "../escape.md",
    }));
    const hidden = await expectUnchanged(root, () => getWriteGuidance({
      target: target(root),
      notePath: ".hidden/note.md",
    }));
    expect(traversal.rejection?.code).toBe("PATH_UNSAFE");
    expect(hidden.rejection?.code).toBe("PATH_UNSAFE");
    expect(hidden.rejection?.message).toMatch(/hidden/);

    await symlink(outside, join(root, "Alias"));
    const linked = await expectUnchanged(root, () => getWriteGuidance({
      target: target(root),
      notePath: "Alias/new.md",
      templateId: "literature",
    }));
    expect(linked.rejection?.code).toBe("PATH_UNSAFE");
    expect(linked.rejection?.message).toMatch(/symlink/);
    expect(await readdir(outside)).toEqual([]);

    const snapshot = await loadResolvedTemplates(root);
    expect(() => prepareApprovedWrite({
      vaultRealPath: snapshot.vault,
      notePath: ".secret/a.md",
      snapshot,
      templateId: null,
    })).toThrow(WriteGuidanceFailure);
  });

  it("rejects a current-directory target before reading or creating vault bytes", async () => {
    const root = await makeRoot("oms-write-guidance-cwd-");
    const report = await expectUnchanged(root, () => getWriteGuidance({
      target: target(root, "cwd"),
      notePath: NOTE_PATH,
      templateId: "literature",
    }));
    expect(report.status).toBe("rejected");
    expect(report.rejection?.code).toBe("TARGET_UNVERIFIED");
    expect(report.rejection?.admission?.code).toBe("target-unverified");
    expect(report.rejection?.message).toMatch(/guide, check, or complete/);
    expect(report.preparation).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it("uses approved bytes when the local draft and raw source drift", async () => {
    const root = await installVault(true);
    await writeFile(join(root, ".oms", "templates", "literature.md"), "draft changed\n");
    await writeFile(join(root, "Sources", "literature.md"), "raw changed\n");
    const report = await expectUnchanged(root, () => getWriteGuidance({
      target: target(root),
      notePath: NOTE_PATH,
      templateId: "literature",
    }));
    expect(report.status).toBe("guided");
    expect(report.approvedMarkdown?.defaultLayer).toBe(DEFAULT_MARKDOWN);
    expect(report.approvedMarkdown?.templateLayer).toBe(LITERATURE_MARKDOWN);
    expect(report.approvedMarkdown?.templateLayer).not.toBe("draft changed\n");
    expect(report.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["MANAGED_TEMPLATE_DRIFT", "SOURCE_DRIFT"]);
    expect(report.diagnostics.find(diagnostic => diagnostic.code === "MANAGED_TEMPLATE_DRIFT")?.path).toBe(".oms/templates/literature.md");
    expect(report.diagnostics.find(diagnostic => diagnostic.code === "SOURCE_DRIFT")?.path).toBe("Sources/literature.md");
  });

  it("leaves the vault filesystem unchanged across guide reads and refusals", async () => {
    const root = await installVault(true);
    const reports: WriteGuidanceReport[] = [];
    await expectUnchanged(root, async () => {
      reports.push(await getWriteGuidance({ target: target(root), notePath: NOTE_PATH, templateId: "literature" }));
      reports.push(await getWriteGuidance({ target: target(root), templateId: null }));
      reports.push(await getWriteGuidance({ target: target(root), notePath: NOTE_PATH, templateId: "" }));
      reports.push(await getWriteGuidance({ target: target(root), notePath: "../escape.md" }));
      reports.push(await getWriteGuidance({ target: target(root, "cwd"), notePath: NOTE_PATH }));
      return reports;
    });
    expect(reports.map(report => report.status)).toEqual(["guided", "needs-path", "rejected", "rejected", "rejected"]);
    expect(reports[0]?.preparation?.notePath).toBe(NOTE_PATH);
  });
});
