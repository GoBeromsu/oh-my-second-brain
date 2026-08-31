/** Per-note metadata used for template-bound graph retrieval. */
export interface EngineGraphNode {
  /** Vault-relative path. */
  readonly path: string;
  /** Stable frontmatter template identity. */
  readonly template: string;
  /** First vault-relative path segment. */
  readonly folder: string;
  /** Declared fields for this node's template only. */
  readonly axes: Readonly<Record<string, readonly AxisScalar[]>>;
  /** Resolved vault-relative outgoing wikilinks. */
  readonly wikilinks: readonly string[];
  readonly bodyPreview: string;
  readonly searchTerms: ReadonlySet<string>;
}

export type AxisScalar = string | number | boolean;

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

export interface QueryAxes {
  readonly template?: AxisScalar | readonly AxisScalar[];
  readonly folder?: AxisScalar | readonly AxisScalar[];
  readonly field?: Readonly<Record<string, AxisScalar | readonly AxisScalar[] | AxisFieldPredicate>>;
  readonly link?: AxisScalar | readonly AxisScalar[];
}

export interface NodeAxisFilters {
  readonly template?: string;
  readonly folder?: string;
  readonly property?: string;
  readonly value?: AxisScalar;
  readonly wikilink?: string;
}

export interface QueryFacet {
  readonly axis: "template" | "folder" | "field" | "link";
  readonly value: string;
  readonly count: number;
  readonly key?: string;
}

const PUBLIC_AXIS_NAMES = new Set(["template", "folder", "field", "link"]);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const match of text.toLocaleLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu)) out.push(match[0]);
  return out;
}

export function toAxisScalars(value: unknown): AxisScalar[] {
  if (Array.isArray(value)) return value.flatMap(toAxisScalars);
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value === "number") return Number.isFinite(value) ? [value] : [];
  if (typeof value === "boolean") return [value];
  if (value instanceof Date && !Number.isNaN(value.getTime())) return [value.toISOString()];
  return [];
}

export function wikilinkStemMatch(link: string, target: string): boolean {
  const stem = (value: string): string => {
    const normalized = value.toLocaleLowerCase().replace(/\.md$/u, "").trim();
    return normalized.slice(normalized.lastIndexOf("/") + 1);
  };
  return stem(link) === stem(target);
}

function axisValues(value: AxisScalar | readonly AxisScalar[] | undefined, axis: string): AxisScalar[] {
  const values = value === undefined ? [] : Array.isArray(value) ? [...value] : [value];
  if (!values.every(item => typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)))) {
    throw new Error(`Axis "${axis}" values must be finite numbers, strings, or booleans.`);
  }
  return values.map(item => typeof item === "string" ? item.trim() : item).filter(item => typeof item !== "string" || item.length > 0);
}

function comparable(value: AxisScalar): string | number | boolean {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLocaleLowerCase();
  if (/^\d{4}-\d{2}-\d{2}(?:t.*)?$/u.test(normalized)) {
    const timestamp = Date.parse(normalized);
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return normalized;
}

function equals(left: AxisScalar, right: AxisScalar): boolean {
  const a = comparable(left);
  const b = comparable(right);
  return typeof a === typeof b && Object.is(a, b);
}

function compare(left: AxisScalar, right: AxisScalar): number {
  const a = comparable(left);
  const b = comparable(right);
  if (typeof a !== typeof b) throw new Error("Typed axis comparison requires values of the same type.");
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
  return a === b ? 0 : a ? 1 : -1;
}

function matches(values: readonly AxisScalar[], expected: readonly AxisScalar[]): boolean {
  return expected.some(item => values.some(value => equals(value, item)));
}

function isAxisScalarArray(value: AxisScalar | readonly AxisScalar[] | AxisFieldPredicate): value is readonly AxisScalar[] {
  return Array.isArray(value);
}

function fieldPredicate(value: AxisScalar | readonly AxisScalar[] | AxisFieldPredicate, key: string): { readonly equals: AxisScalar[]; readonly contains: AxisScalar[]; readonly containsAll: AxisScalar[]; readonly range: AxisFieldPredicate } {
  if (typeof value !== "object" || value === null || isAxisScalarArray(value)) return { equals: axisValues(value, `field.${key}`), contains: [], containsAll: [], range: {} };
  const known = new Set(["contains", "containsAll", "in", "between", "gte", "gt", "lte", "lt", "from", "to"]);
  for (const operator of Object.keys(value)) if (!known.has(operator)) throw new Error(`Unknown field predicate "${operator}" for "${key}".`);
  return { equals: axisValues(value.in, `field.${key}.in`), contains: axisValues(value.contains, `field.${key}.contains`), containsAll: axisValues(value.containsAll, `field.${key}.containsAll`), range: value };
}

export function filterNodesByQueryAxes(nodes: readonly EngineGraphNode[], axes: QueryAxes): EngineGraphNode[] {
  if (axes === null || typeof axes !== "object" || Array.isArray(axes)) throw new Error("Query axes must be an object.");
  for (const key of Object.keys(axes)) if (!PUBLIC_AXIS_NAMES.has(key)) throw new Error(`Unknown query axis "${key}". Expected template, folder, field, or link.`);
  if (axes.field !== undefined && (axes.field === null || typeof axes.field !== "object" || Array.isArray(axes.field))) throw new Error("Field axis must be an object mapping field names to values.");
  const templates = axisValues(axes.template, "template");
  const folders = axisValues(axes.folder, "folder");
  const links = axisValues(axes.link, "link");
  const fields = Object.entries(axes.field ?? {}).map(([key, value]) => [key, fieldPredicate(value, key)] as const);
  return nodes.filter(node => {
    if (templates.length && !matches([node.template], templates)) return false;
    if (folders.length && !matches([node.folder], folders)) return false;
    if (links.length && !links.some(link => typeof link === "string" && node.wikilinks.some(target => wikilinkStemMatch(target, link)))) return false;
    for (const [key, predicate] of fields) {
      const values = node.axes[key] ?? [];
      if (predicate.equals.length && !matches(values, predicate.equals)) return false;
      if (predicate.contains.length && !matches(values, predicate.contains)) return false;
      if (predicate.containsAll.length && !predicate.containsAll.every(item => values.some(value => equals(value, item)))) return false;
      const lower = predicate.range.gte ?? predicate.range.gt ?? predicate.range.from;
      const upper = predicate.range.lte ?? predicate.range.lt ?? predicate.range.to;
      if (predicate.range.between !== undefined && (!Array.isArray(predicate.range.between) || predicate.range.between.length !== 2)) throw new Error(`Field predicate "between" for "${key}" requires two values.`);
      if (lower !== undefined || upper !== undefined) {
        if (!values.some(value => (lower === undefined || compare(value, lower) >= (predicate.range.gt === undefined ? 0 : 1)) && (upper === undefined || compare(value, upper) <= (predicate.range.lt === undefined ? 0 : -1)))) return false;
      }
      if (predicate.range.between !== undefined && !values.some(value => compare(value, predicate.range.between![0]) >= 0 && compare(value, predicate.range.between![1]) <= 0)) return false;
      if (!predicate.equals.length && !predicate.contains.length && !predicate.containsAll.length && lower === undefined && upper === undefined && predicate.range.between === undefined) return false;
    }
    return true;
  });
}

export function queryFacets(nodes: readonly EngineGraphNode[]): QueryFacet[] {
  const counts = new Map<string, { axis: QueryFacet["axis"]; value: string; key?: string; count: number }>();
  const add = (axis: QueryFacet["axis"], value: string, key?: string): void => {
    const normalized = value.trim();
    if (!normalized) return;
    const identity = `${axis}\0${key?.toLocaleLowerCase() ?? ""}\0${normalized.toLocaleLowerCase()}`;
    const entry = counts.get(identity);
    if (entry) entry.count++;
    else counts.set(identity, { axis, value: normalized, ...(key === undefined ? {} : { key }), count: 1 });
  };
  for (const node of nodes) {
    add("template", node.template);
    add("folder", node.folder);
    for (const [key, values] of Object.entries(node.axes)) for (const value of new Set(values)) add("field", String(value), key);
    for (const target of new Set(node.wikilinks)) add("link", target);
  }
  return [...counts.values()].sort((left, right) => left.axis.localeCompare(right.axis) || (left.key ?? "").localeCompare(right.key ?? "") || left.value.localeCompare(right.value));
}

export function filterNodesByAxis(nodes: readonly EngineGraphNode[], filters: NodeAxisFilters): EngineGraphNode[] {
  return nodes.filter(node => {
    if (filters.template !== undefined && node.template !== filters.template) return false;
    if (filters.folder !== undefined && node.folder !== filters.folder) return false;
    if (filters.wikilink !== undefined && !node.wikilinks.some(link => wikilinkStemMatch(link, filters.wikilink!))) return false;
    if (filters.property !== undefined) {
      const values = node.axes[filters.property] ?? [];
      if (filters.value === undefined ? values.length === 0 : !values.some(value => String(value) === filters.value)) return false;
    }
    return true;
  });
}

export function searchScore(node: EngineGraphNode, query: string): number {
  const terms = new Set(tokenize(query));
  let score = 0;
  for (const term of terms) if (node.searchTerms.has(term)) score++;
  return score;
}
