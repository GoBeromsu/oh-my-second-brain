import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VAULT_PUBLICATION_LEASE } from "./file-lock.js";

const injectedFault = vi.hoisted(() => ({
  operation: "" as "" | "write" | "remove" | "read" | "realpath",
  suffix: "",
  armed: false,
  skip: 0,
  code: "",
}));

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const denyAccess = (value: string): boolean => injectedFault.armed && injectedFault.operation === "realpath" && value.endsWith(injectedFault.suffix);
  const shouldFail = (operation: typeof injectedFault.operation, value: string): boolean => {
    if (!injectedFault.armed || injectedFault.operation !== operation || !value.endsWith(injectedFault.suffix)) return false;
    if (injectedFault.skip > 0) {
      injectedFault.skip -= 1;
      return false;
    }
    injectedFault.armed = false;
    return true;
  };
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>): Promise<void> => {
      if (shouldFail("write", String(args[0]))) throw new Error("injected write failure");
      await actual.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>): Promise<void> => {
      if (shouldFail("write", String(args[1]))) throw new Error("injected rename failure");
      await actual.rename(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>): Promise<void> => {
      if (shouldFail("remove", String(args[0]))) throw new Error("injected remove failure");
      await actual.rm(...args);
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      if (denyAccess(String(args[0]))) {
        const error = new Error("denied") as NodeJS.ErrnoException;
        error.code = injectedFault.code || "EACCES";
        throw error;
      }
      return actual.realpath(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args);
      if (shouldFail("read", String(args[0]))) return Buffer.from("injected read-back mismatch");
      return result;
    },
  };
});

import { approvalDigest, digestBytes, hashCanonical, outputDigest } from "./canonical.js";
import { parseTemplatePolicy } from "./policy.js";
import { loadResolvedTemplates } from "./resolver.js";
import { readSearchTemplateSource } from "../engine/retrieval/template-source.js";
import * as eventJournal from "../runtime/event-journal.js";
import { readRuntimeEvents } from "../runtime/event-read.js";
import {
  executeTemplateTransaction,
  inspectTemplateTransactionMarker,
  resumeTemplateTransaction,
  TEMPLATE_TRANSACTION_MARKER_PATH,
  type TemplateTransactionFailure,
  type TemplateTransactionFailureReason,
} from "./transaction.js";
import type {
  ControlTransition,
  Digest,
  FileExpectation,
  ManagedDraftTransition,
  ManagedTemplatePath,
  PlannedPhysicalOutput,
  TemplateCompositionManifest,
  TemplateId,
  TemplateTransactionReceipt,
  VerifiedFileState,
} from "./types.js";

const encoder = new TextEncoder();
const POLICY = ".oms/template-policy.json" as const;
const TAXONOMY = ".oms/taxonomy.json" as const;
const PROJECTION = ".oms/types.json" as const;
const DRAFT = ".oms/templates/default.md" as ManagedTemplatePath;
const POLICY_V1 = "policy-v1";
const POLICY_V2 = "policy-v2";
const TAXONOMY_V1 = "taxonomy-v1";
const TAXONOMY_V2 = "taxonomy-v2";
const PROJECTION_V1 = "projection-v1";
const PROJECTION_V2 = "projection-v2";
const DRAFT_V1 = "draft-v1";
const DRAFT_V2 = "draft-v2";
const NOTE = "ordinary note\n";
const SOURCE = "raw source\n";
const OBSIDIAN = "{\"types\":{\"title\":\"text\"}}\n";
const roots: string[] = [];
let previousRuntime: string | undefined;

beforeEach(() => {
  injectedFault.operation = "";
  injectedFault.suffix = "";
  injectedFault.armed = false;
  injectedFault.skip = 0;
  injectedFault.code = "";
  previousRuntime = process.env.OMS_RUNTIME_ROOT;
});

afterEach(async () => {
  if (previousRuntime === undefined) delete process.env.OMS_RUNTIME_ROOT;
  else process.env.OMS_RUNTIME_ROOT = previousRuntime;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function publicationId(approval: Digest, output: Digest): string {
  return digestBytes(`${approval}\0${output}`).slice("sha256:".length, "sha256:".length + 32);
}

function present(text: string): Extract<VerifiedFileState, { readonly state: "present" }> {
  const bytes = encoder.encode(text);
  return { state: "present", bytes, signature: digestBytes(bytes) };
}

function expectation(state: VerifiedFileState): FileExpectation {
  return state.state === "absent" ? { state: "absent" } : { state: "present", signature: state.signature };
}

function control<K extends "policy" | "taxonomy" | "projection", P extends ".oms/template-policy.json" | ".oms/taxonomy.json" | ".oms/types.json">(
  kind: K,
  controlPath: P,
  before: string,
  after: string,
  action: "write" | "verify-only",
): ControlTransition<K, P> {
  const current = present(before);
  const proposed = present(after);
  return { kind, path: controlPath, expectedCurrent: expectation(current), current, proposed, action };
}

function draft(before: string | null, after: string | null, action: "write" | "verify-only", templateId: TemplateId | null = null, draftPath: ManagedTemplatePath = DRAFT): ManagedDraftTransition {
  const current = before === null ? { state: "absent" as const } : present(before);
  const proposed = after === null ? { state: "absent" as const } : present(after);
  return { templateId, path: draftPath, expectedCurrent: expectation(current), current, proposed, action };
}

function seal(body: Omit<TemplateCompositionManifest, "approvalDigest" | "outputDigest">): TemplateCompositionManifest {
  return { ...body, approvalDigest: approvalDigest(body), outputDigest: outputDigest(body.outputs) };
}

function publication(options: {
  readonly policy?: readonly [string, string, "write" | "verify-only"];
  readonly taxonomy?: readonly [string, string, "write" | "verify-only"];
  readonly projection?: readonly [string, string, "write" | "verify-only"];
  readonly drafts?: readonly ManagedDraftTransition[];
  readonly outputs?: readonly PlannedPhysicalOutput[];
} = {}): TemplateCompositionManifest {
  const [policyBefore, policyAfter, policyAction] = options.policy ?? [POLICY_V1, POLICY_V2, "write"];
  const [taxonomyBefore, taxonomyAfter, taxonomyAction] = options.taxonomy ?? [TAXONOMY_V1, TAXONOMY_V2, "write"];
  const [projectionBefore, projectionAfter, projectionAction] = options.projection ?? [PROJECTION_V1, PROJECTION_V2, "write"];
  const drafts = options.drafts ?? [draft(null, DRAFT_V2, "write")];
  const controls = [
    control("policy", POLICY, policyBefore, policyAfter, policyAction),
    control("taxonomy", TAXONOMY, taxonomyBefore, taxonomyAfter, taxonomyAction),
    control("projection", PROJECTION, projectionBefore, projectionAfter, projectionAction),
  ] as TemplateCompositionManifest["controls"];
  const transitions = [...controls, ...drafts];
  const outputs = options.outputs ?? transitions.flatMap(transition => transition.action === "write" && transition.proposed.state === "present"
    ? [{ finalVaultRelativePath: transition.path, payloadDigest: transition.proposed.signature }]
    : []);
  return seal({
    version: 1,
    markerPath: TEMPLATE_TRANSACTION_MARKER_PATH,
    controls,
    drafts,
    operations: [{ kind: "commit-contract", templateId: null, payloadDigest: digestBytes("commit-contract") }],
    diagnostics: [],
    outputs,
  });
}

interface Fixture {
  readonly root: string;
  readonly vault: string;
  readonly runtime: string;
}

async function fixture(draftText?: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-template-publication-"));
  roots.push(root);
  const vault = path.join(root, "vault");
  const runtime = path.join(root, "runtime");
  process.env.OMS_RUNTIME_ROOT = runtime;
  await mkdir(path.join(vault, ".oms"), { recursive: true });
  await mkdir(path.join(vault, ".obsidian"), { recursive: true });
  await mkdir(path.join(vault, "Notes"), { recursive: true });
  await mkdir(path.join(vault, "Templates"), { recursive: true });
  await writeFile(path.join(vault, POLICY), POLICY_V1);
  await writeFile(path.join(vault, TAXONOMY), TAXONOMY_V1);
  await writeFile(path.join(vault, PROJECTION), PROJECTION_V1);
  await writeFile(path.join(vault, "Notes", "plain.md"), NOTE);
  await writeFile(path.join(vault, "Templates", "source.md"), SOURCE);
  await writeFile(path.join(vault, ".obsidian", "types.json"), OBSIDIAN);
  if (draftText !== undefined) {
    await mkdir(path.join(vault, ".oms", "templates"), { recursive: true });
    await writeFile(path.join(vault, DRAFT), draftText);
  }
  return { root, vault, runtime };
}

async function files(vault: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else found.push(path.relative(vault, absolute).replaceAll("\\", "/"));
    }
  }
  await walk(vault);
  return found.sort();
}

async function text(vault: string, relativePath: string): Promise<string> {
  return readFile(path.join(vault, relativePath), "utf8");
}

function code(receipt: TemplateTransactionReceipt): string | undefined {
  return receipt.status === "rejected" || receipt.status === "inconsistent" || receipt.status === "resume-required" ? receipt.diagnostics[0]?.code : undefined;
}

async function untouched(vault: string): Promise<void> {
  expect(await text(vault, "Notes/plain.md")).toBe(NOTE);
  expect(await text(vault, "Templates/source.md")).toBe(SOURCE);
  expect(await text(vault, ".obsidian/types.json")).toBe(OBSIDIAN);
}

function events(item: Fixture) {
  return readRuntimeEvents({ vaultPath: item.vault, runtimeRoot: item.runtime }).events;
}

function rejectsLegacyMarker(vault: string, manifest: TemplateCompositionManifest): void {
  // @ts-expect-error v4 publication does not accept a marker alias or migration mode.
  void executeTemplateTransaction(vault, manifest, { approvedDigest: manifest.approvalDigest }, ".oms/template-migration.json");
}
void rejectsLegacyMarker;

describe("v4 guarded template publication", () => {
  it("dry-run matches the approval and creates no vault, lock, journal, or staging bytes", async () => {
    const item = await fixture();
    const manifest = publication();
    const before = await files(item.vault);
    const receipt = await executeTemplateTransaction(item.vault, manifest, { dryRun: true });
    expect(receipt).toMatchObject({ status: "planned", approvalDigest: manifest.approvalDigest, outputDigest: manifest.outputDigest });
    expect(await files(item.vault)).toEqual(before);
    expect(existsSync(item.runtime)).toBe(false);
    expect(events(item)).toEqual([]);
    expect(await inspectTemplateTransactionMarker(item.vault)).toEqual({ admission: "clear", state: "absent", marker: null });
    await untouched(item.vault);
  });

  it("publishes the three controls and managed draft when the approved digest matches", async () => {
    const item = await fixture();
    const manifest = publication();
    const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
    expect(receipt).toMatchObject({
      status: "applied",
      transactionId: publicationId(manifest.approvalDigest, manifest.outputDigest),
      approvalDigest: manifest.approvalDigest,
      outputDigest: manifest.outputDigest,
      writtenPaths: [POLICY, TAXONOMY, PROJECTION, DRAFT],
      markerState: "complete",
    });
    expect(await text(item.vault, POLICY)).toBe(POLICY_V2);
    expect(await text(item.vault, TAXONOMY)).toBe(TAXONOMY_V2);
    expect(await text(item.vault, PROJECTION)).toBe(PROJECTION_V2);
    expect(await text(item.vault, DRAFT)).toBe(DRAFT_V2);
    await untouched(item.vault);
    const id = publicationId(manifest.approvalDigest, manifest.outputDigest);
    expect(await files(item.vault)).toEqual([
      ".obsidian/types.json",
      `.oms/.template-transactions/${id}/plan.json`,
      ".oms/taxonomy.json",
      ".oms/template-policy.json",
      ".oms/template-transaction.json",
      ".oms/templates/default.md",
      ".oms/types.json",
      "Notes/plain.md",
      "Templates/source.md",
    ]);
    expect(await inspectTemplateTransactionMarker(item.vault)).toMatchObject({ admission: "clear", state: "complete" });
    const committed = events(item);
    expect(committed.filter(event => event.kind === "template-contract-commit")).toHaveLength(1);
    expect(committed.filter(event => event.kind === "template-contract-commit-control")).toHaveLength(4);
    expect(committed.every(event => event.outcome === "success" && event.inputSignature === manifest.approvalDigest)).toBe(true);
  });

  it("rejects a changed control CAS preimage without writing", async () => {
    const item = await fixture();
    const manifest = publication();
    await writeFile(path.join(item.vault, POLICY), "control-changed");
    const before = await files(item.vault);
    const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
    expect(receipt.status).toBe("rejected");
    expect(code(receipt)).toBe("CONTRACT_UNVERIFIABLE");
    expect(await text(item.vault, POLICY)).toBe("control-changed");
    expect(await files(item.vault)).toEqual(before);
    expect(existsSync(item.runtime)).toBe(false);
    await untouched(item.vault);
  });

  it("rejects a changed managed draft CAS preimage without writing", async () => {
    const item = await fixture(DRAFT_V1);
    const manifest = publication({ drafts: [draft(DRAFT_V1, DRAFT_V2, "write")] });
    await writeFile(path.join(item.vault, DRAFT), "draft-changed");
    const before = await files(item.vault);
    const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
    expect(receipt.status).toBe("rejected");
    expect(code(receipt)).toBe("MANAGED_TEMPLATE_DRIFT");
    expect(await text(item.vault, DRAFT)).toBe("draft-changed");
    expect(await text(item.vault, POLICY)).toBe(POLICY_V1);
    expect(await files(item.vault)).toEqual(before);
    await untouched(item.vault);
  });

  it("rejects a stale verify-only preimage and leaves an unchanged manifest untouched", async () => {
    const item = await fixture();
    const verified = publication({
      policy: [POLICY_V1, POLICY_V1, "verify-only"],
      taxonomy: [TAXONOMY_V1, TAXONOMY_V1, "verify-only"],
      projection: [PROJECTION_V1, PROJECTION_V1, "verify-only"],
      drafts: [],
    });
    const before = await files(item.vault);
    expect((await executeTemplateTransaction(item.vault, verified, { approvedDigest: verified.approvalDigest })).status).toBe("unchanged");
    expect(await files(item.vault)).toEqual(before);
    expect(events(item)).toEqual([]);
    await writeFile(path.join(item.vault, POLICY), "stale-preimage");
    const receipt = await executeTemplateTransaction(item.vault, verified, { approvedDigest: verified.approvalDigest });
    expect(receipt.status).toBe("rejected");
    expect(code(receipt)).toBe("CONTRACT_UNVERIFIABLE");
    expect(await text(item.vault, POLICY)).toBe("stale-preimage");
    expect(await inspectTemplateTransactionMarker(item.vault)).toEqual({ admission: "clear", state: "absent", marker: null });
    await untouched(item.vault);
  });

  it("rejects a tampered approval digest, output digest, or proposed byte hash", async () => {
    const item = await fixture();
    const manifest = publication();
    const before = await files(item.vault);
    const tamperedApproval = { ...manifest, approvalDigest: digestBytes("tampered-approval") };
    expect(code(await executeTemplateTransaction(item.vault, tamperedApproval, { approvedDigest: tamperedApproval.approvalDigest }))).toBe("TEMPLATE_TRANSACTION_MANIFEST_INVALID");
    const tamperedOutput = { ...manifest, outputDigest: digestBytes("tampered-output") };
    expect(code(await executeTemplateTransaction(item.vault, tamperedOutput, { approvedDigest: manifest.approvalDigest }))).toBe("TEMPLATE_TRANSACTION_MANIFEST_INVALID");
    const tamperedBytes = {
      ...manifest,
      controls: [{ ...manifest.controls[0]!, proposed: { ...manifest.controls[0]!.proposed, signature: digestBytes("declared-lie") } }, manifest.controls[1]!, manifest.controls[2]!] as TemplateCompositionManifest["controls"],
    };
    expect(code(await executeTemplateTransaction(item.vault, tamperedBytes, { approvedDigest: manifest.approvalDigest }))).toBe("TEMPLATE_TRANSACTION_MANIFEST_INVALID");
    const incoherent = publication({ outputs: manifest.outputs.filter(output => output.finalVaultRelativePath !== POLICY) });
    expect(code(await executeTemplateTransaction(item.vault, incoherent, { approvedDigest: incoherent.approvalDigest }))).toBe("TEMPLATE_TRANSACTION_MANIFEST_INVALID");
    expect(await files(item.vault)).toEqual(before);
    expect(await text(item.vault, POLICY)).toBe(POLICY_V1);
    await untouched(item.vault);
  });

  it("refuses ordinary notes, raw sources, and Obsidian type outputs", async () => {
    const item = await fixture();
    const before = await files(item.vault);
    for (const illegal of ["Notes/plain.md", "Templates/source.md", ".obsidian/types.json"] as const) {
      const body = publication();
      const outputs = [...body.outputs, { finalVaultRelativePath: illegal, payloadDigest: digestBytes("illegal") }] as TemplateCompositionManifest["outputs"];
      const { approvalDigest: _approval, outputDigest: _output, ...rest } = { ...body, outputs };
      const manifest = seal(rest);
      const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
      expect(receipt.status).toBe("rejected");
      expect(code(receipt)).toBe("TEMPLATE_SOURCE_UNSAFE");
    }
    const sourced = publication();
    const sourceDraft = draft(null, DRAFT_V2, "write", null, "Notes/plain.md" as ManagedTemplatePath);
    const { approvalDigest: _approval, outputDigest: _output, ...rest } = { ...sourced, drafts: [sourceDraft] };
    const manifest = seal(rest);
    expect(code(await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest }))).toBe("TEMPLATE_SOURCE_UNSAFE");
    expect(await files(item.vault)).toEqual(before);
    await untouched(item.vault);
  });

  it("refuses a symlink in the staging path before any publication I/O", async () => {
    const item = await fixture();
    const manifest = publication();
    const outside = await mkdtemp(path.join(tmpdir(), "oms-staging-outside-"));
    roots.push(outside);
    const sentinel = path.join(outside, "sentinel.txt");
    await writeFile(sentinel, "SENTINEL");
    const id = publicationId(manifest.approvalDigest, manifest.outputDigest);
    const stagedPolicy = path.join(item.vault, ".oms", ".template-transactions", id, "staging", ".oms", "template-policy.json");
    await mkdir(path.dirname(stagedPolicy), { recursive: true });
    await symlink(sentinel, stagedPolicy);
    const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
    expect(receipt.status).toBe("rejected");
    expect(code(receipt)).toBe("TEMPLATE_SOURCE_UNSAFE");
    expect(await readFile(sentinel, "utf8")).toBe("SENTINEL");
    expect(await text(item.vault, POLICY)).toBe(POLICY_V1);
    expect(await inspectTemplateTransactionMarker(item.vault)).toEqual({ admission: "clear", state: "absent", marker: null });
    await untouched(item.vault);
  });

  it("leaves a reader-blocking marker when publication fails between controls", async () => {
    const item = await fixture();
    const manifest = publication();
    injectedFault.operation = "write";
    injectedFault.suffix = ".oms/taxonomy.json";
    injectedFault.skip = 1;
    injectedFault.armed = true;
    const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
    expect(receipt.status).toBe("resume-required");
    expect(code(receipt)).toBe("CONTRACT_TRANSACTION_IN_PROGRESS");
    expect(await text(item.vault, POLICY)).toBe(POLICY_V2);
    expect(await text(item.vault, TAXONOMY)).toBe(TAXONOMY_V1);
    expect(await text(item.vault, PROJECTION)).toBe(PROJECTION_V1);
    await expect(text(item.vault, DRAFT)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await inspectTemplateTransactionMarker(item.vault)).toMatchObject({
      admission: "blocked",
      state: "in-progress",
      marker: { status: "in-progress", transactionId: publicationId(manifest.approvalDigest, manifest.outputDigest), approvalDigest: manifest.approvalDigest },
    });
    expect(events(item)).toEqual([]);
    await untouched(item.vault);
  });

  it("resumes a torn publication from the durable plan and disk hashes", async () => {
    const item = await fixture();
    const manifest = publication();
    injectedFault.operation = "write";
    injectedFault.suffix = ".oms/taxonomy.json";
    injectedFault.skip = 1;
    injectedFault.armed = true;
    expect((await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("resume-required");
    expect(events(item)).toEqual([]);
    const inspection = await inspectTemplateTransactionMarker(item.vault);
    expect(inspection.state).toBe("in-progress");
    const receipt = await resumeTemplateTransaction(item.vault, inspection.marker!.transactionId, manifest.approvalDigest);
    expect(receipt).toMatchObject({ status: "applied", approvalDigest: manifest.approvalDigest, outputDigest: manifest.outputDigest, markerState: "complete" });
    expect(await text(item.vault, POLICY)).toBe(POLICY_V2);
    expect(await text(item.vault, TAXONOMY)).toBe(TAXONOMY_V2);
    expect(await text(item.vault, PROJECTION)).toBe(PROJECTION_V2);
    expect(await text(item.vault, DRAFT)).toBe(DRAFT_V2);
    expect(await inspectTemplateTransactionMarker(item.vault)).toMatchObject({ admission: "clear", state: "complete" });
    expect(events(item).some(event => event.kind === "template-contract-commit" && event.outcome === "success")).toBe(true);
    await untouched(item.vault);
  });

  it("refuses an external mutation during resume", async () => {
    const item = await fixture();
    const manifest = publication();
    injectedFault.operation = "write";
    injectedFault.suffix = ".oms/taxonomy.json";
    injectedFault.skip = 1;
    injectedFault.armed = true;
    await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
    await writeFile(path.join(item.vault, TAXONOMY), "external-mutation");
    const inspection = await inspectTemplateTransactionMarker(item.vault);
    const receipt = await resumeTemplateTransaction(item.vault, inspection.marker!.transactionId, manifest.approvalDigest);
    expect(receipt.status).toBe("inconsistent");
    expect(code(receipt)).toBe("TEMPLATE_TRANSACTION_INCONSISTENT");
    expect(await text(item.vault, TAXONOMY)).toBe("external-mutation");
    expect(await text(item.vault, POLICY)).toBe(POLICY_V2);
    expect(await text(item.vault, PROJECTION)).toBe(PROJECTION_V1);
    expect(await inspectTemplateTransactionMarker(item.vault)).toMatchObject({ admission: "blocked", state: "in-progress" });
    await untouched(item.vault);
  });

  it("keeps completed marker admission separate from managed draft freshness", async () => {
    const item = await fixture();
    const manifest = publication();
    expect((await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("applied");
    await writeFile(path.join(item.vault, DRAFT), "user edited draft");
    expect(await inspectTemplateTransactionMarker(item.vault)).toMatchObject({ admission: "clear", state: "complete" });
    expect((await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("inconsistent");
    expect(await text(item.vault, DRAFT)).toBe("user edited draft");
  });

  it.each([
    ["note", DRAFT],
    ["default", DRAFT],
    [null, ".oms/templates/note.md"],
  ] as const)("rejects mismatched draft identity %s at %s", async (id, location) => {
    const item = await fixture();
    const manifest = publication({ drafts: [draft(null, DRAFT_V2, "write", id as TemplateId | null, location as ManagedTemplatePath)] });
    expect((await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("rejected");
    expect(await text(item.vault, POLICY)).toBe(POLICY_V1);
    expect(await inspectTemplateTransactionMarker(item.vault)).toEqual({ admission: "clear", state: "absent", marker: null });
    await untouched(item.vault);
  });

  it("rechecks outputs before returning already-complete", async () => {
    const item = await fixture();
    const manifest = publication();
    expect((await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("applied");
    const afterApply = events(item).length;
    const again = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
    expect(again).toMatchObject({ status: "already-complete", writtenPaths: [], markerState: "complete", approvalDigest: manifest.approvalDigest });
    expect(events(item)).toHaveLength(afterApply);
    await writeFile(path.join(item.vault, POLICY), "tampered-after-complete");
    const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
    expect(receipt.status).toBe("inconsistent");
    expect(code(receipt)).toBe("TEMPLATE_TRANSACTION_INCONSISTENT");
    expect(await text(item.vault, POLICY)).toBe("tampered-after-complete");
    expect(events(item)).toHaveLength(afterApply);
    await untouched(item.vault);
  });

  it("does not trust the declared current snapshot when the disk still matches expectedCurrent", async () => {
    const item = await fixture();
    const manifest = publication();
    const lying = {
      ...manifest,
      controls: [
        { ...manifest.controls[0]!, current: manifest.controls[0]!.proposed },
        manifest.controls[1]!,
        manifest.controls[2]!,
      ] as TemplateCompositionManifest["controls"],
    };
    const receipt = await executeTemplateTransaction(item.vault, lying, { approvedDigest: lying.approvalDigest });
    expect(receipt.status).toBe("applied");
    expect(await text(item.vault, POLICY)).toBe(POLICY_V2);
    await untouched(item.vault);
  });

  it("does not publish while another live lock owner holds the shared vault lease", async () => {
    const item = await fixture();
    const manifest = publication();
    const lock = path.join(item.vault, VAULT_PUBLICATION_LEASE);
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, token: "live-owner" })}\n`);
    const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
    expect(receipt.status).toBe("rejected");
    expect(code(receipt)).toBe("CONTRACT_TRANSACTION_IN_PROGRESS");
    expect(await text(item.vault, POLICY)).toBe(POLICY_V1);
    expect(await inspectTemplateTransactionMarker(item.vault)).toEqual({ admission: "clear", state: "absent", marker: null });
    await untouched(item.vault);
  });

  it("blocks an invalid marker and admits only a missing marker", async () => {
    const item = await fixture();
    expect(await inspectTemplateTransactionMarker(item.vault)).toEqual({ admission: "clear", state: "absent", marker: null });
    await writeFile(path.join(item.vault, TEMPLATE_TRANSACTION_MARKER_PATH), "{\"status\":\"in-progress\"}\n");
    expect(await inspectTemplateTransactionMarker(item.vault)).toEqual({
      admission: "blocked",
      state: "invalid",
      marker: null,
      failure: {
        reason: "marker-fields-invalid",
        message: "transaction marker is missing a required digest or publication id",
        path: TEMPLATE_TRANSACTION_MARKER_PATH,
      },
    });
    const manifest = publication();
    const before = await text(item.vault, POLICY);
    const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
    expect(receipt.status).toBe("rejected");
    expect(code(receipt)).toBe("CONTRACT_TRANSACTION_IN_PROGRESS");
    expect(await text(item.vault, POLICY)).toBe(before);
    await untouched(item.vault);
  });

  it("reports a bounded reason for each invalid marker or plan class without changing vault bytes", async () => {
    const item = await fixture();
    const manifest = publication();
    expect((await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("applied");
    const markerPath = path.join(item.vault, TEMPLATE_TRANSACTION_MARKER_PATH);
    const stored = JSON.parse(await text(item.vault, TEMPLATE_TRANSACTION_MARKER_PATH)) as {
      status: "complete";
      transactionId: string;
      approvalDigest: Digest;
      outputDigest: Digest;
      planDigest: Digest;
      checksum: Digest;
    };
    const planPath = `.oms/.template-transactions/${stored.transactionId}/plan.json`;
    const planText = await text(item.vault, planPath);
    const before = await files(item.vault);
    const cases: ReadonlyArray<readonly [string, () => Promise<void>, TemplateTransactionFailure]> = [
      ["malformed-json", async () => { await writeFile(markerPath, "{"); }, {
        reason: "marker-malformed",
        message: "transaction marker is not valid JSON",
        path: TEMPLATE_TRANSACTION_MARKER_PATH,
      }],
      ["non-object", async () => { await writeFile(markerPath, "[]\n"); }, {
        reason: "marker-malformed",
        message: "transaction marker is not a JSON object",
        path: TEMPLATE_TRANSACTION_MARKER_PATH,
      }],
      ["missing-fields", async () => { await writeFile(markerPath, `${JSON.stringify({ status: "complete" })}\n`); }, {
        reason: "marker-fields-invalid",
        message: "transaction marker is missing a required digest or publication id",
        path: TEMPLATE_TRANSACTION_MARKER_PATH,
      }],
      ["checksum", async () => {
        await writeFile(markerPath, `${JSON.stringify({ ...stored, checksum: digestBytes("not-the-marker") })}\n`);
      }, {
        reason: "marker-checksum-mismatch",
        message: "transaction marker checksum does not match its fields",
        path: TEMPLATE_TRANSACTION_MARKER_PATH,
      }],
      ["missing-plan", async () => { await rm(path.join(item.vault, planPath)); }, {
        reason: "plan-missing",
        message: "durable plan is missing",
        path: planPath,
      }],
      ["invalid-plan", async () => { await writeFile(path.join(item.vault, planPath), "{}\n"); }, {
        reason: "plan-invalid",
        message: "durable plan shape is not version 1",
        path: planPath,
      }],
      ["unreadable-plan", async () => {
        await rm(path.join(item.vault, planPath));
        await mkdir(path.join(item.vault, planPath));
      }, {
        reason: "control-unreadable",
        message: "template control path is not a readable regular file",
        path: planPath,
      }],
    ];
    for (const [name, mutate, failure] of cases) {
      await writeFile(markerPath, `${JSON.stringify(stored)}\n`);
      await mkdir(path.dirname(path.join(item.vault, planPath)), { recursive: true });
      await writeFile(path.join(item.vault, planPath), planText);
      await mutate();
      const inspection = await inspectTemplateTransactionMarker(item.vault);
      expect(inspection, name).toMatchObject({ admission: "blocked", state: "invalid", marker: null, failure });
      expect(inspection.failure?.message, name).not.toMatch(/\/Users\/|injected|sha256:[0-9a-f]{64}/);
      // The bounded reason is the same one a reader observes, and it never
      // instructs a resume for a marker that cannot be trusted.
      expect(inspection.failure, name).toMatchObject({ reason: failure.reason, message: failure.message, path: failure.path });
      expect(inspection.failure?.message, name).not.toMatch(/^resume/);
      await expect(loadResolvedTemplates(item.vault), name).rejects.toThrow(
        `CONTRACT_TRANSACTION_IN_PROGRESS: transaction marker is invalid: ${failure.message} (${failure.reason}; ${failure.path})`,
      );
    }
    await rm(path.join(item.vault, planPath), { recursive: true, force: true });
    await writeFile(markerPath, `${JSON.stringify(stored)}\n`);
    await writeFile(path.join(item.vault, planPath), planText);
    expect(await files(item.vault)).toEqual(before);
    expect((await inspectTemplateTransactionMarker(item.vault)).state).toBe("complete");
    const progressMaterial = {
      status: "in-progress" as const,
      transactionId: stored.transactionId,
      approvalDigest: stored.approvalDigest,
      outputDigest: stored.outputDigest,
      planDigest: stored.planDigest,
    };
    await writeFile(markerPath, `${JSON.stringify({ ...progressMaterial, checksum: hashCanonical("oms.contract-publish.marker.v1", progressMaterial) })}\n`);
    const open = await inspectTemplateTransactionMarker(item.vault);
    expect(open).toMatchObject({ admission: "blocked", state: "in-progress" });
    expect(open.failure).toBeUndefined();
    const openDiagnosis = await inspectTemplateTransactionMarker(item.vault);
    expect(openDiagnosis.state).toBe("in-progress");
    expect(openDiagnosis.failure).toBeUndefined();
    await expect(loadResolvedTemplates(item.vault)).rejects.toThrow("CONTRACT_TRANSACTION_IN_PROGRESS: template transaction is in progress");
    await writeFile(markerPath, `${JSON.stringify(stored)}\n`);
    await untouched(item.vault);
  });

  it("does not treat unsupported policy version 3 as marker corruption", async () => {
    const item = await fixture();
    const v3 = `${JSON.stringify({ version: 3, properties: {}, templates: {} })}\n`;
    await writeFile(path.join(item.vault, POLICY), v3);
    await expect(loadResolvedTemplates(item.vault)).rejects.toThrow(/TEMPLATE_POLICY_VERSION_UNSUPPORTED: version 3 is unsupported/);
    const search = await readSearchTemplateSource(item.vault);
    // A historical policy declares no V5 contract, so retrieval reports the
    // unavailability instead of inventing field axes.
    expect(search.source.templates).toBeNull();
    expect(search.diagnostics.map(item => item.code)).toContain("CONTRACT_VERSION_UNSUPPORTED");
    expect(search.diagnostics.map(entry => `${entry.code}: ${entry.message}`).join("\n")).not.toMatch(/marker|transaction/);
    expect(() => parseTemplatePolicy(v3)).toThrow(/TEMPLATE_POLICY_VERSION_UNSUPPORTED/);

    const manifest = publication({ policy: [v3, POLICY_V2, "write"] });
    expect((await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("applied");
    await writeFile(path.join(item.vault, TEMPLATE_TRANSACTION_MARKER_PATH), "{\"status\":\"complete\"}\n");
    await writeFile(path.join(item.vault, POLICY), v3);
    const inspection = await inspectTemplateTransactionMarker(item.vault);
    expect(inspection.failure?.reason).toBe("marker-fields-invalid" satisfies TemplateTransactionFailureReason);
    expect(inspection.failure?.message).not.toMatch(/version 3|TEMPLATE_POLICY/);
    await expect(loadResolvedTemplates(item.vault)).rejects.toThrow(/transaction marker is invalid: .*marker-fields-invalid/);
    const masked = await readSearchTemplateSource(item.vault);
    expect(masked.source.templates).toBeNull();
    const maskedReasons = masked.diagnostics.map(entry => `${entry.code}: ${entry.message}`).join("\n");
    expect(maskedReasons).toMatch(/CONTRACT_VERSION_UNSUPPORTED/);
    expect(maskedReasons).not.toMatch(/marker-fields-invalid/);
    await untouched(item.vault);
  });

  it("reports symlink controls and inaccessible vaults without marker-byte remediation", async () => {
    const item = await fixture();
    const manifest = publication();
    expect((await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("applied");
    const markerPath = path.join(item.vault, TEMPLATE_TRANSACTION_MARKER_PATH);
    const stored = JSON.parse(await text(item.vault, TEMPLATE_TRANSACTION_MARKER_PATH)) as { transactionId: string };
    const planPath = `.oms/.template-transactions/${stored.transactionId}/plan.json`;
    const markerText = await text(item.vault, TEMPLATE_TRANSACTION_MARKER_PATH);
    const planText = await text(item.vault, planPath);
    const unsafe = {
      reason: "control-unreadable",
      message: "template control path is unsafe or a symlink inside the approved marker and plan namespace",
    };
    await rm(markerPath);
    await symlink(path.join(item.root, "marker-target.json"), markerPath);
    await writeFile(path.join(item.root, "marker-target.json"), markerText);
    const markerLink = await inspectTemplateTransactionMarker(item.vault);
    expect(markerLink).toMatchObject({ admission: "blocked", state: "invalid", failure: { ...unsafe, path: TEMPLATE_TRANSACTION_MARKER_PATH } });
    expect(markerLink.failure?.message).not.toMatch(/outside the approved/);
    await rm(markerPath);
    await writeFile(markerPath, markerText);
    await rm(path.join(item.vault, planPath));
    await symlink(path.join(item.root, "plan-target.json"), path.join(item.vault, planPath));
    await writeFile(path.join(item.root, "plan-target.json"), planText);
    const planLink = await inspectTemplateTransactionMarker(item.vault);
    expect(planLink).toMatchObject({ admission: "blocked", state: "invalid", failure: { ...unsafe, path: planPath } });
    const linkDiagnosis = await inspectTemplateTransactionMarker(item.vault);
    expect(linkDiagnosis.failure?.message ?? "").not.toMatch(/restore access to the vault path/);
    await rm(path.join(item.vault, planPath));
    await writeFile(path.join(item.vault, planPath), planText);

    const missing = path.join(item.root, "missing-vault");
    const missingInspection = await inspectTemplateTransactionMarker(missing);
    expect(missingInspection.failure).toMatchObject({ reason: "vault-inaccessible", message: "vault path is missing or not accessible" });
    const missingDiagnosis = await inspectTemplateTransactionMarker(missing);
    expect(missingDiagnosis.failure?.message).toBe("vault path is missing or not accessible");
    // The resolver resolves the vault root before marker inspection.
    await expect(loadResolvedTemplates(missing)).rejects.toMatchObject({ code: "ENOENT" });

    injectedFault.operation = "realpath";
    injectedFault.suffix = item.vault;
    injectedFault.code = "EACCES";
    injectedFault.armed = true;
    const deniedInspection = await inspectTemplateTransactionMarker(item.vault);
    expect(deniedInspection.failure?.reason).toBe("vault-inaccessible");
    expect(deniedInspection.failure?.message).not.toMatch(item.vault);
    expect(deniedInspection.failure?.message).toBe("vault or template control path is not accessible");
    expect(deniedInspection.failure?.reason).toBe("vault-inaccessible");
    injectedFault.armed = false;
    await untouched(item.vault);
  });

  it("keeps a valid complete marker clear when policy bytes later become version 3", async () => {
    const item = await fixture();
    const manifest = publication();
    expect((await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest })).status).toBe("applied");
    const v3 = `${JSON.stringify({ version: 3, properties: {}, templates: {} })}\n`;
    await writeFile(path.join(item.vault, POLICY), v3);
    const inspection = await inspectTemplateTransactionMarker(item.vault);
    expect(inspection).toMatchObject({ admission: "clear", state: "complete" });
    expect(inspection.failure).toBeUndefined();
    await expect(loadResolvedTemplates(item.vault)).rejects.toThrow(/TEMPLATE_POLICY_VERSION_UNSUPPORTED: version 3 is unsupported/);
    const search = await readSearchTemplateSource(item.vault);
    // A historical policy declares no V5 contract, so retrieval reports the
    // unavailability instead of inventing field axes.
    expect(search.source.templates).toBeNull();
    expect(search.diagnostics.map(item => item.code)).toContain("CONTRACT_VERSION_UNSUPPORTED");
    expect(search.diagnostics.map(entry => `${entry.code}: ${entry.message}`).join("\n")).not.toMatch(/marker|transaction/);
    await untouched(item.vault);
  });

  it("keeps an applied publication when the external journal append fails", async () => {
    const item = await fixture();
    const manifest = publication();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const append = vi.spyOn(eventJournal, "appendRuntimeEvent").mockImplementation(() => {
      throw new Error("LEDGER_APPEND_FAILED: injected");
    });
    try {
      const receipt = await executeTemplateTransaction(item.vault, manifest, { approvedDigest: manifest.approvalDigest });
      expect(receipt.status).toBe("applied");
      expect(await text(item.vault, POLICY)).toBe(POLICY_V2);
      expect(warning).toHaveBeenCalled();
      expect(append).toHaveBeenCalled();
    } finally {
      append.mockRestore();
      warning.mockRestore();
    }
    await untouched(item.vault);
  });
});
