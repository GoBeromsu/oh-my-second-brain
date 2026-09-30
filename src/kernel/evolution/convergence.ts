import { canonicalJson } from "../conventions/canonical.js";
import type { LineageEvent } from "../contract/lineage.js";
import type { VaultContract } from "../contract/types.js";
import { tokenJaccard, type Similarity } from "./stage-semantic.js";

/**
 * When evolution stops.
 *
 *   - Converged: the candidate is at least 0.95 similar to the parent, so there is nothing
 *     worth an evaluation and no request is issued.
 *   - Stalled: the last 3 generations were all sealed autonomously. Every one of them was
 *     issued unconverged (a converged candidate never is), so the loop is not settling;
 *     autonomous sealing stops (EVOLUTION_STALLED) until an owner seals a generation
 *     themselves, e.g. through `oms interview`.
 *
 * Similarity is the mean, over every folder and property key either contract has, of the
 * token similarity of the two canonical entries (a key only one side has scores 0).
 */

export const CONVERGENCE_THRESHOLD = 0.95;
export const STALL_LIMIT = 3;
const EPSILON = 1e-9;

class ConvergenceError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ConvergenceError";
  }
}

function entries(contract: VaultContract): Map<string, string> {
  const found = new Map<string, string>();
  for (const [key, entry] of Object.entries(contract.folders ?? {})) found.set(`folder:${key}`, canonicalJson(entry));
  for (const [key, entry] of Object.entries(contract.properties ?? {})) found.set(`property:${key}`, canonicalJson(entry));
  return found;
}

export function contractSimilarity(parent: VaultContract, candidate: VaultContract, similarity: Similarity = tokenJaccard): number {
  const before = entries(parent);
  const after = entries(candidate);
  const keys = new Set([...before.keys(), ...after.keys()]);
  if (keys.size === 0) return 1;
  let total = 0;
  for (const key of keys) {
    const left = before.get(key);
    const right = after.get(key);
    if (left === undefined || right === undefined) continue;
    total += left === right ? 1 : similarity(left, right);
  }
  return total / keys.size;
}

export function isConverged(parent: VaultContract, candidate: VaultContract, similarity?: Similarity): boolean {
  return contractSimilarity(parent, candidate, similarity) >= CONVERGENCE_THRESHOLD - EPSILON;
}

/**
 * How many generations in a row, counted back from the tail, were sealed autonomously. An
 * owner's seal ends the run; an unrecorded seal counts (fail-closed); a bookkeeping
 * `recovered` event (bootstrap, seq restart, gap anchor) neither counts nor ends it.
 */
export function autonomousRun(events: readonly LineageEvent[]): number {
  let run = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as LineageEvent;
    if (event.kind === "sealed") {
      if (event.autonomous !== true) break;
      run += 1;
    } else if (event.reason === "unrecorded-seal") {
      run += 1;
    }
  }
  return run;
}

export function isStalled(events: readonly LineageEvent[]): boolean {
  return autonomousRun(events) >= STALL_LIMIT;
}

export function assertNotStalled(events: readonly LineageEvent[]): void {
  if (!isStalled(events)) return;
  throw new ConvergenceError("EVOLUTION_STALLED", `the last ${STALL_LIMIT} generations were sealed autonomously without converging; autonomous sealing is paused until an owner seals a generation (run \`oms interview\` in a terminal)`);
}
