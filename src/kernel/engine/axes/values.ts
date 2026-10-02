/** Canonical scalar representation shared by the observation store and exact selectors. */
export type AxisValueType = "string" | "number" | "boolean" | "date";
export type AxisValue = string | number | boolean | Date;

function scalarType(value: AxisValue): AxisValueType {
  if (value instanceof Date) return "date";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

function canonicalScalar(value: AxisValue): AxisValue {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("Axis date value must be valid.");
    return value.toISOString();
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) throw new Error("Axis string value must be non-empty.");
    return normalized;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Axis number value must be finite.");
    return value;
  }
  return value;
}

function normalizedLookup(value: AxisValue, type: AxisValueType): string {
  if (type === "date") return (value instanceof Date ? value.toISOString() : String(value)).toLowerCase();
  return String(value).trim().toLowerCase();
}

export function normalizeAxisValue(value: AxisValue): { readonly value: AxisValue; readonly type: AxisValueType; readonly normalizedValue: string } {
  const canonical = canonicalScalar(value);
  const type = scalarType(value);
  return { value: canonical, type, normalizedValue: normalizedLookup(canonical, type) };
}
