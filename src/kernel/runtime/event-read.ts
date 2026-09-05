import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { resolveRuntimeLedgerLocation } from "./event-journal.js";
import {
  type RuntimeEventOutcome,
  type RuntimeEventReadOptions,
  type RuntimeEventReadResult,
  type StoredRuntimeEvent,
} from "./event-types.js";

interface StoredEventRow {
  readonly event_id: string;
  readonly invocation_id: string;
  readonly attempt_n: number;
  readonly transaction_id: string | null;
  readonly event_time: string | null;
  readonly observed_at: string;
  readonly registered_at: string;
  readonly kind: string;
  readonly outcome: RuntimeEventOutcome;
  readonly changed_between_from: string | null;
  readonly changed_between_to: string | null;
  readonly vault_fingerprint: string;
  readonly host_id: string;
  readonly surface: string;
  readonly operation: string;
  readonly template_id: string | null;
  readonly note_path: string | null;
  readonly input_signature: string | null;
  readonly template_signature: string | null;
  readonly package_version: string | null;
  readonly git_commit: string | null;
}

function storedEvent(row: StoredEventRow): StoredRuntimeEvent {
  return {
    eventId: row.event_id,
    invocationId: row.invocation_id,
    attemptN: row.attempt_n,
    transactionId: row.transaction_id,
    eventTime: row.event_time,
    observedAt: row.observed_at,
    registeredAt: row.registered_at,
    kind: row.kind,
    outcome: row.outcome,
    changedBetweenFrom: row.changed_between_from,
    changedBetweenTo: row.changed_between_to,
    hostId: row.host_id,
    vaultFingerprint: row.vault_fingerprint,
    surface: row.surface,
    operation: row.operation,
    templateId: row.template_id,
    notePath: row.note_path,
    inputSignature: row.input_signature,
    templateSignature: row.template_signature,
    packageVersion: row.package_version,
    gitCommit: row.git_commit,
  };
}

/** Read retained history for exactly the current host and real vault identity. */
export function readRuntimeEvents(options: RuntimeEventReadOptions): RuntimeEventReadResult {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0)) {
    throw new TypeError("limit must be a non-negative integer");
  }
  const location = resolveRuntimeLedgerLocation(options, false);
  if (location === null || !existsSync(location.databasePath)) return { events: [], partial: false };

  const database = new Database(location.databasePath, { readonly: true, fileMustExist: true });
  try {
    database.pragma("busy_timeout = 5000");
    database.pragma("query_only = ON");
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_events'").get();
    if (table === undefined) return { events: [], partial: false };

    const conditions = ["host_id = ?", "vault_fingerprint = ?"];
    const values: (string | number)[] = [location.hostId, location.vaultFingerprint];
    if (options.surface !== undefined) {
      conditions.push("surface = ?");
      values.push(options.surface);
    }
    if (options.operation !== undefined) {
      conditions.push("operation = ?");
      values.push(options.operation);
    }
    if (options.kinds !== undefined) {
      if (options.kinds.length === 0) return { events: [], partial: false };
      conditions.push(`kind IN (${options.kinds.map(() => "?").join(", ")})`);
      values.push(...options.kinds);
    }
    if (options.outcomes !== undefined) {
      if (options.outcomes.length === 0) return { events: [], partial: false };
      conditions.push(`outcome IN (${options.outcomes.map(() => "?").join(", ")})`);
      values.push(...options.outcomes);
    }

    let sql = `SELECT * FROM runtime_events WHERE ${conditions.join(" AND ")} ORDER BY registered_at DESC, rowid DESC`;
    if (options.limit !== undefined) {
      sql += " LIMIT ?";
      values.push(options.limit + 1);
    }
    const rows = database.prepare(sql).all(...values) as StoredEventRow[];
    const partial = options.limit !== undefined && rows.length > options.limit;
    const visible = partial ? rows.slice(0, options.limit) : rows;
    return { events: visible.map(storedEvent), partial };
  } finally {
    database.close();
  }
}
