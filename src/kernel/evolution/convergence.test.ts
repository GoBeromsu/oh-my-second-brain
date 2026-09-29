import { describe, expect, it } from "vitest";
import type { LineageEvent } from "../contract/lineage.js";
import type { VaultContract } from "../contract/types.js";
import { assertNotStalled, autonomousRun, contractSimilarity, isConverged, isStalled, STALL_LIMIT } from "./convergence.js";

const folder = (meaning: string) => ({ meaning, searchExclude: false });

function contract(folders: Record<string, string>): VaultContract {
  return {
    folders: Object.fromEntries(Object.entries(folders).map(([key, meaning]) => [key, folder(meaning)])),
    properties: {},
  } as unknown as VaultContract;
}

let seq = 0;
function event(kind: LineageEvent["kind"], extra: Partial<LineageEvent> = {}): LineageEvent {
  seq += 1;
  return { eventSeq: seq, kind, generation: seq, parentDigest: "none", digest: `sha256:${String(seq).padStart(64, "0")}`, mutations: [], manifestDigests: {}, ...extra } as LineageEvent;
}
const auto = () => event("sealed", { autonomous: true, mode: "autonomous" });
const human = () => event("sealed");

describe("contractSimilarity", () => {
  it("is 1 for identical or empty contracts and 0 when no key is shared", () => {
    const a = contract({ Projects: "active work" });
    expect(contractSimilarity(a, a)).toBe(1);
    expect(contractSimilarity(contract({}), contract({}))).toBe(1);
    expect(contractSimilarity(a, contract({ Areas: "active work" }))).toBe(0);
    const open = { folders: null, properties: null } as VaultContract;
    expect(contractSimilarity(open, open)).toBe(1);
  });

  it("averages per-key similarity over the union of keys", () => {
    const parent = contract({ A: "x", B: "y" });
    const candidate = contract({ A: "x", B: "z" });
    expect(contractSimilarity(parent, candidate, () => 0.5)).toBeCloseTo(0.75);
    expect(contractSimilarity(parent, contract({ A: "x" }))).toBeCloseTo(0.5);
  });
});

describe("isConverged", () => {
  it("treats similarity 0.95 as converged and 0.94 as not", () => {
    const parent = contract({ A: "x" });
    const candidate = contract({ A: "y" });
    expect(isConverged(parent, candidate, () => 0.95)).toBe(true);
    expect(isConverged(parent, candidate, () => 0.94)).toBe(false);
  });
});

describe("stall detection", () => {
  it("stalls after three consecutive autonomous generations", () => {
    const events = [human(), auto(), auto()];
    expect(autonomousRun(events)).toBe(2);
    expect(isStalled(events)).toBe(false);
    expect(() => assertNotStalled(events)).not.toThrow();
    const stalled = [...events, auto()];
    expect(autonomousRun(stalled)).toBe(STALL_LIMIT);
    expect(() => assertNotStalled(stalled)).toThrow(/^EVOLUTION_STALLED: .*oms interview/);
  });

  it("resumes once an owner seals a generation", () => {
    expect(isStalled([auto(), auto(), auto(), human()])).toBe(false);
    expect(autonomousRun([auto(), auto(), auto(), human(), auto()])).toBe(1);
  });

  it("counts an unrecorded seal and skips bookkeeping anchors", () => {
    const events = [human(), auto(), event("recovered", { reason: "unrecorded-seal" }), event("recovered", { reason: "gap-anchor" }), auto()];
    expect(autonomousRun(events)).toBe(3);
    expect(isStalled(events)).toBe(true);
    expect(autonomousRun([event("recovered", { reason: "bootstrap" })])).toBe(0);
  });
});
