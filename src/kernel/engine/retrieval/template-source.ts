import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TemplateRetrievalSource } from "../../templates/axes.js";
import { digestBytes, hashCanonical } from "../../templates/canonical.js";
import { parseTemplatePolicy } from "../../templates/policy.js";
import {
  composeTemplateRetrievalSource,
  controlGenerationDigest,
  taxonomyRouting,
  type TaxonomyRouting,
} from "../../templates/resolver.js";
import type { Digest, TemplateFolderPath, TemplatePolicy } from "../../templates/types.js";

/**
 * Search-side read of policy and taxonomy bytes.
 * Missing or invalid policy, invalid taxonomy, and composition failure stay
 * unavailable. This reader does not admit a vault, open a projection, consult
 * a publication marker, or write.
 */

const POLICY_FILE = ".oms/template-policy.json";
const TAXONOMY_FILE = ".oms/taxonomy.json";
const ABSENT_DOMAIN = "oms.search-template-source.absent.v1";
const NO_PATHS = [] as const;

export type SearchTemplateSource =
  | {
      readonly available: true;
      readonly digest: Digest;
      readonly source: TemplateRetrievalSource;
      readonly managedSourcePaths: readonly string[];
    }
  | {
      readonly available: false;
      readonly digest: Digest;
      readonly reason: string;
      readonly managedSourcePaths: readonly [];
    };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function unavailable(digest: Digest, reason: string): SearchTemplateSource {
  return { available: false, digest, reason, managedSourcePaths: NO_PATHS };
}

function emptyRouting(): TaxonomyRouting {
  const targetFolders = new Map<string, TemplateFolderPath>();
  const globalAxes: TaxonomyRouting["globalAxes"] = Object.create(null);
  return { targetFolders, globalAxes };
}

/** Both control files use the P05 generation digest. A missing file stays null, so empty bytes are a different input. */
function presenceDigest(policy: Uint8Array | null, taxonomy: Uint8Array | null): Digest {
  if (policy !== null && taxonomy !== null) return controlGenerationDigest(policy, taxonomy);
  return hashCanonical(ABSENT_DOMAIN, {
    policy: policy === null ? null : digestBytes(policy),
    taxonomy: taxonomy === null ? null : digestBytes(taxonomy),
  });
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readBytes(file: string): Promise<Uint8Array | null> {
  try {
    return Uint8Array.from(await readFile(file));
  } catch (error: unknown) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function listedSourcePaths(source: TemplateRetrievalSource): readonly string[] {
  const paths: string[] = [];
  for (const templateId of Object.keys(source.templates)) {
    const sourcePath = source.policy.templates[templateId]?.source?.path;
    if (sourcePath !== undefined) paths.push(sourcePath);
  }
  return paths;
}

export async function readSearchTemplateSource(vault: string): Promise<SearchTemplateSource> {
  const policyBytes = await readBytes(path.join(vault, ".oms", "template-policy.json"));
  const taxonomyBytes = await readBytes(path.join(vault, ".oms", "taxonomy.json"));
  const digest = presenceDigest(policyBytes, taxonomyBytes);
  if (policyBytes === null) return unavailable(digest, `template policy missing (${POLICY_FILE})`);

  let policy: TemplatePolicy;
  try {
    policy = parseTemplatePolicy(decodeUtf8(policyBytes));
  } catch (error: unknown) {
    return unavailable(digest, `template policy invalid: ${message(error)}`);
  }

  let routing: TaxonomyRouting;
  if (taxonomyBytes === null) {
    routing = emptyRouting();
  } else {
    try {
      routing = taxonomyRouting(TAXONOMY_FILE, taxonomyBytes);
    } catch (error: unknown) {
      return unavailable(digest, `template taxonomy invalid: ${message(error)}`);
    }
  }

  try {
    const source = composeTemplateRetrievalSource(policy, routing, digest);
    return { available: true, digest, source, managedSourcePaths: listedSourcePaths(source) };
  } catch (error: unknown) {
    return unavailable(digest, `template composition failed: ${message(error)}`);
  }
}
