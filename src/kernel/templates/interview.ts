import { createHash } from "node:crypto";

import {
  deriveContentFormatContract,
  type ContentContractDecisions,
  type ContentFormatContract,
} from "./content-contract.js";
import {
  isTemplateSourceInFolder,
  validateTemplateId,
} from "./paths.js";
import {
  composeResolvedTemplateFields,
  resolveClassifiedTemplateSource,
  type ResolvedClassifiedTemplateSource,
} from "./resolver.js";
import { classifyTemplateRenderer } from "./renderer.js";
import type { TemplateReviewContext } from "./review-context.js";
import type { InterviewLedgerAnswer } from "./interview-ledger.js";
import type {
  ContractDefinition,
  Diagnostic,
  Digest,
  FieldPolicy,
  JsonValue,
  ObsidianContractType,
  TemplateBinding,
  TemplateFolderPath,
  TemplateId,
  TemplatePolicy,
  TemplateSourcePath,
} from "./types.js";
import { proposedTemplateId, type CensusDiff, type CensusEntry } from "./census.js";

export type TemplateInterviewQuestionKind =
  | "contract-selection"
  | "field-type"
  | "field-requiredness"
  | "field-intent"
  | "content-section-requiredness"
  | "content-order"
  | "naming"
  | "deleted-source-disposition"
  | "rename-identity";

export interface TemplateInterviewQuestion {
  readonly questionId: Digest;
  readonly templateId: string;
  readonly kind: TemplateInterviewQuestionKind;
  readonly subject: string;
  readonly anchorDigest: Digest;
  readonly prompt: string;
  readonly choices?: readonly string[];
}

export interface TemplateInterview {
  readonly questions: readonly TemplateInterviewQuestion[];
  readonly next?: TemplateInterviewQuestion;
  readonly invalidatedQuestionIds: readonly string[];
  readonly proposedPolicy?: TemplatePolicy;
  readonly reviewedTemplateIds: readonly TemplateId[];
  readonly diagnostics: readonly Diagnostic[];
}

const TYPES: readonly ObsidianContractType[] = [
  "text",
  "string",
  "select",
  "number",
  "boolean",
  "checkbox",
  "date",
  "datetime",
  "list",
  "multitext",
  "multi",
  "tags",
  "aliases",
  "file",
];
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const BLOCKING = new Set<Diagnostic["code"]>([
  "TEMPLATE_ID_DUPLICATE",
  "TEMPLATE_SOURCE_DUPLICATE",
  "TEMPLATE_SOURCE_INVALID",
  "TEMPLATE_CANDIDATE_INCOMPATIBLE",
  "TEMPLATE_CONTRACT_UNOBSERVED",
  "BASE_CONTRACT_CONFLICT",
  "OBSIDIAN_TYPE_CONFLICT",
  "TEMPLATE_TYPE_UNRESOLVED",
  "TEMPLATE_POLICY_DANGLING_FIELD",
  "TEMPLATE_RECLASSIFY_PATH_MISMATCH",
  "TEMPLATE_EXPRESSION_UNSUPPORTED",
]);

interface QuestionDraft extends TemplateInterviewQuestion {
  readonly anchorMaterial: string;
}

interface Candidate {
  readonly entry: CensusEntry;
  readonly existing?: TemplateBinding;
  readonly oldBinding?: TemplateBinding;
  readonly diff?: CensusDiff;
  readonly initialId: string;
  id: string;
  identityQuestion?: QuestionDraft;
  renameQuestion?: QuestionDraft;
  source?: ResolvedClassifiedTemplateSource;
  renderer?: TemplateBinding["renderer"];
  contractName?: string;
  contract?: ContractDefinition;
  fields?: Readonly<Record<string, FieldPolicy>>;
  content?: ContentFormatContract;
  naming?: string;
  readonly obsidianTypes: Readonly<Record<string, ObsidianContractType>>;
  identityResolved: boolean;
  readonly blockingDiagnostics: Diagnostic[];
}

interface QuestionState {
  readonly questions: QuestionDraft[];
  readonly unanswered: TemplateInterviewQuestion[];
  readonly invalidated: string[];
  readonly diagnostics: Diagnostic[];
}

function digest(value: string): Digest {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function json(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(json);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(json);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceFolder(
  path: TemplateSourcePath,
  folders: TemplatePolicy["templateFolders"],
  existing?: TemplateBinding,
): TemplateFolderPath | undefined {
  const authored = existing?.sourceFolder;
  if (
    authored !== undefined
    && folders.some(folder => folder.path === authored)
    && isTemplateSourceInFolder(path, authored)
  ) {
    return authored;
  }
  return folders
    .filter(folder => isTemplateSourceInFolder(path, folder.path))
    .sort((left, right) => right.path.length - left.path.length || compare(left.path, right.path))[0]?.path;
}

function sourceDiagnostic(
  code: Diagnostic["code"],
  entry: CensusEntry,
  message: string,
  field?: string,
): Diagnostic {
  return {
    code,
    path: entry.sourcePath,
    ...(entry.templateId === undefined ? {} : { templateId: entry.templateId }),
    ...(field === undefined ? {} : { field }),
    message,
  };
}

function errorCode(error: unknown): Diagnostic["code"] {
  if (!(error instanceof Error)) return "TEMPLATE_SOURCE_INVALID";
  const code = /^([A-Z][A-Z_]+):/.exec(error.message)?.[1];
  const known: readonly Diagnostic["code"][] = [
    "TEMPLATE_SOURCE_INVALID",
    "TEMPLATE_CANDIDATE_INCOMPATIBLE",
    "TEMPLATE_POLICY_DANGLING_FIELD",
    "BASE_CONTRACT_CONFLICT",
    "OBSIDIAN_TYPE_CONFLICT",
    "TEMPLATE_TYPE_UNRESOLVED",
    "TEMPLATE_EXPRESSION_UNSUPPORTED",
    "TEMPLATE_PROPOSAL_OVERSIZE",
    "TEMPLATE_CONTRACT_UNOBSERVED",
  ];
  return code !== undefined && known.includes(code as Diagnostic["code"])
    ? code as Diagnostic["code"]
    : "TEMPLATE_SOURCE_INVALID";
}

function censusCode(code: CensusEntry["diagnostics"][number]["code"]): Diagnostic["code"] {
  switch (code) {
    case "TEMPLATE_ID_DUPLICATE":
      return "TEMPLATE_ID_DUPLICATE";
    case "TEMPLATE_ID_INVALID":
      return "TEMPLATE_CANDIDATE_INCOMPATIBLE";
    case "TEMPLATE_SOURCE_DUPLICATE":
      return "TEMPLATE_SOURCE_DUPLICATE";
    case "TEMPLATE_SOURCE_UNSAFE":
      return "TEMPLATE_SOURCE_UNSAFE";
    case "TEMPLATE_SOURCE_INVALID":
      return "TEMPLATE_SOURCE_INVALID";
    default:
      return "TEMPLATE_CANDIDATE_INCOMPATIBLE";
  }
}

function question(
  templateId: string,
  kind: TemplateInterviewQuestionKind,
  subject: string,
  anchorMaterial: string,
  prompt: string,
  choices?: readonly string[],
): QuestionDraft {
  const anchorDigest = digest(anchorMaterial);
  return {
    questionId: digest(`${templateId}|${kind}|${subject}|${anchorDigest}`),
    templateId,
    kind,
    subject,
    anchorDigest,
    prompt,
    ...(choices === undefined || choices.length === 0 ? {} : { choices }),
    anchorMaterial,
  };
}

function asRequired(value: unknown): boolean | undefined {
  if (value === true || value === "required") return true;
  if (value === false || value === "optional") return false;
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function contractChoices(policy: TemplatePolicy): readonly string[] {
  return Object.keys(policy.contracts).sort(compare);
}

function sourceIdentity(entry: CensusEntry): string {
  if (entry.templateId !== undefined) {
    try {
      return validateTemplateId(entry.templateId);
    } catch {
      // A malformed census identity is not an authority; derive from the verified path.
    }
  }
  return proposedTemplateId(entry.sourcePath) ?? entry.sourcePath;
}

function bindingsByPath(policy: TemplatePolicy): ReadonlyMap<string, TemplateBinding> {
  return new Map(Object.values(policy.templates).map(binding => [binding.sourcePath, binding]));
}

function oldBindingForDiff(
  diff: CensusDiff | undefined,
  byPath: ReadonlyMap<string, TemplateBinding>,
): TemplateBinding | undefined {
  return diff?.oldSourcePath === undefined ? undefined : byPath.get(diff.oldSourcePath);
}

function diffForEntry(census: TemplateReviewContext["census"], path: string): CensusDiff | undefined {
  return census.diffs.find(diff => diff.newSourcePath === path || diff.sourcePath === path);
}

function addDiagnostic(state: QuestionState, value: Diagnostic): void {
  if (!state.diagnostics.some(item => item.code === value.code && item.path === value.path && item.field === value.field && item.message === value.message)) {
    state.diagnostics.push(value);
  }
}

function consume(
  draft: QuestionDraft,
  answers: Readonly<Record<string, InterviewLedgerAnswer>>,
  state: QuestionState,
): unknown | undefined {
  if (!state.questions.some(item => item.questionId === draft.questionId)) state.questions.push(draft);
  const stored = answers[draft.questionId];
  if (stored === undefined) {
    if (!state.unanswered.some(item => item.questionId === draft.questionId)) state.unanswered.push(draft);
    return undefined;
  }
  if (
    stored.templateId !== draft.templateId
    || stored.kind !== draft.kind
    || stored.subject !== draft.subject
    || stored.anchorDigest !== draft.anchorDigest
  ) {
    state.unanswered.push(draft);
    state.invalidated.push(draft.questionId);
    addDiagnostic(state, {
      code: "TEMPLATE_CANDIDATE_INCOMPATIBLE",
      templateId: draft.templateId as TemplateId,
      field: draft.subject,
      message: `Answer ${draft.questionId} does not match the current question anchor.`,
    });
    return undefined;
  }
  try {
    const accepted = validateInterviewAnswer(draft, stored.value);
    return accepted.value;
  } catch (error: unknown) {
    state.unanswered.push(draft);
    addDiagnostic(state, {
      code: "TEMPLATE_CANDIDATE_INCOMPATIBLE",
      templateId: draft.templateId as TemplateId,
      field: draft.subject,
      message: error instanceof Error ? error.message : "Interview answer is invalid.",
    });
    return undefined;
  }
}

function classifySource(
  entry: CensusEntry,
  binding: TemplateBinding | undefined,
): { readonly source?: ResolvedClassifiedTemplateSource; readonly renderer: TemplateBinding["renderer"]; readonly diagnostics: readonly Diagnostic[] } {
  const classification = classifyTemplateRenderer(entry.sourcePath, entry.bytes);
  const renderer = binding?.renderer ?? classification.renderer;
  const diagnostics: Diagnostic[] = classification.diagnostics.map(item => ({
    ...item,
    ...(entry.templateId === undefined ? {} : { templateId: entry.templateId }),
  }));
  try {
    const source = resolveClassifiedTemplateSource(entry.sourcePath, entry.bytes, renderer);
    return { source, renderer, diagnostics };
  } catch (error: unknown) {
    diagnostics.push(sourceDiagnostic(errorCode(error), entry, error instanceof Error ? error.message : "Template source is invalid."));
    return { renderer, diagnostics };
  }
}

function frontmatterFields(
  source: ResolvedClassifiedTemplateSource,
  obsidian: Readonly<Record<string, ObsidianContractType>>,
): { readonly fields: Readonly<Record<string, FieldPolicy>>; readonly error?: unknown } {
  try {
    const inferred = composeResolvedTemplateFields({ fields: {} }, {}, source.frontmatter, obsidian);
    return { fields: inferred };
  } catch (error: unknown) {
    return { fields: {}, error };
  }
}

function fieldAnchor(key: string, value: JsonValue): string {
  return `${key}\u0000${canonical(value)}`;
}

function contentDecisions(content: ContentFormatContract): ContentContractDecisions {
  return {
    order: content.order,
    nodes: content.nodes
      .filter(node => node.kind !== "placeholder")
      .map(node => ({ anchorDigest: node.anchorDigest, required: node.required })),
  };
}

type ContentNode = ContentFormatContract["nodes"][number];

function contentSubject(node: ContentNode): string {
  switch (node.kind) {
    case "heading":
      return `heading:${node.level}:${node.text}`;
    case "fenced-code":
      return `fenced-code:${node.char}:${node.info}`;
    case "list":
      return `list:${node.ordered ? "ordered" : "unordered"}`;
    case "placeholder":
      return "placeholder:oms-content";
  }
}

function sameReplacementShape(oldNode: ContentNode, newNode: ContentNode): boolean {
  if (oldNode.kind !== newNode.kind) return false;
  if (oldNode.kind === "heading" && newNode.kind === "heading") return oldNode.level === newNode.level;
  if (oldNode.kind === "fenced-code" && newNode.kind === "fenced-code") {
    return oldNode.char === newNode.char && oldNode.info === newNode.info;
  }
  if (oldNode.kind === "list" && newNode.kind === "list") return oldNode.ordered === newNode.ordered;
  return false;
}

function requiredAnchorSequence(nodes: readonly ContentNode[]): readonly Digest[] {
  return nodes
    .filter(node => node.kind !== "placeholder" && node.required)
    .map(node => node.anchorDigest);
}

function sameSequence(left: readonly Digest[], right: readonly Digest[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function applyContentQuestions(
  candidate: Candidate,
  state: QuestionState,
  answers: Readonly<Record<string, InterviewLedgerAnswer>>,
  needsQuestions: boolean,
): void {
  const source = candidate.source;
  if (source === undefined) return;
  const knownContent = (candidate.oldBinding ?? candidate.existing)?.content;
  if (!needsQuestions) {
    if (knownContent !== undefined) candidate.content = knownContent;
    return;
  }
  const prior: ContentContractDecisions = knownContent === undefined ? { nodes: [] } : contentDecisions(knownContent);
  const observed = deriveContentFormatContract(source.body, {
    templateId: candidate.id,
    bom: source.bom,
    eol: source.eol,
    finalNewline: source.finalNewline,
  }).contract;
  const priorNodes = knownContent?.nodes.filter(node => node.kind !== "placeholder") ?? [];
  const currentNodes = observed.nodes.filter(node => node.kind !== "placeholder");
  const currentAnchors = new Set(currentNodes.map(node => node.anchorDigest));
  const priorAnchors = new Set(priorNodes.map(node => node.anchorDigest));
  const priorRequiredSequence = requiredAnchorSequence(priorNodes);
  const removedNodes = priorNodes.filter(node => !currentAnchors.has(node.anchorDigest));
  const removedRequired = priorNodes.filter(node => node.required && !currentAnchors.has(node.anchorDigest));
  const addedNodes = currentNodes.filter(node => !priorAnchors.has(node.anchorDigest));
  const replacement = removedNodes.length === 1
    && removedRequired.length === 1
    && addedNodes.length === 1
    && sameReplacementShape(removedRequired[0]!, addedNodes[0]!)
    && priorNodes.indexOf(removedRequired[0]!) === currentNodes.indexOf(addedNodes[0]!);
  const deletionNodes = replacement ? [] : removedRequired;
  for (const removed of removedRequired) {
    const oldQuestion = question(
      candidate.id,
      "content-section-requiredness",
      contentSubject(removed),
      removed.anchorMaterial,
      `The previously required ${contentSubject(removed)} is missing. Should it remain required or be removed?`,
      ["required", "optional"],
    );
    state.invalidated.push(oldQuestion.questionId);
  }
  let nodeDecisions = [...prior.nodes];
  let order = prior.order;
  let orderReopened = false;
  const derive = () => deriveContentFormatContract(source.body, {
    templateId: candidate.id,
    bom: source.bom,
    eol: source.eol,
    finalNewline: source.finalNewline,
    decisions: {
      ...(order === undefined ? {} : { order }),
      nodes: nodeDecisions,
    },
  });
  const reopenChangedStrictOrder = (derived: ReturnType<typeof deriveContentFormatContract>): void => {
    if (orderReopened || prior.order !== "strict" || order !== "strict") return;
    const currentRequiredSequence = requiredAnchorSequence(derived.contract.nodes);
    if (
      currentRequiredSequence.length >= 2
      && !sameSequence(priorRequiredSequence, currentRequiredSequence)
    ) {
      order = undefined;
      orderReopened = true;
    }
  };
  const consumeQuestions = (derived: ReturnType<typeof deriveContentFormatContract>): void => {
    for (const item of derived.questions) {
      const draft = question(candidate.id, item.kind, item.subject, item.anchorMaterial, item.prompt, item.choices);
      const value = consume(draft, answers, state);
      if (item.kind === "content-order") {
        if (value === "strict" || value === "unordered") order = value;
        continue;
      }
      const required = asRequired(value);
      if (
        required !== undefined
        && !nodeDecisions.some(decision => decision.anchorDigest === item.anchorDigest)
      ) nodeDecisions = [...nodeDecisions, { anchorDigest: item.anchorDigest, required }];
    }
  };
  let derived = derive();
  reopenChangedStrictOrder(derived);
  derived = derive();
  consumeQuestions(derived);
  derived = derive();
  reopenChangedStrictOrder(derived);
  derived = derive();
  consumeQuestions(derived);
  for (const removed of deletionNodes) {
    const draft = question(
      candidate.id,
      "content-section-requiredness",
      contentSubject(removed),
      removed.anchorMaterial,
      `The previously required ${contentSubject(removed)} is missing. Should it remain required or be removed?`,
      ["required", "optional"],
    );
    const value = consume(draft, answers, state);
    if (asRequired(value) === true) {
      candidate.blockingDiagnostics.push(sourceDiagnostic(
        "TEMPLATE_CONTRACT_UNOBSERVED",
        candidate.entry,
        `Previously required ${contentSubject(removed)} is absent from the current source; restore it before applying the contract.`,
      ));
    }
  }
  candidate.content = derive().contract;
}

function applyFieldQuestions(
  candidate: Candidate,
  policy: TemplatePolicy,
  contract: ContractDefinition,
  state: QuestionState,
  answers: Readonly<Record<string, InterviewLedgerAnswer>>,
  needsQuestions: boolean,
): void {
  const source = candidate.source;
  if (source === undefined) return;
  if (!needsQuestions) {
    candidate.fields = contract.fields;
    return;
  }
  const inferredResult = frontmatterFields(source, candidate.obsidianTypes);
  const inferred = inferredResult.fields;
  if (inferredResult.error !== undefined && errorCode(inferredResult.error) !== "TEMPLATE_TYPE_UNRESOLVED") {
    candidate.blockingDiagnostics.push(sourceDiagnostic(
      errorCode(inferredResult.error),
      candidate.entry,
      inferredResult.error instanceof Error ? inferredResult.error.message : "Frontmatter type authority conflicts with the template.",
    ));
  }
  const fields: Record<string, FieldPolicy> = { ...contract.fields };
  for (const key of Object.keys(source.frontmatter).sort(compare)) {
    const value = source.frontmatter[key]!;
    const authored = { ...(policy.base.fields[key] ?? {}), ...(contract.fields[key] ?? {}) };
    const contractOwnsField = Object.hasOwn(contract.fields, key);
    let type = authored.type ?? inferred[key]?.type;
    const anchor = fieldAnchor(key, value);
    if (type === undefined) {
      const typeQuestion = question(
        candidate.id,
        "field-type",
        `field:${key}`,
        anchor,
        `Which type should frontmatter field ${key} use?`,
        TYPES,
      );
      const selected = consume(typeQuestion, answers, state);
      if (typeof selected === "string" && TYPES.includes(selected as ObsidianContractType)) type = selected as ObsidianContractType;
    }
    let required = authored.required;
    if (required === undefined) {
      const requiredQuestion = question(
        candidate.id,
        "field-requiredness",
        `field:${key}`,
        anchor,
        `Should frontmatter field ${key} be required?`,
        ["required", "optional"],
      );
      required = asRequired(consume(requiredQuestion, answers, state));
    }
    let intent = authored.intent;
    if (intent === undefined) {
      const intentQuestion = question(
        candidate.id,
        "field-intent",
        `field:${key}`,
        anchor,
        `What intent does frontmatter field ${key} have?`,
      );
      intent = asString(consume(intentQuestion, answers, state));
    }
    const resolved = {
      ...authored,
      ...(type === undefined ? {} : { type }),
      ...(required === undefined ? {} : { required }),
      ...(intent === undefined ? {} : { intent }),
    };
    if (
      contractOwnsField
      || !Object.hasOwn(policy.base.fields, key)
      || canonical(resolved) !== canonical(policy.base.fields[key])
    ) fields[key] = resolved;
  }
  candidate.fields = fields;
}

function specializedName(base: string, id: string, contracts: Readonly<Record<string, ContractDefinition>>): string {
  const wanted = `${base}::${id}`;
  if (!Object.hasOwn(contracts, wanted)) return wanted;
  let index = 2;
  while (Object.hasOwn(contracts, `${wanted}-${index}`)) index += 1;
  return `${wanted}-${index}`;
}

function candidateNeedsSpecialization(candidate: Candidate): boolean {
  if (candidate.fields === undefined || candidate.contract === undefined) return false;
  return canonical(candidate.fields) !== canonical(candidate.contract.fields);
}

function bindingForCandidate(
  candidate: Candidate,
  contracts: Record<string, ContractDefinition>,
  folders: TemplatePolicy["templateFolders"],
): TemplateBinding | undefined {
  if (candidate.source === undefined || candidate.contractName === undefined || candidate.naming === undefined) return undefined;
  let contractName = candidate.contractName;
  if (candidate.fields !== undefined && candidate.contract !== undefined && candidateNeedsSpecialization(candidate)) {
    contractName = specializedName(contractName, candidate.id, contracts);
    contracts[contractName] = { ...candidate.contract, fields: candidate.fields };
  }
  const existing = candidate.oldBinding ?? candidate.existing;
  const folder = sourceFolder(candidate.entry.sourcePath, folders, existing);
  if (folder === undefined) {
    candidate.blockingDiagnostics.push(sourceDiagnostic(
      "TEMPLATE_SOURCE_INVALID",
      candidate.entry,
      `Template source ${candidate.entry.sourcePath} is not within a registered template folder.`,
    ));
    return undefined;
  }
  return {
    ...(existing ?? {}),
    templateId: validateTemplateId(candidate.id),
    destinationClass: "registered-existing",
    renderer: candidate.renderer ?? existing?.renderer ?? "none",
    sourceFolder: folder,
    sourcePath: candidate.entry.sourcePath,
    contract: contractName,
    naming: candidate.naming,
    approvedSourceSignature: candidate.entry.signature,
    approvedBodySignature: digest(candidate.source.body),
    ...(candidate.content === undefined ? {} : { content: candidate.content }),
  };
}

function blocking(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some(item => BLOCKING.has(item.code));
}

/**
 * Builds the deterministic review model from a read-only census/context.
 * Existing policy facts and matching answer anchors are carried forward; only
 * unresolved ambiguity becomes a question.
 */
export function buildTemplateInterview(
  context: TemplateReviewContext,
  answers: Readonly<Record<string, InterviewLedgerAnswer>>,
): TemplateInterview {
  const state: QuestionState = { questions: [], unanswered: [], invalidated: [], diagnostics: [] };
  const byPath = bindingsByPath(context.policy);
  const entries = [...context.census.entries].sort((left, right) => {
    const leftKnown = byPath.has(left.sourcePath)
      || oldBindingForDiff(diffForEntry(context.census, left.sourcePath), byPath) !== undefined;
    const rightKnown = byPath.has(right.sourcePath)
      || oldBindingForDiff(diffForEntry(context.census, right.sourcePath), byPath) !== undefined;
    return Number(!leftKnown) - Number(!rightKnown) || compare(left.sourcePath, right.sourcePath);
  });
  const preliminaryIds = new Map(entries.map(entry => [entry.sourcePath, sourceIdentity(entry)]));
  const groupedIds = new Map<string, CensusEntry[]>();
  for (const entry of entries) {
    const id = preliminaryIds.get(entry.sourcePath)!;
    const key = id.normalize("NFC").toLocaleLowerCase("en-US");
    const group = groupedIds.get(key) ?? [];
    group.push(entry);
    groupedIds.set(key, group);
  }
  const duplicatePaths = new Set<string>();
  for (const group of groupedIds.values()) {
    if (group.length < 2) continue;
    for (const entry of group) duplicatePaths.add(entry.sourcePath);
  }

  const candidates: Candidate[] = entries.map(entry => {
    const diff = diffForEntry(context.census, entry.sourcePath);
    const existing = byPath.get(entry.sourcePath);
    const oldBinding = oldBindingForDiff(diff, byPath);
    const initialId = existing?.templateId
      ?? (diff?.kind === "renamed" && diff.automatic && oldBinding !== undefined
        ? oldBinding.templateId
        : preliminaryIds.get(entry.sourcePath)!);
    const candidate: Candidate = {
      entry,
      ...(existing === undefined ? {} : { existing }),
      ...(oldBinding === undefined ? {} : { oldBinding }),
      ...(diff === undefined ? {} : { diff }),
      initialId,
      id: initialId,
      identityResolved: true,
      blockingDiagnostics: [],
      obsidianTypes: context.obsidianTypes,
    };
    const hasStableDerivedId = proposedTemplateId(entry.sourcePath) !== null;
    const knownAutomaticRename = diff?.kind === "renamed" && diff.automatic && oldBinding !== undefined;
    if (
      duplicatePaths.has(entry.sourcePath)
      || (existing === undefined && !hasStableDerivedId && !knownAutomaticRename)
    ) {
      const identityQuestion = question(
        initialId,
        "rename-identity",
        `identity:${entry.sourcePath}`,
        `${entry.sourcePath}\u0000${entry.signature}`,
        `Choose a stable template id for ${entry.sourcePath}.`,
      );
      candidate.identityQuestion = identityQuestion;
    }
    if (
      diff?.kind === "renamed"
      && !diff.automatic
      && oldBinding !== undefined
      && diff.oldSourcePath !== undefined
    ) {
      const nextId = entry.templateId ?? initialId;
      const choices = [...new Set([oldBinding.templateId, nextId])].sort(compare);
      const renameQuestion = question(
        initialId,
        "rename-identity",
        `rename:${diff.oldSourcePath}->${diff.newSourcePath ?? diff.sourcePath}`,
        `${diff.oldSourcePath}\u0000${diff.newSourcePath ?? diff.sourcePath}\u0000${entry.signature}`,
        `Confirm the identity change from ${oldBinding.templateId} to ${nextId}.`,
        choices,
      );
      candidate.renameQuestion = renameQuestion;
    }
    return candidate;
  });

  for (const candidate of candidates) {
    const identity = candidate.identityQuestion === undefined ? candidate.initialId : consume(candidate.identityQuestion, answers, state);
    const identityId = typeof identity === "string" ? identity : candidate.identityQuestion === undefined ? candidate.initialId : undefined;
    if (identityId === undefined) {
      candidate.identityResolved = false;
      continue;
    }
    candidate.id = identityId;
    const rename = candidate.renameQuestion === undefined ? undefined : consume(candidate.renameQuestion, answers, state);
    if (candidate.renameQuestion !== undefined && typeof rename !== "string") {
      candidate.identityResolved = false;
      continue;
    }
    if (candidate.renameQuestion !== undefined && typeof rename === "string") candidate.id = rename;
    const sourceResult = classifySource(candidate.entry, candidate.oldBinding ?? candidate.existing);
    candidate.source = sourceResult.source;
    candidate.renderer = sourceResult.renderer;
    for (const diagnostic of sourceResult.diagnostics) {
      if (diagnostic.code !== "TEMPLATE_CONTRACT_UNOBSERVED" || candidate.source === undefined) state.diagnostics.push(diagnostic);
    }
    if (candidate.source === undefined) {
      candidate.identityResolved = false;
      continue;
    }
    const source = candidate.source;
    const existing = candidate.id === candidate.oldBinding?.templateId ? candidate.oldBinding : candidate.existing;
    const contractName = existing?.contract;
    const choices = contractChoices(context.policy);
    if (contractName === undefined) {
      if (choices.length === 0) {
        state.diagnostics.push(sourceDiagnostic("TEMPLATE_POLICY_DANGLING_FIELD", candidate.entry, "No template contract is available."));
        continue;
      }
      if (choices.length === 1) {
        candidate.contractName = choices[0];
      } else {
        const contractQuestion = question(
          candidate.id,
          "contract-selection",
          "contract",
          `${candidate.entry.sourcePath}\u0000contracts`,
          `Which contract should ${candidate.entry.sourcePath} use?`,
          choices,
        );
        const selected = consume(contractQuestion, answers, state);
        if (typeof selected === "string" && choices.includes(selected)) candidate.contractName = selected;
      }
    } else {
      candidate.contractName = contractName;
    }
    if (candidate.contractName === undefined) continue;
    candidate.contract = context.policy.contracts[candidate.contractName];
    if (candidate.contract === undefined) {
      state.diagnostics.push(sourceDiagnostic("TEMPLATE_POLICY_DANGLING_FIELD", candidate.entry, `Contract ${candidate.contractName} is missing.`));
      continue;
    }
    const rendererNeedsQuestions = existing === undefined || !context.projectionUsable || !context.freshTemplateIds.includes(candidate.id as TemplateId);
    try {
      for (const [key, field] of Object.entries(context.policy.base.fields)) {
        if (field.required === true && field.filledBy !== "obsidian" && !Object.hasOwn(source.frontmatter, key)) {
          candidate.blockingDiagnostics.push(sourceDiagnostic(
            "BASE_CONTRACT_CONFLICT",
            candidate.entry,
            `Template is missing required base field ${key}.`,
            key,
          ));
        }
      }
      applyFieldQuestions(candidate, context.policy, candidate.contract, state, answers, rendererNeedsQuestions);
      applyContentQuestions(candidate, state, answers, rendererNeedsQuestions);
      if (candidate.content?.wellFormed === false) {
        state.diagnostics.push(sourceDiagnostic("TEMPLATE_SOURCE_INVALID", candidate.entry, "Template body contains an unterminated fenced block."));
      }
    } catch (error: unknown) {
      state.diagnostics.push(sourceDiagnostic(errorCode(error), candidate.entry, error instanceof Error ? error.message : "Template source could not be analyzed."));
      continue;
    }
    if (existing === undefined) {
      const namingQuestion = question(
        candidate.id,
        "naming",
        "naming",
        `${candidate.entry.sourcePath}\u0000naming`,
        `Which naming expression should ${candidate.entry.sourcePath} use?`,
      );
      const naming = consume(namingQuestion, answers, state);
      candidate.naming = asString(naming);
    } else {
      candidate.naming = existing.naming;
    }
  }

  const currentPaths = new Set(entries.map(entry => entry.sourcePath));
  const retired = new Set<string>();
  const deferred = new Set<string>();
  const replaced = new Set<string>();
  let replacementDefault: TemplateId | undefined;
  for (const candidate of candidates) {
    if (
      candidate.identityResolved
      && candidate.diff?.kind === "renamed"
      && !candidate.diff.automatic
      && candidate.oldBinding !== undefined
      && candidate.id !== candidate.oldBinding.templateId
    ) {
      replaced.add(candidate.oldBinding.templateId);
      if (context.policy.defaultTemplate === candidate.oldBinding.templateId) replacementDefault = candidate.id as TemplateId;
    }
  }
  for (const binding of Object.values(context.policy.templates).sort((left, right) => compare(left.sourcePath, right.sourcePath))) {
    if (currentPaths.has(binding.sourcePath)) continue;
    const diff = context.census.diffs.find(item => item.kind === "deleted" && (item.oldSourcePath === binding.sourcePath || item.sourcePath === binding.sourcePath || item.templateId === binding.templateId));
    if (diff === undefined) continue;
    const deletionQuestion = question(
      binding.templateId,
      "deleted-source-disposition",
      `deleted:${binding.templateId}:${binding.sourcePath}`,
      `${binding.sourcePath}\u0000deleted-source-disposition`,
      `Should deleted source ${binding.sourcePath} be retired or deferred?`,
      ["retire", "defer"],
    );
    const disposition = consume(deletionQuestion, answers, state);
    if (disposition === "retire") retired.add(binding.templateId);
    if (disposition === "defer") deferred.add(binding.templateId);
  }

  const answerQuestionIds = new Set<string>(state.questions.map(item => item.questionId));
  for (const [questionId, answer] of Object.entries(answers)) {
    if (answerQuestionIds.has(questionId)) continue;
    const candidatesForAnswer = state.questions.filter(item =>
      item.templateId === answer.templateId
      && item.kind === answer.kind
      && item.subject.split(":")[0] === answer.subject.split(":")[0],
    );
    const related = candidatesForAnswer.find(item => item.subject === answer.subject)
      ?? (candidatesForAnswer.length === 1 ? candidatesForAnswer[0] : undefined);
    if (related !== undefined) state.invalidated.push(questionId);
  }

  for (const candidate of candidates) {
    if (candidate.identityResolved && candidate.id !== candidate.initialId) {
      const normalized = candidate.id.normalize("NFC").toLocaleLowerCase("en-US");
      if (candidates.some(other => other !== candidate && other.identityResolved && other.id.normalize("NFC").toLocaleLowerCase("en-US") === normalized)) {
        candidate.blockingDiagnostics.push(sourceDiagnostic("TEMPLATE_ID_DUPLICATE", candidate.entry, `Template id ${candidate.id} is claimed by more than one source.`));
      }
    }
    if (candidate.identityResolved) {
      const prior = context.policy.templates[candidate.id];
      if (
        prior !== undefined
        && prior.sourcePath !== candidate.entry.sourcePath
        && prior.templateId !== candidate.oldBinding?.templateId
      ) {
        candidate.blockingDiagnostics.push(sourceDiagnostic("TEMPLATE_ID_DUPLICATE", candidate.entry, `Template id ${candidate.id} is already bound to ${prior.sourcePath}.`));
      }
    }
  }

  const contracts: Record<string, ContractDefinition> = { ...context.policy.contracts };
  const proposedBindings: Record<string, TemplateBinding> = {};
  for (const candidate of candidates) {
    const binding = candidate.identityResolved && candidate.source !== undefined
      ? bindingForCandidate(candidate, contracts, context.policy.templateFolders)
      : undefined;
    if (binding !== undefined) proposedBindings[binding.templateId] = binding;
    for (const diagnostic of candidate.blockingDiagnostics) state.diagnostics.push(diagnostic);
  }
  for (const binding of Object.values(context.policy.templates)) {
    if (retired.has(binding.templateId) || replaced.has(binding.templateId)) continue;
    if (proposedBindings[binding.templateId] !== undefined) continue;
    const sourceCandidate = candidates.find(candidate =>
      candidate.existing?.templateId === binding.templateId
      || candidate.oldBinding?.templateId === binding.templateId,
    );
    if (
      sourceCandidate !== undefined
      && sourceCandidate.source === undefined
      && sourceCandidate.identityResolved === false
    ) {
      proposedBindings[binding.templateId] = binding;
      continue;
    }
    if (deferred.has(binding.templateId) || !currentPaths.has(binding.sourcePath)) proposedBindings[binding.templateId] = binding;
  }

  for (const diagnostic of context.census.diagnostics) {
    if (
      (diagnostic.code === "TEMPLATE_ID_DUPLICATE" || diagnostic.code === "TEMPLATE_ID_INVALID")
      && candidates.some(candidate => candidate.entry.sourcePath === diagnostic.path && candidate.identityResolved)
    ) continue;
    addDiagnostic(state, {
      code: censusCode(diagnostic.code),
      path: diagnostic.path,
      ...(diagnostic.templateId === undefined ? {} : { templateId: diagnostic.templateId }),
      message: diagnostic.message,
    });
  }

  const reviewed = candidates
    .filter(candidate =>
      candidate.identityResolved
      && !candidate.blockingDiagnostics.some(item => BLOCKING.has(item.code))
      && !state.unanswered.some(questionValue => questionValue.templateId === candidate.id),
    )
    .map(candidate => candidate.id as TemplateId);
  const diagnostics = [...state.diagnostics];
  const unresolved = state.unanswered.length > 0;
  const hasBlocking = blocking(diagnostics);
  const proposedPolicy = unresolved || hasBlocking
    ? undefined
    : retired.has(context.policy.defaultTemplate ?? "")
      ? (() => {
        const withoutDefault = { ...context.policy, contracts, templates: proposedBindings };
        Reflect.deleteProperty(withoutDefault, "defaultTemplate");
        return withoutDefault;
      })()
      : replacementDefault === undefined
        ? { ...context.policy, contracts, templates: proposedBindings }
        : { ...context.policy, contracts, templates: proposedBindings, defaultTemplate: replacementDefault };
  const result: TemplateInterview = {
    questions: state.unanswered,
    ...(state.unanswered[0] === undefined ? {} : { next: state.unanswered[0] }),
    invalidatedQuestionIds: [...new Set(state.invalidated)].sort(compare),
    ...(proposedPolicy === undefined ? {} : { proposedPolicy }),
    reviewedTemplateIds: [...new Set(reviewed)].sort(compare),
    diagnostics,
  };
  return result;
}

/**
 * Validates one answer against the exact question shape. The returned value is
 * the canonical ledger answer; arbitrary policy or contract objects are never
 * accepted as an answer.
 */
export function validateInterviewAnswer(
  questionValue: TemplateInterviewQuestion,
  value: unknown,
): InterviewLedgerAnswer {
  if (
    questionValue === null
    || typeof questionValue !== "object"
    || typeof questionValue.questionId !== "string"
    || typeof questionValue.anchorDigest !== "string"
    || typeof questionValue.templateId !== "string"
    || typeof questionValue.subject !== "string"
    || !DIGEST.test(questionValue.questionId)
    || !DIGEST.test(questionValue.anchorDigest)
    || questionValue.templateId.length === 0
    || questionValue.subject.length === 0
  ) {
    throw new TypeError("TEMPLATE_INTERVIEW_ANSWER_INVALID: malformed question");
  }
  if (!json(value)) throw new TypeError("TEMPLATE_INTERVIEW_ANSWER_INVALID: answer must be JSON-compatible");
  if (questionValue.choices !== undefined) {
    if (!Array.isArray(questionValue.choices) || questionValue.choices.some(choice => typeof choice !== "string")) {
      throw new TypeError("TEMPLATE_INTERVIEW_ANSWER_INVALID: malformed question choices");
    }
    const booleanRequiredness = (questionValue.kind === "field-requiredness" || questionValue.kind === "content-section-requiredness")
      && typeof value === "boolean";
    if (!booleanRequiredness && (typeof value !== "string" || !questionValue.choices.includes(value))) {
      throw new TypeError(`TEMPLATE_INTERVIEW_ANSWER_INVALID: choose one of ${questionValue.choices.join(", ")}`);
    }
  }
  if (
    (questionValue.kind === "contract-selection"
      || questionValue.kind === "deleted-source-disposition"
      || questionValue.kind === "content-order")
    && (questionValue.choices === undefined || questionValue.choices.length === 0)
  ) {
    throw new TypeError("TEMPLATE_INTERVIEW_ANSWER_INVALID: selection choices are required");
  }
  switch (questionValue.kind) {
    case "field-type":
      if (typeof value !== "string" || !TYPES.includes(value as ObsidianContractType)) throw new TypeError("TEMPLATE_INTERVIEW_ANSWER_INVALID: field type is unsupported");
      break;
    case "field-requiredness":
    case "content-section-requiredness":
      if (asRequired(value) === undefined) throw new TypeError("TEMPLATE_INTERVIEW_ANSWER_INVALID: requiredness must be required or optional");
      break;
    case "content-order":
      if (value !== "strict" && value !== "unordered") throw new TypeError("TEMPLATE_INTERVIEW_ANSWER_INVALID: content order is unsupported");
      break;
    case "contract-selection":
    case "deleted-source-disposition":
      if (typeof value !== "string" || value.length === 0) throw new TypeError("TEMPLATE_INTERVIEW_ANSWER_INVALID: selection is required");
      break;
    case "rename-identity":
      if (typeof value !== "string") throw new TypeError("TEMPLATE_INTERVIEW_ANSWER_INVALID: template id is required");
      try { validateTemplateId(value); } catch { throw new TypeError("TEMPLATE_INTERVIEW_ANSWER_INVALID: template id is invalid"); }
      break;
    case "field-intent":
    case "naming":
      if (asString(value) === undefined) throw new TypeError("TEMPLATE_INTERVIEW_ANSWER_INVALID: non-empty text is required");
      break;
    default:
      throw new TypeError("TEMPLATE_INTERVIEW_ANSWER_INVALID: unknown question kind");
  }
  return {
    templateId: questionValue.templateId,
    kind: questionValue.kind,
    subject: questionValue.subject,
    anchorDigest: questionValue.anchorDigest,
    value: value as JsonValue,
  };
}
