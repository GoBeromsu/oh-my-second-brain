import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveContentFormatContract } from "./content-contract.js";
import { buildTemplateInterview, validateInterviewAnswer, type TemplateInterviewQuestion } from "./interview.js";
import type { TemplateReviewContext } from "./review-context.js";
import { normalizeTemplateFolderPath, normalizeTemplateSourcePath, validateTemplateId } from "./paths.js";
import type {
  CensusResult,
  CensusEntry,
  CensusDiff,
} from "./census.js";
import type {
  ContractDefinition,
  Digest,
  TemplateBinding,
  TemplatePolicy,
} from "./types.js";
import type { InterviewLedgerAnswer } from "./interview-ledger.js";

const encoder = new TextEncoder();
const TEMPLATE = "---\ntitle: '{{title}}'\n---\n# Daily\nBody\n";

function digest(value: string): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sourcePath(value: string) {
  return normalizeTemplateSourcePath(value);
}

function id(value: string) {
  return validateTemplateId(value);
}

function contract(fields: ContractDefinition["fields"] = {}): ContractDefinition {
  return { intent: "A note", fields, views: [] };
}

function binding(templateId: string, path: string, contractName = "note"): TemplateBinding {
  const normalized = sourcePath(path);
  return {
    templateId: id(templateId),
    destinationClass: "managed-default",
    renderer: "obsidian-core",
    sourceFolder: sourcePath(normalized.slice(0, normalized.lastIndexOf("/")) + "/folder.md").replace(/\/folder\.md$/u, "") as TemplateBinding["sourceFolder"],
    sourcePath: normalized,
    contract: contractName,
    naming: "{{title}}",
  };
}

function contentBinding(templateId: string, path: string, content?: TemplateBinding["content"]): TemplateBinding {
  return { ...binding(templateId, path), ...(content === undefined ? {} : { content }) };
}

function entry(path: string, bytes = TEMPLATE, templateId?: string): CensusEntry {
  const normalized = sourcePath(path);
  const value = encoder.encode(bytes);
  return {
    sourcePath: normalized,
    bytes: value,
    signature: digest(bytes),
    ...(templateId === undefined ? {} : { templateId: id(templateId) }),
    diagnostics: [],
  };
}

function census(entries: readonly CensusEntry[], diffs: readonly CensusDiff[] = []): CensusResult {
  return { entries, diffs, diagnostics: [], digest: digest(JSON.stringify({ entries: entries.map(item => item.sourcePath), diffs })) };
}

function context(
  policy: TemplatePolicy,
  entries: readonly CensusEntry[],
  diffs: readonly CensusDiff[] = [],
  options: Partial<Pick<TemplateReviewContext, "projectionUsable" | "freshTemplateIds" | "obsidianTypes">> = {},
): TemplateReviewContext {
  return {
    vault: "/vault",
    policy,
    census: census(entries, diffs),
    obsidianTypes: options.obsidianTypes ?? {},
    censusDigest: digest("review"),
    projectionUsable: options.projectionUsable ?? false,
    freshTemplateIds: options.freshTemplateIds ?? [],
  };
}

function policy(bindings: readonly TemplateBinding[], fields: ContractDefinition["fields"] = {}): TemplatePolicy {
  return {
    version: 3,
    templateFolders: [{ path: "Templates", default: true }],
    base: { fields: {} },
    contracts: { note: contract(fields) },
    templates: Object.fromEntries(bindings.map(item => [item.templateId, item])),
  };
}

function answer(question: TemplateInterviewQuestion, value: unknown): InterviewLedgerAnswer {
  return validateInterviewAnswer(question, value);
}

function approvedContent(body: string, templateId = "daily", required = true): NonNullable<TemplateBinding["content"]> {
  const observed = deriveContentFormatContract(body, { templateId });
  return deriveContentFormatContract(body, {
    templateId,
    decisions: {
      nodes: observed.contract.nodes
        .filter(node => node.kind !== "placeholder")
        .map(node => ({ anchorDigest: node.anchorDigest, required })),
    },
  }).contract;
}

describe("template interview model", () => {
  it("keeps unchanged authored bindings and answers question-free", () => {
    const content = deriveContentFormatContract("# Daily\nBody\n", {
      templateId: "daily",
      decisions: { order: "unordered", nodes: [{ anchorDigest: digest("# Daily"), required: true }] },
    }).contract;
    const known = { ...binding("daily", "Templates/daily.md"), content };
    const fields = { title: { type: "text" as const, required: true, intent: "The note title" } };
    const result = buildTemplateInterview(
      context(policy([known], fields), [entry("Templates/daily.md", "---\ntitle: '{{title}}'\n---\n# Daily\nBody\n", "daily")], [], {
        projectionUsable: true,
        freshTemplateIds: [id("daily")],
      }),
      {},
    );
    expect(result.questions).toEqual([]);
    expect(result.proposedPolicy?.templates.daily?.templateId).toBe(id("daily"));
    expect(result.proposedPolicy?.templates.daily?.destinationClass).toBe("registered-existing");
    expect(result.proposedPolicy?.templates.daily?.approvedSourceSignature).toBe(digest(TEMPLATE));
  });

  it("does not ask optional metadata questions for an unchanged verified binding", () => {
    const fields = { title: { type: "text" as const, required: true } };
    const known = binding("daily", "Templates/daily.md");
    const result = buildTemplateInterview(
      context(policy([known], fields), [entry("Templates/daily.md", TEMPLATE, "daily")], [], {
        projectionUsable: true,
        freshTemplateIds: [id("daily")],
      }),
      {},
    );
    expect(result.questions).toEqual([]);
    expect(result.proposedPolicy?.contracts.note.fields).toEqual(fields);
    expect(result.proposedPolicy?.templates.daily?.templateId).toBe(id("daily"));
  });

  it("asks for unknown metadata and concrete body decisions without asking placement", () => {
    const result = buildTemplateInterview(
      context(policy([], { title: { type: "text", required: false, intent: "Authored title" } }), [entry("Templates/new.md", "---\ntitle: '{{title}}'\nstatus: draft\n---\n# Daily\nBody\n")], [], { obsidianTypes: { title: "text" } }),
      {},
    );
    expect(result.questions.some(question => question.kind === "field-requiredness" && question.subject === "field:status")).toBe(true);
    expect(result.questions.some(question => question.kind === "field-intent" && question.subject === "field:status")).toBe(true);
    expect(result.questions.some(question => question.subject === "field:title")).toBe(false);
    expect(result.questions.some(question => question.kind === "content-section-requiredness")).toBe(true);
    expect(result.questions.some(question => question.kind === "content-order")).toBe(false);
    expect(result.questions.some(question => question.kind === "naming")).toBe(true);
    expect(result.questions.some(question => question.kind.includes("placement"))).toBe(false);
    expect(result.proposedPolicy).toBeUndefined();
  });

  it("asks exactly for a newly added node when an approved content contract exists", () => {
    const knownContent = deriveContentFormatContract("# Daily", {
      templateId: "daily",
      decisions: { nodes: [{ anchorDigest: deriveContentFormatContract("# Daily").contract.nodes[0]!.anchorDigest, required: true }] },
    }).contract;
    const known = contentBinding("daily", "Templates/daily.md", knownContent);
    const current = entry("Templates/daily.md", "---\ntitle: literal\n---\n# Daily\n# New\n", "daily");
    const result = buildTemplateInterview(
      context(policy([known], { title: { type: "text", required: true, intent: "Title" } }), [current], [], {
        projectionUsable: true,
        freshTemplateIds: [],
      }),
      {},
    );
    expect(result.questions.map(question => question.subject)).toEqual(["heading:1:New"]);
  });

  it("uses the deepest selected folder for nested sources and preserves a valid authored scope", () => {
    const folders: TemplatePolicy["templateFolders"] = [
      { path: normalizeTemplateFolderPath("Templates"), default: true as const },
      { path: normalizeTemplateFolderPath("Templates/team") },
    ];
    const nestedPolicy = { ...policy([]), templateFolders: folders };
    const nestedContext = context(nestedPolicy, [entry("Templates/team/new.md")], [], { obsidianTypes: { title: "text" } });
    const pending = buildTemplateInterview(nestedContext, {});
    const values = Object.fromEntries(pending.questions.map(item => {
      if (item.kind === "field-type") return [item.questionId, answer(item, "text")];
      if (item.kind === "field-requiredness" || item.kind === "content-section-requiredness") return [item.questionId, answer(item, "optional")];
      return [item.questionId, answer(item, "authored")];
    }));
    const nested = buildTemplateInterview(nestedContext, values);
    expect(nested.proposedPolicy?.templates.new?.sourceFolder).toBe("Templates/team");

    const authored = binding("new", "Templates/team/new.md");
    const preserved = { ...authored, sourceFolder: "Templates" as TemplateBinding["sourceFolder"] };
    const existing = buildTemplateInterview(
      context({ ...policy([preserved]), templateFolders: folders }, [entry("Templates/team/new.md", TEMPLATE, "new")], [], {
        projectionUsable: true,
        freshTemplateIds: [id("new")],
      }),
      {},
    );
    expect(existing.proposedPolicy?.templates.new?.sourceFolder).toBe("Templates");
  });

  it("does not reopen identity for a known non-sluggable source name", () => {
    const known = binding("known", "Templates/!!!.md");
    const result = buildTemplateInterview(
      context(policy([known]), [entry("Templates/!!!.md", TEMPLATE, "known")], [], {
        projectionUsable: true,
        freshTemplateIds: [id("known")],
      }),
      {},
    );
    expect(result.questions.some(item => item.kind === "rename-identity")).toBe(false);
    expect(result.proposedPolicy?.templates.known?.templateId).toBe(id("known"));
  });

  it("blocks an unsupported existing source without dropping its binding", () => {
    const known = binding("known", "Templates/known.md");
    const unsupported = entry(
      "Templates/known.md",
      "---\ntitle: '{{tp.system.run()}}'\n---\n# Daily\n",
      "known",
    );
    const result = buildTemplateInterview(
      context(policy([known]), [unsupported], [], {
        projectionUsable: true,
        freshTemplateIds: [id("known")],
      }),
      {},
    );
    expect(result.diagnostics.some(item => item.code === "TEMPLATE_EXPRESSION_UNSUPPORTED")).toBe(true);
    expect(result.proposedPolicy).toBeUndefined();
    expect(result.reviewedTemplateIds).not.toContain(id("known"));
  });

  it("reopens strict order after a reorder and after a newly required node", () => {
    const observed = deriveContentFormatContract("# First\n# Second", { templateId: "daily" }).contract;
    const knownContent = deriveContentFormatContract("# First\n# Second", {
      templateId: "daily",
      decisions: {
        order: "strict",
        nodes: observed.nodes
          .filter(node => node.kind !== "placeholder")
          .map(node => ({ anchorDigest: node.anchorDigest, required: true })),
      },
    }).contract;
    const known = contentBinding("daily", "Templates/daily.md", knownContent);
    const reorderedContext = context(
      policy([known], { title: { type: "text", required: true, intent: "Title" } }),
      [entry("Templates/daily.md", "---\ntitle: literal\n---\n# Second\n# First\n", "daily")],
      [],
      { projectionUsable: true, freshTemplateIds: [] },
    );
    const reordered = buildTemplateInterview(reorderedContext, {});
    expect(reordered.questions.filter(item => item.kind === "content-section-requiredness")).toHaveLength(0);
    expect(reordered.questions.filter(item => item.kind === "content-order")).toHaveLength(1);

    const addedContext = context(
      policy([known], { title: { type: "text", required: true, intent: "Title" } }),
      [entry("Templates/daily.md", "---\ntitle: literal\n---\n# First\n# Second\n# Third\n", "daily")],
      [],
      { projectionUsable: true, freshTemplateIds: [] },
    );
    const addedPending = buildTemplateInterview(addedContext, {});
    const addedNode = addedPending.questions.find(item => item.subject === "heading:1:Third");
    if (addedNode === undefined) throw new Error("expected added node question");
    const addedRequired = buildTemplateInterview(addedContext, {
      [addedNode.questionId]: answer(addedNode, "required"),
    });
    expect(addedRequired.questions.filter(item => item.kind === "content-order")).toHaveLength(1);
  });

  it("asks only for a changed existing body node and not unrelated prose", () => {
    const observed = deriveContentFormatContract("# Daily", { templateId: "daily" }).contract;
    const knownContent = deriveContentFormatContract("# Daily", {
      templateId: "daily",
      decisions: { nodes: [{ anchorDigest: observed.nodes[0]!.anchorDigest, required: true }] },
    }).contract;
    const known = contentBinding("daily", "Templates/daily.md", knownContent);
    const current = entry("Templates/daily.md", "---\ntitle: literal\n---\n# Changed\nunrelated prose\n", "daily");
    const result = buildTemplateInterview(
      context(policy([known], { title: { type: "text", required: true, intent: "Title" } }), [current], [], {
        projectionUsable: true,
        freshTemplateIds: [],
      }),
      {},
    );
    expect(result.questions.map(question => question.subject)).toEqual(["heading:1:Changed"]);
  });

  it("asks content order only after two required answers and not for one", () => {
    const known = contentBinding("daily", "Templates/daily.md");
    const current = entry("Templates/daily.md", "---\ntitle: literal\n---\n# First\n# Second\n", "daily");
    const reviewContext = context(policy([known], { title: { type: "text", required: true, intent: "Title" } }), [current], [], {
      projectionUsable: false,
    });
    const first = buildTemplateInterview(reviewContext, {});
    const nodeQuestions = first.questions.filter(question => question.kind === "content-section-requiredness");
    expect(first.questions.some(question => question.kind === "content-order")).toBe(false);
    const oneRequired = { [nodeQuestions[0]!.questionId]: answer(nodeQuestions[0]!, "required") };
    const one = buildTemplateInterview(reviewContext, oneRequired);
    expect(one.questions.some(question => question.kind === "content-order")).toBe(false);
    const bothRequired = Object.fromEntries(nodeQuestions.map(question => [question.questionId, answer(question, "required")]));
    const two = buildTemplateInterview(reviewContext, bothRequired);
    const order = two.questions.filter(question => question.kind === "content-order");
    expect(order).toHaveLength(1);
    expect(two.proposedPolicy).toBeUndefined();
    const complete = buildTemplateInterview(reviewContext, {
      ...bothRequired,
      [order[0]!.questionId]: answer(order[0]!, "strict"),
    });
    expect(complete.questions).toEqual([]);
    expect(complete.proposedPolicy).toBeDefined();
  });

  it("invalidates all repeated-node answers when a duplicate occurrence is added", () => {
    const observed = deriveContentFormatContract("# A\n# A", { templateId: "daily" }).contract;
    const knownContent = deriveContentFormatContract("# A\n# A", {
      templateId: "daily",
      decisions: {
        nodes: observed.nodes.filter(node => node.kind === "heading").map(node => ({ anchorDigest: node.anchorDigest, required: true })),
      },
    }).contract;
    const known = contentBinding("daily", "Templates/daily.md", knownContent);
    const current = entry("Templates/daily.md", "---\ntitle: literal\n---\n# A\n# A\n# A\n", "daily");
    const result = buildTemplateInterview(
      context(policy([known], { title: { type: "text", required: true, intent: "Title" } }), [current], [], {
        projectionUsable: true,
        freshTemplateIds: [],
      }),
      {},
    );
    expect(result.questions.filter(question => question.kind === "content-section-requiredness")).toHaveLength(5);
    expect(result.proposedPolicy).toBeUndefined();
  });

  it("does not drop a deleted required node without explicit removal", () => {
    const known = contentBinding("daily", "Templates/daily.md", approvedContent("# Required"));
    const current = entry("Templates/daily.md", "---\ntitle: literal\n---\nBody\n", "daily");
    const reviewContext = context(policy([known], { title: { type: "text", required: true, intent: "Title" } }), [current], [], {
      projectionUsable: true,
      freshTemplateIds: [],
    });
    const pending = buildTemplateInterview(reviewContext, {});
    const deletion = pending.questions.filter(question => question.kind === "content-section-requiredness");
    expect(deletion).toHaveLength(1);
    expect(pending.proposedPolicy).toBeUndefined();

    const removed = buildTemplateInterview(reviewContext, { [deletion[0]!.questionId]: answer(deletion[0]!, "optional") });
    expect(removed.questions).toEqual([]);
    expect(removed.proposedPolicy).toBeDefined();
    expect(removed.proposedPolicy?.templates.daily?.content?.nodes.some(node => node.kind === "heading")).toBe(false);
  });

  it("keeps a deleted required rule blocked and read-only when explicitly retained", () => {
    const known = contentBinding("daily", "Templates/daily.md", approvedContent("# Required"));
    const current = entry("Templates/daily.md", "---\ntitle: literal\n---\nBody\n", "daily");
    const reviewContext = context(policy([known], { title: { type: "text", required: true, intent: "Title" } }), [current], [], {
      projectionUsable: true,
      freshTemplateIds: [],
    });
    const pending = buildTemplateInterview(reviewContext, {});
    const deletion = pending.questions.find(question => question.kind === "content-section-requiredness");
    if (deletion === undefined) throw new Error("expected deleted required-node question");
    const kept = buildTemplateInterview(reviewContext, { [deletion.questionId]: answer(deletion, "required") });
    expect(kept.questions).toEqual([]);
    expect(kept.proposedPolicy).toBeUndefined();
    expect(kept.diagnostics.some(diagnostic => diagnostic.code === "TEMPLATE_CONTRACT_UNOBSERVED")).toBe(true);
  });

  it("does not ask for optional node removal and combines a simple replacement into one question", () => {
    const optional = contentBinding("daily", "Templates/daily.md", approvedContent("# Optional", "daily", false));
    const optionalCurrent = entry("Templates/daily.md", "---\ntitle: literal\n---\nBody\n", "daily");
    const optionalReview = context(policy([optional], { title: { type: "text", required: true, intent: "Title" } }), [optionalCurrent], [], {
      projectionUsable: true,
      freshTemplateIds: [],
    });
    const optionalResult = buildTemplateInterview(optionalReview, {});
    expect(optionalResult.questions.filter(question => question.kind === "content-section-requiredness")).toEqual([]);
    expect(optionalResult.proposedPolicy).toBeDefined();

    const required = contentBinding("daily", "Templates/daily.md", approvedContent("# Old"));
    const replacementCurrent = entry("Templates/daily.md", "---\ntitle: literal\n---\n# New\n", "daily");
    const replacementReview = context(policy([required], { title: { type: "text", required: true, intent: "Title" } }), [replacementCurrent], [], {
      projectionUsable: true,
      freshTemplateIds: [],
    });
    const replacement = buildTemplateInterview(replacementReview, {});
    const slot = replacement.questions.filter(question => question.kind === "content-section-requiredness");
    expect(slot).toHaveLength(1);
    expect(slot[0]?.subject).toBe("heading:1:New");
    const completed = buildTemplateInterview(replacementReview, { [slot[0]!.questionId]: answer(slot[0]!, "required") });
    expect(completed.questions).toEqual([]);
    expect(completed.proposedPolicy).toBeDefined();
    expect(completed.diagnostics.some(diagnostic => diagnostic.code === "TEMPLATE_CONTRACT_UNOBSERVED")).toBe(false);
  });

  it("invalidates only the changed frontmatter anchor and keeps unrelated body anchors", () => {
    const initial = context(policy([], { title: { type: "text", required: false, intent: "Authored title" } }), [entry("Templates/new.md", "---\ntitle: '{{title}}'\nstatus: draft\n---\n# Daily\nBody\n")], [], { obsidianTypes: { title: "text" } });
    const first = buildTemplateInterview(initial, {});
    const required = first.questions.find(question => question.kind === "field-requiredness" && question.subject === "field:status");
    if (required === undefined) throw new Error("expected requiredness question");
    const heading = first.questions.find(question => question.kind === "content-section-requiredness");
    if (heading === undefined) throw new Error("expected heading question");
    const stored = answer(required, "required");
    const storedHeading = answer(heading, "required");
    const changed = context(policy([], { title: { type: "text", required: false, intent: "Authored title" } }), [entry("Templates/new.md", "---\ntitle: '{{title}}'\nstatus: changed\n---\n# Daily\nEdited prose\n")], [], { obsidianTypes: { title: "text" } });
    const resumed = buildTemplateInterview(changed, { [required.questionId]: stored, [heading.questionId]: storedHeading });
    expect(resumed.invalidatedQuestionIds).toContain(required.questionId);
    expect(resumed.questions.some(question => question.questionId === heading.questionId)).toBe(false);
  });

  it("supports interrupted resume and preserves explicit policy semantics", () => {
    const authored = binding("daily", "Templates/daily.md");
    const explicit = policy([authored], { title: { type: "text", required: false, intent: "Authored title" } });
    const result = buildTemplateInterview(
      context(explicit, [entry("Templates/daily.md", TEMPLATE, "daily")], [], { projectionUsable: true, freshTemplateIds: [id("daily")] }),
      {},
    );
    expect(result.questions).toEqual([]);
    expect(result.proposedPolicy?.contracts.note.fields.title?.required).toBe(false);
    expect(result.proposedPolicy?.contracts.note.fields.title?.intent).toBe("Authored title");
  });

  it("asks before carrying a suggested rename but carries a unique identical-byte rename", () => {
    const authored = contentBinding("daily", "Templates/daily.md", approvedContent("# Daily\nBody\n"));
    const changedPath = entry("Templates/renamed.md", TEMPLATE);
    const suggested: CensusDiff = {
      kind: "renamed",
      sourcePath: changedPath.sourcePath,
      oldSourcePath: authored.sourcePath,
      newSourcePath: changedPath.sourcePath,
      templateId: id("renamed"),
      automatic: false,
      confirmationRequired: true,
      strategy: "body-signature",
    };
    const pending = buildTemplateInterview(context(policy([authored], {
      title: { type: "text", required: true, intent: "The note title" },
    }), [changedPath], [suggested]), {});
    expect(pending.questions.some(question => question.kind === "rename-identity")).toBe(true);
    expect(pending.proposedPolicy).toBeUndefined();

    const automatic: CensusDiff = { ...suggested, automatic: true, confirmationRequired: false, strategy: "identical-bytes" };
    const carried = buildTemplateInterview(context(policy([authored], {
      title: { type: "text", required: true, intent: "The note title" },
    }), [changedPath], [automatic]), {});
    expect(carried.questions).not.toContainEqual(expect.objectContaining({ kind: "rename-identity" }));
    expect(carried.proposedPolicy?.templates.daily?.sourcePath).toBe(changedPath.sourcePath);
  });

  it("resolves duplicate and Unicode identities through explicit questions", () => {
    const first = entry("Templates/one.md", TEMPLATE, "same");
    const second = entry("Templates/two.md", TEMPLATE, "same");
    const pending = buildTemplateInterview(context(policy([]), [first, second]), {});
    const identityQuestions = pending.questions.filter(question => question.kind === "rename-identity");
    expect(identityQuestions).toHaveLength(2);
    const answers = Object.fromEntries(identityQuestions.map((question, index) => [question.questionId, answer(question, index === 0 ? "one" : "two")]));
    const resolved = buildTemplateInterview(context(policy([]), [first, second]), answers);
    expect(resolved.questions.some(question => question.kind === "rename-identity")).toBe(false);
    expect(resolved.questions.every(question => question.templateId === "one" || question.templateId === "two")).toBe(true);

    const korean = buildTemplateInterview(context(policy([]), [entry("Templates/한글.md")]), {});
    expect(korean.questions.find(question => question.kind === "rename-identity")).toBeUndefined();
  });

  it("retires a deleted source without touching source paths", () => {
    const authored = binding("daily", "Templates/daily.md");
    const diff: CensusDiff = {
      kind: "deleted",
      sourcePath: authored.sourcePath,
      templateId: authored.templateId,
      automatic: true,
      confirmationRequired: false,
    };
    const pending = buildTemplateInterview(context(policy([authored]), [], [diff]), {});
    const question = pending.questions.find(item => item.kind === "deleted-source-disposition");
    if (question === undefined) throw new Error("expected deletion question");
    const result = buildTemplateInterview(context(policy([authored]), [], [diff]), { [question.questionId]: answer(question, "retire") });
    expect(result.proposedPolicy?.templates.daily).toBeUndefined();
    expect(result.proposedPolicy?.defaultTemplate).toBeUndefined();
  });

  it("rejects invalid answer selections and does not accept policy-shaped values", () => {
    const question: TemplateInterviewQuestion = {
      questionId: digest("question"),
      templateId: "daily",
      kind: "field-requiredness",
      subject: "field:title",
      anchorDigest: digest("anchor"),
      prompt: "required?",
      choices: ["required", "optional"],
    };
    expect(() => validateInterviewAnswer(question, "maybe")).toThrow("TEMPLATE_INTERVIEW_ANSWER_INVALID");
    expect(() => validateInterviewAnswer(question, { required: true })).toThrow("TEMPLATE_INTERVIEW_ANSWER_INVALID");
    expect(validateInterviewAnswer(question, "required").value).toBe("required");
  });

  it("specializes a generated template without mutating the shared sibling contract", () => {
    const sibling = binding("sibling", "Templates/sibling.md");
    const result = buildTemplateInterview(context(policy([sibling]), [entry("Templates/new.md")], [], { obsidianTypes: { title: "text" } }), {});
    expect(result.proposedPolicy).toBeUndefined();
    expect(result.diagnostics.some(item => item.code === "TEMPLATE_ID_DUPLICATE")).toBe(false);
    expect(result.proposedPolicy?.contracts.note).toBeUndefined();
  });
});
