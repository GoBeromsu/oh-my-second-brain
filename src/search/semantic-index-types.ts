export type SemanticStorage = "qmd-sqlite" | "oms-native-json";

export interface SemanticIndexedDocument {
  readonly collection: string;
  readonly path: string;
  readonly uri: string;
  readonly docid: string;
  readonly title?: string;
  readonly content: string;
  readonly terms: readonly string[];
  readonly termFrequency: Readonly<Record<string, number>>;
  readonly lineCount: number;
  readonly mtimeMs: number;
  readonly size: number;
}

export interface SemanticCollectionSummary {
  readonly name: string;
  readonly path: string;
  readonly pattern: string;
  readonly ignore: readonly string[];
  readonly includeByDefault: boolean;
  readonly updateCommand?: string;
  readonly context?: string;
  readonly documents: number;
  readonly activeDocuments: number;
  readonly lastModified?: string;
}

export interface SemanticStoredContext {
  readonly collection?: string;
  readonly pathPrefix: string;
  readonly context: string;
  readonly updatedAt: string;
}

export interface SemanticQmdCompatibility {
  readonly queryDocument: true;
  readonly storage: "metadata-compatible";
  readonly unsupportedInternals: readonly string[];
}

export interface SemanticIndexFile {
  readonly version: 1;
  readonly storage: SemanticStorage;
  readonly generatedAt: string;
  readonly vault: string;
  readonly collection: string;
  readonly chunkStrategy?: string;
  readonly collections?: readonly SemanticCollectionSummary[];
  readonly contexts?: readonly SemanticStoredContext[];
  readonly globalContext?: string;
  readonly qmdCompatibility?: SemanticQmdCompatibility;
  readonly documents: readonly SemanticIndexedDocument[];
}
