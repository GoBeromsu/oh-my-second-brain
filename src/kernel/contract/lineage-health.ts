import { NO_DIGEST } from "./digest.js";
import { SNAPSHOT_TEMPORARY_PREFIX, snapshotInventory } from "./generation-snapshot.js";
import { chainViolations, classifyLineageTail, type LineageEvent } from "./lineage.js";
import { currentSequence, observeLineage, storeRoot } from "./store.js";

/**
 * The lineage and kept snapshots, diagnosed only: nothing is created, bootstrapped or
 * repaired here. The two repairs are `oms doctor lineage-recover` (records what the
 * chain can account for) and `oms doctor lineage-reanchor` (also anchors a gap).
 */

export type LineageFindingKind =
  | "before-bootstrap"
  | "lineage-unrecorded-seal"
  | "lineage-seq-restart"
  | "lineage-gap"
  | "lineage-chain-broken"
  | "lineage-corrupt"
  | "lineage-truncated-tail"
  | "lineage-unreadable"
  | "snapshot-unsealed"
  | "snapshot-missing"
  | "snapshot-unexpected-entry";

export type LineageRepair = "oms doctor lineage-recover" | "oms doctor lineage-reanchor";

export interface LineageFinding {
  readonly kind: LineageFindingKind;
  readonly detail: string;
  readonly recovery: LineageRepair | null;
}

export interface LineageHealth {
  readonly events: number;
  readonly snapshots: number;
  readonly snapshotBytes: number;
  readonly findings: readonly LineageFinding[];
}

/** Findings that are recorded facts rather than faults: a pre-lineage store, a kept crash snapshot, a cut last line. */
const INFORMATIONAL: ReadonlySet<LineageFindingKind> = new Set(["before-bootstrap", "snapshot-unsealed", "lineage-truncated-tail"]);

export function lineageNeedsAttention(health: LineageHealth | null): boolean {
  return health !== null && health.findings.some(finding => !INFORMATIONAL.has(finding.kind));
}

const RECOVER: LineageRepair = "oms doctor lineage-recover";
const REANCHOR: LineageRepair = "oms doctor lineage-reanchor";

function named(events: readonly LineageEvent[]): Set<string> {
  const digests = new Set<string>();
  for (const event of events) {
    for (const digest of [event.parentDigest, event.digest, event.priorTail, event.gapFrom]) {
      if (digest !== undefined && digest !== NO_DIGEST) digests.add(digest);
    }
  }
  return digests;
}

export async function lineageHealth(vaultId: string, root: string = storeRoot()): Promise<LineageHealth> {
  let observed;
  let inventory;
  try {
    observed = await observeLineage(root, vaultId, await currentSequence(vaultId, root), "display");
    inventory = await snapshotInventory(root, vaultId);
  } catch (error: unknown) {
    const detail = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "the lineage could not be read";
    return { events: 0, snapshots: 0, snapshotBytes: 0, findings: [{ kind: "lineage-unreadable", detail, recovery: null }] };
  }
  const { events, corrupt, truncatedTail } = observed.lineage;
  const P = observed.parent.digest;
  const findings: LineageFinding[] = [];
  for (const line of corrupt) findings.push({ kind: "lineage-corrupt", detail: `line ${line} does not parse`, recovery: null });
  if (truncatedTail) findings.push({ kind: "lineage-truncated-tail", detail: "the last line is cut short and is ignored; the next append drops it", recovery: null });
  for (const violation of chainViolations(events, observed.input.retained)) findings.push({ kind: "lineage-chain-broken", detail: violation, recovery: null });

  if (events.length === 0) {
    if (observed.sources.length > 0) {
      findings.push({ kind: "before-bootstrap", detail: `${observed.sources.length} kept generation(s) predate the lineage; the next seal records them`, recovery: RECOVER });
    }
  } else {
    const classified = classifyLineageTail(events, observed.input);
    if (classified.outcome === "unrecorded-seal") findings.push({ kind: "lineage-unrecorded-seal", detail: `${P} is sealed but has no lineage event`, recovery: RECOVER });
    else if (classified.outcome === "seq-restart") findings.push({ kind: "lineage-seq-restart", detail: "the lineage ends at a generation but nothing is linked", recovery: RECOVER });
    else if (classified.outcome === "gap") findings.push({ kind: "lineage-gap", detail: `the lineage ends at ${events.at(-1)?.digest} but ${P} is linked`, recovery: REANCHOR });
  }

  const recorded = named(events);
  const kept = new Set<string>(inventory.digests);
  const recreatable = new Set<string>(observed.sources.map(source => source.read.digest));
  for (const digest of inventory.digests) {
    if (!recorded.has(digest) && digest !== P) findings.push({ kind: "snapshot-unsealed", detail: `${digest} was snapshotted but never sealed; it is kept`, recovery: null });
  }
  for (const digest of [...recorded].filter(digest => !kept.has(digest)).sort()) {
    findings.push({ kind: "snapshot-missing", detail: `${digest} is in the lineage but has no snapshot`, recovery: recreatable.has(digest) ? RECOVER : null });
  }
  for (const entry of inventory.unexpected) {
    findings.push({ kind: "snapshot-unexpected-entry", detail: entry, recovery: entry.startsWith(SNAPSHOT_TEMPORARY_PREFIX) ? RECOVER : null });
  }
  return { events: events.length, snapshots: inventory.digests.length, snapshotBytes: inventory.bytes, findings };
}
