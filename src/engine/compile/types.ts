/**
 * Local compile types for M2.
 *
 * PARALLEL-SAFETY: These types are LOCAL to src/engine/compile/.
 * Do NOT import from the shared src/engine/types.ts (read-only per plan).
 * Do NOT touch the shared types.ts.
 */

/** Provenance grade classifying the curation level of a material relative to the vault owner. */
export type ProvenanceGrade = "authored" | "curated" | "external-raw";

/** A single material item (source document) prepared for compilation. */
export interface Material {
  /** Vault-relative path to the source document. */
  path: string;
  /** Raw text content of the material. */
  text: string;
  /** Provenance grade, resolved from folder->grade map at setup time (not hardcoded). */
  grade: ProvenanceGrade;
}

/**
 * Minimal graph view needed by the compile layer.
 * Provides backlink lookup without coupling to the full engine graph type.
 */
export interface CompileGraph {
  /** Return all vault-relative paths whose wiki pages link TO `docPath`. */
  getBacklinks(docPath: string): string[];
}

/**
 * LLM provider injection seam.
 * Inject a real provider at runtime; use deterministicStubProvider in tests.
 * Mirrors the EmbeddingProvider injection pattern from src/engine/embed/provider.ts.
 */
export interface LLMProvider {
  complete(prompt: string): Promise<string>;
}

/** Step 1 output of nashsu 2-step CoT: analysis pass results. */
export interface CoTStep1Result {
  entities: string[];
  concepts: string[];
  arguments: string[];
  contradictions: string[];
  structure: string;
}

/** Full output of the 2-step CoT pipeline (step1 + step2 body). */
export interface CoTResult {
  step1: CoTStep1Result;
  /** Synthesized Markdown body with [[wikilinks]] (from Step 2). */
  body: string;
}

/** Core result produced by the stateless compile worker. */
export interface CompileResult {
  /** Synthesized page body (Markdown with [[wikilinks]]). Empty string signals a cache-hit skip. */
  body: string;
  /** SHA-256 hex digest of the input-material fingerprint. */
  sha: string;
  /** Provenance grades of the materials that contributed to this compile run. */
  provenance: ProvenanceGrade[];
}

/** Extended compile result that includes lucasastorian cascade backlink information. */
export interface CascadeResult extends CompileResult {
  /** Vault paths of wiki pages that link TO the compiled concept page. */
  affected_backlinks: string[];
}

/**
 * Maps a vault folder prefix (or exact path) to a provenance grade.
 * Resolved at setup time — never hardcoded with vault-specific values.
 */
export type FolderGradeMap = Record<string, ProvenanceGrade>;

/** Output of Phase A (extract-all-without-writing). */
export interface PhaseAResult {
  materials: Material[];
}
