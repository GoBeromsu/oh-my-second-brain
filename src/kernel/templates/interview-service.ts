import { readFile } from "node:fs/promises";

import { admitWriteTarget, type WriteTarget } from "../capture/safe.js";
import { readBundledPackageVersion } from "../runtime/assets.js";
import { appendRuntimeEvent, createRuntimeEvent, createRuntimeInvocation } from "../runtime/event-journal.js";
import type { RuntimeEventInput, RuntimeInvocation } from "../runtime/event-types.js";
import { approvalDigest, digestBytes, outputDigest } from "./canonical.js";
import { templateCensus, type CensusResult } from "./census.js";
import {
  buildTemplateInterview,
  validateInterviewAnswer,
  type TemplateInterview,
  type TemplateInterviewAnswer,
  type TemplateInterviewQuestion,
  type TemplateProposalInput,
} from "./interview.js";
import {
  readInterviewLedger,
  withInterviewLedgerLock,
  type InterviewLedger,
  type InterviewLedgerAnswer,
  type InterviewLedgerRead,
} from "./interview-ledger.js";
import {
  normalizeTemplateControlPath,
  verifyManagedTemplatePath,
  verifyTemplateControlPath,
} from "./paths.js";
import { parseTemplatePolicy, serializeDerivedProjection, serializeTemplatePolicy } from "./policy.js";
import { controlGenerationDigest, expectedProjectionManaged, taxonomyRouting } from "./resolver.js";
import { executeTemplateTransaction, TEMPLATE_TRANSACTION_MARKER_PATH } from "./transaction.js";
import type {
  ControlTransition,
  Diagnostic,
  Digest,
  FileExpectation,
  GuardedTemplateRequest,
  JsonValue,
  ManagedDraftTransition,
  ManagedTemplatePath,
  TemplateCompositionManifest,
  TemplateId,
  TemplatePolicy,
  TemplateTransactionReceipt,
  VerifiedFileState,
} from "./types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const BLOCKING = new Set<string>([
  "TEMPLATE_ID_DUPLICATE",
  "TEMPLATE_SOURCE_DUPLICATE",
  "TEMPLATE_SOURCE_INVALID",
  "TEMPLATE_SOURCE_UNSAFE",
  "TEMPLATE_POLICY_INVALID",
  "TEMPLATE_POLICY_VERSION_UNSUPPORTED",
  "CONTRACT_UNVERIFIABLE",
  "CONTRACT_COMPOSITION_CONFLICT",
  "PROJECTION_INVALID",
  "RUBRIC_INVALID",
]);
const QUESTION_KINDS: ReadonlySet<TemplateInterviewQuestion["kind"]> = new Set([
  "pool",
  "default-layer",
  "individual",
  "taxonomy-placement",
  "completion",
]);
const POLICY_PATH = ".oms/template-policy.json";
const TAXONOMY_PATH = ".oms/taxonomy.json";
const PROJECTION_PATH = ".oms/types.json";
const encoder = new TextEncoder();

export type TemplateInterviewServiceState = "question" | "confirm" | "unchanged" | "blocked";

export interface TemplateInterviewSessionRequest {
  readonly proposals?: readonly TemplateProposalInput[];
}

export interface TemplateInterviewAnswerRequest extends TemplateInterviewSessionRequest {
  readonly questionId: Digest;
  readonly answer: JsonValue;
  readonly censusDigest: Digest;
  readonly expectedLedgerDigest: Digest | null;
}

export interface TemplateInterviewCommitRequest extends TemplateInterviewSessionRequest {
  readonly censusDigest: Digest;
  readonly expectedLedgerDigest: Digest | null;
  readonly dryRun?: boolean;
  readonly approvedDigest?: Digest;
}

type CompactControlTransition = Omit<TemplateCompositionManifest["controls"][number], "current" | "proposed"> & {
  readonly current: FileExpectation;
  readonly proposed: FileExpectation;
};

type CompactDraftTransition = Omit<ManagedDraftTransition, "current" | "proposed"> & {
  readonly current: FileExpectation;
  readonly proposed: FileExpectation;
};

/** Public review proposal metadata; source and control payload bytes never cross this boundary. */
export type TemplateInterviewProposal = Omit<TemplateCompositionManifest, "controls" | "drafts"> & {
  readonly controls: readonly [CompactControlTransition, CompactControlTransition, CompactControlTransition];
  readonly drafts: readonly CompactDraftTransition[];
};

export interface TemplateInterviewServiceDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly templateId?: string;
}

/** Canonical machine-facing review state; only `next` is exposed, never the full unanswered list. */
export interface TemplateInterviewServiceResult {
  readonly state: TemplateInterviewServiceState;
  readonly censusDigest: Digest;
  readonly expectedLedgerDigest: Digest | null;
  readonly next?: TemplateInterviewQuestion;
  readonly invalidatedQuestionIds: readonly Digest[];
  readonly reviewedTemplateIds: readonly TemplateId[];
  readonly diagnostics: readonly TemplateInterviewServiceDiagnostic[];
  readonly proposedPolicy?: TemplatePolicy;
  readonly proposal?: TemplateInterviewProposal;
  readonly approvalDigest?: Digest;
}

interface LedgerSnapshot {
  readonly read: InterviewLedgerRead;
  readonly answers: Readonly<Record<string, InterviewLedgerAnswer>>;
  readonly invalidDiagnostic?: TemplateInterviewServiceDiagnostic;
}

interface ModelResult {
  readonly census: CensusResult;
  readonly interview: TemplateInterview;
  readonly ledgerDigest: Digest | null;
  readonly answers: Readonly<Record<string, InterviewLedgerAnswer>>;
  readonly diagnostics: readonly TemplateInterviewServiceDiagnostic[];
  readonly proposedPolicy?: TemplatePolicy;
}

function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST.test(value);
}

function isQuestionKind(value: unknown): value is TemplateInterviewQuestion["kind"] {
  return typeof value === "string" && QUESTION_KINDS.has(value as TemplateInterviewQuestion["kind"]);
}

function codedError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`);
  Object.assign(error, { code });
  return error;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message.split(":", 1)[0]! : "TEMPLATE_INTERVIEW_FAILED";
}

function diagnostic(code: string, message: string, path?: string, templateId?: string): TemplateInterviewServiceDiagnostic {
  return {
    code,
    message,
    ...(path === undefined ? {} : { path }),
    ...(templateId === undefined ? {} : { templateId }),
  };
}

function blocking(diagnostics: readonly TemplateInterviewServiceDiagnostic[]): boolean {
  return diagnostics.some(item => BLOCKING.has(item.code));
}

function expectation(value: VerifiedFileState): FileExpectation {
  return value.state === "present" ? { state: "present", signature: value.signature } : { state: "absent" };
}

function compactFile(value: VerifiedFileState): FileExpectation {
  return expectation(value);
}

function compactProposal(manifest: TemplateCompositionManifest): TemplateInterviewProposal {
  const compactControl = (control: TemplateCompositionManifest["controls"][number]): CompactControlTransition => ({
    ...control,
    current: compactFile(control.current),
    proposed: compactFile(control.proposed),
  });
  return {
    ...manifest,
    controls: [
      compactControl(manifest.controls[0]),
      compactControl(manifest.controls[1]),
      compactControl(manifest.controls[2]),
    ],
    drafts: manifest.drafts.map(draft => ({
      ...draft,
      current: compactFile(draft.current),
      proposed: compactFile(draft.proposed),
    })),
  };
}

function validGuardedRequest(request: unknown): request is GuardedTemplateRequest {
  if (request === null || typeof request !== "object") return false;
  const value = request as { readonly dryRun?: unknown; readonly approvedDigest?: unknown };
  if (value.dryRun === true) return value.approvedDigest === undefined;
  return isDigest(value.approvedDigest);
}

function validateAnswerRequest(request: TemplateInterviewAnswerRequest): void {
  if (
    request === null
    || typeof request !== "object"
    || !isDigest(request.questionId)
    || !isDigest(request.censusDigest)
    || !(request.expectedLedgerDigest === null || isDigest(request.expectedLedgerDigest))
  ) throw codedError("TEMPLATE_INTERVIEW_ANSWER_INVALID", "questionId, censusDigest, and expectedLedgerDigest are invalid");
}

function validateCommitRequest(request: TemplateInterviewCommitRequest): asserts request is TemplateInterviewCommitRequest & GuardedTemplateRequest {
  if (
    request === null
    || typeof request !== "object"
    || !isDigest(request.censusDigest)
    || !(request.expectedLedgerDigest === null || isDigest(request.expectedLedgerDigest))
    || !validGuardedRequest(request)
  ) throw codedError("TEMPLATE_INTERVIEW_COMMIT_INVALID", "census/ledger CAS and guarded request are invalid");
}

function appendEvent(vault: string, invocation: RuntimeInvocation, input: RuntimeEventInput): void {
  try {
    appendRuntimeEvent(createRuntimeEvent(invocation, input), { vaultPath: vault });
  } catch {
    // Runtime history is external and non-authoritative for the review/write result.
  }
}

function questionTemplateId(question: TemplateInterviewQuestion): string | undefined {
  if (question.proposal.kind === "individual") return question.proposal.templateId;
  if (question.proposal.kind === "taxonomy-placement") return question.proposal.templateId ?? undefined;
  return undefined;
}

function questionEvent(
  vault: string,
  action: "shown" | "answered" | "invalidated" | "stale",
  questionId: Digest,
  questionKind: TemplateInterviewQuestion["kind"],
  inputSignature: Digest,
  templateId?: string,
): void {
  const invocation = createRuntimeInvocation({
    surface: "kernel",
    operation: `template-interview-question-${action}:${questionKind}`,
    packageVersion: readBundledPackageVersion(),
  });
  appendEvent(vault, invocation, {
    kind: action === "stale" ? "template-interview-stale" : `template-interview-question-${action}`,
    outcome: action === "answered" ? "success" : action === "shown" ? "observation-gap" : "rejected",
    transactionId: questionId,
    ...(templateId === undefined ? {} : { templateId }),
    inputSignature,
  });
}

function journalDiffs(census: CensusResult, invocation: RuntimeInvocation): void {
  for (const diff of census.diffs) {
    appendEvent(census.vault, invocation, {
      kind: `template-interview-census-${diff.kind}`,
      outcome: "observation-gap",
      ...(diff.templateId === null ? {} : { templateId: diff.templateId }),
      notePath: diff.path,
      inputSignature: census.censusDigest,
    });
  }
}

function journalInterview(
  interview: TemplateInterview,
  census: CensusResult,
  answers: Readonly<Record<string, InterviewLedgerAnswer>>,
): void {
  if (interview.next !== undefined) {
    questionEvent(
      census.vault,
      "shown",
      interview.next.questionId,
      interview.next.kind,
      census.censusDigest,
      questionTemplateId(interview.next),
    );
  }
  const questionsById = new Map<string, TemplateInterviewQuestion>(interview.questions.map(question => [question.questionId, question]));
  interview.invalidatedQuestionIds.forEach(questionId => {
    const question = questionsById.get(questionId);
    const answer = answers[questionId];
    const kind = question?.kind ?? (isQuestionKind(answer?.kind) ? answer.kind : undefined);
    if (kind === undefined) return;
    questionEvent(
      census.vault,
      "invalidated",
      questionId,
      kind,
      census.censusDigest,
      question === undefined ? (typeof answer?.templateId === "string" ? answer.templateId : undefined) : questionTemplateId(question),
    );
  });
}

function reviewedTemplateIds(interview: TemplateInterview): readonly TemplateId[] {
  const ids = new Set<string>();
  for (const item of [...interview.confirmed, ...interview.deferred, ...interview.unresolved]) {
    if (item.proposal.kind === "individual") ids.add(item.proposal.templateId);
    if (item.proposal.kind === "taxonomy-placement" && item.proposal.templateId !== null) ids.add(item.proposal.templateId);
  }
  return [...ids].sort() as TemplateId[];
}

function interviewDiagnostics(interview: TemplateInterview): TemplateInterviewServiceDiagnostic[] {
  return interview.diagnostics.map(item => diagnostic(item.code, item.message, item.path, item.templateId));
}

function ledgerAnswers(value: Readonly<Record<string, InterviewLedgerAnswer>>): TemplateInterviewAnswer[] {
  const answers: TemplateInterviewAnswer[] = [];
  for (const [questionId, answer] of Object.entries(value)) {
    if (!isDigest(questionId) || !isDigest(answer.anchorDigest) || typeof answer.raw !== "string") continue;
    if (answer.disposition !== "confirm" && answer.disposition !== "defer" && answer.disposition !== "unresolved") continue;
    answers.push({
      questionId,
      anchorDigest: answer.anchorDigest,
      censusDigest: isDigest(answer.censusDigest) ? answer.censusDigest : answer.anchorDigest,
      disposition: answer.disposition,
      raw: answer.raw,
    });
  }
  return answers;
}

function individualLayer(proposal: Extract<TemplateInterview["confirmed"][number]["proposal"], { readonly kind: "individual" }>) {
  return {
    templateId: proposal.templateId,
    templatePath: proposal.templatePath,
    approvedMarkdown: "",
    approvedMarkdownDigest: digestBytes(""),
    fields: proposal.fields,
    headings: proposal.headings,
    semanticCriteria: proposal.semanticCriteria,
    ...(proposal.headingOrder === null ? {} : { headingOrder: proposal.headingOrder }),
    ...(proposal.source === null ? {} : { source: proposal.source }),
  };
}

function composeProposedPolicy(census: CensusResult, interview: TemplateInterview): TemplatePolicy | undefined {
  if (interview.next !== undefined || census.authority === "invalid") return undefined;
  const pool = interview.confirmed.find(item => item.proposal.kind === "pool")?.proposal;
  const defaultLayer = interview.confirmed.find(item => item.proposal.kind === "default-layer")?.proposal;
  const completion = interview.confirmed.find(item => item.proposal.kind === "completion")?.proposal;
  const individuals = interview.confirmed.flatMap(item => item.proposal.kind === "individual" ? [item.proposal] : []);
  try {
    if (census.authority === "absent") {
      if (defaultLayer === undefined || defaultLayer.kind !== "default-layer") return undefined;
      return parseTemplatePolicy({
        version: 4,
        properties: pool?.kind === "pool" ? pool.properties : {},
        default: {
          templatePath: defaultLayer.templatePath,
          approvedMarkdown: defaultLayer.approvedMarkdown,
          approvedMarkdownDigest: defaultLayer.approvedMarkdownDigest,
          headingOrder: defaultLayer.headingOrder,
          fields: defaultLayer.fields,
          headings: defaultLayer.headings,
          semanticCriteria: defaultLayer.semanticCriteria,
        },
        templates: Object.fromEntries(individuals.map(item => [item.templateId, individualLayer(item)])),
        ...(completion?.kind === "completion"
          ? { completion: { retryBudget: completion.retryBudget, agentRepair: completion.agentRepair } }
          : {}),
      });
    }
    const approved = census.approvedPolicy;
    if (approved === null) return undefined;
    return parseTemplatePolicy({
      version: 4,
      properties: { ...approved.properties, ...(pool?.kind === "pool" ? pool.properties : {}) },
      default: approved.default,
      templates: {
        ...approved.templates,
        ...Object.fromEntries(individuals.map(item => [item.templateId, individualLayer(item)])),
      },
      completion: completion?.kind === "completion"
        ? { retryBudget: completion.retryBudget, agentRepair: completion.agentRepair }
        : approved.completion,
      ...(approved.extensions === undefined ? {} : { extensions: approved.extensions }),
    });
  } catch {
    return undefined;
  }
}

function makeModel(
  census: CensusResult,
  answers: Readonly<Record<string, InterviewLedgerAnswer>>,
  ledgerDigest: Digest | null,
  proposals: readonly TemplateProposalInput[] | undefined,
  extraDiagnostics: readonly TemplateInterviewServiceDiagnostic[] = [],
): ModelResult {
  const interview = buildTemplateInterview(census, {
    ...(proposals === undefined ? {} : { proposals }),
    answers: ledgerAnswers(answers),
  });
  const diagnostics = [...extraDiagnostics, ...interviewDiagnostics(interview)];
  return {
    census,
    interview,
    ledgerDigest,
    answers,
    diagnostics,
    proposedPolicy: composeProposedPolicy(census, interview),
  };
}

async function resultFromModel(
  model: ModelResult,
  invocation: RuntimeInvocation,
): Promise<TemplateInterviewServiceResult> {
  const { census, interview, ledgerDigest } = model;
  journalDiffs(census, invocation);
  journalInterview(interview, census, model.answers);
  const base = {
    censusDigest: census.censusDigest,
    expectedLedgerDigest: ledgerDigest,
    invalidatedQuestionIds: interview.invalidatedQuestionIds,
    reviewedTemplateIds: reviewedTemplateIds(interview),
    diagnostics: model.diagnostics,
  };
  if (interview.next !== undefined) return { state: "question", next: interview.next, ...base };
  if (census.authority === "invalid" || blocking(model.diagnostics) || model.proposedPolicy === undefined) {
    return { state: "blocked", ...base };
  }
  const manifest = await composeCommitManifest(census, model.proposedPolicy, interview);
  if (manifest.outputs.length === 0) {
    return { state: "unchanged", ...base, proposedPolicy: model.proposedPolicy };
  }
  const proposal = compactProposal(manifest);
  return {
    state: "confirm",
    ...base,
    proposedPolicy: model.proposedPolicy,
    proposal,
    approvalDigest: proposal.approvalDigest,
  };
}

function stale(message: string): never {
  throw codedError("TEMPLATE_INTERVIEW_STALE", message);
}

async function readLedgerSnapshot(vault: string): Promise<LedgerSnapshot> {
  try {
    const read = await readInterviewLedger(vault);
    return {
      read,
      answers: read.ledger?.answers ?? {},
    };
  } catch (error: unknown) {
    if (errorCode(error) !== "TEMPLATE_INTERVIEW_INVALID") throw error;
    const rawDigest = error instanceof Error && "digest" in error && isDigest(error.digest) ? error.digest : null;
    const message = error instanceof Error ? error.message : String(error);
    return {
      read: { ledger: null, digest: rawDigest },
      answers: {},
      invalidDiagnostic: diagnostic("TEMPLATE_INTERVIEW_INVALID", message),
    };
  }
}

async function questionForId(
  target: WriteTarget,
  questionId: Digest,
  proposals?: readonly TemplateProposalInput[],
): Promise<{ readonly kind: TemplateInterviewQuestion["kind"]; readonly templateId?: string } | undefined> {
  try {
    const census = await templateCensus(target.vault);
    const snapshot = await readLedgerSnapshot(census.vault);
    const interview = buildTemplateInterview(census, {
      ...(proposals === undefined ? {} : { proposals }),
      answers: ledgerAnswers(snapshot.answers),
    });
    const question = interview.questions.find(item => item.questionId === questionId);
    if (question !== undefined) return { kind: question.kind, templateId: questionTemplateId(question) };
    const answer = snapshot.answers[questionId];
    if (answer !== undefined && isQuestionKind(answer.kind)) {
      return { kind: answer.kind, templateId: typeof answer.templateId === "string" ? answer.templateId : undefined };
    }
  } catch {
    // Stale telemetry cannot change the authoritative rejection.
  }
  return undefined;
}

async function journalStale(target: WriteTarget, input: Digest, questionId: Digest, proposals?: readonly TemplateProposalInput[]): Promise<void> {
  const question = await questionForId(target, questionId, proposals);
  if (question !== undefined) {
    questionEvent(target.vault, "stale", questionId, question.kind, input, question.templateId);
    return;
  }
  const invocation = createRuntimeInvocation({
    surface: "kernel",
    operation: "template-interview-question-stale:unresolved",
    packageVersion: readBundledPackageVersion(),
  });
  appendEvent(target.vault, invocation, {
    kind: "template-interview-stale",
    outcome: "rejected",
    transactionId: questionId,
    inputSignature: input,
  });
}

function journalCommitStale(target: WriteTarget, input: Digest): void {
  const invocation = createRuntimeInvocation({ surface: "kernel", operation: "template-interview-commit-stale", packageVersion: readBundledPackageVersion() });
  appendEvent(target.vault, invocation, { kind: "template-interview-stale", outcome: "rejected", inputSignature: input });
}

async function readControlState(vault: string, relativePath: string): Promise<VerifiedFileState> {
  const verified = await verifyTemplateControlPath(vault, normalizeTemplateControlPath(relativePath), { expected: "either" });
  if (verified.targetRealPath === null) return { state: "absent" };
  const bytes = new Uint8Array(await readFile(verified.absolutePath));
  return { state: "present", bytes, signature: digestBytes(bytes) };
}

async function readDraftState(vault: string, relativePath: ManagedTemplatePath): Promise<VerifiedFileState> {
  const verified = await verifyManagedTemplatePath(vault, relativePath, { expected: "either" });
  if (verified.targetRealPath === null) return { state: "absent" };
  const bytes = new Uint8Array(await readFile(verified.absolutePath));
  return { state: "present", bytes, signature: digestBytes(bytes) };
}

function present(bytes: Uint8Array): Extract<VerifiedFileState, { readonly state: "present" }> {
  return { state: "present", bytes, signature: digestBytes(bytes) };
}

function controlTransition<K extends "policy" | "taxonomy" | "projection", P extends typeof POLICY_PATH | typeof TAXONOMY_PATH | typeof PROJECTION_PATH>(
  kind: K,
  path: P,
  current: VerifiedFileState,
  proposedBytes: Uint8Array,
): ControlTransition<K, P> {
  const proposed = present(proposedBytes);
  if (current.state === "present" && current.signature === proposed.signature) {
    return { kind, path, expectedCurrent: expectation(current), current, proposed: current, action: "verify-only" };
  }
  return { kind, path, expectedCurrent: expectation(current), current, proposed, action: "write" };
}

function draftTransition(
  templateId: TemplateId | null,
  path: ManagedTemplatePath,
  current: VerifiedFileState,
  proposedBytes: Uint8Array,
): ManagedDraftTransition {
  const proposed = present(proposedBytes);
  if (current.state === "present" && current.signature === proposed.signature) {
    return { templateId, path, expectedCurrent: expectation(current), current, proposed: current, action: "verify-only" };
  }
  return { templateId, path, expectedCurrent: expectation(current), current, proposed, action: "write" };
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function proposedTaxonomyBytes(current: VerifiedFileState, interview: TemplateInterview): Uint8Array {
  const placements = interview.confirmed.flatMap(item => item.proposal.kind === "taxonomy-placement" ? [item.proposal] : []);
  if (placements.length === 0) {
    return current.state === "present" ? current.bytes : encoder.encode("{}\n");
  }
  let base: Record<string, unknown> = {};
  if (current.state === "present") {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(current.bytes));
      if (!recordValue(parsed)) throw new Error("taxonomy is not an object");
      base = { ...parsed };
    } catch (error: unknown) {
      throw codedError("CONTRACT_UNVERIFIABLE", error instanceof Error ? error.message : String(error));
    }
  }
  const templates = recordValue(base.templates) ? { ...base.templates } : {};
  for (const placement of placements) {
    if (placement.templateId === null) continue;
    templates[placement.templateId] = placement.placement;
  }
  return encoder.encode(`${JSON.stringify({ ...base, templates }, null, 2)}\n`);
}

async function composeCommitManifest(
  census: CensusResult,
  policy: TemplatePolicy,
  interview: TemplateInterview,
): Promise<TemplateCompositionManifest> {
  const [policyState, taxonomyState, projectionState] = await Promise.all([
    readControlState(census.vault, POLICY_PATH),
    readControlState(census.vault, TAXONOMY_PATH),
    readControlState(census.vault, PROJECTION_PATH),
  ]);
  const policyBytes = encoder.encode(serializeTemplatePolicy(policy));
  const taxonomyBytes = proposedTaxonomyBytes(taxonomyState, interview);
  const generation = controlGenerationDigest(policyBytes, taxonomyBytes);
  const projectionBytes = encoder.encode(serializeDerivedProjection({
    version: "oms.types.v2",
    generatedFrom: generation,
    managed: expectedProjectionManaged(policy, taxonomyRouting(TAXONOMY_PATH, taxonomyBytes), generation),
  }));
  const controls = [
    controlTransition("policy", POLICY_PATH, policyState, policyBytes),
    controlTransition("taxonomy", TAXONOMY_PATH, taxonomyState, taxonomyBytes),
    controlTransition("projection", PROJECTION_PATH, projectionState, projectionBytes),
  ] as TemplateCompositionManifest["controls"];
  const draftSpecs: Array<{ readonly templateId: TemplateId | null; readonly path: ManagedTemplatePath; readonly bytes: Uint8Array }> = [
    { templateId: null, path: policy.default.templatePath, bytes: encoder.encode(policy.default.approvedMarkdown) },
    ...Object.values(policy.templates).map(template => ({
      templateId: template.templateId,
      path: template.templatePath,
      bytes: encoder.encode(template.approvedMarkdown),
    })),
  ];
  const drafts: ManagedDraftTransition[] = [];
  for (const spec of draftSpecs) {
    drafts.push(draftTransition(spec.templateId, spec.path, await readDraftState(census.vault, spec.path), spec.bytes));
  }
  const transitions = [...controls, ...drafts];
  const outputs = transitions.flatMap(transition =>
    transition.action === "write" && transition.proposed.state === "present"
      ? [{ finalVaultRelativePath: transition.path, payloadDigest: transition.proposed.signature }]
      : []);
  const body = {
    version: 1 as const,
    markerPath: TEMPLATE_TRANSACTION_MARKER_PATH,
    controls,
    drafts,
    operations: [{ kind: "commit-contract" as const, templateId: null, payloadDigest: digestBytes(policyBytes) }],
    diagnostics: [] as Diagnostic[],
    outputs,
  };
  return { ...body, approvalDigest: approvalDigest(body), outputDigest: outputDigest(outputs) };
}

function requireComposable(model: ModelResult): { readonly policy: TemplatePolicy; readonly interview: TemplateInterview } {
  if (model.interview.next !== undefined) stale("interview questions remain unanswered");
  if (model.proposedPolicy === undefined || blocking(model.diagnostics) || model.census.authority === "invalid") {
    throw codedError("TEMPLATE_INTERVIEW_REVIEW_REQUIRED", "interview did not produce an approvable contract");
  }
  return { policy: model.proposedPolicy, interview: model.interview };
}

async function censusDigestOf(vault: string): Promise<Digest> {
  return (await templateCensus(vault)).censusDigest;
}

/** Reads the current review model without writing the vault or interview ledger. */
export async function nextTemplateInterview(
  target: WriteTarget,
  request: TemplateInterviewSessionRequest = {},
): Promise<TemplateInterviewServiceResult> {
  const invocation = createRuntimeInvocation({ surface: "kernel", operation: "template-interview-next", packageVersion: readBundledPackageVersion() });
  const census = await templateCensus(target.vault);
  const snapshot = await readLedgerSnapshot(census.vault);
  try {
    if (snapshot.invalidDiagnostic !== undefined) {
      appendEvent(census.vault, invocation, {
        kind: "template-interview-ledger-invalid",
        outcome: "rejected",
        inputSignature: census.censusDigest,
      });
    }
    return await resultFromModel(
      makeModel(
        census,
        snapshot.answers,
        snapshot.read.digest,
        request.proposals,
        snapshot.invalidDiagnostic === undefined ? [] : [snapshot.invalidDiagnostic],
      ),
      invocation,
    );
  } catch (error: unknown) {
    return {
      state: "blocked",
      censusDigest: census.censusDigest,
      expectedLedgerDigest: snapshot.read.digest,
      invalidatedQuestionIds: [],
      reviewedTemplateIds: [],
      diagnostics: [diagnostic(errorCode(error), error instanceof Error ? error.message : String(error))],
    };
  }
}

/** Validates and persists one answer under a census/ledger CAS lock, then returns only the next question. */
export async function answerTemplateInterview(
  target: WriteTarget,
  request: TemplateInterviewAnswerRequest,
): Promise<TemplateInterviewServiceResult> {
  validateAnswerRequest(request);
  const invocation = createRuntimeInvocation({ surface: "kernel", operation: "template-interview-answer", packageVersion: readBundledPackageVersion() });
  try {
    return await withInterviewLedgerLock(
      target,
      {
        expectedLedgerDigest: request.expectedLedgerDigest,
        expectedCensusDigest: request.censusDigest,
        verifyCensus: async () => censusDigestOf(target.vault),
      },
      async locked => {
        const census = await templateCensus(target.vault);
        if (census.censusDigest !== request.censusDigest) stale("the template census changed; re-read before retrying");
        const interview = buildTemplateInterview(census, {
          ...(request.proposals === undefined ? {} : { proposals: request.proposals }),
          answers: ledgerAnswers(locked.answers),
        });
        const question = interview.next;
        if (question === undefined || question.questionId !== request.questionId) stale("the answer does not match the current interview question");
        let accepted: TemplateInterviewAnswer;
        try {
          accepted = validateInterviewAnswer(question, request.answer);
        } catch (error: unknown) {
          questionEvent(
            census.vault,
            "invalidated",
            question.questionId,
            question.kind,
            census.censusDigest,
            questionTemplateId(question),
          );
          throw error;
        }
        const prior = locked.answers[question.questionId];
        const answers: Record<string, InterviewLedgerAnswer> = {
          ...locked.answers,
          [question.questionId]: {
            ...(prior ?? {}),
            anchorDigest: accepted.anchorDigest,
            disposition: accepted.disposition,
            raw: accepted.raw,
            censusDigest: accepted.censusDigest,
            kind: question.kind,
            subject: question.subject,
          },
        };
        const base: InterviewLedger = locked.ledger === null
          ? { version: 1, censusDigest: request.censusDigest, answers }
          : { ...locked.ledger, censusDigest: request.censusDigest, answers };
        const saved = await locked.save(base);
        questionEvent(
          census.vault,
          "answered",
          question.questionId,
          question.kind,
          census.censusDigest,
          questionTemplateId(question),
        );
        return resultFromModel(makeModel(census, answers, saved.digest, request.proposals), invocation);
      },
    );
  } catch (error: unknown) {
    if (errorCode(error) === "TEMPLATE_INTERVIEW_STALE") await journalStale(target, request.censusDigest, request.questionId, request.proposals);
    throw error;
  }
}

async function previewCommit(
  target: WriteTarget,
  request: TemplateInterviewCommitRequest & GuardedTemplateRequest,
): Promise<TemplateTransactionReceipt> {
  const admission = await admitWriteTarget(target);
  if (admission !== undefined) throw new Error(`${admission.code}: ${admission.remediation}`);
  const census = await templateCensus(target.vault);
  if (census.censusDigest !== request.censusDigest) stale("the template census changed; re-read before retrying");
  const snapshot = await readLedgerSnapshot(census.vault);
  if (snapshot.read.digest !== request.expectedLedgerDigest) stale("the interview ledger changed; re-read before retrying");
  const model = makeModel(census, snapshot.answers, snapshot.read.digest, request.proposals);
  const composable = requireComposable(model);
  const manifest = await composeCommitManifest(census, composable.policy, composable.interview);
  const receipt = await executeTemplateTransaction(census.vault, manifest, { dryRun: true });
  const [afterCensus, afterLedger] = await Promise.all([
    templateCensus(target.vault),
    readLedgerSnapshot(census.vault),
  ]);
  if (afterCensus.censusDigest !== request.censusDigest || afterLedger.read.digest !== request.expectedLedgerDigest) {
    stale("the interview snapshot changed during dry-run; re-read before retrying");
  }
  return receipt;
}

/** Replays the reviewed model and publishes only with the user-approved exact approvalDigest. */
export async function commitTemplateContracts(
  target: WriteTarget,
  request: TemplateInterviewCommitRequest,
): Promise<TemplateTransactionReceipt> {
  validateCommitRequest(request);
  if (request.dryRun === true) {
    try {
      return await previewCommit(target, request);
    } catch (error: unknown) {
      if (errorCode(error) === "TEMPLATE_INTERVIEW_STALE") journalCommitStale(target, request.censusDigest);
      throw error;
    }
  }
  try {
    return await withInterviewLedgerLock(
      target,
      {
        expectedLedgerDigest: request.expectedLedgerDigest,
        expectedCensusDigest: request.censusDigest,
        verifyCensus: async () => censusDigestOf(target.vault),
      },
      async locked => {
        const census = await templateCensus(target.vault);
        if (census.censusDigest !== request.censusDigest) stale("the template census changed; re-read before retrying");
        const model = makeModel(census, locked.answers, locked.ledgerDigest, request.proposals);
        const composable = requireComposable(model);
        const manifest = await composeCommitManifest(census, composable.policy, composable.interview);
        return executeTemplateTransaction(census.vault, manifest, request);
      },
    );
  } catch (error: unknown) {
    if (errorCode(error) === "TEMPLATE_INTERVIEW_STALE") journalCommitStale(target, request.censusDigest);
    throw error;
  }
}
