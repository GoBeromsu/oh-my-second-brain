import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Reader for `~/.oms/guard-events.jsonl`, the `{ts, kind}` lines the Claude guard wrapper
 * appends when it cannot reach the judge. Doctor is the only reader; the judge never
 * consults it. Only counts per known kind leave this module.
 */

const TRANSPORT_FAILURE_KINDS = ["spawn-failed", "exit-nonzero", "timeout", "empty-output", "malformed-output", "internal"] as const;
export type TransportFailureKind = typeof TRANSPORT_FAILURE_KINDS[number];

export interface TransportFailures {
  readonly total: number;
  readonly kinds: Readonly<Partial<Record<TransportFailureKind, number>>>;
  /** Present when the guard recorded output it could not read, which an outdated guard does. */
  readonly hint?: string;
}

/** An older installed guard reads a newer judge's warning as malformed; it still allows the write. */
export const MALFORMED_OUTPUT_HINT = "an older guard may not understand this CLI's output; run `oms setup host sync`";

/** The events file sits beside the contract store root (`~/.oms/vaults`). */
export function guardEventsPath(storeRootDirectory: string): string {
  return join(dirname(storeRootDirectory), "guard-events.jsonl");
}

/** Counts recorded transport failures by kind. A missing or unreadable file counts as none. */
export async function readTransportFailures(storeRootDirectory: string): Promise<TransportFailures> {
  let text: string;
  try {
    text = await readFile(guardEventsPath(storeRootDirectory), "utf-8");
  } catch {
    return { total: 0, kinds: {} };
  }
  const kinds: Partial<Record<TransportFailureKind, number>> = {};
  let total = 0;
  for (const line of text.split("\n")) {
    let kind: unknown;
    try {
      kind = (JSON.parse(line) as { kind?: unknown }).kind;
    } catch {
      continue;
    }
    if (!(TRANSPORT_FAILURE_KINDS as readonly unknown[]).includes(kind)) continue;
    const known = kind as TransportFailureKind;
    kinds[known] = (kinds[known] ?? 0) + 1;
    total += 1;
  }
  return (kinds["malformed-output"] ?? 0) > 0 ? { total, kinds, hint: MALFORMED_OUTPUT_HINT } : { total, kinds };
}
