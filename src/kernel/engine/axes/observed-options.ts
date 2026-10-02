import { observedPathQuery, type ObservedFieldFilters } from "./observed-query.js";
import { OBSERVED_DISCOVERY_MAX_CURSOR_CHARS, OBSERVED_DISCOVERY_MAX_LIMIT, OBSERVED_DISCOVERY_MAX_VALUE_BYTES } from "./observed-discovery.js";

export interface ObservedQueryOptions {
  readonly field?: ObservedFieldFilters;
  readonly discover?: {
    readonly key?: string;
    readonly limit?: number;
    readonly cursor?: string;
  };
}

function mapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate the closed explicit namespace before any engine/backend is selected. */
export function observedQueryOptions(value: unknown): ObservedQueryOptions | undefined {
  if (value === undefined) return undefined;
  if (!mapping(value)) throw new Error('Query "observed" must be an object.');
  if (Object.keys(value).some(key => key !== "field" && key !== "discover")) throw new Error('Query "observed" accepts only field and discover.');
  if (value["field"] === undefined && value["discover"] === undefined) throw new Error('Query "observed" requires field or discover.');
  const field = value["field"] as ObservedFieldFilters | undefined;
  if (field !== undefined) observedPathQuery(field);
  const discover = value["discover"];
  if (discover === undefined) return { field };
  if (!mapping(discover) || Object.keys(discover).some(key => key !== "key" && key !== "limit" && key !== "cursor")) throw new Error('Query "observed.discover" accepts only key, limit, and cursor.');
  const key = discover["key"];
  if (key !== undefined && (typeof key !== "string" || key.trim() === "" || Buffer.byteLength(key.trim()) > OBSERVED_DISCOVERY_MAX_VALUE_BYTES)) throw new Error(`Query "observed.discover.key" must be non-empty and at most ${OBSERVED_DISCOVERY_MAX_VALUE_BYTES} UTF-8 bytes.`);
  const limit = discover["limit"];
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > OBSERVED_DISCOVERY_MAX_LIMIT)) throw new Error(`Query "observed.discover.limit" must be an integer between 1 and ${OBSERVED_DISCOVERY_MAX_LIMIT}.`);
  const cursor = discover["cursor"];
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > OBSERVED_DISCOVERY_MAX_CURSOR_CHARS)) throw new Error('Query "observed.discover.cursor" must be a non-empty bounded cursor.');
  return { ...(field === undefined ? {} : { field }), discover: { ...(key === undefined ? {} : { key }), ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) } };
}
