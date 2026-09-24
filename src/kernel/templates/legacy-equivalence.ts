import { digestBytes } from "./canonical.js";
import { parseContractPolicyV5, serializeContractPolicyV5, type ContractPolicyV5 } from "./contract-v5.js";
import { decodeLegacyPolicy, type LegacyPolicyDecoding } from "./legacy-policy-decoder.js";
import { verifiedLegacySource, verifyLegacyPublicationEvidence, type LegacyPublicationVerification } from "./legacy-publication-evidence.js";
import type { Digest } from "./types.js";

/**
 * Raw-archive ownership and in-process replay for one fresh verifier→decoder run.
 * A proof is consistency evidence only. It is not publication, migration, activation,
 * owner review, or human authorization.
 *
 * Recovery after process restart cannot deserialize either brand. The caller rebuilds
 * the raw archive, runs executeLegacyDecoderEquivalence again for a fresh capability,
 * and compares that result's material and canonical candidate with a separately
 * validated sealed publisher plan. replayLegacyDecoderEquivalence only revalidates a
 * proof and archive that still exist in this process.
 */

export const LEGACY_EQUIVALENCE_POLICY_PATH = ".oms/template-policy.json" as const;
/** Fixed decoder contract bound into material. Not caller configuration or publisher authority. */
export const LEGACY_DECODER_EXECUTION_VERSION = "oms.legacy-decoder-execution.v1" as const;
/**
 * Independent raw-proof capacity. A proved archive at this bound is consistency
 * evidence only and is not a claim that the sealed publisher plan can store it.
 * Publication eligibility is a separate exact serialized-plan admission.
 */
const ARCHIVE_BYTE_LIMIT = 8 * 1024 * 1024;
const OBSERVATION_LIMIT = 256;
const FIXED_CONTROL_COUNT = 3;
const PATH_LIMIT = 240;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface LegacyEquivalenceArchiveInput {
  readonly format: "v3" | "v4";
  readonly markerPath: string;
  readonly markerBytes: Uint8Array;
  readonly planPath: string;
  readonly planBytes: Uint8Array;
  readonly policyPath: ".oms/template-policy.json";
  readonly policyBytes: Uint8Array;
  readonly observedOutputs: ReadonlyMap<string, Uint8Array>;
}

declare const legacyEquivalenceArchiveBrand: unique symbol;
export interface LegacyEquivalenceArchive {
  readonly [legacyEquivalenceArchiveBrand]: never;
}

export interface LegacyEquivalenceMaterial {
  readonly format: "v3" | "v4";
  readonly marker: Readonly<{ path: string; digest: Digest }>;
  readonly plan: Readonly<{ path: string; digest: Digest }>;
  readonly policy: Readonly<{ path: ".oms/template-policy.json"; digest: Digest }>;
  readonly observedOutputs: readonly Readonly<{ path: string; digest: Digest }>[];
  readonly archiveDigest: Digest;
  readonly decoderExecutionVersion: typeof LEGACY_DECODER_EXECUTION_VERSION;
}

export interface LegacyEquivalenceCandidate {
  readonly sourceVersion: 3 | 4 | null;
  readonly policy: ContractPolicyV5;
  readonly canonicalPolicy: string;
  readonly candidateDigest: Digest;
}

export interface LegacyEquivalenceHistoricalSource {
  readonly templateId: string;
  readonly identity: string;
  readonly path: string;
  readonly rawDigest: Digest;
  readonly historicalBytes: Uint8Array;
}

export interface LegacyEquivalenceProposal {
  readonly material: LegacyEquivalenceMaterial;
  readonly candidate: LegacyEquivalenceCandidate;
  readonly decoding: LegacyPolicyDecoding;
  readonly availableHistoricalSources: readonly LegacyEquivalenceHistoricalSource[];
  readonly unavailableHistoricalSources: readonly Readonly<{ templateId: string; reason: string }>[];
}

declare const legacyEquivalenceProofBrand: unique symbol;
export interface LegacyEquivalenceProof {
  readonly [legacyEquivalenceProofBrand]: never;
}

export type LegacyEquivalenceExecution =
  | { readonly disposition: "proved"; readonly proof: LegacyEquivalenceProof; readonly proposal: LegacyEquivalenceProposal }
  | { readonly disposition: "proposed"; readonly proposal: LegacyEquivalenceProposal; readonly reasons: readonly string[] }
  | { readonly disposition: "invalid" | "unavailable"; readonly material: LegacyEquivalenceMaterial; readonly reasons: readonly string[]; readonly proposal?: LegacyEquivalenceProposal };

export type LegacyEquivalenceRecovery =
  | { readonly disposition: "recovered"; readonly material: LegacyEquivalenceMaterial; readonly candidate: LegacyEquivalenceCandidate; readonly availableHistoricalSources: readonly LegacyEquivalenceHistoricalSource[] }
  | { readonly disposition: "rejected"; readonly reasons: readonly string[] };

interface OwnedArchive {
  readonly format: "v3" | "v4";
  readonly markerPath: string;
  readonly markerBytes: Uint8Array;
  readonly planPath: string;
  readonly planBytes: Uint8Array;
  readonly policyBytes: Uint8Array;
  readonly observedOutputs: ReadonlyMap<string, Uint8Array>;
  readonly material: LegacyEquivalenceMaterial;
}

interface ProofRecord {
  readonly archiveDigest: Digest;
  readonly canonicalPolicy: string;
  readonly material: LegacyEquivalenceMaterial;
}

const archives = new WeakMap<LegacyEquivalenceArchive, OwnedArchive>();
const proofs = new WeakMap<LegacyEquivalenceProof, ProofRecord>();

function cloneBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/** Exact raw path scalar. Valid paired surrogates stay; NFC and separators are never rewritten. */
function rawPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > PATH_LIMIT) return null;
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return null;
  const encoded = encoder.encode(value);
  try {
    if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded) !== value) return null;
  } catch {
    return null;
  }
  const segments = value.split("/");
  if (segments.some(segment => segment.length === 0 || segment === "." || segment === "..")) return null;
  return value;
}

function codePointCompare(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0)!);
  const b = Array.from(right, character => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/**
 * Fixed-order descriptor of exact paths and byte digests. Native JSON.stringify
 * preserves those strings; it does not NFC-normalize them.
 */
function descriptor(material: Omit<LegacyEquivalenceMaterial, "archiveDigest" | "decoderExecutionVersion">): string {
  return JSON.stringify({
    format: material.format,
    marker: { path: material.marker.path, digest: material.marker.digest },
    plan: { path: material.plan.path, digest: material.plan.digest },
    policy: { path: material.policy.path, digest: material.policy.digest },
    observedOutputs: material.observedOutputs.map(output => ({ path: output.path, digest: output.digest })),
    decoderExecutionVersion: LEGACY_DECODER_EXECUTION_VERSION,
  });
}

function archiveDigest(material: Omit<LegacyEquivalenceMaterial, "archiveDigest" | "decoderExecutionVersion">): Digest {
  return digestBytes(`oms.legacy-equivalence.archive.v1\0${descriptor(material)}`);
}

function component(path: string, bytes: Uint8Array): { readonly path: string; readonly digest: Digest } {
  return { path, digest: digestBytes(bytes) };
}

function ownedMaterial(owned: Omit<OwnedArchive, "material">): LegacyEquivalenceMaterial {
  const observedOutputs = [...owned.observedOutputs]
    .map(([path, bytes]) => component(path, bytes))
    .sort((left, right) => codePointCompare(left.path, right.path) || codePointCompare(left.digest, right.digest));
  const descriptive = {
    format: owned.format,
    marker: component(owned.markerPath, owned.markerBytes),
    plan: component(owned.planPath, owned.planBytes),
    policy: { path: LEGACY_EQUIVALENCE_POLICY_PATH, digest: digestBytes(owned.policyBytes) },
    observedOutputs,
    decoderExecutionVersion: LEGACY_DECODER_EXECUTION_VERSION,
  };
  return { ...descriptive, archiveDigest: archiveDigest(descriptive) };
}

function cloneMaterial(material: LegacyEquivalenceMaterial): LegacyEquivalenceMaterial {
  return {
    format: material.format,
    marker: { path: material.marker.path, digest: material.marker.digest },
    plan: { path: material.plan.path, digest: material.plan.digest },
    policy: { path: material.policy.path, digest: material.policy.digest },
    observedOutputs: material.observedOutputs.map(output => ({ path: output.path, digest: output.digest })),
    archiveDigest: material.archiveDigest,
    decoderExecutionVersion: material.decoderExecutionVersion,
  };
}

function sameMaterial(left: LegacyEquivalenceMaterial, right: LegacyEquivalenceMaterial): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Fatal UTF-8 whose default re-encoding preserves every archived byte, including a BOM. */
function exactText(bytes: Uint8Array): string | null {
  let text: string;
  try { text = decoder.decode(bytes); } catch { return null; }
  const encoded = encoder.encode(text);
  return sameBytes(encoded, bytes) ? text : null;
}

function cloneDecoding(decoding: LegacyPolicyDecoding): LegacyPolicyDecoding {
  return {
    sourceVersion: decoding.sourceVersion,
    policy: parseContractPolicyV5(serializeContractPolicyV5(decoding.policy)),
    archive: { bytes: cloneBytes(decoding.archive.bytes), digest: decoding.archive.digest },
    inventory: decoding.inventory.map(entry => ({ path: entry.path, disposition: entry.disposition, reason: entry.reason })),
    reasons: [...decoding.reasons],
    selectionBlocked: decoding.selectionBlocked,
    automaticMigrationBlocked: decoding.automaticMigrationBlocked,
  };
}

function candidateFor(decoding: LegacyPolicyDecoding): LegacyEquivalenceCandidate {
  const canonicalPolicy = serializeContractPolicyV5(decoding.policy);
  return {
    sourceVersion: decoding.sourceVersion,
    policy: parseContractPolicyV5(canonicalPolicy),
    canonicalPolicy,
    candidateDigest: digestBytes(`oms.legacy-equivalence.candidate.v1\0${canonicalPolicy}`),
  };
}

function policyTemplateIds(policyBytes: Uint8Array): readonly string[] {
  let policy: unknown;
  try { policy = JSON.parse(decoder.decode(policyBytes)); } catch { return []; }
  const templates = policy !== null && typeof policy === "object" && !Array.isArray(policy)
    ? (policy as { templates?: unknown }).templates
    : undefined;
  if (templates === null || typeof templates !== "object" || Array.isArray(templates)) return [];
  return Object.keys(templates).sort(codePointCompare);
}

/**
 * Availability is only the verifier capability's policy-bound snapshot. It is not a
 * current original-file observation or an authentication of that historical source.
 */
function historicalSources(
  proof: unknown,
  policyBytes: Uint8Array,
  verification: Extract<LegacyPublicationVerification, { status: "verified" }>,
): { readonly available: readonly LegacyEquivalenceHistoricalSource[]; readonly unavailable: readonly Readonly<{ templateId: string; reason: string }>[] } {
  const unavailable = new Map(verification.unavailableSources.map(source => [source.templateId, source.reason]));
  for (const templateId of policyTemplateIds(policyBytes)) {
    if (verifiedLegacySource(proof, policyBytes, templateId) === null && !unavailable.has(templateId)) {
      unavailable.set(templateId, "verified historical policy snapshot is not available");
    }
  }
  const available: LegacyEquivalenceHistoricalSource[] = [];
  for (const templateId of policyTemplateIds(policyBytes)) {
    if (unavailable.has(templateId)) continue;
    const source = verifiedLegacySource(proof, policyBytes, templateId);
    if (source === null) continue;
    available.push({
      templateId,
      identity: source.identity,
      path: source.path,
      rawDigest: source.rawDigest,
      historicalBytes: cloneBytes(source.historicalBytes),
    });
  }
  return {
    available,
    unavailable: [...unavailable].sort(([left], [right]) => codePointCompare(left, right)).map(([templateId, reason]) => ({ templateId, reason })),
  };
}

function proposalFor(
  material: LegacyEquivalenceMaterial,
  decoding: LegacyPolicyDecoding,
  publicationProof: unknown,
  policyBytes: Uint8Array,
  verification: LegacyPublicationVerification | null,
): LegacyEquivalenceProposal {
  const sources = verification?.status === "verified" ? historicalSources(publicationProof, policyBytes, verification) : { available: [], unavailable: [] };
  return {
    material: cloneMaterial(material),
    candidate: candidateFor(decoding),
    decoding: cloneDecoding(decoding),
    availableHistoricalSources: sources.available,
    unavailableHistoricalSources: sources.unavailable,
  };
}

function decodeOwned(policyBytes: Uint8Array, publicationProof?: unknown): LegacyPolicyDecoding | string {
  try { return decodeLegacyPolicy(cloneBytes(policyBytes), publicationProof); }
  catch (error) { return error instanceof Error ? error.message : "historical policy cannot be decoded"; }
}

function publicationInput(owned: OwnedArchive, markerText: string, planText: string): Parameters<typeof verifyLegacyPublicationEvidence>[0] {
  return {
    format: owned.format,
    markerPath: owned.markerPath,
    markerBytes: markerText,
    planPath: owned.planPath,
    planBytes: planText,
    policyBytes: cloneBytes(owned.policyBytes),
    observedOutputs: Object.fromEntries([...owned.observedOutputs].map(([path, bytes]) => [path, cloneBytes(bytes)])),
  };
}

/** Accepts only raw archival components. Public digests, booleans, and brands are not authority inputs. */
export function createLegacyEquivalenceArchive(input: LegacyEquivalenceArchiveInput): LegacyEquivalenceArchive {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("legacy equivalence archive input is unsupported");
  if (input.format !== "v3" && input.format !== "v4") throw new TypeError("legacy equivalence format is unsupported");
  if (input.policyPath !== LEGACY_EQUIVALENCE_POLICY_PATH) throw new TypeError("legacy policy path is not the exact historical policy path");
  const markerPath = rawPath(input.markerPath);
  const planPath = rawPath(input.planPath);
  if (markerPath === null || planPath === null) throw new TypeError("legacy equivalence path is malformed");
  if (!isBytes(input.markerBytes) || !isBytes(input.planBytes) || !isBytes(input.policyBytes)) throw new TypeError("legacy equivalence evidence must be raw bytes");
  if (!(input.observedOutputs instanceof Map)) throw new TypeError("observed outputs must be a raw path map");
  if (input.observedOutputs.size > OBSERVATION_LIMIT) throw new TypeError("observed outputs exceed the archive bound");
  let total = input.markerBytes.byteLength + input.planBytes.byteLength + input.policyBytes.byteLength;
  const observed = new Map<string, Uint8Array>();
  for (const [path, bytes] of input.observedOutputs) {
    const exact = rawPath(path);
    if (exact === null || !isBytes(bytes)) throw new TypeError("observed output path or bytes are malformed");
    if (observed.has(exact)) throw new TypeError("observed output paths are duplicated");
    total += bytes.byteLength;
    if (total > ARCHIVE_BYTE_LIMIT || observed.size + FIXED_CONTROL_COUNT > OBSERVATION_LIMIT) throw new TypeError("legacy equivalence archive exceeds 8 MiB");
    observed.set(exact, cloneBytes(bytes));
  }
  if (total > ARCHIVE_BYTE_LIMIT) throw new TypeError("legacy equivalence archive exceeds 8 MiB");
  const ownedWithoutMaterial = {
    format: input.format,
    markerPath,
    markerBytes: cloneBytes(input.markerBytes),
    planPath,
    planBytes: cloneBytes(input.planBytes),
    policyBytes: cloneBytes(input.policyBytes),
    observedOutputs: observed,
  };
  const archive = Object.create(null) as LegacyEquivalenceArchive;
  archives.set(archive, { ...ownedWithoutMaterial, material: ownedMaterial(ownedWithoutMaterial) });
  return archive;
}

/** Descriptive path and raw-byte digest material. It is not an authority input. */
export function materializeLegacyEquivalenceArchive(archive: LegacyEquivalenceArchive): LegacyEquivalenceMaterial {
  const owned = archives.get(archive);
  if (owned === undefined) throw new TypeError("legacy equivalence archive is not registered");
  return cloneMaterial(owned.material);
}

function executeOwned(owned: OwnedArchive): LegacyEquivalenceExecution {
  const material = cloneMaterial(owned.material);
  const markerText = exactText(owned.markerBytes);
  const planText = exactText(owned.planBytes);
  if (markerText === null || planText === null) {
    return { disposition: "invalid", material, reasons: ["marker or plan bytes are not exact round-trippable UTF-8"] };
  }
  const verification = verifyLegacyPublicationEvidence(publicationInput(owned, markerText, planText));
  if (verification.status !== "verified") {
    const decoded = decodeOwned(owned.policyBytes);
    if (typeof decoded === "string") return { disposition: verification.status, material, reasons: [decoded, ...verification.reasons] };
    const proposal = proposalFor(material, decoded, undefined, owned.policyBytes, null);
    const disposition = decoded.sourceVersion === null ? "invalid" : "proposed";
    return { disposition, material, proposal, reasons: [...decoded.reasons, ...verification.reasons] };
  }
  const decoded = decodeOwned(owned.policyBytes, verification.proof);
  if (typeof decoded === "string") return { disposition: "invalid", material, reasons: [decoded] };
  const proposal = proposalFor(material, decoded, verification.proof, owned.policyBytes, verification);
  const reasons = [
    ...decoded.reasons,
    ...proposal.unavailableHistoricalSources.map(source => source.reason),
  ];
  if (decoded.selectionBlocked || decoded.automaticMigrationBlocked || proposal.unavailableHistoricalSources.length > 0 || decoded.sourceVersion === null) {
    const disposition = decoded.sourceVersion === null ? "invalid" : "proposed";
    return { disposition, material, reasons, proposal };
  }
  const proof = Object.create(null) as LegacyEquivalenceProof;
  proofs.set(proof, { archiveDigest: material.archiveDigest, canonicalPolicy: proposal.candidate.canonicalPolicy, material });
  return { disposition: "proved", proof, proposal };
}

/**
 * Runs the existing verifier and fixed decoder. A proof is minted only when that fresh
 * run is verified, unblocked, version-known, and has no unavailable historical source.
 * A public boolean, digest, or candidate cannot enter this path as proof.
 */
export function executeLegacyDecoderEquivalence(archive: LegacyEquivalenceArchive): LegacyEquivalenceExecution {
  const owned = archives.get(archive);
  if (owned === undefined) throw new TypeError("legacy equivalence archive is not registered");
  return executeOwned(owned);
}

/**
 * In-process proof/material revalidation. A serialized brand, public material, public
 * candidate digest, or type cast has no WeakMap record and is rejected. This is not
 * process-restart recovery.
 */
export function replayLegacyDecoderEquivalence(proof: unknown, archive: LegacyEquivalenceArchive): LegacyEquivalenceRecovery {
  const record = typeof proof === "object" && proof !== null ? proofs.get(proof as LegacyEquivalenceProof) : undefined;
  const owned = archives.get(archive);
  if (record === undefined || owned === undefined) return { disposition: "rejected", reasons: ["equivalence proof is not registered for this process"] };
  const execution = executeOwned(owned);
  if (execution.disposition !== "proved" || !sameMaterial(execution.proposal.material, record.material) || execution.proposal.candidate.canonicalPolicy !== record.canonicalPolicy) {
    return { disposition: "rejected", reasons: ["fresh equivalence execution does not match the registered proof"] };
  }
  return {
    disposition: "recovered",
    material: cloneMaterial(execution.proposal.material),
    candidate: candidateFor(execution.proposal.decoding),
    availableHistoricalSources: execution.proposal.availableHistoricalSources.map(source => ({ ...source, historicalBytes: cloneBytes(source.historicalBytes) })),
  };
}
