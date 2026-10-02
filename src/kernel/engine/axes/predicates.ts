/** Shared scalar/list and field predicate semantics for declared and observed retrieval. */
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

export function axisValues(value: AxisScalar | readonly AxisScalar[] | undefined, axis: string): AxisScalar[] {
  const values = value === undefined ? [] : Array.isArray(value) ? [...value] : [value];
  if (!values.every(item => typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)))) {
    throw new Error(`Axis "${axis}" values must be finite numbers, strings, or booleans.`);
  }
  return values.map(item => typeof item === "string" ? item.trim() : item).filter(item => typeof item !== "string" || item.length > 0);
}

export function comparable(value: AxisScalar): string | number | boolean {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLocaleLowerCase();
  if (/^\d{4}-\d{2}-\d{2}(?:t.*)?$/u.test(normalized)) {
    const timestamp = Date.parse(normalized);
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return normalized;
}

export function equals(left: AxisScalar, right: AxisScalar): boolean {
  const a = comparable(left);
  const b = comparable(right);
  // Finite note numbers compare by value: decimals and large values stay, and -0 matches 0.
  return typeof a === typeof b && a === b;
}

export function compare(left: AxisScalar, right: AxisScalar): number {
  const a = comparable(left);
  const b = comparable(right);
  if (typeof a !== typeof b) throw new Error("Typed axis comparison requires values of the same type.");
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
  return a === b ? 0 : a ? 1 : -1;
}

function isAxisScalarArray(value: AxisScalar | readonly AxisScalar[] | AxisFieldPredicate): value is readonly AxisScalar[] {
  return Array.isArray(value);
}

export function fieldPredicate(value: AxisScalar | readonly AxisScalar[] | AxisFieldPredicate, key: string): { readonly equals: AxisScalar[]; readonly contains: AxisScalar[]; readonly containsAll: AxisScalar[]; readonly range: AxisFieldPredicate } {
  if (typeof value !== "object" || value === null || isAxisScalarArray(value)) return { equals: axisValues(value, `field.${key}`), contains: [], containsAll: [], range: {} };
  const known = new Set(["contains", "containsAll", "in", "between", "gte", "gt", "lte", "lt", "from", "to"]);
  for (const operator of Object.keys(value)) if (!known.has(operator)) throw new Error(`Unknown field predicate "${operator}" for "${key}".`);
  return { equals: axisValues(value.in, `field.${key}.in`), contains: axisValues(value.contains, `field.${key}.contains`), containsAll: axisValues(value.containsAll, `field.${key}.containsAll`), range: value };
}
