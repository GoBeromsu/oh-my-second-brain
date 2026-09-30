import { lstat, readdir, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { compareCodePoints } from "../conventions/canonical.js";
import { legacyTemplatesOf } from "./legacy.js";
import { readTransportFailures, type TransportFailures } from "./guard-events.js";
import { pendingLogKey, readInterviewLog } from "./interview-log.js";
import { lineageHealth, type LineageHealth } from "./lineage-health.js";
import { unsafePatternChanges, type LooseningChange } from "./loosening.js";
import { diagnoseStore, readStore, storeExists, storeHousekeeping, storeRoot, writeIndexEntry, type StoreCause } from "./store.js";
import { resolveSealState, type SealRow } from "./vault-id.js";
import { readVaultSettings } from "../vault/settings.js";
import type { Guidance } from "./types.js";

/**
 * Contract posture for `oms setup status` and `doctor`. Read-only except `doctorFix`,
 * which only re-indexes. Output never carries a vault id, a store path or a rule value.
 */

export interface DoctorFinding {
  readonly message: string;
  readonly guidance: Guidance | null;
}

export interface ContractStatus {
  readonly contract: "none" | "sealed" | "unreadable";
  /** Present when the contract is unreadable: `tampered` refuses writes, `broken` lets them through with a warning. */
  readonly reason?: "tampered" | "broken";
  readonly row: SealRow;
  readonly findings: readonly DoctorFinding[];
  /**
   * Templates an old (version 1 or 2) generation sealed. Their required properties,
   * narrowed rules and headings are no longer enforced; a reseal writes a generation
   * without them. Zero for a version 3 head or an unsealed vault.
   */
  readonly legacyTemplates: number;
}

/** Fixed doctor wording per truth-table row. */
export const ROW_FINDING: Readonly<Record<SealRow, DoctorFinding>> = {
  "never-sealed": { message: "contract: none", guidance: "oms interview" },
  "synced-second-machine": { message: "vaultId present, no local store", guidance: "oms interview" },
  "store-without-index": { message: "index entry missing", guidance: "oms doctor contract --fix" },
  "vault-moved": { message: "vault moved", guidance: "oms doctor contract --fix" },
  "sealed": { message: "contract: sealed", guidance: null },
  "index-without-store": { message: "contract store missing", guidance: "oms interview" },
  "settings-missing": { message: "vault settings missing", guidance: "oms interview" },
  "vault-id-tampered": { message: "vault id mismatch", guidance: "oms doctor contract" },
  "index-corrupt": { message: "index unreadable", guidance: "oms doctor contract --fix" },
};

export const SHARED_FINDING: DoctorFinding = { message: "vault id shared", guidance: "oms doctor contract" };
export const SETTINGS_INVALID_FINDING: DoctorFinding = { message: "vault settings unreadable", guidance: "oms doctor contract" };
export const STORE_UNREADABLE_FINDING: DoctorFinding = { message: "contract store unreadable", guidance: "oms setup" };

/** The sealed generation carries template constraints the judge no longer enforces; the count is the only detail. */
export function legacyTemplateFinding(count: number): DoctorFinding {
  return { message: `legacy-template-constraints-ignored: ${count}`, guidance: "oms setup" };
}

/**
 * A legacy generation sealed templates, but the vault settings name no `templateFolder`, so
 * those templates neither scaffold new notes nor stay out of the audit. Only a suggestion:
 * the folder is named when every sealed template shares it, and nothing is written.
 */
export function templateFolderUnsetFinding(sources: readonly string[]): DoctorFinding {
  const folders = new Set(sources.map(source => posix.dirname(source)));
  const [folder] = folders;
  const value = folders.size === 1 && folder !== undefined && folder !== "." ? `"${folder}"` : "your template folder";
  return { message: `template-folder-unset: set "templateFolder" to ${value} in .oms/settings.json so templates scaffold new notes`, guidance: null };
}

async function templateFolderUnset(vault: string): Promise<boolean> {
  try {
    return (await readVaultSettings(vault))?.templateFolder === undefined;
  } catch {
    // Unreadable settings are reported on their own; no suggestion is made on top of them.
    return false;
  }
}

export async function contractStatus(vault: string, root: string = storeRoot()): Promise<ContractStatus> {
  const state = await resolveSealState(vault, root);
  const findings: DoctorFinding[] = [ROW_FINDING[state.row]];
  if (state.settingsInvalid) findings.push(SETTINGS_INVALID_FINDING);
  if (state.shared) findings.push(SHARED_FINDING);
  if (state.view.state !== "sealed") {
    const loadedRow = state.row !== "index-without-store" && state.row !== "vault-id-tampered" && state.row !== "settings-missing";
    if (state.view.state === "unreadable" && loadedRow) findings.push(STORE_UNREADABLE_FINDING);
    return state.view.state === "unreadable"
      ? { contract: "unreadable", reason: state.view.reason, row: state.row, findings, legacyTemplates: 0 }
      : { contract: "none", row: state.row, findings, legacyTemplates: 0 };
  }
  const legacy = Object.values(legacyTemplatesOf(state.view));
  const legacyTemplates = legacy.length;
  if (legacyTemplates > 0) findings.push(legacyTemplateFinding(legacyTemplates));
  if (legacyTemplates > 0 && await templateFolderUnset(vault)) findings.push(templateFolderUnsetFinding(legacy.map(template => template.source)));
  return { contract: "sealed", row: state.row, findings, legacyTemplates };
}

/** Why a contract is unreadable. Names no path, directory or id. */
export type UnreadableCause = StoreCause | "index-without-store" | "settings-missing" | "vault-id-mismatch";

export interface UnexpectedControlFile {
  readonly path: string;
  readonly kind: "unexpected-control-file";
}

export interface ContractDoctor extends ContractStatus {
  readonly cause: UnreadableCause | null;
  /** Recovery is a full reseal; there is no automatic fallback. */
  readonly recovery: "oms setup" | null;
  /** Sealed pattern rules today's seal screen refuses, by field and kind only; only a terminal reseal replaces them. */
  readonly unsafePatterns: readonly LooseningChange[];
  readonly staleLocks: number;
  readonly orphans: number;
  /** Hook transport failures the guard wrapper recorded: counts per kind only. */
  readonly transportFailures: TransportFailures;
  readonly interviewLog: InterviewLogHealth;
  /** The lineage and kept snapshots, read-only; null when the vault has no id yet. */
  readonly lineage: LineageHealth | null;
}

/**
 * The interview log, diagnosed only: lines that did not parse are skipped when the log is
 * read and are never repaired here. `pendingCorrupt` is the log kept before the first
 * seal; `unreadable` is a state directory the log may not be read from (unsafe, say).
 */
export interface InterviewLogHealth {
  readonly corrupt: readonly number[];
  readonly pendingCorrupt: readonly number[];
  readonly unreadable: boolean;
}

async function interviewLogHealth(vault: string, vaultId: string | null, root: string): Promise<InterviewLogHealth> {
  try {
    const pending = await readInterviewLog(root, await pendingLogKey(vault));
    const own = vaultId === null ? { corrupt: [] } : await readInterviewLog(root, vaultId);
    return { corrupt: own.corrupt, pendingCorrupt: pending.corrupt, unreadable: false };
  } catch {
    return { corrupt: [], pendingCorrupt: [], unreadable: true };
  }
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
  else if (state.row === "settings-missing") cause = "settings-missing";
  else if (state.row === "vault-id-tampered") cause = "vault-id-mismatch";
  else if (status.contract === "unreadable" && state.vaultId !== null) {
    const diagnosis = await diagnoseStore(state.vaultId, root);
    if (diagnosis !== "ok" && diagnosis !== "absent") cause = diagnosis;
  }
  const housekeeping = state.vaultId === null ? { staleLocks: 0, orphans: 0 } : await storeHousekeeping(state.vaultId, root);
  const transportFailures = await readTransportFailures(root);
  const read = status.contract === "sealed" && state.vaultId !== null ? await readStore(state.vaultId, root) : null;
  const unsafePatterns = read?.state === "ok" ? unsafePatternChanges(read.contract) : [];
  const recovery = cause === null && unsafePatterns.length === 0 ? null : "oms setup";
  const interviewLog = await interviewLogHealth(vault, state.vaultId, root);
  const lineage = state.vaultId === null ? null : await lineageHealth(state.vaultId, root);
  const report: ContractDoctor = { ...status, cause, recovery, unsafePatterns, ...housekeeping, transportFailures, interviewLog, lineage };
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
