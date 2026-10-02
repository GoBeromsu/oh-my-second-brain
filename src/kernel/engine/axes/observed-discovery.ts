import { observedFacetSelection, type ObservedExactSelection } from "./observed-exact.js";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { observedPathQuery, type ObservedFieldFilters } from "./observed-query.js";
import type { AxisValue, AxisValueType } from "./store.js";

export const OBSERVED_DISCOVERY_MAX_LIMIT = 100;
export const OBSERVED_DISCOVERY_MAX_VALUE_BYTES = 512;
export const OBSERVED_DISCOVERY_MAX_PAGE_BYTES = 32 * 1024;
export const OBSERVED_DISCOVERY_MAX_CURSOR_CHARS = 8192;

export interface ObservedDiscoveryOptions {
  /** Omit for keys; supply one exact observed key for its values. */
  readonly key?: string;
  readonly fields?: ObservedFieldFilters;
  readonly candidatePaths?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ObservedKeyFacet {
  readonly key: string;
  /** Number of distinct matching notes with at least one scalar at this key. */
  readonly count: number;
  readonly valueCount: number;
  readonly valueTypes: readonly AxisValueType[];
}

export interface ObservedValueFacet {
  /** Type-bound value predicate; counts also depend on the unchanged discovery scope. */
  readonly selection: ObservedExactSelection;
  readonly value: AxisValue;
  readonly valueType: AxisValueType;
  /** Canonical trimmed/lowercase value, not the original display spelling. */
  readonly normalizedValue: string;
  readonly count: number;
}

interface ObservedDiscoveryPage {
  /** Complete distinct-key/value count, including oversized entries. */
  readonly totalCount: number;
  /** Entries exceeding the byte bound are omitted, never silently truncated. */
  readonly omittedCount: number;
  readonly cursor: string | null;
}

export type ObservedDiscoveryResult = ObservedDiscoveryPage & (
  | { readonly kind: "keys"; readonly keys: readonly ObservedKeyFacet[] }
  | { readonly kind: "values"; readonly key: string; readonly values: readonly ObservedValueFacet[] }
);

interface FacetRow {
  axis_key: string;
  value_type: AxisValueType;
  normalized_value: string;
  value_json: string;
  count: number;
  value_count: number;
  value_types: string;
}

/** SQL aggregation stays in the existing EAV repository; only a bounded page leaves SQLite. */
export function discoverObserved(
  db: Database.Database,
  options: ObservedDiscoveryOptions,
  snapshotIdentity: string,
  decode: (type: AxisValueType, json: string) => AxisValue,
): ObservedDiscoveryResult {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > OBSERVED_DISCOVERY_MAX_LIMIT) throw new Error(`Observed discovery limit must be between 1 and ${OBSERVED_DISCOVERY_MAX_LIMIT}.`);
  const key = options.key?.trim().toLowerCase();
  if (key === "" || (key !== undefined && Buffer.byteLength(key) > OBSERVED_DISCOVERY_MAX_VALUE_BYTES)) throw new Error(`Observed discovery key must be non-empty and at most ${OBSERVED_DISCOVERY_MAX_VALUE_BYTES} UTF-8 bytes.`);
  const query = observedPathQuery(options.fields ?? {}, options.candidatePaths);
  const scope = createHash("sha256").update(JSON.stringify([snapshotIdentity, query, key ?? null])).digest("hex");
  let after: string[] | undefined;
  if (options.cursor !== undefined) {
    try {
      if (options.cursor.length > OBSERVED_DISCOVERY_MAX_CURSOR_CHARS) throw new Error();
      const parsed = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as { v?: unknown; scope?: unknown; after?: unknown };
      if (parsed.v !== 1 || parsed.scope !== scope || !Array.isArray(parsed.after) || parsed.after.length !== (key === undefined ? 1 : 2) || !parsed.after.every(item => typeof item === "string" && Buffer.byteLength(item) <= OBSERVED_DISCOVERY_MAX_VALUE_BYTES)) throw new Error();
      after = parsed.after;
    } catch {
      throw new Error("Observed discovery cursor is invalid or its source snapshot/filter changed; restart discovery.");
    }
  }
  const params = [...query.params, ...(key === undefined ? [] : [key])];
  const group = key === undefined ? "axis_key" : "value_type, normalized_value";
  const valueColumns = key === undefined
    ? "COUNT(DISTINCT value_type || ':' || normalized_value) AS value_count, GROUP_CONCAT(DISTINCT value_type) AS value_types"
    : "value_type, normalized_value, MIN(value_json) AS value_json";
  const cte = `WITH matched AS (${query.sql}), facets AS (
    SELECT axis_key, ${valueColumns}, COUNT(DISTINCT note_path) AS count
    FROM axis_observation
    WHERE axis_kind = 'field' AND note_path IN (SELECT note_path FROM matched)${key === undefined ? "" : " AND axis_key = ?"}
    GROUP BY ${group}
  ) `;
  const boundColumn = key === undefined ? "axis_key" : "normalized_value";
  const counts = db.prepare(`${cte}SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN length(CAST(${boundColumn} AS BLOB)) > ? THEN 1 ELSE 0 END), 0) AS omitted FROM facets`).get(...params, OBSERVED_DISCOVERY_MAX_VALUE_BYTES) as { total: number; omitted: number };
  const order = key === undefined ? "axis_key" : "value_type, normalized_value";
  const afterClause = after === undefined ? "" : key === undefined ? " AND axis_key > ?" : " AND (value_type, normalized_value) > (?, ?)";
  const rows = db.prepare(`${cte}SELECT * FROM facets WHERE length(CAST(${boundColumn} AS BLOB)) <= ?${afterClause} ORDER BY ${order} LIMIT ?`).all(...params, OBSERVED_DISCOVERY_MAX_VALUE_BYTES, ...(after ?? []), limit + 1) as FacetRow[];
  const response = (page: readonly FacetRow[], more: boolean): ObservedDiscoveryResult => {
    const last = page.at(-1);
    const cursor = !more || last === undefined ? null : Buffer.from(JSON.stringify({ v: 1, scope, after: key === undefined ? [last.axis_key] : [last.value_type, last.normalized_value] })).toString("base64url");
    const metadata = { totalCount: counts.total, omittedCount: counts.omitted, cursor };
    if (key === undefined) return { ...metadata, kind: "keys", keys: page.map(row => ({ key: row.axis_key, count: row.count, valueCount: row.value_count, valueTypes: row.value_types.split(",").sort() as AxisValueType[] })) };
    return { ...metadata, kind: "values", key, values: page.map(row => { const value = decode(row.value_type, row.value_json); return { value, valueType: row.value_type, normalizedValue: row.normalized_value, count: row.count, selection: observedFacetSelection(row.value_type, value) }; }) };
  };
  // Item count is only an upper bound. Budget the actual serialized response,
  // including JSON escaping and its continuation cursor, without changing any
  // scalar value or silently dropping the remainder of the vocabulary.
  let result = response([], false);
  for (let size = 1; size <= Math.min(rows.length, limit); size++) {
    const next = response(rows.slice(0, size), size < rows.length);
    if (Buffer.byteLength(JSON.stringify(next)) > OBSERVED_DISCOVERY_MAX_PAGE_BYTES) break;
    result = next;
  }
  return result;
}
