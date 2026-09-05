import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { admitWriteTarget } from "../capture/safe.js";
import type { WriteTargetSource } from "../conventions/write-protocol.js";
import { inputDigest, templateInput } from "./canonical.js";
import { deriveTemplateSourcePath, normalizeTemplateControlPath, verifyTemplateControlPath, verifyTemplateSourcePath, verifyVaultPath } from "./paths.js";
import { parseTemplatePolicy } from "./policy.js";
import { buildTemplateCompositionManifest } from "./resolver.js";
import { executeTemplateTransaction, TEMPLATE_MUTATION_MARKER_PATH, templateMigrationAdmission } from "./transaction.js";
import type { Digest, FileExpectation, GuardedTemplateRequest, TemplateSemanticChange, TemplateSourcePath, TemplateTransactionReceipt, VerifiedFileState } from "./types.js";

export interface TemplateOperationTarget {
  readonly vault: string;
  readonly source: WriteTargetSource;
}

const MAX_TEMPLATE_BYTES = 262_144;

function digest(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Digest;
}

async function state(path: string, maxBytes?: number): Promise<VerifiedFileState> {
  try {
    const bytes = new Uint8Array(await readFile(path));
    if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
      throw new Error(`TEMPLATE_PROPOSAL_OVERSIZE: template source exceeds ${maxBytes} bytes`);
    }
    return { state: "present", bytes, signature: digest(bytes) };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { state: "absent" };
    throw error;
  }
}

async function controlState(vault: string, path: ".oms/template-policy.json" | ".oms/taxonomy.json" | ".oms/types.json", required: boolean): Promise<VerifiedFileState> {
  const verified = await verifyTemplateControlPath(vault, normalizeTemplateControlPath(path), { expected: required ? "existing-file" : "either" });
  return verified.targetRealPath === null ? { state: "absent" } : state(verified.absolutePath);
}

async function obsidianTypesState(vault: string): Promise<VerifiedFileState> {
  const path = ".obsidian/types.json" as TemplateSourcePath;
  const verified = await verifyVaultPath(vault, path, { expected: "existing-file" });
  return state(verified.absolutePath);
}

async function sourceState(vault: string, path: TemplateSourcePath): Promise<VerifiedFileState> {
  const verified = await verifyTemplateSourcePath(vault, path, { expected: "either" });
  return verified.targetRealPath === null ? { state: "absent" } : state(verified.absolutePath, MAX_TEMPLATE_BYTES);
}

function expectation(value: VerifiedFileState): FileExpectation {
  return value.state === "present" ? { state: "present", signature: value.signature } : { state: "absent" };
}

/** Composes and executes one guarded template operation from current server-observed CAS state. */
export async function executeTemplateOperation(
  target: TemplateOperationTarget,
  change: TemplateSemanticChange,
  request: GuardedTemplateRequest,
): Promise<TemplateTransactionReceipt> {
  if (
    request === null ||
    typeof request !== "object" ||
    (request.dryRun === true
      ? request.approvedDigest !== undefined
      : typeof request.approvedDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(request.approvedDigest))
  ) {
    throw new TypeError("Template operation requires dryRun:true or an exact approvedDigest");
  }
  const admission = await admitWriteTarget(target);
  if (admission !== undefined) throw new Error(`${admission.code}: ${admission.remediation}`);
  const vault = resolve(target.vault);
  if (await templateMigrationAdmission(vault) !== "clear") {
    throw new Error("migration-incomplete: resume or repair the validated template migration transaction");
  }

  const [policyState, taxonomyState, projectionState, obsidianState] = await Promise.all([
    controlState(vault, ".oms/template-policy.json", true),
    controlState(vault, ".oms/taxonomy.json", true),
    controlState(vault, ".oms/types.json", false),
    obsidianTypesState(vault),
  ]);
  if (policyState.state === "absent" || taxonomyState.state === "absent" || obsidianState.state === "absent") {
    throw new Error("TEMPLATE_CONTROL_MISSING: template policy, taxonomy, and Obsidian types must exist");
  }
  const policy = parseTemplatePolicy(new TextDecoder().decode(policyState.bytes));
  const sources = await Promise.all(Object.values(policy.templates).map(async binding => {
    const path = deriveTemplateSourcePath(binding);
    return { templateId: binding.templateId, path, state: await sourceState(vault, path) };
  }));
  if ((change.mode === "create" || change.mode === "update") && change.source.bytes.byteLength > MAX_TEMPLATE_BYTES) {
    throw new Error(`TEMPLATE_PROPOSAL_OVERSIZE: ${change.source.path} exceeds ${MAX_TEMPLATE_BYTES} bytes`);
  }
  const proposedPathState = change.mode === "create" || change.mode === "update"
    ? await sourceState(vault, change.source.path)
    : undefined;
  const movedSource = change.mode === "update" && change.moveStrategy === "register-already-moved"
    ? proposedPathState
    : undefined;
  const signatures = new Map(sources.flatMap(source => source.state.state === "present" ? [[source.templateId, source.state.signature] as const] : []));
  const currentInput = templateInput(
    policy,
    { policy: policyState.signature, taxonomy: taxonomyState.signature, obsidianTypes: obsidianState.signature, obsidianTypesPath: ".obsidian/types.json" },
    Object.values(policy.templates),
    binding => {
      const signature = signatures.get(binding.templateId);
      if (
        signature === undefined &&
        change.mode === "update" &&
        change.moveStrategy === "register-already-moved" &&
        change.templateId === binding.templateId &&
        movedSource?.state === "present"
      ) return movedSource.signature;
      if (signature === undefined) throw new Error(`TEMPLATE_SOURCE_INVALID: registered template source (${deriveTemplateSourcePath(binding)}) is missing`);
      return signature;
    },
  );
  const manifest = await buildTemplateCompositionManifest(vault, change, {
    expected: {
      input: inputDigest(currentInput),
      controls: { policy: expectation(policyState), taxonomy: expectation(taxonomyState), projection: expectation(projectionState) },
      sources: sources.map(source => ({ templateId: source.templateId, path: source.path, expected: expectation(source.state) })),
    },
    taxonomy: { expectedCurrent: expectation(taxonomyState), proposedBytes: taxonomyState.bytes, action: "verify-only" },
  });
  return executeTemplateTransaction(vault, manifest, request, TEMPLATE_MUTATION_MARKER_PATH);
}
