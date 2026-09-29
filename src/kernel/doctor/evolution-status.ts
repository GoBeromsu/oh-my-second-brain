import { readLineage } from "../contract/lineage.js";
import { lineageHealth } from "../contract/lineage-health.js";
import { storeRoot } from "../contract/store.js";
import { resolveSealState } from "../contract/vault-id.js";
import { readEvolutionEvents, EVOLUTION_EVENT_KINDS, type EvolutionCounters, type EvolutionEventKind } from "../evolution/events.js";
import { readPolicy, type EvolutionLimits } from "../evolution/policy.js";
import { autonomousSeals, checkRateLimit } from "../evolution/rate-limit.js";
import { listRequests } from "../evolution/request-state.js";

/**
 * The evolution section of `doctor status`: counters from the evolution journal, the
 * requests waiting for the owner, the autonomous budget left in the current day and week,
 * and whether the lineage currently has a gap. Read-only: every reader here returns empty
 * for an absent store and creates nothing. An unsealed vault has no evolution (null).
 */
export interface EvolutionStatus {
  readonly autonomous: boolean;
  readonly policy: "absent" | "ok" | "invalid";
  readonly counters: EvolutionCounters;
  readonly awaitingHuman: number;
  readonly budget: {
    readonly limits: EvolutionLimits;
    readonly used: { readonly day: number; readonly week: number };
    readonly remaining: { readonly day: number; readonly week: number };
  };
  readonly lineageGap: boolean;
}

export async function evolutionStatus(vault: string, now: number, root: string = storeRoot()): Promise<EvolutionStatus | null> {
  const state = await resolveSealState(vault, root);
  if (state.row !== "sealed" || state.vaultId === null) return null;
  const vaultId = state.vaultId;
  const policy = await readPolicy(root, vaultId);
  const journal = (await readEvolutionEvents(root, vaultId)).events;
  const counters = Object.fromEntries(EVOLUTION_EVENT_KINDS.map(kind => [kind, 0])) as Record<EvolutionEventKind, number>;
  for (const event of journal) counters[event.kind] += 1;
  const requests = (await listRequests(root, vaultId)).records;
  const lineage = (await readLineage(root, vaultId, "display")).events;
  const check = checkRateLimit(autonomousSeals(lineage, requests, journal), policy.policy.limits, now);
  const health = await lineageHealth(vaultId, root);
  return {
    autonomous: policy.policy.autonomous,
    policy: policy.state,
    counters,
    awaitingHuman: requests.filter(request => request.state === "awaiting-human").length,
    budget: {
      limits: policy.policy.limits,
      used: { day: check.day, week: check.week },
      remaining: policy.policy.autonomous ? check.remaining : { day: 0, week: 0 },
    },
    lineageGap: health.findings.some(finding => finding.kind === "lineage-gap"),
  };
}
