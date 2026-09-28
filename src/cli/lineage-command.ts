import path from "node:path";

import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";
import { repairDoctor } from "../kernel/doctor/service.js";
import { resolveEffectiveVault } from "../kernel/link/link.js";

/**
 * `oms doctor lineage-recover` and `lineage-reanchor`: the two contract-lineage repairs.
 * Recover records only what the chain can account for and refuses a gap; reanchor also
 * anchors a gap. Both keep the verified-target gate: a cwd-inferred vault is rejected.
 */

export type LineageLeaf = "lineage-recover" | "lineage-reanchor";

function usage(leaf: LineageLeaf): string {
  return `Usage: oms doctor ${leaf} [--vault <path>]`;
}

function parseVault(leaf: LineageLeaf, argv: readonly string[]): string | undefined {
  let vault: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token !== "--vault") throw new Error(`CONTRACT_ARGS_INVALID: doctor ${leaf} received unknown argument ${token}`);
    if (vault !== undefined) throw new Error("CONTRACT_ARGS_INVALID: duplicate flag --vault");
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error("CONTRACT_ARGS_INVALID: --vault requires a value");
    vault = value;
  }
  return vault;
}

async function target(explicit: string | undefined): Promise<{ readonly vault: string; readonly source: WriteTargetSource }> {
  if (explicit !== undefined) return { vault: path.resolve(explicit), source: "explicit" };
  const resolved = await resolveEffectiveVault(process.cwd(), process.env);
  return { vault: resolved.vault, source: resolved.source };
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function runLineageCommand(leaf: LineageLeaf, argv: readonly string[]): Promise<void> {
  process.exitCode = 0;
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(usage(leaf));
    return;
  }
  try {
    const resolved = await target(parseVault(leaf, argv));
    const result = await repairDoctor({ operation: leaf, vault: resolved.vault, source: resolved.source, args: undefined });
    if (result.kind === "error") {
      process.exitCode = 1;
      print({ status: "error", message: result.message });
      return;
    }
    if (result.kind === "rejected") process.exitCode = 1;
    print(result.value);
  } catch (error: unknown) {
    process.exitCode = 1;
    print({
      status: "rejected",
      diagnostics: [{
        code: error instanceof Error ? error.message.split(":", 1)[0] : "CONTRACT_LINEAGE_REPAIR_FAILED",
        remediation: error instanceof Error ? error.message : String(error),
      }],
    });
  }
}
