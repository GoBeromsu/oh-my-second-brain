export type FieldType = "string" | "url" | "date" | "list" | "number" | "boolean";

export type Normalize = "kebab" | "lower" | "trim";

export interface OntologyField {
  name: string;
  type: FieldType;
  required?: boolean;
  intent: string;
  normalize?: Normalize;
  immutable?: boolean;
  /** Closed vocabulary for string fields; a value outside this list is a lint violation. */
  enum?: string[];
}

export interface OntologyLens {
  name: string;
  intent: string;
  fields: string[];
}

export interface Concept {
  concept: string;
  intent: string;
  folder: string;
  fields: OntologyField[];
  lenses?: OntologyLens[];
}

export interface FolderBinding {
  intent: string;
  concept: string | string[] | null;
  /**
   * Marks this folder as an agent-writable zone per the vault routing guideline.
   * Agent-writable alone is advisory; use routingLawStrict for hard created_by checks.
   */
  agentWritable?: boolean;
  /**
   * Marks an agent-writable folder as agent-exclusive for hard routing-law enforcement.
   */
  routingLawStrict?: boolean;
}

export interface Taxonomy {
  version: number;
  folders: Record<string, FolderBinding>;
  /** Vault-relative glob patterns exempt from audit/lint scans. */
  exclude?: string[];
}

export interface Ontology {
  taxonomy: Taxonomy;
  concepts: Map<string, Concept>;
}
