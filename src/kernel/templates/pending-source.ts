import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { admitWriteTarget } from "../capture/safe.js";
import { approvalDigest, inputDigest, outputDigest, parseDigest, templateInput } from "./canonical.js";
import { proposedTemplateId } from "./census.js";
import type { TemplateOperationTarget } from "./operations.js";
import { deriveTemplateSourcePath, normalizeTemplateSourcePath, validateTemplateId, verifyTemplateSourcePath } from "./paths.js";
import { readTemplateReviewContext } from "./review-context.js";
import { resolveClassifiedTemplateSource, sourceSignature } from "./resolver.js";
import { executeTemplateTransaction, TEMPLATE_MUTATION_MARKER_PATH, templateMigrationAdmission } from "./transaction.js";
import type {
  Digest,
  GuardedTemplateRequest,
  InputV2,
  LogicalOperation,
  SourceDescriptor,
  SourceTransition,
  TemplateCompositionManifest,
  TemplateId,
  TemplateRenderer,
  TemplateSemanticSnapshot,
  TemplateTransactionReceipt,
  VerifiedFileState,
} from "./types.js";

export interface PendingTemplateSourceRepair {
  readonly templateId: string;
  readonly sourcePath: string;
  readonly expectedSourceDigest: Digest;
  readonly renderer: TemplateRenderer;
  readonly bytes: Uint8Array;
}

function digest(value: Uint8Array): Digest {
  return parseDigest(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

function requiredSourceDigest(sourceDigests: ReadonlyMap<TemplateId, Digest>, templateId: TemplateId): Digest {
  const value = sourceDigests.get(templateId);
  if (value === undefined) throw new Error(`TEMPLATE_SOURCE_INVALID: registered source is missing for ${templateId}`);
  return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

async function requiredFile(root: string, path: string): Promise<Extract<VerifiedFileState, { readonly state: "present" }>> {
  const bytes = new Uint8Array(await readFile(join(root, path)));
  return { state: "present", bytes, signature: digest(bytes) };
}

function snapshot(
  input: InputV2,
  bindings: TemplateSemanticSnapshot["bindings"],
  sourceDigests: ReadonlyMap<TemplateId, Digest>,
  resolvedInputSignature: Digest,
): TemplateSemanticSnapshot {
  return {
    input,
    inputDigest: inputDigest(input),
    bindings,
    resolvedTemplates: bindings.map(binding => ({
      templateId: binding.templateId,
      sourcePath: deriveTemplateSourcePath(binding),
      inputSignature: resolvedInputSignature,
      templateSignature: requiredSourceDigest(sourceDigests, binding.templateId),
    })),
  };
}

/**
 * Replaces one unbound selected-folder source under exact source-digest and
 * approval-digest CAS. Contract controls and unrelated source bytes are
 * verified but never rewritten; adoption remains a separate review step.
 */
export async function repairPendingTemplateSource(
  target: TemplateOperationTarget,
  requested: PendingTemplateSourceRepair,
  request: GuardedTemplateRequest,
): Promise<TemplateTransactionReceipt> {
  const admission = await admitWriteTarget(target);
  if (admission !== undefined) throw new Error(`${admission.code}: ${admission.remediation}`);
  const root = resolve(target.vault);
  if (await templateMigrationAdmission(root) !== "clear") {
    throw new Error("migration-incomplete: resume or repair the validated template migration transaction");
  }

  const templateId = validateTemplateId(requested.templateId);
  const sourcePath = normalizeTemplateSourcePath(requested.sourcePath);
  const verified = await verifyTemplateSourcePath(root, sourcePath, { expected: "existing-file" });
  if (verified.targetRealPath === null) throw new Error(`TEMPLATE_NOT_FOUND: pending source ${sourcePath}`);

  const context = await readTemplateReviewContext(root);
  const entry = context.census.entries.find(candidate => candidate.sourcePath === sourcePath);
  if (entry === undefined) throw new Error(`TEMPLATE_NOT_FOUND: pending source ${sourcePath} is outside the selected census`);
  const observedId = entry.templateId ?? proposedTemplateId(sourcePath);
  if (observedId !== templateId) {
    throw new Error(`TEMPLATE_IDENTITY_IMMUTABLE: pending source ${sourcePath} resolves to ${observedId ?? "no stable id"}`);
  }
  if (
    context.policy.templates[templateId] !== undefined
    || Object.values(context.policy.templates).some(binding => deriveTemplateSourcePath(binding) === sourcePath)
  ) {
    throw new Error(`TEMPLATE_ALREADY_REGISTERED: ${templateId} must use the registered template update path`);
  }
  const pending = context.census.diffs.some(diff =>
    diff.kind !== "deleted"
    && (diff.templateId === templateId || diff.sourcePath === sourcePath || diff.newSourcePath === sourcePath),
  );
  if (!pending) throw new Error(`TEMPLATE_NOT_FOUND: ${sourcePath} is not a pending source`);
  if (entry.signature !== requested.expectedSourceDigest) {
    throw new Error(`TEMPLATE_SOURCE_DRIFT: ${sourcePath} expected ${requested.expectedSourceDigest} but found ${entry.signature}`);
  }

  const proposedBytes = new Uint8Array(requested.bytes);
  resolveClassifiedTemplateSource(sourcePath, proposedBytes, requested.renderer);
  const proposedDigest = digest(proposedBytes);
  const controls = await Promise.all([
    requiredFile(root, ".oms/template-policy.json"),
    requiredFile(root, ".oms/taxonomy.json"),
    requiredFile(root, ".oms/types.json"),
    requiredFile(root, ".obsidian/types.json"),
  ]);
  const [policyState, taxonomyState, projectionState, obsidianState] = controls;
  const bindings = Object.values(context.policy.templates).sort((left, right) => left.templateId.localeCompare(right.templateId));
  const sourceDigests = new Map<TemplateId, Digest>();
  for (const binding of bindings) {
    const boundPath = deriveTemplateSourcePath(binding);
    const boundEntry = context.census.entries.find(candidate => candidate.sourcePath === boundPath);
    if (boundEntry === undefined) throw new Error(`TEMPLATE_SOURCE_INVALID: registered source is missing for ${binding.templateId}`);
    sourceDigests.set(binding.templateId, boundEntry.signature);
  }
  const descriptors: SourceDescriptor[] = [
    { logicalId: "template-policy", signature: policyState.signature },
    { logicalId: "taxonomy", signature: taxonomyState.signature },
    { logicalId: "obsidian-types", signature: obsidianState.signature },
    ...bindings.map(binding => ({ path: deriveTemplateSourcePath(binding), signature: requiredSourceDigest(sourceDigests, binding.templateId) })),
  ];
  const resolvedInputSignature = sourceSignature(descriptors);
  const input = templateInput(
    context.policy,
    {
      policy: policyState.signature,
      taxonomy: taxonomyState.signature,
      obsidianTypes: obsidianState.signature,
      obsidianTypesPath: ".obsidian/types.json",
    },
    bindings,
    binding => requiredSourceDigest(sourceDigests, binding.templateId),
  );
  const current = snapshot(input, bindings, sourceDigests, resolvedInputSignature);
  const proposed = snapshot(input, bindings, sourceDigests, resolvedInputSignature);
  const sourceTransition: SourceTransition = {
    templateId,
    path: sourcePath,
    expectedCurrent: { state: "present", signature: requested.expectedSourceDigest },
    current: { state: "present", bytes: new Uint8Array(entry.bytes), signature: entry.signature },
    proposed: { state: "present", bytes: proposedBytes, signature: proposedDigest },
    action: sameBytes(entry.bytes, proposedBytes) ? "verify-only" : "write",
  };
  const controlTransitions: TemplateCompositionManifest["controls"] = [
    { kind: "policy", path: ".oms/template-policy.json", expectedCurrent: { state: "present", signature: policyState.signature }, current: policyState, proposed: policyState, action: "verify-only" },
    { kind: "taxonomy", path: ".oms/taxonomy.json", expectedCurrent: { state: "present", signature: taxonomyState.signature }, current: taxonomyState, proposed: taxonomyState, action: "verify-only" },
    { kind: "projection", path: ".oms/types.json", expectedCurrent: { state: "present", signature: projectionState.signature }, current: projectionState, proposed: projectionState, action: "verify-only" },
  ];
  const operations: readonly LogicalOperation[] = [{
    kind: "update",
    templateId,
    destinationClass: "registered-existing",
    payloadDigest: proposedDigest,
    stableRelativeSuffix: null,
  }];
  const outputs = [
    ...controlTransitions.map(control => ({ finalVaultRelativePath: control.path, payloadDigest: control.proposed.signature })),
    { finalVaultRelativePath: sourcePath, payloadDigest: proposedDigest },
  ];
  const preimage = { current, controls: controlTransitions, sources: [sourceTransition] };
  const manifest: TemplateCompositionManifest = {
    version: 1,
    mode: "update",
    current,
    proposed,
    controls: controlTransitions,
    sources: [sourceTransition],
    operations,
    diagnostics: [],
    moves: [],
    outputs,
    approvalDigest: approvalDigest(proposed.inputDigest, operations, [], preimage),
    outputDigest: outputDigest(outputs),
  };
  return executeTemplateTransaction(root, manifest, request, TEMPLATE_MUTATION_MARKER_PATH);
}
