import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execute, repairPending, resume, diagnose, regenerate, load, reviewContext, next, answer, commit } = vi.hoisted(() => ({
  execute: vi.fn(async (_target: any, change: any, request: any) => ({ status: request.dryRun ? "planned" : "applied", mode: change.mode, approvalDigest: `sha256:${"a".repeat(64)}` })),
  repairPending: vi.fn(async (_target: any, _change: any, request: any) => ({ status: request.dryRun ? "planned" : "applied", mode: "update", approvalDigest: `sha256:${"a".repeat(64)}` })),
  resume: vi.fn(async () => ({ status: "applied", mode: "update" })),
  diagnose: vi.fn(async () => ({ status: "healthy", diagnostics: [] })),
  regenerate: vi.fn(async ({ request }: { request: { dryRun?: boolean } }) => ({ status: request.dryRun ? "planned" : "applied", mode: "reconcile" })),
  load: vi.fn(async () => ({ inputSignature: `sha256:${"b".repeat(64)}`, templates: { note: { id: "note", renderer: "obsidian-core", sourcePath: "Templates/note.md" } } })),
  reviewContext: vi.fn(async () => ({
    vault: "/vault",
    censusDigest: `sha256:${"c".repeat(64)}`,
    projectionUsable: false,
    freshTemplateIds: [],
    policy: {},
    obsidianTypes: {},
    census: {
      digest: `sha256:${"d".repeat(64)}`,
      entries: [{ sourcePath: "Templates/note.md", signature: `sha256:${"e".repeat(64)}`, templateId: "note", diagnostics: [], bytes: new Uint8Array() }],
      diffs: [],
      diagnostics: [],
    },
  })),
  next: vi.fn(async () => ({ state: "question", next: { questionId: `sha256:${"f".repeat(64)}` }, censusDigest: `sha256:${"c".repeat(64)}`, expectedLedgerDigest: null })),
  answer: vi.fn(async (_target: any, request: any) => ({ state: "confirm", ...request, expectedLedgerDigest: `sha256:${"e".repeat(64)}` })),
  commit: vi.fn(async (_target: any, request: any) => ({ status: request.dryRun ? "planned" : "applied", mode: "reconcile", approvalDigest: `sha256:${"a".repeat(64)}` })),
}));

vi.mock("../kernel/templates/operations.js", () => ({ executeTemplateOperation: execute }));
vi.mock("../kernel/templates/pending-source.js", () => ({ repairPendingTemplateSource: repairPending }));
vi.mock("../kernel/templates/transaction.js", () => ({ resumeTemplateTransaction: resume, TEMPLATE_MUTATION_MARKER_PATH: ".oms/template-mutation.json" }));
vi.mock("../kernel/templates/doctor.js", () => ({ diagnoseTemplates: diagnose, regenerateTypes: regenerate }));
vi.mock("../kernel/templates/resolver.js", () => ({ loadResolvedTemplates: load }));
vi.mock("../kernel/templates/review-context.js", () => ({ readTemplateReviewContext: reviewContext }));
vi.mock("../kernel/templates/interview-service.js", () => ({
  nextTemplateInterview: next,
  answerTemplateInterview: answer,
  commitTemplateContracts: commit,
}));
vi.mock("../kernel/link/link.js", () => ({ resolveEffectiveVault: vi.fn(async () => ({ vault: process.cwd(), source: "cwd", scope: null })) }));

import { runTemplateCommand, templateUsage } from "./template-command.js";

const roots: string[] = [];
const digest = `sha256:${"1".repeat(64)}`;
let log: ReturnType<typeof vi.spyOn>;
async function vault(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-template-cli-")); roots.push(root);
  await mkdir(path.join(root, ".oms"), { recursive: true });
  await mkdir(path.join(root, "Templates"), { recursive: true });
  await writeFile(path.join(root, ".oms", "template-policy.json"), JSON.stringify({
    version: 3,
    templateFolders: [{ path: "Templates", default: true }],
    base: { fields: {} },
    contracts: { base: { fields: {}, intent: "Base", views: [] }, article: { fields: {}, intent: "Article", views: [] } },
    templates: { note: { templateId: "note", destinationClass: "registered-existing", renderer: "obsidian-core", sourceFolder: "Templates", sourcePath: "Templates/note.md", contract: "base", naming: "{{date}}-{{slug}}.md" } },
  }));
  await writeFile(path.join(root, "Templates", "note.md"), "---\ntemplate: note\n---\nbody\n");
  return root;
}
beforeEach(() => {
  process.exitCode = undefined;
  vi.clearAllMocks();
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  log.mockRestore();
  process.exitCode = undefined;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function output(): any { return JSON.parse(String(log.mock.calls.at(-1)?.[0])); }

describe("template command", () => {
  it("documents every public verb and approval protocol", () => {
    const usage = templateUsage();
    for (const verb of ["scan", "list", "show", "add", "update", "move", "remove", "default", "check", "regenerate-types", "review", "answer", "commit"]) expect(usage).toContain(verb);
    expect(usage).not.toContain("--mode");
    expect(usage).not.toContain("add <existing-file>");
    expect(usage).toContain("--yes --approved-digest");
  });

  it("lists, shows, scans, and checks without invoking mutation", async () => {
    const root = await vault();
    await runTemplateCommand(["list", "--vault", root]); expect(output().templates[0].id).toBe("note");
    await runTemplateCommand(["show", "note", "--vault", root]); expect(output().template.id).toBe("note");
    await runTemplateCommand(["scan", "--vault", root]); expect(reviewContext).toHaveBeenCalledWith(root);
    expect(output()).toMatchObject({ projectionUsable: false, entries: [{ sourcePath: "Templates/note.md" }] });
    await runTemplateCommand(["check", "--vault", root]); expect(diagnose).toHaveBeenCalledWith({ vault: root, source: "explicit" });
    expect(output()).toMatchObject({ vault: root, status: "healthy", diagnostics: [] });
    expect(process.exitCode).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("forwards review, answer, and commit leaves without collapsing their guards", async () => {
    const root = await vault();
    const questionId = `sha256:${"f".repeat(64)}`;
    const censusDigest = `sha256:${"c".repeat(64)}`;
    const ledgerDigest = `sha256:${"e".repeat(64)}`;

    await runTemplateCommand(["review", "--vault", root]);
    expect(next).toHaveBeenCalledWith({ vault: root, source: "explicit" }, undefined);
    await runTemplateCommand(["review", "--vault", root, "--dry-run"]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_ARGS_INVALID" }] });
    expect(next).toHaveBeenCalledOnce();

    await runTemplateCommand([
      "answer", questionId, "--answer", '{"required":true}', "--census-digest", censusDigest,
      "--ledger-digest", "null", "--vault", root,
    ]);
    expect(answer).toHaveBeenCalledWith(
      { vault: root, source: "explicit" },
      { questionId, answer: { required: true }, censusDigest, expectedLedgerDigest: null },
    );
    await runTemplateCommand(["answer", questionId, "--answer", "not-json", "--census-digest", censusDigest, "--ledger-digest", "null", "--vault", root]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_ARGS_INVALID" }] });
    expect(answer).toHaveBeenCalledOnce();
    await runTemplateCommand(["answer", questionId, "--answer", "true", "--census-digest", "sha256:BAD", "--ledger-digest", ledgerDigest, "--vault", root, "--yes"]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_ARGS_INVALID" }] });
    expect(answer).toHaveBeenCalledOnce();

    await runTemplateCommand(["commit", "--census-digest", censusDigest, "--ledger-digest", "null", "--vault", root, "--dry-run"]);
    expect(commit).toHaveBeenCalledWith(
      { vault: root, source: "explicit" },
      { censusDigest, expectedLedgerDigest: null, dryRun: true },
    );
    await runTemplateCommand(["commit", "--census-digest", censusDigest, "--ledger-digest", ledgerDigest, "--vault", root, "--yes", "--approved-digest", digest]);
    expect(commit).toHaveBeenLastCalledWith(
      { vault: root, source: "explicit" },
      { censusDigest, expectedLedgerDigest: ledgerDigest, approvedDigest: digest },
    );
  });

  it("forwards template-scoped review CAS and guarded pending-source repair", async () => {
    const root = await vault();
    const proposal = path.join(root, "agent-session.md");
    await writeFile(proposal, "---\ntitle: Agent Session\n---\n<!-- oms:content -->\n");
    await runTemplateCommand(["review", "--template-id", "agent-session", "--vault", root]);
    expect(next).toHaveBeenLastCalledWith({ vault: root, source: "explicit" }, "agent-session");

    await runTemplateCommand([
      "update", "agent-session",
      "--path", "Templates/agent-session.md",
      "--from", proposal,
      "--expected-source-digest", digest,
      "--renderer", "obsidian-core",
      "--vault", root,
      "--dry-run",
    ]);
    expect(repairPending).toHaveBeenCalledWith(
      { vault: root, source: "explicit" },
      expect.objectContaining({
        templateId: "agent-session",
        sourcePath: "Templates/agent-session.md",
        expectedSourceDigest: digest,
        renderer: "obsidian-core",
        bytes: expect.any(Uint8Array),
      }),
      { dryRun: true },
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports needs-repair as warning-only while preserving rejected and inconsistent failures", async () => {
    const root = await vault();
    diagnose.mockResolvedValueOnce({ status: "needs-repair", diagnostics: [{ code: "TEMPLATE_CONTROL_MISSING" }] });
    await runTemplateCommand(["check", "--vault", root]);
    expect(output()).toMatchObject({
      vault: root,
      status: "needs-repair",
      diagnostics: [{ code: "TEMPLATE_CONTROL_MISSING" }],
    });
    expect(process.exitCode).toBe(0);

    execute.mockResolvedValueOnce({ status: "inconsistent", diagnostics: [] });
    await runTemplateCommand(["default", "note", "--vault", root, "--dry-run"]);
    expect(process.exitCode).toBe(1);
  });

  it("selects folders without registration modes and preserves explicit defaults", async () => {
    const root = await vault();
    await runTemplateCommand(["add", "External", "--vault", root, "--dry-run"]);
    expect(execute).toHaveBeenCalledWith({ vault: root, source: "explicit" }, { mode: "register-folder", folder: { path: "External" } }, { dryRun: true });
    await runTemplateCommand(["add", "Other", "--creation-default", "--vault", root, "--dry-run"]);
    expect(execute).toHaveBeenLastCalledWith({ vault: root, source: "explicit" }, { mode: "register-folder", folder: { path: "Other", default: true } }, { dryRun: true });
  });

  it("rejects per-file registration and retired folder modes", async () => {
    const root = await vault();
    await runTemplateCommand(["add", "Templates/note.md", "--id", "article", "--contract", "article", "--vault", root, "--dry-run"]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_ARGS_INVALID" }] });
    await runTemplateCommand(["add", "Templates", "--mode", "auto", "--vault", root, "--dry-run"]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_ARGS_INVALID" }] });
    expect(execute).not.toHaveBeenCalled();
  });

  it("creates from bounded content in the registered creation folder", async () => {
    const root = await vault();
    const from = path.join(root, "content.md");
    const content = "---\ntemplate: article\n---\nbody\n";
    await writeFile(from, content);
    await runTemplateCommand(["add", "--id", "article", "--from", from, "--contract", "article", "--vault", root, "--dry-run"]);
    expect(execute).toHaveBeenCalledWith({ vault: root, source: "explicit" }, expect.objectContaining({ mode: "create", binding: expect.objectContaining({ sourcePath: "Templates/article.md", contract: "article" }), source: expect.objectContaining({ bytes: expect.any(Uint8Array), publication: "write" }) }), { dryRun: true });
    expect(process.exitCode).toBe(0);
  });

  it("builds precise update, reclassify, relocate, remove, and default changes", async () => {
    const root = await vault();
    await runTemplateCommand(["update", "note", "--naming", "{{slug}}.md", "--vault", root, "--dry-run"]);
    expect(execute.mock.calls.at(-1)?.[1]).toMatchObject({ mode: "update", templateId: "note", binding: { naming: "{{slug}}.md" }, source: { path: "Templates/note.md", publication: "verify-existing" } });
    await runTemplateCommand(["update", "note", "--class", "managed-default", "--vault", root, "--dry-run"]);
    expect(execute.mock.calls.at(-1)?.[1]).toEqual({ mode: "reclassify", templateId: "note", toClass: "managed-default" });
    await runTemplateCommand(["move", "--folder", "Templates", "--vault", root, "--dry-run"]);
    expect(execute.mock.calls.at(-1)?.[1]).toEqual({ mode: "relocate-folder", templateFolder: "Templates" });
    await runTemplateCommand(["remove", "note", "--delete-source", "--vault", root, "--dry-run"]);
    expect(execute.mock.calls.at(-1)?.[1]).toEqual({ mode: "remove", templateId: "note", deleteSource: true });
    await runTemplateCommand(["default", "note", "--vault", root, "--dry-run"]);
    expect(execute.mock.calls.at(-1)?.[1]).toEqual({ mode: "default", templateId: "note" });
  });

  it("supports guarded regenerate and resume apply", async () => {
    const root = await vault();
    await runTemplateCommand(["regenerate-types", "--vault", root, "--dry-run"]);
    expect(regenerate).toHaveBeenCalledWith({ target: { vault: root, source: "explicit" }, request: { dryRun: true } });
    await runTemplateCommand(["update", "--resume", "tx-1", "--vault", root, "--yes", "--approved-digest", digest]);
    expect(resume).toHaveBeenCalledWith(root, "tx-1", digest, ".oms/template-mutation.json");
  });

  it("passes an approved digest unchanged and prints a stale-CAS rejection receipt", async () => {
    const root = await vault();
    execute.mockResolvedValueOnce({ status: "rejected", mode: "default", diagnostics: [{ code: "MIGRATION_APPROVAL_MISMATCH" }] } as any);
    await runTemplateCommand(["default", "note", "--vault", root, "--yes", "--approved-digest", digest]);
    expect(execute).toHaveBeenCalledWith({ vault: root, source: "explicit" }, { mode: "default", templateId: "note" }, { approvedDigest: digest });
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "MIGRATION_APPROVAL_MISMATCH" }] });
    expect(process.exitCode).toBe(1);
  });

  it("rejects self-approval, stale-shaped digests, unknown flags, and argument conflicts before mutation", async () => {
    const root = await vault();
    for (const args of [
      ["remove", "note", "--vault", root, "--yes"],
      ["default", "note", "--vault", root, "--yes", "--approved-digest", "sha256:BAD"],
      ["move", "--folder", "Templates", "--vault", root, "--dry-run", "--approved-digest", digest],
      ["update", "note", "--class", "managed-default", "--naming", "x", "--vault", root, "--dry-run"],
      ["remove", "note", "--unknown", "x", "--vault", root, "--dry-run"],
    ]) {
      await runTemplateCommand(args);
      expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_ARGS_INVALID" }] });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects cwd-inferred mutation, unsafe paths, missing defaults/contracts, and oversized --from", async () => {
    await runTemplateCommand(["default", "note", "--dry-run"]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_ARGS_INVALID" }] });
    await runTemplateCommand(["answer", digest, "--answer", "true", "--census-digest", digest, "--ledger-digest", "null"]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_ARGS_INVALID" }] });
    await runTemplateCommand(["commit", "--census-digest", digest, "--ledger-digest", "null", "--dry-run"]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_ARGS_INVALID" }] });
    expect(answer).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    const root = await vault();
    await runTemplateCommand(["add", "../escape", "--vault", root, "--dry-run"]);
    expect(output().status).toBe("rejected");
    await runTemplateCommand(["add", "Templates/note.md", "--id", "other", "--contract", "missing", "--vault", root, "--dry-run"]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_CONTRACT_UNKNOWN" }] });
    const script = path.join(root, "script.md");
    await writeFile(script, "---\ntemplate: script\n---\n<%* throw new Error('must not execute') %>\n");
    await runTemplateCommand(["add", "--id", "script", "--from", script, "--vault", root, "--dry-run"]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_EXPRESSION_UNSUPPORTED" }] });
    await writeFile(path.join(root, ".oms", "template-policy.json"), JSON.stringify({
      version: 3, templateFolders: [{ path: "Templates" }], base: { fields: {} },
      contracts: { base: { fields: {}, intent: "Base", views: [] } }, templates: {},
    }));
    const content = path.join(root, "content.md"); await writeFile(content, "---\ntemplate: other\n---\nbody\n");
    await runTemplateCommand(["add", "--id", "other", "--from", content, "--vault", root, "--dry-run"]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_FOLDER_DEFAULT_UNDECLARED" }] });
    const huge = path.join(root, "huge.md"); await writeFile(huge, "x".repeat(262_145));
    await runTemplateCommand(["add", "--id", "huge", "--from", huge, "--vault", root, "--dry-run"]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_PROPOSAL_OVERSIZE" }] });
    expect(execute).not.toHaveBeenCalled();
  });
});
