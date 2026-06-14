import type { SemanticProviderStatus } from "./semantic-provider-types.js";
import type { SemanticStorage } from "./semantic-index-types.js";

export type SemanticSyncStepName = "pull" | "scan" | "write-index" | "status";

export interface SemanticSyncStep {
  readonly name: SemanticSyncStepName;
  readonly status: number;
  readonly message: string;
  readonly documents?: number;
}

export interface SemanticEmbeddingSyncOptions {
  readonly vault: string;
  readonly collection?: string;
  readonly collectionPath?: string;
  readonly pattern?: string;
  readonly ignore?: readonly string[];
  readonly includeByDefault?: boolean;
  readonly updateCommand?: string;
  readonly context?: string;
  readonly ensureCollection?: boolean;
  readonly update?: boolean;
  readonly embed?: boolean;
  readonly force?: boolean;
  readonly pull?: boolean;
  readonly index?: string;
  readonly chunkStrategy?: string;
  readonly maxDocsPerBatch?: number;
  readonly maxBatchMb?: number;
  readonly storage?: SemanticStorage;
  readonly modelPath?: string;
}

export type SemanticEmbeddingSyncResult =
  | {
      readonly available: true;
      readonly storage: SemanticStorage;
      readonly collection?: string;
      readonly index?: string;
      readonly status: Extract<SemanticProviderStatus, { readonly available: true }>;
      readonly steps: readonly SemanticSyncStep[];
    }
  | {
      readonly available: false;
      readonly reason: string;
      readonly storage: SemanticStorage;
      readonly collection?: string;
      readonly index?: string;
      readonly steps: readonly SemanticSyncStep[];
    };
