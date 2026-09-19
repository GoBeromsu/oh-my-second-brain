import { readBundledPackageVersion } from "../runtime/assets.js";
import { appendRuntimeEvent, createRuntimeEvent, createRuntimeInvocation } from "../runtime/event-journal.js";
import type { RuntimeEventInput, RuntimeInvocation } from "../runtime/event-types.js";
import { buildTemplateInterview, validateInterviewAnswer, type TemplateInterview, type TemplateInterviewQuestion } from "./interview.js";
import {
  readInterviewLedger,
  withInterviewLedgerLock,
  type InterviewLedger,
  type InterviewLedgerAnswer,
  type InterviewLedgerRead,
} from "./interview-ledger.js";
import { buildReconcileCompositionManifest } from "./reconcile.js";
import { readTemplateReviewContext, type TemplateReviewContext } from "./review-context.js";
import { executeTemplateOperation, type TemplateOperationTarget } from "./operations.js";
import type {
  Diagnostic,
  Digest,
  FileExpectation,
  GuardedTemplateRequest,
  JsonValue,
  TemplateCompositionManifest,
  TemplateId,
  TemplatePolicy,
  TemplateTransactionReceipt,
} from "./types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const BLOCKING = new Set<Diagnostic["code"]>([
  "TEMPLATE_ID_DUPLICATE",
  "TEMPLATE_SOURCE_DUPLICATE",
  "TEMPLATE_SOURCE_INVALID",
  "TEMPLATE_CANDIDATE_INCOMPATIBLE",
  "TEMPLATE_CONTRACT_UNOBSERVED",
  "BASE_CONTRACT_CONFLICT",
  "TEMPLATE_POLICY_DANGLING_FIELD",
  "TEMPLATE_RECLASSIFY_PATH_MISMATCH",
  "OBSIDIAN_TYPE_CONFLICT",
  "TEMPLATE_TYPE_UNRESOLVED",
  "TEMPLATE_EXPRESSION_UNSUPPORTED",
]);

export type TemplateInterviewServiceState = "question" | "confirm" | "unchanged" | "blocked";

export interface TemplateInterviewAnswerRequest {
  readonly questionId: Digest;
  readonly answer: JsonValue;
  readonly censusDigest: Digest;
  readonly expectedLedgerDigest: Digest | null;
}

export interface TemplateInterviewCommitRequest {
  readonly censusDigest: Digest;
  readonly expectedLedgerDigest: Digest | null;
  readonly dryRun?: boolean;
  readonly approvedDigest?: Digest;
}

type CompactControlTransition = Omit<TemplateCompositionManifest["controls"][number], "current" | "proposed"> & {
  readonly current: FileExpectation;
  readonly proposed: FileExpectation;
};

type CompactSourceTransition = Omit<TemplateCompositionManifest["sources"][number], "current" | "proposed"> & {
  readonly current: FileExpectation;
  readonly proposed: FileExpectation;
};

/** Public review proposal metadata; source and control payload bytes never cross this boundary. */
export type TemplateInterviewProposal = Omit<TemplateCompositionManifest, "controls" | "sources"> & {
  readonly controls: readonly [CompactControlTransition, CompactControlTransition, CompactControlTransition];
  readonly sources: readonly CompactSourceTransition[];
};

/** Canonical machine-facing review state; only `next` is exposed, never the full unanswered list. */
export interface TemplateInterviewServiceResult {
  readonly state: TemplateInterviewServiceState;
  readonly censusDigest: Digest;
  readonly expectedLedgerDigest: Digest | null;
  readonly next?: TemplateInterviewQuestion;
  readonly invalidatedQuestionIds: readonly string[];
  readonly reviewedTemplateIds: readonly TemplateId[];
  readonly diagnostics: readonly Diagnostic[];
  readonly proposedPolicy?: TemplatePolicy;
  readonly proposal?: TemplateInterviewProposal;
  readonly approvalDigest?: Digest;
}

interface LedgerSnapshot {
  readonly read: InterviewLedgerRead;
  readonly answers: Readonly<Record<string, InterviewLedgerAnswer>>;
  readonly invalidDiagnostic?: Diagnostic;
}

interface ModelResult {
  readonly context: TemplateReviewContext;
  readonly interview: TemplateInterview;
  readonly ledgerDigest: Digest | null;
  readonly answers: Readonly<Record<string, InterviewLedgerAnswer>>;
  readonly diagnostics: readonly Diagnostic[];
}

function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST.test(value);
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

function diagnostic(code: string, message: string, templateId?: string): Diagnostic {
  return {
    code: code as Diagnostic["code"],
    message,
    ...(templateId === undefined ? {} : { templateId: templateId as TemplateId }),
  };
}

function blocking(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some(item => BLOCKING.has(item.code));
}

function expectation(value: { readonly state: "absent" } | { readonly state: "present"; readonly signature: Digest }): FileExpectation {
  return value.state === "present" ? { state: "present", signature: value.signature } : { state: "absent" };
}

function compactProposal(manifest: TemplateCompositionManifest): TemplateInterviewProposal {
  const compactControl = (control: TemplateCompositionManifest["controls"][number]): CompactControlTransition => ({
    ...control,
    current: expectation(control.current),
    proposed: expectation(control.proposed),
  });
  return {
    ...manifest,
    controls: [
      compactControl(manifest.controls[0]),
      compactControl(manifest.controls[1]),
      compactControl(manifest.controls[2]),
    ],
    sources: manifest.sources.map(source => ({
      ...source,
      current: expectation(source.current),
      proposed: expectation(source.proposed),
    })),
  };
}

const QUESTION_KINDS: ReadonlySet<TemplateInterviewQuestion["kind"]> = new Set([
  "contract-selection",
  "field-type",
  "field-requiredness",
  "field-intent",
  "content-section-requiredness",
  "content-order",
  "naming",
  "deleted-source-disposition",
  "rename-identity",
]);

function isQuestionKind(value: unknown): value is TemplateInterviewQuestion["kind"] {
  return typeof value === "string" && QUESTION_KINDS.has(value as TemplateInterviewQuestion["kind"]);
}

function hasWork(context: TemplateReviewContext): boolean {
  return context.census.diffs.length > 0
    || context.census.diagnostics.length > 0
    || !context.projectionUsable
    || context.freshTemplateIds.length < Object.keys(context.policy.templates).length;
}

function deferredDeletionAnswerIds(
  context: TemplateReviewContext,
  answers: Readonly<Record<string, InterviewLedgerAnswer>>,
): readonly string[] {
  const currentPaths = new Set(context.census.entries.map(entry => entry.sourcePath));
  const deletedBindings = new Map<string, string>(
    Object.values(context.policy.templates)
      .filter(binding =>
        !currentPaths.has(binding.sourcePath)
        && context.census.diffs.some(diff =>
          diff.kind === "deleted"
          && (
            diff.templateId === binding.templateId
            || diff.sourcePath === binding.sourcePath
            || diff.oldSourcePath === binding.sourcePath
          ),
        ))
      .map(binding => [binding.templateId, `deleted:${binding.templateId}:${binding.sourcePath}`] as const),
  );
  return Object.entries(answers)
    .filter(([, answer]) =>
      answer.kind === "deleted-source-disposition"
      && answer.value === "defer"
      && deletedBindings.get(answer.templateId) === answer.subject,
    )
    .map(([questionId]) => questionId);
}

/**
 * A deferred deletion is a durable choice for the last commit, not a
 * permanent acknowledgement of a still-missing source. Re-open only in the
 * in-memory model used by an explicit next/review (or to validate its answer);
 * the persisted ledger remains the user's last committed draft until an
 * answer is submitted.
 */
function reopenDeferredDeletionAnswers(
  context: TemplateReviewContext,
  answers: Readonly<Record<string, InterviewLedgerAnswer>>,
): Readonly<Record<string, InterviewLedgerAnswer>> {
  const ids = new Set(deferredDeletionAnswerIds(context, answers));
  if (ids.size === 0) return answers;
  return Object.fromEntries(Object.entries(answers).filter(([questionId]) => !ids.has(questionId)));
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
  ) throw codedError("TEMPLATE_RECONCILE_INVALID", "census/ledger CAS and guarded request are invalid");
}

function appendEvent(vault: string, invocation: RuntimeInvocation, input: RuntimeEventInput): void {
  try {
    appendRuntimeEvent(createRuntimeEvent(invocation, input), { vaultPath: vault });
  } catch {
    // Runtime history is external and non-authoritative for the review/write result.
  }
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

function journalDiffs(context: TemplateReviewContext, invocation: RuntimeInvocation): void {
  for (const diff of context.census.diffs) {
    appendEvent(context.vault, invocation, {
      kind: `template-interview-census-${diff.kind}`,
      outcome: "observation-gap",
      ...(diff.templateId === undefined ? {} : { templateId: diff.templateId }),
      notePath: diff.sourcePath,
      inputSignature: context.censusDigest,
    });
  }
}

function journalInterview(
  interview: TemplateInterview,
  context: TemplateReviewContext,
  answers: Readonly<Record<string, InterviewLedgerAnswer>>,
): void {
  if (interview.next !== undefined) {
    questionEvent(
      context.vault,
      "shown",
      interview.next.questionId,
      interview.next.kind,
      context.censusDigest,
      interview.next.templateId,
    );
  }
  const questionsById = new Map<string, TemplateInterviewQuestion>(interview.questions.map(question => [question.questionId, question]));
  interview.invalidatedQuestionIds.forEach(questionId => {
    const question = questionsById.get(questionId);
    const answer = answers[questionId];
    const kind = question?.kind ?? (isQuestionKind(answer?.kind) ? answer.kind : undefined);
    if (kind === undefined) return;
    questionEvent(
      context.vault,
      "invalidated",
      questionId as Digest,
      kind,
      context.censusDigest,
      question?.templateId ?? answer?.templateId,
    );
  });
}

async function resultFromModel(
  model: ModelResult,
  invocation: RuntimeInvocation,
): Promise<TemplateInterviewServiceResult> {
  const { context, interview, ledgerDigest } = model;
  journalDiffs(context, invocation);
  journalInterview(interview, context, model.answers);
  const base = {
    censusDigest: context.censusDigest,
    expectedLedgerDigest: ledgerDigest,
    invalidatedQuestionIds: interview.invalidatedQuestionIds,
    reviewedTemplateIds: interview.reviewedTemplateIds,
    diagnostics: model.diagnostics,
  };
  if (interview.next !== undefined) return { state: "question", next: interview.next, ...base };
  if (blocking(model.diagnostics) || interview.proposedPolicy === undefined) {
    return { state: "blocked", ...base };
  }
  if (!hasWork(context)) return { state: "unchanged", ...base };
  const change = reconcileChange(model);
  const proposal = compactProposal(await buildReconcileCompositionManifest(context.vault, change));
  return {
    state: "confirm" as const,
    ...base,
    proposedPolicy: interview.proposedPolicy,
    proposal,
    approvalDigest: proposal.approvalDigest,
  };
}

type ReconcileChange = Extract<import("./types.js").TemplateSemanticChange, { readonly mode: "reconcile" }>;

function makeModel(
  context: TemplateReviewContext,
  answers: Readonly<Record<string, InterviewLedgerAnswer>>,
  ledgerDigest: Digest | null,
  extraDiagnostics: readonly Diagnostic[] = [],
): ModelResult {
  const interview = buildTemplateInterview(context, answers);
  return {
    context,
    interview,
    ledgerDigest,
    answers,
    diagnostics: [...extraDiagnostics, ...interview.diagnostics],
  };
}

function reconcileChange(model: ModelResult): ReconcileChange {
  if (model.interview.next !== undefined) stale("interview questions remain unanswered");
  if (model.interview.proposedPolicy === undefined || blocking(model.diagnostics)) {
    throw codedError("TEMPLATE_RECONCILE_REVIEW_REQUIRED", "interview did not produce an approvable policy");
  }
  return {
    mode: "reconcile",
    census: model.context.census,
    ledgerDigest: model.ledgerDigest,
    answers: model.answers,
    proposedPolicy: model.interview.proposedPolicy,
    reviewedTemplateIds: model.interview.reviewedTemplateIds,
  };
}

async function model(
  context: TemplateReviewContext,
  answers: Readonly<Record<string, InterviewLedgerAnswer>>,
  ledgerDigest: Digest | null,
  invocation: RuntimeInvocation,
  extraDiagnostics: readonly Diagnostic[] = [],
): Promise<TemplateInterviewServiceResult> {
  const current = makeModel(context, answers, ledgerDigest, extraDiagnostics);
  return resultFromModel(current, invocation);
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

function stale(message: string): never {
  throw codedError("TEMPLATE_INTERVIEW_STALE", message);
}

async function questionForId(
  target: TemplateOperationTarget,
  questionId: Digest,
): Promise<{ readonly kind: TemplateInterviewQuestion["kind"]; readonly templateId: string } | undefined> {
  try {
    const context = await readTemplateReviewContext(target.vault);
    const snapshot = await readLedgerSnapshot(context.vault);
    const interview = buildTemplateInterview(context, snapshot.answers);
    const question = interview.questions.find(item => item.questionId === questionId);
    if (question !== undefined) return { kind: question.kind, templateId: question.templateId };
    const answer = snapshot.answers[questionId];
    if (answer !== undefined && isQuestionKind(answer.kind)) return { kind: answer.kind, templateId: answer.templateId };
  } catch {
    // Stale telemetry cannot change the authoritative rejection.
  }
  return undefined;
}

async function journalStale(target: TemplateOperationTarget, input: Digest, questionId: Digest): Promise<void> {
  const question = await questionForId(target, questionId);
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

function journalCommitStale(target: TemplateOperationTarget, input: Digest): void {
  const invocation = createRuntimeInvocation({ surface: "kernel", operation: "template-interview-commit-stale", packageVersion: readBundledPackageVersion() });
  appendEvent(target.vault, invocation, { kind: "template-interview-stale", outcome: "rejected", inputSignature: input });
}

function recordCommitEvent(vault: string, receipt: TemplateTransactionReceipt): void {
  const outcome = receipt.status === "applied"
    ? "success"
    : receipt.status === "rejected"
      ? "rejected"
      : receipt.status === "inconsistent"
        ? "failure"
        : "unchanged";
  const approvalDigest = receipt.status === "applied" || receipt.status === "already-complete"
    ? receipt.approvedDigest
    : "none";
  const operation = `template-contract-commit:approvalDigest=${approvalDigest}`;
  const transactionId = receipt.status === "applied" || receipt.status === "already-complete"
    ? receipt.transactionId
    : undefined;
  appendEvent(vault, createRuntimeInvocation({
    surface: "kernel",
    operation,
    packageVersion: readBundledPackageVersion(),
  }), {
    kind: "template-contract-commit",
    outcome,
    ...(transactionId === undefined ? {} : { transactionId }),
    inputSignature: "inputDigest" in receipt ? receipt.inputDigest : receipt.proposedInputDigest,
  });
  if (receipt.status !== "applied" && receipt.status !== "already-complete") return;
  for (const path of receipt.writtenPaths) {
    if (!path.startsWith(".oms/")) continue;
    appendEvent(vault, createRuntimeInvocation({
      surface: "kernel",
      operation: `template-contract-commit-control:approvalDigest=${approvalDigest}`,
      packageVersion: readBundledPackageVersion(),
    }), {
      kind: "template-contract-commit-control",
      outcome: receipt.status === "applied" ? "success" : "unchanged",
      transactionId,
      notePath: path,
      inputSignature: receipt.inputDigest,
    });
  }
}

/** Reads the current review model without writing the vault or interview ledger. */
export async function nextTemplateInterview(target: TemplateOperationTarget): Promise<TemplateInterviewServiceResult> {
  const invocation = createRuntimeInvocation({ surface: "kernel", operation: "template-interview-next", packageVersion: readBundledPackageVersion() });
  const context = await readTemplateReviewContext(target.vault);
  const snapshot = await readLedgerSnapshot(context.vault);
  try {
    if (snapshot.invalidDiagnostic !== undefined) {
      appendEvent(context.vault, invocation, {
        kind: "template-interview-ledger-invalid",
        outcome: "rejected",
        inputSignature: context.censusDigest,
      });
    }
    const answers = reopenDeferredDeletionAnswers(context, snapshot.answers);
    return await model(
      context,
      answers,
      snapshot.read.digest,
      invocation,
      snapshot.invalidDiagnostic === undefined ? [] : [snapshot.invalidDiagnostic],
    );
  } catch (error: unknown) {
    return {
      state: "blocked",
      censusDigest: context.censusDigest,
      expectedLedgerDigest: snapshot.read.digest,
      invalidatedQuestionIds: [],
      reviewedTemplateIds: [],
      diagnostics: [diagnostic(errorCode(error), error instanceof Error ? error.message : String(error))],
    };
  }
}

/** Validates and persists one answer under a census/ledger CAS lock, then returns only the next question. */
export async function answerTemplateInterview(
  target: TemplateOperationTarget,
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
        verifyCensus: async () => (await readTemplateReviewContext(target.vault)).censusDigest,
      },
      async locked => {
        const context = await readTemplateReviewContext(target.vault);
        if (context.censusDigest !== request.censusDigest) stale("the template census changed; re-read before retrying");
        let answersForInterview = locked.answers;
        let interview = buildTemplateInterview(context, answersForInterview);
        if (interview.next?.questionId !== request.questionId) {
          const reopenedAnswers = reopenDeferredDeletionAnswers(context, locked.answers);
          if (reopenedAnswers !== locked.answers) {
            const reopenedInterview = buildTemplateInterview(context, reopenedAnswers);
            if (reopenedInterview.next?.questionId === request.questionId) {
              answersForInterview = reopenedAnswers;
              interview = reopenedInterview;
            }
          }
        }
        const question = interview.next;
        if (question === undefined || question.questionId !== request.questionId) stale("the answer does not match the current interview question");
        let accepted: InterviewLedgerAnswer;
        try {
          accepted = validateInterviewAnswer(question, request.answer);
        } catch (error: unknown) {
          questionEvent(
            context.vault,
            "invalidated",
            question.questionId,
            question.kind,
            context.censusDigest,
            question.templateId,
          );
          throw error;
        }
        const prior = locked.answers[question.questionId];
        const answers = {
          ...locked.answers,
          [question.questionId]: { ...(prior ?? {}), ...accepted },
        };
        const base: InterviewLedger = locked.ledger === null
          ? { version: 1, censusDigest: request.censusDigest, answers }
          : { ...locked.ledger, censusDigest: request.censusDigest, answers };
        const saved = await locked.save(base);
        questionEvent(
          context.vault,
          "answered",
          question.questionId,
          question.kind,
          context.censusDigest,
          question.templateId,
        );
        return model(context, answers, saved.digest, invocation);
      },
    );
  } catch (error: unknown) {
    if (errorCode(error) === "TEMPLATE_INTERVIEW_STALE") await journalStale(target, request.censusDigest, request.questionId);
    throw error;
  }
}

/** Replays the reviewed model and composes/executes a guarded reconcile while retaining one ledger lock. */
export async function commitTemplateContracts(
  target: TemplateOperationTarget,
  request: TemplateInterviewCommitRequest,
): Promise<TemplateTransactionReceipt> {
  validateCommitRequest(request);
  if (request.dryRun === true) {
    try {
      const context = await readTemplateReviewContext(target.vault);
      if (context.censusDigest !== request.censusDigest) stale("the template census changed; re-read before retrying");
      const snapshot = await readLedgerSnapshot(context.vault);
      if (snapshot.read.digest !== request.expectedLedgerDigest) stale("the interview ledger changed; re-read before retrying");
      const model = makeModel(context, snapshot.answers, snapshot.read.digest);
      const change = reconcileChange(model);
      const receipt = await executeTemplateOperation(target, change, request);
      const [afterContext, afterLedger] = await Promise.all([
        readTemplateReviewContext(target.vault),
        readLedgerSnapshot(context.vault),
      ]);
      if (afterContext.censusDigest !== request.censusDigest || afterLedger.read.digest !== request.expectedLedgerDigest) {
        stale("the interview snapshot changed during dry-run; re-read before retrying");
      }
      recordCommitEvent(target.vault, receipt);
      return receipt;
    } catch (error: unknown) {
      if (errorCode(error) === "TEMPLATE_INTERVIEW_STALE" || errorCode(error) === "TEMPLATE_RECONCILE_STALE") {
        journalCommitStale(target, request.censusDigest);
      }
      throw error;
    }
  }
  try {
    return await withInterviewLedgerLock(
      target,
      {
        expectedLedgerDigest: request.expectedLedgerDigest,
        expectedCensusDigest: request.censusDigest,
        verifyCensus: async () => (await readTemplateReviewContext(target.vault)).censusDigest,
      },
      async locked => {
        const context = await readTemplateReviewContext(target.vault);
        if (context.censusDigest !== request.censusDigest) stale("the template census changed; re-read before retrying");
        const change = reconcileChange(makeModel(context, locked.answers, locked.ledgerDigest));
        const receipt = await executeTemplateOperation(target, change, request);
        recordCommitEvent(context.vault, receipt);
        return receipt;
      },
    );
  } catch (error: unknown) {
    if (errorCode(error) === "TEMPLATE_INTERVIEW_STALE" || errorCode(error) === "TEMPLATE_RECONCILE_STALE") {
      journalCommitStale(target, request.censusDigest);
    }
    throw error;
  }
}
