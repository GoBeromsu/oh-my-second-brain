import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { WriteTarget } from "../capture/safe.js";
import { digestBytes } from "./canonical.js";
import {
  answerTemplateInterview,
  commitTemplateContracts,
  nextTemplateInterview,
  type TemplateInterviewServiceResult,
} from "./interview-service.js";
import { readInterviewLedger } from "./interview-ledger.js";
import {
  type TemplateIndividualProposalInput,
  type TemplateInterviewQuestion,
  type TemplateProposalInput,
} from "./interview.js";
import { parseTemplatePolicy, serializeDerivedProjection } from "./policy.js";
import { controlGenerationDigest, expectedProjectionManaged, taxonomyRouting } from "./resolver.js";

const roots: string[] = [];
const encoder = new TextEncoder();
const RAW = "---\nstatus: open\ntype: literature\n---\n<% tp.file.title %>\n# Summary\n# Sources\n";
const target = (vault: string, source: WriteTarget["source"] = "explicit"): WriteTarget => ({ vault, source });
const initialRuntimeRoot = process.env.OMS_RUNTIME_ROOT;

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

async function put(root: string, path: string, content: string | Uint8Array): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-interview-service-"));
  roots.push(root);
  const runtime = join(root, "runtime");
  process.env.OMS_RUNTIME_ROOT = runtime;
  await mkdir(runtime, { recursive: true });
  await put(root, ".obsidian/templates.json", JSON.stringify({ folder: "Templates" }));
  await put(root, "Templates/reading-note.md", RAW);
  return root;
}

async function approvedVault(): Promise<string> {
  const root = await fixture();
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
  await put(root, ".oms/template-policy.json", policyText);
  await put(root, ".oms/taxonomy.json", taxonomyText);
  await put(root, ".oms/types.json", projection);
  await put(root, ".oms/templates/default.md", "");
  await put(root, ".oms/templates/literature.md", "");
  await put(root, "Sources/literature.md", original);
  await put(root, "Notes/plain.md", "ordinary note\n");
  return root;
}

async function vaultSnapshot(root: string): Promise<Readonly<Record<string, string>>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = "";
        await visit(join(directory, entry.name), relative);
      } else if (entry.isFile()) {
        snapshot[relative] = Buffer.from(await readFile(join(directory, entry.name))).toString("base64");
      }
    }
  };
  await visit(root, "");
  return snapshot;
}

afterEach(async () => {
  if (initialRuntimeRoot === undefined) delete process.env.OMS_RUNTIME_ROOT;
  else process.env.OMS_RUNTIME_ROOT = initialRuntimeRoot;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function proposals(): readonly TemplateProposalInput[] {
  const individual: TemplateIndividualProposalInput = {
    kind: "individual",
    templateId: "reading",
    sourcePath: "Templates/reading-note.md",
    sourceIdentity: "reading-source",
    fields: { cite: { property: "cite" } },
    headings: [{ headingId: "notes", title: "Notes", level: 2, required: true }],
    headingOrder: "strict",
  };
  return [
    { kind: "pool", properties: { cite: { type: "text", intent: "Citation." } } },
    individual,
    { kind: "taxonomy-placement", templateId: "reading", placement: { templateFolder: "Unread Notes" } },
    { kind: "completion", retryBudget: 4, agentRepair: { enabled: true, contexts: ["maintenance"] } },
  ];
}

function session(result: TemplateInterviewServiceResult) {
  return { censusDigest: result.censusDigest, expectedLedgerDigest: result.expectedLedgerDigest, proposals: proposals() };
}

function confirm(question: TemplateInterviewQuestion, raw = `answer ${question.kind}`): { readonly disposition: "confirm"; readonly raw: string } {
  return { disposition: "confirm", raw };
}

function containsBytePayload(value: unknown): boolean {
  if (value instanceof Uint8Array) return true;
  if (Array.isArray(value)) return value.some(containsBytePayload);
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some(containsBytePayload);
}

async function answerNext(
  vault: string,
  result: TemplateInterviewServiceResult,
  value: { readonly disposition: "confirm" | "defer" | "unresolved"; readonly raw: string } = result.next === undefined
    ? { disposition: "confirm", raw: "yes" }
    : confirm(result.next),
): Promise<TemplateInterviewServiceResult> {
  if (result.state !== "question" || result.next === undefined) throw new Error("test expected a next interview question");
  return answerTemplateInterview(target(vault), {
    ...session(result),
    questionId: result.next.questionId,
    answer: value,
  });
}

async function complete(vault: string, dispositions?: readonly ("confirm" | "defer" | "unresolved")[]): Promise<TemplateInterviewServiceResult> {
  let result = await nextTemplateInterview(target(vault), { proposals: proposals() });
  for (let pass = 0; pass < 32 && result.state === "question"; pass += 1) {
    const question = result.next;
    if (question === undefined) throw new Error("expected a next question");
    const disposition = dispositions?.[pass] ?? "confirm";
    result = await answerNext(vault, result, { disposition, raw: `answer ${question.kind}` });
  }
  return result;
}

describe("template interview service", () => {
  it("starts a fresh interview at one question and does not write the vault", async () => {
    const root = await fixture();
    const before = await vaultSnapshot(root);
    const result = await nextTemplateInterview(target(root), { proposals: proposals() });
    expect(result.state).toBe("question");
    expect(result.next?.kind).toBe("pool");
    expect(result.next?.questionId).toMatch(/^sha256:/u);
    expect(result.expectedLedgerDigest).toBeNull();
    expect(result).not.toHaveProperty("questions");
    expect(await vaultSnapshot(root)).toEqual(before);
    expect((await readInterviewLedger(root)).ledger).toBeNull();
  });

  it("resumes mid-interview from the durable ledger after a restart", async () => {
    const root = await fixture();
    const first = await nextTemplateInterview(target(root), { proposals: proposals() });
    const answered = await answerNext(root, first);
    expect(answered.expectedLedgerDigest).toMatch(/^sha256:/u);
    const ledgerPath = join(root, ".oms/template-interview.json");
    const stored = JSON.parse(await readFile(ledgerPath, "utf8")) as { answers: Record<string, Record<string, unknown>> };
    stored.extension = { owner: "host" };
    const firstQuestionId = first.next!.questionId;
    stored.answers[firstQuestionId]!.extension = { keep: true };
    await writeFile(ledgerPath, `${JSON.stringify(stored)}\n`);
    const reloaded = await readInterviewLedger(root);
    const resumed = await nextTemplateInterview(target(root), { proposals: proposals() });
    expect(resumed.expectedLedgerDigest).toBe(reloaded.digest);
    expect(resumed.state).toBe("question");
    expect(resumed.next?.kind).toBe("default-layer");
    const next = await answerNext(root, resumed);
    const finalLedger = JSON.parse(await readFile(ledgerPath, "utf8")) as { extension: unknown; answers: Record<string, Record<string, unknown>> };
    expect(finalLedger.extension).toEqual({ owner: "host" });
    expect(finalLedger.answers[firstQuestionId]!.extension).toEqual({ keep: true });
    expect(next.expectedLedgerDigest).not.toBe(resumed.expectedLedgerDigest);
  });

  it("rejects a stale or forged CAS without mutating the ledger", async () => {
    const root = await fixture();
    const first = await nextTemplateInterview(target(root), { proposals: proposals() });
    const staleRequest = {
      ...session(first),
      questionId: first.next!.questionId,
      answer: confirm(first.next!),
    } as const;
    const answered = await answerTemplateInterview(target(root), staleRequest);
    const before = await readFile(join(root, ".oms/template-interview.json"));
    await expect(answerTemplateInterview(target(root), staleRequest)).rejects.toThrow("TEMPLATE_INTERVIEW_STALE");
    await expect(readFile(join(root, ".oms/template-interview.json"))).resolves.toEqual(before);
    await expect(answerTemplateInterview(target(root), {
      ...session(answered),
      questionId: first.next!.questionId,
      answer: confirm(first.next!),
    })).rejects.toThrow("TEMPLATE_INTERVIEW_STALE");
    await expect(answerTemplateInterview(target(root), {
      ...session(first),
      expectedLedgerDigest: digestBytes("forged-ledger"),
      questionId: first.next!.questionId,
      answer: confirm(first.next!),
    })).rejects.toThrow("TEMPLATE_INTERVIEW_STALE");
    await expect(readFile(join(root, ".oms/template-interview.json"))).resolves.toEqual(before);
  });

  it("retains defer and unresolved answers instead of auto-resolving them", async () => {
    const root = await fixture();
    const result = await complete(root, ["confirm", "defer", "defer", "unresolved", "confirm"]);
    expect(result.next).toBeUndefined();
    const ledger = (await readInterviewLedger(root)).ledger;
    const dispositions = Object.values(ledger?.answers ?? {}).map(answer => answer.disposition).sort();
    expect(dispositions).toEqual(["confirm", "confirm", "defer", "defer", "unresolved"]);
    expect(Object.values(ledger?.answers ?? {}).some(answer => answer.raw.includes("individual"))).toBe(true);
    if (result.state === "confirm") {
      const planned = await commitTemplateContracts(target(root), { ...session(result), dryRun: true });
      expect(planned.status === "planned" || planned.status === "unchanged").toBe(true);
    } else {
      expect(result.state).toBe("blocked");
    }
  });

  it("supersedes an invalidated answer without dropping unaffected ones", async () => {
    const root = await fixture();
    const first = await nextTemplateInterview(target(root), { proposals: proposals() });
    const pool = first.next!;
    const afterPool = await answerNext(root, first, confirm(pool, "use the explicit pool"));
    const defaultQuestion = afterPool.next!;
    const afterDefault = await answerNext(root, afterPool, { disposition: "defer", raw: "later" });
    const individual = afterDefault.next!;
    expect(individual.kind).toBe("individual");
    await answerNext(root, afterDefault, confirm(individual, "first individual"));
    await put(root, "Templates/reading-note.md", `${RAW}\nchanged\n`);
    const resumed = await nextTemplateInterview(target(root), { proposals: proposals() });
    expect(resumed.censusDigest).not.toBe(first.censusDigest);
    expect(resumed.invalidatedQuestionIds).toEqual([individual.questionId]);
    expect(resumed.next?.kind).toBe("individual");
    const ledgerBefore = JSON.parse(await readFile(join(root, ".oms/template-interview.json"), "utf8")) as {
      readonly answers: Record<string, { readonly raw: string; readonly disposition: string }>;
    };
    expect(ledgerBefore.answers[pool.questionId]?.raw).toBe("use the explicit pool");
    expect(ledgerBefore.answers[defaultQuestion.questionId]?.disposition).toBe("defer");
    const superseded = await answerNext(root, resumed, confirm(resumed.next!, "second individual"));
    const ledger = JSON.parse(await readFile(join(root, ".oms/template-interview.json"), "utf8")) as {
      readonly answers: Record<string, { readonly raw: string; readonly disposition: string }>;
    };
    expect(ledger.answers[pool.questionId]?.raw).toBe("use the explicit pool");
    expect(ledger.answers[defaultQuestion.questionId]?.disposition).toBe("defer");
    expect(ledger.answers[resumed.next!.questionId]?.raw).toBe("second individual");
    expect(superseded.next?.kind).toBe("taxonomy-placement");
  });

  it("keeps unaffected answers across an unrelated source change", async () => {
    const root = await fixture();
    await put(root, "Templates/other.md", "unrelated\n");
    const first = await nextTemplateInterview(target(root), { proposals: proposals() });
    const answered = await answerNext(root, first);
    await put(root, "Templates/other.md", "unrelated changed\n");
    const resumed = await nextTemplateInterview(target(root), { proposals: proposals() });
    expect(resumed.censusDigest).not.toBe(first.censusDigest);
    expect(resumed.invalidatedQuestionIds).not.toContain(first.next!.questionId);
    expect(resumed.state).toBe("question");
    expect(resumed.expectedLedgerDigest).toBe(answered.expectedLedgerDigest);
    expect(resumed.next?.kind).toBe("default-layer");
  });

  it("commits a dry-run preview whose digest equals the applied manifest", async () => {
    const root = await fixture();
    const final = await complete(root);
    expect(final.state).toBe("confirm");
    expect(containsBytePayload(final.proposal)).toBe(false);
    const sourceBefore = await readFile(join(root, "Templates/reading-note.md"));
    const planned = await commitTemplateContracts(target(root), {
      ...session(final),
      dryRun: true,
    });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") throw new Error("expected a planned commit");
    expect(planned.approvalDigest).toBe(final.approvalDigest);
    const applied = await commitTemplateContracts(target(root), {
      ...session(final),
      approvedDigest: planned.approvalDigest,
    });
    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") throw new Error("expected an applied commit");
    expect(applied.approvalDigest).toBe(planned.approvalDigest);
    expect(await readFile(join(root, "Templates/reading-note.md"))).toEqual(sourceBefore);
    expect(applied.writtenPaths.every(path => path.startsWith(".oms/"))).toBe(true);
    const after = await nextTemplateInterview(target(root), { proposals: proposals() });
    expect(after.state === "unchanged" || after.state === "confirm" || after.state === "question").toBe(true);
  });

  it("refuses an external mutation between preview and apply", async () => {
    const root = await fixture();
    const final = await complete(root);
    const planned = await commitTemplateContracts(target(root), {
      ...session(final),
      dryRun: true,
    });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") throw new Error("expected a planned commit");
    await put(root, ".oms/taxonomy.json", "{\"mutated\":true}\n");
    const receipt = await commitTemplateContracts(target(root), {
      ...session(final),
      approvedDigest: planned.approvalDigest,
    });
    expect(receipt.status).toBe("rejected");
  });

  it("does not write the vault on read paths, including invalid authority and ordinary notes", async () => {
    const invalid = await fixture();
    await put(invalid, ".oms/template-policy.json", "{");
    const invalidBefore = await vaultSnapshot(invalid);
    const invalidReview = await nextTemplateInterview(target(invalid), { proposals: proposals() });
    expect(invalidReview.state).toBe("blocked");
    expect(invalidReview.next).toBeUndefined();
    expect(await vaultSnapshot(invalid)).toEqual(invalidBefore);

    const approved = await approvedVault();
    await put(approved, "Sources/literature.md", "drifted\n");
    const approvedBefore = await vaultSnapshot(approved);
    const drifted = await nextTemplateInterview(target(approved));
    expect(drifted.next).toBeUndefined();
    expect(await vaultSnapshot(approved)).toEqual(approvedBefore);
    expect(await readFile(join(approved, "Notes/plain.md"), "utf8")).toBe("ordinary note\n");
  });

  it("rejects a caller-supplied anchor override and an unverified cwd target", async () => {
    const root = await fixture();
    const first = await nextTemplateInterview(target(root), { proposals: proposals() });
    const question = first.next!;
    await expect(answerTemplateInterview(target(root), {
      ...session(first),
      questionId: question.questionId,
      answer: { disposition: "confirm", raw: "yes", anchorDigest: digestBytes("override") },
    })).rejects.toThrow(/TEMPLATE_INTERVIEW_ANSWER_INVALID|anchor does not match/);
    expect((await readInterviewLedger(root)).ledger).toBeNull();
    await expect(commitTemplateContracts(target(root, "cwd"), {
      ...session(first),
      dryRun: true,
    })).rejects.toThrow("target-unverified");
  });

  it("survives a process-style restart with a persisted mid-interview ledger", async () => {
    const root = await fixture();
    const first = await nextTemplateInterview(target(root), { proposals: proposals() });
    await answerNext(root, first);
    const persisted = await readInterviewLedger(root);
    const restarted = await nextTemplateInterview(target(root), { proposals: proposals() });
    expect(restarted.expectedLedgerDigest).toBe(persisted.digest);
    expect(restarted.next?.kind).toBe("default-layer");
    const continued = await answerNext(root, restarted, { disposition: "confirm", raw: "resume after restart" });
    expect(continued.expectedLedgerDigest).not.toBe(persisted.digest);
    expect(continued.next?.kind).toBe("individual");
    const ledger = (await readInterviewLedger(root)).ledger;
    expect(Object.keys(ledger?.answers ?? {})).toHaveLength(2);
  });
});
