import { describe, expect, it } from "vitest";
import v3Corpus from "../../../test/fixtures/contract-migrations/v3.json" with { type: "json" };
import v4Corpus from "../../../test/fixtures/contract-migrations/v4.json" with { type: "json" };
import manifest from "../../../test/fixtures/contract-migrations/manifest.json" with { type: "json" };
import {
  V3_PROVENANCE,
  V4_PROVENANCE,
  admitV3Note,
  admitV4Note,
  classifyV4Boundary,
  evaluateV3Policy,
  evaluateV4Policy,
} from "../../../test/fixtures/contract-migrations/legacy-oracle.js";


function rules(result: { readonly violations: readonly { readonly rule: string }[] }): string[] {
  return result.violations.map(violation => `${"field" in violation ? String(violation.field) : "?"}:${violation.rule}`);
}

describe("legacy contract provenance gap", () => {
  it("records the nine-output diagnosis as uncaptured and not attributable to v3", () => {
    const gap = manifest.coverageGaps[0];
    expect(gap?.status).toBe("not-captured");
    expect(gap?.knownReference.producingCommit).toBe("UNKNOWN");
    expect(gap?.knownReference.mustNotAttributeTo).toBe(V3_PROVENANCE.commit);
    expect(V4_PROVENANCE.commit).toBe(manifest.parentBaseline);
  });
});

describe("version 3 effective rules", () => {
  const corpusCase = v3Corpus.cases[0];
  if (corpusCase?.kind !== "effective-rules") throw new Error("missing v3 effective case");
  const policy = corpusCase.policy;

  it("merges base, contract, and binding without taking template values as field overrides", () => {
    const evaluated = evaluateV3Policy(policy);
    expect(evaluated.disposition).toBe("evaluated");
    if (evaluated.disposition !== "evaluated") return;
    expect(evaluated.version).toBe(3);
    expect(evaluated.fields.literature).toMatchObject({
      status: { required: true, immutable: true, allowedValues: ["open"] },
      source: { type: "text", format: "url", required: true },
      title: { normalize: "trim" },
    });
    expect(evaluated.extras.defaultTemplate).toBe("literature");
  });

  it("admits a complete note and preserves undeclared frontmatter and BOM/CRLF", () => {
    const probe = corpusCase.probes?.find(item => item.id === "admit");
    const edge = corpusCase.probes?.find(item => item.id === "bom-crlf-body-preserved");
    if (probe === undefined || edge === undefined) throw new Error("missing v3 probes");
    const admitted = admitV3Note(policy, "literature", probe.frontmatter, probe.body, "update");
    expect(admitted.valid).toBe(true);
    expect(admitted.normalized).toMatchObject({ free: "kept" });
    const preserved = admitV3Note(policy, "literature", edge.frontmatter, edge.body, "update");
    expect(preserved.valid).toBe(true);
    expect(preserved.preservedBody).toBe(edge.body);
    expect(edge.body?.startsWith("\uFEFF")).toBe(true);
    expect(edge.body).toContain("\r\n");
  });

  it("reports required, narrowed-value, url, writer, and body misses without normalizing stored values", () => {
    const missing = corpusCase.probes?.find(item => item.id === "missing-required-and-writer");
    const widened = corpusCase.probes?.find(item => item.id === "widened-value-and-bad-url");
    const fenced = corpusCase.probes?.find(item => item.id === "strict-body-order");
    const appended = corpusCase.probes?.find(item => item.id === "append-ignores-missing-heading");
    if (missing === undefined || widened === undefined || fenced === undefined || appended === undefined) throw new Error("missing v3 edge probes");
    expect(rules(admitV3Note(policy, "literature", missing.frontmatter, missing.body, "update"))).toEqual(["source:required", "created_by:writer-identity"]);
    expect(rules(admitV3Note(policy, "literature", widened.frontmatter, widened.body, "update"))).toEqual(["status:allowed-values", "source:format", "created_by:writer-identity"]);
    expect(admitV3Note(policy, "literature", fenced.frontmatter, fenced.body, "update").valid).toBe(false);
    expect(admitV3Note(policy, "literature", appended.frontmatter, appended.body, "append").valid).toBe(true);
  });

  it("normalizes only on create and still requires the base field", () => {
    const probe = corpusCase.probes?.find(item => item.id === "create-normalizes-title-and-rejects-empty-required");
    if (probe === undefined) throw new Error("missing create probe");
    const created = admitV3Note(policy, "literature", probe.frontmatter, undefined, "create");
    expect(created.normalized?.title).toBe("Kept");
    expect(rules(created)).toEqual(["status:required", "source:required"]);
  });
  it("selects clip rather than literature and keeps a real heading beside a fence", () => {
    const beside = corpusCase.probes?.find(item => item.id === "clip-fence-beside-real-heading");
    const reversed = corpusCase.probes?.find(item => item.id === "clip-order-reversed");
    if (beside?.contract === undefined || reversed?.contract === undefined) throw new Error("missing clip probes");
    expect(beside.contract).toBe("clip");
    const besideResult = admitV3Note(policy, beside.contract, beside.frontmatter, beside.body, "update");
    const reversedResult = admitV3Note(policy, reversed.contract, reversed.frontmatter, reversed.body, "update");
    expect(besideResult.valid, rules(besideResult)).toBe(true);
    expect(rules(reversedResult)).toContain("body:document-order:format");
  });
});

describe("version 3 review boundaries", () => {
  it("does not invent an equivalent for weakening or unknown metadata", () => {
    const corpusCase = v3Corpus.cases[1];
    if (corpusCase === undefined) throw new Error("missing v3 invalid case");
    const evaluated = evaluateV3Policy(corpusCase.policy);
    expect(evaluated.disposition).toBe("review-required");
    if (evaluated.disposition === "review-required") expect(evaluated.code).toBe("BASE_CONTRACT_CONFLICT");
  });

  it("keeps unsupported version and unsafe source paths review-required", () => {
    const corpusCase = v3Corpus.cases[2];
    if (corpusCase?.variants === undefined) throw new Error("missing v3 variants");
    for (const variant of corpusCase.variants) {
      const evaluated = evaluateV3Policy(variant.policy);
      expect(evaluated.disposition, variant.id).toBe("review-required");
    }
  });
});

describe("version 4 effective rules", () => {
  const corpusCase = v4Corpus.cases[0];
  if (corpusCase?.kind !== "effective-rules") throw new Error("missing v4 effective case");
  const policy = corpusCase.policy;

  it("ORs required, narrows values, and adds headings without copying v3 binding shape", () => {
    const evaluated = evaluateV4Policy(policy, "literature");
    expect(evaluated.disposition).toBe("evaluated");
    if (evaluated.disposition !== "evaluated") return;
    expect(evaluated.version).toBe(4);
    expect(evaluated.headingOrder).toBe("strict");
    expect(evaluated.fields).toMatchObject({
      status: { required: true, allowedValues: ["open"], type: "select" },
      source: { required: true, format: "url" },
    });
    expect(evaluated.fields).not.toHaveProperty("unused");
    expect(evaluated.headings.map(heading => heading.headingId)).toEqual(["summary", "sources"]);
    expect(evaluated.extras).not.toHaveProperty("writers");
    expect(corpusCase.expectedDigest?.literature).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("admits the ordered note and rejects inherited values, reversal, fences, and empty required values", () => {
    const byId = new Map(corpusCase.probes?.map(probe => [probe.id, probe]));
    const admit = byId.get("admit-narrowed-and-ordered");
    const inherited = byId.get("inherited-value-rejected-and-order-reversed");
    const fenced = byId.get("fenced-heading-does-not-satisfy");
    const empty = byId.get("empty-string-is-missing-required");
    const list = byId.get("list-member-outside-narrowed-set");
    if (admit === undefined || inherited === undefined || fenced === undefined || empty === undefined || list === undefined) throw new Error("missing v4 probes");
    expect(admitV4Note(policy, "literature", admit.frontmatter, admit.body).valid).toBe(true);
    expect(rules(admitV4Note(policy, "literature", inherited.frontmatter, inherited.body))).toEqual(["status:allowed-values", "body:order:heading"]);
    expect(admitV4Note(policy, null, fenced.frontmatter, fenced.body).valid).toBe(false);
    expect(rules(admitV4Note(policy, "literature", empty.frontmatter, empty.body))).toEqual(["status:required", "source:required"]);
    expect(rules(admitV4Note(policy, "literature", list.frontmatter, list.body))).toEqual(["status:type"]);
  });

  it("preserves a BOM/CRLF body while still seeing its headings", () => {
    const probe = corpusCase.probes?.find(item => item.id === "bom-crlf-heading-still-required");
    if (probe === undefined) throw new Error("missing BOM probe");
    const admitted = admitV4Note(policy, "literature", probe.frontmatter, probe.body);
    expect(admitted.valid).toBe(true);
    expect(admitted.preservedBody).toBe(probe.body);
  });
});

describe("version 4 inheritance and review boundaries", () => {
  it("inherits omitted order and does not clear an omitted allowed-value ceiling", () => {
    const corpusCase = v4Corpus.cases[1];
    if (corpusCase === undefined) throw new Error("missing inheritance case");
    const evaluated = evaluateV4Policy(corpusCase.policy, "literature");
    expect(evaluated.disposition).toBe("evaluated");
    if (evaluated.disposition !== "evaluated") return;
    expect(evaluated.headingOrder).toBe("unordered");
    expect(evaluated.fields.status).toMatchObject({ required: true, allowedValues: ["closed", "open"] });
    const probe = corpusCase.probes?.[0];
    if (probe === undefined) throw new Error("missing inheritance probe");
    expect(admitV4Note(corpusCase.policy, "literature", probe.frontmatter, probe.body).valid).toBe(true);
  });

  it("classifies unknown, missing-source, semantic, and nonrepresentable cases as review-required", () => {
    const corpusCase = v4Corpus.cases[2];
    if (corpusCase?.variants === undefined) throw new Error("missing v4 boundary variants");
    const expected = new Map([
      ["retired-v3-shape", "TEMPLATE_POLICY_VERSION_UNSUPPORTED"],
      ["missing-source-bytes", "missing-source-bytes"],
      ["semantic-criteria-not-machine-equivalent", "semantic-review-required"],
      ["unknown-root-member", "unknown-metadata"],
      ["nonrepresentable-weakening", "CONTRACT_COMPOSITION_CONFLICT"],
      ["digest-mismatch", "CONTRACT_UNVERIFIABLE"],
      ["nonempty-wrong-sha", "CONTRACT_UNVERIFIABLE"],
    ]);
    for (const variant of corpusCase.variants) {
      const templateId = variant.id === "missing-source-bytes" || variant.id === "nonrepresentable-weakening" ? "literature" : null;
      const evaluated = classifyV4Boundary(variant.policy, templateId);
      expect(evaluated.disposition, variant.id).toBe("review-required");
      if (evaluated.disposition === "review-required") expect(evaluated.code, variant.id).toBe(expected.get(variant.id));
    }
  });
  it("rejects a nonempty wrong SHA on the selected layer and keeps a distinct template", () => {
    const variant = v4Corpus.cases[2]?.variants?.find(item => item.id === "nonempty-wrong-sha");
    const inheritance = v4Corpus.cases[1];
    if (variant === undefined || inheritance === undefined) throw new Error("missing counterexamples");
    const mismatched = classifyV4Boundary(variant.policy, "memo");
    expect(mismatched.disposition).toBe("review-required");
    if (mismatched.disposition === "review-required") expect(mismatched.code).toBe("CONTRACT_UNVERIFIABLE");
    const evaluated = evaluateV4Policy(inheritance.policy, "memo");
    expect(evaluated.disposition).toBe("evaluated");
    if (evaluated.disposition !== "evaluated") return;
    expect(Object.keys(evaluated.fields)).toEqual(["status"]);
    expect(evaluated.headings.map(heading => String(heading.headingId))).toEqual(["memo"]);
  });
});
