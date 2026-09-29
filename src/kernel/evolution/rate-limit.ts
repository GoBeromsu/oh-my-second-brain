import type { LineageEvent } from "../contract/lineage.js";
import type { EvolutionEvent } from "./events.js";
import type { EvolutionLimits } from "./policy.js";
import type { RequestRecord } from "./request-state.js";

/**
 * The autonomous rate limit. What counts is read from the lineage, the record of what was
 * sealed, never from a counter the loop could forget to bump:
 *   - a `sealed` event marked autonomous;
 *   - a `recovered` unrecorded-seal event (a seal whose own event was lost), attributed by
 *     the request that attempted exactly that seal (parentEventSeq = eventSeq - 1 and the
 *     same candidate digest). One autonomous attempt counts, one human attempt does not;
 *     no attempt or more than one cannot be attributed and counts (fail-closed).
 * Bootstrap anchors, human-cli seals and human-approved seals never count.
 *
 * The time of a counted seal is its `seal.autonomous` journal entry, else the attempt's
 * `at`. A seal with no known time is always inside every window.
 */

export const DAY_MS = 24 * 60 * 60_000;
export const WEEK_MS = 7 * DAY_MS;

/** One counted seal; `at` is null when its time is unknown. */
export interface CountedSeal {
  readonly eventSeq: number;
  readonly at: number | null;
}

function attemptsFor(event: LineageEvent, requests: readonly RequestRecord[]): RequestRecord[] {
  return requests.filter(request => request.sealAttempt !== undefined
    && request.sealAttempt.parentEventSeq === event.eventSeq - 1
    && request.sealAttempt.candidateDigest === event.digest);
}

export function autonomousSeals(lineage: readonly LineageEvent[], requests: readonly RequestRecord[], journal: readonly EvolutionEvent[]): CountedSeal[] {
  const journalTime = (requestId: string | undefined): number | null => {
    if (requestId === undefined) return null;
    const entry = journal.find(event => event.kind === "seal.autonomous" && event.requestId === requestId);
    if (entry !== undefined) return entry.at;
    return requests.find(request => request.requestId === requestId)?.sealAttempt?.at ?? null;
  };
  const counted: CountedSeal[] = [];
  for (const event of lineage) {
    if (event.kind === "sealed") {
      if (event.autonomous === true) counted.push({ eventSeq: event.eventSeq, at: journalTime(event.requestId) });
      continue;
    }
    if (event.reason !== "unrecorded-seal") continue;
    const matches = attemptsFor(event, requests);
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only === undefined) counted.push({ eventSeq: event.eventSeq, at: null });
    else if (only.sealAttempt?.mode === "autonomous") counted.push({ eventSeq: event.eventSeq, at: journalTime(only.requestId) });
  }
  return counted;
}

export interface RateLimitCheck {
  readonly allowed: boolean;
  /** Counted seals within the last 24 hours and 7 days. */
  readonly day: number;
  readonly week: number;
  readonly remaining: { readonly day: number; readonly week: number };
}

export function checkRateLimit(seals: readonly CountedSeal[], limits: EvolutionLimits, now: number): RateLimitCheck {
  const within = (span: number): number => seals.filter(seal => seal.at === null || now - seal.at < span).length;
  const day = within(DAY_MS);
  const week = within(WEEK_MS);
  return {
    allowed: day < limits.perDay && week < limits.perWeek,
    day,
    week,
    remaining: { day: Math.max(0, limits.perDay - day), week: Math.max(0, limits.perWeek - week) },
  };
}
