import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildTemplateInterview } from "./interview.js";
import { parseDerivedProjection, parseTemplatePolicy, serializeDerivedProjection, serializeTemplatePolicy } from "./policy.js";
import { readTemplateReviewContext } from "./review-context.js";
import {
  deriveManagedTemplateProjection,
  sharedAuthoritySignature,
  sourceSignature,
  taxonomyRouting,
  resolveClassifiedTemplateSource,
} from "./resolver.js";
import { deriveTemplateSourcePath, normalizeTemplateSourcePath, verifyTemplateSourcePath } from "./paths.js";
import { approvalDigest, inputDigest, outputDigest } from "./canonical.js";
import type {
  AuthorityEntry,
  ControlPath,
  DerivedProjection,
  Diagnostic,
  Digest,
  FileExpectation,
  InputV2,
  LogicalOperation,
  ResolvedTemplateSourceSignatures,
  SourceDescriptor,
  SourceTransition,
  TemplateBinding,
  TemplateCompositionManifest,
  TemplateId,
  TemplatePolicy,
  TemplateSemanticChange,
  TemplateSourcePath,
  VerifiedFileState,
} from "./types.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const REVIEW_CONTROL_PATHS = [
  ".oms/template-policy.json",
  ".oms/taxonomy.json",
  ".oms/types.json",
  ".obsidian/types.json",
] as const;
type ReviewControlPath = typeof REVIEW_CONTROL_PATHS[number];

function digest(value: Uint8Array | string): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function expectation(value: VerifiedFileState): FileExpectation {
  return value.state === "absent" ? value : { state: "present", signature: value.signature };
}

function expectationMatches(value: VerifiedFileState, expected: FileExpectation): boolean {
  return value.state === expected.state
    && (value.state === "absent" || (expected.state === "present" && value.signature === expected.signature));
}

function censusSourceExpectation(
  census: Awaited<ReturnType<typeof readTemplateReviewContext>>["census"],
  path: TemplateSourcePath,
): FileExpectation | undefined {
  const entry = census.entries.find(value => value.sourcePath === path);
  if (entry !== undefined) return { state: "present", signature: entry.signature };
  const absent = census.diffs.some(diff => (
    (diff.kind === "deleted" && (diff.sourcePath === path || diff.oldSourcePath === path))
    || (diff.kind === "renamed" && diff.oldSourcePath === path)
  ));
  return absent ? { state: "absent" } : undefined;
}

function assertReviewedSnapshot(
  context: Awaited<ReturnType<typeof readTemplateReviewContext>>,
  controls: Readonly<Record<ReviewControlPath, VerifiedFileState>>,
  paths: readonly TemplateSourcePath[],
  sources: ReadonlyMap<string, VerifiedFileState>,
): void {
  for (const path of REVIEW_CONTROL_PATHS) {
    const expected = context.authorityStates[path];
    const current = controls[path];
    if (expected === undefined || current === undefined || !expectationMatches(current, expected)) {
      fail("TEMPLATE_RECONCILE_STALE", `${path} changed since the interview snapshot`);
    }
  }
  for (const path of paths) {
    const expected = censusSourceExpectation(context.census, path);
    const current = sources.get(path);
    if (expected === undefined || current === undefined || !expectationMatches(current, expected)) {
      fail("TEMPLATE_RECONCILE_STALE", `${path} changed since the interview snapshot`);
    }
  }
}

function sameDiagnostics(
  left: readonly { readonly code: string; readonly message: string; readonly path?: string; readonly templateId?: string }[],
  right: readonly { readonly code: string; readonly message: string; readonly path?: string; readonly templateId?: string }[],
): boolean {
  return left.length === right.length && left.every((value, index) => {
    const other = right[index];
    return other !== undefined
      && value.code === other.code
      && value.message === other.message
      && value.path === other.path
      && value.templateId === other.templateId;
  });
}

function sameCensusSnapshot(
  left: Awaited<ReturnType<typeof readTemplateReviewContext>>["census"],
  right: Awaited<ReturnType<typeof readTemplateReviewContext>>["census"],
): boolean {
  if (left.entries.length !== right.entries.length || left.diffs.length !== right.diffs.length || left.diagnostics.length !== right.diagnostics.length) {
    return false;
  }
  if (!left.entries.every((entry, index) => {
    const other = right.entries[index];
    return other !== undefined
      && entry.sourcePath === other.sourcePath
      && entry.signature === other.signature
      && entry.templateId === other.templateId
      && sameDiagnostics(entry.diagnostics, other.diagnostics);
  })) return false;
  if (!left.diffs.every((diff, index) => {
    const other = right.diffs[index];
    return other !== undefined
      && diff.kind === other.kind
      && diff.sourcePath === other.sourcePath
      && diff.oldSourcePath === other.oldSourcePath
      && diff.newSourcePath === other.newSourcePath
      && diff.templateId === other.templateId
      && diff.automatic === other.automatic
      && diff.confirmationRequired === other.confirmationRequired
      && diff.strategy === other.strategy;
  })) return false;
  return sameDiagnostics(left.diagnostics, right.diagnostics) && left.digest === right.digest;
}

function sameAuthoritySnapshot(
  left: Awaited<ReturnType<typeof readTemplateReviewContext>>["authorityStates"],
  right: Awaited<ReturnType<typeof readTemplateReviewContext>>["authorityStates"],
): boolean {
  return REVIEW_CONTROL_PATHS.every(path => {
    const expected = left[path];
    const current = right[path];
    return expected.state === current.state
      && (expected.state === "absent" || (current.state === "present" && expected.signature === current.signature));
  });
}

function assertReviewedReviewSnapshot(
  expected: Awaited<ReturnType<typeof readTemplateReviewContext>>,
  current: Awaited<ReturnType<typeof readTemplateReviewContext>>,
): void {
  if (!sameAuthoritySnapshot(expected.authorityStates, current.authorityStates)) {
    fail("TEMPLATE_RECONCILE_STALE", "review authorities changed since the interview snapshot");
  }
  if (
    !sameCensusSnapshot(expected.census, current.census)
    || expected.censusDigest !== current.censusDigest
    || expected.projectionUsable !== current.projectionUsable
    || !sameIds(expected.freshTemplateIds, current.freshTemplateIds)
  ) {
    fail("TEMPLATE_RECONCILE_STALE", "selected template census changed since the interview snapshot");
  }
}

async function readFileState(vault: string, relativePath: string): Promise<VerifiedFileState> {
  try {
    const bytes = new Uint8Array(await readFile(resolve(vault, relativePath)));
    return { state: "present", bytes, signature: digest(bytes) };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { state: "absent" };
    throw error;
  }
}

async function readSourceState(vault: string, sourcePath: TemplateSourcePath): Promise<VerifiedFileState> {
  const verified = await verifyTemplateSourcePath(vault, sourcePath, { expected: "either" });
  if (verified.targetRealPath === null) return { state: "absent" };
  return readFileState(vault, sourcePath);
}

function staleRead(path: string, error: unknown): never {
  const detail = error instanceof Error ? error.message : String(error);
  fail("TEMPLATE_RECONCILE_STALE", `${path} could not be re-read: ${detail}`);
}

async function readReviewedFileState(vault: string, path: string): Promise<VerifiedFileState> {
  try {
    return await readFileState(vault, path);
  } catch (error: unknown) {
    return staleRead(path, error);
  }
}

async function readReviewedSourceState(vault: string, path: TemplateSourcePath): Promise<VerifiedFileState> {
  try {
    return await readSourceState(vault, path);
  } catch (error: unknown) {
    return staleRead(path, error);
  }
}

async function readReviewedContext(vault: string): Promise<Awaited<ReturnType<typeof readTemplateReviewContext>>> {
  try {
    return await readTemplateReviewContext(vault);
  } catch (error: unknown) {
    return staleRead("selected template review snapshot", error);
  }
}

function currentAndProposedInput(
  policy: TemplatePolicy,
  controls: { readonly policy: Digest; readonly taxonomy: Digest; readonly obsidianTypes: Digest },
  obsidianTypesPath: string,
  bindings: readonly TemplateBinding[],
  states: ReadonlyMap<string, VerifiedFileState>,
): { readonly input: InputV2; readonly sourceDescriptors: readonly SourceDescriptor[]; } {
  const authority: AuthorityEntry[] = [
    { kind: "policy", logicalId: "template-policy", vaultRelativePath: ".oms/template-policy.json", contentDigest: controls.policy },
    { kind: "taxonomy", logicalId: "taxonomy", vaultRelativePath: ".oms/taxonomy.json", contentDigest: controls.taxonomy },
    { kind: "obsidian-types", logicalId: "obsidian-types", vaultRelativePath: obsidianTypesPath, contentDigest: controls.obsidianTypes },
  ];
  const sourceDescriptors: SourceDescriptor[] = [
    { logicalId: "template-policy", signature: controls.policy },
    { logicalId: "taxonomy", signature: controls.taxonomy },
    { logicalId: "obsidian-types", signature: controls.obsidianTypes },
  ];
  for (const binding of bindings) {
    const sourcePath = deriveTemplateSourcePath(binding);
    const state = states.get(sourcePath);
    if (state?.state !== "present") continue;
    authority.push({ kind: "template", logicalId: binding.templateId, vaultRelativePath: sourcePath, contentDigest: state.signature });
    sourceDescriptors.push({ path: sourcePath, signature: state.signature });
  }
  const placement = bindings.map(binding => ({
    templateId: binding.templateId,
    destinationClass: binding.destinationClass,
    templateFolder: binding.destinationClass === "managed-default" ? binding.sourceFolder : null,
    sourceFolder: binding.sourceFolder,
    sourcePath: deriveTemplateSourcePath(binding),
  }));
  return { input: { version: 2, templateFolders: policy.templateFolders, authority, placement }, sourceDescriptors };
}

function canonicalPolicy(value: TemplatePolicy): string {
  return serializeTemplatePolicy(parseTemplatePolicy(value));
}

function registeredExistingPolicy(value: TemplatePolicy): TemplatePolicy {
  return parseTemplatePolicy({
    ...value,
    templates: Object.fromEntries(Object.entries(value.templates).map(([id, binding]) => [
      id,
      { ...binding, destinationClass: "registered-existing" as const },
    ])),
  });
}

function policyBindingsByPath(policy: TemplatePolicy): ReadonlyMap<string, TemplateBinding> {
  return new Map(Object.values(policy.templates).map(binding => [deriveTemplateSourcePath(binding), binding]));
}

function diagnosticsBlocking(diagnostics: readonly Diagnostic[]): boolean {
  const blocking = new Set([
    "TEMPLATE_SOURCE_INVALID",
    "TEMPLATE_SOURCE_DUPLICATE",
    "TEMPLATE_CANDIDATE_INCOMPATIBLE",
    "TEMPLATE_ID_DUPLICATE",
    "TEMPLATE_CONTRACT_UNOBSERVED",
    "BASE_CONTRACT_CONFLICT",
    "TEMPLATE_POLICY_DANGLING_FIELD",
    "TEMPLATE_RECLASSIFY_PATH_MISMATCH",
    "OBSIDIAN_TYPE_CONFLICT",
    "TEMPLATE_TYPE_UNRESOLVED",
    "TEMPLATE_EXPRESSION_UNSUPPORTED",
  ]);
  return diagnostics.some(item => blocking.has(item.code));
}

function diagnosticFromInterview(value: Diagnostic): Diagnostic {
  return { ...value, message: value.message ?? value.code };
}

function sameIds(left: readonly TemplateId[], right: readonly TemplateId[]): boolean {
  const a = [...new Set(left)].sort((x, y) => x.localeCompare(y));
  const b = [...new Set(right)].sort((x, y) => x.localeCompare(y));
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sourcePathSet(
  current: TemplatePolicy,
  proposed: TemplatePolicy,
  censusPaths: readonly TemplateSourcePath[],
): readonly TemplateSourcePath[] {
  const paths = new Set<string>([
    ...Object.values(current.templates).map(binding => deriveTemplateSourcePath(binding)),
    ...Object.values(proposed.templates).map(binding => deriveTemplateSourcePath(binding)),
    ...censusPaths,
  ]);
  return [...paths].map(path => normalizeTemplateSourcePath(path)).sort((left, right) => left.localeCompare(right)) as TemplateSourcePath[];
}

function idForSource(
  sourcePath: TemplateSourcePath,
  current: ReadonlyMap<string, TemplateBinding>,
  proposed: ReadonlyMap<string, TemplateBinding>,
  context: Awaited<ReturnType<typeof readTemplateReviewContext>>,
): TemplateId {
  const binding = proposed.get(sourcePath) ?? current.get(sourcePath);
  if (binding !== undefined) return binding.templateId;
  const entry = context.census.entries.find(item => item.sourcePath === sourcePath);
  if (entry?.templateId !== undefined) return entry.templateId;
  fail("TEMPLATE_RECONCILE_INVALID", `source ${sourcePath} has no reviewed template identity`);
}

function resolvedSignatures(
  policy: TemplatePolicy,
  states: ReadonlyMap<string, VerifiedFileState>,
  inputSignature: Digest,
): readonly ResolvedTemplateSourceSignatures[] {
  return Object.values(policy.templates)
    .map(binding => {
      const sourcePath = deriveTemplateSourcePath(binding);
      const state = states.get(sourcePath);
      return state?.state === "present"
        ? { templateId: binding.templateId, sourcePath, inputSignature, templateSignature: state.signature }
        : null;
    })
    .filter((value): value is ResolvedTemplateSourceSignatures => value !== null)
    .sort((left, right) => left.templateId.localeCompare(right.templateId) || left.sourcePath.localeCompare(right.sourcePath));
}

function manifestControl<K extends "policy" | "taxonomy" | "projection", P extends ControlPath>(
  kind: K,
  path: P,
  current: VerifiedFileState,
  proposed: Extract<VerifiedFileState, { readonly state: "present" }>,
  action: "write" | "verify-only",
): TemplateCompositionManifest["controls"][number] {
  return { kind, path, expectedCurrent: expectation(current), current, proposed, action } as TemplateCompositionManifest["controls"][number];
}

/**
 * Rebuilds a reviewed template policy/projection without touching any source
 * file. The interview is replayed against a fresh read-only context, so a
 * forged policy or stale answer set cannot become an approved composition.
 * Every later control/source read is checked against that reviewed snapshot
 * before any derived bytes are admitted to the manifest. A complete
 * follow-up census closes races for newly appearing selected-folder sources.
 */
export async function buildReconcileCompositionManifest(
  vault: string,
  change: Extract<TemplateSemanticChange, { readonly mode: "reconcile" }>,
): Promise<TemplateCompositionManifest> {
  if (change.ledgerDigest !== null && !DIGEST.test(change.ledgerDigest)) fail("TEMPLATE_RECONCILE_INVALID", "ledgerDigest is invalid");
  const context = await readTemplateReviewContext(vault);
  if (context.census.digest !== change.census.digest) fail("TEMPLATE_RECONCILE_STALE", "census changed since the interview snapshot");
  const interview = buildTemplateInterview(context, change.answers);
  if (interview.questions.length > 0) fail("TEMPLATE_RECONCILE_REVIEW_REQUIRED", "interview questions remain unanswered");
  if (interview.proposedPolicy === undefined) fail("TEMPLATE_RECONCILE_REVIEW_REQUIRED", "interview did not produce a proposed policy");
  if (diagnosticsBlocking(interview.diagnostics)) fail("TEMPLATE_RECONCILE_REVIEW_REQUIRED", "interview diagnostics remain blocking");
  const proposedPolicy = parseTemplatePolicy(change.proposedPolicy);
  const interviewPolicy = registeredExistingPolicy(interview.proposedPolicy);
  if (canonicalPolicy(proposedPolicy) !== canonicalPolicy(interviewPolicy)) fail("TEMPLATE_RECONCILE_INVALID", "proposedPolicy does not match the reviewed interview model");
  if (!sameIds(change.reviewedTemplateIds, interview.reviewedTemplateIds)) fail("TEMPLATE_RECONCILE_INVALID", "reviewedTemplateIds do not match the reviewed interview model");
  if (Object.values(proposedPolicy.templates).some(binding => binding.destinationClass !== "registered-existing")) fail("TEMPLATE_RECONCILE_INVALID", "reconcile bindings must be registered-existing");

  const root = resolve(vault);
  const policyState = await readReviewedFileState(root, ".oms/template-policy.json");
  const taxonomyState = await readReviewedFileState(root, ".oms/taxonomy.json");
  const projectionState = await readReviewedFileState(root, ".oms/types.json");
  const obsidianState = await readReviewedFileState(root, ".obsidian/types.json");
  const controlStates = {
    ".oms/template-policy.json": policyState,
    ".oms/taxonomy.json": taxonomyState,
    ".oms/types.json": projectionState,
    ".obsidian/types.json": obsidianState,
  } as const;
  const paths = sourcePathSet(context.policy, proposedPolicy, [
    ...context.census.entries.map(entry => entry.sourcePath),
    ...context.census.diffs.flatMap(diff => [diff.sourcePath, diff.oldSourcePath, diff.newSourcePath].filter((value): value is TemplateSourcePath => value !== undefined)),
  ]);
  const sourceStates = new Map<string, VerifiedFileState>();
  for (const path of paths) sourceStates.set(path, await readReviewedSourceState(root, path));
  assertReviewedSnapshot(context, controlStates, paths, sourceStates);
  const followUpContext = await readReviewedContext(root);
  assertReviewedReviewSnapshot(context, followUpContext);
  if (policyState.state !== "present" || taxonomyState.state !== "present" || obsidianState.state !== "present") fail("TEMPLATE_RECONCILE_INVALID", "required controls are missing");
  const currentPolicy = parseTemplatePolicy(decoder.decode(policyState.bytes));
  const taxonomy = taxonomyRouting(".oms/taxonomy.json", taxonomyState.bytes);
  const obsidianTypes = context.obsidianTypes;

  const currentByPath = policyBindingsByPath(currentPolicy);
  const proposedByPath = policyBindingsByPath(proposedPolicy);
  const sourceDescriptorsForCurrent = currentAndProposedInput(currentPolicy, {
    policy: policyState.signature,
    taxonomy: taxonomyState.signature,
    obsidianTypes: obsidianState.signature,
  }, ".obsidian/types.json", Object.values(currentPolicy.templates), sourceStates);
  const proposedPolicyBytes = encoder.encode(canonicalPolicy(proposedPolicy));
  const proposedControls = {
    policy: digest(proposedPolicyBytes),
    taxonomy: taxonomyState.signature,
    obsidianTypes: obsidianState.signature,
  };
  const proposedBindings = Object.values(proposedPolicy.templates).sort((left, right) => left.templateId.localeCompare(right.templateId));
  const reviewed = new Set(change.reviewedTemplateIds);
  const proposedTemplates: Record<string, DerivedProjection["managed"]["templates"][string]> = {};
  for (const binding of proposedBindings) {
    if (!reviewed.has(binding.templateId)) continue;
    const path = deriveTemplateSourcePath(binding);
    const state = sourceStates.get(path);
    if (state?.state !== "present") continue;
    const source = resolveClassifiedTemplateSource(path, state.bytes, binding.renderer);
    proposedTemplates[binding.templateId] = deriveManagedTemplateProjection(
      proposedPolicy,
      binding,
      source,
      obsidianTypes,
      taxonomy.targetFolders.get(binding.templateId),
    );
  }
  const proposedSourceDescriptors: SourceDescriptor[] = [
    { logicalId: "template-policy", signature: proposedControls.policy },
    { logicalId: "taxonomy", signature: proposedControls.taxonomy },
    { logicalId: "obsidian-types", signature: proposedControls.obsidianTypes },
    ...proposedBindings.flatMap(binding => {
      if (proposedTemplates[binding.templateId] === undefined) return [];
      const state = sourceStates.get(deriveTemplateSourcePath(binding));
      return state?.state === "present" ? [{ path: deriveTemplateSourcePath(binding), signature: state.signature }] : [];
    }),
  ];
  const proposedInputSignature = sourceSignature(proposedSourceDescriptors);
  let priorProjection: DerivedProjection | undefined;
  if (context.projectionUsable && projectionState.state === "present") {
    try { priorProjection = parseDerivedProjection(decoder.decode(projectionState.bytes)); } catch { priorProjection = undefined; }
  }
  const proposedProjection: DerivedProjection = {
    version: "oms.types.v1",
    generatedFrom: {
      algorithm: "sha256-lp-v1",
      inputSignature: proposedInputSignature,
      sharedAuthoritySignature: sharedAuthoritySignature(proposedSourceDescriptors),
      sources: proposedSourceDescriptors,
    },
    managed: { base: proposedPolicy.base, templates: proposedTemplates, globalAxes: taxonomy.globalAxes },
    ...(priorProjection?.extensions === undefined ? {} : { extensions: priorProjection.extensions }),
  };
  const proposedProjectionBytes = encoder.encode(serializeDerivedProjection(proposedProjection));

  const currentInput = sourceDescriptorsForCurrent.input;
  const currentInputDigest = inputDigest(currentInput);
  const proposedInput = currentAndProposedInput(proposedPolicy, proposedControls, ".obsidian/types.json", proposedBindings, sourceStates).input;
  const proposedInputDigest = inputDigest(proposedInput);
  const currentSnapshot: TemplateCompositionManifest["current"] = {
    input: currentInput,
    inputDigest: currentInputDigest,
    bindings: Object.values(currentPolicy.templates).sort((left, right) => left.templateId.localeCompare(right.templateId)),
    resolvedTemplates: resolvedSignatures(currentPolicy, sourceStates, sourceSignature(sourceDescriptorsForCurrent.sourceDescriptors)),
  };
  const proposedSnapshot: TemplateCompositionManifest["proposed"] = {
    input: proposedInput,
    inputDigest: proposedInputDigest,
    bindings: proposedBindings,
    resolvedTemplates: resolvedSignatures(proposedPolicy, sourceStates, proposedInputSignature),
  };

  const transitions: SourceTransition[] = [];
  for (const path of paths) {
    const state = sourceStates.get(path) ?? { state: "absent" as const };
    const templateId = idForSource(path, currentByPath, proposedByPath, context);
    transitions.push({
      templateId,
      path,
      expectedCurrent: expectation(state),
      current: state,
      proposed: state,
      action: "verify-only",
    });
  }
  transitions.sort((left, right) => left.templateId.localeCompare(right.templateId) || left.path.localeCompare(right.path));
  const operations: LogicalOperation[] = proposedBindings.map(binding => ({
    kind: "reconcile",
    templateId: binding.templateId,
    destinationClass: binding.destinationClass,
    payloadDigest: digest(proposedPolicyBytes),
    stableRelativeSuffix: null,
  }));
  const controls = [
    manifestControl("policy", ".oms/template-policy.json", policyState, { state: "present", bytes: proposedPolicyBytes, signature: digest(proposedPolicyBytes) }, !sameBytes(policyState.bytes, proposedPolicyBytes) ? "write" : "verify-only"),
    manifestControl("taxonomy", ".oms/taxonomy.json", taxonomyState, { state: "present", bytes: new Uint8Array(taxonomyState.bytes), signature: taxonomyState.signature }, "verify-only"),
    manifestControl("projection", ".oms/types.json", projectionState, { state: "present", bytes: proposedProjectionBytes, signature: digest(proposedProjectionBytes) }, projectionState.state === "present" && sameBytes(projectionState.bytes, proposedProjectionBytes) ? "verify-only" : "write"),
  ] as TemplateCompositionManifest["controls"];
  const diagnostics = interview.diagnostics.map(diagnosticFromInterview);
  const outputs = controls.filter(control => control.action === "write").map(control => ({ finalVaultRelativePath: control.path, payloadDigest: control.proposed.signature }));
  const approval = approvalDigest(proposedInputDigest, operations, diagnostics, { current: currentSnapshot, controls, sources: transitions });
  return {
    version: 1,
    mode: "reconcile",
    current: currentSnapshot,
    proposed: proposedSnapshot,
    controls,
    sources: transitions,
    operations,
    diagnostics,
    moves: [],
    outputs,
    approvalDigest: approval,
    outputDigest: outputDigest(outputs),
  };
}
