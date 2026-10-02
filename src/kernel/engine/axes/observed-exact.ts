import { normalizeAxisValue, type AxisValue, type AxisValueType } from "./values.js";
import type { AxisScalar } from "./predicates.js";

/** JSON-safe typed equality. Date values use the canonical ISO string emitted by facets. */
export interface ObservedExactValue {
  readonly valueType: AxisValueType;
  readonly value: AxisScalar;
}

export interface ObservedExactSelection {
  readonly exact: ObservedExactValue;
}

export function normalizeObservedExact(input: unknown): { readonly valueType: AxisValueType; readonly normalizedValue: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Observed exact selection must contain valueType and value.");
  const exact = input as Record<string, unknown>;
  if (Object.keys(exact).some(key => key !== "valueType" && key !== "value") || !Object.hasOwn(exact, "valueType") || !Object.hasOwn(exact, "value")) throw new Error("Observed exact selection accepts only valueType and value, both required.");
  const type = exact["valueType"];
  const value = exact["value"];
  let scalar: AxisValue;
  if (type === "date") {
    if (typeof value !== "string") throw new Error("Observed exact date requires a canonical ISO string.");
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error("Observed exact date requires the canonical ISO string emitted by facets (including milliseconds and Z).");
    scalar = date;
  } else if ((type === "string" && typeof value === "string") || (type === "number" && typeof value === "number") || (type === "boolean" && typeof value === "boolean")) {
    scalar = value;
  } else {
    throw new Error("Observed exact value must match its string, number, boolean, or date valueType without coercion.");
  }
  const normalized = normalizeAxisValue(scalar);
  return { valueType: normalized.type, normalizedValue: normalized.normalizedValue };
}

/** JSON-safe value predicate, not a self-contained source/query/filter scope token. */
export function observedFacetSelection(valueType: AxisValueType, value: AxisValue): ObservedExactSelection {
  return { exact: { valueType, value: value instanceof Date ? value.toISOString() : value } };
}
