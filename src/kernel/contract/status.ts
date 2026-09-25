import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { templateDrift } from "./drift.js";
import { EMPTY_PUBLIC_MANIFEST, readPublicManifest } from "./public.js";
import { loadLayers, readStoreMeta } from "./store.js";
import { readVaultId } from "./vault-id.js";

/**
 * Contract posture for status and doctor. Strictly read-only: it never creates the
 * store, `.oms/vault-id` or the manifest, and never records the location it sees.
 */

export type ContractLocation = "same" | "moved" | "clone-suspect" | "unknown";

export interface ContractTemplateStatus {
  readonly id: string;
  readonly name: string;
  readonly state: "active" | "drift" | "missing" | "unreadable";
}

export interface ContractStatus {
  readonly vault: "no-contract" | "ok" | "unreadable";
  readonly location: ContractLocation;
  readonly templates: readonly ContractTemplateStatus[];
  readonly common: "none" | "active" | "unreadable";
  readonly legacyPolicyPresent: boolean;
}

const LEGACY_POLICY_PATH = ".oms/template-policy.json";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function locate(vault: string, vaultId: string, lastSeen: string | null): Promise<ContractLocation> {
  if (lastSeen === null) return "unknown";
  let current: string;
  try {
    current = await realpath(vault);
  } catch {
    return "unknown";
  }
  if (current === lastSeen) return "same";
  const other = await readVaultId(lastSeen);
  return other.state === "ok" && other.id === vaultId ? "clone-suspect" : "moved";
}

export async function contractStatus(vault: string): Promise<ContractStatus> {
  const legacyPolicyPresent = await exists(join(vault, LEGACY_POLICY_PATH));
  const [manifest, vaultId] = await Promise.all([readPublicManifest(vault), readVaultId(vault)]);
  if (manifest.state === "absent" && vaultId.state === "absent") {
    return { vault: "no-contract", location: "unknown", templates: [], common: "none", legacyPolicyPresent };
  }
  if (manifest.state === "invalid") {
    return { vault: "unreadable", location: "unknown", templates: [], common: "unreadable", legacyPolicyPresent };
  }
  const known = manifest.state === "ok" ? manifest.manifest : EMPTY_PUBLIC_MANIFEST;
  if (vaultId.state !== "ok") {
    return {
      vault: "unreadable",
      location: "unknown",
      templates: known.templates.map(template => ({ id: template.id, name: template.name, state: "unreadable" })),
      common: known.common === null ? "none" : "unreadable",
      legacyPolicyPresent,
    };
  }
  const [loaded, meta] = await Promise.all([loadLayers(vaultId.id, known), readStoreMeta(vaultId.id)]);
  const location = meta.state === "ok" ? await locate(vault, vaultId.id, meta.meta.lastSeenRealpath) : "unknown";
  const templates: ContractTemplateStatus[] = [];
  for (const template of known.templates) {
    const load = loaded.templates.get(template.id);
    const state = load?.state === "ok" ? await templateDrift(vault, template) : "unreadable";
    templates.push({ id: template.id, name: template.name, state });
  }
  const common = loaded.common === null ? "none" : loaded.common.state === "ok" ? "active" : "unreadable";
  const unreadable = loaded.orphaned || meta.state === "invalid" || common === "unreadable" || templates.some(template => template.state === "unreadable");
  const vaultState = unreadable ? "unreadable" : manifest.state === "absent" ? "no-contract" : "ok";
  return { vault: vaultState, location, templates, common, legacyPolicyPresent };
}
