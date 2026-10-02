import { normalizeObservedExact, type ObservedExactValue } from "./observed-exact.js";
import { axisValues, fieldPredicate, type AxisFieldPredicate, type AxisScalar } from "./predicates.js";

/** Explicit observed fields, independent of the sealed typed field declaration. */
export interface ObservedFieldPredicate extends AxisFieldPredicate {
  readonly exact?: ObservedExactValue;
}
export type ObservedFieldFilters = Readonly<Record<string, AxisScalar | readonly AxisScalar[] | ObservedFieldPredicate>>;

export interface ObservedPathQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export const OBSERVED_MAX_FIELDS = 32;
export const OBSERVED_MAX_PREDICATE_VALUES = 256;

/** Parameterized EAV query. No result limit is applied before this intersection. */
export function observedPathQuery(fields: ObservedFieldFilters, candidatePaths?: readonly string[]): ObservedPathQuery {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) throw new Error("Observed fields must map field names to predicates.");
  const entries = Object.entries(fields);
  if (entries.length > OBSERVED_MAX_FIELDS) throw new Error(`Observed filtering accepts at most ${OBSERVED_MAX_FIELDS} fields.`);
  const params: unknown[] = candidatePaths === undefined ? [] : [JSON.stringify([...new Set(candidatePaths)].sort())];
  const scope = candidatePaths === undefined ? "" : "WITH scope(note_path) AS (SELECT value FROM json_each(?)) ";
  const scoped = candidatePaths === undefined ? "" : " AND note_path IN (SELECT note_path FROM scope)";
  if (entries.length === 0) {
    return {
      sql: scope + (candidatePaths === undefined
        ? "SELECT DISTINCT note_path FROM axis_observation WHERE axis_kind = 'field' ORDER BY note_path"
        : "SELECT DISTINCT note_path FROM scope ORDER BY note_path"),
      params,
    };
  }
  const queries: string[] = [];
  for (const [key, raw] of entries) {
    const canonicalKey = key.trim().toLowerCase();
    if (!canonicalKey) throw new Error("Observed field keys must be non-empty.");
    const operands = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? Object.values(raw) : [raw];
    if (operands.some(value => Array.isArray(value) && value.length > OBSERVED_MAX_PREDICATE_VALUES)) throw new Error(`Observed predicates accept at most ${OBSERVED_MAX_PREDICATE_VALUES} values.`);
    const hasExact = raw !== null && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "exact");
    const { exact, ...shared } = hasExact ? raw as ObservedFieldPredicate : {};
    const exactValue = hasExact ? normalizeObservedExact(exact) : undefined;
    const predicate = fieldPredicate(hasExact ? shared : raw, key);
    for (const operator of ["gte", "gt", "lte", "lt", "from", "to"] as const) {
      if (Object.hasOwn(predicate.range, operator)) {
        const value = predicate.range[operator];
        if (Array.isArray(value) || axisValues(value, `observed.field.${key}.${operator}`).length !== 1) throw new Error("Observed range boundaries must be non-empty scalar values.");
      }
    }
    const tests: string[] = [];
    params.push(canonicalKey);
    if (exactValue !== undefined) {
      tests.push("MAX(CASE WHEN value_type = ? AND normalized_value = ? THEN 1 ELSE 0 END) = 1");
      params.push(exactValue.valueType, exactValue.normalizedValue);
    }
    const any = (values: readonly AxisScalar[]): void => {
      if (values.length > OBSERVED_MAX_PREDICATE_VALUES) throw new Error(`Observed predicates accept at most ${OBSERVED_MAX_PREDICATE_VALUES} values.`);
      if (values.length === 0) return;
      tests.push("MAX(oms_axis_any(value_type, value_json, ?)) = 1");
      params.push(JSON.stringify(values));
    };
    any(predicate.equals);
    any(predicate.contains);
    if (predicate.containsAll.length > OBSERVED_MAX_PREDICATE_VALUES) throw new Error(`Observed predicates accept at most ${OBSERVED_MAX_PREDICATE_VALUES} values.`);
    for (const value of predicate.containsAll) any([value]);
    const range = (lower: AxisScalar | undefined, upper: AxisScalar | undefined, lowerExclusive: boolean, upperExclusive: boolean): void => {
      const comparisons: string[] = [];
      for (const [value, operator] of [[lower, lowerExclusive ? ">" : ">="], [upper, upperExclusive ? "<" : "<="]] as const) {
        if (value === undefined) continue;
        if (axisValues(value, `observed.field.${key}.range`).length !== 1 || Array.isArray(value)) throw new Error("Observed range boundaries must be non-empty scalar values.");
        comparisons.push(`oms_axis_compare(value_type, value_json, ?) ${operator} 0`);
        params.push(JSON.stringify(value));
      }
      if (comparisons.length > 0) tests.push(`MAX(CASE WHEN ${comparisons.join(" AND ")} THEN 1 ELSE 0 END) = 1`);
    };
    range(predicate.range.gte ?? predicate.range.gt ?? predicate.range.from, predicate.range.lte ?? predicate.range.lt ?? predicate.range.to, predicate.range.gt !== undefined, predicate.range.lt !== undefined);
    if (predicate.range.between !== undefined) {
      if (!Array.isArray(predicate.range.between) || predicate.range.between.length !== 2) throw new Error(`Field predicate "between" for "${key}" requires two values.`);
      if (predicate.range.between.some(value => value === undefined)) throw new Error(`Field predicate "between" for "${key}" requires two scalar values.`);
      range(predicate.range.between[0], predicate.range.between[1], false, false);
    }
    queries.push(`SELECT note_path FROM axis_observation WHERE axis_kind = 'field' AND axis_key = ?${scoped} GROUP BY note_path HAVING ${tests.length ? tests.join(" AND ") : "0"}`);
  }
  return { sql: `${scope}${queries.join(" INTERSECT ")} ORDER BY note_path`, params };
}
