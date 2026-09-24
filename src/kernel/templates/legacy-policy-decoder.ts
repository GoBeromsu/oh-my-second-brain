import { parseLegacyJson } from "./legacy-json.js";
import { digestBytes } from "./canonical.js";
import { evaluateContractV5 } from "./contract-check.js";
import { composeContractV5, parseContractPolicyV5, type ContractPolicyV5, type FieldRefV5, type PropertyDefinitionV5, type RegisteredContractV5, type ReviewRequiredContractV5 } from "./contract-v5.js";
import { verifiedLegacySource } from "./legacy-publication-evidence.js";
import { normalizeTemplateFolderPath, normalizeTemplateSourcePath, validateTemplateId } from "./paths.js";
import { parseTemplatePolicy } from "./policy.js";
import type { Digest, ObsidianContractType } from "./types.js";

export type MemberDisposition = "mapped" | "archived" | "review-required";
export interface MemberInventoryEntry {
  readonly path: string;
  readonly disposition: MemberDisposition;
  readonly reason: string;
}
export interface LegacyPolicyArchive {
  /** A proposed archive, not a claim that any bytes have been persisted. */
  readonly bytes: Uint8Array;
  readonly digest: Digest;
}
export interface LegacyPolicyDecoding {
  readonly policy: ContractPolicyV5;
  readonly archive: LegacyPolicyArchive;
  readonly inventory: readonly MemberInventoryEntry[];
  readonly reasons: readonly string[];
  readonly selectionBlocked: boolean;
  readonly automaticMigrationBlocked: boolean;
  readonly sourceVersion: 3 | 4 | null;
}

const TYPES = new Set<ObsidianContractType>(["text", "string", "select", "number", "boolean", "checkbox", "date", "datetime", "list", "multitext", "multi", "tags", "aliases", "file"]);
const LIST_TYPES = new Set(["list", "multitext", "multi", "tags", "aliases"]);
const STRING_TYPES = new Set(["text", "string", "select", "file"]);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MEMBERS = 50_000;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function token(value: string): string { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }
function fieldPath(parent: string, name: string): string { return `${parent}/${token(name)}`; }
function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
function dictionary<T>(): Record<string, T> { return Object.create(null) as Record<string, T>; }
function canonicalTemplateId(id: string): boolean {
  try { return validateTemplateId(id) === id; }
  catch { return false; }
}

interface Shape {
  readonly members?: Readonly<Record<string, Shape>>;
  readonly values?: Shape;
  readonly items?: Shape;
  readonly data?: true;
}
const scalar: Shape = {};
const data: Shape = { data: true };
const object = (members: Readonly<Record<string, Shape>>): Shape => ({ members });
const mapping = (values: Shape): Shape => ({ values });
const array = (items: Shape): Shape => ({ items });
const extensions = object({});
const v3Field = object({ type: scalar, required: scalar, normalize: scalar, allowedValues: array(scalar), format: scalar, default: object({ kind: scalar, value: data, token: scalar }), allowTemplateDefault: scalar, immutable: scalar, intent: scalar, filledBy: scalar, extensions });
const v3Contract = object({ fields: mapping(v3Field), intent: scalar, views: array(object({ name: scalar, keys: array(scalar), extensions })), extensions });
const v3Content = object({ version: scalar, nodes: array(object({ kind: scalar, level: scalar, text: scalar, required: scalar, span: object({ start: scalar, end: scalar, startLine: scalar, endLine: scalar }), anchorMaterial: scalar, anchorDigest: scalar, extensions })), order: scalar, eol: scalar, bom: scalar, finalNewline: scalar, bodySignature: scalar, wellFormed: scalar, diagnostics: array(data), extensions });
const v3Binding = object({ templateId: scalar, destinationClass: scalar, renderer: scalar, sourceFolder: scalar, sourcePath: scalar, contract: scalar, naming: scalar, content: v3Content, approvedSourceSignature: scalar, approvedBodySignature: scalar, extensions });
const v3Shape = object({ version: scalar, templateFolders: array(object({ path: scalar, default: scalar, extensions })), defaultTemplate: scalar, base: object({ fields: mapping(v3Field), extensions }), contracts: mapping(v3Contract), templates: mapping(v3Binding), writers: object({ field: scalar, identifiers: array(scalar), extensions }), extensions });
const v4Property = object({ type: scalar, intent: scalar, allowedValues: array(scalar), format: scalar, extensions });
const v4Field = object({ property: scalar, required: scalar, allowedValues: array(scalar), extensions });
const v4Layer = object({ templateId: scalar, templatePath: scalar, approvedMarkdown: scalar, approvedMarkdownDigest: scalar, fields: mapping(v4Field), headings: array(object({ headingId: scalar, title: scalar, level: scalar, required: scalar, extensions })), headingOrder: scalar, semanticCriteria: array(data), source: object({ path: scalar, identity: scalar, rawDigest: scalar, extensions }), extensions });
const v4Shape = object({ version: scalar, properties: mapping(v4Property), default: v4Layer, templates: mapping(v4Layer), completion: object({ retryBudget: scalar, agentRepair: object({ enabled: scalar, contexts: array(scalar), extensions }), extensions }), extensions });

/** Each real JSON node receives a disposition; unknown subtrees are never skipped. */
class Inventory {
  readonly entries: MemberInventoryEntry[] = [];
  private readonly ranges = new Map<string, { start: number; end: number }>();
  private readonly unresolved = new Set<string>();
  constructor(value: unknown, shape: Shape) { this.walk(value, "", shape, 0); }
  private flag(path: string): void {
    this.unresolved.add(path);
    while (path !== "") {
      path = path.slice(0, path.lastIndexOf("/"));
      this.unresolved.add(path);
    }
  }
  private walk(value: unknown, path: string, shape: Shape | undefined, depth: number): void {
    if (depth > 64 || path.length > 8192 || this.entries.length >= MAX_MEMBERS) throw new Error("LEGACY_POLICY_OVERSIZE: inventory exceeds its explicit bound");
    const validShape = shape !== undefined && (shape.data === true || (Array.isArray(value) ? shape.items !== undefined : record(value) ? shape.members !== undefined || shape.values !== undefined : shape.members === undefined && shape.values === undefined && shape.items === undefined));
    const start = this.entries.length;
    this.entries.push({ path, disposition: validShape ? "archived" : "review-required", reason: validShape ? "recognized historical data retained in proposed raw archive" : "unknown member or malformed historical shape" });
    if (!validShape) this.flag(path);
    if (Array.isArray(value)) value.forEach((item, index) => this.walk(item, `${path}/${index}`, validShape ? shape?.data ? data : shape?.items : undefined, depth + 1));
    else if (record(value)) for (const [key, item] of Object.entries(value)) {
      const child = validShape ? shape?.data ? data : shape?.values ?? (shape?.members !== undefined && Object.hasOwn(shape.members, key) ? shape.members[key] : undefined) : undefined;
      this.walk(item, fieldPath(path, key), child, depth + 1);
    }
    this.ranges.set(path, { start, end: this.entries.length });
  }
  has(path: string): boolean { return this.unresolved.has(path); }
  mark(path: string, disposition: MemberDisposition, reason: string, descendants = true): void {
    const range = this.ranges.get(path);
    if (disposition === "review-required") this.flag(path);
    if (range === undefined) return;
    for (let index = range.start; index < (descendants ? range.end : range.start + 1); index++) {
      const entry = this.entries[index]!;
      if (entry.disposition !== "review-required" || disposition === "review-required") this.entries[index] = { path: entry.path, disposition, reason };
    }
  }
}

function pending(digest: Digest, version: 3 | 4 | null, member: string, reasons: readonly string[]): ReviewRequiredContractV5 {
  return { status: "review-required", reasons: unique(reasons).slice(0, 24), legacy: { archiveDigest: digest, member, format: version === null ? "oms.legacy-policy.unknown" : `oms.legacy-policy.v${version}` } };
}
function ambiguous(bytes: Uint8Array, members: "duplicate" | "uninspectable"): LegacyPolicyDecoding {
  const digest = digestBytes(bytes);
  const reason = members === "duplicate"
    ? "duplicate JSON members were overwritten before inventory; raw bytes are archived and not exhaustively interpreted"
    : "JSON members could not be exhaustively accounted; raw bytes are archived and not exhaustively interpreted";
  return {
    sourceVersion: null,
    policy: parseContractPolicyV5({ version: 5, revision: 0, properties: {}, common: pending(digest, null, "", [reason]), templates: {} }),
    archive: { bytes: Uint8Array.from(bytes), digest },
    inventory: [{ path: "", disposition: "review-required", reason }],
    reasons: [reason],
    selectionBlocked: true,
    automaticMigrationBlocked: true,
  };
}
function result(version: 3 | 4, bytes: Uint8Array, inventory: Inventory, properties: Record<string, PropertyDefinitionV5>, commonFields: Record<string, FieldRefV5>, commonReasons: readonly string[], templates: Record<string, RegisteredContractV5>, headingOrder: "unordered" | "strict" = "unordered"): LegacyPolicyDecoding {
  const digest = digestBytes(bytes);
  const selectionBlocked = commonReasons.length > 0;
  const commonPath = version === 3 ? "/base" : "/default";
  if (selectionBlocked) inventory.mark(commonPath, "review-required", "common semantics require explicit review");
  else {
    inventory.mark(commonPath, "mapped", "consumed by the explicit common contract", false);
    inventory.mark(`${commonPath}/fields`, "mapped", "consumed by explicit field and property rules");
    if (version === 4) {
      inventory.mark("/default/headings", "mapped", "empty historical heading array");
      inventory.mark("/default/headingOrder", "mapped", "historical order retained explicitly");
    }
  }
  const common = selectionBlocked ? pending(digest, version, commonPath, commonReasons) : { status: "active" as const, fields: commonFields, headings: [], headingOrder, additionalHeadings: "allow" as const };
  const policy = parseContractPolicyV5({ version: 5, revision: 0, properties, common, templates });
  return { sourceVersion: version, policy, archive: { bytes: Uint8Array.from(bytes), digest }, inventory: inventory.entries, reasons: unique(commonReasons), selectionBlocked, automaticMigrationBlocked: selectionBlocked || inventory.has("") || Object.values(templates).some(item => item.status !== "active") };
}

/** Finite closed values can prove that a stronger intrinsic V5 type adds no rejection. */
function intrinsicEquivalent(type: ObsidianContractType, values: readonly string[] | undefined, format?: "url"): boolean {
  if (values === undefined) return false;
  const property: PropertyDefinitionV5 = { type, ...(format === undefined ? {} : { format }) };
  const contract = composeContractV5(parseContractPolicyV5({ version: 5, revision: 0, properties: { value: property }, common: { status: "active", fields: { value: {} } }, templates: {} }), null);
  return values.every(value => evaluateContractV5({ value: type === "tags" ? [value] : value }, "", contract).valid);
}
function v3Rules(raw: Record<string, unknown>): { property?: PropertyDefinitionV5; field?: FieldRefV5; reasons: string[] } {
  const reasons: string[] = [];
  if (!TYPES.has(raw.type as ObsidianContractType)) return { reasons: ["field has no valid historical type authority"] };
  const type = raw.type as ObsidianContractType;
  if (raw.required !== undefined && typeof raw.required !== "boolean") reasons.push("required is not boolean");
  if (raw.intent !== undefined && (typeof raw.intent !== "string" || raw.intent.trim() === "")) reasons.push("intent is not a nonempty string");
  const allowed = strings(raw.allowedValues) ? raw.allowedValues : undefined;
  if (Object.hasOwn(raw, "allowedValues") && (allowed === undefined || new Set(allowed).size !== allowed.length)) reasons.push("allowedValues is not a unique string set");
  if (raw.format !== undefined && (raw.format !== "url" || !STRING_TYPES.has(type))) reasons.push("format has no equivalent type-bound rule");
  for (const key of ["normalize", "default", "immutable", "filledBy", "allowTemplateDefault"]) if (Object.hasOwn(raw, key)) reasons.push(`${key} requires explicit rule-change review`);
  if (allowed !== undefined && LIST_TYPES.has(type)) reasons.push("v3 scalar allowedValues validation is not per-member list validation");
  if (["tags", "date", "datetime"].includes(type) && !intrinsicEquivalent(type, allowed)) reasons.push("intrinsic type validation differs from historical admission");
  if (raw.format === "url" && !intrinsicEquivalent(type, allowed, "url")) reasons.push("v3 create and saved-note URL admission differ");
  if (reasons.length > 0) return { reasons };
  const property: PropertyDefinitionV5 = { type, ...(typeof raw.intent === "string" ? { intent: raw.intent } : {}), ...(raw.format === "url" ? { format: "url" as const } : {}), ...(allowed === undefined ? {} : { allowedValues: [...allowed], valuePolicy: "closed" as const }) };
  const field: FieldRefV5 = { required: raw.required === true, ...(allowed === undefined ? {} : { allowedValues: [...allowed], valuePolicy: "closed" as const }) };
  return { property, field, reasons };
}
function legacyConflict(base: Record<string, unknown>, child: Record<string, unknown>): boolean {
  return base.required === true && child.required === false || base.immutable === true && child.immutable === false || base.type !== undefined && child.type !== undefined && base.type !== child.type || strings(base.allowedValues) && strings(child.allowedValues) && child.allowedValues.some(value => !(base.allowedValues as string[]).includes(value));
}

function decodeV3(root: Record<string, unknown>, bytes: Uint8Array, inventory: Inventory, proof: unknown): LegacyPolicyDecoding {
  const properties = dictionary<PropertyDefinitionV5>();
  const fields = dictionary<FieldRefV5>();
  const templates = dictionary<RegisteredContractV5>();
  const reasons: string[] = [];
  const digest = digestBytes(bytes);
  const base = record(root.base) && record(root.base.fields) ? root.base.fields : undefined;
  if (base === undefined) reasons.push("base.fields must be an object");
  if (!record(root.contracts) || !record(root.templates) || !Array.isArray(root.templateFolders)) reasons.push("historical registry shape is invalid");
  const commonContract = record(root.contracts) ? root.contracts.base : undefined;
  if (!record(commonContract) || !record(commonContract.fields) || Object.keys(commonContract.fields).length !== 0 || !Array.isArray(commonContract.views) || commonContract.views.length !== 0 || typeof commonContract.intent !== "string" || inventory.has("/contracts/base")) {
    inventory.mark("/contracts", "review-required", "a valid vacuous contracts.base is required to prove automatic common admission");
  }
  if (inventory.has("/base")) reasons.push("unresolved common member");
  for (const key of Object.keys(root)) if (!Object.hasOwn(v3Shape.members!, key)) reasons.push("unknown root semantics");
  for (const key of ["writers", "defaultTemplate"]) if (Object.hasOwn(root, key)) { reasons.push(`${key} requires explicit review`); inventory.mark(`/${key}`, "review-required", "removed historical behavior"); }
  const folderPaths = new Set<string>();
  let defaultFolders = 0;
  if (Array.isArray(root.templateFolders) && root.templateFolders.length > 0) inventory.mark("/templateFolders", "review-required", "discovery and default selection require a separately verified portable-settings mapping");
  if (Array.isArray(root.templateFolders)) root.templateFolders.forEach((folder, index) => {
    const at = `/templateFolders/${index}`;
    const value = record(folder) ? folder.path : undefined;
    try {
      if (typeof value !== "string" || value.includes("..") || normalizeTemplateFolderPath(value) !== value || folderPaths.has(value)) throw new Error("unsafe or repeated discovery path");
      folderPaths.add(value);
      if (record(folder) && Object.hasOwn(folder, "default") && typeof folder.default !== "boolean") throw new Error("default folder flag must be boolean");
      if (record(folder) && folder.default === true && ++defaultFolders > 1) throw new Error("multiple default discovery folders");
    } catch { inventory.mark(at, "review-required", "unsafe, ambiguous or malformed historical discovery folder"); }
  });
  for (const [name, raw] of Object.entries(base ?? {})) {
    const at = fieldPath("/base/fields", name);
    const converted = record(raw) ? v3Rules(raw) : { reasons: ["field must be an object"] };
    if (inventory.has(at) || converted.reasons.length > 0 || converted.property === undefined || converted.field === undefined) {
      reasons.push(...(converted.reasons.length ? converted.reasons : ["unresolved common field"]));
      inventory.mark(at, "review-required", "common field is not equivalent");
    } else { properties[name] = converted.property; fields[name] = { ...converted.field, property: name }; }
  }
  if (record(root.contracts)) for (const [name, raw] of Object.entries(root.contracts)) {
    const at = fieldPath("/contracts", name);
    if (!record(raw) || !record(raw.fields) || typeof raw.intent !== "string" || !Array.isArray(raw.views)) { inventory.mark(at, "review-required", "malformed inactive contract"); continue; }
    for (const [field, value] of Object.entries(raw.fields)) {
      const parent = base !== undefined && record(base[field]) ? base[field] : {};
      if (!record(value) || legacyConflict(parent, value) || v3Rules({ ...parent, ...value }).reasons.length > 0) inventory.mark(fieldPath(`${at}/fields`, field), "review-required", "inactive contract requires explicit review; common remains unchanged");
    }
    if (name !== "base" || Object.keys(raw.fields).length > 0 || raw.views.length > 0) inventory.mark(at, "review-required", "reusable individual semantics have no registered V5 source mapping");
  }
  if (record(root.templates)) for (const [id, raw] of Object.entries(root.templates)) {
    const at = fieldPath("/templates", id);
    if (!canonicalTemplateId(id)) {
      inventory.mark(at, "review-required", "invalid individual identity retained only in the raw archive");
      continue;
    }
    const issues = ["v3 naming and renderer behavior require explicit rule-change review"];
    if (record(raw)) {
      const source = verifiedLegacySource(proof, bytes, id);
      if (source === null || source.path !== raw.sourcePath || digestBytes(source.historicalBytes) !== source.rawDigest) issues.push("historical source snapshot is unavailable");
      if (raw.templateId !== id || typeof raw.contract !== "string" || !record(root.contracts) || !Object.hasOwn(root.contracts, raw.contract)) issues.push("binding identity or contract reference is invalid");
      try { if (typeof raw.sourcePath !== "string" || normalizeTemplateSourcePath(raw.sourcePath) !== raw.sourcePath) issues.push("source path is not canonical"); }
      catch { issues.push("source path is unsafe"); }
    } else issues.push("binding is not an object");
    inventory.mark(at, "review-required", issues.join("; "));
    templates[id] = pending(digest, 3, at, issues);
  }
  return result(3, bytes, inventory, properties, fields, reasons, templates);
}

type LegacyV4 = ReturnType<typeof parseTemplatePolicy>;
type LegacyLayer = LegacyV4["default"];
function layerIssues(layer: LegacyLayer): string[] {
  const reasons: string[] = [];
  if (layer.semanticCriteria.length > 0) reasons.push("semantic criteria require explicit rule-change review");
  if (layer.headings.length > 0) reasons.push("historical heading admission and diagnostics are not yet proven equivalent");
  if (layer.approvedMarkdown.trim() !== "") reasons.push("approved Markdown guidance cannot be silently removed or become an editable source");
  return reasons;
}
function effectiveFields(policy: LegacyV4, layer?: LegacyLayer): Record<string, FieldRefV5> {
  const fields = dictionary<FieldRefV5>();
  const parent = policy.default.fields;
  for (const name of new Set([...Object.keys(parent), ...Object.keys(layer?.fields ?? {})])) {
    const base = parent[name];
    const child = layer?.fields[name];
    const property = child?.property ?? base!.property;
    const definition = policy.properties[property]!;
    const allowed = child?.allowedValues ?? base?.allowedValues ?? definition.allowedValues;
    fields[name] = { property, required: base?.required === true || child?.required === true, ...(allowed === undefined ? { valuePolicy: "free" as const } : { valuePolicy: "closed" as const, allowedValues: [...allowed] }) };
  }
  return fields;
}
function fieldIssues(fields: Readonly<Record<string, FieldRefV5>>, policy: LegacyV4, inventory: Inventory): string[] {
  const issues: string[] = [];
  for (const field of Object.values(fields)) {
    const property = field.property!;
    const definition = policy.properties[property]!;
    if (inventory.has(fieldPath("/properties", property))) issues.push("referenced property contains unresolved members");
    if (["tags", "datetime"].includes(definition.type) && !intrinsicEquivalent(definition.type, field.allowedValues ?? undefined)) issues.push("intrinsic type validation differs from historical admission");
  }
  return unique(issues);
}
function decodeV4(root: Record<string, unknown>, bytes: Uint8Array, inventory: Inventory, proof: unknown): LegacyPolicyDecoding {
  const digest = digestBytes(bytes);
  const properties = dictionary<PropertyDefinitionV5>();
  const templates = dictionary<RegisteredContractV5>();
  const reasons: string[] = [];
  let base: LegacyV4;
  try {
    if (!record(root.templates)) throw new Error("templates must be an object");
    // Validate the actual common and pool, never manufacture an empty common on an individual failure.
    base = parseTemplatePolicy({ ...root, templates: {} });
  } catch (error) {
    inventory.mark("", "review-required", "historical common or pool is invalid");
    return result(4, bytes, inventory, properties, dictionary<FieldRefV5>(), [error instanceof Error ? error.message : "historical common is invalid"], templates);
  }
  for (const [name, property] of Object.entries(base.properties)) {
    properties[name] = { type: property.type, intent: property.intent, ...(property.format === undefined ? {} : { format: property.format }), ...(property.allowedValues === undefined ? {} : { allowedValues: [...property.allowedValues], valuePolicy: "closed" as const }) };
    for (const key of ["type", "intent", "format", "allowedValues"]) inventory.mark(fieldPath(fieldPath("/properties", name), key), "mapped", "consumed by the V5 property pool");
  }
  const commonFields = effectiveFields(base);
  if (inventory.has("/default")) reasons.push("unresolved common members");
  for (const key of Object.keys(root)) if (!Object.hasOwn(v4Shape.members!, key)) reasons.push("unknown root semantics");
  reasons.push(...layerIssues(base.default), ...fieldIssues(commonFields, base, inventory));
  if (Object.hasOwn(root, "completion")) {
    inventory.mark("/completion", "review-required", "completion and repair controls require explicit rule-change review");
  }
  for (const [id, raw] of Object.entries(root.templates as Record<string, unknown>)) {
    const at = fieldPath("/templates", id);
    if (!canonicalTemplateId(id)) {
      inventory.mark(at, "review-required", "invalid individual identity retained only in the raw archive");
      continue;
    }
    const issues: string[] = [];
    let parsed: LegacyV4 | undefined;
    try { parsed = parseTemplatePolicy({ ...root, templates: { [id]: raw } }); }
    catch (error) { issues.push(error instanceof Error ? error.message : "historical individual is invalid"); }
    const layer = parsed?.templates[id];
    const source = verifiedLegacySource(proof, bytes, id);
    let fields = dictionary<FieldRefV5>();
    if (inventory.has(at)) issues.push("unresolved individual members");
    if (layer !== undefined && parsed !== undefined) {
      fields = effectiveFields(parsed, layer);
      issues.push(...layerIssues(layer), ...fieldIssues(fields, parsed, inventory));
      if (base.default.headingOrder === "strict" && layer.headingOrder === "unordered") issues.push("historical heading-order weakening requires review");
      if (layer.source === undefined || source === null || source.identity !== layer.source.identity || source.path !== layer.source.path || source.rawDigest !== layer.source.rawDigest || digestBytes(source.historicalBytes) !== layer.source.rawDigest) issues.push("verified historical policy snapshot does not bind this source");
    } else issues.push("individual could not be parsed");
    if (issues.length > 0 || source === null || layer === undefined) {
      inventory.mark(at, "review-required", "individual needs explicit review");
      templates[id] = pending(digest, 4, at, issues.length > 0 ? issues : ["source snapshot is unavailable"]);
    } else {
      inventory.mark(at, "mapped", "sealed historical field rules materialized without weakening", false);
      for (const key of ["fields", "headings", "headingOrder", "source"]) inventory.mark(`${at}/${key}`, "mapped", "consumed by the explicit registered contract");
      templates[id] = { status: "active", source: { identity: source.identity, path: source.path, rawDigest: source.rawDigest }, fields, headings: [], headingOrder: layer.headingOrder ?? base.default.headingOrder ?? "unordered", additionalHeadings: "allow" };
    }
  }
  return result(4, bytes, inventory, properties, commonFields, reasons, templates, base.default.headingOrder ?? "unordered");
}

/** Pure migration proposal. No source reads, publication, retroapproval, or ordinary-note writes. */
export function decodeLegacyPolicy(policyBytes: string | Uint8Array, proof?: unknown): LegacyPolicyDecoding {
  if (typeof policyBytes !== "string" && !(policyBytes instanceof Uint8Array)) throw new Error("LEGACY_POLICY_INVALID: policy input must be an exact string or bytes");
  const bytes = typeof policyBytes === "string" ? Buffer.from(policyBytes, "utf8") : Uint8Array.from(policyBytes);
  if (bytes.byteLength > MAX_BYTES) throw new Error("LEGACY_POLICY_OVERSIZE: policy exceeds 8 MiB");
  let parsed: ReturnType<typeof parseLegacyJson>;
  try { parsed = parseLegacyJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("LEGACY_POLICY_INVALID: policy must be UTF-8 JSON"); }
  if (parsed.members !== "unique") return ambiguous(bytes, parsed.members);
  const decoded = parsed.value;
  if (!record(decoded) || (decoded.version !== 3 && decoded.version !== 4)) throw new Error("LEGACY_POLICY_VERSION_UNSUPPORTED: only versions 3 and 4 are migration inputs");
  const version = decoded.version;
  const inventory = new Inventory(decoded, version === 3 ? v3Shape : v4Shape);
  try { return version === 3 ? decodeV3(decoded, bytes, inventory, proof) : decodeV4(decoded, bytes, inventory, proof); }
  catch (error) {
    // A known but unrepresentable document never turns into an empty active policy.
    inventory.mark("", "review-required", "historical policy could not be represented safely");
    return result(version, bytes, inventory, dictionary<PropertyDefinitionV5>(), dictionary<FieldRefV5>(), [error instanceof Error ? error.message : "historical policy cannot be represented"], dictionary<RegisteredContractV5>());
  }
}
