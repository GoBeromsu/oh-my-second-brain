/**
 * Frozen, fixture-backed golden query set for the R2 measurement harness.
 *
 * The set deliberately carries the nine preregistered query classes rather than
 * treating language/intent strata as free-form tags.  Every row is curated
 * against test/fixtures/vault and has at least one qrel row; a real-vault run
 * must replace this set through OMS_GOLDEN_QUERIES rather than invent labels.
 */

export type QueryType = "lex" | "vec" | "hyde" | "graph";

/** R2 classes from the approved measurement plan. */
export const GOLDEN_QUERY_CLASSES = [
  "ko",
  "ko-inflected",
  "ko-verb-inflected",
  "다단어-AND-0hit",
  "en",
  "mixed",
  "phrase",
  "conceptual",
  "frontmatter-constrained",
] as const;

export type GoldenQueryClass = (typeof GOLDEN_QUERY_CLASSES)[number];

export interface GoldenQuery {
  /** Unique stable identifier for this query. */
  id: string;
  /** Retrieval modality requested by the arm. */
  type: QueryType;
  /** Query text sent through the production assemble seam. */
  query: string;
  /** Fixture-relative documents judged relevant for this query. */
  expectedNotes: string[];
  /** True only for rows whose expectedNotes were verified. */
  curated?: boolean;
  /** One of the nine preregistered classes. */
  queryClass: GoldenQueryClass;
  /** Additional non-normative labels for report consumers. */
  tags?: string[];
}

const idea = ["notes/idea.md"];
const architecture = ["references/clean-architecture.md"];

/**
 * Twenty-eight scored rows (seven per retrieval type), stratified over all
 * nine classes.  The 0-hit class intentionally has a relevant qrel despite a
 * query that is absent from the fixture, proving that zero retrieval is
 * measured rather than silently omitted.
 */
export const GOLDEN_QUERIES: GoldenQuery[] = [
  { id: "lex-01", type: "lex", query: "지식 graph metadata schema", expectedNotes: idea, curated: true, queryClass: "ko", tags: ["korean", "technical-concept"] },
  { id: "lex-02", type: "lex", query: "knowledge graphs organizing", expectedNotes: idea, curated: true, queryClass: "ko-inflected", tags: ["korean"] },
  { id: "lex-03", type: "lex", query: "architecture 설계한다", expectedNotes: architecture, curated: true, queryClass: "ko-verb-inflected", tags: ["korean"] },
  { id: "lex-04", type: "lex", query: "term-never-present-r2", expectedNotes: architecture, curated: true, queryClass: "다단어-AND-0hit", tags: ["zero-hit"] },
  { id: "lex-05", type: "lex", query: "clean architecture dependency rule", expectedNotes: architecture, curated: true, queryClass: "en", tags: ["english"] },
  { id: "lex-06", type: "lex", query: "지식 architecture dependency", expectedNotes: architecture, curated: true, queryClass: "mixed", tags: ["cross-language"] },
  { id: "lex-07", type: "lex", query: "ability to change architecture", expectedNotes: architecture, curated: true, queryClass: "phrase", tags: ["phrase"] },

  { id: "vec-01", type: "vec", query: "knowledge metadata convention", expectedNotes: idea, curated: true, queryClass: "conceptual", tags: ["conceptual", "personal-capture"] },
  { id: "vec-02", type: "vec", query: "frontmatter title tags architecture", expectedNotes: architecture, curated: true, queryClass: "frontmatter-constrained", tags: ["frontmatter"] },
  { id: "vec-03", type: "vec", query: "지식 graph schema", expectedNotes: idea, curated: true, queryClass: "ko", tags: ["korean"] },
  { id: "vec-04", type: "vec", query: "organizing knowledge systems", expectedNotes: idea, curated: true, queryClass: "ko-inflected", tags: ["korean"] },
  { id: "vec-05", type: "vec", query: "architecture를 설계한다", expectedNotes: architecture, curated: true, queryClass: "ko-verb-inflected", tags: ["korean"] },
  { id: "vec-06", type: "vec", query: "qzx-and-never-hit-r2", expectedNotes: architecture, curated: true, queryClass: "다단어-AND-0hit", tags: ["zero-hit"] },
  { id: "vec-07", type: "vec", query: "SOLID principles clean architecture", expectedNotes: architecture, curated: true, queryClass: "en", tags: ["english"] },

  { id: "hyde-01", type: "hyde", query: "지식 architecture dependency", expectedNotes: architecture, curated: true, queryClass: "mixed", tags: ["cross-language"] },
  { id: "hyde-02", type: "hyde", query: "what changes together architecture", expectedNotes: architecture, curated: true, queryClass: "phrase", tags: ["phrase"] },
  { id: "hyde-03", type: "hyde", query: "metadata schema knowledge system", expectedNotes: idea, curated: true, queryClass: "conceptual", tags: ["conceptual"] },
  { id: "hyde-04", type: "hyde", query: "frontmatter author tags design", expectedNotes: architecture, curated: true, queryClass: "frontmatter-constrained", tags: ["frontmatter"] },
  { id: "hyde-05", type: "hyde", query: "지식 graph architecture", expectedNotes: idea, curated: true, queryClass: "ko", tags: ["korean"] },
  { id: "hyde-06", type: "hyde", query: "knowledge organizing schemas", expectedNotes: idea, curated: true, queryClass: "ko-inflected", tags: ["korean"] },
  { id: "hyde-07", type: "hyde", query: "architecture 설계하는 principles", expectedNotes: architecture, curated: true, queryClass: "ko-verb-inflected", tags: ["korean"] },

  { id: "graph-01", type: "graph", query: "never-existing graph seed", expectedNotes: architecture, curated: true, queryClass: "다단어-AND-0hit", tags: ["zero-hit"] },
  { id: "graph-02", type: "graph", query: "clean architecture", expectedNotes: architecture, curated: true, queryClass: "en", tags: ["english"] },
  { id: "graph-03", type: "graph", query: "지식 architecture", expectedNotes: architecture, curated: true, queryClass: "mixed", tags: ["cross-language"] },
  { id: "graph-04", type: "graph", query: "ability to change", expectedNotes: architecture, curated: true, queryClass: "phrase", tags: ["phrase"] },
  { id: "graph-05", type: "graph", query: "convention as data metadata", expectedNotes: idea, curated: true, queryClass: "conceptual", tags: ["conceptual"] },
  { id: "graph-06", type: "graph", query: "title tags software architecture", expectedNotes: architecture, curated: true, queryClass: "frontmatter-constrained", tags: ["frontmatter"] },
  { id: "graph-07", type: "graph", query: "knowledge graph", expectedNotes: idea, curated: true, queryClass: "ko", tags: ["korean"] },
];

/** Frozen binary qrels paired one-to-one with the curated rows above. */
export const GOLDEN_QRELS = Object.fromEntries(
  GOLDEN_QUERIES.map((query) => [
    query.id,
    Object.fromEntries(query.expectedNotes.map((docPath) => [docPath, 1])),
  ]),
) as Record<string, Record<string, number>>;

export const QUERY_COUNT = GOLDEN_QUERIES.length;

export const QUERIES_BY_TYPE = {
  lex: GOLDEN_QUERIES.filter((q) => q.type === "lex"),
  vec: GOLDEN_QUERIES.filter((q) => q.type === "vec"),
  hyde: GOLDEN_QUERIES.filter((q) => q.type === "hyde"),
  graph: GOLDEN_QUERIES.filter((q) => q.type === "graph"),
} as const;

export const QUERIES_BY_CLASS = Object.fromEntries(
  GOLDEN_QUERY_CLASSES.map((queryClass) => [
    queryClass,
    GOLDEN_QUERIES.filter((query) => query.queryClass === queryClass),
  ]),
) as Record<GoldenQueryClass, GoldenQuery[]>;

/** Fail closed instead of allowing a partial/uncurated set to look measured. */
export function validateGoldenCoverage(
  queries: readonly GoldenQuery[] = GOLDEN_QUERIES,
  options: { readonly allowUncurated?: boolean } = {},
): void {
  if (queries.length < 25) throw new Error(`golden query coverage requires at least 25 rows, got ${queries.length}`);
  const classes = new Set(queries.filter((query) => query.curated).map((query) => query.queryClass));
  const missing = GOLDEN_QUERY_CLASSES.filter((queryClass) => !classes.has(queryClass));
  if (missing.length > 0) throw new Error(`golden query coverage is missing classes: ${missing.join(", ")}`);
  if (options.allowUncurated !== true && queries.some((query) => !query.curated)) {
    throw new Error("golden query set contains uncurated rows");
  }
}
