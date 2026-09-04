import { createHash } from "node:crypto";

import type {
  AuthorityEntry,
  Diagnostic,
  Digest,
  InputV2,
  LogicalOperation,
  PlacementEntry,
  PlannedPhysicalOutput,
  TemplateBinding,
  TemplatePolicy,
} from "./types.js";

const encoder = new TextEncoder();
const DIGEST = /^sha256:[0-9a-f]{64}$/;

type CanonicalObject = { readonly [key: string]: Canonical };
type Canonical = null | boolean | number | string | readonly Canonical[] | CanonicalObject;

function isCanonicalArray(value: Canonical): value is readonly Canonical[] {
  return Array.isArray(value);
}

function scalar(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError("String contains an unpaired surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("String contains an unpaired surrogate");
    }
  }
  return value.normalize("NFC");
}

function compare(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function quote(value: string): string {
  let output = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"') output += '\\"';
    else if (character === "\\") output += "\\\\";
    else if (code <= 0x1f) output += `\\u${code.toString(16).padStart(4, "0")}`;
    else output += character;
  }
  return `${output}"`;
}

function normalize(value: unknown): Canonical {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return scalar(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError("Canonical JSON permits only safe integers other than -0");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("Canonical JSON value is unsupported");
  }

  const result: Record<string, Canonical> = {};
  for (const [key, member] of Object.entries(value)) {
    const normalizedKey = scalar(key);
    if (Object.hasOwn(result, normalizedKey)) {
      throw new TypeError("Object keys collide after NFC normalization");
    }
    result[normalizedKey] = normalize(member);
  }
  return result;
}

function serialize(value: Canonical): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return quote(value);
  if (isCanonicalArray(value)) return `[${value.map(serialize).join(",")}]`;

  const entries = Object.keys(value)
    .sort(compare)
    .map((key) => `${quote(key)}:${serialize(value[key]!)}`);
  return `{${entries.join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return serialize(normalize(value));
}

export function parseDigest(value: string): Digest {
  if (!DIGEST.test(value)) throw new TypeError("Digest must be lowercase sha256:<64hex>");
  return value as Digest;
}

export function frameHash(domain: string, value: unknown): Uint8Array {
  const domainBytes = encoder.encode(scalar(domain));
  const valueBytes = encoder.encode(canonicalJson(value));
  const prefix = encoder.encode("oms-hash-frame-v1\0");
  const length = (bytes: Uint8Array): Uint8Array => encoder.encode(`${bytes.byteLength}\0`);
  const parts = [prefix, length(domainBytes), domainBytes, length(valueBytes), valueBytes];
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function hashCanonical(domain: string, value: unknown): Digest {
  return `sha256:${createHash("sha256").update(frameHash(domain, value)).digest("hex")}` as Digest;
}

function authorities(entries: readonly AuthorityEntry[]): AuthorityEntry[] {
  return [...entries]
    .sort((left, right) => compare(left.kind, right.kind) || compare(left.logicalId, right.logicalId) || compare(left.vaultRelativePath ?? "", right.vaultRelativePath ?? ""))
    .map((entry) => ({
      ...entry,
      vaultRelativePath: entry.vaultRelativePath ?? null,
      contentDigest: parseDigest(entry.contentDigest),
    }));
}

function placements(entries: readonly PlacementEntry[]): PlacementEntry[] {
  const result = [...entries].sort((left, right) => compare(left.templateId, right.templateId));
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1]!.templateId === result[index]!.templateId) {
      throw new TypeError("TEMPLATE_ID_DUPLICATE");
    }
  }
  return result;
}

/** Builds the authority and placement payload shared by registration, resolution, and repair. */
export function templateInput(
  policy: TemplatePolicy,
  controls: {
    readonly policy: Digest;
    readonly taxonomy: Digest;
    readonly obsidianTypes: Digest;
    readonly obsidianTypesPath: string;
  },
  bindings: readonly TemplateBinding[],
  sourceDigest: (binding: TemplateBinding) => Digest,
): InputV2 {
  const authority: AuthorityEntry[] = [
    { kind: "policy", logicalId: "template-policy", vaultRelativePath: ".oms/template-policy.json", contentDigest: controls.policy },
    { kind: "taxonomy", logicalId: "taxonomy", vaultRelativePath: ".oms/taxonomy.json", contentDigest: controls.taxonomy },
    { kind: "obsidian-types", logicalId: "obsidian-types", vaultRelativePath: controls.obsidianTypesPath, contentDigest: controls.obsidianTypes },
    ...bindings.map((binding) => ({ kind: "template" as const, logicalId: binding.templateId, vaultRelativePath: binding.sourcePath, contentDigest: sourceDigest(binding) })),
  ];
  authority.sort((left, right) => left.kind.localeCompare(right.kind) || left.logicalId.localeCompare(right.logicalId));
  return {
    version: 2,
    authority,
    placement: bindings.map((binding) => ({
      templateId: binding.templateId,
      destinationClass: binding.destinationClass,
      templateFolder: binding.destinationClass === "managed-default" ? policy.templateFolder : null,
      sourcePath: binding.sourcePath,
    })),
  };
}

export function inputDigest(input: InputV2): Digest {
  if (input.version !== 2) throw new TypeError("InputV2 version must be 2");
  return hashCanonical("oms.template-migration.input.v2", {
    version: 2,
    authority: authorities(input.authority),
    placement: placements(input.placement),
  });
}

function diagnostic(value: Diagnostic): Record<string, unknown> {
  return {
    code: value.code,
    templateId: value.templateId ?? null,
    path: value.path ?? null,
    field: value.field ?? null,
    message: value.message ?? null,
    extensions: value.extensions ?? null,
  };
}

export function approvalDigest(input: Digest, operations: readonly LogicalOperation[], diagnostics: readonly Diagnostic[], cleanup?: { readonly path: string; readonly expectedDigest: Digest }): Digest {
  parseDigest(input);
  const canonicalOperations = [...operations]
    .sort((left, right) =>
      compare(left.kind, right.kind) ||
      compare(left.templateId, right.templateId) ||
      compare(left.destinationClass, right.destinationClass) ||
      compare(left.stableRelativeSuffix ?? "", right.stableRelativeSuffix ?? "") ||
      compare(left.payloadDigest, right.payloadDigest),
    )
    .map((operation) => ({
      kind: operation.kind,
      templateId: operation.templateId,
      destinationClass: operation.destinationClass,
      payloadDigest: parseDigest(operation.payloadDigest),
      stableRelativeSuffix: operation.stableRelativeSuffix ?? null,
    }));
  const canonicalDiagnostics = [...diagnostics]
    .sort((left, right) =>
      compare(left.code, right.code) ||
      compare(left.templateId ?? "", right.templateId ?? "") ||
      compare(left.path ?? "", right.path ?? "") ||
      compare(left.field ?? "", right.field ?? "") ||
      compare(canonicalJson(diagnostic(left)), canonicalJson(diagnostic(right))),
    )
    .map(diagnostic);
  return hashCanonical("oms.template-migration.approval.v2", {
    inputDigest: input,
    operations: canonicalOperations,
    diagnostics: canonicalDiagnostics,
    cleanup: cleanup === undefined ? null : { path: cleanup.path, expectedDigest: parseDigest(cleanup.expectedDigest) },
  });
}

export function outputDigest(outputs: readonly PlannedPhysicalOutput[]): Digest {
  const unique = new Map<string, Digest>();
  for (const output of outputs) {
    const payloadDigest = parseDigest(output.payloadDigest);
    const existing = unique.get(output.finalVaultRelativePath);
    if (existing !== undefined && existing !== payloadDigest) {
      throw new TypeError("MIGRATION_OUTPUT_CONFLICT");
    }
    unique.set(output.finalVaultRelativePath, payloadDigest);
  }

  const canonicalOutputs = [...unique.entries()]
    .map(([finalVaultRelativePath, payloadDigest]) => ({ finalVaultRelativePath, payloadDigest }))
    .sort((left, right) => compare(left.finalVaultRelativePath, right.finalVaultRelativePath) || compare(left.payloadDigest, right.payloadDigest));
  return hashCanonical("oms.template-migration.output.v1", { outputs: canonicalOutputs });
}
