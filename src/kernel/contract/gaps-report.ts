import type { Digest } from "../conventions/canonical.js";
import { contractContradictions, type Contradiction } from "./contradiction.js";
import { GAP_AXES, GAP_KINDS, openGaps, readGapLedger, type GapAxis, type GapKind, type GapLedger } from "./gap-ledger.js";
import { contractRevision } from "./revision.js";
import { storeRoot } from "./store.js";
import { resolveSealState, type SealState } from "./vault-id.js";

/**
 * `oms doctor gaps`: the open gaps in the ledger and the contradictions in the sealed
 * contract, read-only. It never creates the store, the state directory or the ledger.
 * Each gap is reported by id, note path, axis, kind and field, never by the value the
 * writer wanted, and a gap recorded under an older contract revision is marked stale.
 */

export interface GapEntry {
  readonly id: string;
  readonly notePath: string;
  readonly axis: GapAxis;
  readonly kind: GapKind;
  readonly field: string;
  /** True when a draft holds the note because nothing valid could be saved. */
  readonly drafted: boolean;
  /** True when the gap was recorded under a contract revision other than the current one. */
  readonly stale: boolean;
}

export interface GapsReport {
  readonly contract: "open" | "sealed" | "unreadable";
  readonly contractRevision: Digest | null;
  /** `unreadable` when the ledger exists but could not be read (too large or an unsafe state entry). */
  readonly ledger: "ok" | "unreadable";
  readonly open: number;
  readonly byAxis: Readonly<Record<GapAxis, number>>;
  readonly byKind: Readonly<Record<GapKind, number>>;
  readonly gaps: readonly GapEntry[];
  /** 1-based ledger lines that did not parse; they are skipped, never rewritten. */
  readonly corruptLines: readonly number[];
  readonly contradictions: readonly Contradiction[];
}

export interface GapsReportDeps {
  readonly root: string;
  readonly resolveSealState: (vault: string, root: string) => Promise<SealState>;
  readonly readGapLedger: (root: string, vaultId: string) => Promise<GapLedger>;
}

function counts<K extends string>(keys: readonly K[], values: readonly K[]): Record<K, number> {
  const out = Object.fromEntries(keys.map(key => [key, 0])) as Record<K, number>;
  for (const value of values) out[value] += 1;
  return out;
}

export async function gapsReport(vault: string, overrides: Partial<GapsReportDeps> = {}): Promise<GapsReport> {
  const deps: GapsReportDeps = { root: storeRoot(), resolveSealState, readGapLedger, ...overrides };
  const seal = await deps.resolveSealState(vault, deps.root);
  const revision = contractRevision(seal.view);
  let ledger: GapLedger = { events: [], corrupt: [] };
  let ledgerState: GapsReport["ledger"] = "ok";
  if (seal.vaultId !== null) {
    try {
      ledger = await deps.readGapLedger(deps.root, seal.vaultId);
    } catch {
      ledgerState = "unreadable";
    }
  }
  const gaps = openGaps(ledger.events).map((gap): GapEntry => ({
    id: gap.id,
    notePath: gap.notePath,
    axis: gap.axis,
    kind: gap.kind,
    field: gap.wanted.field,
    drafted: gap.draftRef !== undefined,
    stale: gap.contractRevision !== revision,
  }));
  return {
    contract: seal.view.state,
    contractRevision: revision,
    ledger: ledgerState,
    open: gaps.length,
    byAxis: counts(GAP_AXES, gaps.map(gap => gap.axis)),
    byKind: counts(GAP_KINDS, gaps.map(gap => gap.kind)),
    gaps,
    corruptLines: ledger.corrupt,
    contradictions: seal.view.state === "sealed" ? contractContradictions(seal.view.contract) : [],
  };
}
