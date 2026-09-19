import { createHash } from "node:crypto";

/**
 * The body grammar intentionally stays smaller than Markdown. A template
 * contract records only blocks that OMS can validate without executing a
 * renderer or depending on a Markdown parser. Paragraphs, setext headings,
 * tables, block quotes, and other Markdown constructs remain unconstrained.
 */

export type ContentOrder = "strict" | "unordered";
export type ContentEol = "lf" | "crlf";
export type ContentFenceChar = "`" | "~";
export type ContentDigest = `sha256:${string}`;
export type ContentNodeKind = "heading" | "fenced-code" | "list" | "placeholder";
export type ContentQuestionKind = "content-section-requiredness" | "content-order";
export type ContentContractViolationCode = "required-node-missing" | "order-mismatch" | "unterminated-fence";

export interface ContentNodeSpan {
  /** UTF-16 offsets into the BOM-stripped body scanned by the derivation function. */
  readonly start: number;
  readonly end: number;
  /** One-based source line numbers, useful for host diagnostics. */
  readonly startLine: number;
  readonly endLine: number;
}

export interface ContentHeadingNode {
  readonly kind: "heading";
  readonly level: number;
  readonly text: string;
  readonly required: boolean;
  readonly span: ContentNodeSpan;
  /** The smallest source slice whose change invalidates this decision, with deterministic occurrence context when repeated. */
  readonly anchorMaterial: string;
  readonly anchorDigest: ContentDigest;
}

export interface ContentFencedCodeNode {
  readonly kind: "fenced-code";
  readonly char: ContentFenceChar;
  readonly fenceLength: number;
  readonly info: string;
  readonly closed: boolean;
  readonly required: boolean;
  readonly span: ContentNodeSpan;
  /** The complete fence block, or the source suffix when it is unterminated, with deterministic occurrence context when repeated. */
  readonly anchorMaterial: string;
  readonly anchorDigest: ContentDigest;
}

export interface ContentListNode {
  readonly kind: "list";
  readonly ordered: boolean;
  readonly itemCount: number;
  readonly required: boolean;
  readonly span: ContentNodeSpan;
  /** Marker lines only; prose belonging to a list is deliberately unconstrained. Repeated runs carry occurrence context. */
  readonly anchorMaterial: string;
  readonly anchorDigest: ContentDigest;
}

export interface ContentPlaceholderNode {
  readonly kind: "placeholder";
  readonly token: "<!-- oms:content -->";
  readonly span: ContentNodeSpan;
  /** The marker line, with deterministic occurrence context when repeated. */
  readonly anchorMaterial: string;
  readonly anchorDigest: ContentDigest;
}

export type ContentNode = ContentHeadingNode | ContentFencedCodeNode | ContentListNode | ContentPlaceholderNode;
export type ContentRequiredNode = ContentHeadingNode | ContentFencedCodeNode | ContentListNode;

export interface ContentContractDiagnostic {
  readonly code: "unterminated-fence";
  readonly message: string;
  readonly span?: ContentNodeSpan;
}

/**
 * The one canonical serialised body contract. Callers filter `nodes` by their
 * discriminant; no category arrays are persisted alongside it.
 *
 * `required` on a node is meaningful only after an explicit confirmed
 * decision. Derivation leaves every observed node optional and emits a
 * question instead of treating presence as a rule.
 */
export interface ContentFormatContract {
  readonly version: 1;
  readonly nodes: readonly ContentNode[];
  readonly order: ContentOrder;
  readonly eol: ContentEol;
  readonly bom: boolean;
  readonly finalNewline: boolean;
  readonly bodySignature: ContentDigest;
  readonly wellFormed: boolean;
  readonly diagnostics: readonly ContentContractDiagnostic[];
}

/** The only body decisions accepted by derivation. */
export interface ContentNodeDecision {
  readonly anchorDigest: ContentDigest;
  readonly required: boolean;
}

export interface ContentContractDecisions {
  readonly order?: ContentOrder;
  readonly nodes: readonly ContentNodeDecision[];
}

export interface DeriveContentFormatContractOptions {
  readonly templateId?: string;
  readonly decisions?: ContentContractDecisions;
  /** Source metadata can be supplied by the frontmatter extractor. */
  readonly bom?: boolean;
  readonly eol?: ContentEol;
  readonly finalNewline?: boolean;
}

export interface ContentContractQuestion {
  readonly questionId: ContentDigest;
  readonly kind: ContentQuestionKind;
  readonly subject: string;
  readonly anchorDigest: ContentDigest;
  readonly anchorMaterial: string;
  readonly prompt: string;
  readonly choices: readonly string[];
}

export interface DerivedContentFormatContract {
  readonly contract: ContentFormatContract;
  readonly questions: readonly ContentContractQuestion[];
}

export type TemplateBodyContractMode = "create" | "update" | "append";

export interface EvaluateTemplateBodyContractOptions {
  readonly mode?: TemplateBodyContractMode;
}

export interface TemplateBodyContractViolation {
  readonly code: ContentContractViolationCode;
  readonly rule: "required" | "order" | "fence";
  readonly message: string;
  readonly nodeKind?: ContentNodeKind;
  readonly subject?: string;
  readonly anchorDigest?: ContentDigest;
}

export interface TemplateBodyContractResult {
  readonly valid: boolean;
  readonly mode: TemplateBodyContractMode;
  readonly violations: readonly TemplateBodyContractViolation[];
  /** Nodes observed in the candidate body; the contract itself remains canonical. */
  readonly nodes: readonly ContentNode[];
  readonly eol: ContentEol;
  readonly bom: boolean;
  readonly finalNewline: boolean;
}

interface SourceLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly number: number;
}

interface OpenFence {
  readonly char: ContentFenceChar;
  readonly length: number;
  readonly info: string;
  readonly start: SourceLine;
  readonly openingLine: number;
}

interface ScannedBody {
  readonly nodes: readonly ContentNode[];
  readonly diagnostics: readonly ContentContractDiagnostic[];
  readonly eol: ContentEol;
  readonly bom: boolean;
  readonly finalNewline: boolean;
  readonly body: string;
}

interface ScanMetadata {
  readonly bom?: boolean;
  readonly eol?: ContentEol;
  readonly finalNewline?: boolean;
}

interface ListMarker {
  readonly ordered: boolean;
}

const MAX_BODY_BYTES = 1_048_576;
const MAX_BODY_LINES = 100_000;
const CONTENT_MARKER = "<!-- oms:content -->";
const DYNAMIC_TOKEN = /{{(?:title|date(?::[^{}]*)?|time(?::[^{}]*)?)}}/g;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function digest(input: string): ContentDigest {
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

function sourceLines(body: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  let number = 1;
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;
    const separatorLength = code === 13 && body.charCodeAt(index + 1) === 10 ? 2 : 1;
    lines.push({ text: body.slice(start, index), start, end: index, number });
    number += 1;
    index += separatorLength - 1;
    start = index + 1;
  }
  if (start < body.length || lines.length === 0) {
    lines.push({ text: body.slice(start), start, end: body.length, number });
  }
  return lines;
}

function eolOf(body: string): ContentEol {
  return body.includes("\r\n") ? "crlf" : "lf";
}

function parseFenceOpening(line: string): { readonly char: ContentFenceChar; readonly length: number; readonly info: string } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) return undefined;
  const run = match[1]!;
  const char = run[0] as ContentFenceChar;
  const rest = match[2] ?? "";
  // CommonMark disallows backticks in the info string of a backtick fence.
  if (char === "`" && rest.includes("`")) return undefined;
  return { char, length: run.length, info: rest.trim() };
}

function isFenceClosing(line: string, fence: OpenFence): boolean {
  // A closing fence may have up to three leading spaces and only spaces/tabs
  // after the marker run. Any other trailing text is ordinary code content.
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (match === null) return false;
  const run = match[1]!;
  return run[0] === fence.char && run.length >= fence.length;
}

function parseHeading(line: string): { readonly level: number; readonly text: string } | undefined {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
  if (match === null) return undefined;
  let text = (match[2] ?? "").trim();
  // A trailing sequence is an ATX closing sequence only when separated by
  // whitespace, as required by CommonMark.
  text = text.replace(/[ \t]+#+[ \t]*$/, "").trim();
  return { level: match[1]!.length, text };
}

function parseListMarker(line: string): ListMarker | undefined {
  const match = /^ {0,3}([-*+]|[0-9]{1,9}[.)])[ \t]+/.exec(line);
  if (match === null) return undefined;
  return { ordered: /^[0-9]/.test(match[1]!) };
}

function nodeSpan(start: SourceLine, end: SourceLine): ContentNodeSpan {
  return { start: start.start, end: end.end, startLine: start.number, endLine: end.number };
}

function makeHeading(body: string, line: SourceLine, heading: { readonly level: number; readonly text: string }): ContentHeadingNode {
  const anchorMaterial = body.slice(line.start, line.end);
  return {
    kind: "heading",
    level: heading.level,
    text: heading.text,
    required: false,
    span: nodeSpan(line, line),
    anchorMaterial,
    anchorDigest: digest(anchorMaterial),
  };
}

function makeFence(
  body: string,
  opening: OpenFence,
  ending: SourceLine,
  closed: boolean,
): ContentFencedCodeNode {
  const anchorMaterial = body.slice(opening.start.start, ending.end);
  return {
    kind: "fenced-code",
    char: opening.char,
    fenceLength: opening.length,
    info: opening.info,
    closed,
    required: false,
    span: nodeSpan(opening.start, ending),
    anchorMaterial,
    anchorDigest: digest(anchorMaterial),
  };
}

function makeList(body: string, start: SourceLine, end: SourceLine, ordered: boolean, itemCount: number): ContentListNode {
  const anchorMaterial = body.slice(start.start, end.end);
  return {
    kind: "list",
    ordered,
    itemCount,
    required: false,
    span: nodeSpan(start, end),
    anchorMaterial,
    anchorDigest: digest(anchorMaterial),
  };
}

function makePlaceholder(body: string, line: SourceLine): ContentPlaceholderNode {
  const anchorMaterial = body.slice(line.start, line.end);
  return {
    kind: "placeholder",
    token: CONTENT_MARKER,
    span: nodeSpan(line, line),
    anchorMaterial,
    anchorDigest: digest(anchorMaterial),
  };
}

function occurrenceAnchorMaterial(raw: string, count: number, occurrence: number): string {
  return JSON.stringify({ raw, count, occurrence });
}

function disambiguateRepeatedAnchors(nodes: readonly ContentNode[]): readonly ContentNode[] {
  const groups = new Map<string, number[]>();
  nodes.forEach((node, index) => {
    const key = JSON.stringify([node.kind, node.anchorMaterial]);
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  });
  const context = new Map<number, { readonly count: number; readonly occurrence: number }>();
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    indexes.forEach((index, occurrence) => context.set(index, { count: indexes.length, occurrence }));
  }
  return nodes.map((node, index): ContentNode => {
    const occurrence = context.get(index);
    if (occurrence === undefined) return node;
    const anchorMaterial = occurrenceAnchorMaterial(node.anchorMaterial, occurrence.count, occurrence.occurrence);
    return { ...node, anchorMaterial, anchorDigest: digest(anchorMaterial) };
  });
}

function scanBody(input: string, metadata: ScanMetadata = {}): ScannedBody {
  const hasBom = input.startsWith("\ufeff");
  const body = hasBom ? input.slice(1) : input;
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new RangeError(`CONTENT_CONTRACT_OVERSIZE: body exceeds ${MAX_BODY_BYTES} UTF-8 bytes`);
  }
  const lines = sourceLines(body);
  if (lines.length > MAX_BODY_LINES) {
    throw new RangeError(`CONTENT_CONTRACT_OVERSIZE: body exceeds ${MAX_BODY_LINES} lines`);
  }

  const nodes: ContentNode[] = [];
  const diagnostics: ContentContractDiagnostic[] = [];
  let fence: OpenFence | null = null;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (fence !== null) {
      if (isFenceClosing(line.text, fence)) {
        nodes.push(makeFence(body, fence, line, true));
        fence = null;
      }
      index += 1;
      continue;
    }

    const opening = parseFenceOpening(line.text);
    if (opening !== undefined) {
      fence = { ...opening, start: line, openingLine: line.number };
      index += 1;
      continue;
    }

    const heading = parseHeading(line.text);
    if (heading !== undefined) {
      nodes.push(makeHeading(body, line, heading));
      index += 1;
      continue;
    }

    if (line.text === CONTENT_MARKER) {
      nodes.push(makePlaceholder(body, line));
      index += 1;
      continue;
    }

    const list = parseListMarker(line.text);
    if (list !== undefined) {
      let end = line;
      let itemCount = 1;
      let next = index + 1;
      while (next < lines.length) {
        const nextMarker = parseListMarker(lines[next]!.text);
        if (nextMarker === undefined || nextMarker.ordered !== list.ordered) break;
        end = lines[next]!;
        itemCount += 1;
        next += 1;
      }
      nodes.push(makeList(body, line, end, list.ordered, itemCount));
      index = next;
      continue;
    }
    index += 1;
  }

  if (fence !== null) {
    const ending = lines[lines.length - 1]!;
    const node = makeFence(body, fence, ending, false);
    nodes.push(node);
    diagnostics.push({
      code: "unterminated-fence",
      message: `Fenced code opened on line ${fence.openingLine} has no valid closing fence.`,
      span: node.span,
    });
  }

  return {
    nodes: disambiguateRepeatedAnchors(nodes),
    diagnostics,
    eol: metadata.eol ?? eolOf(body),
    bom: metadata.bom ?? hasBom,
    finalNewline: metadata.finalNewline ?? /(?:\r\n|\r|\n)$/.test(body),
    body,
  };
}

function subject(node: ContentNode): string {
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

function question(
  templateId: string,
  kind: ContentQuestionKind,
  questionSubject: string,
  anchorMaterial: string,
  prompt: string,
  choices: readonly string[],
): ContentContractQuestion {
  const anchorDigest = digest(anchorMaterial);
  return {
    questionId: digest(`${templateId}|${kind}|${questionSubject}|${anchorDigest}`),
    kind,
    subject: questionSubject,
    anchorDigest,
    anchorMaterial,
    prompt,
    choices,
  };
}

function applyDecisions(
  nodes: readonly ContentNode[],
  decisions: readonly ContentNodeDecision[],
  templateId: string,
): { readonly nodes: readonly ContentNode[]; readonly questions: readonly ContentContractQuestion[] } {
  const byAnchor = new Map<ContentDigest, { readonly required: boolean; readonly count: number }>();
  for (const decision of decisions) {
    const previous = byAnchor.get(decision.anchorDigest);
    byAnchor.set(decision.anchorDigest, {
      required: decision.required,
      count: (previous?.count ?? 0) + 1,
    });
  }
  const questions: ContentContractQuestion[] = [];
  const updated = nodes.map((node) => {
    if (node.kind === "placeholder") return node;
    const confirmed = byAnchor.get(node.anchorDigest);
    if (confirmed !== undefined && confirmed.count === 1) return { ...node, required: confirmed.required };
    questions.push(question(
      templateId,
      "content-section-requiredness",
      subject(node),
      node.anchorMaterial,
      `Should ${subject(node)} be required in generated notes?`,
      ["required", "optional"],
    ));
    return node;
  });
  return { nodes: updated, questions };
}

function contractFromScan(scanned: ScannedBody, nodes: readonly ContentNode[], order: ContentOrder): ContentFormatContract {
  return {
    version: 1,
    nodes,
    order,
    eol: scanned.eol,
    bom: scanned.bom,
    finalNewline: scanned.finalNewline,
    bodySignature: digest(scanned.body),
    wellFormed: scanned.diagnostics.length === 0,
    diagnostics: scanned.diagnostics,
  };
}

/**
 * Derives a body contract using a bounded, fence-aware line scan. The returned
 * nodes are certain observations; requiredness and strict ordering become
 * rules only when supplied through explicit decisions.
 */
export function deriveContentFormatContract(
  body: string,
  options: DeriveContentFormatContractOptions = {},
): DerivedContentFormatContract {
  const scanned = scanBody(body, options);
  const templateId = options.templateId ?? "template";
  const decisions = options.decisions?.nodes ?? [];
  const applied = applyDecisions(scanned.nodes, decisions, templateId);
  const confirmedOrder = options.decisions?.order;
  const order = confirmedOrder ?? "unordered";
  const questions = [...applied.questions];
  const required = applied.nodes.filter((node): node is ContentRequiredNode => node.kind !== "placeholder" && node.required);
  if (confirmedOrder === undefined && required.length >= 2) {
    const orderMaterial = required.map(node => node.anchorDigest).join("\u0001");
    questions.push(question(
      templateId,
      "content-order",
      "document-order",
      orderMaterial,
      "Should recognised body sections be required to appear in this order?",
      ["strict", "unordered"],
    ));
  }
  return { contract: contractFromScan(scanned, applied.nodes, order), questions };
}

function dynamicHeadingPattern(source: string): RegExp {
  let pattern = "^";
  let last = 0;
  for (const match of source.matchAll(DYNAMIC_TOKEN)) {
    pattern += escapeRegExp(source.slice(last, match.index));
    pattern += "[\\s\\S]+?";
    last = (match.index ?? 0) + match[0].length;
  }
  pattern += escapeRegExp(source.slice(last));
  return new RegExp(`${pattern}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bodyNodeMatches(expected: ContentNode, actual: ContentNode): boolean {
  if (expected.kind !== actual.kind) return false;
  if (expected.kind === "heading" && actual.kind === "heading") {
    return expected.level === actual.level && dynamicHeadingPattern(expected.text).test(actual.text);
  }
  if (expected.kind === "fenced-code" && actual.kind === "fenced-code") {
    return expected.char === actual.char && expected.info.trim() === actual.info.trim();
  }
  if (expected.kind === "list" && actual.kind === "list") {
    return expected.ordered === actual.ordered && actual.itemCount >= expected.itemCount;
  }
  return false;
}

function requiredNodes(contract: ContentFormatContract): readonly ContentRequiredNode[] {
  return contract.nodes.filter((node): node is ContentRequiredNode => node.kind !== "placeholder" && node.required);
}

/**
 * Validates a rendered or caller-supplied body against confirmed structure.
 * Create/update enforce only confirmed required nodes and their confirmed
 * relative order. Append is intentionally weaker: it cannot delete a node,
 * so it checks only that the resulting body still has closed fences. The
 * source marker is an insertion location and is never a required rendered
 * node.
 */
export function evaluateTemplateBodyContract(
  body: string,
  content: ContentFormatContract,
  options: EvaluateTemplateBodyContractOptions = {},
): TemplateBodyContractResult {
  const mode = options.mode ?? "update";
  const scanned = scanBody(body);
  const violations: TemplateBodyContractViolation[] = [];
  for (const diagnostic of scanned.diagnostics) {
    const fence = scanned.nodes.find(node => node.kind === "fenced-code" && !node.closed);
    violations.push({
      code: "unterminated-fence",
      rule: "fence",
      message: diagnostic.message,
      nodeKind: "fenced-code",
      ...(fence === undefined ? {} : { anchorDigest: fence.anchorDigest }),
    });
  }

  if (mode !== "append" && violations.length === 0) {
    const expected = requiredNodes(content);
    const actual = scanned.nodes;
    const matches: Array<{ readonly expected: ContentRequiredNode; readonly index: number }> = [];
    const consumed = new Set<number>();
    for (const wanted of expected) {
      let found = -1;
      for (let index = 0; index < actual.length; index += 1) {
        const candidate = actual[index]!;
        if (consumed.has(index) || !bodyNodeMatches(wanted, candidate)) continue;
        found = index;
        break;
      }
      if (found < 0) {
        violations.push({
          code: "required-node-missing",
          rule: "required",
          message: `Required ${subject(wanted)} is missing from the body.`,
          nodeKind: wanted.kind,
          subject: subject(wanted),
          anchorDigest: wanted.anchorDigest,
        });
      } else {
        consumed.add(found);
        matches.push({ expected: wanted, index: found });
      }
    }
    if (content.order === "strict" && matches.length > 1) {
      for (let index = 1; index < matches.length; index += 1) {
        const previous = matches[index - 1]!;
        const current = matches[index]!;
        if (current.index < previous.index) {
          violations.push({
            code: "order-mismatch",
            rule: "order",
            message: `Required body sections are out of order: ${subject(previous.expected)} must precede ${subject(current.expected)}.`,
            subject: "document-order",
          });
          break;
        }
      }
    }
  }
  return {
    valid: violations.length === 0,
    mode,
    violations,
    nodes: scanned.nodes,
    eol: scanned.eol,
    bom: scanned.bom,
    finalNewline: scanned.finalNewline,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseFailure(path: string, message: string): never {
  throw new Error(`CONTENT_CONTRACT_INVALID: ${path} ${message}`);
}

function exactKeys(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) parseFailure(`${path}.${key}`, "is not a supported property");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) parseFailure(`${path}.${key}`, "is required");
  }
}

function parseString(value: unknown, path: string): string {
  if (typeof value !== "string") parseFailure(path, "must be a string");
  return value;
}

function parseBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") parseFailure(path, "must be a boolean");
  return value;
}

function parseInteger(value: unknown, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) parseFailure(path, `must be an integer >= ${minimum}`);
  return value as number;
}

function parseBoundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  const parsed = parseInteger(value, path, minimum);
  if (parsed > maximum) parseFailure(path, `must be an integer <= ${maximum}`);
  return parsed;
}

function parseDigest(value: unknown, path: string): ContentDigest {
  const parsed = parseString(value, path);
  if (!DIGEST.test(parsed)) parseFailure(path, "must be a sha256 digest");
  return parsed as ContentDigest;
}

function parseSpan(value: unknown, path: string): ContentNodeSpan {
  if (!isRecord(value)) parseFailure(path, "must be an object");
  exactKeys(value, path, ["start", "end", "startLine", "endLine"]);
  const start = parseInteger(value.start, `${path}.start`, 0);
  const end = parseInteger(value.end, `${path}.end`, start);
  const startLine = parseInteger(value.startLine, `${path}.startLine`, 1);
  const endLine = parseInteger(value.endLine, `${path}.endLine`, startLine);
  return { start, end, startLine, endLine };
}

function parseNode(value: unknown, path: string): ContentNode {
  if (!isRecord(value)) parseFailure(path, "must be an object");
  const kind = parseString(value.kind, `${path}.kind`);
  if (kind === "heading") {
    exactKeys(value, path, ["kind", "level", "text", "required", "span", "anchorMaterial", "anchorDigest"]);
    const anchorMaterial = parseString(value.anchorMaterial, `${path}.anchorMaterial`);
    const anchorDigest = parseDigest(value.anchorDigest, `${path}.anchorDigest`);
    if (digest(anchorMaterial) !== anchorDigest) parseFailure(`${path}.anchorDigest`, "does not match anchorMaterial");
    return {
      kind: "heading",
      level: parseBoundedInteger(value.level, `${path}.level`, 1, 6),
      text: parseString(value.text, `${path}.text`),
      required: parseBoolean(value.required, `${path}.required`),
      span: parseSpan(value.span, `${path}.span`),
      anchorMaterial,
      anchorDigest,
    };
  }
  if (kind === "fenced-code") {
    exactKeys(value, path, ["kind", "char", "fenceLength", "info", "closed", "required", "span", "anchorMaterial", "anchorDigest"]);
    const char = parseString(value.char, `${path}.char`);
    if (char !== "`" && char !== "~") parseFailure(`${path}.char`, "must be ` or ~");
    const anchorMaterial = parseString(value.anchorMaterial, `${path}.anchorMaterial`);
    const anchorDigest = parseDigest(value.anchorDigest, `${path}.anchorDigest`);
    if (digest(anchorMaterial) !== anchorDigest) parseFailure(`${path}.anchorDigest`, "does not match anchorMaterial");
    return {
      kind: "fenced-code",
      char,
      fenceLength: parseInteger(value.fenceLength, `${path}.fenceLength`, 3),
      info: parseString(value.info, `${path}.info`),
      closed: parseBoolean(value.closed, `${path}.closed`),
      required: parseBoolean(value.required, `${path}.required`),
      span: parseSpan(value.span, `${path}.span`),
      anchorMaterial,
      anchorDigest,
    };
  }
  if (kind === "list") {
    exactKeys(value, path, ["kind", "ordered", "itemCount", "required", "span", "anchorMaterial", "anchorDigest"]);
    const anchorMaterial = parseString(value.anchorMaterial, `${path}.anchorMaterial`);
    const anchorDigest = parseDigest(value.anchorDigest, `${path}.anchorDigest`);
    if (digest(anchorMaterial) !== anchorDigest) parseFailure(`${path}.anchorDigest`, "does not match anchorMaterial");
    return {
      kind: "list",
      ordered: parseBoolean(value.ordered, `${path}.ordered`),
      itemCount: parseInteger(value.itemCount, `${path}.itemCount`, 1),
      required: parseBoolean(value.required, `${path}.required`),
      span: parseSpan(value.span, `${path}.span`),
      anchorMaterial,
      anchorDigest,
    };
  }
  if (kind === "placeholder") {
    exactKeys(value, path, ["kind", "token", "span", "anchorMaterial", "anchorDigest"]);
    const token = parseString(value.token, `${path}.token`);
    if (token !== CONTENT_MARKER) parseFailure(`${path}.token`, "must be the oms content marker");
    const anchorMaterial = parseString(value.anchorMaterial, `${path}.anchorMaterial`);
    const anchorDigest = parseDigest(value.anchorDigest, `${path}.anchorDigest`);
    if (digest(anchorMaterial) !== anchorDigest) parseFailure(`${path}.anchorDigest`, "does not match anchorMaterial");
    return {
      kind: "placeholder",
      token,
      span: parseSpan(value.span, `${path}.span`),
      anchorMaterial,
      anchorDigest,
    };
  }
  parseFailure(`${path}.kind`, "is unsupported");
}

function parseDiagnostic(value: unknown, path: string): ContentContractDiagnostic {
  if (!isRecord(value)) parseFailure(path, "must be an object");
  exactKeys(value, path, ["code", "message"], ["span"]);
  const code = parseString(value.code, `${path}.code`);
  if (code !== "unterminated-fence") parseFailure(`${path}.code`, "is unsupported");
  return {
    code,
    message: parseString(value.message, `${path}.message`),
    ...(value.span === undefined ? {} : { span: parseSpan(value.span, `${path}.span`) }),
  };
}

/**
 * Parses the canonical serialised contract shape. Unknown properties,
 * malformed node variants, invalid digests, contradictory diagnostics, and
 * duplicate/overlapping spans are rejected rather than silently projected.
 */
export function parseContentFormatContract(input: unknown): ContentFormatContract {
  if (!isRecord(input)) parseFailure("contract", "must be an object");
  exactKeys(input, "contract", ["version", "nodes", "order", "eol", "bom", "finalNewline", "bodySignature", "wellFormed", "diagnostics"]);
  if (input.version !== 1) parseFailure("contract.version", "must be 1");
  if (!Array.isArray(input.nodes)) parseFailure("contract.nodes", "must be an array");
  const nodes = input.nodes.map((node, index) => parseNode(node, `contract.nodes[${index}]`));
  let previousEnd = -1;
  let previousStart = -1;
  for (const [index, node] of nodes.entries()) {
    if (node.span.start < previousEnd) parseFailure(`contract.nodes[${index}].span`, "overlaps or is out of order");
    if (node.span.start === previousStart && node.span.end === previousEnd) parseFailure(`contract.nodes[${index}].span`, "duplicates a previous node span");
    previousStart = node.span.start;
    previousEnd = node.span.end;
  }
  const order = parseString(input.order, "contract.order");
  if (order !== "strict" && order !== "unordered") parseFailure("contract.order", "must be strict or unordered");
  const eol = parseString(input.eol, "contract.eol");
  if (eol !== "lf" && eol !== "crlf") parseFailure("contract.eol", "must be lf or crlf");
  const bom = parseBoolean(input.bom, "contract.bom");
  const finalNewline = parseBoolean(input.finalNewline, "contract.finalNewline");
  const bodySignature = parseDigest(input.bodySignature, "contract.bodySignature");
  const wellFormed = parseBoolean(input.wellFormed, "contract.wellFormed");
  if (!Array.isArray(input.diagnostics)) parseFailure("contract.diagnostics", "must be an array");
  const diagnostics = input.diagnostics.map((diagnostic, index) => parseDiagnostic(diagnostic, `contract.diagnostics[${index}]`));
  if (wellFormed !== (diagnostics.length === 0)) parseFailure("contract.wellFormed", "must agree with diagnostics");
  const hasUnclosedFence = nodes.some(node => node.kind === "fenced-code" && !node.closed);
  const hasFenceDiagnostic = diagnostics.some(diagnostic => diagnostic.code === "unterminated-fence");
  if (hasUnclosedFence !== hasFenceDiagnostic) parseFailure("contract.diagnostics", "must describe every unterminated fence");
  return {
    version: 1,
    nodes,
    order,
    eol,
    bom,
    finalNewline,
    bodySignature,
    wellFormed,
    diagnostics,
  };
}
