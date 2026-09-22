import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { diagnose, regenerate, load, reviewContext, next, answer, commit } = vi.hoisted(() => ({
  diagnose: vi.fn(async () => ({ status: "healthy", diagnostics: [] })),
  regenerate: vi.fn(async ({ request }: { request: { dryRun?: boolean } }) => ({ status: request.dryRun ? "planned" : "applied", mode: "reconcile" })),
  load: vi.fn(async () => ({
    generationDigest: `sha256:${"b".repeat(64)}`,
    defaultContract: { templateId: null, fields: {}, headings: [] },
    templates: { note: { id: "note", templateId: "note", contractDigest: `sha256:${"b".repeat(64)}` } },
  })),
  reviewContext: vi.fn(async () => ({
    vault: "/vault",
    resolved: {
      generationDigest: `sha256:${"c".repeat(64)}`,
      drafts: [],
      sources: [],
      diagnostics: [],
    },
    approved: [
      { templateId: null, templatePath: ".oms/templates/default.md", approvedMarkdownDigest: `sha256:${"d".repeat(64)}` },
      { templateId: "note", templatePath: ".oms/templates/note.md", approvedMarkdownDigest: `sha256:${"e".repeat(64)}` },
    ],
    raw: [{ templateId: "note", path: "Sources/note.md", identity: "note-source", approvedRawDigest: `sha256:${"f".repeat(64)}`, observedRawDigest: null, drift: "SOURCE_DRIFT" }],
  })),
  next: vi.fn(async () => ({ state: "question", next: { questionId: `sha256:${"f".repeat(64)}` }, censusDigest: `sha256:${"c".repeat(64)}`, expectedLedgerDigest: null })),
  answer: vi.fn(async (_target: any, request: any) => ({ state: "confirm", ...request, expectedLedgerDigest: `sha256:${"e".repeat(64)}` })),
  commit: vi.fn(async (_target: any, request: any) => ({ status: request.dryRun ? "planned" : "applied", mode: "reconcile", approvalDigest: `sha256:${"a".repeat(64)}` })),
}));

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
    for (const verb of ["scan", "list", "show", "check", "regenerate-types", "review", "answer", "commit"]) expect(usage).toContain(verb);
    expect(usage).toContain("Leaves: scan | list | show | check | regenerate-types | review | answer | commit");
    expect(usage).not.toContain("--mode");
    expect(usage).not.toMatch(/\badd\b/u);
    expect(usage).not.toMatch(/\bupdate\b/u);
    expect(usage).not.toMatch(/\bmove\b/u);
    expect(usage).not.toMatch(/\bremove\b/u);
    expect(usage).not.toMatch(/\bdefault\b/u);
    expect(usage).toContain("--yes --approved-digest");
  });

  it("lists, shows, scans, and checks without invoking mutation", async () => {
    const root = await vault();
    await runTemplateCommand(["list", "--vault", root]); expect(output().templates[0].id).toBe("note");
    await runTemplateCommand(["show", "note", "--vault", root]); expect(output().template.id).toBe("note");
    await runTemplateCommand(["scan", "--vault", root]); expect(reviewContext).toHaveBeenCalledWith(root);
    expect(output()).toMatchObject({
      approved: [{ templateId: null }, { templateId: "note" }],
      raw: [{ path: "Sources/note.md", drift: "SOURCE_DRIFT" }],
    });
    await runTemplateCommand(["check", "--vault", root]); expect(diagnose).toHaveBeenCalledWith({ vault: root, source: "explicit" });
    expect(output()).toMatchObject({ vault: root, status: "healthy", diagnostics: [] });
    expect(process.exitCode).toBe(0);
    expect(commit).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("forwards review, answer, and commit leaves without collapsing their guards", async () => {
    const root = await vault();
    const questionId = `sha256:${"f".repeat(64)}`;
    const censusDigest = `sha256:${"c".repeat(64)}`;
    const ledgerDigest = `sha256:${"e".repeat(64)}`;

    await runTemplateCommand(["review", "--vault", root]);
    expect(next).toHaveBeenCalledWith({ vault: root, source: "explicit" });
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

  it("reports needs-repair as warning-only while preserving rejected failures", async () => {
    const root = await vault();
    diagnose.mockResolvedValueOnce({ status: "needs-repair", diagnostics: [{ code: "TEMPLATE_CONTROL_MISSING" }] });
    await runTemplateCommand(["check", "--vault", root]);
    expect(output()).toMatchObject({
      vault: root,
      status: "needs-repair",
      diagnostics: [{ code: "TEMPLATE_CONTROL_MISSING" }],
    });
    expect(process.exitCode).toBe(0);

    commit.mockResolvedValueOnce({ status: "inconsistent", diagnostics: [] });
    await runTemplateCommand(["commit", "--census-digest", digest, "--ledger-digest", "null", "--vault", root, "--dry-run"]);
    expect(process.exitCode).toBe(1);
  });

  it("rejects retired add, update, move, remove, and default leaves with no alias", async () => {
    const root = await vault();
    for (const args of [
      ["add", "External", "--vault", root, "--dry-run"],
      ["update", "note", "--vault", root, "--dry-run"],
      ["move", "--folder", "Templates", "--vault", root, "--dry-run"],
      ["remove", "note", "--vault", root, "--dry-run"],
      ["default", "note", "--vault", root, "--dry-run"],
    ]) {
      await runTemplateCommand(args);
      expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_ARGS_INVALID" }] });
    }
    expect(commit).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
  });

  it("supports guarded regenerate-types", async () => {
    const root = await vault();
    await runTemplateCommand(["regenerate-types", "--vault", root, "--dry-run"]);
    expect(regenerate).toHaveBeenCalledWith({ target: { vault: root, source: "explicit" }, request: { dryRun: true } });
    await runTemplateCommand(["regenerate-types", "--vault", root, "--yes", "--approved-digest", digest]);
    expect(regenerate).toHaveBeenLastCalledWith({ target: { vault: root, source: "explicit" }, request: { approvedDigest: digest } });
  });

  it("rejects self-approval, stale-shaped digests, unknown flags, and argument conflicts before mutation", async () => {
    const root = await vault();
    for (const args of [
      ["commit", "--census-digest", digest, "--ledger-digest", "null", "--vault", root, "--yes"],
      ["commit", "--census-digest", digest, "--ledger-digest", "null", "--vault", root, "--yes", "--approved-digest", "sha256:BAD"],
      ["commit", "--census-digest", digest, "--ledger-digest", "null", "--vault", root, "--dry-run", "--approved-digest", digest],
      ["regenerate-types", "--vault", root, "--unknown", "x", "--dry-run"],
    ]) {
      await runTemplateCommand(args);
      expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_ARGS_INVALID" }] });
    }
    expect(commit).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("rejects cwd-inferred mutation for answer, commit, and regenerate-types", async () => {
    await runTemplateCommand(["answer", digest, "--answer", "true", "--census-digest", digest, "--ledger-digest", "null"]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_ARGS_INVALID" }] });
    await runTemplateCommand(["commit", "--census-digest", digest, "--ledger-digest", "null", "--dry-run"]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_ARGS_INVALID" }] });
    await runTemplateCommand(["regenerate-types", "--dry-run"]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_ARGS_INVALID" }] });
    expect(answer).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
  });
});
