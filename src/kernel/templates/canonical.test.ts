import { describe, expect, it } from "vitest";
import { approvalDigest, canonicalJson, digestBytes, frameHash, hashCanonical, inputDigest, outputDigest } from "./canonical.js";
import type { ControlTransition, ManagedTemplatePath, TemplateCasExpectation, TemplateCompositionManifest } from "./types.js";

const a = digestBytes("before");
const b = digestBytes("after");
const draftPath = ".oms/templates/default.md" as ManagedTemplatePath;
const cas: TemplateCasExpectation = {
  controls: { policy: { state: "present", signature: a }, taxonomy: { state: "absent" }, projection: { state: "absent" } },
  drafts: [{ templateId: null, path: draftPath, expected: { state: "present", signature: a } }],
};
function manifest(): Omit<TemplateCompositionManifest, "approvalDigest" | "outputDigest"> {
  function control<K extends "policy" | "taxonomy" | "projection", P extends ".oms/template-policy.json" | ".oms/taxonomy.json" | ".oms/types.json">(kind: K, path: P): ControlTransition<K, P> {
    return {
      kind, path, expectedCurrent: { state: "present", signature: a },
      current: { state: "present", bytes: Buffer.from("before"), signature: a },
      proposed: { state: "present", bytes: Buffer.from("after"), signature: b }, action: "write",
    };
  }
  return {
    version: 1, markerPath: ".oms/template-transaction.json",
    controls: [control("policy", ".oms/template-policy.json"), control("taxonomy", ".oms/taxonomy.json"), control("projection", ".oms/types.json")],
    drafts: [{ templateId: null, path: draftPath, expectedCurrent: { state: "absent" }, current: { state: "absent" }, proposed: { state: "present", bytes: Buffer.from("after"), signature: b }, action: "write" }],
    operations: [{ kind: "commit-contract", templateId: null, payloadDigest: b }],
    diagnostics: [], outputs: [{ finalVaultRelativePath: draftPath, payloadDigest: b }],
  };
}

describe("canonical byte and value hashing", () => {
  it("pins raw SHA256 and framed byte lengths without normalizing raw bytes", () => {
    expect(digestBytes("abc")).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(Buffer.from(frameHash("x", { b: 1, a: 2 })).toString()).toBe('oms-hash-frame-v1\0' + '1\0x13\0{"a":2,"b":1}');
    expect(digestBytes("é")).not.toBe(digestBytes("é"));
    expect(hashCanonical("x", "é")).toBe(hashCanonical("x", "é"));
    expect(hashCanonical("x", "é")).not.toBe(hashCanonical("y", "é"));
  });
  it("escapes controls and preserves prototype-named keys", () => {
    expect(canonicalJson({ line: '\n\t"\\' })).toBe('{"line":"\\u000a\\u0009\\"\\\\"}');
    const value: unknown = JSON.parse('{"__proto__":{"safe":true}}');
    expect(canonicalJson(value)).toBe('{"__proto__":{"safe":true}}');
    expect(hashCanonical("x", value)).not.toBe(hashCanonical("x", {}));
  });
  it("orders scalar keys by codepoint and rejects ambiguous or unsupported values", () => {
    expect(canonicalJson({ z: false, a: [null, true, 1] })).toBe('{"a":[null,true,1],"z":false}');
    expect(() => canonicalJson({ "é": 1, "é": 2 })).toThrow("collide");
    for (const value of [NaN, Infinity, -0, 1.5, undefined, new Date(), "\ud800", "\udc00", "\ud800x"]) {
      expect(() => canonicalJson(value)).toThrow();
    }
    expect(canonicalJson("𝄞")).toBe('"𝄞"');
  });
});

describe("v4 publication bindings", () => {
  it("binds current control and managed-draft CAS state", () => {
    const baseline = inputDigest(cas);
    expect(inputDigest({ ...cas, controls: { ...cas.controls, policy: { state: "present", signature: b } } })).not.toBe(baseline);
    expect(inputDigest({ ...cas, drafts: [{ ...cas.drafts[0]!, expected: { state: "absent" } }] })).not.toBe(baseline);
    expect(inputDigest({ ...cas, drafts: [{ ...cas.drafts[0]!, path: ".oms/templates/other.md" as ManagedTemplatePath }] })).not.toBe(baseline);
    expect(() => inputDigest({ ...cas, controls: { ...cas.controls, policy: { state: "present", signature: "invalid" as typeof a } } })).toThrow("Digest");
  });
  it("normalizes draft iteration order without mutating caller inputs", () => {
    const withTwo = { ...cas, drafts: [...cas.drafts, { templateId: null, path: ".oms/templates/z.md" as ManagedTemplatePath, expected: { state: "absent" as const } }] };
    const before = structuredClone(withTwo);
    expect(inputDigest(withTwo)).toBe(inputDigest({ ...withTwo, drafts: [...withTwo.drafts].reverse() }));
    expect(withTwo).toEqual(before);
  });
  it("binds proposed bytes rather than trusting their declared signature", () => {
    const proposal = manifest();
    const baseline = approvalDigest(proposal);
    const changed = structuredClone(proposal);
    changed.controls[0].proposed.bytes[0] = 88;
    expect(approvalDigest(changed)).not.toBe(baseline);
    expect(approvalDigest(proposal)).toBe(baseline);
  });
  it("binds preimages, actions, operations and diagnostics", () => {
    const proposal = manifest();
    const baseline = approvalDigest(proposal);
    expect(approvalDigest({ ...proposal, drafts: [{ ...proposal.drafts[0]!, expectedCurrent: { state: "present", signature: a } }] })).not.toBe(baseline);
    expect(approvalDigest({ ...proposal, drafts: [{ ...proposal.drafts[0]!, templateId: "other" as NonNullable<TemplateCasExpectation["drafts"][number]["templateId"]> }] })).not.toBe(baseline);
    expect(approvalDigest({ ...proposal, drafts: [{ ...proposal.drafts[0]!, action: "verify-only" }] })).not.toBe(baseline);
    expect(approvalDigest({ ...proposal, operations: [{ ...proposal.operations[0]!, payloadDigest: a }] })).not.toBe(baseline);
    expect(approvalDigest({ ...proposal, diagnostics: [{ code: "CONTRACT_UNVERIFIABLE", message: "Missing approval" }] })).not.toBe(baseline);
    expect(approvalDigest({ ...proposal, drafts: [{ ...proposal.drafts[0]!, proposed: { state: "absent" } }] })).not.toBe(baseline);
  });
  it("canonicalizes transaction ordering and rejects conflicting output bytes", () => {
    const proposal = manifest();
    const outputs = [...proposal.outputs, { finalVaultRelativePath: ".oms/types.json" as const, payloadDigest: a }];
    expect(outputDigest(outputs)).toBe(outputDigest([...outputs].reverse()));
    expect(outputDigest(outputs)).toBe(outputDigest([...outputs, outputs[0]!]));
    expect(() => outputDigest([...outputs, { ...outputs[0]!, payloadDigest: a }])).toThrow("TEMPLATE_TRANSACTION_INCONSISTENT");
    const reordered = { ...proposal, controls: [proposal.controls[2], proposal.controls[1], proposal.controls[0]] as unknown as TemplateCompositionManifest["controls"] };
    expect(approvalDigest(reordered)).toBe(approvalDigest(proposal));
  });
});
