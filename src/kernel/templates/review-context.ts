import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseObsidianTypes } from "../contracts/index.js";
import { templateCensus, type CensusPriorEntry, type CensusResult } from "./census.js";
import {
  deriveManagedTemplateProjection,
  projectionHeaderMatches,
  resolveClassifiedTemplateSource,
  taxonomyRouting,
  validatedProjectionPriorEntries,
  type ResolvedClassifiedTemplateSource,
} from "./resolver.js";
import { parseDerivedProjection, parseTemplatePolicy } from "./policy.js";
import { deriveTemplateSourcePath } from "./paths.js";
import type {
  DerivedProjection,
  Digest,
  FileExpectation,
  ObsidianContractType,
  SourceDescriptor,
  TemplateId,
  TemplatePolicy,
} from "./types.js";

export interface TemplateReviewContext {
  readonly vault: string;
  readonly policy: TemplatePolicy;
  readonly census: CensusResult;
  readonly obsidianTypes: Readonly<Record<string, ObsidianContractType>>;
  readonly censusDigest: Digest;
  readonly projectionUsable: boolean;
  readonly freshTemplateIds: readonly TemplateId[];
}

export type TemplateReviewAuthorityPath =
  | ".oms/template-policy.json"
  | ".oms/taxonomy.json"
  | ".oms/types.json"
  | ".obsidian/types.json";

export interface TemplateReviewSnapshot extends TemplateReviewContext {
  readonly authorityStates: Readonly<Record<TemplateReviewAuthorityPath, FileExpectation>>;
}

interface RawState {
  readonly signature: Digest | null;
  readonly bytes: Uint8Array | null;
}

function digest(value: Uint8Array | string): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function expectation(state: RawState): FileExpectation {
  return state.signature === null ? { state: "absent" } : { state: "present", signature: state.signature };
}

async function readState(root: string, relativePath: string, required: boolean): Promise<RawState> {
  try {
    const bytes = new Uint8Array(await readFile(join(root, relativePath)));
    return { bytes, signature: digest(bytes) };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT" && !required) {
      return { bytes: null, signature: null };
    }
    if (error instanceof Error && "code" in error) {
      throw new Error(`TEMPLATE_SOURCE_INVALID: ${relativePath} cannot be read: ${String(error.code)}`);
    }
    throw error;
  }
}

function authorityDescriptors(policy: RawState, taxonomy: RawState, obsidian: RawState): SourceDescriptor[] {
  if (policy.signature === null || taxonomy.signature === null || obsidian.signature === null) {
    throw new Error("TEMPLATE_SOURCE_INVALID: shared template authorities are incomplete");
  }
  return [
    { logicalId: "template-policy", signature: policy.signature },
    { logicalId: "taxonomy", signature: taxonomy.signature },
    { logicalId: "obsidian-types", signature: obsidian.signature },
  ];
}

function sourceByPath(projection: DerivedProjection): ReadonlyMap<string, Digest> {
  return new Map(projection.generatedFrom.sources.flatMap(source => source.path === undefined ? [] : [[source.path, source.signature] as const]));
}

function approvedPolicyPriorEntries(policy: TemplatePolicy): readonly CensusPriorEntry[] {
  return Object.values(policy.templates).flatMap(binding => {
    if (binding.approvedSourceSignature === undefined) return [];
    const bodySignature = binding.approvedBodySignature ?? binding.content?.bodySignature;
    return [{
      sourcePath: deriveTemplateSourcePath(binding),
      templateId: binding.templateId,
      signature: binding.approvedSourceSignature,
      signatureVerified: true,
      ...(bodySignature === undefined ? {} : { bodySignature }),
    }];
  });
}

function sourceIsFresh(
  census: CensusResult,
  path: string,
  signature: Digest | undefined,
): boolean {
  const entry = census.entries.find(item => item.sourcePath === path);
  if (entry === undefined || entry.diagnostics.length > 0 || signature !== entry.signature) return false;
  return !census.diffs.some(diff => diff.sourcePath === path && diff.kind !== "added");
}

function reviewDigest(
  census: Digest,
  policy: RawState,
  taxonomy: RawState,
  obsidian: RawState,
  projection: RawState,
): Digest {
  const preimage = JSON.stringify({
    version: 1,
    census,
    authorities: [
      [".oms/template-policy.json", policy.signature],
      [".oms/taxonomy.json", taxonomy.signature],
      [".obsidian/types.json", obsidian.signature],
      [".oms/types.json", projection.signature],
    ],
  });
  return digest(preimage);
}

async function projectionState(
  policy: TemplatePolicy,
  taxonomy: ReturnType<typeof taxonomyRouting>,
  controls: readonly SourceDescriptor[],
  census: CensusResult,
  raw: RawState,
  obsidianTypes: Readonly<Record<string, ObsidianContractType>>,
): Promise<{ readonly usable: boolean; readonly freshTemplateIds: readonly TemplateId[]; }> {
  if (raw.bytes === null) return { usable: false, freshTemplateIds: [] };
  let projection: DerivedProjection;
  try {
    projection = parseDerivedProjection(Buffer.from(raw.bytes).toString("utf8"));
  } catch {
    return { usable: false, freshTemplateIds: [] };
  }
  try {
    if (!projectionHeaderMatches(projection, controls)) return { usable: false, freshTemplateIds: [] };
    const prior = validatedProjectionPriorEntries(policy, projection);
    const projectedByPath = sourceByPath(projection);
    const fresh: TemplateId[] = [];
    const expectedTemplates: Record<string, DerivedProjection["managed"]["templates"][string]> = {};
    for (const binding of Object.values(policy.templates).sort((left, right) => left.templateId.localeCompare(right.templateId))) {
      const path = deriveTemplateSourcePath(binding);
      if (!sourceIsFresh(census, path, projectedByPath.get(path))) continue;
      const entry = census.entries.find(item => item.sourcePath === path);
      if (entry === undefined) continue;
      if (binding.approvedSourceSignature !== undefined && entry.signature !== binding.approvedSourceSignature) continue;
      let source: ResolvedClassifiedTemplateSource;
      try {
        source = resolveClassifiedTemplateSource(path, entry.bytes, binding.renderer);
        const expected = deriveManagedTemplateProjection(policy, binding, source, obsidianTypes, taxonomy.targetFolders.get(binding.templateId));
        if (expected.content.bodySignature !== expected.bodySignature) continue;
        expectedTemplates[binding.templateId] = expected;
        fresh.push(binding.templateId);
      } catch {
        continue;
      }
    }
    const stored = {
      base: projection.managed.base,
      globalAxes: projection.managed.globalAxes,
      templates: Object.fromEntries(fresh.flatMap(id => {
        const template = projection.managed.templates[id];
        return template === undefined ? [] : [[id, template] as const];
      })),
    };
    const expected = {
      base: policy.base,
      globalAxes: taxonomy.globalAxes,
      templates: expectedTemplates,
    };
    if (!isDeepStrictEqual(expected, stored)) return { usable: false, freshTemplateIds: [] };
    // Keep the validated prior computation explicit: identity is never sourced from managed payload values.
    void prior;
    return { usable: true, freshTemplateIds: fresh.sort((left, right) => left.localeCompare(right)) };
  } catch {
    return { usable: false, freshTemplateIds: [] };
  }
}

/**
 * Builds the read-only review/bootstrap snapshot without loading the active
 * resolved convention. Invalid or absent derived projection bytes simply mean
 * that no projection-backed prior census is available; current policy
 * authorities and selected-folder bytes still produce a review context.
 */
export async function readTemplateReviewContext(vault: string): Promise<TemplateReviewSnapshot> {
  const root = await realpath(vault);
  const policyRaw = await readState(root, ".oms/template-policy.json", true);
  const taxonomyRaw = await readState(root, ".oms/taxonomy.json", true);
  const obsidianRaw = await readState(root, ".obsidian/types.json", true);
  const projectionRaw = await readState(root, ".oms/types.json", false);
  if (policyRaw.bytes === null || taxonomyRaw.bytes === null || obsidianRaw.bytes === null) {
    throw new Error("TEMPLATE_SOURCE_INVALID: review authorities are incomplete");
  }
  const policy = parseTemplatePolicy(Buffer.from(policyRaw.bytes).toString("utf8"));
  const taxonomy = taxonomyRouting(".oms/taxonomy.json", taxonomyRaw.bytes);
  const obsidian = parseObsidianTypes(obsidianRaw.bytes, join(root, ".obsidian/types.json"));
  const controls = authorityDescriptors(policyRaw, taxonomyRaw, obsidianRaw);
  let projection: DerivedProjection | undefined;
  if (projectionRaw.bytes !== null) {
    try { projection = parseDerivedProjection(Buffer.from(projectionRaw.bytes).toString("utf8")); } catch { projection = undefined; }
  }
  let prior: readonly CensusPriorEntry[] = [];
  if (projection !== undefined) {
    try {
      if (projectionHeaderMatches(projection, controls)) {
        prior = validatedProjectionPriorEntries(policy, projection);
      }
    } catch {
      prior = [];
    }
  }
  const priorByPath = new Map(prior.map(value => [value.sourcePath, value]));
  for (const value of approvedPolicyPriorEntries(policy)) priorByPath.set(value.sourcePath, value);
  prior = [...priorByPath.values()];
  const census = await templateCensus(root, policy, prior);
  const validated = await projectionState(policy, taxonomy, controls, census, projectionRaw, obsidian.types);
  const authorityStates: Readonly<Record<TemplateReviewAuthorityPath, FileExpectation>> = {
    ".oms/template-policy.json": expectation(policyRaw),
    ".oms/taxonomy.json": expectation(taxonomyRaw),
    ".oms/types.json": expectation(projectionRaw),
    ".obsidian/types.json": expectation(obsidianRaw),
  };
  return {
    vault: root,
    policy,
    census,
    obsidianTypes: obsidian.types,
    censusDigest: reviewDigest(census.digest, policyRaw, taxonomyRaw, obsidianRaw, projectionRaw),
    projectionUsable: validated.usable,
    freshTemplateIds: validated.freshTemplateIds,
    authorityStates,
  };
}
