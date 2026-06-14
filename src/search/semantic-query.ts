import path from "node:path";
import { normalizeSemanticStorage, readSemanticIndex, SEMANTIC_SQLITE_STORAGE } from "./semantic-index.js";
import { querySqliteSemanticStore } from "./semantic-sqlite-query.js";
import {
  cosineScore,
  firstMatchingLine,
  lexicalScore,
  parseLexQuery,
  snippetAroundLine,
  termFrequency,
  tokenize,
} from "./semantic-token.js";
import type {
  SemanticIndexFile,
  SemanticIndexedDocument,
  SemanticQueryOptions,
  SemanticQueryResult,
  SemanticSearchHit,
  SemanticTypedSearch,
} from "./semantic-types.js";

interface QueryTexts {
  readonly lexical: readonly string[];
  readonly vector: readonly string[];
}

interface ParsedQueryDocument {
  readonly intent?: string;
  readonly searches: readonly SemanticTypedSearch[];
  readonly fallback?: string;
}

interface RankedDocument {
  readonly document: SemanticIndexedDocument;
  readonly lexical: number;
  readonly vector: number;
  readonly score: number;
  readonly line?: number;
}

function parseQueryDocument(query: string): ParsedQueryDocument {
  const searches: SemanticTypedSearch[] = [];
  let intent: string | undefined;
  const fallback: string[] = [];
  let sawStructuredLine = false;
  for (const rawLine of query.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(intent|lex|vec|hyde|expand):\s*(.+)$/u.exec(line);
    if (!match) {
      fallback.push(line);
      continue;
    }
    sawStructuredLine = true;
    const key = match[1];
    const value = match[2]?.trim();
    if (!value) continue;
    if (key === "intent") {
      intent = value;
    } else if (key === "expand") {
      searches.push({ type: "lex", query: value }, { type: "vec", query: value }, { type: "hyde", query: value });
    } else if (key === "lex" || key === "vec" || key === "hyde") {
      searches.push({ type: key, query: value });
    }
  }
  if (!sawStructuredLine) return { searches: [], fallback: query.trim() || undefined };
  return { intent, searches, fallback: fallback.join("\n").trim() || undefined };
}

function typedSearches(opts: SemanticQueryOptions): readonly SemanticTypedSearch[] {
  const parsed = parseQueryDocument(opts.query);
  const direct: SemanticTypedSearch[] = [];
  if (opts.lex?.trim()) direct.push({ type: "lex", query: opts.lex.trim() });
  if (opts.vec?.trim()) direct.push({ type: "vec", query: opts.vec.trim() });
  if (opts.hyde?.trim()) direct.push({ type: "hyde", query: opts.hyde.trim() });
  return [...parsed.searches, ...direct, ...(opts.searches ?? [])].filter((search) => search.query.trim().length > 0);
}

function queryTexts(opts: SemanticQueryOptions): QueryTexts {
  const parsed = parseQueryDocument(opts.query);
  const searches = typedSearches(opts);
  const lexical = searches.filter((search) => search.type === "lex").map((search) => search.query);
  const vector = searches.filter((search) => search.type === "vec" || search.type === "hyde").map((search) => search.query);
  const fallback = parsed.fallback ?? opts.query.trim();
  const intent = opts.intent?.trim() ?? parsed.intent;
  return {
    lexical: lexical.length > 0 ? lexical : fallback ? [fallback] : [],
    vector: vector.length > 0 ? [...vector, ...(intent ? [intent] : [])] : fallback ? [fallback, ...(intent ? [intent] : [])] : [],
  };
}

function weightedText(texts: readonly string[]): string {
  const first = texts[0];
  return [first, ...texts].filter((value) => value && value.trim().length > 0).join("\n");
}

function maxLexicalScore(texts: readonly string[], document: SemanticIndexedDocument): {
  readonly score: number;
  readonly line?: number;
} {
  let score = 0;
  let line: number | undefined;
  for (const text of texts) {
    const current = lexicalScore(parseLexQuery(text), document);
    if (current.score > score) {
      score = current.score;
      line = current.line;
    }
  }
  return { score, line };
}

function contextForDocument(index: SemanticIndexFile, document: SemanticIndexedDocument): string {
  const contexts = [];
  if (index.globalContext?.trim()) contexts.push(index.globalContext.trim());
  const collectionContext = index.collections?.find((collection) => collection.name === document.collection)?.context;
  if (collectionContext?.trim()) contexts.push(collectionContext.trim());
  for (const entry of index.contexts ?? []) {
    if (entry.collection && entry.collection !== document.collection) continue;
    const prefix = entry.pathPrefix === "." ? "" : entry.pathPrefix.replace(/^\.?\//u, "");
    if (prefix.length === 0 || document.path.startsWith(prefix)) contexts.push(entry.context);
  }
  return contexts.join("\n");
}

function documentWithContext(index: SemanticIndexFile, document: SemanticIndexedDocument): SemanticIndexedDocument {
  const context = contextForDocument(index, document);
  if (!context) return document;
  const content = `${context}\n${document.content}`;
  return {
    ...document,
    content,
    terms: tokenize(content),
    termFrequency: termFrequency(content),
  };
}

function scoreDocuments(
  opts: SemanticQueryOptions,
  index: SemanticIndexFile,
  documents: readonly SemanticIndexedDocument[],
): readonly RankedDocument[] {
  const texts = queryTexts(opts);
  const useLexical = opts.mode !== "vsearch";
  const useVector = opts.mode !== "search";
  const vectorFrequency = termFrequency(weightedText(texts.vector));
  const prelim = documents.map((rawDocument) => {
    const document = documentWithContext(index, rawDocument);
    const lexical = useLexical ? maxLexicalScore(texts.lexical, document) : { score: 0 };
    const vector = useVector ? cosineScore(vectorFrequency, document.termFrequency) : 0;
    const vectorLine = useVector ? firstMatchingLine(document.content, tokenize(weightedText(texts.vector))) : undefined;
    return {
      document: rawDocument,
      lexical: lexical.score,
      vector,
      line: lexical.line ?? vectorLine,
    };
  });

  const lexicalRanks = rankScores(prelim.map((item) => ({ key: item.document.docid, score: item.lexical })));
  const vectorRanks = rankScores(prelim.map((item) => ({ key: item.document.docid, score: item.vector })));

  return prelim.map((item) => {
    const lexicalRrf = item.lexical > 0 ? 1 / (60 + (lexicalRanks.get(item.document.docid) ?? 1000)) : 0;
    const vectorRrf = item.vector > 0 ? 1 / (60 + (vectorRanks.get(item.document.docid) ?? 1000)) : 0;
    const topBonus = (lexicalRanks.get(item.document.docid) === 1 ? 0.04 : 0) + (vectorRanks.get(item.document.docid) === 1 ? 0.04 : 0);
    const blended = (item.lexical + item.vector) / (useLexical && useVector ? 2 : 1);
    const score = Math.min(1, blended * 0.8 + (lexicalRrf + vectorRrf) * 6 + topBonus);
    return { ...item, score };
  });
}

function rankScores(items: readonly { readonly key: string; readonly score: number }[]): ReadonlyMap<string, number> {
  return new Map(
    [...items]
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
      .map((item, index) => [item.key, index + 1]),
  );
}

function hitPath(opts: SemanticQueryOptions, indexVault: string, document: SemanticIndexedDocument): string {
  return opts.fullPath === true ? path.join(indexVault, document.path) : document.path;
}

function hitFromRanked(opts: SemanticQueryOptions, index: SemanticIndexFile, ranked: RankedDocument): SemanticSearchHit {
  const snippet = snippetAroundLine(ranked.document.content, ranked.line);
  const configuredContext = contextForDocument(index, ranked.document);
  const context = [configuredContext, opts.full === true ? ranked.document.content : snippet]
    .filter((value) => value && value.length > 0)
    .join("\n");
  return {
    docid: ranked.document.docid,
    score: Number(ranked.score.toFixed(6)),
    uri: ranked.document.uri,
    path: hitPath(opts, index.vault, ranked.document),
    line: ranked.line,
    title: ranked.document.title,
    snippet: snippet || ranked.document.title || ranked.document.path,
    context,
    evidence: {
      lexical: ranked.lexical > 0,
      vector: ranked.vector > 0,
    },
  };
}

export async function querySemanticStore(opts: SemanticQueryOptions): Promise<SemanticQueryResult> {
  if (normalizeSemanticStorage(opts.storage) === SEMANTIC_SQLITE_STORAGE) return querySqliteSemanticStore(opts);
  return queryJsonSemanticStore(opts);
}

async function queryJsonSemanticStore(opts: SemanticQueryOptions): Promise<SemanticQueryResult> {
  const loaded = await readSemanticIndex(opts);
  if (!loaded.available) return { available: false, reason: loaded.reason, hits: [] };
  const collection = opts.collection?.trim();
  const documents = collection
    ? loaded.index.documents.filter((document) => document.collection === collection)
    : loaded.index.documents;
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
  const candidateLimit = Math.max(limit, Math.min(opts.candidateLimit ?? 100, 500));
  const minScore = opts.minScore ?? 0;
  const ranked = scoreDocuments(opts, loaded.index, documents)
    .filter((item) => opts.all === true || item.score > 0)
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score || a.document.path.localeCompare(b.document.path))
    .slice(0, candidateLimit)
    .slice(0, limit)
    .map((item) => hitFromRanked(opts, loaded.index, item));

  return { available: true, hits: ranked };
}
