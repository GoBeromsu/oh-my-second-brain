import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { inputDigest, templateInput } from "./canonical.js";
import { deriveTemplateSourcePath, isTemplateSourceInFolder, normalizeTemplateFolderPath, normalizeTemplateSourcePath, selectTemplateFolder, validateTemplateId, verifyTemplateSourcePath } from "./paths.js";
import { parseTemplatePolicy } from "./policy.js";
import { classifyTemplateRenderer } from "./renderer.js";
import { buildTemplateCompositionManifest } from "./resolver.js";
import { completedTemplateTransaction, executeTemplateTransaction, TEMPLATE_MUTATION_MARKER_PATH } from "./transaction.js";
import type { Digest, FileExpectation, GuardedTemplateRequest, TemplateBinding, TemplatePolicy, TemplateRenderer, TemplateSourcePath, TemplateTransactionReceipt, VerifiedFileState } from "./types.js";

export interface RegisterExistingTemplateRequest {
  readonly templateId: string;
  readonly sourceFolder: string;
  readonly sourcePath: string;
  readonly renderer: TemplateRenderer;
  readonly filledBy: readonly string[];
  readonly contract: string;
  readonly naming: string;
}

function digest(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Digest;
}

async function state(path: string): Promise<VerifiedFileState> {
  try {
    const bytes = new Uint8Array(await readFile(path));
    return { state: "present", bytes, signature: digest(bytes) };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { state: "absent" };
    throw error;
  }
}

function expectation(value: VerifiedFileState): FileExpectation {
  return value.state === "present" ? { state: "present", signature: value.signature } : { state: "absent" };
}

function registrationInput(
  policy: TemplatePolicy,
  policyState: Extract<VerifiedFileState, { readonly state: "present" }>,
  taxonomyState: Extract<VerifiedFileState, { readonly state: "present" }>,
  obsidianState: Extract<VerifiedFileState, { readonly state: "present" }>,
  sources: readonly { readonly templateId: string; readonly path: TemplateSourcePath; readonly state: VerifiedFileState }[],
): ReturnType<typeof templateInput> {
  const digests = new Map<string, Digest>();
  for (const source of sources) {
    if (source.state.state === "absent") throw new Error(`TEMPLATE_SOURCE_INVALID: registered template source (${source.path}) is missing`);
    digests.set(source.templateId, source.state.signature);
  }
  const bindings = Object.values(policy.templates);
  return templateInput(
    policy,
    { policy: policyState.signature, taxonomy: taxonomyState.signature, obsidianTypes: obsidianState.signature, obsidianTypesPath: ".obsidian/types.json" },
    bindings,
    (binding) => {
      const value = digests.get(binding.templateId);
      if (value === undefined) throw new Error(`TEMPLATE_SOURCE_INVALID: registered template source (${binding.sourcePath}) is missing`);
      return value;
    },
  );
}

/** Registers a user-owned template in place; only OMS control files are published. */
export async function registerExistingTemplate(vault: string, request: RegisterExistingTemplateRequest, guard: GuardedTemplateRequest): Promise<TemplateTransactionReceipt> {
  const templateId = validateTemplateId(request.templateId);
  const sourceFolder = normalizeTemplateFolderPath(request.sourceFolder);
  const sourcePath = normalizeTemplateSourcePath(request.sourcePath);
  const source = await verifyTemplateSourcePath(vault, sourcePath);
  const sourceState = await state(source.absolutePath);
  if (sourceState.state === "absent") throw new Error(`TEMPLATE_SOURCE_INVALID: registered template source (${sourcePath}) is missing`);
  const classification = classifyTemplateRenderer(sourcePath, sourceState.bytes);
  if (classification.renderer !== request.renderer) {
    throw new Error(`TEMPLATE_SOURCE_INVALID: requested renderer ${request.renderer} does not match observed renderer ${classification.renderer}`);
  }
  if (
    request.filledBy.length !== classification.filledBy.length ||
    request.filledBy.some((field, index) => field !== classification.filledBy[index])
  ) {
    throw new Error("TEMPLATE_SOURCE_INVALID: requested filledBy fields do not match observed template fields");
  }
  const blockingClassification = classification.diagnostics.find(diagnostic =>
    diagnostic.code !== "TEMPLATE_RENDERER_EXTERNAL" &&
    diagnostic.code !== "FIELD_FILLED_BY_OBSIDIAN" &&
    !(diagnostic.code === "TEMPLATE_CONTRACT_UNOBSERVED" && classification.renderer === "none")
  );
  if (blockingClassification !== undefined) {
    throw new Error(`${blockingClassification.code}: registered template source (${sourcePath}) could not be classified`);
  }

  const [policyState, taxonomyState, projectionState, obsidianState] = await Promise.all([
    state(join(vault, ".oms/template-policy.json")), state(join(vault, ".oms/taxonomy.json")),
    state(join(vault, ".oms/types.json")), state(join(vault, ".obsidian/types.json")),
  ]);
  if (policyState.state === "absent" || taxonomyState.state === "absent" || obsidianState.state === "absent") {
    throw new Error("TEMPLATE_SOURCE_INVALID: template policy, taxonomy, and Obsidian types must exist");
  }
  const policy = parseTemplatePolicy(new TextDecoder().decode(policyState.bytes));
  selectTemplateFolder(policy.templateFolders, sourceFolder);
  if (!isTemplateSourceInFolder(sourcePath, sourceFolder)) {
    throw new Error(`TEMPLATE_SOURCE_INVALID: registered source ${sourcePath} must be within ${sourceFolder}`);
  }
  if (policy.contracts[request.contract] === undefined) {
    throw new Error(`TEMPLATE_CONTRACT_UNKNOWN: contract ${request.contract} does not exist; author it in .oms/template-policy.json first`);
  }
  const bound = policy.templates[templateId];
  if (bound !== undefined) {
    // Registration is one-shot. Separating "already in the requested state" from
    // "bound to something else" is what makes a replayed apply actionable: the
    // first needs no work, the second is a real identity collision.
    const identical = bound.destinationClass === "registered-existing" && bound.renderer === request.renderer && bound.sourceFolder === sourceFolder && deriveTemplateSourcePath(bound) === sourcePath && bound.contract === request.contract && bound.naming === request.naming;
    if (!identical) throw new Error(`TEMPLATE_ID_DUPLICATE: templateId ${templateId} is already registered`);
    if (guard.approvedDigest === undefined) {
      throw new Error(`TEMPLATE_ALREADY_REGISTERED: ${templateId} is already registered at ${sourcePath} with this contract and naming; no change is required`);
    }
    const sources = await Promise.all(Object.values(policy.templates).map(async (binding) => ({
      templateId: binding.templateId,
      path: deriveTemplateSourcePath(binding),
      state: await state(join(vault, deriveTemplateSourcePath(binding))),
    })));
    const input = registrationInput(policy, policyState, taxonomyState, obsidianState, sources);
    const completed = await completedTemplateTransaction(vault, guard.approvedDigest, {
      inputDigest: inputDigest(input),
      outputs: [
        { finalVaultRelativePath: ".oms/template-policy.json" },
        { finalVaultRelativePath: ".oms/taxonomy.json" },
        { finalVaultRelativePath: ".oms/types.json" },
        ...sources.map((item) => ({ finalVaultRelativePath: item.path })),
      ],
    }, TEMPLATE_MUTATION_MARKER_PATH);
    if (completed !== null) {
      return {
        status: "already-complete",
        mode: "create",
        transactionId: completed.transactionId,
        currentInputDigest: completed.inputDigest,
        inputDigest: completed.inputDigest,
        approvedDigest: completed.approvalDigest,
        outputDigest: completed.outputDigest,
        operations: [{ kind: "create", templateId, destinationClass: bound.destinationClass, payloadDigest: sourceState.signature, stableRelativeSuffix: null }],
        moves: [],
        writtenPaths: [],
        deletedPaths: [],
        verified: completed.verified,
        markerState: "complete",
      };
    }
    throw new Error("TEMPLATE_TRANSACTION_REPLAY_MISMATCH: completed registration does not match current controls and registered sources; request a new dry-run");
  }
  const sources = await Promise.all(Object.values(policy.templates).map(async binding => ({ templateId: binding.templateId, path: deriveTemplateSourcePath(binding), state: await state(join(vault, deriveTemplateSourcePath(binding))) })));
  const input = registrationInput(policy, policyState, taxonomyState, obsidianState, sources);
  const binding: TemplateBinding = { templateId, destinationClass: "registered-existing", renderer: request.renderer, sourceFolder, sourcePath, contract: request.contract, naming: request.naming };
  const manifest = await buildTemplateCompositionManifest(vault, { mode: "create", binding, source: { path: sourcePath, bytes: sourceState.bytes, publication: "verify-existing" } }, {
    expected: {
      input: inputDigest(input),
      controls: { policy: expectation(policyState), taxonomy: expectation(taxonomyState), projection: expectation(projectionState) },
      sources: sources.map(source => ({ templateId: source.templateId as TemplateBinding["templateId"], path: source.path, expected: expectation(source.state) })),
    },
    taxonomy: { expectedCurrent: expectation(taxonomyState), proposedBytes: taxonomyState.bytes, action: "verify-only" },
  });
  return executeTemplateTransaction(vault, manifest, guard, TEMPLATE_MUTATION_MARKER_PATH);
}
