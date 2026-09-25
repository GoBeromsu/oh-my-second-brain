import { compareCodePoints, hashCanonical, type Digest } from "../../conventions/canonical.js";
import { readSourceExclusions, type SourceExclusionInventory } from "../../conventions/note-exclude.js";
import { deriveFolderOntologyAxis } from "../../contract/folders-axis.js";
import type { PropertyContract, VaultContract } from "../../contract/types.js";
import { resolveSealState } from "../../contract/vault-id.js";
import type { GlobalAxes, GlobalAxis, RetrievalFields, TemplateRetrievalSource } from "./axes.js";

/**
 * Search-side read of the sealed vault contract.
 *
 * Search sees only the acceptance surface: folder path and meaning, and
 * property name, type and required. No rule or value leaves the store through
 * this reader. It admits no vault, writes nothing and never reads a vault-side
 * control file other than settings.json. `null` metadata means unavailable,
 * never an empty contract.
 */

const CONTRACT_PATH = "folders.json";
const RETRIEVAL_DOMAIN = "oms.search-template-source.v6";

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

type ReadState =
  | { readonly state: "open" }
  | { readonly state: "unreadable"; readonly reason: string }
  | { readonly state: "sealed"; readonly contract: VaultContract };

/** A fixed reason by code: a raw filesystem message would carry a private store path. */
function failureReason(error: unknown): string {
  const code = (error as { readonly code?: unknown } | null)?.code;
  const named = typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "CONTRACT_READ_FAILED";
  return `${named}; run oms contract doctor`;
}

function isAbsent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function readState(vault: string): Promise<ReadState> {
  try {
    const view = (await resolveSealState(vault)).view;
    if (view.state === "sealed") return { state: "sealed", contract: view.contract };
    if (view.state === "unreadable") return { state: "unreadable", reason: "the sealed contract is unreadable; run oms contract doctor" };
    return { state: "open" };
  } catch (error: unknown) {
    return isAbsent(error) ? { state: "open" } : { state: "unreadable", reason: failureReason(error) };
  }
}

function sortedEntries<T>(record: Readonly<Record<string, T>>): Array<[string, T]> {
  return Object.entries(record).sort(([left], [right]) => compareCodePoints(left, right));
}

/** The only contract facts search may carry. Rules and templates' narrowed rules never enter. */
function publicProjection(contract: VaultContract): unknown {
  return {
    folders: contract.folders === null
      ? null
      : sortedEntries(contract.folders).map(([path, folder]) => ({ path, meaning: folder.meaning, searchExclude: folder.searchExclude })),
    properties: contract.properties === null
      ? null
      : sortedEntries(contract.properties).map(([name, property]) => ({ name, type: property.type, required: property.required })),
    templates: sortedEntries(contract.templates).map(([name, template]) => ({
      name,
      source: template.source,
      requiredProperties: [...template.requiredProperties].sort(compareCodePoints),
    })),
  };
}

function fields(
  properties: Readonly<Record<string, PropertyContract>>,
  forcedRequired: readonly string[],
): RetrievalFields {
  const out: Record<string, RetrievalFields[string]> = Object.create(null) as Record<string, RetrievalFields[string]>;
  for (const [name, property] of sortedEntries(properties)) {
    out[name] = {
      property: name,
      type: property.type,
      required: property.required || forcedRequired.includes(name),
      valuePolicy: "free",
    };
  }
  return out;
}

function globalAxes(contract: VaultContract): GlobalAxes {
  const axes: Record<string, GlobalAxis> = Object.create(null) as Record<string, GlobalAxis>;
  const axis = deriveFolderOntologyAxis(contract.folders);
  if (axis !== null) axes["folder-ontology"] = axis;
  return axes;
}

export async function readSearchTemplateSource(vault: string): Promise<SearchTemplateSource> {
  const [state, exclusions] = await Promise.all([readState(vault), readSourceExclusions(vault)]);
  const diagnostics: RetrievalDiagnostic[] = exclusions.diagnostics.map(item => ({ code: item.code, path: item.path, message: item.message }));
  const digest = hashCanonical(RETRIEVAL_DOMAIN, {
    state: state.state,
    contract: state.state === "sealed" ? publicProjection(state.contract) : null,
    exclusions: exclusions.digest,
  });

  if (state.state === "open") {
    diagnostics.push({ code: "CONTRACT_OPEN", path: CONTRACT_PATH, message: "no contract is sealed; notes stay searchable without declared field axes" });
    return {
      digest,
      source: { generationDigest: digest, defaultFields: null, templates: null, globalAxes: Object.create(null) as GlobalAxes, sourcePaths: null },
      exclusions,
      diagnostics,
    };
  }
  if (state.state === "unreadable") {
    diagnostics.push({ code: "CONTRACT_UNREADABLE", path: CONTRACT_PATH, message: `sealed contract is unavailable: ${state.reason}` });
    return {
      digest,
      source: { generationDigest: digest, defaultFields: null, templates: null, globalAxes: null, sourcePaths: null },
      exclusions,
      diagnostics,
    };
  }

  const { contract } = state;
  const templates: Record<string, RetrievalFields | null> = Object.create(null) as Record<string, RetrievalFields | null>;
  for (const [name, template] of sortedEntries(contract.templates)) {
    templates[name] = contract.properties === null ? null : fields(contract.properties, template.requiredProperties);
  }
  return {
    digest,
    source: {
      generationDigest: digest,
      defaultFields: contract.properties === null ? null : fields(contract.properties, []),
      templates,
      globalAxes: globalAxes(contract),
      sourcePaths: Object.values(contract.templates).map(template => template.source).sort(compareCodePoints),
    },
    exclusions,
    diagnostics,
  };
}
