import { readFile } from "node:fs/promises";
import path from "node:path";
import { readSourceExclusions, type SourceExclusionInventory } from "../../conventions/note-exclude.js";
import type { RetrievalFields, TemplateRetrievalSource } from "../../templates/axes.js";
import { digestBytes, hashCanonical } from "../../templates/canonical.js";
import { composeContractV5, parseContractPolicyV5, ContractV5Error, type ContractPolicyV5 } from "../../templates/contract-v5.js";
import { taxonomyRouting, type TaxonomyRouting } from "../../templates/resolver.js";
import type { Digest } from "../../templates/types.js";

/**
 * Search-side read of the explicit V5 contract and the user taxonomy.
 *
 * Policy, taxonomy, and source exclusions are independent channels: an invalid
 * policy leaves ordinary notes searchable with the taxonomy still in force, and
 * unreadable taxonomy does not erase valid registrations. The reader admits no
 * vault, opens no projection, consults no publication marker, and writes
 * nothing. `null` metadata means unavailable, never an empty contract.
 */

const POLICY_FILE = ".oms/template-policy.json";
const TAXONOMY_FILE = ".oms/taxonomy.json";
const RETRIEVAL_DOMAIN = "oms.search-template-source.v5";

export interface RetrievalDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface SearchTemplateSource {
  readonly digest: Digest;
  readonly source: TemplateRetrievalSource;
  readonly exclusions: SourceExclusionInventory;
  readonly diagnostics: readonly RetrievalDiagnostic[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An absent control includes a `.oms` that is not a directory at all. */
function isAbsent(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readBytes(file: string): Promise<Uint8Array | null> {
  try {
    return Uint8Array.from(await readFile(file));
  } catch (error: unknown) {
    if (isAbsent(error)) return null;
    throw error;
  }
}

/**
 * Presence and content of each channel. Absent, empty, invalid, and unreadable
 * inputs stay distinguishable, and the exclusion inventory participates so a
 * changed settings root invalidates a cached graph.
 */
function retrievalDigest(
  policy: Uint8Array | null,
  taxonomy: Uint8Array | null,
  exclusions: SourceExclusionInventory,
): Digest {
  return hashCanonical(RETRIEVAL_DOMAIN, {
    policy: policy === null ? null : digestBytes(policy),
    taxonomy: taxonomy === null ? null : digestBytes(taxonomy),
    exclusions: exclusions.digest,
  });
}

function diagnostic(code: string, file: string, detail: string): RetrievalDiagnostic {
  return { code, path: file, message: detail };
}

function contractCode(error: unknown): string {
  return error instanceof ContractV5Error ? error.code : "TEMPLATE_POLICY_UNREADABLE";
}

/** Effective fields per registration. A review-required or uncomposable layer stays null. */
function composedFields(
  policy: ContractPolicyV5,
  diagnostics: RetrievalDiagnostic[],
): { readonly defaultFields: RetrievalFields | null; readonly templates: Readonly<Record<string, RetrievalFields | null>> } {
  let defaultFields: RetrievalFields | null = null;
  try {
    defaultFields = composeContractV5(policy, null).fields;
  } catch (error: unknown) {
    diagnostics.push(diagnostic(contractCode(error), POLICY_FILE, `common contract rules are unavailable: ${message(error)}`));
  }
  const templates: Record<string, RetrievalFields | null> = Object.create(null) as Record<string, RetrievalFields | null>;
  for (const templateId of Object.keys(policy.templates)) {
    try {
      templates[templateId] = composeContractV5(policy, templateId).fields;
    } catch (error: unknown) {
      templates[templateId] = null;
      diagnostics.push(diagnostic(contractCode(error), POLICY_FILE, `template ${templateId} rules are unavailable: ${message(error)}`));
    }
  }
  return { defaultFields, templates };
}

/** Registered original-source paths. They are exclusion facts, never contract authority. */
function registeredSourcePaths(policy: ContractPolicyV5): readonly string[] {
  const paths: string[] = [];
  for (const entry of Object.values(policy.templates)) {
    if (entry.status === "active") paths.push(entry.source.path);
  }
  return paths.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export async function readSearchTemplateSource(vault: string): Promise<SearchTemplateSource> {
  const policyBytes = await readBytes(path.join(vault, ".oms", "template-policy.json"));
  const taxonomyBytes = await readBytes(path.join(vault, ".oms", "taxonomy.json"));
  const exclusions = await readSourceExclusions(vault);
  const digest = retrievalDigest(policyBytes, taxonomyBytes, exclusions);
  const diagnostics: RetrievalDiagnostic[] = exclusions.diagnostics.map(item => diagnostic(item.code, item.path, item.message));

  let globalAxes: TemplateRetrievalSource["globalAxes"] = Object.create(null) as Record<string, never>;
  if (taxonomyBytes !== null) {
    let routing: TaxonomyRouting | null = null;
    try {
      routing = taxonomyRouting(TAXONOMY_FILE, taxonomyBytes);
    } catch (error: unknown) {
      diagnostics.push(diagnostic("TEMPLATE_TAXONOMY_UNREADABLE", TAXONOMY_FILE, `taxonomy axes are unavailable: ${message(error)}`));
    }
    globalAxes = routing === null ? null : routing.globalAxes;
  }

  if (policyBytes === null) {
    diagnostics.push(diagnostic("TEMPLATE_POLICY_ABSENT", POLICY_FILE, "no explicit contract is published; notes stay searchable without declared field axes"));
    return { digest, source: { generationDigest: digest, defaultFields: null, templates: null, globalAxes, sourcePaths: null }, exclusions, diagnostics };
  }

  let policy: ContractPolicyV5;
  try {
    policy = parseContractPolicyV5(decodeUtf8(policyBytes));
  } catch (error: unknown) {
    diagnostics.push(diagnostic(contractCode(error), POLICY_FILE, `declared contract is unavailable: ${message(error)}`));
    return { digest, source: { generationDigest: digest, defaultFields: null, templates: null, globalAxes, sourcePaths: null }, exclusions, diagnostics };
  }

  const composed = composedFields(policy, diagnostics);
  return {
    digest,
    source: {
      generationDigest: digest,
      defaultFields: composed.defaultFields,
      templates: composed.templates,
      globalAxes,
      sourcePaths: registeredSourcePaths(policy),
    },
    exclusions,
    diagnostics,
  };
}
