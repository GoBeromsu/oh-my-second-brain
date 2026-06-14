import type { SemanticIndexedDocument } from "./semantic-types.js";

export interface ParsedLexQuery {
  readonly terms: readonly string[];
  readonly phrases: readonly string[];
  readonly excluded: readonly string[];
}

export interface ScoredDocument {
  readonly document: SemanticIndexedDocument;
  readonly lexical: number;
  readonly vector: number;
  readonly line?: number;
  readonly matchedLexical: boolean;
  readonly matchedVector: boolean;
}

export function tokenize(text: string): readonly string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu);
  return matches ?? [];
}

export function termFrequency(text: string): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const term of tokenize(text)) {
    counts[term] = (counts[term] ?? 0) + 1;
  }
  return counts;
}

export function uniqueSortedTerms(text: string): readonly string[] {
  return Array.from(new Set(tokenize(text))).sort();
}

export function parseLexQuery(query: string): ParsedLexQuery {
  const phrases: string[] = [];
  const phrasePattern = /"([^"]+)"/gu;
  let withoutPhrases = query;
  let phraseMatch: RegExpExecArray | null;
  while ((phraseMatch = phrasePattern.exec(query)) !== null) {
    const phrase = phraseMatch[1]?.trim().toLowerCase();
    if (phrase) phrases.push(phrase);
  }
  withoutPhrases = withoutPhrases.replace(phrasePattern, " ");

  const terms: string[] = [];
  const excluded: string[] = [];
  for (const raw of withoutPhrases.split(/\s+/u)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("-") && trimmed.length > 1) {
      excluded.push(...tokenize(trimmed.slice(1)));
      continue;
    }
    terms.push(...tokenize(trimmed));
  }

  return {
    terms: Array.from(new Set(terms)).sort(),
    phrases: Array.from(new Set(phrases)).sort(),
    excluded: Array.from(new Set(excluded)).sort(),
  };
}

export function cosineScore(
  queryFrequency: Readonly<Record<string, number>>,
  documentFrequency: Readonly<Record<string, number>>,
): number {
  let dot = 0;
  let queryMagnitude = 0;
  let documentMagnitude = 0;
  for (const value of Object.values(queryFrequency)) queryMagnitude += value * value;
  for (const value of Object.values(documentFrequency)) documentMagnitude += value * value;
  for (const [term, value] of Object.entries(queryFrequency)) {
    dot += value * (documentFrequency[term] ?? 0);
  }
  if (queryMagnitude === 0 || documentMagnitude === 0) return 0;
  return dot / (Math.sqrt(queryMagnitude) * Math.sqrt(documentMagnitude));
}

export function lexicalScore(query: ParsedLexQuery, document: SemanticIndexedDocument): {
  readonly score: number;
  readonly line?: number;
} {
  const lowerContent = document.content.toLowerCase();
  const documentTerms = Object.keys(document.termFrequency);
  const hasTerm = (term: string): boolean =>
    document.termFrequency[term] !== undefined || documentTerms.some((documentTerm) => documentTerm.startsWith(term));
  if (query.excluded.some((term) => hasTerm(term))) return { score: 0 };

  let matched = 0;
  for (const term of query.terms) {
    if (hasTerm(term)) matched += 1;
  }

  let phraseBonus = 0;
  for (const phrase of query.phrases) {
    if (lowerContent.includes(phrase)) phraseBonus += 1;
  }

  const denominator = Math.max(1, query.terms.length + query.phrases.length);
  const score = Math.min(1, (matched + phraseBonus) / denominator);
  return { score, line: firstMatchingLine(document.content, [...query.terms, ...query.phrases]) };
}

export function firstMatchingLine(content: string, needles: readonly string[]): number | undefined {
  const lowered = needles.map((needle) => needle.toLowerCase()).filter((needle) => needle.length > 0);
  if (lowered.length === 0) return undefined;
  const lines = content.split(/\r?\n/u);
  for (const [index, line] of visibleLineEntries(lines)) {
    const lowerLine = line.toLowerCase();
    if (lowered.some((needle) => lowerLine.includes(needle))) return index + 1;
  }
  return undefined;
}

function firstBodyLine(lines: readonly string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  const close = lines.slice(1).findIndex((line) => line.trim() === "---");
  return close < 0 ? 0 : close + 2;
}

function visibleLineEntries(lines: readonly string[]): readonly (readonly [number, string])[] {
  return lines
    .map((line, index) => [index, line] as const)
    .filter(([index]) => index >= firstBodyLine(lines));
}

export function snippetAroundLine(content: string, line: number | undefined): string {
  const lines = content.split(/\r?\n/u);
  const center = Math.max(firstBodyLine(lines), (line ?? firstBodyLine(lines) + 1) - 1);
  const start = Math.max(0, center - 1);
  const end = Math.min(lines.length, center + 2);
  return lines
    .slice(start, end)
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== "---")
    .join(" ")
    .slice(0, 400);
}
