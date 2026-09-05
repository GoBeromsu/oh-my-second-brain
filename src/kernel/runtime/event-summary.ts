import { readRuntimeEvents } from "./event-read.js";
import type { RuntimeLedgerOptions, StoredRuntimeEvent } from "./event-types.js";

export interface RuntimeObservationSummary {
  readonly status: "observed" | "unobserved";
  readonly lastUsedAt: string | null;
  readonly lastVerifiedAt: string | null;
  readonly uses: number;
  readonly currentSignature: string | null;
  readonly previousSignature: string | null;
  readonly changedBetween: readonly [string | null, string] | null;
  readonly gaps: number;
}

export interface RuntimeHistorySummary {
  readonly events: number;
  readonly uses: number;
  readonly verifications: number;
  readonly gaps: number;
  readonly templates: Readonly<Record<string, RuntimeObservationSummary>>;
}

function latest(events: readonly StoredRuntimeEvent[], predicate: (event: StoredRuntimeEvent) => boolean): StoredRuntimeEvent | undefined {
  return events.find(predicate);
}

/** Summarizes only retained observations for this host and vault; it never creates a ledger. */
export function summarizeRuntimeHistory(options: RuntimeLedgerOptions): RuntimeHistorySummary {
  const events = readRuntimeEvents(options).events;
  const templateIds = [...new Set(events.flatMap(event => event.templateId === null ? [] : [event.templateId]))].sort();
  const templates: Record<string, RuntimeObservationSummary> = {};
  for (const templateId of templateIds) {
    const matching = events.filter(event => event.templateId === templateId);
    const uses = matching.filter(event =>
      (event.kind === "note-write" || event.kind === "template-use") &&
      event.outcome === "success"
    );
    const verifications = matching.filter(event => event.kind === "template-verification");
    const current = verifications[0];
    const previous = current === undefined
      ? undefined
      : verifications.find(event => event.templateSignature !== current.templateSignature);
    const verified = verifications.find(event => event.outcome === "success");
    const change = current === undefined
      ? undefined
      : verifications.find(event =>
          event.templateSignature === current.templateSignature &&
          event.changedBetweenTo !== null
        );
    templates[templateId] = {
      status: current === undefined || current.outcome === "observation-gap" ? "unobserved" : "observed",
      lastUsedAt: (() => {
        const use = latest(uses, () => true);
        return use?.eventTime ?? use?.observedAt ?? null;
      })(),
      lastVerifiedAt: verified?.observedAt ?? null,
      uses: uses.length,
      currentSignature: current?.templateSignature ?? null,
      previousSignature: previous?.templateSignature ?? null,
      changedBetween: change?.changedBetweenTo === null || change?.changedBetweenTo === undefined
        ? null
        : [change.changedBetweenFrom, change.changedBetweenTo],
      gaps: matching.filter(event => event.outcome === "observation-gap").length,
    };
  }
  return {
    events: events.length,
    uses: events.filter(event =>
      (event.kind === "note-write" || event.kind === "template-use") &&
      event.outcome === "success"
    ).length,
    verifications: events.filter(event => event.kind === "template-verification").length,
    gaps: events.filter(event => event.outcome === "observation-gap").length,
    templates,
  };
}
