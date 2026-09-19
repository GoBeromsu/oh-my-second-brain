import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as eventJournal from "../runtime/event-journal.js";
import { readRuntimeEvents } from "../runtime/event-read.js";
import type { TemplateInterviewQuestion } from "./interview.js";
import {
  answerTemplateInterview,
  commitTemplateContracts,
  nextTemplateInterview,
  type TemplateInterviewServiceResult,
} from "./interview-service.js";
import { readInterviewLedger } from "./interview-ledger.js";
import type { TemplateOperationTarget } from "./operations.js";
import type { JsonValue } from "./types.js";

const roots: string[] = [];
const target = (vault: string, source: TemplateOperationTarget["source"] = "explicit"): TemplateOperationTarget => ({ vault, source });
const initialRuntimeRoot = process.env.OMS_RUNTIME_ROOT;

async function fixture(options: { readonly extra?: boolean; readonly placement?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-interview-service-"));
  roots.push(root);
  await mkdir(join(root, ".oms"), { recursive: true });
  await mkdir(join(root, ".obsidian"), { recursive: true });
  await mkdir(join(root, "Templates"), { recursive: true });
  const policy = {
    version: 3,
    templateFolders: [{ path: "Templates", default: true }],
    base: { fields: {} },
    contracts: { note: { intent: "Notes", fields: { title: { type: "text" } }, views: [] } },
    templates: {
      note: {
        templateId: "note",
        destinationClass: "registered-existing",
        renderer: "obsidian-core",
        sourceFolder: "Templates",
        sourcePath: "Templates/note.md",
        contract: "note",
        naming: "{{title}}.md",
      },
    },
  };
  await Promise.all([
    writeFile(join(root, ".oms/template-policy.json"), JSON.stringify(policy)),
    writeFile(join(root, ".oms/taxonomy.json"), JSON.stringify(options.placement === false ? { folders: {} } : { folders: { Notes: { template: "note" } } })),
    writeFile(join(root, ".obsidian/types.json"), JSON.stringify({ types: { title: "text" } })),
    writeFile(join(root, "Templates/note.md"), "---\ntitle: Note\n---\n# Note\nBody\n"),
    ...(options.extra ? [writeFile(join(root, "Templates/new.md"), "---\ntitle: New\n---\n# New\nBody\n")] : []),
  ]);
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

async function externalRuntimeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-interview-runtime-"));
  roots.push(root);
  process.env.OMS_RUNTIME_ROOT = root;
  return root;
}

afterEach(async () => {
  if (initialRuntimeRoot === undefined) delete process.env.OMS_RUNTIME_ROOT;
  else process.env.OMS_RUNTIME_ROOT = initialRuntimeRoot;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function answerFor(question: TemplateInterviewQuestion): JsonValue {
  if (question.kind === "field-type") return "text";
  if (question.kind === "field-requiredness" || question.kind === "content-section-requiredness") return "optional";
  if (question.kind === "field-intent") return "note metadata";
  if (question.kind === "content-order") return "unordered";
  if (question.kind === "contract-selection") return "note";
  if (question.kind === "deleted-source-disposition") return "defer";
  if (question.kind === "rename-identity") return question.choices?.[0] ?? "note";
  return "{{title}}.md";
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
): Promise<TemplateInterviewServiceResult> {
  if (result.state !== "question" || result.next === undefined) throw new Error("test expected a next interview question");
  const question = result.next;
  return answerTemplateInterview(target(vault), {
    questionId: question.questionId,
    answer: answerFor(question),
    censusDigest: result.censusDigest,
    expectedLedgerDigest: result.expectedLedgerDigest,
  });
}

async function complete(vault: string): Promise<TemplateInterviewServiceResult> {
  let result = await nextTemplateInterview(target(vault));
  for (let pass = 0; pass < 32 && result.state === "question"; pass += 1) result = await answerNext(vault, result);
  return result;
}

describe("template interview service", () => {
  it("returns one linear question and leaves next read-only", async () => {
    const root = await fixture({ extra: true });
    const before = await readdir(root);
    const result = await nextTemplateInterview(target(root));
    expect(result.state).toBe("question");
    expect(result.next).toMatchObject({ questionId: expect.stringMatching(/^sha256:/u) });
    expect(result).not.toHaveProperty("questions");
    expect(await readdir(root)).toEqual(before);
    expect((await readInterviewLedger(root)).ledger).toBeNull();
  });

  it("resumes answers in order and carries unknown ledger data", async () => {
    const root = await fixture({ extra: true });
    const first = await nextTemplateInterview(target(root));
    const answered = await answerNext(root, first);
    expect(answered.expectedLedgerDigest).toMatch(/^sha256:/u);
    const ledgerPath = join(root, ".oms/template-interview.json");
    const stored = JSON.parse(await readFile(ledgerPath, "utf8")) as { answers: Record<string, Record<string, unknown>> };
    stored.extension = { owner: "host" };
    const firstQuestionId = first.next!.questionId;
    stored.answers[firstQuestionId]!.extension = { keep: true };
    await writeFile(ledgerPath, `${JSON.stringify(stored)}\n`);
    const reloaded = await readInterviewLedger(root);
    const resumed = await nextTemplateInterview(target(root));
    expect(resumed.expectedLedgerDigest).toBe(reloaded.digest);
    expect(resumed.state).toBe("question");
    const next = await answerNext(root, resumed);
    const finalLedger = JSON.parse(await readFile(ledgerPath, "utf8")) as { extension: unknown; answers: Record<string, Record<string, unknown>> };
    expect(finalLedger.extension).toEqual({ owner: "host" });
    expect(finalLedger.answers[firstQuestionId]!.extension).toEqual({ keep: true });
    expect(next.expectedLedgerDigest).not.toBe(resumed.expectedLedgerDigest);
  });

  it("keeps unaffected answers across a fresh source resume", async () => {
    const root = await fixture({ extra: true });
    const first = await nextTemplateInterview(target(root));
    if (first.state !== "question" || first.next === undefined) throw new Error("test expected an initial question");
    const answered = await answerNext(root, first);
    await writeFile(join(root, "Templates/new.md"), "---\ntitle: Newer\n---\n# New\nChanged body\n");
    const resumed = await nextTemplateInterview(target(root));
    expect(resumed.censusDigest).not.toBe(first.censusDigest);
    expect(resumed.invalidatedQuestionIds).not.toContain(first.next.questionId);
    expect(resumed.state).toBe("question");
    expect(resumed.expectedLedgerDigest).toBe(answered.expectedLedgerDigest);
  });

  it("rejects stale or out-of-order answers without changing the ledger", async () => {
    const root = await fixture({ extra: true });
    const first = await nextTemplateInterview(target(root));
    const staleRequest = {
      questionId: first.next!.questionId,
      answer: answerFor(first.next!),
      censusDigest: first.censusDigest,
      expectedLedgerDigest: first.expectedLedgerDigest,
    } as const;
    const answered = await answerTemplateInterview(target(root), staleRequest);
    const before = await readFile(join(root, ".oms/template-interview.json"));
    await expect(answerTemplateInterview(target(root), staleRequest)).rejects.toThrow("TEMPLATE_INTERVIEW_STALE");
    await expect(readFile(join(root, ".oms/template-interview.json"))).resolves.toEqual(before);
    if (answered.state !== "question" || answered.next === undefined) throw new Error("test expected a second question");
    await expect(answerTemplateInterview(target(root), {
      questionId: first.next!.questionId,
      answer: answerFor(first.next!),
      censusDigest: answered.censusDigest,
      expectedLedgerDigest: answered.expectedLedgerDigest,
    })).rejects.toThrow("TEMPLATE_INTERVIEW_STALE");
  });

  it("records question IDs and kinds for shown, answered, invalidated, and stale events (audit)", async () => {
    const runtimeRoot = await externalRuntimeRoot();
    const root = await fixture();
    const first = await nextTemplateInterview(target(root));
    if (first.state !== "question" || first.next === undefined) throw new Error("test expected an initial question");
    const question = first.next;
    const answered = await answerNext(root, first);
    await writeFile(join(root, "Templates/note.md"), "---\ntitle: Changed\n---\n# Note\nBody\n");
    const changed = await nextTemplateInterview(target(root));
    expect(changed.invalidatedQuestionIds).toContain(question.questionId);
    await expect(answerTemplateInterview(target(root), {
      questionId: question.questionId,
      answer: answerFor(question),
      censusDigest: first.censusDigest,
      expectedLedgerDigest: first.expectedLedgerDigest,
    })).rejects.toThrow("TEMPLATE_INTERVIEW_STALE");

    const events = readRuntimeEvents({ vaultPath: root, runtimeRoot }).events;
    expect(events).toContainEqual(expect.objectContaining({
      kind: "template-interview-question-shown",
      transactionId: question.questionId,
      operation: `template-interview-question-shown:${question.kind}`,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "template-interview-question-answered",
      transactionId: question.questionId,
      operation: `template-interview-question-answered:${question.kind}`,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "template-interview-question-invalidated",
      transactionId: question.questionId,
      operation: `template-interview-question-invalidated:${question.kind}`,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "template-interview-stale",
      transactionId: question.questionId,
      operation: `template-interview-question-stale:${question.kind}`,
    }));
    expect(answered.expectedLedgerDigest).toMatch(/^sha256:/u);
  });


  it("derives with empty trusted answers for an invalid ledger and permits explicit repair", async () => {
    const root = await fixture({ extra: true });
    const ledgerPath = join(root, ".oms/template-interview.json");
    await writeFile(ledgerPath, "{broken");
    const result = await nextTemplateInterview(target(root));
    expect(result.state).toBe("question");
    expect(result.next).toBeDefined();
    expect(result.expectedLedgerDigest).toMatch(/^sha256:/u);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TEMPLATE_INTERVIEW_INVALID" })]));
    const draftBefore = await readFile(ledgerPath);
    await expect(answerTemplateInterview(target(root), {
      questionId: result.next!.questionId,
      answer: answerFor(result.next!),
      censusDigest: result.censusDigest,
      expectedLedgerDigest: null,
    })).rejects.toThrow("TEMPLATE_INTERVIEW_STALE");
    expect(await readFile(ledgerPath)).toEqual(draftBefore);
    const repaired = await answerNext(root, result);
    expect(repaired.state).toBe("question");
    expect((await readInterviewLedger(root)).ledger).not.toBeNull();
    expect(await readFile(ledgerPath, "utf8")).not.toBe("{broken");
  });

  it("commits a no-placement review with controls only and preserves the source", async () => {
    const root = await fixture({ extra: true, placement: false });
    const final = await complete(root);
    expect(final.state).toBe("confirm");
    expect(final.proposal?.mode).toBe("reconcile");
    expect(final.proposal?.sources.every(source => source.action === "verify-only")).toBe(true);
    expect(final.proposal?.outputs.every(output => output.finalVaultRelativePath.startsWith(".oms/"))).toBe(true);
    const before = await readFile(join(root, "Templates/note.md"));
    const planned = await commitTemplateContracts(target(root), {
      censusDigest: final.censusDigest,
      expectedLedgerDigest: final.expectedLedgerDigest,
      dryRun: true,
    });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") throw new Error("expected a planned reconcile");
    const applied = await commitTemplateContracts(target(root), {
      censusDigest: final.censusDigest,
      expectedLedgerDigest: final.expectedLedgerDigest,
      approvedDigest: planned.approvalDigest,
    });
    expect(applied.status).toBe("applied");
    expect(await readFile(join(root, "Templates/note.md"))).toEqual(before);
    const afterCommit = await nextTemplateInterview(target(root));
    expect(afterCommit.state).toBe("unchanged");
    expect(afterCommit.next).toBeUndefined();
  });

  it("returns a byte-free confirmation proposal while retaining CAS metadata", async () => {
    const root = await fixture({ extra: true, placement: false });
    const final = await complete(root);
    expect(final.state).toBe("confirm");
    expect(final.proposal).toBeDefined();
    expect(containsBytePayload(final.proposal)).toBe(false);
    expect(final.proposal?.controls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ".oms/template-policy.json",
        action: expect.any(String),
        expectedCurrent: expect.objectContaining({ state: "present", signature: expect.stringMatching(/^sha256:/u) }),
        current: expect.objectContaining({ state: "present", signature: expect.stringMatching(/^sha256:/u) }),
        proposed: expect.objectContaining({ state: "present", signature: expect.stringMatching(/^sha256:/u) }),
      }),
    ]));
    expect(final.proposal?.sources.every(source =>
      source.current.state === "present"
        ? typeof source.current.signature === "string"
        : true,
    )).toBe(true);
  });

  it("records approved commit and verified written control paths in external runtime history (audit)", async () => {
    const runtimeRoot = await externalRuntimeRoot();
    const root = await fixture({ extra: true, placement: false });
    const final = await complete(root);
    expect(final.state).toBe("confirm");
    const planned = await commitTemplateContracts(target(root), {
      censusDigest: final.censusDigest,
      expectedLedgerDigest: final.expectedLedgerDigest,
      dryRun: true,
    });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") throw new Error("expected a planned reconcile");
    const applied = await commitTemplateContracts(target(root), {
      censusDigest: final.censusDigest,
      expectedLedgerDigest: final.expectedLedgerDigest,
      approvedDigest: planned.approvalDigest,
    });
    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") throw new Error("expected an applied reconcile");
    const events = readRuntimeEvents({ vaultPath: root, runtimeRoot }).events;
    expect(events).toContainEqual(expect.objectContaining({
      kind: "template-contract-commit",
      transactionId: applied.transactionId,
      operation: `template-contract-commit:approvalDigest=${applied.approvedDigest}`,
    }));
    const controls = events.filter(event => event.kind === "template-contract-commit-control" && event.transactionId === applied.transactionId);
    expect(controls.map(event => event.notePath).sort()).toEqual(applied.writtenPaths.filter(path => path.startsWith(".oms/")).sort());
    expect(controls.every(event => event.operation === `template-contract-commit-control:approvalDigest=${applied.approvedDigest}`)).toBe(true);
  });

  it("keeps ledger and source bytes authoritative when external telemetry fails", async () => {
    const root = await fixture({ extra: true, placement: false });
    const final = await complete(root);
    expect(final.state).toBe("confirm");
    const planned = await commitTemplateContracts(target(root), {
      censusDigest: final.censusDigest,
      expectedLedgerDigest: final.expectedLedgerDigest,
      dryRun: true,
    });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") throw new Error("expected a planned reconcile");
    const sourceBefore = await readFile(join(root, "Templates/note.md"));
    const ledgerBefore = await readFile(join(root, ".oms/template-interview.json"));
    const append = vi.spyOn(eventJournal, "appendRuntimeEvent").mockImplementation(() => {
      throw new Error("LEDGER_APPEND_FAILED: injected telemetry failure");
    });
    try {
      const applied = await commitTemplateContracts(target(root), {
        censusDigest: final.censusDigest,
        expectedLedgerDigest: final.expectedLedgerDigest,
        approvedDigest: planned.approvalDigest,
      });
      expect(applied.status).toBe("applied");
    } finally {
      append.mockRestore();
    }
    expect(await readFile(join(root, "Templates/note.md"))).toEqual(sourceBefore);
    expect(await readFile(join(root, ".oms/template-interview.json"))).toEqual(ledgerBefore);
  });


  it("allows a zero-question commit from an invalid draft without rewriting the draft", async () => {
    const root = await fixture({ placement: false });
    const initial = await complete(root);
    expect(initial.state).toBe("confirm");
    const firstCommit = await commitTemplateContracts(target(root), {
      censusDigest: initial.censusDigest,
      expectedLedgerDigest: initial.expectedLedgerDigest,
      dryRun: true,
    });
    expect(firstCommit.status).toBe("planned");
    if (firstCommit.status !== "planned") throw new Error("expected a planned initial reconcile");
    const applied = await commitTemplateContracts(target(root), {
      censusDigest: initial.censusDigest,
      expectedLedgerDigest: initial.expectedLedgerDigest,
      approvedDigest: firstCommit.approvalDigest,
    });
    expect(applied.status).toBe("applied");
    const ledgerPath = join(root, ".oms/template-interview.json");
    await writeFile(ledgerPath, "{corrupt-draft");
    const resumed = await nextTemplateInterview(target(root));
    expect(resumed.state).toBe("unchanged");
    expect(resumed.next).toBeUndefined();
    expect(resumed.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TEMPLATE_INTERVIEW_INVALID" })]));
    const draftBefore = await readFile(ledgerPath);
    const snapshotBefore = await vaultSnapshot(root);
    const unchanged = await commitTemplateContracts(target(root), {
      censusDigest: resumed.censusDigest,
      expectedLedgerDigest: resumed.expectedLedgerDigest,
      dryRun: true,
    });
    expect(unchanged.status).toBe("unchanged");
    expect(await readFile(ledgerPath)).toEqual(draftBefore);
    expect(await vaultSnapshot(root)).toEqual(snapshotBefore);
  });

  it("rejects a final commit from an unverified cwd target", async () => {
    const root = await fixture({ extra: true });
    const final = await complete(root);
    expect(final.state).toBe("confirm");
    await expect(commitTemplateContracts(target(root, "cwd"), {
      censusDigest: final.censusDigest,
      expectedLedgerDigest: final.expectedLedgerDigest,
      dryRun: true,
    })).rejects.toThrow("target-unverified");
  });

  it("rejects a stale final ledger digest", async () => {
    const root = await fixture({ extra: true });
    const final = await complete(root);
    const ledgerPath = join(root, ".oms/template-interview.json");
    const stored = JSON.parse(await readFile(ledgerPath, "utf8")) as Record<string, unknown>;
    await writeFile(ledgerPath, `${JSON.stringify({ ...stored, extension: { changed: true } })}\n`);
    await expect(commitTemplateContracts(target(root), {
      censusDigest: final.censusDigest,
      expectedLedgerDigest: final.expectedLedgerDigest,
      dryRun: true,
    })).rejects.toThrow("TEMPLATE_INTERVIEW_STALE");
  });

  it("reopens a committed deferred deletion in memory and retires it under CAS", async () => {
    const root = await fixture({ extra: true, placement: false });
    const initial = await complete(root);
    expect(initial.state).toBe("confirm");
    const planned = await commitTemplateContracts(target(root), {
      censusDigest: initial.censusDigest,
      expectedLedgerDigest: initial.expectedLedgerDigest,
      dryRun: true,
    });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") throw new Error("expected a planned reconcile");
    const applied = await commitTemplateContracts(target(root), {
      censusDigest: initial.censusDigest,
      expectedLedgerDigest: initial.expectedLedgerDigest,
      approvedDigest: planned.approvalDigest,
    });
    expect(applied.status).toBe("applied");

    await rm(join(root, "Templates/new.md"));
    let review = await nextTemplateInterview(target(root));
    let deletionQuestion: TemplateInterviewQuestion | undefined;
    for (let pass = 0; pass < 32 && review.state === "question"; pass += 1) {
      const question = review.next;
      if (question === undefined) throw new Error("expected a deletion question");
      if (question.kind === "deleted-source-disposition") {
        deletionQuestion = question;
        break;
      }
      review = await answerNext(root, review);
    }
    expect(deletionQuestion).toBeDefined();
    if (deletionQuestion === undefined) throw new Error("expected a deletion question");
    while (review.state === "question" && review.next?.questionId !== deletionQuestion.questionId) {
      review = await answerNext(root, review);
    }
    const deferred = await answerTemplateInterview(target(root), {
      questionId: deletionQuestion.questionId,
      answer: "defer",
      censusDigest: review.censusDigest,
      expectedLedgerDigest: review.expectedLedgerDigest,
    });
    expect(deferred.state).toBe("confirm");
    const deferPlanned = await commitTemplateContracts(target(root), {
      censusDigest: deferred.censusDigest,
      expectedLedgerDigest: deferred.expectedLedgerDigest,
      dryRun: true,
    });
    expect(deferPlanned.status).toBe("planned");
    if (deferPlanned.status !== "planned") throw new Error("expected a planned deferred reconcile");
    const deferApplied = await commitTemplateContracts(target(root), {
      censusDigest: deferred.censusDigest,
      expectedLedgerDigest: deferred.expectedLedgerDigest,
      approvedDigest: deferPlanned.approvalDigest,
    });
    expect(deferApplied.status).toBe("applied");

    const ledgerPath = join(root, ".oms/template-interview.json");
    const ledgerBeforeReopen = await readFile(ledgerPath);
    const reopened = await nextTemplateInterview(target(root));
    expect(reopened.state).toBe("question");
    expect(reopened.next).toMatchObject({
      questionId: deletionQuestion.questionId,
      kind: "deleted-source-disposition",
    });
    expect(await readFile(ledgerPath)).toEqual(ledgerBeforeReopen);

    const retired = await answerTemplateInterview(target(root), {
      questionId: reopened.next!.questionId,
      answer: "retire",
      censusDigest: reopened.censusDigest,
      expectedLedgerDigest: reopened.expectedLedgerDigest,
    });
    expect(retired.state).toBe("confirm");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      readonly answers: Record<string, { readonly value: unknown }>;
    };
    expect(ledger.answers[deletionQuestion.questionId]?.value).toBe("retire");
  });
});
