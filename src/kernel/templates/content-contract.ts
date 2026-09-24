import type { ResolvedContract, ResolvedHeading } from "./types.js";

/**
 * Checks required ATX headings in a note body. The scan does not derive a contract,
 * expand tokens, or treat OMS markers as structure. Headings inside fenced code are ignored.
 * Extra headings, including descendants, are legal. Unordered is the default; strict is opt-in.
 */

export type TemplateBodyHeadingRuleId =
  | "HEADING_MISSING"
  | "HEADING_LEVEL_MISMATCH"
  | "HEADING_ORDER_MISMATCH";

/** One failed heading rule. `headingId` is set for every rule this scanner emits. */
export interface TemplateBodyHeadingViolation {
  readonly ruleId: TemplateBodyHeadingRuleId;
  readonly headingId?: string;
  readonly message: string;
}

export interface TemplateBodyContractResult {
  readonly valid: boolean;
  readonly violations: readonly TemplateBodyHeadingViolation[];
}

const MAX_BODY_BYTES = 1_048_576;
const MAX_BODY_LINES = 100_000;

interface SourceLine {
  readonly text: string;
  readonly number: number;
}

export interface ObservedHeading {
  readonly title: string;
  readonly level: number;
  readonly line: number;
}

interface OpenFence {
  readonly char: "`" | "~";
  readonly length: number;
}

interface Assignment {
  readonly heading: ResolvedHeading;
  readonly index: number;
  readonly observed?: ObservedHeading;
  readonly wrongLevel?: ObservedHeading;
}

function fail(message: string): never {
  throw new Error(`CONTENT_CONTRACT_INVALID: ${message}`);
}

function sourceLines(body: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  let number = 1;
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;
    const separatorLength = code === 13 && body.charCodeAt(index + 1) === 10 ? 2 : 1;
    lines.push({ text: body.slice(start, index), number });
    number += 1;
    index += separatorLength - 1;
    start = index + 1;
  }
  if (start < body.length || lines.length === 0) {
    lines.push({ text: body.slice(start), number });
  }
  return lines;
}

function openFence(line: string): OpenFence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) return undefined;
  const run = match[1];
  if (run === undefined) return undefined;
  const char = run[0];
  if (char !== "`" && char !== "~") return undefined;
  const rest = match[2] ?? "";
  if (char === "`" && rest.includes("`")) return undefined;
  return { char, length: run.length };
}

function closesFence(line: string, fence: OpenFence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (match === null) return false;
  const run = match[1];
  if (run === undefined || run.length < fence.length) return false;
  return run[0] === fence.char;
}

function atxHeading(line: string): { readonly level: number; readonly title: string } | undefined {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
  if (match === null) return undefined;
  const marks = match[1];
  if (marks === undefined) return undefined;
  const title = (match[2] ?? "").trim().replace(/[ \t]+#+[ \t]*$/, "").trim();
  return { level: marks.length, title };
}

export function scanContractHeadings(body: string, includeSetext = false): readonly ObservedHeading[] {
  const source = body.startsWith("\uFEFF") ? body.slice(1) : body;
  if (Buffer.byteLength(source, "utf8") > MAX_BODY_BYTES) {
    throw new Error(`CONTENT_CONTRACT_OVERSIZE: body exceeds ${MAX_BODY_BYTES} UTF-8 bytes`);
  }
  const lines = sourceLines(source);
  if (lines.length > MAX_BODY_LINES) {
    throw new Error(`CONTENT_CONTRACT_OVERSIZE: body exceeds ${MAX_BODY_LINES} lines`);
  }
  const headings: ObservedHeading[] = [];
  let fence: OpenFence | undefined;
  let paragraph: SourceLine[] = [];
  for (const line of lines) {
    if (fence !== undefined) {
      if (closesFence(line.text, fence)) fence = undefined;
      continue;
    }
    const opening = openFence(line.text);
    if (opening !== undefined) {
      fence = opening;
      paragraph = [];
      continue;
    }
    const heading = atxHeading(line.text);
    if (heading !== undefined) {
      headings.push({ title: heading.title.normalize("NFC"), level: heading.level, line: line.number });
      paragraph = [];
      continue;
    }
    if (!includeSetext) continue;
    const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(line.text);
    if (underline !== null) {
      if (paragraph.length > 0) {
        headings.push({
          title: paragraph.map(member => member.text.trim()).join(" ").normalize("NFC"),
          level: underline[1]!.startsWith("=") ? 1 : 2,
          line: paragraph[0]!.number,
        });
      }
      paragraph = [];
      continue;
    }
    if (line.text.trim() === "" || /^(?: {4}|\t| {0,3}(?:>|[-+*][ \t]|\d+[.)][ \t]|<))/.test(line.text)) {
      paragraph = [];
    } else {
      paragraph.push(line);
    }
  }
  return headings;
}

function readHeading(value: unknown, index: number): ResolvedHeading {
  const where = `headings[${index}]`;
  if (typeof value !== "object" || value === null) fail(`${where} must be an object`);
  const heading = value as Partial<ResolvedHeading>;
  if (typeof heading.headingId !== "string" || heading.headingId.length === 0) fail(`${where}.headingId must be a non-empty string`);
  if (typeof heading.title !== "string" || heading.title.trim().length === 0) fail(`${where}.title must be a non-empty string`);
  if (typeof heading.level !== "number" || !Number.isSafeInteger(heading.level) || heading.level < 1 || heading.level > 6) {
    fail(`${where}.level must be an integer from 1 to 6`);
  }
  if (heading.required !== true) fail(`${where}.required must be true`);
  return heading as ResolvedHeading;
}

function assign(headings: readonly ResolvedHeading[], observed: readonly ObservedHeading[]): readonly Assignment[] {
  const used = new Set<number>();
  return headings.map(heading => {
    const title = heading.title.normalize("NFC");
    let wrongLevel: ObservedHeading | undefined;
    for (let index = 0; index < observed.length; index += 1) {
      if (used.has(index)) continue;
      const candidate = observed[index];
      if (candidate === undefined || candidate.title !== title) continue;
      if (candidate.level !== heading.level) {
        if (wrongLevel === undefined) wrongLevel = candidate;
        continue;
      }
      used.add(index);
      return { heading, index, observed: candidate };
    }
    return wrongLevel === undefined ? { heading, index: -1 } : { heading, index: -1, wrongLevel };
  });
}

function diagnose(
  headings: readonly ResolvedHeading[],
  observed: readonly ObservedHeading[],
  headingOrder: ResolvedContract["headingOrder"],
): readonly TemplateBodyHeadingViolation[] {
  const assignments = assign(headings, observed);
  const violations: TemplateBodyHeadingViolation[] = [];
  for (const assignment of assignments) {
    if (assignment.index >= 0) continue;
    const { heading } = assignment;
    const wrongLevel = assignment.wrongLevel;
    if (wrongLevel !== undefined) {
      violations.push({
        ruleId: "HEADING_LEVEL_MISMATCH",
        headingId: heading.headingId,
        message: `Heading ${heading.headingId} (${heading.title}) must be level ${heading.level}, not ${wrongLevel.level}.`,
      });
      continue;
    }
    violations.push({
      ruleId: "HEADING_MISSING",
      headingId: heading.headingId,
      message: `Required heading ${heading.headingId} (${heading.title}) at level ${heading.level} is missing.`,
    });
  }
  if (headingOrder !== "strict") return violations;
  let previous: Assignment | undefined;
  for (const assignment of assignments) {
    if (assignment.index < 0 || previous === undefined) {
      if (assignment.index >= 0) previous = assignment;
      continue;
    }
    if (assignment.index < previous.index) {
      const heading = assignment.heading;
      violations.push({
        ruleId: "HEADING_ORDER_MISMATCH",
        headingId: heading.headingId,
        message: `Heading ${heading.headingId} (${heading.title}) must follow ${previous.heading.headingId} (${previous.heading.title}) when heading order is strict.`,
      });
      break;
    }
    previous = assignment;
  }
  return violations;
}

export function evaluateTemplateBodyContract(
  body: string,
  contract: Pick<ResolvedContract, "headings" | "headingOrder">,
): TemplateBodyContractResult {
  if (typeof body !== "string") fail("body must be a string");
  if (typeof contract !== "object" || contract === null) fail("contract must be an object");
  if (contract.headingOrder !== "unordered" && contract.headingOrder !== "strict") {
    fail("headingOrder must be unordered or strict");
  }
  if (!Array.isArray(contract.headings)) fail("headings must be an array");
  const headings = contract.headings.map((heading, index) => readHeading(heading, index));
  const violations = diagnose(headings, scanContractHeadings(body), contract.headingOrder);
  return { valid: violations.length === 0, violations };
}
