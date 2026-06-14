import { createSemanticEmbeddingProvider } from "./semantic-embedding-provider.js";
import { vectorBuffer } from "./semantic-embedding-hash.js";
import { normalizeCollection } from "./semantic-index-core.js";
import { openSemanticSqliteStore } from "./semantic-sqlite-db.js";
import { firstMatchingLine, snippetAroundLine, tokenize } from "./semantic-token.js";
import type { SemanticQueryOptions, SemanticQueryResult, SemanticSearchHit } from "./semantic-types.js";

interface CandidateRow {
  readonly docid: string;
  readonly collection: string;
  readonly path: string;
  readonly uri: string;
  readonly title: string | null;
  readonly content: string;
}

interface LexRow extends CandidateRow {
  readonly rank: number;
}

interface VecRow extends CandidateRow {
  readonly distance: number;
}

interface ContextRow {
  readonly collection: string | null;
  readonly path_prefix: string;
  readonly context: string;
}

function queryTexts(opts: SemanticQueryOptions): { readonly lexical: string; readonly vector: string } {
  const lines = opts.query.split(/\r?\n/u);
  const typed = lines.flatMap((line) => {
    const match = /^(lex|vec|hyde|intent):\s*(.+)$/u.exec(line.trim());
    return match?.[1] && match[2] ? [{ type: match[1], query: match[2] }] : [];
  });
  const searches = opts.searches ?? typed;
  const lexical = [opts.lex, ...searches.filter((entry) => entry.type === "lex").map((entry) => entry.query)].filter(Boolean).join(" ");
  const vector = [
    opts.vec,
    opts.hyde,
    opts.intent,
    ...searches.filter((entry) => entry.type === "vec" || entry.type === "hyde").map((entry) => entry.query),
  ].filter(Boolean).join(" ");
  const plain = typed.length === 0 && searches.length === 0 ? opts.query : "";
  return {
    lexical: lexical || plain,
    vector: vector || plain,
  };
}

function ftsQuery(text: string): string {
  return tokenize(text)
    .slice(0, 32)
    .map((term) => `${term.replace(/"/gu, "")}*`)
    .join(" OR ");
}

function contextForRow(row: CandidateRow, contexts: readonly ContextRow[]): string | undefined {
  const values = contexts.flatMap((entry) => {
    if (entry.collection && entry.collection !== row.collection) return [];
    const prefix = entry.path_prefix === "." ? "" : entry.path_prefix.replace(/^\.?\//u, "");
    return prefix.length === 0 || row.path.startsWith(prefix) ? [entry.context] : [];
  });
  return values.length > 0 ? values.join("\n") : undefined;
}

function rowHit(
  row: CandidateRow,
  score: number,
  evidence: SemanticSearchHit["evidence"],
  lineTerms: string,
  contexts: readonly ContextRow[],
): SemanticSearchHit {
  const line = firstMatchingLine(row.content, tokenize(lineTerms));
  const snippet = snippetAroundLine(row.content, line);
  const context = [contextForRow(row, contexts), snippet].filter((value) => value && value.length > 0).join("\n");
  return {
    docid: row.docid,
    score,
    uri: row.uri,
    path: row.path,
    line,
    title: row.title ?? undefined,
    snippet,
    context: context || undefined,
    evidence,
  };
}

function mergeHits(
  lexRows: readonly LexRow[],
  vecRows: readonly VecRow[],
  opts: SemanticQueryOptions,
  contexts: readonly ContextRow[],
): readonly SemanticSearchHit[] {
  const texts = queryTexts(opts);
  const lexScores = new Map(lexRows.map((row, index) => [row.docid, 1 / (index + 1)]));
  const vecScores = new Map(vecRows.map((row) => [row.docid, 1 / (1 + Math.max(0, row.distance))]));
  const byDocid = new Map<string, CandidateRow>();
  for (const row of [...lexRows, ...vecRows]) byDocid.set(row.docid, row);
  return Array.from(byDocid.values())
    .map((row) => {
      const lexical = lexScores.get(row.docid) ?? 0;
      const vector = vecScores.get(row.docid) ?? 0;
      const score = Math.min(1, lexical * 0.52 + vector * 0.48);
      return rowHit(row, score, { lexical: lexical > 0, vector: vector > 0 }, `${texts.lexical} ${texts.vector}`, contexts);
    })
    .filter((hit) => opts.all === true || hit.score >= (opts.minScore ?? 0))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, opts.limit ?? 10));
}

export async function querySqliteSemanticStore(opts: SemanticQueryOptions): Promise<SemanticQueryResult> {
  let store;
  try {
    store = await openSemanticSqliteStore({ vault: opts.vault, index: opts.index, readonly: true, fileMustExist: true });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { available: false, reason: `OMS SQLite semantic store not found; run oms semantic sync first. ${detail}`, hits: [] };
  }
  try {
    const texts = queryTexts(opts);
    const collection = normalizeCollection(opts.collection);
    const useLexical = opts.mode !== "vsearch";
    const useVector = opts.mode !== "search";
    const lexQuery = ftsQuery(texts.lexical);
    const provider = useVector && store.vectorAvailable
      ? await createSemanticEmbeddingProvider({ modelPath: opts.modelPath })
      : undefined;
    const lexRows = useLexical && lexQuery
      ? store.db.prepare<[string, string], LexRow>(`
          SELECT d.*, bm25(documents_fts) AS rank
          FROM documents_fts
          JOIN documents d ON d.docid = documents_fts.docid
          WHERE documents_fts MATCH ? AND d.collection = ?
          ORDER BY rank
          LIMIT 80
        `).all(lexQuery, collection)
      : [];
    try {
      const vecRows = provider
        ? store.db.prepare<[Buffer, number, string], VecRow>(`
          SELECT d.*, v.distance
          FROM document_vectors v
          JOIN documents d ON d.rowid = v.rowid
          WHERE v.embedding MATCH ? AND k = ? AND d.collection = ?
          ORDER BY v.distance
        `).all(vectorBuffer(await provider.embed(texts.vector)), 80, collection)
        : [];
      const contexts = store.db.prepare<[], ContextRow>("SELECT collection, path_prefix, context FROM store_contexts").all();
      return { available: true, hits: mergeHits(lexRows, vecRows, opts, contexts) };
    } finally {
      await provider?.dispose();
    }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { available: false, reason: detail, hits: [] };
  } finally {
    store.db.close();
  }
}
