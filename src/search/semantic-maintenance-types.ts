import type { SemanticCollectionSummary, SemanticStorage } from "./semantic-index-types.js";
import type { SemanticModels } from "./semantic-provider-types.js";

export type SemanticCollectionResult =
  | { readonly available: true; readonly collections: readonly SemanticCollectionSummary[] }
  | { readonly available: false; readonly reason: string; readonly collections: readonly SemanticCollectionSummary[] };

export type SemanticCollectionMutationResult =
  | {
      readonly available: true;
      readonly collection: string;
      readonly renamed?: boolean;
      readonly removed?: boolean;
      readonly updated?: boolean;
    }
  | { readonly available: false; readonly reason: string; readonly collection?: string };

export type SemanticContextResult =
  | { readonly available: true; readonly contexts: readonly import("./semantic-index-types.js").SemanticStoredContext[] }
  | { readonly available: false; readonly reason: string; readonly contexts: readonly import("./semantic-index-types.js").SemanticStoredContext[] };

export interface SemanticDocumentListing {
  readonly collection: string;
  readonly path: string;
  readonly docid: string;
  readonly title?: string;
  readonly uri: string;
  readonly lineCount: number;
  readonly size: number;
}

export type SemanticDocumentListingResult =
  | { readonly available: true; readonly documents: readonly SemanticDocumentListing[] }
  | { readonly available: false; readonly reason: string; readonly documents: readonly SemanticDocumentListing[] };

export type SemanticCleanupResult =
  | {
      readonly available: true;
      readonly storage: SemanticStorage;
      readonly removedDocuments: number;
      readonly remainingDocuments: number;
      readonly collections: number;
    }
  | { readonly available: false; readonly storage: SemanticStorage; readonly reason: string };

export interface SemanticDoctorCheck {
  readonly name: string;
  readonly status: "pass" | "warn" | "fail" | "unsupported";
  readonly detail: string;
}

export type SemanticDoctorResult =
  | {
      readonly available: true;
      readonly storage: SemanticStorage;
      readonly checks: readonly SemanticDoctorCheck[];
    }
  | {
      readonly available: false;
      readonly storage: SemanticStorage;
      readonly reason: string;
      readonly checks: readonly SemanticDoctorCheck[];
    };

export interface SemanticInitResult {
  readonly available: boolean;
  readonly initialized: boolean;
  readonly storage: SemanticStorage;
  readonly index: string;
}

export interface SemanticPullResult {
  readonly available: true;
  readonly storage: SemanticStorage;
  readonly models: SemanticModels;
  readonly message: string;
}

export type SemanticBenchmarkResult =
  | {
      readonly available: true;
      readonly total: number;
      readonly passed: number;
      readonly failed: number;
      readonly cases: readonly {
        readonly query: string;
        readonly expected: string;
        readonly hit?: string;
        readonly pass: boolean;
      }[];
    }
  | {
      readonly available: false;
      readonly reason: string;
      readonly total: 0;
      readonly passed: 0;
      readonly failed: 0;
      readonly cases: readonly [];
    };
