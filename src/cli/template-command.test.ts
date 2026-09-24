import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeContractVault } from "../kernel/templates/approved-vault-fixture.js";

const { publish, reviewSources, acknowledge, relink, diagnose } = vi.hoisted(() => ({
  publish: vi.fn(async (input: any) => (input.confirmed
    ? { state: "published", revision: 1, receipt: { status: "complete" } }
    : { state: "confirmation-required", plan: { revision: 1, addedTemplates: [], removedTemplates: [], changedTemplates: [], commonChanged: false, propertiesChanged: false } })),
  reviewSources: vi.fn(async () => ({ vault: "/vault", revision: 1, reviews: [{ templateId: "note", state: "unchanged", path: "Templates/note.md" }], held: [] })),
  acknowledge: vi.fn(async (input: any) => (input.confirmed ? { state: "published", revision: 2 } : { state: "confirmation-required", review: { state: "drift" } })),
  relink: vi.fn(async (input: any) => (input.confirmed ? { state: "published", revision: 2 } : { state: "confirmation-required", review: { state: "missing" } })),
  diagnose: vi.fn(async () => ({ vault: "/vault", status: "needs-repair", revision: 1, settings: "verified", diagnostics: [{ code: "SOURCE_DRIFT", message: "the registered source changed", templateId: "note" }] })),
}));

vi.mock("../kernel/templates/service.js", () => ({
  publishContract: publish,
  reviewContractSources: reviewSources,
  acknowledgeContractSource: acknowledge,
  relinkContractSource: relink,
  diagnoseContract: diagnose,
}));
vi.mock("../kernel/link/link.js", () => ({ resolveEffectiveVault: vi.fn(async () => ({ vault: process.cwd(), source: "cwd", scope: null })) }));

import { runTemplateCommand, templateUsage } from "./template-command.js";

const TRANSACTION = "33333333-3333-4333-8333-333333333333";
const DIGEST = `sha256:${"a".repeat(64)}`;
const roots: string[] = [];
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.clearAllMocks();
});

afterEach(async () => {
  log.mockRestore();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function output(): any {
  return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
}

async function vault(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-template-cli-"));
  roots.push(root);
  await writeContractVault(root, {
    properties: { title: { type: "text", intent: "Note title." } },
    templates: { note: { fields: ["title"], approvedMarkdown: "---\ntemplate: note\ntitle: Untitled\n---\n", targetFolder: "notes" } },
    folders: { notes: { intent: "Notes." } },
  });
  return root;
}

describe("template command", () => {
  it("documents every public leaf and rejects the retired ones", async () => {
    const usage = templateUsage();
    for (const verb of ["list", "show", "scan", "check", "publish", "review-sources", "acknowledge-source", "relink-source"]) {
      expect(usage).toContain(verb);
    }
    expect(usage).toContain("Leaves: list | show | scan | check | publish | review-sources | acknowledge-source | relink-source");
    expect(usage).toContain("--policy <file.json>");
    expect(usage).toContain("--reviewed-digest");
    expect(usage).toContain("--candidate-path");
    // The interview ledger, the derived projection repair, and the old
    // mutation verbs leave no alias behind.
    for (const retired of ["regenerate-types", "--proposals", "--census-digest", "--ledger-digest", "--approved-digest"]) {
      expect(usage, retired).not.toContain(retired);
    }
    expect(usage).not.toMatch(/^  (review|answer|commit)(\s|$)/mu);
    const root = await vault();
    for (const args of [["review"], ["answer", DIGEST], ["commit"], ["regenerate-types", "--dry-run"], ["add", "note"], ["remove", "note"]]) {
      await runTemplateCommand([...args, "--vault", root]);
      expect(output(), args.join(" ")).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_ARGS_INVALID" }] });
    }
    expect(publish).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(relink).not.toHaveBeenCalled();
  });

  it("reads the published contract for list, show, and scan without mutating it", async () => {
    const root = await vault();
    const before = await readFile(path.join(root, ".oms", "template-policy.json"));

    await runTemplateCommand(["list", "--vault", root]);
    const listed = output();
    expect(listed).toMatchObject({ vault: root, revision: 1 });
    expect(listed.common).toMatchObject({ status: "active" });
    expect(listed.templates).toEqual([expect.objectContaining({
      templateId: "note",
      status: "active",
      source: { identity: "source-note", path: "Templates/note.md" },
      sourceState: "unchanged",
    })]);

    await runTemplateCommand(["show", "note", "--vault", root]);
    expect(output()).toMatchObject({ templateId: "note", status: "active", contract: { templateId: "note" } });

    await runTemplateCommand(["show", "ghost", "--vault", root]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_NOT_FOUND" }] });

    await runTemplateCommand(["scan", "--vault", root]);
    const scanned = output();
    expect(scanned).toMatchObject({ vault: root, revision: 1, registeredCount: 1 });
    expect(scanned.candidates).toEqual([expect.objectContaining({ path: "Templates/note.md", registeredId: "note", readable: true })]);

    expect(await readFile(path.join(root, ".oms", "template-policy.json"))).toEqual(before);
    expect(publish).not.toHaveBeenCalled();
  });

  it("reports the contract diagnosis for check without repairing it", async () => {
    const root = await vault();
    await runTemplateCommand(["check", "--vault", root]);
    expect(diagnose).toHaveBeenCalledWith({ target: { vault: root, source: "explicit" } });
    expect(output()).toMatchObject({ status: "needs-repair", diagnostics: [{ code: "SOURCE_DRIFT" }] });
  });

  it("forwards publication and source review leaves without collapsing their confirmation", async () => {
    const root = await vault();
    const documentPath = path.join(root, "contract.json");
    await writeFile(documentPath, JSON.stringify({ version: 5, revision: 1, properties: {}, common: { status: "active", fields: {} }, templates: {} }));

    await runTemplateCommand(["publish", "--policy", documentPath, "--transaction-id", TRANSACTION, "--vault", root]);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ target: { vault: root, source: "explicit" }, transactionId: TRANSACTION, confirmed: false }));
    expect(output()).toMatchObject({ state: "confirmation-required" });
    await runTemplateCommand(["publish", "--policy", documentPath, "--transaction-id", TRANSACTION, "--vault", root, "--yes"]);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ confirmed: true }));

    await runTemplateCommand(["review-sources", "--vault", root, "--template-id", "note"]);
    expect(reviewSources).toHaveBeenCalledWith({ target: { vault: root, source: "explicit" }, templateId: "note" });

    await runTemplateCommand(["acknowledge-source", "--vault", root, "--template-id", "note", "--reviewed-digest", DIGEST, "--transaction-id", TRANSACTION]);
    expect(acknowledge).toHaveBeenCalledWith({ target: { vault: root, source: "explicit" }, templateId: "note", reviewedDigest: DIGEST, transactionId: TRANSACTION, confirmed: false });
    await runTemplateCommand(["relink-source", "--vault", root, "--template-id", "note", "--candidate-path", "Templates/moved.md", "--transaction-id", TRANSACTION, "--yes"]);
    expect(relink).toHaveBeenLastCalledWith(expect.objectContaining({ candidatePath: "Templates/moved.md", confirmed: true }));

    publish.mockClear();
    acknowledge.mockClear();
    relink.mockClear();
    for (const args of [
      ["publish", "--transaction-id", TRANSACTION],
      ["publish", "--policy", documentPath],
      ["publish", "--policy", path.join(root, "absent.json"), "--transaction-id", TRANSACTION],
      ["acknowledge-source", "--template-id", "note", "--reviewed-digest", DIGEST],
      ["acknowledge-source", "--template-id", "note", "--transaction-id", TRANSACTION],
      ["relink-source", "--template-id", "note", "--transaction-id", TRANSACTION],
      ["review-sources", "--unknown", "x"],
    ]) {
      await runTemplateCommand([...args, "--vault", root]);
      expect(output(), args.join(" ")).toMatchObject({ status: "rejected", diagnostics: [{ code: "TEMPLATE_ARGS_INVALID" }] });
    }
    expect(publish).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(relink).not.toHaveBeenCalled();
  });

  it("refuses a cwd-inferred vault for a mutating leaf", async () => {
    await runTemplateCommand(["acknowledge-source", "--template-id", "note", "--reviewed-digest", DIGEST, "--transaction-id", TRANSACTION, "--yes"]);
    // The service owns admission, so the CLI forwards the inferred target and
    // the refusal comes back typed rather than being guessed here.
    expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({ target: { vault: process.cwd(), source: "cwd" } }));
  });
});
