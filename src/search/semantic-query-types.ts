import type { SemanticStatusOptions } from "./semantic-provider-types.js";

export interface SemanticHitEvidence {
  readonly lexical: boolean;
  readonly vector: boolean;
}

export type SemanticSearchMode = "query" | "search" | "vsearch";
export type SemanticSearchFormat = "json" | "files";
export type SemanticTypedSearchType = "lex" | "vec" | "hyde";

export interface SemanticTypedSearch {
  readonly type: SemanticTypedSearchType;
  readonly query: string;
}

export interface SemanticSearchHit {
  readonly docid: string;
  readonly score: number;
  readonly uri: string;
  readonly path: string;
  readonly line?: number;
  readonly title?: string;
  readonly snippet: string;
  readonly context?: string;
  readonly evidence: SemanticHitEvidence;
}

export type SemanticQueryResult =
  | { readonly available: true; readonly hits: readonly SemanticSearchHit[] }
  | { readonly available: false; readonly reason: string; readonly hits: readonly SemanticSearchHit[] };

export interface SemanticDocument {
  readonly target: string;
  readonly path: string;
  readonly content: string;
  readonly docid?: string;
  readonly title?: string;
  readonly uri?: string;
}

export type SemanticDocumentResult =
  | { readonly available: true; readonly documents: readonly SemanticDocument[] }
  | { readonly available: false; readonly reason: string; readonly documents: readonly SemanticDocument[] };

export interface SemanticQueryOptions extends SemanticStatusOptions {
  readonly query: string;
  readonly collection?: string;
  readonly limit?: number;
  readonly mode?: SemanticSearchMode;
  readonly intent?: string;
  readonly searches?: readonly SemanticTypedSearch[];
  readonly lex?: string;
  readonly vec?: string;
  readonly hyde?: string;
  readonly minScore?: number;
  readonly all?: boolean;
  readonly format?: SemanticSearchFormat;
  readonly full?: boolean;
  readonly lineNumbers?: boolean;
  readonly fullPath?: boolean;
  readonly chunkStrategy?: string;
  readonly candidateLimit?: number;
  readonly noRerank?: boolean;
}

export interface SemanticGetOptions extends SemanticStatusOptions {
  readonly target: string;
  readonly collection?: string;
  readonly fromLine?: number;
  readonly lineCount?: number;
  readonly lineNumbers?: boolean;
  readonly fullPath?: boolean;
}

export interface SemanticMultiGetOptions extends SemanticStatusOptions {
  readonly targets: readonly string[];
  readonly collection?: string;
  readonly lineLimit?: number;
  readonly maxBytes?: number;
  readonly lineNumbers?: boolean;
  readonly fullPath?: boolean;
}
