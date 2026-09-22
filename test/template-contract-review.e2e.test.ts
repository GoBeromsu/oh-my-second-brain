import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { writeResolvedTemplateNote } from "../src/kernel/capture/safe.js";
import {
  answerTemplateInterview,
  commitTemplateContracts,
  nextTemplateInterview,
  type TemplateInterviewServiceResult,
} from "../src/kernel/templates/interview-service.js";
import type { TemplateInterviewQuestion } from "../src/kernel/templates/interview.js";
import { loadResolvedTemplates } from "../src/kernel/templates/resolver.js";
import type { TemplateOperationTarget } from "../src/kernel/templates/index.js";
import { runTemplateCommand } from "../src/cli/template-command.js";
import {
  readTemplateChangeNotice,
  resetTemplateNoticeDeliveryForTests,
  TEMPLATE_CHANGE_NOTICE_ACTIONS,
  TEMPLATE_CHANGE_NOTICE_MESSAGE,
} from "../src/mcp/template-notice.js";
import { createOMSMcpServer } from "../src/mcp/server.js";

const roots: string[] = [];
const ENGLISH_PATH = "Templates/Review/english.md";
const KOREAN_PATH = "Templates/Review/한국어.md";
const ENGLISH_ID = "english";
const KOREAN_ID = "한국어";
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const sha256 = (value: Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const target = (vault: string): TemplateOperationTarget => ({ vault, source: "explicit" });

function normalizedBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

function expectExactBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(normalizedBytes(actual)).toEqual(normalizedBytes(expected));
}

function containsBytePayload(value: unknown): boolean {
  if (value instanceof Uint8Array) return true;
  if (Array.isArray(value)) return value.some(containsBytePayload);
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some(containsBytePayload);
}

interface Fixture {
  readonly root: string;
  readonly english: Uint8Array;
  readonly korean: Uint8Array;
  readonly existingNote: Uint8Array;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-contract-review-"));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, ".oms"), { recursive: true }),
    mkdir(join(root, ".obsidian"), { recursive: true }),
    mkdir(join(root, "Templates", "Review"), { recursive: true }),
    mkdir(join(root, "notes"), { recursive: true }),
  ]);

  const policy = {
    version: 3,
    templateFolders: [{ path: "Templates/Review", default: true }],
    base: { fields: {} },
    contracts: {
      article: {
        intent: "A reviewable article template.",
        fields: {
          title: {
            type: "text",
            extensions: { fixture: "title" },
          },
          language: {
            type: "select",
            allowedValues: ["en", "ko"],
            extensions: { fixture: "language" },
          },
          status: {
            type: "select",
            allowedValues: ["draft", "published"],
            extensions: { fixture: "status" },
          },
        },
        views: [{ name: "by-status", keys: ["status"] }],
      },
    },
    templates: {},
  };
  const taxonomy = { folders: {} };
  const obsidianTypes = {
    types: {
      title: "text",
      language: "select",
      status: "select",
    },
  };
  const english = new TextEncoder().encode(
    "\ufeff---\r\n"
    + "title: English\r\n"
    + "language: en\r\n"
    + "status: draft\r\n"
    + "---\r\n"
    + "# Overview\r\n"
    + "- First\r\n"
    + "- Second\r\n"
    + "```yaml\r\n"
    + "kind: en\r\n"
    + "```\r\n"
    + "<!-- oms:content -->\r\n",
  );
  const korean = new TextEncoder().encode(
    "---\n"
    + "title: 한국어\n"
    + "language: ko\n"
    + "status: draft\n"
    + "---\n"
    + "# 개요\n"
    + "1. 하나\n"
    + "2. 둘\n"
    + "~~~text\n"
    + "kind: ko\n"
    + "~~~\n"
    + "<!-- oms:content -->\n",
  );
  const existingNote = new TextEncoder().encode(
    "\ufeff---\r\n"
    + "title: Existing\r\n"
    + "---\r\n"
    + "Do not rewrite this note.\r\n",
  );
  await Promise.all([
    writeFile(join(root, ".oms", "template-policy.json"), JSON.stringify(policy)),
    writeFile(join(root, ".oms", "taxonomy.json"), JSON.stringify(taxonomy)),
    writeFile(join(root, ".obsidian", "types.json"), JSON.stringify(obsidianTypes)),
    writeFile(join(root, ENGLISH_PATH), english),
    writeFile(join(root, KOREAN_PATH), korean),
    writeFile(join(root, "notes", "existing.md"), existingNote),
  ]);
  return { root, english, korean, existingNote };
}

async function cliJson(root: string, args: readonly string[]): Promise<Record<string, unknown>> {
  const output: string[] = [];
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
  process.exitCode = undefined;
  try {
    await runTemplateCommand([...args, "--vault", root]);
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }
  const raw = output.at(-1);
  if (raw === undefined) throw new Error(`template command produced no output for ${args.join(" ")}`);
  return JSON.parse(raw) as Record<string, unknown>;
}

function toolPayload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("MCP response did not contain text");
  try {
    return JSON.parse(block.text) as Record<string, unknown>;
  } catch {
    throw new Error(block.text);
  }
}

async function connectMcp(
  vault: string,
  templateNotice: Awaited<ReturnType<typeof readTemplateChangeNotice>> = null,
): Promise<{
  readonly server: ReturnType<typeof createOMSMcpServer>;
  readonly client: Client;
}> {
  const server = createOMSMcpServer({ vault, source: "explicit", templateNotice });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "template-contract-review-e2e", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

function answerFor(question: TemplateInterviewQuestion): string {
  if (question.kind === "contract-selection") return question.choices?.[0] ?? "article";
  if (question.kind === "content-order") return "strict";
  if (question.kind === "naming") return "{{title}}.md";
  if (question.kind === "field-intent") return `Confirmed intent for ${question.subject}`;
  if (question.kind === "rename-identity") return question.choices?.[0] ?? question.templateId;
  if (question.kind === "deleted-source-disposition") return "retire";
  if (question.kind === "field-type") return question.choices?.[0] ?? "text";
  return "required";
}

function serviceResult(value: Record<string, unknown>): TemplateInterviewServiceResult {
  return value as unknown as TemplateInterviewServiceResult;
}

async function completeInterview(vault: string): Promise<TemplateInterviewServiceResult> {
  let result = await nextTemplateInterview(target(vault));
  for (let index = 0; index < 128 && result.state === "question"; index += 1) {
    const question = result.next;
    if (question === undefined) throw new Error("question state omitted result.next");
    result = await answerTemplateInterview(target(vault), {
      questionId: question.questionId,
      answer: answerFor(question),
      censusDigest: result.censusDigest,
      expectedLedgerDigest: result.expectedLedgerDigest,
    });
  }
  return result;
}

async function applyInterview(vault: string, result: TemplateInterviewServiceResult): Promise<void> {
  if (result.state !== "confirm" || result.approvalDigest === undefined) {
    throw new Error(`expected confirmation, received ${result.state}`);
  }
  const planned = await commitTemplateContracts(target(vault), {
    censusDigest: result.censusDigest,
    expectedLedgerDigest: result.expectedLedgerDigest,
    dryRun: true,
  });
  if (planned.status !== "planned") throw new Error(`expected a planned commit, received ${planned.status}`);
  expect(planned.approvalDigest).toBe(result.approvalDigest);
  const applied = await commitTemplateContracts(target(vault), {
    censusDigest: result.censusDigest,
    expectedLedgerDigest: result.expectedLedgerDigest,
    approvedDigest: planned.approvalDigest,
  });
  expect(["applied", "already-complete"]).toContain(applied.status);
}

afterEach(async () => {
  resetTemplateNoticeDeliveryForTests();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("template contract review across CLI, MCP, and capture", () => {
  it("includes the generic pending notice in boot instructions without source identities", async () => {
    const { root } = await fixture();
    const pendingNotice = await readTemplateChangeNotice(root);
    expect(pendingNotice).toMatchObject({
      state: "pending",
      actions: [...TEMPLATE_CHANGE_NOTICE_ACTIONS],
      next: { tool: "oms_write", arguments: { op: "template", mode: "interview-next" } },
    });
    expect(pendingNotice).not.toBeNull();
    if (pendingNotice === null) throw new Error("expected a pending template notice");
    const noticeText = JSON.stringify(pendingNotice);
    expect(noticeText).not.toContain(ENGLISH_PATH);
    expect(noticeText).not.toContain(KOREAN_PATH);
    expect(noticeText).not.toContain("english.md");
    expect(noticeText).not.toContain("한국어.md");

    const { server, client } = await connectMcp(root, pendingNotice);
    try {
      const instructions = client.getInstructions();
      expect(instructions).toContain(TEMPLATE_CHANGE_NOTICE_MESSAGE);
      expect(instructions).not.toContain(ENGLISH_PATH);
      expect(instructions).not.toContain(KOREAN_PATH);
      expect(instructions).not.toContain("english.md");
      expect(instructions).not.toContain("한국어.md");
      expect(pendingNotice.actions).toEqual([...TEMPLATE_CHANGE_NOTICE_ACTIONS]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("repairs one pending source, adopts it through scoped hosts, and admits its note without consuming unrelated work", async () => {
    const { root } = await fixture();
    const initial = await completeInterview(root);
    expect(initial.state).toBe("confirm");
    await applyInterview(root, initial);

    const agentPath = "Templates/Review/agent-session.md";
    const kakaoPath = "Templates/Review/kakaotalk.md";
    const proposalPath = join(root, "agent-session.proposed.md");
    const agentBefore = new TextEncoder().encode(
      "---\ntitle: Agent Session\nlanguage: en\nstatus: draft\n---\n# Broken\n",
    );
    const agentProposed = new TextEncoder().encode(
      "---\ntitle: Agent Session\nlanguage: en\nstatus: draft\n---\n# Agent Session\n<!-- oms:content -->\n",
    );
    const kakao = new TextEncoder().encode(
      "---\ntitle: KakaoTalk\nlanguage: ko\nstatus: draft\n---\n# KakaoTalk\n<!-- oms:content -->\n",
    );
    await Promise.all([
      writeFile(join(root, agentPath), agentBefore),
      writeFile(join(root, kakaoPath), kakao),
      writeFile(proposalPath, agentProposed),
    ]);

    const { server, client } = await connectMcp(root);
    try {
      const unrelatedReview = serviceResult(toolPayload(await client.callTool({
        name: "write",
        arguments: { op: "template", mode: "interview-next", templateId: "kakaotalk" },
      })));
      expect(unrelatedReview).toMatchObject({ state: "question", next: { templateId: "kakaotalk" } });
      const unrelatedQuestion = unrelatedReview.next;
      if (unrelatedQuestion === undefined) throw new Error("unrelated scoped review omitted its question");
      const unrelatedAnswered = serviceResult(toolPayload(await client.callTool({
        name: "write",
        arguments: {
          op: "template",
          mode: "interview-answer",
          templateId: "kakaotalk",
          questionId: unrelatedQuestion.questionId,
          answer: answerFor(unrelatedQuestion),
          censusDigest: unrelatedReview.censusDigest,
          expectedLedgerDigest: unrelatedReview.expectedLedgerDigest,
        },
      })));
      expect(unrelatedAnswered.expectedLedgerDigest).toMatch(digestPattern);
      const ledgerPath = join(root, ".oms", "template-interview.json");
      const ledgerBeforeRepair = JSON.parse(await readFile(ledgerPath, "utf8")) as {
        readonly answers: Readonly<Record<string, unknown>>;
      };
      const savedUnrelatedAnswer = ledgerBeforeRepair.answers[unrelatedQuestion.questionId];
      expect(savedUnrelatedAnswer).toBeDefined();

      const repairPlan = await cliJson(root, [
        "update", "agent-session",
        "--path", agentPath,
        "--from", proposalPath,
        "--expected-source-digest", sha256(agentBefore),
        "--renderer", "obsidian-core",
        "--dry-run",
      ]);
      expect(repairPlan).toMatchObject({ status: "planned", approvalDigest: expect.stringMatching(digestPattern) });
      expectExactBytes(await readFile(join(root, agentPath)), agentBefore);
      expectExactBytes(await readFile(join(root, kakaoPath)), kakao);

      const repairApproval = repairPlan.approvalDigest;
      if (typeof repairApproval !== "string") throw new Error("pending repair omitted approval digest");
      const repaired = await cliJson(root, [
        "update", "agent-session",
        "--path", agentPath,
        "--from", proposalPath,
        "--expected-source-digest", sha256(agentBefore),
        "--renderer", "obsidian-core",
        "--yes",
        "--approved-digest", repairApproval,
      ]);
      expect(repaired.status).toBe("applied");
      expectExactBytes(await readFile(join(root, agentPath)), agentProposed);
      expectExactBytes(await readFile(join(root, kakaoPath)), kakao);

      const rejectedBeforeAdoption = toolPayload(await client.callTool({
        name: "write",
        arguments: {
          op: "note",
          mode: "create",
          templateId: "agent-session",
          targetFolder: "Scoped",
          frontmatter: { title: "Before Adoption", language: "en", status: "draft" },
          body: "",
        },
      }));
      expect(rejectedBeforeAdoption).toMatchObject({
        status: "ask",
        rejection: { code: "contract-violation" },
      });

      let current = serviceResult(await cliJson(root, ["review", "--template-id", "agent-session"]));
      for (let index = 0; index < 128 && current.state === "question"; index += 1) {
        const question = current.next;
        if (question === undefined) throw new Error("scoped review omitted its next question");
        expect(question.templateId).toBe("agent-session");
        if (index % 2 === 0) {
          current = serviceResult(await cliJson(root, [
            "answer", question.questionId,
            "--template-id", "agent-session",
            "--answer", JSON.stringify(answerFor(question)),
            "--census-digest", current.censusDigest,
            "--ledger-digest", current.expectedLedgerDigest ?? "null",
          ]));
        } else {
          current = serviceResult(toolPayload(await client.callTool({
            name: "write",
            arguments: {
              op: "template",
              mode: "interview-answer",
              templateId: "agent-session",
              questionId: question.questionId,
              answer: answerFor(question),
              censusDigest: current.censusDigest,
              expectedLedgerDigest: current.expectedLedgerDigest,
            },
          })));
        }
      }
      expect(current).toMatchObject({ state: "confirm", reviewedTemplateIds: ["agent-session"] });

      const commitPlan = await cliJson(root, [
        "commit",
        "--template-id", "agent-session",
        "--census-digest", current.censusDigest,
        "--ledger-digest", current.expectedLedgerDigest ?? "null",
        "--dry-run",
      ]);
      expect(commitPlan).toMatchObject({ status: "planned", approvalDigest: expect.stringMatching(digestPattern) });
      const commitApproval = commitPlan.approvalDigest;
      if (typeof commitApproval !== "string") throw new Error("scoped commit omitted approval digest");
      const committed = toolPayload(await client.callTool({
        name: "write",
        arguments: {
          op: "template",
          mode: "commit-contracts",
          templateId: "agent-session",
          censusDigest: current.censusDigest,
          expectedLedgerDigest: current.expectedLedgerDigest,
          dryRun: false,
          approvedDigest: commitApproval,
        },
      }));
      expect(["applied", "already-complete"]).toContain(committed.status);

      const ledgerAfterCommit = JSON.parse(await readFile(ledgerPath, "utf8")) as {
        readonly answers: Readonly<Record<string, unknown>>;
      };
      expect(ledgerAfterCommit.answers[unrelatedQuestion.questionId]).toEqual(savedUnrelatedAnswer);
      const pending = serviceResult(toolPayload(await client.callTool({
        name: "write",
        arguments: { op: "template", mode: "interview-next" },
      })));
      expect(pending).toMatchObject({ state: "question", next: { templateId: "kakaotalk" } });
      expectExactBytes(await readFile(join(root, agentPath)), agentProposed);
      expectExactBytes(await readFile(join(root, kakaoPath)), kakao);

      const created = toolPayload(await client.callTool({
        name: "write",
        arguments: {
          op: "note",
          mode: "create",
          templateId: "agent-session",
          targetFolder: "Scoped",
          frontmatter: { title: "After Adoption", language: "en", status: "draft" },
          body: "",
        },
      }));
      expect(created).toMatchObject({
        status: "written",
        templateId: "agent-session",
        notePath: expect.stringMatching(/^Scoped\/.+\.md$/u),
      });
      const notePath = created.notePath;
      if (typeof notePath !== "string") throw new Error("native note create omitted notePath");
      expect(await readFile(join(root, notePath), "utf8")).toContain("title: After Adoption");
      expectExactBytes(await readFile(join(root, agentPath)), agentProposed);
      expectExactBytes(await readFile(join(root, kakaoPath)), kakao);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("discovers selected sources, resumes guarded review, and preserves source and note bytes", async () => {
    const { root, english, korean, existingNote } = await fixture();
    const { server, client } = await connectMcp(root);
    try {
      const first = serviceResult(await cliJson(root, ["review"]));
      expect(first.state).toBe("question");
      expect(first.next?.questionId).toMatch(digestPattern);
      expect(first).not.toHaveProperty("questions");
      expect(first.next?.templateId).toBe(ENGLISH_ID);
      expect(first.next?.templateId).not.toBe(KOREAN_ID);

      const readerOne = await nextTemplateInterview(target(root));
      const readerTwo = await nextTemplateInterview(target(root));
      expect(readerOne.censusDigest).toBe(first.censusDigest);
      expect(readerOne.expectedLedgerDigest).toBeNull();
      expect(readerTwo.next?.questionId).toBe(readerOne.next?.questionId);
      expect(readerTwo.expectedLedgerDigest).toBeNull();

      const question = readerOne.next;
      if (question === undefined) throw new Error("initial review omitted next question");
      const firstAnswer = toolPayload(await client.callTool({
        name: "write",
        arguments: {
          op: "template",
          mode: "interview-answer",
          questionId: question.questionId,
          answer: answerFor(question),
          censusDigest: readerOne.censusDigest,
          expectedLedgerDigest: readerOne.expectedLedgerDigest,
        },
      }));
      expect(firstAnswer.state).toBe("question");
      expect(firstAnswer).not.toHaveProperty("questions");
      expect(firstAnswer.templateNotice).toMatchObject({
        state: "pending",
        actions: [...TEMPLATE_CHANGE_NOTICE_ACTIONS],
        next: { tool: "oms_write", arguments: { op: "template", mode: "interview-next" } },
      });
      expect(firstAnswer.templateNotice).not.toHaveProperty("later");
      expect(TEMPLATE_CHANGE_NOTICE_MESSAGE).toBe("템플릿에 변경이 있습니다");

      const ledgerAfterFirstAnswer = await readFile(join(root, ".oms", "template-interview.json"));
      await expect(answerTemplateInterview(target(root), {
        questionId: question.questionId,
        answer: answerFor(question),
        censusDigest: readerTwo.censusDigest,
        expectedLedgerDigest: readerTwo.expectedLedgerDigest,
      })).rejects.toThrow("TEMPLATE_INTERVIEW_STALE");
      expectExactBytes(await readFile(join(root, ".oms", "template-interview.json")), ledgerAfterFirstAnswer);

      const resumedByCli = serviceResult(await cliJson(root, ["review"]));
      expect(resumedByCli.state).toBe("question");
      expect(resumedByCli.next?.questionId).toBe(firstAnswer.next && (firstAnswer.next as { questionId: string }).questionId);

      let current = serviceResult(firstAnswer);
      for (let index = 0; index < 128 && current.state === "question"; index += 1) {
        const next = current.next;
        if (next === undefined) throw new Error("resumed review omitted next question");
        if (index % 2 === 0) {
          current = serviceResult(await cliJson(root, [
            "answer",
            next.questionId,
            "--answer",
            JSON.stringify(answerFor(next)),
            "--census-digest",
            current.censusDigest,
            "--ledger-digest",
            current.expectedLedgerDigest ?? "null",
          ]));
        } else {
          current = serviceResult(toolPayload(await client.callTool({
            name: "write",
            arguments: {
              op: "template",
              mode: "interview-answer",
              questionId: next.questionId,
              answer: answerFor(next),
              censusDigest: current.censusDigest,
              expectedLedgerDigest: current.expectedLedgerDigest,
            },
          })));
        }
        expect(current).not.toHaveProperty("questions");
      }
      expect(current.state).toBe("confirm");
      expect(current.next).toBeUndefined();
      expect(current.approvalDigest).toMatch(digestPattern);
      expect(current.proposal?.mode).toBe("reconcile");
      expect(current.proposal?.sources.every(source => source.action === "verify-only")).toBe(true);
      expect(current.proposal?.outputs.every(output => output.finalVaultRelativePath.startsWith(".oms/"))).toBe(true);
      expect(containsBytePayload(current.proposal)).toBe(false);
      expect(current.proposal?.controls).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ".oms/template-policy.json",
          expectedCurrent: expect.objectContaining({ state: "present", signature: expect.stringMatching(digestPattern) }),
          current: expect.objectContaining({ state: "present", signature: expect.stringMatching(digestPattern) }),
          proposed: expect.objectContaining({ state: "present", signature: expect.stringMatching(digestPattern) }),
        }),
      ]));

      const beforeCommitEnglish = await readFile(join(root, ENGLISH_PATH));
      const beforeCommitKorean = await readFile(join(root, KOREAN_PATH));
      const beforeCommitNote = await readFile(join(root, "notes", "existing.md"));
      const planned = await cliJson(root, [
        "commit",
        "--census-digest",
        current.censusDigest,
        "--ledger-digest",
        current.expectedLedgerDigest ?? "null",
        "--dry-run",
      ]);
      expect(planned.status).toBe("planned");
      expect(planned.approvalDigest).toBe(current.approvalDigest);
      expectExactBytes(await readFile(join(root, ENGLISH_PATH)), beforeCommitEnglish);
      expectExactBytes(await readFile(join(root, KOREAN_PATH)), beforeCommitKorean);
      expectExactBytes(await readFile(join(root, "notes", "existing.md")), beforeCommitNote);

      const applied = toolPayload(await client.callTool({
        name: "write",
        arguments: {
          op: "template",
          mode: "commit-contracts",
          censusDigest: current.censusDigest,
          expectedLedgerDigest: current.expectedLedgerDigest,
          dryRun: false,
          approvedDigest: planned.approvalDigest,
        },
      }));
      expect(["applied", "already-complete"]).toContain(applied.status);
      expectExactBytes(await readFile(join(root, ENGLISH_PATH)), beforeCommitEnglish);
      expectExactBytes(await readFile(join(root, KOREAN_PATH)), beforeCommitKorean);
      expectExactBytes(await readFile(join(root, "notes", "existing.md")), beforeCommitNote);

      const convention = await loadResolvedTemplates(root);
      const englishTemplate = convention.templates[ENGLISH_ID];
      const koreanTemplate = convention.templates[KOREAN_ID];
      expect(englishTemplate).toMatchObject({ bom: true, eol: "crlf", sourcePath: ENGLISH_PATH });
      expect(koreanTemplate).toMatchObject({ bom: false, eol: "lf", sourcePath: KOREAN_PATH });
      expect(englishTemplate?.content.nodes.map(node => node.kind)).toEqual(["heading", "list", "fenced-code", "placeholder"]);
      expect(koreanTemplate?.content.nodes.map(node => node.kind)).toEqual(["heading", "list", "fenced-code", "placeholder"]);
      expect(englishTemplate?.fields.title).toMatchObject({ required: true, extensions: { fixture: "title" } });
      expect(englishTemplate?.fields.language).toMatchObject({
        required: true,
        allowedValues: ["en", "ko"],
        extensions: { fixture: "language" },
      });
      expect(englishTemplate?.fields.status).toMatchObject({
        required: true,
        allowedValues: ["draft", "published"],
        extensions: { fixture: "status" },
      });
      expect(englishTemplate?.fields.title.intent).toEqual(expect.any(String));

      // Keep this session alive across the source edit. The server re-reads
      // the changed source for admission, while the unaffected source remains
      // writable through the convention loaded before the edit.
      const baselineScan = toolPayload(await client.callTool({ name: "search", arguments: { op: "template-scan" } }));
      expect(baselineScan.templateNotice).toBeUndefined();
      const editedEnglish = Buffer.from(beforeCommitEnglish.toString("utf8").replace("title: English", "title: Edited English"), "utf8");
      await writeFile(join(root, ENGLISH_PATH), editedEnglish);

      const changedScan = toolPayload(await client.callTool({ name: "search", arguments: { op: "template-scan" } }));
      const pendingNotice = changedScan.templateNotice as {
        readonly pendingDigest: string;
        readonly actions: readonly string[];
        readonly next: { readonly tool: string; readonly arguments: Record<string, unknown> };
      };
      expect(pendingNotice).toMatchObject({
        state: "pending",
        pendingDigest: expect.stringMatching(digestPattern),
        actions: [...TEMPLATE_CHANGE_NOTICE_ACTIONS],
        next: { tool: "oms_write", arguments: { op: "template", mode: "interview-next" } },
      });
      expect(pendingNotice.next.arguments).not.toHaveProperty("later");

      const pendingEnglish = toolPayload(await client.callTool({
        name: "write",
        arguments: {
          op: "note",
          mode: "create",
          templateId: ENGLISH_ID,
          targetFolder: "Explicit",
          frontmatter: { title: "Pending English", language: "en", status: "draft" },
          body: "",
        },
      }));
      expect(pendingEnglish.status).toBe("ask");
      expect(pendingEnglish.rejection).toMatchObject({ code: "contract-violation" });
      expect(pendingEnglish.templateNotice).toBeUndefined();
      expectExactBytes(await readFile(join(root, ENGLISH_PATH)), editedEnglish);

      for (let index = 0; index < 2; index += 1) {
        const status = toolPayload(await client.callTool({ name: "status", arguments: {} }));
        expect(status.templateNotice).toEqual(pendingNotice);
      }

      const koreanWritten = await writeResolvedTemplateNote({
        target: target(root),
        convention,
        templateId: KOREAN_ID,
        targetFolder: "Explicit",
        frontmatter: { title: "명시적 대상", language: "ko", status: "draft" },
        body: "",
        mode: "create",
        dryRun: false,
        resolvedAt: "2026-09-14T00:00:00.000Z",
      });
      expect(koreanWritten.status).toBe("written");
      expect(koreanWritten.notePath).toEqual(expect.stringMatching(/^Explicit\/.+\.md$/u));
      const koreanNotePath = koreanWritten.notePath as string;
      const koreanNoteBeforeBadUpdate = await readFile(join(root, koreanNotePath));
      const badBodyUpdate = toolPayload(await client.callTool({
        name: "write",
        arguments: {
          op: "note",
          mode: "update",
          notePath: koreanNotePath,
          body: "# intentionally incomplete",
        },
      }));
      expect(badBodyUpdate.status).toBe("rejected");
      expect(badBodyUpdate.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({ rule: "required", message: expect.stringContaining("Body contract violation") }),
      ]));
      expectExactBytes(await readFile(join(root, koreanNotePath)), koreanNoteBeforeBadUpdate);
      expectExactBytes(await readFile(join(root, "notes", "existing.md")), beforeCommitNote);
      expectExactBytes(await readFile(join(root, KOREAN_PATH)), korean);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps unaffected answers across a source change and rejects stale cross-host CAS", async () => {
    const { root } = await fixture();
    const initial = await nextTemplateInterview(target(root));
    if (initial.next === undefined) throw new Error("expected an initial question");
    let current = initial;
    let unaffectedQuestion: TemplateInterviewQuestion | undefined;
    let changedQuestion: TemplateInterviewQuestion | undefined;
    for (
      let index = 0;
      index < 128
      && current.state === "question"
      && (unaffectedQuestion === undefined || changedQuestion === undefined);
      index += 1
    ) {
      const question = current.next;
      if (question === undefined) throw new Error("source-change review omitted next question");
      if (
        unaffectedQuestion === undefined
        && question.templateId === ENGLISH_ID
        && question.kind === "field-requiredness"
        && question.subject === "field:title"
      ) {
        unaffectedQuestion = question;
      }
      if (
        changedQuestion === undefined
        && question.templateId === ENGLISH_ID
        && question.kind === "field-requiredness"
        && question.subject === "field:status"
      ) {
        changedQuestion = question;
      }
      current = await answerTemplateInterview(target(root), {
        questionId: question.questionId,
        answer: answerFor(question),
        censusDigest: current.censusDigest,
        expectedLedgerDigest: current.expectedLedgerDigest,
      });
    }
    expect(unaffectedQuestion).toBeDefined();
    expect(changedQuestion).toBeDefined();
    if (unaffectedQuestion === undefined || changedQuestion === undefined) {
      throw new Error("fixture did not expose the expected field review slots");
    }
    const ledgerPath = join(root, ".oms", "template-interview.json");
    const ledgerBeforeSourceChange = await readFile(ledgerPath);
    const englishPath = join(root, ENGLISH_PATH);
    const changedEnglish = Buffer.from((await readFile(englishPath, "utf8")).replace("status: draft", "status: published"), "utf8");
    await writeFile(englishPath, changedEnglish);

    const resumed = await nextTemplateInterview(target(root));
    expect(resumed.state).toBe("question");
    expect(resumed.invalidatedQuestionIds).not.toContain(unaffectedQuestion.questionId);
    expect(resumed.invalidatedQuestionIds).toContain(changedQuestion.questionId);
    expect(resumed.next?.templateId).toBe(ENGLISH_ID);
    expect(resumed.expectedLedgerDigest).toMatch(digestPattern);
    expect(current.expectedLedgerDigest).toMatch(digestPattern);
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { readonly answers: Record<string, unknown> };
    expect(ledger.answers).toHaveProperty(unaffectedQuestion.questionId);
    expect(ledger.answers).toHaveProperty(changedQuestion.questionId);

    const readerTwo = await nextTemplateInterview(target(root));
    await expect(answerTemplateInterview(target(root), {
      questionId: changedQuestion.questionId,
      answer: answerFor(changedQuestion),
      censusDigest: initial.censusDigest,
      expectedLedgerDigest: null,
    })).rejects.toThrow("TEMPLATE_INTERVIEW_STALE");
    expectExactBytes(await readFile(ledgerPath), ledgerBeforeSourceChange);
    expect(readerTwo.expectedLedgerDigest).toBe(resumed.expectedLedgerDigest);
  });

  it("confirms zero-question diffs, preserves unique renames, and retires deleted sources", async () => {
    const { root, english, existingNote } = await fixture();
    const initial = await completeInterview(root);
    expect(initial.state).toBe("confirm");
    await applyInterview(root, initial);

    const convention = await loadResolvedTemplates(root);
    const note = await writeResolvedTemplateNote({
      target: target(root),
      convention,
      templateId: KOREAN_ID,
      targetFolder: "Persisted",
      frontmatter: { title: "Persisted Korean", language: "ko", status: "draft" },
      body: "",
      mode: "create",
      dryRun: false,
      resolvedAt: "2026-09-14T00:00:00.000Z",
    });
    expect(note.status).toBe("written");
    const persistedNotePath = note.notePath;
    const persistedNoteBeforeDelete = await readFile(join(root, persistedNotePath));

    const englishPath = join(root, ENGLISH_PATH);
    const renamedPath = join(root, "Templates", "Review", "renamed.md");
    await rename(englishPath, renamedPath);
    await rm(join(root, ".oms", "template-interview.json"), { force: true });
    const renameReview = await nextTemplateInterview(target(root));
    expect(renameReview.state).toBe("confirm");
    expect(renameReview.next).toBeUndefined();
    expect(renameReview.proposedPolicy?.templates[ENGLISH_ID]?.sourcePath).toBe("Templates/Review/renamed.md");
    expect(renameReview.proposal?.sources.every(source => source.action === "verify-only")).toBe(true);
    await applyInterview(root, renameReview);
    expectExactBytes(await readFile(renamedPath), english);
    await expect(readFile(englishPath)).rejects.toMatchObject({ code: "ENOENT" });
    expectExactBytes(await readFile(join(root, persistedNotePath)), persistedNoteBeforeDelete);

    const koreanPath = join(root, KOREAN_PATH);
    await unlink(koreanPath);
    await rm(join(root, ".oms", "template-interview.json"), { force: true });
    const deletionReview = await nextTemplateInterview(target(root));
    expect(deletionReview.state).toBe("question");
    let afterDeletionAnswers = deletionReview;
    let deletionQuestion: TemplateInterviewQuestion | undefined;
    for (let index = 0; index < 32 && afterDeletionAnswers.state === "question"; index += 1) {
      const question = afterDeletionAnswers.next;
      if (question === undefined) throw new Error("deletion review omitted next question");
      if (question.kind === "deleted-source-disposition") {
        deletionQuestion = question;
        break;
      }
      afterDeletionAnswers = await answerTemplateInterview(target(root), {
        questionId: question.questionId,
        answer: answerFor(question),
        censusDigest: afterDeletionAnswers.censusDigest,
        expectedLedgerDigest: afterDeletionAnswers.expectedLedgerDigest,
      });
    }
    expect(deletionQuestion).toBeDefined();
    if (deletionQuestion === undefined) throw new Error("deletion review omitted disposition question");
    const deferred = await answerTemplateInterview(target(root), {
      questionId: deletionQuestion.questionId,
      answer: "defer",
      censusDigest: afterDeletionAnswers.censusDigest,
      expectedLedgerDigest: afterDeletionAnswers.expectedLedgerDigest,
    });
    expect(deferred.state).toBe("confirm");
    const ledgerBeforeReopen = await readFile(join(root, ".oms", "template-interview.json"));
    await applyInterview(root, deferred);
    const reopened = await nextTemplateInterview(target(root));
    expect(reopened.state).toBe("question");
    expect(reopened.next).toMatchObject({
      questionId: deletionQuestion.questionId,
      kind: "deleted-source-disposition",
    });
    expectExactBytes(await readFile(join(root, ".oms", "template-interview.json")), ledgerBeforeReopen);
    const retired = await answerTemplateInterview(target(root), {
      questionId: reopened.next!.questionId,
      answer: "retire",
      censusDigest: reopened.censusDigest,
      expectedLedgerDigest: reopened.expectedLedgerDigest,
    });
    expect(retired.state).toBe("confirm");
    await applyInterview(root, retired);
    await expect(readFile(koreanPath)).rejects.toMatchObject({ code: "ENOENT" });
    expectExactBytes(await readFile(join(root, persistedNotePath)), persistedNoteBeforeDelete);

    await rm(join(root, ".oms", "template-interview.json"), { force: true });
    const renamedEnglish = await readFile(renamedPath, "utf8");
    await writeFile(renamedPath, renamedEnglish.replace("title: English", "title: Zero Question"));
    const policyBeforeZeroQuestion = await readFile(join(root, ".oms", "template-policy.json"));
    const zeroQuestion = await nextTemplateInterview(target(root));
    expect(zeroQuestion.state).toBe("confirm");
    expect(zeroQuestion.next).toBeUndefined();
    expect(zeroQuestion.approvalDigest).toMatch(digestPattern);
    expectExactBytes(await readFile(join(root, ".oms", "template-policy.json")), policyBeforeZeroQuestion);
    expectExactBytes(await readFile(join(root, "notes", "existing.md")), existingNote);
  });

  it("blocks an unsupported nested source without publishing controls", async () => {
    const { root } = await fixture();
    const initial = await completeInterview(root);
    expect(initial.state).toBe("confirm");
    await applyInterview(root, initial);
    const unsupportedPath = join(root, "Templates", "Review", "unsupported.md");
    await writeFile(
      unsupportedPath,
      "---\n"
      + "title: '{{date:YYYY[year]}}'\n"
      + "language: en\n"
      + "status: draft\n"
      + "---\n"
      + "Unsupported\n",
    );
    const controls = [
      join(root, ".oms", "template-policy.json"),
      join(root, ".oms", "taxonomy.json"),
      join(root, ".oms", "types.json"),
      join(root, ".obsidian", "types.json"),
    ] as const;
    const before = await Promise.all(controls.map(path => readFile(path)));
    const sources = [unsupportedPath, join(root, ENGLISH_PATH), join(root, KOREAN_PATH)] as const;
    const sourceBefore = await Promise.all(sources.map(path => readFile(path)));
    const ledgerPath = join(root, ".oms", "template-interview.json");
    const ledgerBefore = await readFile(ledgerPath);
    const review = await completeInterview(root);
    expect(review.state).toBe("blocked");
    expect(review.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "TEMPLATE_EXPRESSION_UNSUPPORTED",
        path: "Templates/Review/unsupported.md",
      }),
    ]));
    expect(review.proposal).toBeUndefined();
    await expect(commitTemplateContracts(target(root), {
      censusDigest: review.censusDigest,
      expectedLedgerDigest: review.expectedLedgerDigest,
      dryRun: true,
    })).rejects.toThrow("TEMPLATE_RECONCILE_REVIEW_REQUIRED");
    expect(await Promise.all(controls.map(path => readFile(path)))).toEqual(before);
    expect(await Promise.all(sources.map(path => readFile(path)))).toEqual(sourceBefore);
    expect(await readFile(ledgerPath)).toEqual(ledgerBefore);
  });

  it("surfaces a deferred deletion through the notice before reopening review", async () => {
    const { root } = await fixture();
    const initial = await completeInterview(root);
    expect(initial.state).toBe("confirm");
    await applyInterview(root, initial);
    const koreanPath = join(root, KOREAN_PATH);
    await unlink(koreanPath);
    await rm(join(root, ".oms", "template-interview.json"), { force: true });

    let review = await nextTemplateInterview(target(root));
    let deletionQuestion: TemplateInterviewQuestion | undefined;
    for (let index = 0; index < 32 && review.state === "question"; index += 1) {
      const question = review.next;
      if (question === undefined) throw new Error("deletion review omitted question");
      if (question.kind === "deleted-source-disposition") {
        deletionQuestion = question;
        break;
      }
      review = await answerTemplateInterview(target(root), {
        questionId: question.questionId,
        answer: answerFor(question),
        censusDigest: review.censusDigest,
        expectedLedgerDigest: review.expectedLedgerDigest,
      });
    }
    expect(deletionQuestion).toBeDefined();
    if (deletionQuestion === undefined) throw new Error("deletion review omitted disposition");
    const deferred = await answerTemplateInterview(target(root), {
      questionId: deletionQuestion.questionId,
      answer: "defer",
      censusDigest: review.censusDigest,
      expectedLedgerDigest: review.expectedLedgerDigest,
    });
    expect(deferred.state).toBe("confirm");
    await applyInterview(root, deferred);

    const { server, client } = await connectMcp(root);
    try {
      const notice = toolPayload(await client.callTool({
        name: "search",
        arguments: { op: "template-scan" },
      }));
      expect(notice.templateNotice).toMatchObject({
        state: "pending",
        actions: [...TEMPLATE_CHANGE_NOTICE_ACTIONS],
        next: { tool: "oms_write", arguments: { op: "template", mode: "interview-next" } },
      });
      expect(notice.templateNotice).not.toHaveProperty("later");
    } finally {
      await client.close();
      await server.close();
    }

    const ledgerBeforeReview = await readFile(join(root, ".oms", "template-interview.json"));
    const reopened = await nextTemplateInterview(target(root));
    expect(reopened.state).toBe("question");
    expect(reopened.next).toMatchObject({
      questionId: deletionQuestion.questionId,
      kind: "deleted-source-disposition",
    });
    expectExactBytes(await readFile(join(root, ".oms", "template-interview.json")), ledgerBeforeReview);
    const retired = await answerTemplateInterview(target(root), {
      questionId: reopened.next!.questionId,
      answer: "retire",
      censusDigest: reopened.censusDigest,
      expectedLedgerDigest: reopened.expectedLedgerDigest,
    });
    expect(retired.state).toBe("confirm");
    await applyInterview(root, retired);
    await expect(readFile(koreanPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("normalizes an NFD template id at the note-create boundary", async () => {
    const { root } = await fixture();
    const memoPath = join(root, "Templates", "Review", "메모.md");
    await rename(join(root, KOREAN_PATH), memoPath);
    const review = await completeInterview(root);
    expect(review.state).toBe("confirm");
    expect(review.proposedPolicy?.templates["메모"]).toBeDefined();
    await applyInterview(root, review);
    const convention = await loadResolvedTemplates(root);
    const created = await writeResolvedTemplateNote({
      target: target(root),
      convention,
      templateId: "메모".normalize("NFD"),
      targetFolder: "NFD",
      frontmatter: { title: "NFD 메모", language: "ko", status: "draft" },
      body: "",
      mode: "create",
      dryRun: false,
      resolvedAt: "2026-09-14T00:00:00.000Z",
    });
    expect(created.status).toBe("written");
    expect(created.templateId).toBe("메모");
  });
});
