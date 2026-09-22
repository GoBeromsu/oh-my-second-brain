import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { digestBytes } from "./canonical.js";
import { templateCensus } from "./census.js";
import {
  buildTemplateInterview,
  validateInterviewAnswer,
  type TemplateIndividualProposalInput,
  type TemplateInterviewQuestion,
  type TemplateProposalInput,
} from "./interview.js";
import { parseTemplatePolicy, serializeDerivedProjection } from "./policy.js";
import { controlGenerationDigest, expectedProjectionManaged, taxonomyRouting } from "./resolver.js";

const encoder = new TextEncoder();
const roots: string[] = [];
const RAW = "---\nstatus: open\ntype: literature\n---\n<% tp.file.title %>\n# Summary\n# Sources\n";

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

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-interview-"));
  roots.push(root);
  return root;
}

async function put(root: string, path: string, content: string | Uint8Array): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function signature(root: string): Promise<string> {
  const rows: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const name = relative(root, full).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) rows.push(`link ${name}`);
      else if (entry.isDirectory()) {
        rows.push(`dir ${name}`);
        await walk(full);
      } else if (entry.isFile()) rows.push(`file ${name} ${digestBytes(new Uint8Array(await readFile(full)))}`);
      else rows.push(`other ${name}`);
    }
  }
  await walk(root);
  return rows.join("\n");
}

function criterion() {
  return {
    criterionId: "cited",
    statement: "The note cites a source.",
    evidenceRequirement: "Quote a bound span.",
    requireByteVerification: true,
    sourceRefs: [{
      kind: "note-span",
      lineSpan: { start: 1, end: 1 },
      sliceDigest: digestBytes("Summary\n"),
    }],
  };
}

function proposals(): readonly TemplateProposalInput[] {
  const individual: TemplateIndividualProposalInput = {
    kind: "individual",
    templateId: "reading",
    sourcePath: "Templates/reading-note.md",
    sourceIdentity: "reading-source",
    fields: { cite: { property: "cite" } },
    headings: [{ headingId: "notes", title: "Notes", level: 2, required: true }],
    semanticCriteria: [criterion()],
    headingOrder: "strict",
  };
  return [
    { kind: "pool", properties: { cite: { type: "text", intent: "Citation." } } },
    individual,
    { kind: "taxonomy-placement", templateId: "reading", placement: { templateFolder: "Unread Notes" } },
    { kind: "completion", retryBudget: 4, agentRepair: { enabled: true, contexts: ["maintenance"] } },
  ];
}

async function sourceVault(text = RAW): Promise<string> {
  const root = await vault();
  await put(root, "Templates/reading-note.md", text);
  return root;
}

function question(interview: { readonly questions: readonly TemplateInterviewQuestion[] }, kind: TemplateInterviewQuestion["kind"]): TemplateInterviewQuestion {
  const found = interview.questions.find(item => item.kind === kind);
  if (found === undefined) throw new Error(`missing ${kind} question`);
  return found;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("explicit template interview", () => {
  it("asks for an empty pool, empty default, optional placement, and completion without inventing an id", async () => {
    const root = await sourceVault();
    const census = await templateCensus(root, {
      includeConfiguredPaths: false,
      selections: [{ path: "Templates", kind: "folder" }],
    });
    const interview = buildTemplateInterview(census);
    expect(interview.authority).toBe("absent");
    expect(interview.questions.map(item => item.kind)).toEqual(["pool", "default-layer", "taxonomy-placement", "completion"]);
    expect(interview.next).toBe(interview.questions[0]);
    expect(question(interview, "pool").proposal).toEqual({ kind: "pool", properties: {} });
    expect(question(interview, "default-layer").proposal).toEqual({
      kind: "default-layer",
      templatePath: ".oms/templates/default.md",
      approvedMarkdown: "",
      approvedMarkdownDigest: digestBytes(""),
      headingOrder: "unordered",
      fields: {},
      headings: [],
      semanticCriteria: [],
    });
    expect(question(interview, "taxonomy-placement").proposal).toEqual({ kind: "taxonomy-placement", templateId: null, placement: null });
    expect(question(interview, "completion").proposal).toEqual({
      kind: "completion",
      retryBudget: 2,
      agentRepair: { enabled: false },
    });
    expect(interview.questions.some(item => item.kind === "individual")).toBe(false);
    expect(JSON.stringify(interview.questions.map(item => item.proposal))).not.toContain("reading-note");
    expect(JSON.stringify(interview.questions.map(item => item.proposal))).not.toContain("<%");

    const pool = question(interview, "pool");
    const answer = validateInterviewAnswer(pool, { disposition: "confirm", raw: "add status as a select and require Summary" });
    const confirmed = buildTemplateInterview(census, { answers: [answer] });
    expect(confirmed.confirmed).toEqual([expect.objectContaining({
      raw: "add status as a select and require Summary",
      proposal: { kind: "pool", properties: {} },
    })]);
    expect(confirmed.next?.kind).toBe("default-layer");
  });

  it("confirms only explicit pool and additive proposals and keeps a deferred answer raw", async () => {
    const root = await sourceVault();
    const census = await templateCensus(root, {
      includeConfiguredPaths: false,
      selections: [{ path: "Templates", kind: "folder" }],
    });
    const input = proposals();
    let interview = buildTemplateInterview(census, { proposals: input });
    expect(interview.questions.map(item => item.kind)).toEqual([
      "pool",
      "default-layer",
      "individual",
      "taxonomy-placement",
      "completion",
    ]);
    const answers = [];
    const steps: TemplateInterviewQuestion["kind"][] = ["pool", "default-layer", "individual", "taxonomy-placement", "completion"];
    const dispositions = ["confirm", "defer", "defer", "unresolved", "confirm"] as const;
    for (const [index, kind] of steps.entries()) {
      expect(interview.next?.kind).toBe(kind);
      const current = interview.next;
      if (current === undefined) throw new Error("missing next question");
      answers.push(validateInterviewAnswer(current, {
        disposition: dispositions[index],
        raw: kind === "individual" ? "rename it reading-note and require Summary" : `answer ${kind}`,
      }));
      interview = buildTemplateInterview(census, { proposals: input, answers });
    }
    expect(interview.next).toBeUndefined();
    expect(interview.confirmed.map(item => item.proposal.kind)).toEqual(["pool", "completion"]);
    expect(interview.deferred.map(item => item.proposal.kind)).toEqual(["default-layer", "individual"]);
    expect(interview.unresolved.map(item => item.proposal.kind)).toEqual(["taxonomy-placement"]);
    const pool = interview.confirmed[0]?.proposal;
    expect(pool).toMatchObject({ kind: "pool", properties: { cite: { type: "text", intent: "Citation." } } });
    expect(pool && pool.kind === "pool" ? Object.keys(pool.properties) : []).toEqual(["cite"]);
    const individual = interview.deferred.find(item => item.proposal.kind === "individual")?.proposal;
    expect(individual).toMatchObject({
      kind: "individual",
      templateId: "reading",
      templatePath: ".oms/templates/reading.md",
      headingOrder: "strict",
      source: { path: "Templates/reading-note.md", identity: "reading-source" },
    });
    if (individual?.kind !== "individual") throw new Error("missing individual proposal");
    expect(Object.keys(individual.fields)).toEqual(["cite"]);
    expect(individual.headings.map(heading => heading.title)).toEqual(["Notes"]);
    expect(individual.semanticCriteria.map(criterion => criterion.criterionId)).toEqual(["cited"]);
    expect(individual.semanticCriteria[0]?.statement).toBe("The note cites a source.");
    expect(JSON.stringify(individual)).not.toContain("<%");
    expect(individual.templatePath).toBe(".oms/templates/reading.md");
    expect(JSON.stringify(individual)).not.toContain("type: literature");
    expect(interview.deferred.find(item => item.proposal.kind === "individual")?.raw).toBe("rename it reading-note and require Summary");
    expect(interview.confirmed.find(item => item.proposal.kind === "completion")?.proposal).toMatchObject({
      retryBudget: 4,
      agentRepair: { enabled: true, contexts: ["maintenance"] },
    });
    expect(interview.unresolved[0]?.proposal).toEqual({
      kind: "taxonomy-placement",
      templateId: "reading",
      placement: { templateFolder: "Unread Notes" },
    });
  });

  it("rejects contract-shaped answers and caller anchor overrides", async () => {
    const root = await sourceVault();
    const census = await templateCensus(root, {
      includeConfiguredPaths: false,
      selections: [{ path: "Templates", kind: "folder" }],
    });
    const interview = buildTemplateInterview(census);
    const pool = question(interview, "pool");
    expect(() => validateInterviewAnswer(pool, { disposition: "confirm", raw: "yes", properties: { status: { type: "select" } } })).toThrow(/TEMPLATE_INTERVIEW_ANSWER_INVALID/);
    expect(() => validateInterviewAnswer(pool, { disposition: "confirm", raw: "yes", anchorDigest: digestBytes("override") })).toThrow(/anchor does not match/);
    const accepted = validateInterviewAnswer(pool, { disposition: "confirm", raw: "  yes  " });
    expect(accepted.anchorDigest).toBe(pool.anchorDigest);
    expect(accepted.censusDigest).toBe(interview.censusDigest);
    expect(accepted.raw).toBe("  yes  ");
    const forged = buildTemplateInterview(census, { answers: [{ ...accepted, anchorDigest: digestBytes("override") }] });
    expect(forged.invalidatedQuestionIds).toEqual([pool.questionId]);
    expect(forged.confirmed).toEqual([]);
    expect(forged.next?.questionId).toBe(pool.questionId);
  });

  it("does not open an interview for invalid authority, source drift, or an ordinary note", async () => {
    const invalid = await vault();
    await put(invalid, ".oms/template-policy.json", "{");
    await put(invalid, "Templates/reading-note.md", RAW);
    const invalidCensus = await templateCensus(invalid, {
      includeConfiguredPaths: false,
      selections: [{ path: "Templates", kind: "folder" }],
    });
    const invalidInterview = buildTemplateInterview(invalidCensus, { proposals: proposals() });
    expect(invalidInterview.authority).toBe("invalid");
    expect(invalidInterview.questions).toEqual([]);
    expect(invalidInterview.confirmed).toEqual([]);

    const approved = await vault();
    const original = encoder.encode("approved\n");
    const policy = {
      version: 4,
      properties: {},
      default: layer(".oms/templates/default.md", ""),
      templates: {
        literature: layer(".oms/templates/literature.md", "", {
          templateId: "literature",
          source: { path: "Sources/literature.md", identity: "literature-source", rawDigest: digestBytes(original) },
        }),
      },
    };
    const policyText = JSON.stringify(policy);
    const taxonomyText = "{}";
    const generation = controlGenerationDigest(encoder.encode(policyText), encoder.encode(taxonomyText));
    const projection = serializeDerivedProjection({
      version: "oms.types.v2",
      generatedFrom: generation,
      managed: expectedProjectionManaged(parseTemplatePolicy(policyText), taxonomyRouting(".oms/taxonomy.json", encoder.encode(taxonomyText)), generation),
    });
    await put(approved, ".oms/template-policy.json", policyText);
    await put(approved, ".oms/taxonomy.json", taxonomyText);
    await put(approved, ".oms/types.json", projection);
    await put(approved, ".oms/templates/default.md", "");
    await put(approved, ".oms/templates/literature.md", "");
    await put(approved, "Sources/literature.md", "drifted\n");
    await put(approved, "Notes/plain.md", "unmanaged property status is missing\n");
    const census = await templateCensus(approved, {
      includeConfiguredPaths: false,
      selections: [{ path: "Sources", kind: "folder" }, { path: "Notes", kind: "folder" }],
    });
    const interview = buildTemplateInterview(census);
    expect(interview.authority).toBe("approved");
    expect(interview.questions).toEqual([]);
    expect(census.diagnostics.some(item => item.code === "SOURCE_DRIFT")).toBe(true);
    expect(census.diffs.find(diff => diff.path === "Notes/plain.md")?.templateId).toBeNull();
  });

  it("invalidates only the proposal whose source bytes changed and resumes at one question", async () => {
    const root = await sourceVault();
    const selection = { includeConfiguredPaths: false, selections: [{ path: "Templates", kind: "folder" }] } as const;
    const census = await templateCensus(root, selection);
    const input = proposals();
    const first = buildTemplateInterview(census, { proposals: input });
    const pool = question(first, "pool");
    const individual = question(first, "individual");
    const answers = [
      validateInterviewAnswer(pool, { disposition: "confirm", raw: "use the explicit pool" }),
      validateInterviewAnswer(individual, { disposition: "confirm", raw: "use the explicit template" }),
    ];
    await put(root, "Templates/reading-note.md", `${RAW}\nchanged\n`);
    const nextCensus = await templateCensus(root, selection);
    const second = buildTemplateInterview(nextCensus, { proposals: input, answers });
    expect(second.censusDigest).not.toBe(first.censusDigest);
    expect(second.invalidatedQuestionIds).toEqual([individual.questionId]);
    expect(second.confirmed.map(item => item.questionId)).toEqual([pool.questionId]);
    expect(second.next?.kind).toBe("default-layer");
    const resumed = buildTemplateInterview(nextCensus, {
      proposals: input,
      answers: [answers[0]!, validateInterviewAnswer(second.questions.find(item => item.kind === "default-layer")!, { disposition: "defer", raw: "later" })],
    });
    expect(resumed.next?.kind).toBe("individual");
    expect(resumed.deferred.map(item => item.proposal.kind)).toEqual(["default-layer"]);
  });

  it("does not write notes or controls while preparing questions", async () => {
    const root = await sourceVault();
    await put(root, "Notes/plain.md", "ordinary note\n");
    const before = await signature(root);
    const census = await templateCensus(root, {
      includeConfiguredPaths: false,
      selections: [{ path: "Templates", kind: "folder" }, { path: "Notes", kind: "folder" }],
    });
    buildTemplateInterview(census, { proposals: proposals() });
    expect(await signature(root)).toBe(before);
  });
});
