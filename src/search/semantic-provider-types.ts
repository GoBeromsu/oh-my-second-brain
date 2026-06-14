import type { SemanticCollectionSummary, SemanticQmdCompatibility, SemanticStorage } from "./semantic-index-types.js";

export interface SemanticModels {
  readonly embedding?: string;
  readonly reranking?: string;
  readonly generation?: string;
}

export interface SemanticIndexDocuments {
  readonly total?: number;
  readonly vectors?: number;
  readonly pending?: number;
  readonly updated?: string;
}

export interface SemanticIndexStatus {
  readonly path?: string;
  readonly size?: string;
  readonly documents?: SemanticIndexDocuments;
}

export type SemanticProviderStatus =
  | {
      readonly available: true;
      readonly storage: SemanticStorage;
      readonly models: SemanticModels;
      readonly index?: SemanticIndexStatus;
      readonly collections?: readonly SemanticCollectionSummary[];
      readonly qmdCompatibility?: SemanticQmdCompatibility;
    }
  | { readonly available: false; readonly reason: string };

export interface SemanticStatusOptions {
  readonly vault?: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
  readonly modelPath?: string;
}
