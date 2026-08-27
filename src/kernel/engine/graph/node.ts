/**
 * EngineGraphNode — per-note metadata model for axis-filtered retrieval.
 *
 * The engine's C2 graph (builder.ts) emits a GraphEdge[] only — it has no
 * per-note concept / folder / axes / wikilinks record. This file adds that
 * node model plus the two pure query primitives the retrieve ops need:
 *
 *   - filterNodesByAxis() — AND-intersection axis filter (mirrors the idea of
 *     src/graph/cache.ts::matchesAxis, reimplemented from scratch — R18).
 *   - searchScore()       — lexical overlap of a free-text query against a
 *     node's pre-tokenised searchTerms set.
 *
 * R18: NO runtime import from src/search. Concept is read directly from
 * frontmatter["concept"] — no Ontology resolution (accepted semantic delta,
 * see swap blueprint RISK-5).
 */

// ---------------------------------------------------------------------------
// Node model
// ---------------------------------------------------------------------------

/** Per-note metadata used for axis filtering and local-graph exploration. */
export interface EngineGraphNode {
  /** Vault-relative path, e.g. "50. AI/Self-Attention.md". */
  path: string;
  /** frontmatter["concept"] when it is a plain string; null otherwise. */
  concept: string | null;
  /** First path segment (folder group) — mirrors builder.ts noteType(). */
  folder: string;
  /** Every frontmatter field coerced to a flat, typed scalar array. */
  /**
   * Typed scalar arrays at runtime. The declared string-array shape is retained
   * for graph renderers; query code reads the values through `fieldValues` so
   * number/boolean values are not coerced or discarded.
   */
  axes: Record<string, string[]>;
  /** Resolved vault-relative docPaths this note links out to via [[…]]. */
  wikilinks: string[];
  /** First 240 chars of the note body (after the frontmatter fence). */
  bodyPreview: string;
  /** Tokenised union of all frontmatter string values + body, for searchScore. */
  searchTerms: Set<string>;
}

// ---------------------------------------------------------------------------
// Tokenisation
// ---------------------------------------------------------------------------

/**
 * Unicode-aware word tokeniser: runs of ≥2 letter/number chars (plus `_`/`-`
 * internally). Lowercased. Matches the search-term grain used by searchScore
 * and buildNodeIndex so query terms and stored terms are directly comparable.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu;
  for (const m of text.toLowerCase().matchAll(re)) {
    out.push(m[0]);
  }
  return out;
}

/**
 * Case-insensitive basename comparison for wikilink axis filtering.
 *
 * `link` is a resolved vault-relative docPath (e.g. "50. AI/Foo.md");
 * `target` is the user-supplied filter (a bare title or a path). Comparing by
 * basename (extension stripped) avoids folder-prefix and slug/real-path
 * mismatches.
 */
export function wikilinkStemMatch(link: string, target: string): boolean {
  const stem = (s: string): string => {
    const lower = s.toLowerCase().replace(/\.md$/, "").trim();
    const slash = lower.lastIndexOf("/");
    return slash >= 0 ? lower.slice(slash + 1) : lower;
  };
  return stem(link) === stem(target);
}

// ---------------------------------------------------------------------------
// Axis filter
// ---------------------------------------------------------------------------

/** Axis filter inputs accepted by filterNodesByAxis (subset of McpAxisFilters). */
export interface NodeAxisFilters {
  concept?: string;
  folder?: string;
  property?: string;
  value?: string;
  wikilink?: string;
}

/** Scalar value accepted by a public folder/field/link axis predicate. */
export type AxisScalar = string | number | boolean;

/** Flatten frontmatter values without erasing number/boolean semantics. */
export function toAxisScalars(value: unknown): AxisScalar[] {
  if (Array.isArray(value)) return value.flatMap(toAxisScalars);
  if (typeof value === "string") return value.trim().length > 0 ? [value.trim()] : [];
  if (typeof value === "number") return Number.isFinite(value) ? [value] : [];
  if (typeof value === "boolean") return [value];
  // YAML timestamp values can be Date instances. ISO strings retain date
  // ordering for the typed range comparator while keeping the node cache JSON
  // serialisable.
  if (value instanceof Date && !Number.isNaN(value.getTime())) return [value.toISOString()];
  return [];
}

/** Optional typed field predicates used by date-range and multi-value tests. */
export interface AxisFieldPredicate {
  readonly contains?: AxisScalar | readonly AxisScalar[];
  readonly containsAll?: readonly AxisScalar[];
  readonly in?: readonly AxisScalar[];
  readonly between?: readonly [AxisScalar, AxisScalar];
  readonly gte?: AxisScalar;
  readonly gt?: AxisScalar;
  readonly lte?: AxisScalar;
  readonly lt?: AxisScalar;
  readonly from?: AxisScalar;
  readonly to?: AxisScalar;
}

/**
 * Public query axes. Values in one axis are OR'ed; distinct field keys and
 * the folder/field/link axes are AND'ed. `field` is a map so a caller can
 * express e.g. `{ status: ["open", "blocked"], team: "platform" }`.
 */
export interface QueryAxes {
  folder?: AxisScalar | readonly AxisScalar[];
  field?: Readonly<
    Record<string, AxisScalar | readonly AxisScalar[] | AxisFieldPredicate>
  >;
  link?: AxisScalar | readonly AxisScalar[];
}

const PUBLIC_AXIS_NAMES = new Set(["folder", "field", "link"]);

function axisValues(value: AxisScalar | readonly AxisScalar[] | undefined, axis: string): AxisScalar[] {
  const values = value === undefined ? [] : Array.isArray(value) ? [...value] : [value];
  if (!values.every((item) =>
    typeof item === "string"
    || typeof item === "boolean"
    || (typeof item === "number" && Number.isFinite(item)))) {
    throw new Error(`Axis "${axis}" values must be finite numbers, strings, or booleans.`);
  }
  return values
    .map((item) => typeof item === "string" ? item.trim() : item)
    .filter((item) => typeof item !== "string" || item.length > 0);
}

function fieldPredicate(value: AxisScalar | readonly AxisScalar[] | AxisFieldPredicate, key: string): {
  equals: AxisScalar[];
  contains: AxisScalar[];
  containsAll: AxisScalar[];
  range: AxisFieldPredicate;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { equals: axisValues(value, `field.${key}`), contains: [], containsAll: [], range: {} };
  }
  const known = new Set(["contains", "containsAll", "in", "between", "gte", "gt", "lte", "lt", "from", "to"]);
  for (const operator of Object.keys(value)) {
    if (!known.has(operator)) throw new Error(`Unknown field predicate "${operator}" for "${key}".`);
  }
  const predicate = value as AxisFieldPredicate;
  return {
    equals: axisValues(predicate.in, `field.${key}.in`),
    contains: axisValues(predicate.contains, `field.${key}.contains`),
    containsAll: axisValues(predicate.containsAll, `field.${key}.containsAll`),
    range: predicate,
  };
}

function fieldValues(node: EngineGraphNode, key: string): AxisScalar[] {
  const values = node.axes[key] as unknown as AxisScalar[] | undefined
    ?? Object.entries(node.axes).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase())?.[1]
    ?? [];
  return values as AxisScalar[];
}

type Comparable = { readonly kind: "string" | "number" | "boolean" | "date"; readonly value: string | number | boolean };

function comparable(value: AxisScalar): Comparable {
  if (typeof value === "number") return { kind: "number", value };
  if (typeof value === "boolean") return { kind: "boolean", value };
  const text = value.trim().toLocaleLowerCase();
  // YAML dates are represented as strings by the node snapshot. Keep their
  // date semantics for range predicates without coercing ordinary strings.
  if (/^\d{4}-\d{2}-\d{2}(?:t.*)?$/u.test(text)) {
    const timestamp = Date.parse(text);
    if (!Number.isNaN(timestamp)) return { kind: "date", value: timestamp };
  }
  return { kind: "string", value: text };
}

function equalValue(left: AxisScalar, right: AxisScalar): boolean {
  const a = comparable(left);
  const b = comparable(right);
  return a.kind === b.kind && Object.is(a.value, b.value);
}

function compareValue(left: AxisScalar, right: AxisScalar): number {
  const a = comparable(left);
  const b = comparable(right);
  if (a.kind !== b.kind) throw new Error("Typed axis comparison requires values of the same type.");
  if (typeof a.value === "number" && typeof b.value === "number") return a.value - b.value;
  if (typeof a.value === "string" && typeof b.value === "string") return a.value.localeCompare(b.value);
  return a.value === b.value ? 0 : a.value ? 1 : -1;
}

function valueMatches(values: readonly AxisScalar[], expected: readonly AxisScalar[]): boolean {
  return expected.some((item) => values.some((value) => equalValue(value, item)));
}

/**
 * Validate and apply the public axis predicate algebra.
 *
 * This is intentionally separate from `filterNodesByAxis`: the latter is the
 * legacy graph operation and still accepts its old singular property shape.
 * Unknown public axes fail loudly instead of silently broadening a query.
 */
export function filterNodesByQueryAxes(
  nodes: readonly EngineGraphNode[],
  axes: QueryAxes,
): EngineGraphNode[] {
  if (axes === null || typeof axes !== "object" || Array.isArray(axes)) {
    throw new Error("Query axes must be an object.");
  }
  for (const key of Object.keys(axes as Record<string, unknown>)) {
    if (!PUBLIC_AXIS_NAMES.has(key)) throw new Error(`Unknown query axis "${key}". Expected folder, field, or link.`);
  }
  const folder = axisValues(axes.folder, "folder");
  const link = axisValues(axes.link, "link");
  if (axes.field !== undefined && (axes.field === null || typeof axes.field !== "object" || Array.isArray(axes.field))) {
    throw new Error('Field axis must be an object mapping field names to values.');
  }
  const fields = Object.entries(axes.field ?? {}).map(([key, value]) => {
    if (!key.trim()) throw new Error("Axis field names must not be empty.");
    if (key.trim().toLocaleLowerCase() === "concept") {
      throw new Error('Unknown query field axis "concept".');
    }
    return [key, fieldPredicate(value, key)] as const;
  });

  return nodes.filter((node) => {
    // Values in one axis are OR'ed.
    if (folder.length > 0 && !valueMatches([node.folder], folder)) return false;
    if (link.length > 0) {
      const links = node.wikilinks.flatMap((target) => {
        const stem = target.toLocaleLowerCase().replace(/\.md$/u, "");
        const slash = stem.lastIndexOf("/");
        return [slash >= 0 ? stem.slice(slash + 1) : stem];
      });
      if (!link.some((target) => {
        if (typeof target !== "string") return false;
        const stem = target.toLocaleLowerCase().replace(/\.md$/u, "");
        const slash = stem.lastIndexOf("/");
        return links.includes(slash >= 0 ? stem.slice(slash + 1) : stem);
      })) return false;
    }
    // Different field keys are AND'ed; values for one key are OR'ed.
    for (const [key, predicate] of fields) {
      const values = fieldValues(node, key);
      if (predicate.equals.length > 0 && !valueMatches(values, predicate.equals)) return false;
      if (predicate.contains.length > 0 && !valueMatches(values, predicate.contains)) return false;
      if (predicate.containsAll.length > 0 && !predicate.containsAll.every((item) => values.some((value) => equalValue(value, item)))) return false;
      const range = predicate.range;
      const lower = range.gte ?? range.gt ?? range.from;
      const upper = range.lte ?? range.lt ?? range.to;
      const between = range.between;
      if (between !== undefined && (!Array.isArray(between) || between.length !== 2)) {
        throw new Error(`Field predicate "between" for "${key}" requires two values.`);
      }
      if (lower !== undefined || upper !== undefined) {
        const matchesRange = values.some((actual) => (
          (lower === undefined || (range.gt !== undefined ? compareValue(actual, lower) > 0 : compareValue(actual, lower) >= 0))
          && (upper === undefined || (range.lt !== undefined ? compareValue(actual, upper) < 0 : compareValue(actual, upper) <= 0))
        ));
        if (!matchesRange) return false;
      }
      if (between !== undefined) {
        if (!values.some((actual) => compareValue(actual, between[0]!) >= 0 && compareValue(actual, between[1]!) <= 0)) return false;
      }
      if (
        predicate.equals.length === 0
        && predicate.contains.length === 0
        && predicate.containsAll.length === 0
        && lower === undefined
        && upper === undefined
        && between === undefined
      ) {
        return false;
      }
    }
    return true;
  });
}

export interface QueryFacet {
  readonly axis: "folder" | "field" | "link";
  readonly value: string;
  readonly count: number;
  readonly key?: string;
}

/** Count axis values over the already-filtered candidate set. */
export function queryFacets(nodes: readonly EngineGraphNode[]): QueryFacet[] {
  const counts = new Map<string, { axis: QueryFacet["axis"]; value: string; key?: string; count: number }>();
  const add = (axis: QueryFacet["axis"], value: string, key?: string): void => {
    const normalized = value.trim();
    if (!normalized) return;
    const identity = `${axis}\u0000${key?.toLocaleLowerCase() ?? ""}\u0000${normalized.toLocaleLowerCase()}`;
    const existing = counts.get(identity);
    if (existing) {
      existing.count++;
    } else {
      counts.set(identity, { axis, value: normalized, ...(key !== undefined ? { key } : {}), count: 1 });
    }
  };
  for (const node of nodes) {
    add("folder", node.folder);
    for (const [key, values] of Object.entries(node.axes)) {
      // Concept remains an internal graph binding, not a public query axis.
      if (key === "concept") continue;
      for (const value of new Set(values)) add("field", String(value), key);
    }
    for (const target of new Set(node.wikilinks)) add("link", target);
  }
  return [...counts.values()]
    .sort((left, right) =>
      left.axis.localeCompare(right.axis)
      || (left.key ?? "").localeCompare(right.key ?? "")
      || left.value.localeCompare(right.value),
    )
    .map((facet) => facet as QueryFacet);
}

/**
 * Return the nodes that satisfy every supplied axis filter (AND-intersection).
 *
 * Undefined filters are ignored. A `property` filter without `value` matches
 * any node that defines that frontmatter field; with `value` it matches only
 * nodes whose field array contains that exact value.
 */
export function filterNodesByAxis(
  nodes: readonly EngineGraphNode[],
  filters: NodeAxisFilters,
): EngineGraphNode[] {
  return nodes.filter((node) => {
    if (filters.concept !== undefined && node.concept !== filters.concept) {
      return false;
    }
    if (filters.folder !== undefined && node.folder !== filters.folder) {
      return false;
    }
    if (filters.wikilink !== undefined) {
      const target = filters.wikilink;
      if (!node.wikilinks.some((link) => wikilinkStemMatch(link, target))) {
        return false;
      }
    }
    if (filters.property !== undefined) {
      const values = node.axes[filters.property];
      if (filters.value !== undefined) {
        if (values === undefined || !values.includes(filters.value)) return false;
      } else if (values === undefined || values.length < 1) {
        return false;
      }
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Lexical score
// ---------------------------------------------------------------------------

/**
 * Count how many distinct query tokens appear in the node's searchTerms set.
 * Returns 0 for an empty/whitespace query. This is a cheap lexical proxy used
 * to rank axis-filtered candidates (no embeddings involved).
 */
export function searchScore(node: EngineGraphNode, query: string): number {
  if (!query) return 0;
  const terms = tokenize(query);
  if (terms.length === 0) return 0;
  let score = 0;
  const seen = new Set<string>();
  for (const term of terms) {
    if (seen.has(term)) continue;
    seen.add(term);
    if (node.searchTerms.has(term)) score++;
  }
  return score;
}
