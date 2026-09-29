import { describe, expect, it } from "vitest";
import type { LineageEvent } from "../contract/lineage.js";
import type { EvolutionEvent } from "./events.js";
import { autonomousSeals, checkRateLimit, DAY_MS, WEEK_MS } from "./rate-limit.js";
import type { RequestRecord, SealMode } from "./request-state.js";

const D = (n: number): string => `sha256:${String(n).padStart(64, "0")}`;
const NOW = 1_700_000_000_000;

function sealed(eventSeq: number, extra: Partial<LineageEvent> = {}): LineageEvent {
  return { eventSeq, kind: "sealed", generation: eventSeq, parentDigest: D(eventSeq - 1), digest: D(eventSeq), mutations: [], manifestDigests: {}, ...extra } as LineageEvent;
}

function recovered(eventSeq: number, reason: LineageEvent["reason"]): LineageEvent {
  return { eventSeq, kind: "recovered", generation: eventSeq, parentDigest: D(eventSeq - 1), digest: D(eventSeq), mutations: [], manifestDigests: {}, reason } as LineageEvent;
}

function request(requestId: string, attempt?: { parentEventSeq: number; digest: number; mode: SealMode; at?: number }): RequestRecord {
  return {
    requestId,
    ...(attempt === undefined ? {} : { sealAttempt: { requestId, parentEventSeq: attempt.parentEventSeq, candidateDigest: D(attempt.digest), mode: attempt.mode, ...(attempt.at === undefined ? {} : { at: attempt.at }) } }),
  } as unknown as RequestRecord;
}

const journal = (requestId: string, at: number): EvolutionEvent => ({ kind: "seal.autonomous", at, requestId });

describe("autonomousSeals", () => {
  it("counts autonomous sealed events and skips human, human-cli and bootstrap events", () => {
    const lineage = [recovered(1, "bootstrap"), sealed(2, { proposer: "human-cli" }), sealed(3, { requestId: "h", mode: "human", autonomous: false }), sealed(4, { requestId: "a", autonomous: true })];
    expect(autonomousSeals(lineage, [], [journal("a", NOW - 5)])).toEqual([{ eventSeq: 4, at: NOW - 5 }]);
  });

  it("falls back to the seal attempt's time, then to an unknown time", () => {
    const lineage = [sealed(1, { requestId: "a", autonomous: true }), sealed(2, { requestId: "b", autonomous: true }), sealed(3, { autonomous: true })];
    const requests = [request("a", { parentEventSeq: 0, digest: 1, mode: "autonomous", at: NOW - 9 }), request("b")];
    expect(autonomousSeals(lineage, requests, [])).toEqual([{ eventSeq: 1, at: NOW - 9 }, { eventSeq: 2, at: null }, { eventSeq: 3, at: null }]);
  });

  it("attributes an unrecorded seal by the one request that attempted it", () => {
    const lineage = [sealed(1), recovered(2, "unrecorded-seal"), recovered(3, "unrecorded-seal")];
    const requests = [request("a", { parentEventSeq: 1, digest: 2, mode: "autonomous", at: NOW - 7 }), request("h", { parentEventSeq: 2, digest: 3, mode: "human", at: NOW })];
    expect(autonomousSeals(lineage, requests, [])).toEqual([{ eventSeq: 2, at: NOW - 7 }]);
  });

  it("counts an unrecorded seal no request or several requests attempted (fail-closed)", () => {
    const lineage = [sealed(1), recovered(2, "unrecorded-seal"), recovered(3, "unrecorded-seal"), recovered(4, "gap-anchor")];
    const requests = [request("h1", { parentEventSeq: 2, digest: 3, mode: "human" }), request("h2", { parentEventSeq: 2, digest: 3, mode: "human" }), request("x", { parentEventSeq: 5, digest: 2, mode: "autonomous" })];
    expect(autonomousSeals(lineage, requests, [])).toEqual([{ eventSeq: 2, at: null }, { eventSeq: 3, at: null }]);
  });
});

describe("checkRateLimit", () => {
  const limits = { perDay: 1, perWeek: 3 };

  it("allows a first seal", () => {
    expect(checkRateLimit([], limits, NOW)).toEqual({ allowed: true, day: 0, week: 0, remaining: { day: 1, week: 3 } });
  });

  it("refuses a second seal within 24 hours and allows it after", () => {
    expect(checkRateLimit([{ eventSeq: 1, at: NOW - DAY_MS + 1 }], limits, NOW).allowed).toBe(false);
    expect(checkRateLimit([{ eventSeq: 1, at: NOW - DAY_MS }], limits, NOW)).toEqual({ allowed: true, day: 0, week: 1, remaining: { day: 1, week: 2 } });
  });

  it("refuses a fourth seal within 7 days", () => {
    const seals = [1, 2, 3].map(n => ({ eventSeq: n, at: NOW - n * DAY_MS - 1 }));
    expect(checkRateLimit(seals, limits, NOW)).toEqual({ allowed: false, day: 0, week: 3, remaining: { day: 1, week: 0 } });
    expect(checkRateLimit(seals.map(seal => ({ ...seal, at: NOW - WEEK_MS })), limits, NOW).allowed).toBe(true);
  });

  it("keeps a seal of unknown time inside every window", () => {
    expect(checkRateLimit([{ eventSeq: 1, at: null }], limits, NOW + 30 * DAY_MS)).toMatchObject({ allowed: false, day: 1, week: 1 });
  });

  it("honours lowered limits, including zero", () => {
    expect(checkRateLimit([], { perDay: 0, perWeek: 3 }, NOW).allowed).toBe(false);
    expect(checkRateLimit([{ eventSeq: 1, at: NOW - 2 * DAY_MS }], { perDay: 1, perWeek: 1 }, NOW).allowed).toBe(false);
  });
});
