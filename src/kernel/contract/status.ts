import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { compareCodePoints } from "../conventions/canonical.js";
import { detectDrift, type DriftState } from "./drift.js";
import { readTransportFailures, type TransportFailures } from "./guard-events.js";
import { diagnoseStore, storeExists, storeHousekeeping, storeRoot, writeIndexEntry, type StoreCause } from "./store.js";
import { resolveSealState, type SealRow } from "./vault-id.js";
import type { Guidance } from "./types.js";

/**
 * Contract posture for `oms contract status` and `doctor`. Read-only except `doctorFix`,
 * which only re-indexes. Output never carries a vault id, a store path or a rule value.
 */

export interface DoctorFinding {
  readonly message: string;
  readonly guidance: Guidance | null;
}

export interface ContractTemplateStatus {
  readonly name: string;
  readonly state: DriftState;
}

export interface ContractStatus {
  readonly contract: "none" | "sealed" | "unreadable";
  readonly row: SealRow;
  readonly findings: readonly DoctorFinding[];
  readonly templates: readonly ContractTemplateStatus[];
}

/** Fixed doctor wording per truth-table row. */
export const ROW_FINDING: Readonly<Record<SealRow, DoctorFinding>> = {
  "never-sealed": { message: "contract: none", guidance: "oms setup" },
  "synced-second-machine": { message: "vaultId present, no local store", guidance: "oms setup" },
  "store-without-index": { message: "index entry missing", guidance: "oms contract doctor --fix" },
  "vault-moved": { message: "vault moved", guidance: "oms contract doctor --fix" },
  "sealed": { message: "contract: sealed", guidance: null },
  "index-without-store": { message: "contract store missing", guidance: "oms setup" },
  "vault-id-tampered": { message: "vault id mismatch", guidance: "oms contract doctor" },
  "index-corrupt": { message: "index unreadable", guidance: "oms contract doctor --fix" },
};

export const SHARED_FINDING: DoctorFinding = { message: "vault id shared", guidance: "oms contract doctor" };
const SETTINGS_INVALID_FINDING: DoctorFinding = { message: "vault settings unreadable", guidance: "oms contract doctor" };
export const STORE_UNREADABLE_FINDING: DoctorFinding = { message: "contract store unreadable", guidance: "oms setup" };

export async function contractStatus(vault: string, root: string = storeRoot()): Promise<ContractStatus> {
  const state = await resolveSealState(vault, root);
  const findings: DoctorFinding[] = [ROW_FINDING[state.row]];
  if (state.settingsInvalid) findings.push(SETTINGS_INVALID_FINDING);
  if (state.shared) findings.push(SHARED_FINDING);
  if (state.view.state !== "sealed") {
    const loadedRow = state.row !== "index-without-store" && state.row !== "vault-id-tampered";
    if (state.view.state === "unreadable" && loadedRow) findings.push(STORE_UNREADABLE_FINDING);
    return { contract: state.view.state === "unreadable" ? "unreadable" : "none", row: state.row, findings, templates: [] };
  }
  const drift = await detectDrift(vault, state.view.contract);
  const templates = [...drift].sort(([left], [right]) => compareCodePoints(left, right)).map(([name, driftState]) => ({ name, state: driftState }));
  return { contract: "sealed", row: state.row, findings, templates };
}

/** Why a contract is unreadable. Names no path, directory or id. */
export type UnreadableCause = StoreCause | "index-without-store" | "vault-id-mismatch";

export interface UnexpectedControlFile {
  readonly path: string;
  readonly kind: "unexpected-control-file";
}

export interface ContractDoctor extends ContractStatus {
  readonly cause: UnreadableCause | null;
  /** Recovery is a full reseal; there is no automatic fallback. */
  readonly recovery: "oms setup" | null;
  readonly staleLocks: number;
  readonly orphans: number;
  /** Hook transport failures the guard wrapper recorded: counts per kind only. */
  readonly transportFailures: TransportFailures;
}

/** The person at the CLI sees the entries by name; an agent sees only how many there are. */
export type ContractDoctorReport =
  | ContractDoctor & { readonly audience: "human"; readonly unexpectedControlFiles: readonly UnexpectedControlFile[] }
  | ContractDoctor & { readonly audience: "agent"; readonly unexpectedControlFiles: number };

const VAULT_CONTROL_DIRECTORY = ".oms";
const VAULT_SETTINGS_FILE = "settings.json";

/** Entries of the vault control directory other than its settings, by the names read from disk. */
async function unexpectedControlFiles(vault: string): Promise<UnexpectedControlFile[]> {
  const directory = join(vault, VAULT_CONTROL_DIRECTORY);
  try {
    if (!(await lstat(directory)).isDirectory()) return [];
    return (await readdir(directory))
      .filter(name => name !== VAULT_SETTINGS_FILE)
      .sort(compareCodePoints)
      .map(name => ({ path: `${VAULT_CONTROL_DIRECTORY}/${name}`, kind: "unexpected-control-file" as const }));
  } catch {
    return [];
  }
}

export async function contractDoctor(vault: string, audience: "human", root?: string): Promise<ContractDoctorReport & { readonly audience: "human" }>;
export async function contractDoctor(vault: string, audience: "agent", root?: string): Promise<ContractDoctorReport & { readonly audience: "agent" }>;
export async function contractDoctor(vault: string, audience: "human" | "agent", root: string = storeRoot()): Promise<ContractDoctorReport> {
  const status = await contractStatus(vault, root);
  const state = await resolveSealState(vault, root);
  let cause: UnreadableCause | null = null;
  if (state.row === "index-without-store") cause = "index-without-store";
  else if (state.row === "vault-id-tampered") cause = "vault-id-mismatch";
  else if (status.contract === "unreadable" && state.vaultId !== null) {
    const diagnosis = await diagnoseStore(state.vaultId, root);
    if (diagnosis !== "ok" && diagnosis !== "absent") cause = diagnosis;
  }
  const housekeeping = state.vaultId === null ? { staleLocks: 0, orphans: 0 } : await storeHousekeeping(state.vaultId, root);
  const transportFailures = await readTransportFailures(root);
  const report: ContractDoctor = { ...status, cause, recovery: cause === null ? null : "oms setup", ...housekeeping, transportFailures };
  const unexpected = await unexpectedControlFiles(vault);
  return audience === "human"
    ? { ...report, audience, unexpectedControlFiles: unexpected }
    : { ...report, audience, unexpectedControlFiles: unexpected.length };
}

export type DoctorFixResult = "reindexed" | "nothing-to-fix" | "not-fixable";

/** Re-indexes rows 3, 4 and 8 when the vault's own id names an existing store. Nothing else is repaired. */
export async function doctorFix(vault: string, root: string = storeRoot()): Promise<DoctorFixResult> {
  const state = await resolveSealState(vault, root);
  if (state.row === "sealed" || state.row === "never-sealed") return "nothing-to-fix";
  if (state.row !== "store-without-index" && state.row !== "vault-moved" && state.row !== "index-corrupt") return "not-fixable";
  if (state.vaultId === null || !await storeExists(state.vaultId, root)) return "not-fixable";
  await writeIndexEntry(await realpath(vault), state.vaultId, root, { rebuildCorrupt: state.row === "index-corrupt" });
  return "reindexed";
}
