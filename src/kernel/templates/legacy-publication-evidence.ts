import type { Digest } from "./types.js";
import { canonicalJson, digestBytes, hashCanonical, parseDigest } from "./canonical.js";
import { parseLegacyJson } from "./legacy-json.js";

/**
 * Pure consistency check over caller-supplied historical publication bytes.
 * It does not read a vault, publish, or treat a seal as human authentication.
 * Source identity must also match the policy bytes sealed by the verified plan.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX_ID = /^[0-9a-f]{32}$/;
const TEMPLATE_ID = /^[\p{L}\p{N}]+(?:-{1,2}[\p{L}\p{N}]+)*$/u;
const V3_MARKERS = [".oms/template-migration.json", ".oms/template-transaction.json", ".oms/template-backfill.json"] as const;
const V3_MARKER_KEYS = ["status", "transactionId", "inputDigest", "approvalDigest", "outputDigest", "planDigest", "checksum"] as const;
const V4_MARKER_KEYS = ["status", "transactionId", "approvalDigest", "outputDigest", "planDigest", "checksum"] as const;
const V3_PLAN_KEYS = ["version", "transactionId", "approvalDigest", "outputDigest", "current", "proposed", "operations", "moves", "outputs", "manifest", "boundaries"] as const;
const V4_PLAN_KEYS = ["version", "transactionId", "approvalDigest", "outputDigest", "boundaries", "outputs", "planDigest"] as const;

export interface LegacyPublicationMarkerInspection {
  readonly format: "v3" | "v4" | "unknown";
  readonly markerPath: string;
  readonly status: "complete" | "in-progress" | "malformed" | "unknown";
  readonly transactionId: string | null;
  readonly planPath: string | null;
  readonly reasons: readonly string[];
}

export interface LegacyPublicationReadSet {
  readonly paths: readonly string[];
  readonly reasons: readonly string[];
}
const V3_CONTROLS = [".oms/template-policy.json", ".oms/taxonomy.json", ".oms/types.json"] as const;
const V3_MODES = ["create", "update", "reclassify", "relocate-folder", "remove", "default", "register-folder", "reconcile"] as const;
const V3_ACTIONS = ["write", "delete", "verify-only"] as const;
const V3_CONTROL_ACTIONS = ["write", "verify-only"] as const;
const V3_KINDS = ["policy", "taxonomy", "projection"] as const;
const V3_OPERATION_KINDS = V3_MODES;
const V3_CLASSES = ["managed-default", "registered-existing"] as const;
const V3_AUTHORITY_KINDS = ["template", "policy", "taxonomy", "obsidian-types"] as const;
const MAX_TEXT = 256 * 1024;
const MAX_COLLECTION = 64;
const MAX_KEYS = 48;
const MAX_DEPTH = 12;

export interface LegacyPublicationEvidenceInput {
  readonly format: "v3" | "v4";
  readonly markerPath: string;
  readonly markerBytes: string;
  readonly planPath: string;
  readonly planBytes: string;
  readonly policyBytes: Uint8Array;
  readonly observedOutputs: Readonly<Record<string, Uint8Array | null>>;
}

export interface LegacyPublicationProof {
  readonly format: "v3" | "v4";
  readonly policyDigest: Digest;
  readonly sealDigest: Digest;
}

export type LegacyPublicationVerification =
  | { readonly status: "verified"; readonly proof: LegacyPublicationProof; readonly unavailableSources: readonly { readonly templateId: string; readonly reason: string }[] }
  | { readonly status: "invalid" | "unavailable"; readonly reasons: readonly string[] };

interface VerifiedSource {
  readonly identity: string;
  readonly path: string;
  readonly rawDigest: Digest;
  readonly historicalBytes: Uint8Array;
}

interface ProofRecord {
  readonly format: "v3" | "v4";
  readonly policyDigest: Digest;
  readonly sealDigest: Digest;
  readonly sources: ReadonlyMap<string, VerifiedSource>;
}

const proofs = new WeakMap<LegacyPublicationProof, ProofRecord>();

function unavailable(reason: string): LegacyPublicationVerification {
  return { status: "unavailable", reasons: [reason] };
}
function invalid(reason: string): LegacyPublicationVerification {
  return { status: "invalid", reasons: [reason] };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function bounded(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= MAX_TEXT;
  if (typeof value === "number") return Number.isSafeInteger(value) && !Object.is(value, -0);
  if (Array.isArray(value)) return value.length <= MAX_COLLECTION && value.every(item => bounded(item, depth + 1));
  if (!isRecord(value) || Object.keys(value).length > MAX_KEYS) return false;
  return Object.values(value).every(item => bounded(item, depth + 1));
}
function digestValue(value: unknown): Digest | null {
  return typeof value === "string" && DIGEST.test(value) ? parseDigest(value) : null;
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
function cloneBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}
function utf8(value: string): Uint8Array | null {
  try {
    const bytes = encoder.encode(value);
    return decoder.decode(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}
function localCanonical(value: unknown): string | null {
  if (value instanceof Uint8Array) return JSON.stringify({ bytes: Buffer.from(value).toString("base64") });
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : encoded;
  }
  if (Array.isArray(value)) {
    const items = value.map(localCanonical);
    return items.some(item => item === null) ? null : `[${items.join(",")}]`;
  }
  if (!isRecord(value)) return null;
  const entries = Object.keys(value).sort().map(key => {
    const encoded = localCanonical(value[key]);
    return encoded === null ? null : `${JSON.stringify(key)}:${encoded}`;
  });
  return entries.some(entry => entry === null) ? null : `{${entries.join(",")}}`;
}
function localDigest(value: unknown): Digest | null {
  const encoded = localCanonical(value);
  return encoded === null ? null : digestBytes(encoded);
}
function codepointCompare(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0) ?? 0);
  const b = Array.from(right, character => character.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}
function legacyTemplateId(value: unknown): string | null {
  if (typeof value !== "string" || value.normalize("NFC") !== value || !TEMPLATE_ID.test(value)) return null;
  return value;
}
function relativeEvidence(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || value.includes("\0") || value.includes("\\")) return null;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return null;
  const segments = value.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === ".." || segment.startsWith("."))) return null;
  return value;
}
function v3SourcePath(value: unknown): string | null {
  const path = relativeEvidence(value);
  if (path === null) return null;
  const leaf = path.slice(path.lastIndexOf("/") + 1);
  return leaf.endsWith(".md") && leaf.length > 3 ? path : null;
}
function v4ManagedPath(value: unknown, templateId: string | null): string | null {
  if (typeof value !== "string" || value.normalize("NFC") !== value) return null;
  const match = /^\.oms\/templates\/([^/]+)\.md$/.exec(value);
  if (match === null) return null;
  const id = match[1] === "default" ? null : legacyTemplateId(match[1]);
  if (match[1] !== "default" && id === null) return null;
  return id === templateId ? value : null;
}
function closedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function expectation(value: unknown): { readonly state: "absent" } | { readonly state: "present"; readonly signature: Digest } | null {
  if (!isRecord(value) || !closedKeys(value, ["state", "signature"])) return null;
  if (value["state"] === "absent") return Object.keys(value).length === 1 ? { state: "absent" } : null;
  const signature = digestValue(value["signature"]);
  return value["state"] === "present" && signature !== null ? { state: "present", signature } : null;
}
function base64Bytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length > MAX_TEXT || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? new Uint8Array(decoded) : null;
}
function revivedState(value: unknown): { readonly state: "absent" } | { readonly state: "present"; readonly bytes: Uint8Array; readonly signature: Digest } | null {
  if (!isRecord(value)) return null;
  if (value["state"] === "absent") return closedKeys(value, ["state"]) ? { state: "absent" } : null;
  if (value["state"] !== "present" || !closedKeys(value, ["state", "bytes", "signature"])) return null;
  const signature = digestValue(value["signature"]);
  const encoded = value["bytes"];
  if (signature === null || !isRecord(encoded) || !closedKeys(encoded, ["bytes"])) return null;
  const bytes = base64Bytes(encoded["bytes"]);
  return bytes !== null && digestBytes(bytes) === signature ? { state: "present", bytes, signature } : null;
}
function publicationId(approval: Digest, output: Digest): string {
  return digestBytes(`${approval}\0${output}`).slice("sha256:".length, "sha256:".length + 32);
}
function historicalOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function sorted<T>(values: readonly T[], compare: (left: T, right: T) => number): boolean {
  return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) <= 0);
}
function diagnosticShape(value: unknown): { readonly code: string; readonly templateId: string | null; readonly path: string | null; readonly field: string | null; readonly message: string | null; readonly extensions: unknown } | null {
  if (!isRecord(value) || typeof value["code"] !== "string" || !closedKeys(value, ["code", "templateId", "path", "field", "message", "extensions"])) return null;
  const optional = (key: string): string | null | undefined => value[key] === undefined || value[key] === null ? null : typeof value[key] === "string" ? value[key] : undefined;
  const templateId = optional("templateId");
  const path = optional("path");
  const field = optional("field");
  const message = optional("message");
  if (templateId === undefined || path === undefined || field === undefined || message === undefined) return null;
  return { code: value["code"], templateId, path, field, message, extensions: value["extensions"] ?? null };
}
function inputV2Digest(value: unknown): Digest | null {
  if (!isRecord(value) || value["version"] !== 2 || !Array.isArray(value["templateFolders"]) || !Array.isArray(value["authority"]) || !Array.isArray(value["placement"])) return null;
  if (!closedKeys(value, ["version", "templateFolders", "authority", "placement"])) return null;
  try {
    const folders = value["templateFolders"].map(folder => {
      if (!isRecord(folder) || typeof folder["path"] !== "string") throw new TypeError("folder");
      const optional = Object.keys(folder).filter(key => key !== "path");
      if (optional.some(key => key !== "default" && key !== "extensions") || folder["default"] !== undefined && folder["default"] !== true) throw new TypeError("folder");
      return { path: folder["path"], ...(folder["default"] === true ? { default: true } : {}), ...(folder["extensions"] === undefined ? {} : { extensions: folder["extensions"] }) };
    });
    const authority = value["authority"].map(entry => {
      if (!isRecord(entry) || !V3_AUTHORITY_KINDS.includes(entry["kind"] as never) || typeof entry["logicalId"] !== "string") throw new TypeError("authority");
      const contentDigest = digestValue(entry["contentDigest"]);
      if (contentDigest === null || entry["vaultRelativePath"] !== null && typeof entry["vaultRelativePath"] !== "string") throw new TypeError("authority");
      return { kind: entry["kind"], logicalId: entry["logicalId"], vaultRelativePath: entry["vaultRelativePath"] ?? null, contentDigest };
    });
    const placement = value["placement"].map(entry => {
      if (!isRecord(entry) || !closedKeys(entry, ["templateId", "destinationClass", "templateFolder", "sourceFolder", "sourcePath"])) throw new TypeError("placement");
      if (!V3_CLASSES.includes(entry["destinationClass"] as never) || typeof entry["sourceFolder"] !== "string" || typeof entry["sourcePath"] !== "string") throw new TypeError("placement");
      if (entry["templateFolder"] !== null && typeof entry["templateFolder"] !== "string") throw new TypeError("placement");
      const templateId = legacyTemplateId(entry["templateId"]);
      if (templateId === null) throw new TypeError("placement");
      return { templateId, destinationClass: entry["destinationClass"], templateFolder: entry["templateFolder"], sourceFolder: entry["sourceFolder"], sourcePath: entry["sourcePath"] };
    });
    folders.sort((left, right) => codepointCompare(left.path, right.path));
    authority.sort((left, right) => codepointCompare(String(left.kind), String(right.kind)) || codepointCompare(left.logicalId, right.logicalId) || codepointCompare(left.vaultRelativePath ?? "", right.vaultRelativePath ?? ""));
    placement.sort((left, right) => codepointCompare(left.templateId, right.templateId));
    if (new Set(folders.map(folder => folder.path)).size !== folders.length || new Set(placement.map(entry => entry.templateId)).size !== placement.length) return null;
    return hashCanonical("oms.template-migration.input.v2", { version: 2, templateFolders: folders, authority, placement });
  } catch {
    return null;
  }
}
function approvalPreimageDigest(input: Digest, operations: readonly Record<string, unknown>[], diagnostics: readonly ReturnType<typeof diagnosticShape>[], manifest: Record<string, unknown>): Digest | null {
  const current = manifest["current"];
  const controls = manifest["controls"];
  const sources = manifest["sources"];
  if (!isRecord(current) || digestValue(current["inputDigest"]) === null || !Array.isArray(controls) || !Array.isArray(sources)) return null;
  const expected = (value: unknown): Record<string, string> | null => {
    const parsed = expectation(isRecord(value) ? { state: value["state"], ...(value["signature"] === undefined ? {} : { signature: value["signature"] }) } : value);
    return parsed === null ? null : parsed.state === "absent" ? { state: "absent" } : { state: "present", signature: parsed.signature };
  };
  try {
    return hashCanonical("oms.template-migration.approval.v2", {
      inputDigest: input,
      preimage: {
        currentInputDigest: parseDigest(String(current["inputDigest"])),
        controls: controls.map(control => {
          if (!isRecord(control)) throw new TypeError("control");
          const state = expected(control["expectedCurrent"]);
          if (state === null || typeof control["path"] !== "string") throw new TypeError("control");
          return { path: control["path"], expectedCurrent: state };
        }).sort((left, right) => codepointCompare(left.path, right.path)),
        sources: sources.map(source => {
          if (!isRecord(source)) throw new TypeError("source");
          const state = expected(source["expectedCurrent"]);
          if (state === null || typeof source["templateId"] !== "string" || typeof source["path"] !== "string") throw new TypeError("source");
          return { templateId: source["templateId"], path: source["path"], expectedCurrent: state };
        }).sort((left, right) => codepointCompare(left.templateId, right.templateId) || codepointCompare(left.path, right.path)),
      },
      operations: operations.map(operation => ({
        kind: operation["kind"], templateId: operation["templateId"], destinationClass: operation["destinationClass"],
        payloadDigest: parseDigest(String(operation["payloadDigest"])), stableRelativeSuffix: operation["stableRelativeSuffix"] ?? null,
      })).sort((left, right) =>
        codepointCompare(String(left.kind), String(right.kind)) ||
        codepointCompare(String(left.templateId), String(right.templateId)) ||
        codepointCompare(String(left.destinationClass), String(right.destinationClass)) ||
        codepointCompare(String(left.stableRelativeSuffix ?? ""), String(right.stableRelativeSuffix ?? "")) ||
        codepointCompare(left.payloadDigest, right.payloadDigest)),
      diagnostics: diagnostics.map(item => item ?? { code: "", templateId: null, path: null, field: null, message: null, extensions: null })
        .sort((left, right) => codepointCompare(left.code, right.code) || codepointCompare(left.templateId ?? "", right.templateId ?? "") || codepointCompare(left.path ?? "", right.path ?? "") || codepointCompare(left.field ?? "", right.field ?? "") || codepointCompare(left.message ?? "", right.message ?? "") || codepointCompare(canonicalJson(left), canonicalJson(right))),
    });
  } catch {
    return null;
  }
}
function outputSetDigest(domain: "oms.template-migration.output.v1" | "oms.contract-publish.output.v1", outputs: readonly { readonly path: string; readonly payloadDigest: Digest }[]): Digest {
  const unique = new Map<string, Digest>();
  for (const output of outputs) {
    if (unique.has(output.path) && unique.get(output.path) !== output.payloadDigest) throw new TypeError("duplicate output");
    unique.set(output.path, output.payloadDigest);
  }
  const canonical = [...unique].map(([finalVaultRelativePath, payloadDigest]) => ({ finalVaultRelativePath, payloadDigest }))
    .sort((left, right) => codepointCompare(left.finalVaultRelativePath, right.finalVaultRelativePath) || (domain.endsWith("v1") && domain.startsWith("oms.template") ? codepointCompare(left.payloadDigest, right.payloadDigest) : 0));
  return hashCanonical(domain, { outputs: canonical });
}
function observedPostimage(path: string, expected: Digest, observed: Readonly<Record<string, Uint8Array | null>>): boolean {
  if (!Object.hasOwn(observed, path)) return false;
  const actual = observed[path];
  return actual instanceof Uint8Array && digestBytes(actual) === expected;
}
function proofFor(record: ProofRecord): LegacyPublicationProof {
  const proof: LegacyPublicationProof = { format: record.format, policyDigest: record.policyDigest, sealDigest: record.sealDigest };
  proofs.set(proof, record);
  return proof;
}

function markerLocator(format: "v3" | "v4" | "unknown", markerPath: string, status: LegacyPublicationMarkerInspection["status"], transactionId: string | null, planPath: string | null, reasons: readonly string[]): LegacyPublicationMarkerInspection {
  return { format, markerPath, status, transactionId, planPath, reasons };
}
function knownMarkerPath(markerPath: string): boolean {
  return markerPath === ".oms/template-transaction.json" || V3_MARKERS.includes(markerPath as never);
}
function parsedPublicationText(markerBytes: string): { readonly marker: Record<string, unknown> } | { readonly reason: string } {
  if (utf8(markerBytes) === null || !markerBytes.endsWith("\n")) return { reason: "publication marker is not exact UTF-8 canonical JSON plus newline" };
  let marker: unknown;
  try { marker = JSON.parse(markerBytes); } catch { return { reason: "publication marker is not JSON" }; }
  if (!isRecord(marker)) return { reason: "publication marker is not an object" };
  if (!bounded(marker)) return { reason: "publication marker exceeds the closed evidence bound" };
  if (`${localCanonical(marker)}\n` !== markerBytes) return { reason: "publication marker is not historical canonical JSON" };
  return { marker };
}
/** Locates a closed historical marker. A matching path is not publication proof. */
export function inspectLegacyPublicationMarker(markerPath: string, markerBytes: string): LegacyPublicationMarkerInspection {
  if (!knownMarkerPath(markerPath)) return markerLocator("unknown", markerPath, "unknown", null, null, ["publication marker path is not a known historical slot"]);
  const parsed = parsedPublicationText(markerBytes);
  if ("reason" in parsed) return markerLocator(markerPath === ".oms/template-transaction.json" ? "unknown" : "v3", markerPath, "malformed", null, null, [parsed.reason]);
  const marker = parsed.marker;
  const v3 = closedKeys(marker, V3_MARKER_KEYS) && Object.hasOwn(marker, "inputDigest");
  const v4 = markerPath === ".oms/template-transaction.json" && closedKeys(marker, V4_MARKER_KEYS) && !Object.hasOwn(marker, "inputDigest");
  const format = v3 ? "v3" : v4 ? "v4" : "unknown";
  if (format === "unknown") return markerLocator(markerPath === ".oms/template-transaction.json" ? "unknown" : "v3", markerPath, "malformed", null, null, ["publication marker shape is not a closed historical marker"]);
  if (marker["status"] !== "complete" && marker["status"] !== "in-progress") return markerLocator(format, markerPath, "malformed", null, null, ["publication marker status is not a historical publication status"]);
  const transactionId = typeof marker["transactionId"] === "string" && (format === "v4" || HEX_ID.test(marker["transactionId"])) ? marker["transactionId"] : null;
  if (transactionId === null) return markerLocator(format, markerPath, "malformed", null, null, ["publication marker id is malformed"]);
  const stem = markerPath.slice(".oms/".length, -".json".length);
  const planPath = format === "v3" ? `.oms/.template-transactions/${transactionId}/${stem}/plan.json` : `.oms/.template-transactions/${transactionId}/plan.json`;
  return markerLocator(format, markerPath, marker["status"], transactionId, planPath, []);
}
function confinedObservationPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return null;
  const segments = value.split("/");
  if (segments.some(segment => segment.length === 0 || segment === "." || segment === "..")) return null;
  return value;
}
function sealedOutputPaths(value: unknown): { readonly paths: readonly string[] } | { readonly reason: string } {
  if (!Array.isArray(value)) return { reason: "sealed plan outputs are not a collection" };
  if (value.length > MAX_COLLECTION) return { reason: "sealed plan outputs exceed the closed evidence bound" };
  const paths: string[] = [];
  for (const output of value) {
    if (!isRecord(output) || !closedKeys(output, ["finalVaultRelativePath", "payloadDigest"])) return { reason: "sealed plan output is not a closed path and digest" };
    const path = confinedObservationPath(output["finalVaultRelativePath"]);
    if (path === null || digestValue(output["payloadDigest"]) === null) return { reason: "sealed plan output path or digest is malformed" };
    if (paths.includes(path)) return { reason: "sealed plan outputs are duplicated" };
    paths.push(path);
  }
  return { paths };
}
/** Required observation paths from one sealed plan. It does not read, verify, or authorize publication. */
export function legacyPublicationReadSet(format: "v3" | "v4", markerPath: string, markerBytes: string, planPath: string, planBytes: string): LegacyPublicationReadSet {
  const located = inspectLegacyPublicationMarker(markerPath, markerBytes);
  if (located.format !== format || located.planPath !== planPath || located.status === "malformed" || located.status === "unknown") {
    return { paths: [], reasons: located.reasons.length === 0 ? ["sealed plan is not the marker's located publication"] : located.reasons };
  }
  if (utf8(planBytes) === null || !planBytes.endsWith("\n")) return { paths: [], reasons: ["sealed plan is not exact UTF-8 canonical JSON plus newline"] };
  let plan: unknown;
  try { plan = JSON.parse(planBytes); } catch { return { paths: [], reasons: ["sealed plan is not JSON"] }; }
  if (!isRecord(plan) || !bounded(plan) || `${localCanonical(plan)}\n` !== planBytes) return { paths: [], reasons: ["sealed plan is not bounded historical canonical JSON"] };
  if (format === "v3") {
    if (!closedKeys(plan, V3_PLAN_KEYS) || plan["version"] !== 1) return { paths: [], reasons: ["v3 plan shape is not version 1"] };
  } else if (!closedKeys(plan, V4_PLAN_KEYS) || plan["version"] !== 1) return { paths: [], reasons: ["v4 plan shape is not version 1"] };
  if (plan["transactionId"] !== located.transactionId) return { paths: [], reasons: ["sealed plan identity does not match the located marker"] };
  const outputs = sealedOutputPaths(plan["outputs"]);
  if ("reason" in outputs) return { paths: [], reasons: [outputs.reason] };
  return { paths: [...new Set([markerPath, planPath, ...outputs.paths])], reasons: [] };
}

function verifyV3(input: LegacyPublicationEvidenceInput): LegacyPublicationVerification {
  if (!V3_MARKERS.includes(input.markerPath as never)) return invalid("v3 marker path is not a known nested publication marker");
  const stem = input.markerPath.slice(".oms/".length, -".json".length);
  const markerUtf8 = utf8(input.markerBytes);
  const planUtf8 = utf8(input.planBytes);
  if (markerUtf8 === null || planUtf8 === null || !input.markerBytes.endsWith("\n") || !input.planBytes.endsWith("\n")) return invalid("v3 publication text is not exact UTF-8 canonical JSON plus newline");
  let marker: unknown;
  let plan: unknown;
  try {
    marker = JSON.parse(input.markerBytes);
    plan = JSON.parse(input.planBytes);
  } catch {
    return invalid("v3 publication text is not JSON");
  }
  if (!isRecord(marker) || !isRecord(plan)) return invalid("v3 publication is not an object");
  if (!bounded(marker)) return invalid("v3 marker exceeds the closed evidence bound");
  if (!bounded(plan)) return invalid("v3 plan exceeds the closed evidence bound");
  if (`${localCanonical(marker)}\n` !== input.markerBytes || `${localCanonical(plan)}\n` !== input.planBytes) return invalid("v3 publication text is not historical canonical JSON");
  if (!closedKeys(marker, V3_MARKER_KEYS)) return invalid("v3 marker shape is not closed");
  if (marker["status"] !== "complete" && marker["status"] !== "in-progress") return invalid("v3 marker status is not a historical publication status");
  const approvalDigest = digestValue(marker["approvalDigest"]);
  const outputDigest = digestValue(marker["outputDigest"]);
  const inputDigest = digestValue(marker["inputDigest"]);
  const planDigest = digestValue(marker["planDigest"]);
  const checksum = digestValue(marker["checksum"]);
  if (approvalDigest === null || outputDigest === null || inputDigest === null || planDigest === null || checksum === null || !HEX_ID.test(String(marker["transactionId"]))) return invalid("v3 marker digest or id is malformed");
  const bare = { status: marker["status"], transactionId: marker["transactionId"], inputDigest, approvalDigest, outputDigest, planDigest };
  if (localDigest(bare) !== checksum || marker["transactionId"] !== publicationId(approvalDigest, outputDigest)) return invalid("v3 marker checksum or publication id does not match");
  if (marker["status"] !== "complete") return unavailable("v3 publication is in progress");
  if (input.planPath !== `.oms/.template-transactions/${marker["transactionId"]}/${stem}/plan.json`) return invalid("v3 plan path is not the nested marker-stem root");
  if (localDigest(plan) !== planDigest) return invalid("v3 plan digest does not match the marker");
  if (!closedKeys(plan, V3_PLAN_KEYS) || plan["version"] !== 1) return invalid("v3 plan shape is not version 1");
  if (plan["transactionId"] !== marker["transactionId"] || plan["approvalDigest"] !== approvalDigest || plan["outputDigest"] !== outputDigest || typeof plan["manifest"] !== "string") return invalid("v3 plan identity does not match the marker");
  if (!Array.isArray(plan["boundaries"]) || !Array.isArray(plan["operations"]) || !Array.isArray(plan["moves"]) || !Array.isArray(plan["outputs"])) return invalid("v3 plan collections are invalid");
  let manifest: unknown;
  try { manifest = JSON.parse(plan["manifest"]); } catch { return invalid("v3 manifest string is not JSON"); }
  if (!bounded(manifest) || !isRecord(manifest)) return invalid("v3 manifest is not a bounded object");
  if (localCanonical(manifest) !== plan["manifest"]) return invalid("v3 manifest string is not its historical local canonical form");
  if (manifest["version"] !== 1 || !V3_MODES.includes(manifest["mode"] as never) || Object.hasOwn(manifest, "legacyCleanup")) return invalid("v3 manifest mode is unsupported");
  if (!Array.isArray(manifest["controls"]) || manifest["controls"].length !== 3 || !Array.isArray(manifest["sources"]) || !Array.isArray(manifest["operations"]) || !Array.isArray(manifest["diagnostics"]) || !Array.isArray(manifest["outputs"])) return invalid("v3 manifest collections are invalid");
  const controls = manifest["controls"].map(control => {
    if (!isRecord(control) || typeof control["path"] !== "string" || typeof control["action"] !== "string" || typeof control["kind"] !== "string") return null;
    if (!V3_CONTROL_ACTIONS.includes(control["action"] as "write") || !V3_KINDS.includes(control["kind"] as "policy")) return null;
    const current = revivedState(control["current"]);
    const proposed = revivedState(control["proposed"]);
    const expectedCurrent = expectation(control["expectedCurrent"]);
    if (current === null || proposed?.state !== "present" || expectedCurrent === null) return null;
    return { path: control["path"], action: control["action"], kind: control["kind"], expectedCurrent, current, proposed };
  });
  if (controls.some(control => control === null)) return invalid("v3 control revival failed");
  const sources = manifest["sources"].map(source => {
    if (!isRecord(source) || typeof source["action"] !== "string" || !V3_ACTIONS.includes(source["action"] as "write")) return null;
    const templateId = legacyTemplateId(source["templateId"]);
    const path = v3SourcePath(source["path"]);
    const current = revivedState(source["current"]);
    const proposed = revivedState(source["proposed"]);
    const expectedCurrent = expectation(source["expectedCurrent"]);
    if (templateId === null || path === null || current === null || proposed === null || expectedCurrent === null) return null;
    return { templateId, path, action: source["action"], expectedCurrent, current, proposed };
  });
  if (sources.some(source => source === null)) return invalid("v3 source revival failed");
  const strictControls = controls.filter((control): control is NonNullable<typeof control> => control !== null);
  const strictSources = sources.filter((source): source is NonNullable<typeof source> => source !== null);
  if (strictControls.some((control, index) => control["path"] !== V3_CONTROLS[index])) return invalid("v3 controls are not policy, taxonomy, projection");
  if (!sorted(strictSources, (left, right) => historicalOrder(`${left.templateId}\0${left.path}`, `${right.templateId}\0${right.path}`))) return invalid("v3 sources are not ordered");
  if (new Set(strictSources.map(source => source.path)).size !== strictSources.length) return invalid("v3 source paths are duplicated");
  if (new Set(strictSources.map(source => source.templateId)).size !== strictSources.length) return invalid("v3 source identity is duplicated");
  const currentDigest = inputV2Digest(isRecord(manifest["current"]) ? manifest["current"]["input"] : null);
  const proposedDigest = inputV2Digest(isRecord(manifest["proposed"]) ? manifest["proposed"]["input"] : null);
  if (!isRecord(manifest["current"]) || !isRecord(manifest["proposed"])) return invalid("v3 semantic snapshot is not an object");
  if (currentDigest === null || proposedDigest === null) return invalid("v3 revived InputV2 is not a closed historical input");
  if (manifest["current"]["inputDigest"] !== currentDigest || manifest["proposed"]["inputDigest"] !== proposedDigest || inputDigest !== proposedDigest) return invalid("v3 input digest does not match revived InputV2");
  const operations = manifest["operations"];
  if (!Array.isArray(operations) || operations.some(operation => !isRecord(operation) || !V3_OPERATION_KINDS.includes(operation["kind"] as never) || legacyTemplateId(operation["templateId"]) === null || !V3_CLASSES.includes(operation["destinationClass"] as never) || digestValue(operation["payloadDigest"]) === null || operation["stableRelativeSuffix"] !== null)) return invalid("v3 operations are not historical logical operations");
  const diagnostics = (manifest["diagnostics"] as unknown[]).map(diagnosticShape);
  if (diagnostics.some(item => item === null)) return invalid("v3 diagnostics are not closed");
  const strictOperations = operations.filter((operation): operation is Record<string, unknown> => isRecord(operation));
  const approved = approvalPreimageDigest(proposedDigest, strictOperations, diagnostics, manifest);
  if (approved === null || approved !== approvalDigest || manifest["approvalDigest"] !== approvalDigest) return invalid("v3 approval preimage does not match");
  const outputs = (manifest["outputs"] as unknown[]).map(output => {
    if (!isRecord(output) || !closedKeys(output, ["finalVaultRelativePath", "payloadDigest"])) return null;
    const payloadDigest = digestValue(output["payloadDigest"]);
    return typeof output["finalVaultRelativePath"] === "string" && payloadDigest !== null ? { path: output["finalVaultRelativePath"], payloadDigest } : null;
  });
  if (outputs.some(output => output === null)) return invalid("v3 outputs are malformed");
  const strictOutputs = outputs.filter((output): output is NonNullable<typeof output> => output !== null);
  if (new Set(strictOutputs.map(output => output.path)).size !== strictOutputs.length) return invalid("v3 outputs are duplicated");
  const planOutputs = plan["outputs"] as unknown[];
  if (planOutputs.length !== strictOutputs.length || strictOutputs.some((output, index) => !isRecord(planOutputs[index]) || planOutputs[index]?.["finalVaultRelativePath"] !== output.path || planOutputs[index]?.["payloadDigest"] !== output.payloadDigest)) return invalid("v3 plan outputs do not match the revived manifest");
  let recomputedOutput: Digest;
  try { recomputedOutput = outputSetDigest("oms.template-migration.output.v1", strictOutputs); } catch { return invalid("v3 outputs conflict"); }
  if (recomputedOutput !== outputDigest || manifest["outputDigest"] !== outputDigest) return invalid("v3 output digest does not match");
  if (manifest["mode"] === "reconcile" && (strictSources.some(source => source["action"] !== "verify-only") || strictOutputs.some(output => !V3_CONTROLS.includes(output.path as never)))) return invalid("v3 reconcile publication is not verify-only");
  const boundaries = plan["boundaries"] as unknown[];
  const expectedBoundaries = [
    ...strictSources.filter(source => source["action"] === "write").sort((left, right) => left.templateId.localeCompare(right.templateId)),
    ...strictControls.filter(control => control["action"] === "write"),
    ...strictSources.filter(source => source["action"] === "delete").sort((left, right) => left.templateId.localeCompare(right.templateId)),
  ];
  if (boundaries.length !== expectedBoundaries.length) return invalid("v3 boundaries do not match write and delete transitions");
  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index];
    const transition = expectedBoundaries[index];
    if (!isRecord(boundary) || !closedKeys(boundary, ["path", "expected", "proposed"]) || transition === undefined || boundary["path"] !== transition["path"]) return invalid("v3 boundary path does not match its transition");
    const expected = expectation(boundary["expected"]);
    const proposed = revivedState(boundary["proposed"]);
    const transitionExpected = expectation(transition["expectedCurrent"]);
    if (expected === null || proposed === null || transitionExpected === null || JSON.stringify(expected) !== JSON.stringify(transitionExpected) || localCanonical(proposed) !== localCanonical(transition["proposed"])) return invalid("v3 boundary bytes do not match revived transition bytes");
  }
  for (const output of strictOutputs) {
    if (!observedPostimage(output.path, output.payloadDigest, input.observedOutputs)) return invalid("v3 observed postimage is missing or mismatched");
  }
  if (Object.keys(input.observedOutputs).some(path => !strictOutputs.some(output => output.path === path))) return invalid("v3 observed output is outside the sealed output set");
  const policy = strictControls[0];
  if (policy === undefined || policy["kind"] !== "policy" || policy["action"] !== "write" || policy.proposed.state !== "present" || !sameBytes(policy.proposed.bytes, input.policyBytes) || digestBytes(input.policyBytes) !== policy.proposed.signature) return invalid("v3 policy control does not match supplied policy bytes");
  const proposedInput = isRecord(manifest["proposed"]) ? manifest["proposed"]["input"] : null;
  if (!isRecord(proposedInput) || !Array.isArray(proposedInput["authority"]) || !Array.isArray(proposedInput["placement"])) return invalid("v3 proposed input is unavailable");
  const authority = proposedInput["authority"].filter((entry): entry is Record<string, unknown> => isRecord(entry));
  const policyAuthority = authority.find(entry => entry["kind"] === "policy");
  if (policyAuthority?.["contentDigest"] !== policy.proposed.signature || policyAuthority["vaultRelativePath"] !== policy["path"]) return invalid("v3 policy authority is not linked to proposed policy bytes");
  let capturedPolicy: unknown;
  try {
    const parsed = parseLegacyJson(decoder.decode(input.policyBytes));
    capturedPolicy = parsed.members === "unique" ? parsed.value : null;
  }
  catch { capturedPolicy = null; }
  const policyBindings = bounded(capturedPolicy) && isRecord(capturedPolicy) && capturedPolicy["version"] === 3 && isRecord(capturedPolicy["templates"])
    ? capturedPolicy["templates"]
    : null;
  const sourcesById = new Map<string, VerifiedSource>();
  const unavailableSources: { templateId: string; reason: string }[] = [];
  for (const source of strictSources) {
    if (source["action"] !== "write" || source.proposed.state !== "present") {
      unavailableSources.push({ templateId: source.templateId, reason: "historical source transition does not carry proposed bytes" });
      continue;
    }
    const placement = (proposedInput["placement"] as unknown[]).find(entry => isRecord(entry) && entry["templateId"] === source.templateId);
    const templateAuthority = authority.find(entry => entry["kind"] === "template" && entry["logicalId"] === source.templateId);
    const bindings = Array.isArray(isRecord(manifest["proposed"]) ? manifest["proposed"]["bindings"] : null) ? manifest["proposed"]["bindings"] as unknown[] : [];
    const binding = bindings.find(entry => isRecord(entry) && entry["templateId"] === source.templateId);
    if (!isRecord(placement) || !isRecord(templateAuthority) || !isRecord(binding) || placement["sourcePath"] !== source.path || templateAuthority["vaultRelativePath"] !== source.path || templateAuthority["contentDigest"] !== source.proposed.signature || binding["sourcePath"] !== source.path) {
      return invalid("v3 source linkage does not match authority, placement, and binding");
    }
    const policyBinding = policyBindings !== null && Object.hasOwn(policyBindings, source.templateId) ? policyBindings[source.templateId] : undefined;
    if (!isRecord(policyBinding) || policyBinding["templateId"] !== source.templateId || policyBinding["sourcePath"] !== source.path) {
      unavailableSources.push({ templateId: source.templateId, reason: "captured policy does not bind this historical source identity and path" });
      continue;
    }
    sourcesById.set(source.templateId, { identity: source.templateId, path: source.path, rawDigest: source.proposed.signature, historicalBytes: cloneBytes(source.proposed.bytes) });
  }
  return { status: "verified", proof: proofFor({ format: "v3", policyDigest: policy.proposed.signature, sealDigest: approvalDigest, sources: sourcesById }), unavailableSources };
}

function canonicalSourcePath(value: unknown): string | null {
  if (typeof value !== "string" || value.normalize("NFC") !== value) return null;
  const path = v3SourcePath(value);
  return path;
}
function textDigest(value: string): Digest | null {
  return utf8(value) === null ? null : digestBytes(value);
}
/** A verified historical policy snapshot, not human approval or an observed filesystem file. */
function v4PolicySnapshots(policyBytes: Uint8Array): Map<string, VerifiedSource> {
  const snapshots = new Map<string, VerifiedSource>();
  let parsed: unknown;
  try {
    const policy = parseLegacyJson(decoder.decode(policyBytes));
    if (policy.members !== "unique") return snapshots;
    parsed = policy.value;
  } catch { return snapshots; }
  if (!bounded(parsed) || !isRecord(parsed) || parsed["version"] !== 4 || !isRecord(parsed["templates"])) return snapshots;
  for (const [templateId, template] of Object.entries(parsed["templates"])) {
    if (legacyTemplateId(templateId) !== templateId || !isRecord(template) || template["templateId"] !== templateId || !isRecord(template["source"])) continue;
    const source = template["source"];
    const path = canonicalSourcePath(source["path"]);
    const identity = typeof source["identity"] === "string" && source["identity"].trim().length > 0 && source["identity"].length <= 240 && !/[\u0000-\u001f]/u.test(source["identity"]) ? source["identity"] : null;
    const recorded = digestValue(source["rawDigest"]);
    const approved = digestValue(template["approvedMarkdownDigest"]);
    const markdown = typeof template["approvedMarkdown"] === "string" ? template["approvedMarkdown"] : null;
    const actual = markdown === null ? null : textDigest(markdown);
    if (path === null || identity === null || recorded === null || approved === null || actual === null || actual !== recorded || actual !== approved) continue;
    if (markdown === null) continue;
    snapshots.set(templateId, { identity, path, rawDigest: recorded, historicalBytes: cloneBytes(encoder.encode(markdown)) });
  }
  return snapshots;
}
function verifyV4(input: LegacyPublicationEvidenceInput): LegacyPublicationVerification {
  if (input.markerPath !== ".oms/template-transaction.json") return invalid("v4 marker path is not the direct publication marker");
  const markerUtf8 = utf8(input.markerBytes);
  const planUtf8 = utf8(input.planBytes);
  if (markerUtf8 === null || planUtf8 === null || !input.markerBytes.endsWith("\n") || !input.planBytes.endsWith("\n")) return invalid("v4 publication text is not exact UTF-8 canonical JSON plus newline");
  let marker: unknown;
  let plan: unknown;
  try {
    marker = JSON.parse(input.markerBytes);
    plan = JSON.parse(input.planBytes);
  } catch {
    return invalid("v4 publication text is not JSON");
  }
  if (!bounded(marker) || !bounded(plan) || !isRecord(marker) || !isRecord(plan)) return invalid("v4 publication exceeds the closed evidence bound");
  if (`${localCanonical(marker)}\n` !== input.markerBytes || `${localCanonical(plan)}\n` !== input.planBytes) return invalid("v4 publication text is not historical canonical JSON");
  const markerKeys = Object.keys(marker);
  if (!["status", "transactionId", "approvalDigest", "outputDigest", "planDigest", "checksum"].every(key => markerKeys.includes(key))) return invalid("v4 marker is missing a sealed field");
  if (!closedKeys(marker, V4_MARKER_KEYS) || !closedKeys(plan, V4_PLAN_KEYS)) return invalid("v4 publication has unsupported metadata");
  if (marker["status"] !== "in-progress" && marker["status"] !== "complete") return invalid("v4 marker status is not a historical publication status");
  const approvalDigest = digestValue(marker["approvalDigest"]);
  const outputDigest = digestValue(marker["outputDigest"]);
  const planDigest = digestValue(marker["planDigest"]);
  const checksum = digestValue(marker["checksum"]);
  if (approvalDigest === null || outputDigest === null || planDigest === null || checksum === null || typeof marker["transactionId"] !== "string") return invalid("v4 marker digest is malformed");
  if (marker["transactionId"] !== publicationId(approvalDigest, outputDigest)) return invalid("v4 publication id does not match its digests");
  const material = { status: marker["status"], transactionId: marker["transactionId"], approvalDigest, outputDigest, planDigest };
  if (hashCanonical("oms.contract-publish.marker.v1", material) !== checksum) return invalid("v4 marker checksum does not match");
  if (marker["status"] !== "complete") return unavailable("v4 publication is in progress");
  if (input.planPath !== `.oms/.template-transactions/${marker["transactionId"]}/plan.json`) return invalid("v4 plan path is not the direct publication root");
  if (plan["version"] !== 1 || !Array.isArray(plan["boundaries"]) || !Array.isArray(plan["outputs"]) || plan["transactionId"] !== marker["transactionId"] || plan["approvalDigest"] !== approvalDigest || plan["outputDigest"] !== outputDigest || plan["planDigest"] !== planDigest) return invalid("v4 plan identity does not match the marker");
  const boundaries = plan["boundaries"].map(boundary => {
    if (!isRecord(boundary) || !closedKeys(boundary, ["path", "templateId", "expected", "proposed"]) || typeof boundary["path"] !== "string") return null;
    const templateId = boundary["templateId"] === null ? null : legacyTemplateId(boundary["templateId"]);
    if (boundary["templateId"] !== null && templateId === null) return null;
    const path = V3_CONTROLS.includes(boundary["path"] as never) ? boundary["templateId"] === null ? boundary["path"] : null : v4ManagedPath(boundary["path"], templateId);
    const expected = expectation(boundary["expected"]);
    const proposed = expectation(boundary["proposed"]);
    if (path === null || expected === null || proposed === null || proposed.state !== "present") return null;
    return { path, templateId, expected, proposed };
  });
  if (boundaries.some(boundary => boundary === null)) return invalid("v4 boundary is not a closed path and signature pair");
  const strictBoundaries = boundaries.filter((boundary): boundary is NonNullable<typeof boundary> => boundary !== null);
  if (new Set(strictBoundaries.map(boundary => boundary.path)).size !== strictBoundaries.length) return invalid("v4 boundaries are duplicated");
  const outputs = plan["outputs"].map(output => {
    if (!isRecord(output) || !closedKeys(output, ["finalVaultRelativePath", "payloadDigest"]) || typeof output["finalVaultRelativePath"] !== "string") return null;
    const payloadDigest = digestValue(output["payloadDigest"]);
    const known = strictBoundaries.find(boundary => boundary.path === output["finalVaultRelativePath"]);
    return payloadDigest !== null && known !== undefined ? { path: output["finalVaultRelativePath"], payloadDigest } : null;
  });
  if (outputs.some(output => output === null)) return invalid("v4 output is not a sealed boundary");
  const strictOutputs = outputs.filter((output): output is NonNullable<typeof output> => output !== null);
  const present = strictBoundaries.filter(boundary => boundary.proposed.state === "present");
  if (present.length !== strictOutputs.length || present.some(boundary => {
    const proposed = boundary.proposed;
    return proposed.state !== "present" || !strictOutputs.some(output => output.path === boundary.path && output.payloadDigest === proposed.signature);
  })) return invalid("v4 outputs do not match present boundaries");
  let recomputed: Digest;
  try { recomputed = outputSetDigest("oms.contract-publish.output.v1", strictOutputs); } catch { return invalid("v4 outputs conflict"); }
  const planMaterial = { version: 1, transactionId: marker["transactionId"], approvalDigest, outputDigest, boundaries: strictBoundaries, outputs: strictOutputs.map(output => ({ finalVaultRelativePath: output.path, payloadDigest: output.payloadDigest })) };
  if (hashCanonical("oms.contract-publish.plan.v1", planMaterial) !== planDigest || recomputed !== outputDigest) return invalid("v4 plan or output digest does not match");
  for (const output of strictOutputs) {
    if (!observedPostimage(output.path, output.payloadDigest, input.observedOutputs)) return invalid("v4 observed postimage is missing or mismatched");
  }
  if (Object.keys(input.observedOutputs).some(path => !strictOutputs.some(output => output.path === path))) return invalid("v4 observed output is outside the sealed output set");
  const policy = strictBoundaries.find(boundary => boundary.path === ".oms/template-policy.json");
  if (policy === undefined || policy.proposed.state !== "present" || digestBytes(input.policyBytes) !== policy.proposed.signature) return invalid("v4 captured policy bytes do not match the policy write boundary");
  const snapshots = v4PolicySnapshots(input.policyBytes);
  const sources = new Map(snapshots);
  const unavailableSources: { templateId: string; reason: string }[] = [];
  for (const boundary of strictBoundaries) {
    if (boundary.templateId === null) continue;
    const snapshot = snapshots.get(boundary.templateId);
    if (snapshot === undefined) {
      unavailableSources.push({ templateId: boundary.templateId, reason: "v4 plan has no verified historical policy snapshot for this template" });
      continue;
    }
  }
  return {
    status: "verified",
    proof: proofFor({ format: "v4", policyDigest: policy.proposed.signature, sealDigest: approvalDigest, sources }),
    unavailableSources,
  };
}

/** Verifies supplied publication bytes. A verified result is consistency evidence, not authentication. */
export function verifyLegacyPublicationEvidence(input: LegacyPublicationEvidenceInput): LegacyPublicationVerification {
  if (!isRecord(input) || (input.format !== "v3" && input.format !== "v4")) return unavailable("publication format is unsupported");
  if (!(input.policyBytes instanceof Uint8Array) || input.policyBytes.byteLength > MAX_TEXT) return invalid("policy bytes are outside the evidence bound");
  if (!isRecord(input.observedOutputs) || Object.keys(input.observedOutputs).length > MAX_COLLECTION) return invalid("observed outputs are outside the evidence bound");
  try {
    return input.format === "v3" ? verifyV3(input) : verifyV4(input);
  } catch {
    return invalid("publication evidence is not a closed historical shape");
  }
}

/** Returns one sealed historical source. JSON, a boolean, or a mismatched policy cannot forge this result. */
export function verifiedLegacySource(proof: unknown, policyBytes: Uint8Array, templateId: string): { readonly identity: string; readonly path: string; readonly rawDigest: Digest; readonly historicalBytes: Uint8Array } | null {
  if (typeof proof !== "object" || proof === null || !(policyBytes instanceof Uint8Array)) return null;
  const record = proofs.get(proof as LegacyPublicationProof);
  if (record === undefined || record.policyDigest !== digestBytes(policyBytes)) return null;
  const source = record.sources.get(templateId);
  return source === undefined ? null : { identity: source.identity, path: source.path, rawDigest: source.rawDigest, historicalBytes: cloneBytes(source.historicalBytes) };
}
