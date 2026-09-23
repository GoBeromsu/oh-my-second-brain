import { digestBytes, hashCanonical } from "./canonical.js";
import type { CensusBinding, CensusResult } from "./census.js";
import { parseTemplatePolicy } from "./policy.js";
import { normalizeTemplateSourcePath, validateTemplateId } from "./paths.js";
import type {
  CompletionCriterion,
  CompletionPolicy,
  Digest,
  HeadingContract,
  HeadingOrder,
  JsonValue,
  LayerFieldRef,
  ManagedTemplatePath,
  PropertyDefinition,
  TemplateId,
  TemplatePolicy,
  TemplateSourcePath,
} from "./types.js";

/**
 * Explicit v4 proposal questions. One question is current. Free answers stay
 * raw: this module does not turn them into fields, headings, criteria,
 * placements, or repair settings, and it does not write a ledger or vault.
 * The anchor is computed here. Callers cannot supply a replacement anchor.
 */

export const TEMPLATE_INTERVIEW_QUESTION_DOMAIN = "oms.template-interview.question.v4";
export const TEMPLATE_INTERVIEW_ANCHOR_DOMAIN = "oms.template-interview.anchor.v4";

export type TemplateInterviewQuestionKind = "pool" | "default-layer" | "individual" | "taxonomy-placement" | "completion";
export type TemplateInterviewDisposition = "confirm" | "defer" | "unresolved";

export interface TemplateInterviewDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly templateId?: string;
}

export interface PoolTemplateProposal {
  readonly kind: "pool";
  readonly properties: Readonly<Record<string, PropertyDefinition>>;
}

export interface DefaultLayerProposal {
  readonly kind: "default-layer";
  readonly templatePath: ManagedTemplatePath;
  readonly approvedMarkdown: "";
  readonly approvedMarkdownDigest: Digest;
  readonly headingOrder: "unordered";
  readonly fields: Readonly<Record<string, LayerFieldRef>>;
  readonly headings: readonly HeadingContract[];
  readonly semanticCriteria: readonly CompletionCriterion[];
}

export interface IndividualTemplateProposal {
  readonly kind: "individual";
  readonly templateId: TemplateId;
  readonly templatePath: ManagedTemplatePath;
  readonly fields: Readonly<Record<string, LayerFieldRef>>;
  readonly headings: readonly HeadingContract[];
  readonly semanticCriteria: readonly CompletionCriterion[];
  /** Null inherits the approved order. A declared value can only be confirmed explicitly. */
  readonly headingOrder: HeadingOrder | null;
  readonly source: {
    readonly path: TemplateSourcePath;
    readonly identity: string;
    readonly rawDigest: Digest;
  } | null;
}

export interface TaxonomyPlacementProposal {
  readonly kind: "taxonomy-placement";
  readonly templateId: TemplateId | null;
  readonly placement: JsonValue | null;
}

export interface CompletionConfigProposal {
  readonly kind: "completion";
  readonly retryBudget: number;
  readonly agentRepair: CompletionPolicy["agentRepair"];
}

export type TemplateProposal =
  | PoolTemplateProposal
  | DefaultLayerProposal
  | IndividualTemplateProposal
  | TaxonomyPlacementProposal
  | CompletionConfigProposal;

export interface TemplatePoolProposalInput {
  readonly kind: "pool";
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface TemplateIndividualProposalInput {
  readonly kind: "individual";
  readonly templateId: string;
  readonly sourcePath?: string;
  readonly sourceIdentity?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly headings?: readonly unknown[];
  readonly semanticCriteria?: readonly unknown[];
  readonly headingOrder?: HeadingOrder;
}

export interface TemplatePlacementProposalInput {
  readonly kind: "taxonomy-placement";
  readonly templateId: string;
  readonly placement: JsonValue | null;
}

export interface TemplateCompletionProposalInput {
  readonly kind: "completion";
  readonly retryBudget?: number;
  readonly agentRepair?: {
    readonly enabled?: boolean;
    readonly contexts?: readonly ("post-write" | "maintenance")[];
  };
}

export type TemplateProposalInput =
  | TemplatePoolProposalInput
  | TemplateIndividualProposalInput
  | TemplatePlacementProposalInput
  | TemplateCompletionProposalInput;

export interface TemplateInterviewQuestion {
  readonly questionId: Digest;
  readonly kind: TemplateInterviewQuestionKind;
  readonly subject: string;
  readonly prompt: string;
  readonly proposal: TemplateProposal;
  /** Binds the relevant source bytes, approved evidence, and approved snapshot. */
  readonly anchorDigest: Digest;
  /** Binds the raw candidate snapshot from census. Not an anchor override. */
  readonly censusDigest: Digest;
}

export interface TemplateInterviewAnswer {
  readonly questionId: Digest;
  readonly anchorDigest: Digest;
  readonly censusDigest: Digest;
  readonly disposition: TemplateInterviewDisposition;
  readonly raw: string;
}

export interface TemplateInterviewResolution {
  readonly questionId: Digest;
  readonly anchorDigest: Digest;
  readonly disposition: TemplateInterviewDisposition;
  readonly raw: string;
  readonly proposal: TemplateProposal;
}

export interface TemplateInterview {
  readonly authority: CensusResult["authority"];
  readonly censusDigest: Digest;
  /** Ordered queue. Ask `next` only; the rest is resume state for the ledger service. */
  readonly questions: readonly TemplateInterviewQuestion[];
  readonly next?: TemplateInterviewQuestion;
  readonly confirmed: readonly TemplateInterviewResolution[];
  readonly deferred: readonly TemplateInterviewResolution[];
  readonly unresolved: readonly TemplateInterviewResolution[];
  readonly invalidatedQuestionIds: readonly Digest[];
  readonly diagnostics: readonly TemplateInterviewDiagnostic[];
}

export interface TemplateInterviewOptions {
  readonly proposals?: readonly TemplateProposalInput[];
  readonly answers?: readonly TemplateInterviewAnswer[] | Readonly<Record<string, TemplateInterviewAnswer>>;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const DISPOSITIONS = new Set<TemplateInterviewDisposition>(["confirm", "defer", "unresolved"]);
const ANSWER_KEYS = new Set(["disposition", "raw", "questionId", "anchorDigest", "censusDigest"]);
const EMPTY_MARKDOWN_DIGEST = digestBytes("");

interface QuestionDraft {
  readonly kind: TemplateInterviewQuestionKind;
  readonly subject: string;
  readonly prompt: string;
  readonly proposal: TemplateProposal;
  readonly approvedMarkdownDigest: Digest | null;
  readonly sourceRawDigest: Digest | null;
  readonly approvedRawDigest: Digest | null;
}

function compareText(left: string, right: string): number {
  const leftCodes = Array.from(left, character => character.codePointAt(0) ?? 0);
  const rightCodes = Array.from(right, character => character.codePointAt(0) ?? 0);
  const length = Math.min(leftCodes.length, rightCodes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftCodes[index]! - rightCodes[index]!;
    if (difference !== 0) return difference;
  }
  return leftCodes.length - rightCodes.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  const code = errorMessage(error).split(":", 1)[0] ?? "";
  return /^[A-Z][A-Z0-9_]*$/u.test(code) ? code : "TEMPLATE_PROPOSAL_INVALID";
}

function diagnostic(code: string, message: string, path?: string, templateId?: string): TemplateInterviewDiagnostic {
  return {
    code,
    message,
    ...(path === undefined ? {} : { path }),
    ...(templateId === undefined ? {} : { templateId }),
  };
}

function pushError(diagnostics: TemplateInterviewDiagnostic[], error: unknown, path?: string, templateId?: string): void {
  diagnostics.push(diagnostic(errorCode(error), errorMessage(error), path, templateId));
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function emptyPolicy(): TemplatePolicy {
  return parseTemplatePolicy({
    version: 4,
    properties: {},
    default: {
      templatePath: ".oms/templates/default.md",
      approvedMarkdown: "",
      approvedMarkdownDigest: EMPTY_MARKDOWN_DIGEST,
      fields: {},
      headings: [],
      semanticCriteria: [],
    },
    templates: {},
  });
}

function ownedProperties(census: CensusResult, extra: Readonly<Record<string, PropertyDefinition>>): Readonly<Record<string, PropertyDefinition>> {
  return { ...(census.approvedPolicy?.properties ?? {}), ...extra };
}

function acceptPool(
  census: CensusResult,
  input: TemplatePoolProposalInput,
  diagnostics: TemplateInterviewDiagnostic[],
): Readonly<Record<string, PropertyDefinition>> | null {
  try {
    if (!isRecord(input.properties)) throw new Error("TEMPLATE_PROPOSAL_INVALID: property pool must be an object");
    const approved = census.approvedPolicy?.properties ?? {};
    for (const name of Object.keys(input.properties)) {
      if (Object.hasOwn(approved, name)) throw new Error(`TEMPLATE_PROPOSAL_INVALID: property ${name} is already in the approved pool`);
    }
    const parsed = parseTemplatePolicy({
      version: 4,
      properties: { ...approved, ...input.properties },
      default: census.approvedPolicy?.default ?? emptyPolicy().default,
      templates: {},
      ...(census.approvedPolicy === null ? {} : { completion: census.approvedPolicy.completion }),
    });
    const properties: Record<string, PropertyDefinition> = {};
    for (const name of Object.keys(input.properties).sort(compareText)) {
      const definition = parsed.properties[name];
      if (definition === undefined) throw new Error(`TEMPLATE_PROPOSAL_INVALID: property ${name} was not accepted`);
      properties[name] = definition;
    }
    return plain(properties);
  } catch (error: unknown) {
    pushError(diagnostics, error);
    return null;
  }
}

function sourceOwner(census: CensusResult, path: string): CensusBinding | undefined {
  return census.bindings.find(binding =>
    (binding.status === "matched" || binding.status === "drift" || binding.status === "relocated")
    && (binding.observedPath === path || binding.approvedPath === path));
}

function acceptIndividual(
  census: CensusResult,
  input: TemplateIndividualProposalInput,
  pool: Readonly<Record<string, PropertyDefinition>>,
  diagnostics: TemplateInterviewDiagnostic[],
): IndividualTemplateProposal | null {
  let templateId: TemplateId;
  try {
    templateId = validateTemplateId(input.templateId);
  } catch (error: unknown) {
    pushError(diagnostics, error, undefined, input.templateId);
    return null;
  }
  if (templateId === "default") {
    diagnostics.push(diagnostic("TEMPLATE_ID_INVALID", "template id default is reserved for the always-on default layer", undefined, templateId));
    return null;
  }
  const existing = census.approvedPolicy?.templates[templateId];
  let sourcePath: TemplateSourcePath | null = null;
  let sourceIdentity: string | null = null;
  let sourceRawDigest: Digest | null = null;
  if (input.sourcePath !== undefined) {
    if (typeof input.sourceIdentity !== "string" || input.sourceIdentity.trim() === "") {
      diagnostics.push(diagnostic(
        "TEMPLATE_PROPOSAL_INVALID",
        "Source identity must be supplied explicitly and is not derived from the file name",
        input.sourcePath,
        templateId,
      ));
      return null;
    }
    try {
      sourcePath = normalizeTemplateSourcePath(input.sourcePath);
    } catch (error: unknown) {
      pushError(diagnostics, error, input.sourcePath, templateId);
      return null;
    }
    const observed = census.sources.find(source => source.path === sourcePath);
    if (observed === undefined) {
      diagnostics.push(diagnostic("TEMPLATE_SOURCE_INVALID", "Proposed source was not in the raw census", sourcePath, templateId));
      return null;
    }
    const owner = sourceOwner(census, sourcePath);
    if (owner !== undefined && owner.templateId !== templateId) {
      diagnostics.push(diagnostic("TEMPLATE_SOURCE_DUPLICATE", `Raw source ${sourcePath} is already bound to ${owner.templateId}`, sourcePath, templateId));
      return null;
    }
    sourceIdentity = input.sourceIdentity;
    sourceRawDigest = observed.rawDigest;
  } else if (input.sourceIdentity !== undefined) {
    diagnostics.push(diagnostic("TEMPLATE_PROPOSAL_INVALID", "Source identity requires an explicit source path", undefined, templateId));
    return null;
  }
  try {
    const parsed = parseTemplatePolicy({
      version: 4,
      properties: ownedProperties(census, pool),
      default: census.approvedPolicy?.default ?? emptyPolicy().default,
      templates: {
        [templateId]: {
          templateId,
          templatePath: `.oms/templates/${templateId}.md`,
          approvedMarkdown: "",
          approvedMarkdownDigest: EMPTY_MARKDOWN_DIGEST,
          fields: input.fields ?? {},
          headings: input.headings ?? [],
          semanticCriteria: input.semanticCriteria ?? [],
          ...(input.headingOrder === undefined ? {} : { headingOrder: input.headingOrder }),
          ...(sourcePath === null || sourceIdentity === null || sourceRawDigest === null ? {} : {
            source: { path: sourcePath, identity: sourceIdentity, rawDigest: sourceRawDigest },
          }),
        },
      },
      ...(census.approvedPolicy === null ? {} : { completion: census.approvedPolicy.completion }),
    });
    const layer = parsed.templates[templateId];
    if (layer === undefined) throw new Error("TEMPLATE_PROPOSAL_INVALID: individual template was not accepted");
    if (existing !== undefined) {
      const fieldClash = Object.keys(layer.fields).some(key => Object.hasOwn(existing.fields, key));
      const headingClash = layer.headings.some(heading => existing.headings.some(item => item.headingId === heading.headingId));
      const criterionClash = layer.semanticCriteria.some(criterion => existing.semanticCriteria.some(item => item.criterionId === criterion.criterionId));
      if (fieldClash || headingClash || criterionClash) {
        throw new Error(`TEMPLATE_PROPOSAL_INVALID: template ${templateId} can only add new fields, headings, or criteria`);
      }
      const additions = Object.keys(layer.fields).length + layer.headings.length + layer.semanticCriteria.length;
      const orderChange = input.headingOrder !== undefined && input.headingOrder !== (existing.headingOrder ?? "unordered");
      const previousSource = existing.source;
      const proposedSource = layer.source;
      const sourceChange = proposedSource !== undefined && (
        previousSource?.path !== proposedSource.path
        || previousSource?.rawDigest !== proposedSource.rawDigest
        || previousSource?.identity !== proposedSource.identity
      );
      if (additions === 0 && !orderChange && !sourceChange) {
        throw new Error(`TEMPLATE_PROPOSAL_INVALID: template ${templateId} has no additive change`);
      }
    }
    return plain({
      kind: "individual",
      templateId,
      templatePath: `.oms/templates/${templateId}.md` as ManagedTemplatePath,
      fields: layer.fields,
      headings: layer.headings,
      semanticCriteria: layer.semanticCriteria,
      headingOrder: input.headingOrder ?? null,
      source: layer.source === undefined ? null : {
        path: layer.source.path,
        identity: layer.source.identity,
        rawDigest: layer.source.rawDigest,
      },
    });
  } catch (error: unknown) {
    pushError(diagnostics, error, sourcePath ?? undefined, templateId);
    return null;
  }
}

function acceptPlacement(input: TemplatePlacementProposalInput, diagnostics: TemplateInterviewDiagnostic[]): TaxonomyPlacementProposal | null {
  let templateId: TemplateId;
  try {
    templateId = validateTemplateId(input.templateId);
    hashCanonical("oms.template-interview.placement.v4", { placement: input.placement });
  } catch (error: unknown) {
    pushError(diagnostics, error, undefined, typeof input.templateId === "string" ? input.templateId : undefined);
    return null;
  }
  return { kind: "taxonomy-placement", templateId, placement: plain(input.placement) };
}

function acceptCompletion(input: TemplateCompletionProposalInput, diagnostics: TemplateInterviewDiagnostic[]): CompletionConfigProposal | null {
  try {
    const parsed = parseTemplatePolicy({
      version: 4,
      properties: {},
      default: emptyPolicy().default,
      templates: {},
      completion: { retryBudget: input.retryBudget, agentRepair: input.agentRepair },
    });
    return plain({
      kind: "completion",
      retryBudget: parsed.completion.retryBudget,
      agentRepair: parsed.completion.agentRepair,
    });
  } catch (error: unknown) {
    pushError(diagnostics, error);
    return null;
  }
}

function draftsFor(census: CensusResult, proposals: readonly TemplateProposalInput[], diagnostics: TemplateInterviewDiagnostic[]): QuestionDraft[] {
  let poolInput: TemplatePoolProposalInput | null = null;
  const individuals: TemplateIndividualProposalInput[] = [];
  const placements: TemplatePlacementProposalInput[] = [];
  let completionInput: TemplateCompletionProposalInput | null = null;
  for (const proposal of proposals) {
    if (!isRecord(proposal) || typeof proposal.kind !== "string") {
      diagnostics.push(diagnostic("TEMPLATE_PROPOSAL_INVALID", "Proposal must declare a kind"));
      continue;
    }
    if (proposal.kind === "pool") {
      if (poolInput !== null) diagnostics.push(diagnostic("TEMPLATE_PROPOSAL_INVALID", "Only one property-pool proposal is accepted"));
      else poolInput = proposal as TemplatePoolProposalInput;
    } else if (proposal.kind === "individual") individuals.push(proposal as TemplateIndividualProposalInput);
    else if (proposal.kind === "taxonomy-placement") placements.push(proposal as TemplatePlacementProposalInput);
    else if (proposal.kind === "completion") {
      if (completionInput !== null) diagnostics.push(diagnostic("TEMPLATE_PROPOSAL_INVALID", "Only one completion proposal is accepted"));
      else completionInput = proposal as TemplateCompletionProposalInput;
    } else diagnostics.push(diagnostic("TEMPLATE_PROPOSAL_INVALID", `Unknown proposal kind ${proposal.kind}`));
  }

  const drafts: QuestionDraft[] = [];
  const pool = poolInput === null
    ? census.authority === "absent" ? {} : null
    : acceptPool(census, poolInput, diagnostics);
  if (pool !== null && (poolInput !== null || census.authority === "absent")) {
    drafts.push({
      kind: "pool",
      subject: "pool",
      prompt: "Define the user-owned property pool. Only explicit property definitions in this proposal are available; the free-text answer is stored raw and is not parsed into properties.",
      proposal: { kind: "pool", properties: pool },
      approvedMarkdownDigest: null,
      sourceRawDigest: null,
      approvedRawDigest: null,
    });
  }
  if (census.authority === "absent") {
    drafts.push({
      kind: "default-layer",
      subject: "default",
      prompt: "Confirm the always-on default layer. It is empty: no fields, headings, or semantic criteria, and its approved markdown is empty. The default body is not classified.",
      proposal: {
        kind: "default-layer",
        templatePath: ".oms/templates/default.md" as ManagedTemplatePath,
        approvedMarkdown: "",
        approvedMarkdownDigest: EMPTY_MARKDOWN_DIGEST,
        headingOrder: "unordered",
        fields: {},
        headings: [],
        semanticCriteria: [],
      },
      approvedMarkdownDigest: EMPTY_MARKDOWN_DIGEST,
      sourceRawDigest: null,
      approvedRawDigest: null,
    });
  }

  const individualCounts = new Map<string, number>();
  for (const input of individuals) {
    const key = typeof input.templateId === "string" ? input.templateId : "";
    individualCounts.set(key, (individualCounts.get(key) ?? 0) + 1);
  }
  const acceptedIndividuals: IndividualTemplateProposal[] = [];
  for (const input of individuals) {
    const key = typeof input.templateId === "string" ? input.templateId : "";
    if ((individualCounts.get(key) ?? 0) > 1) {
      diagnostics.push(diagnostic("TEMPLATE_ID_DUPLICATE", `Individual proposal ${key} is duplicated`, undefined, key));
      continue;
    }
    const accepted = acceptIndividual(census, input, pool ?? {}, diagnostics);
    if (accepted !== null) acceptedIndividuals.push(accepted);
  }
  acceptedIndividuals.sort((left, right) => compareText(left.templateId, right.templateId));
  for (const proposal of acceptedIndividuals) {
    const existing = census.approvedPolicy?.templates[proposal.templateId];
    drafts.push({
      kind: "individual",
      subject: `individual:${proposal.templateId}`,
      prompt: `Confirm the explicit individual template ${proposal.templateId}${proposal.source === null ? "" : ` for raw source ${proposal.source.path}`}. Fields, headings, semantic criteria, and the template id come only from this proposal, not from the file name or source syntax.`,
      proposal,
      approvedMarkdownDigest: existing?.approvedMarkdownDigest ?? null,
      sourceRawDigest: proposal.source?.rawDigest ?? null,
      approvedRawDigest: existing?.source?.rawDigest ?? null,
    });
  }

  const placementCounts = new Map<string, number>();
  for (const input of placements) {
    const key = typeof input.templateId === "string" ? input.templateId : "";
    placementCounts.set(key, (placementCounts.get(key) ?? 0) + 1);
  }
  const acceptedPlacements: TaxonomyPlacementProposal[] = [];
  for (const input of placements) {
    const key = typeof input.templateId === "string" ? input.templateId : "";
    if ((placementCounts.get(key) ?? 0) > 1) {
      diagnostics.push(diagnostic("TEMPLATE_ID_DUPLICATE", `Placement proposal ${key} is duplicated`, undefined, key));
      continue;
    }
    const accepted = acceptPlacement(input, diagnostics);
    if (accepted !== null) acceptedPlacements.push(accepted);
  }
  if (placements.length === 0 && census.authority === "absent") {
    drafts.push({
      kind: "taxonomy-placement",
      subject: "placement",
      prompt: "Confirm that no taxonomy placement is proposed. Folders and notes are not scanned for a placement.",
      proposal: { kind: "taxonomy-placement", templateId: null, placement: null },
      approvedMarkdownDigest: null,
      sourceRawDigest: null,
      approvedRawDigest: null,
    });
  }
  acceptedPlacements.sort((left, right) => compareText(left.templateId ?? "", right.templateId ?? ""));
  for (const proposal of acceptedPlacements) {
    drafts.push({
      kind: "taxonomy-placement",
      subject: `placement:${proposal.templateId}`,
      prompt: `Confirm the explicit taxonomy placement for ${proposal.templateId}. No folder or note is inferred.`,
      proposal,
      approvedMarkdownDigest: null,
      sourceRawDigest: null,
      approvedRawDigest: null,
    });
  }

  const completion = completionInput === null
    ? census.authority === "absent"
      ? { kind: "completion" as const, retryBudget: emptyPolicy().completion.retryBudget, agentRepair: emptyPolicy().completion.agentRepair }
      : null
    : acceptCompletion(completionInput, diagnostics);
  if (completion !== null && (completionInput !== null || census.authority === "absent")) {
    drafts.push({
      kind: "completion",
      subject: "completion",
      prompt: "Confirm the user-owned completion retry budget and agent repair settings. These settings are not inferred from notes and do not by themselves change contract identity.",
      proposal: completion,
      approvedMarkdownDigest: null,
      sourceRawDigest: null,
      approvedRawDigest: null,
    });
  }
  return drafts;
}

function questionFor(draft: QuestionDraft, census: CensusResult, diagnostics: TemplateInterviewDiagnostic[]): TemplateInterviewQuestion | null {
  const proposal = plain(draft.proposal);
  let questionId: Digest;
  let anchor: Digest;
  try {
    questionId = hashCanonical(TEMPLATE_INTERVIEW_QUESTION_DOMAIN, { kind: draft.kind, subject: draft.subject });
    anchor = hashCanonical(TEMPLATE_INTERVIEW_ANCHOR_DOMAIN, {
      kind: draft.kind,
      subject: draft.subject,
      proposal,
      generationDigest: census.generationDigest,
      approvedMarkdownDigest: draft.approvedMarkdownDigest,
      sourceRawDigest: draft.sourceRawDigest,
      approvedRawDigest: draft.approvedRawDigest,
    });
  } catch (error: unknown) {
    pushError(diagnostics, error);
    return null;
  }
  return {
    questionId,
    kind: draft.kind,
    subject: draft.subject,
    prompt: draft.prompt,
    proposal,
    anchorDigest: anchor,
    censusDigest: census.censusDigest,
  };
}

function storedAnswers(value: TemplateInterviewOptions["answers"], diagnostics: TemplateInterviewDiagnostic[]): TemplateInterviewAnswer[] {
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value.map(answer => ["", answer] as const) : Object.entries(value);
  const answers: TemplateInterviewAnswer[] = [];
  for (const [key, answer] of entries) {
    if (
      !isRecord(answer)
      || !isDigest(answer.questionId)
      || !isDigest(answer.anchorDigest)
      || !DISPOSITIONS.has(answer.disposition as TemplateInterviewDisposition)
      || typeof answer.raw !== "string"
    ) {
      diagnostics.push(diagnostic("TEMPLATE_INTERVIEW_ANSWER_INVALID", "Stored answer does not match the interview answer shape"));
      continue;
    }
    if (!Array.isArray(value) && key !== answer.questionId) {
      diagnostics.push(diagnostic("TEMPLATE_INTERVIEW_ANSWER_INVALID", "Stored answer key does not match its question id", undefined, key));
      continue;
    }
    answers.push({
      questionId: answer.questionId,
      anchorDigest: answer.anchorDigest,
      censusDigest: isDigest(answer.censusDigest) ? answer.censusDigest : answer.anchorDigest,
      disposition: answer.disposition as TemplateInterviewDisposition,
      raw: answer.raw,
    });
  }
  return answers;
}

function emptyInterview(census: CensusResult, diagnostics: TemplateInterviewDiagnostic[]): TemplateInterview {
  return {
    authority: census.authority,
    censusDigest: census.censusDigest,
    questions: [],
    confirmed: [],
    deferred: [],
    unresolved: [],
    invalidatedQuestionIds: [],
    diagnostics,
  };
}

/**
 * Builds the ordered proposal queue from a census and caller-supplied
 * proposals. Filename, frontmatter, and source syntax never become a
 * template id or a contract. Invalid authority yields no setup questions.
 */
export function buildTemplateInterview(census: CensusResult, options: TemplateInterviewOptions = {}): TemplateInterview {
  const diagnostics: TemplateInterviewDiagnostic[] = census.diagnostics.map(item => diagnostic(item.code, item.message, item.path, item.templateId));
  if (census.authority === "invalid") return emptyInterview(census, diagnostics);
  const questions = draftsFor(census, options.proposals ?? [], diagnostics).flatMap(draft => {
    const question = questionFor(draft, census, diagnostics);
    return question === null ? [] : [question];
  });
  const answers = storedAnswers(options.answers, diagnostics);
  const seen = new Set<string>();
  const confirmed: TemplateInterviewResolution[] = [];
  const deferred: TemplateInterviewResolution[] = [];
  const unresolved: TemplateInterviewResolution[] = [];
  const invalidated: Digest[] = [];
  const settled = new Set<string>();
  for (const answer of answers) {
    const question = questions.find(item => item.questionId === answer.questionId);
    if (question === undefined) {
      // The ledger records a decision this run cannot reproduce, usually because
      // the proposals that raised the question were not supplied again. Dropping
      // it silently would publish a contract missing the user's own answer.
      diagnostics.push(diagnostic(
        "TEMPLATE_INTERVIEW_ANSWER_ORPHANED",
        "A recorded answer has no matching question in this review. Supply the same proposals, or clear the recorded answer before publishing.",
        undefined,
        answer.questionId,
      ));
      continue;
    }
    if (seen.has(answer.questionId)) {
      diagnostics.push(diagnostic("TEMPLATE_INTERVIEW_ANSWER_INVALID", "Duplicate stored answer", undefined, answer.questionId));
      continue;
    }
    seen.add(answer.questionId);
    if (answer.anchorDigest !== question.anchorDigest) {
      invalidated.push(question.questionId);
      continue;
    }
    const resolution: TemplateInterviewResolution = {
      questionId: question.questionId,
      anchorDigest: question.anchorDigest,
      disposition: answer.disposition,
      raw: answer.raw,
      proposal: question.proposal,
    };
    settled.add(question.questionId);
    if (answer.disposition === "confirm") confirmed.push(resolution);
    else if (answer.disposition === "defer") deferred.push(resolution);
    else unresolved.push(resolution);
  }
  diagnostics.sort((left, right) => compareText(left.path ?? "", right.path ?? "") || compareText(left.code, right.code) || compareText(left.message, right.message));
  const next = questions.find(question => !settled.has(question.questionId));
  return {
    authority: census.authority,
    censusDigest: census.censusDigest,
    questions,
    ...(next === undefined ? {} : { next }),
    confirmed,
    deferred,
    unresolved,
    invalidatedQuestionIds: [...new Set(invalidated)].sort(compareText),
    diagnostics,
  };
}

function malformed(message: string): never {
  throw new TypeError(`TEMPLATE_INTERVIEW_ANSWER_INVALID: ${message}`);
}

/**
 * Checks one free-text answer against the question this module produced.
 * The returned anchor and census digest always come from that question.
 */
export function validateInterviewAnswer(question: TemplateInterviewQuestion, value: unknown): TemplateInterviewAnswer {
  if (!isRecord(question) || !isDigest(question.questionId) || !isDigest(question.anchorDigest) || !isDigest(question.censusDigest)) {
    malformed("malformed question");
  }
  if (!isRecord(question.proposal) || question.proposal.kind !== question.kind || typeof question.subject !== "string" || question.subject.length === 0) {
    malformed("malformed question");
  }
  if (!isRecord(value)) malformed("answer must be an object");
  for (const key of Object.keys(value)) {
    if (!ANSWER_KEYS.has(key)) malformed("answer cannot carry contract fields");
  }
  const disposition = value.disposition;
  if (typeof disposition !== "string" || !DISPOSITIONS.has(disposition as TemplateInterviewDisposition)) {
    malformed("disposition must be confirm, defer, or unresolved");
  }
  if (typeof value.raw !== "string") malformed("free answer must be a string");
  if (disposition === "confirm" && value.raw.trim().length === 0) malformed("confirmation requires a free-text answer");
  if (value.questionId !== undefined && value.questionId !== question.questionId) malformed("question id does not match");
  if (value.anchorDigest !== undefined && value.anchorDigest !== question.anchorDigest) malformed("anchor does not match the question");
  if (value.censusDigest !== undefined && value.censusDigest !== question.censusDigest) malformed("census digest does not match the question");
  return {
    questionId: question.questionId,
    anchorDigest: question.anchorDigest,
    censusDigest: question.censusDigest,
    disposition: disposition as TemplateInterviewDisposition,
    raw: value.raw,
  };
}
