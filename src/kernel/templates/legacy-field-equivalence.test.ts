import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { parseNote } from "../conventions/frontmatter.js";
import { evaluateContractV5 } from "./contract-check.js";
import { composeContractV5 } from "./contract-v5.js";
import { decodeLegacyPolicy, type LegacyPolicyDecoding } from "./legacy-policy-decoder.js";
import { admitV3Note, evaluateV3Policy, type LegacyAdmission, type LegacyDisposition } from "../../../test/fixtures/contract-migrations/legacy-oracle.js";

/**
 * Historical field admission only, not full writing or authentication.
 * Automatic equivalence is claimed only for named proven-safe rules whose decoder reports automaticMigrationBlocked:false.
 * Review-required rules preserve their archive and are not counted as admission equivalence.
 * Matrix receipt, not an assertion target: 12 proven-safe rules, 14 review rules, 2 rejected policies,
 * one historically accepted array-shaped base conservatively held for review,
 * 6 YAML numeric edges. Unsupported: v4, registration, headings, normalize/default/immutable/filledBy/allowTemplateDefault,
 * unproven tags/date/datetime/url, v3 list closure, invented invalid-policy admission, reason prose.
 * Oracle cannot represent bigint or NaN/Infinity inside JSON policy bytes.
 */

const encoder = new TextEncoder();
type Scalar = string | number | boolean | null;
type NoteValue = Scalar | readonly NoteValue[] | { readonly [key: string]: NoteValue };
type Frontmatter = Readonly<Record<string, NoteValue>>;
type Probe = readonly [string, Frontmatter];
type Rule = { readonly type: string; readonly required?: boolean; readonly allowedValues?: readonly string[]; readonly format?: "url"; readonly intent?: string };

const PROVEN_SAFE = [
  ["text", { type: "text" }],
  ["string", { type: "string" }],
  ["select", { type: "select", allowedValues: ["open", "closed"] }],
  ["number", { type: "number" }],
  ["boolean", { type: "boolean" }],
  ["checkbox", { type: "checkbox" }],
  ["file", { type: "file" }],
  ["list", { type: "list" }],
  ["multi", { type: "multi" }],
  ["multitext", { type: "multitext" }],
  ["aliases", { type: "aliases" }],
  ["closed-text", { type: "text", allowedValues: ["kept", "other"] }],
] as const satisfies readonly (readonly [string, Rule])[];

const CLOSED_INTRINSIC = [
  ["closed-date", { type: "date", allowedValues: ["2024-02-29", "2024-01-01"] }],
  ["closed-datetime", { type: "datetime", allowedValues: ["2024-02-29T00:00:00Z", "2024-01-01T00:00:00Z"] }],
  ["closed-url", { type: "text", format: "url", allowedValues: ["https://example.org", "http://example.org"] }],
] as const satisfies readonly (readonly [string, Rule])[];

const REVIEW_REQUIRED = [
  ["normalize-trim", { type: "text", normalize: "trim" }],
  ["default-literal", { type: "text", default: { kind: "literal", value: "kept" } }],
  ["immutable", { type: "text", immutable: true }],
  ["filled-by", { type: "text", filledBy: "user" }],
  ["template-default", { type: "text", allowTemplateDefault: true }],
  ["tags-without-closed-proof", { type: "tags" }],
  ["closed-tags", { type: "tags", allowedValues: ["flower", "topic/sub-topic"] }],
  ["date-without-closed-proof", { type: "date" }],
  ["datetime-without-closed-proof", { type: "datetime" }],
  ["url-without-closed-proof", { type: "text", format: "url" }],
  ["blank-intent", { type: "text", intent: " " }],
  ["duplicate-allowed-values", { type: "select", allowedValues: ["open", "open"] }],
  ["non-boolean-required", { type: "text", required: "yes" }],
  ["unknown-type", { type: "markdown" }],
] as const;

const REJECTED = [
  ["unsafe-folder", { version: 3, templateFolders: [{ path: "../secret" }], base: { fields: { status: { type: "text" } } }, contracts: { base: { intent: "Base.", fields: {}, views: [] } }, templates: {} }],
  ["version-marker", { version: 3, templateFolder: "Templates", templateFolders: [], base: { fields: {} }, contracts: {}, templates: {} }],
] as const;

const SCALAR_PROBES: readonly Probe[] = [
  ["absent", {}],
  ["null", { value: null }],
  ["empty", { value: "" }],
  ["whitespace", { value: " \t" }],
  ["false", { value: false }],
  ["zero", { value: 0 }],
  ["string", { value: "kept" }],
  ["number", { value: 1 }],
  ["boolean", { value: true }],
  ["array", { value: ["kept"] }],
  ["object", { value: { kept: true } }],
];
const REQUIRED_PROBES: readonly Probe[] = [
  ["absent", {}],
  ["null", { value: null }],
  ["empty", { value: "" }],
  ["whitespace", { value: " \t" }],
  ["false", { value: false }],
  ["zero", { value: 0 }],
  ["present", { value: "kept" }],
];
const CLOSED_PROBES: readonly Probe[] = [
  ["absent", {}],
  ["empty", { value: "" }],
  ["member", { value: "open" }],
  ["other-member", { value: "closed" }],
  ["outside", { value: "other" }],
  ["lookalike", { value: 0 }],
];
const LIST_PROBES: readonly Probe[] = [
  ["empty", { value: [] }],
  ["strings", { value: ["kept", "other"] }],
  ["numbers", { value: [0, 1] }],
  ["mixed", { value: [0, false, "kept", null] }],
  ["nested", { value: [["kept"]] }],
  ["scalar", { value: "kept" }],
];
const DATE_PROBES: readonly Probe[] = ["2024-02-29", "2024-01-01", "2023-02-29", "2024-13-01", "20240229", "2024-2-29", " 2024-02-29"].map(value => [JSON.stringify(value), { value }] as const);
const TIME_PROBES: readonly Probe[] = ["2024-02-29T00:00:00Z", "2024-01-01T00:00:00Z", "2024-02-29", "2024-02-30T00:00:00Z", "not-a-time"].map(value => [JSON.stringify(value), { value }] as const);
const URL_PROBES: readonly Probe[] = ["https://example.org", "http://example.org", "javascript:alert(1)", "example.org", ""].map(value => [JSON.stringify(value), { value }] as const);
const NUMERIC_PROBES: readonly Probe[] = [
  ["negative-zero", { value: -0 }],
  ["non-integer", { value: 1.5 }],
  ["negative-non-integer", { value: -0.25 }],
  ["nan", { value: Number.NaN }],
  ["positive-infinity", { value: Number.POSITIVE_INFINITY }],
  ["negative-infinity", { value: Number.NEGATIVE_INFINITY }],
];

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}
function policy(rule: object, field = "value"): Record<string, unknown> {
  return { version: 3, templateFolders: [], base: { fields: { [field]: rule } }, contracts: { base: { intent: "Base.", fields: {}, views: [] } }, templates: {} };
}
function label(value: unknown): string {
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
  try { return JSON.stringify(value) ?? String(value); }
  catch { return Object.prototype.toString.call(value); }
}
function sameNumber(left: unknown, right: unknown): boolean {
  return typeof left === "number" && typeof right === "number" && (Object.is(left, right) || Number.isNaN(left) && Number.isNaN(right));
}
function saved(frontmatter: Frontmatter): { readonly value: Frontmatter; readonly yaml: string } {
  const yaml = stringify(frontmatter, { schema: "core", lineWidth: 0 });
  const parsed = parseNote(`---\n${yaml}---\n`);
  if (parsed.diagnostics.length > 0) throw new Error(`YAML frontmatter did not round-trip: ${parsed.diagnostics.map(item => item.code).join(",")}`);
  const source = Object.values(frontmatter)[0];
  const roundTrip = parsed.frontmatter[Object.keys(frontmatter)[0] ?? ""];
  if (typeof source === "number" && !sameNumber(roundTrip, source)) throw new Error(`YAML collapsed ${label(source)}`);
  return { value: parsed.frontmatter as Frontmatter, yaml };
}
function decision(admission: { readonly violations: readonly { readonly field: string }[] }, field: string): boolean {
  return !admission.violations.some(item => item.field === field);
}
function admitted(decoded: LegacyPolicyDecoding): boolean {
  return decoded.automaticMigrationBlocked === false && decoded.selectionBlocked === false && decoded.policy.common.status === "active";
}
function compare(name: string, rule: Rule, frontmatter: Frontmatter): void {
  const source = policy(rule);
  const disposition = evaluateV3Policy(source);
  if (disposition.disposition !== "evaluated") throw new Error(`${name} is not an evaluated automatic candidate`);
  const decoded = decodeLegacyPolicy(bytes(source));
  expect(admitted(decoded), `${name} decoder reasons=${decoded.reasons.join("; ")}`).toBe(true);
  const note = saved(frontmatter);
  const oracle = admitV3Note(source, "base", note.value, undefined, "update");
  const migrated = evaluateContractV5(note.value, "", composeContractV5(decoded.policy, null));
  expect(decision(migrated, "value"), `${name} value=${label(frontmatter.value)} yaml=${JSON.stringify(note.yaml)}`).toBe(decision(oracle, "value"));
}

describe("proven-safe automatic field admission", () => {
  it.each(PROVEN_SAFE)("maps %s automatically", (name, rule) => {
    const decoded = decodeLegacyPolicy(bytes(policy(rule)));
    expect(admitted(decoded), name).toBe(true);
    expect(evaluateV3Policy(policy(rule)).disposition, name).toBe("evaluated");
  });
  it.each(PROVEN_SAFE.flatMap(([name, rule]) => SCALAR_PROBES.map(([probe, frontmatter]) => [name, rule, probe, frontmatter] as const)))("compares %s %s", (name, rule, probe, frontmatter) => {
    compare(`${name}/${probe}`, rule, frontmatter);
  });
  it.each(([undefined, false, true] as const).flatMap(required => REQUIRED_PROBES.map(([probe, frontmatter]) => [required, probe, frontmatter] as const)))("compares required %s %s", (required, probe, frontmatter) => {
    compare(`required/${String(required)}/${probe}`, required === undefined ? { type: "text" } : { type: "text", required }, frontmatter);
  });
  it.each(CLOSED_PROBES)("compares closed select %s", (probe, frontmatter) => {
    compare(`closed/${probe}`, { type: "select", allowedValues: ["open", "closed"] }, frontmatter);
  });
  it.each((["list", "multi", "multitext", "aliases"] as const).flatMap(type => LIST_PROBES.map(([probe, frontmatter]) => [type, probe, frontmatter] as const)))("compares %s %s", (type, probe, frontmatter) => {
    compare(`${type}/${probe}`, { type }, frontmatter);
  });
  it.each(NUMERIC_PROBES)("compares YAML numeric %s", (probe, frontmatter) => {
    compare(`number/${probe}`, { type: "number" }, frontmatter);
    compare(`list/${probe}`, { type: "list" }, { value: [frontmatter.value as NoteValue] });
  });
});

describe("closed intrinsic candidates", () => {
  it.each(CLOSED_INTRINSIC)("maps finite closed %s automatically", (name, rule) => {
    const decoded = decodeLegacyPolicy(bytes(policy(rule)));
    expect(evaluateV3Policy(policy(rule)).disposition, name).toBe("evaluated");
    expect(admitted(decoded), `${name} finite closed set was not automatically mapped: ${decoded.reasons.join("; ")}`).toBe(true);
  });
  it.each(CLOSED_INTRINSIC.flatMap(([name, rule]) => (name === "closed-date" ? DATE_PROBES : name === "closed-datetime" ? TIME_PROBES : URL_PROBES).map(([probe, frontmatter]) => [name, rule, probe, frontmatter] as const)))("compares %s %s", (name, rule, probe, frontmatter) => {
    compare(`${name}/${probe}`, rule, frontmatter);
  });
});

describe("review-required field rules", () => {
  it("keeps an array-shaped base pending even though the historical evaluator accepts it", () => {
    const source = { version: 3, templateFolders: [], base: [], contracts: {}, templates: {} };
    expect(evaluateV3Policy(source).disposition).toBe("evaluated");
    const decoded = decodeLegacyPolicy(bytes(source));
    expect(decoded.automaticMigrationBlocked).toBe(true);
    expect(decoded.policy.common.status).toBe("review-required");
    expect(Buffer.from(decoded.archive.bytes).equals(bytes(source))).toBe(true);
  });
  it.each(REVIEW_REQUIRED)("blocks %s without counting admission equivalence", (name, rule) => {
    const source = policy(rule);
    const decoded = decodeLegacyPolicy(bytes(source));
    const disposition: LegacyDisposition = evaluateV3Policy(source);
    expect(decoded.automaticMigrationBlocked, name).toBe(true);
    expect(decoded.policy.common.status, name).toBe("review-required");
    expect(Buffer.from(decoded.archive.bytes).equals(bytes(source)), name).toBe(true);
    expect(["evaluated", "review-required"], name).toContain(disposition.disposition);
    expect(decoded.policy.templates, name).toEqual({});
  });
});

describe("historically rejected policies", () => {
  it.each(REJECTED)("preserves %s without an invented admission", (name, source) => {
    const disposition = evaluateV3Policy(source);
    expect(disposition.disposition, name).toBe("review-required");
    const decoded = decodeLegacyPolicy(bytes(source));
    expect(decoded.automaticMigrationBlocked, name).toBe(true);
    expect(Buffer.from(decoded.archive.bytes).equals(bytes(source)), name).toBe(true);
    if (disposition.disposition === "review-required") expect(() => admitV3Note(source, "base", {}, undefined), name).toThrow(disposition.message);
    if (name === "unsafe-folder") {
      expect(decoded.selectionBlocked, name).toBe(false);
      expect(decoded.policy.common.status, name).toBe("active");
    }
  });
  it("preserves an undeclared sibling on a proven-safe field", () => {
    const source = policy({ type: "select", required: true, allowedValues: ["open"] }, "status");
    const note = saved({ status: "open", sibling: "[[kept]]" });
    const oracle: LegacyAdmission = admitV3Note(source, "base", note.value, undefined, "update");
    const decoded = decodeLegacyPolicy(bytes(source));
    expect(admitted(decoded)).toBe(true);
    const migrated = evaluateContractV5(note.value, "", composeContractV5(decoded.policy, null));
    expect(decision(migrated, "status")).toBe(decision(oracle, "status"));
    expect(note.value.sibling).toBe("[[kept]]");
  });
});
