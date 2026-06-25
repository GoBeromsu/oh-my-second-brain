export type FieldType = "string" | "url" | "date" | "list" | "number" | "boolean";

export type Normalize = "kebab" | "lower" | "trim";

export interface OntologyField {
  name: string;
  type: FieldType;
  required?: boolean;
  intent: string;
  normalize?: Normalize;
  immutable?: boolean;
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
}

export interface Taxonomy {
  version: number;
  folders: Record<string, FolderBinding>;
}

export interface Ontology {
  taxonomy: Taxonomy;
  concepts: Map<string, Concept>;
}
