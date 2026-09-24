import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateContractV5 } from "./contract-check.js";
import { composeContractV5, type ContractPolicyV5, type EffectiveFieldV5 } from "./contract-v5.js";
import { decodeLegacyPolicy } from "./legacy-policy-decoder.js";
import { verifiedLegacySource, verifyLegacyPublicationEvidence } from "./legacy-publication-evidence.js";
import { admitV3Note, admitV4Note, evaluateV3Policy, evaluateV4Policy, type LegacyViolation } from "../../../test/fixtures/contract-migrations/legacy-oracle.ts";
import v3Corpus from "../../../test/fixtures/contract-migrations/v3.json" with { type: "json" };
import v4Corpus from "../../../test/fixtures/contract-migrations/v4.json" with { type: "json" };

const encoder = new TextEncoder();
function bytes(value: unknown): Uint8Array { return encoder.encode(JSON.stringify(value)); }
function exactText(value: Uint8Array): string { return Buffer.from(value).toString("utf8"); }
function legacyKeys(value: unknown): string[] {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
}
function v3Case(id: string): Record<string, unknown> {
  const found = v3Corpus.cases.find(item => item.id === id);
  if (found === undefined || !("policy" in found)) throw new Error(id);
  return structuredClone(found.policy) as Record<string, unknown>;
}
function v4Case(id: string): Record<string, unknown> {
  const found = v4Corpus.cases.find(item => item.id === id);
  if (found === undefined || !("policy" in found)) throw new Error(id);
  return structuredClone(found.policy) as Record<string, unknown>;
}
function v4Variant(id: string): Record<string, unknown> {
  const found = v4Corpus.cases.find(item => item.id === "v4-review-required-boundaries");
  const variant = found?.variants?.find(item => item.id === id);
  if (variant === undefined) throw new Error(id);
  return structuredClone(variant.policy) as Record<string, unknown>;
}
function rules(field: EffectiveFieldV5 | undefined): Record<string, unknown> {
  return { type: field?.type, required: field?.required ?? false, allowedValues: field?.allowedValues ?? null, format: field?.format ?? null, valuePolicy: field?.valuePolicy ?? null };
}
function comparable(policy: ContractPolicyV5, templateId: string | null, frontmatter: Readonly<Record<string, string | number | boolean | null | readonly string[]>>, body: string): { readonly rules: Record<string, unknown>; readonly valid: boolean; readonly ruleset: string[] } {
  const effective = composeContractV5(policy, templateId);
  const result = evaluateContractV5(frontmatter, body, effective);
  return { rules: Object.fromEntries(Object.entries(effective.fields).map(([name, field]) => [name, rules(field)])), valid: result.valid, ruleset: result.violations.map(item => item.rule).sort() };
}
function oracleRules(admission: { readonly valid: boolean; readonly violations: readonly LegacyViolation[] }, fields: Record<string, unknown>): { readonly valid: boolean; readonly ruleset: string[] } {
  return { valid: admission.valid, ruleset: admission.violations.filter(item => Object.hasOwn(fields, item.field) && ["required", "type", "allowed-values", "format"].includes(item.rule)).map(item => item.rule).sort() };
}

const commonOnly = {
  version: 3,
  templateFolders: [],
  base: { fields: { status: { type: "select", required: true, allowedValues: ["open", "closed"] } } },
  contracts: { base: { intent: "Base.", fields: {}, views: [] } },
  templates: {},
};

describe("legacy policy decoder", () => {
  it("activates a v3 common-only policy and matches the frozen oracle on base probes", () => {
    const decoded = decodeLegacyPolicy(bytes(commonOnly));
    expect(decoded.selectionBlocked).toBe(false);
    expect(decoded.automaticMigrationBlocked).toBe(false);
    expect(decoded.policy.common.status).toBe("active");
    expect(decoded.policy.templates).toEqual({});
    expect(exactText(decoded.archive.bytes)).toBe(JSON.stringify(commonOnly));
    const probes = [
      [{ status: "open" }, true],
      [{}, false],
      [{ status: "closed" }, true],
      [{ status: "other" }, false],
      [{ status: 1 }, false],
    ] as const;
    for (const [frontmatter, valid] of probes) {
      const historical = admitV3Note(commonOnly, "base", frontmatter, undefined);
      const active = comparable(decoded.policy, null, frontmatter, "");
      expect(active.valid).toBe(valid);
      expect(active.valid).toBe(oracleRules(historical, { status: true }).valid);
      expect(active.ruleset).toEqual(oracleRules(historical, { status: true }).ruleset);
      expect(active.rules.status).toMatchObject({ type: "select", required: true, valuePolicy: "closed" });
    }
    expect(evaluateV3Policy(commonOnly).disposition).toBe("evaluated");
  });

  it("keeps every frozen v3 individual pending and does not let its format mutate common", () => {
    const policy = v3Case("v3-base-contract-binding");
    const decoded = decodeLegacyPolicy(bytes(policy), { approved: true, commit: "46e8703e4c9f446a1d6eebaa7cd585b6adf0516f" });
    expect(decoded.selectionBlocked).toBe(true);
    expect(decoded.automaticMigrationBlocked).toBe(true);
    expect(decoded.policy.templates.literature?.status).toBe("review-required");
    expect(decoded.policy.templates.clip?.status).toBe("review-required");
    expect(decoded.policy.common.status).toBe("review-required");
    if (decoded.policy.templates.literature?.status === "review-required") {
      expect(decoded.policy.templates.literature.legacy).toMatchObject({ archiveDigest: decoded.archive.digest, member: "/templates/literature" });
      expect(JSON.stringify(decoded.policy.templates.literature.legacy)).not.toContain("## Summary");
    }
    expect(decoded.inventory.some(entry => entry.path === "/templates/literature/naming" && entry.disposition === "review-required")).toBe(true);
    expect(decoded.reasons.join(" ")).toMatch(/naming|immutable|writers|defaultTemplate/);
  });

  it("preserves exact BOM and CRLF bytes without accepting an object input", () => {
    const raw = `\uFEFF${JSON.stringify(commonOnly).replaceAll(",", ",\r\n")}`;
    const decoded = decodeLegacyPolicy(raw);
    expect(Buffer.from(decoded.archive.bytes).equals(Buffer.from(raw, "utf8"))).toBe(true);
    expect(exactText(decoded.archive.bytes)).toBe(raw);
    expect(exactText(decoded.archive.bytes).charCodeAt(0)).toBe(0xfeff);
    expect(decoded.archive.digest.startsWith("sha256:")).toBe(true);
    expect(() => decodeLegacyPolicy(commonOnly as never)).toThrow(/string or bytes/);
    expect(() => decodeLegacyPolicy("{")).toThrow(/LEGACY_POLICY_INVALID/);
    expect(() => decodeLegacyPolicy(bytes({ version: 2 }))).toThrow(/VERSION_UNSUPPORTED/);
  });

  it("returns a bounded review for malformed known v3 instead of throwing or dropping fields", () => {
    const malformed = { version: 3, templateFolders: [{ path: "Templates/../secret" }], base: { fields: { status: "bad" } }, contracts: [], templates: {} };
    const decoded = decodeLegacyPolicy(bytes(malformed));
    expect(decoded.selectionBlocked).toBe(true);
    expect(decoded.policy.common.status).toBe("review-required");
    expect(exactText(decoded.archive.bytes)).toContain("secret");
    expect(decoded.policy.properties).toEqual({});
  });

  it("preserves valid common when an inactive v3 contract conflicts", () => {
    const policy = {
      version: 3,
      templateFolders: [],
      base: { fields: { status: { type: "select", required: true, allowedValues: ["open"] }, note: { type: "text" } } },
      contracts: { base: { intent: "Base.", fields: { status: { type: "text" } }, views: [] } },
      templates: {},
    };
    const decoded = decodeLegacyPolicy(bytes(policy));
    expect(decoded.selectionBlocked).toBe(false);
    expect(decoded.automaticMigrationBlocked).toBe(true);
    expect(decoded.policy.properties.status).toMatchObject({ type: "select", allowedValues: ["open"], valuePolicy: "closed" });
    expect(decoded.policy.common.status).toBe("active");
    expect(decoded.inventory.some(entry => entry.path === "/contracts/base/fields/status" && entry.disposition === "review-required")).toBe(true);
    const historical = evaluateV3Policy(policy);
    expect(historical.disposition).toBe("review-required");
    if (historical.disposition === "review-required") expect(historical.code).toBe("BASE_CONTRACT_CONFLICT");
    const commonOnlyProjection = { ...policy, contracts: { base: { intent: "Base.", fields: {}, views: [] } } };
    expect(comparable(decoded.policy, null, { status: "open", note: "kept" }, "").valid).toBe(admitV3Note(commonOnlyProjection, "base", { status: "open", note: "kept" }, undefined).valid);
  });

  it("inventories escaped unknown nested members without blocking a still-valid common selection", () => {
    const policy = { ...commonOnly, extensions: { "a/b": { "~": [1, { kept: true }] } } };
    const decoded = decodeLegacyPolicy(bytes(policy));
    expect(decoded.selectionBlocked).toBe(false);
    expect(decoded.automaticMigrationBlocked).toBe(true);
    expect(decoded.inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/extensions/a~1b/~0", disposition: "review-required" }),
      expect.objectContaining({ path: "/extensions/a~1b/~0/0", disposition: "review-required" }),
    ]));
    expect(decoded.policy.common.status).toBe("active");
  });

  it("keeps the frozen omitted-order v4 common contract active and its entries pending without proof", () => {
    const policy = v4Case("v4-omitted-order-inherits-and-omitted-values-do-not-clear");
    const decoded = decodeLegacyPolicy(bytes(policy), { approved: true, rawDigest: v4Corpus.shared.rawDigest });
    expect(decoded.selectionBlocked).toBe(false);
    expect(decoded.automaticMigrationBlocked).toBe(true);
    expect(decoded.policy.templates.literature?.status).toBe("review-required");
    expect(decoded.policy.templates.memo?.status).toBe("review-required");
    const historical = evaluateV4Policy(policy, null);
    expect(historical.disposition).toBe("evaluated");
    if (historical.disposition !== "evaluated") return;
    const active = composeContractV5(decoded.policy, null);
    expect(active.headingOrder).toBe("unordered");
    expect(rules(active.fields.status)).toMatchObject({ type: "select", required: false, valuePolicy: "closed", allowedValues: ["closed", "open"] });
    expect(historical.fields.status).toMatchObject({ required: false, allowedValues: ["closed", "open"] });
    const frontmatter = { status: "closed" };
    expect(comparable(decoded.policy, null, frontmatter, "").valid).toBe(admitV4Note(policy, null, frontmatter, "").valid);
    expect(comparable(decoded.policy, null, {}, "").valid).toBe(true);
    expect(comparable(decoded.policy, null, { status: "other" }, "").ruleset).toEqual(["allowed-values"]);
  });

  it("does not activate the frozen prose v4 entry from a current digest or a fake approval", () => {
    const policy = v4Case("v4-required-or-narrowing-headings-order");
    const decoded = decodeLegacyPolicy(bytes(policy), { path: "Templates/literature.md", rawDigest: v4Corpus.shared.rawDigest, approved: true });
    expect(decoded.selectionBlocked).toBe(true);
    expect(decoded.policy.common.status).toBe("review-required");
    expect(decoded.policy.templates.literature?.status).toBe("review-required");
    expect(decoded.reasons.join(" ")).toMatch(/semantic|prose|guidance/);
    expect(evaluateV4Policy(policy, "literature").disposition).toBe("evaluated");
  });

  it("preserves a bad approvedMarkdownDigest as review and does not throw the v4 parser", () => {
    const policy = v4Variant("digest-mismatch");
    const decoded = decodeLegacyPolicy(bytes(policy));
    expect(decoded.selectionBlocked).toBe(true);
    expect(decoded.policy.common.status).toBe("review-required");
    expect(exactText(decoded.archive.bytes)).toContain("changed");
    expect(evaluateV4Policy(policy, null).disposition).toBe("review-required");
  });

  it("keeps an unknown root member and a nested field member unresolved", () => {
    const unknown = v4Variant("unknown-root-member");
    const decoded = decodeLegacyPolicy(bytes(unknown));
    expect(decoded.selectionBlocked).toBe(true);
    expect(decoded.inventory.some(entry => entry.path === "/mystery" && entry.disposition === "review-required")).toBe(true);
    expect(exactText(decoded.archive.bytes)).toContain("kept");
    const nested = v4Case("v4-omitted-order-inherits-and-omitted-values-do-not-clear");
    (nested.default as { fields: Record<string, Record<string, unknown>> }).fields.status.mystery = true;
    const nestedDecoded = decodeLegacyPolicy(bytes(nested));
    expect(nestedDecoded.selectionBlocked).toBe(true);
    expect(nestedDecoded.inventory.some(entry => entry.path === "/default/fields/status/mystery")).toBe(true);
    expect(nestedDecoded.policy.properties.status).toMatchObject({ type: "select", allowedValues: ["closed", "open"] });
    expect(nestedDecoded.policy.common.status).toBe("review-required");
  });

  it("does not equate a setext underline with a historical ATX heading", () => {
    const policy = v4Case("v4-omitted-order-inherits-and-omitted-values-do-not-clear");
    const layer = policy.default as { approvedMarkdown: string; approvedMarkdownDigest: string; headings: unknown[] };
    layer.approvedMarkdown = "Summary\n-------\n";
    layer.approvedMarkdownDigest = "sha256:3d4eb6547300b5be7ae7f6403a6f9353f71fabd1499cbc1e529ae27519a9a8c6";
    const decoded = decodeLegacyPolicy(encoder.encode(JSON.stringify(policy)));
    expect(decoded.policy.common.status).toBe("review-required");
    expect(decoded.reasons.join(" ")).toMatch(/guidance|heading/);
    expect(decoded.policy.common.status === "active" ? decoded.policy.common.headings : []).toEqual([]);
  });

  it("retains valid common fields when one v4 individual is malformed", () => {
    const policy = v4Case("v4-omitted-order-inherits-and-omitted-values-do-not-clear");
    const templates = policy.templates as Record<string, Record<string, unknown>>;
    templates.literature = { ...templates.literature, approvedMarkdownDigest: "not-a-digest" };
    const decoded = decodeLegacyPolicy(bytes(policy));
    expect(decoded.selectionBlocked).toBe(false);
    expect(decoded.policy.common.status).toBe("active");
    expect(decoded.policy.properties.status).toMatchObject({ type: "select", allowedValues: ["closed", "open"] });
    expect(decoded.policy.templates.literature?.status).toBe("review-required");
    expect(decoded.policy.templates.memo?.status).toBe("review-required");
    expect(Object.keys(decoded.policy.templates)).toEqual(["literature", "memo"]);
    const historical = evaluateV4Policy(policy, null);
    expect(historical.disposition).toBe("evaluated");
    expect(comparable(decoded.policy, null, { status: "closed" }, "").valid).toBe(admitV4Note(policy, null, { status: "closed" }, "").valid);
  });

  it("scopes an unknown nested extension without copying it into legacy metadata", () => {
    const policy = {
      version: 3,
      templateFolders: [],
      base: { fields: { status: { type: "select", required: true, allowedValues: ["open"] } } },
      contracts: { base: { intent: "Base.", fields: {}, views: [] } },
      templates: { note: { templateId: "note", destinationClass: "registered-existing", sourcePath: "Templates/note.md", contract: "base", extensions: { "a/b": { "~": ["## hidden"] } } } },
    };
    const decoded = decodeLegacyPolicy(bytes(policy));
    expect(decoded.selectionBlocked).toBe(false);
    expect(decoded.automaticMigrationBlocked).toBe(true);
    expect(decoded.inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/templates/note/extensions/a~1b/~0", disposition: "review-required" }),
    ]));
    expect(decoded.policy.templates.note?.status).toBe("review-required");
    if (decoded.policy.templates.note?.status !== "review-required") return;
    expect(legacyKeys(decoded.policy.templates.note.legacy)).toEqual(["archiveDigest", "format", "member"]);
    expect(JSON.stringify(decoded.policy.templates.note.legacy)).not.toContain("hidden");
    expect(exactText(decoded.archive.bytes)).toContain("## hidden");
  });

  it("blocks automatic migration for an unknown unused property without blocking common", () => {
    const policy = v4Case("v4-omitted-order-inherits-and-omitted-values-do-not-clear");
    (policy.properties as { status: Record<string, unknown>; unused: Record<string, unknown> }).unused = { type: "text", intent: "Unused.", keeper: true };
    const decoded = decodeLegacyPolicy(bytes(policy));
    expect(decoded.selectionBlocked).toBe(false);
    expect(decoded.automaticMigrationBlocked).toBe(true);
    expect(decoded.policy.common.status).toBe("active");
    expect(decoded.inventory.some(entry => entry.path === "/properties/unused/keeper" && entry.disposition === "review-required")).toBe(true);
    expect(composeContractV5(decoded.policy, null).fields).not.toHaveProperty("unused");
    expect(evaluateV4Policy(policy, null).disposition).toBe("evaluated");
  });

  it("inherits a v4 pool ceiling when the field omits allowedValues", () => {
    const policy = v4Case("v4-omitted-order-inherits-and-omitted-values-do-not-clear");
    delete (policy.default as { fields: Record<string, Record<string, unknown>> }).fields.status.allowedValues;
    const decoded = decodeLegacyPolicy(bytes(policy));
    const historical = evaluateV4Policy(policy, null);
    expect(historical.disposition).toBe("evaluated");
    if (historical.disposition !== "evaluated" || decoded.policy.common.status !== "active") return;
    expect(decoded.policy.common.fields.status?.allowedValues).toEqual(["closed", "open"]);
    expect(decoded.policy.properties.status?.allowedValues).toEqual(["closed", "open"]);
    expect(composeContractV5(decoded.policy, null).fields.status).toMatchObject({ valuePolicy: "closed", allowedValues: ["closed", "open"] });
    expect(comparable(decoded.policy, null, { status: "other" }, "").ruleset).toEqual(["allowed-values"]);
    expect(admitV4Note(policy, null, { status: "other" }, "").valid).toBe(false);
  });

  it("keeps explicit v3 required false common-valid and ignores an inactive contract conflict", () => {
    const policy = {
      version: 3,
      templateFolders: [],
      base: { fields: { status: { type: "select", required: false, allowedValues: ["open"] } } },
      contracts: { base: { intent: "Base.", fields: {}, views: [] }, dormant: { intent: "Dormant.", fields: { status: { type: "text" } }, views: [] } },
      templates: {},
    };
    const decoded = decodeLegacyPolicy(bytes(policy));
    expect(decoded.selectionBlocked).toBe(false);
    expect(decoded.automaticMigrationBlocked).toBe(true);
    expect(decoded.policy.properties.status).toMatchObject({ type: "select", allowedValues: ["open"] });
    const historical = evaluateV3Policy(policy);
    expect(historical.disposition).toBe("review-required");
    if (historical.disposition === "review-required") expect(historical.code).toBe("BASE_CONTRACT_CONFLICT");
    const commonOnlyProjection = { ...policy, contracts: { base: { intent: "Base.", fields: {}, views: [] } } };
    expect(admitV3Note(commonOnlyProjection, "base", {}, undefined).valid).toBe(true);
    expect(comparable(decoded.policy, null, {}, "").valid).toBe(true);
    expect(comparable(decoded.policy, null, { status: "open" }, "").valid).toBe(true);
    expect(evaluateV3Policy(commonOnlyProjection).disposition).toBe("evaluated");
  });

  it("matches frozen v3 admission for an empty closed string set", () => {
    const policy = {
      version: 3,
      templateFolders: [],
      base: { fields: { status: { type: "select", required: true, allowedValues: [] } } },
      contracts: { base: { intent: "Base.", fields: {}, views: [] } },
      templates: {},
    };
    const decoded = decodeLegacyPolicy(bytes(policy));
    expect(evaluateV3Policy(policy).disposition).toBe("evaluated");
    expect(decoded.selectionBlocked).toBe(false);
    expect(decoded.policy.properties.status?.allowedValues).toEqual([]);
    const probes = [
      { value: "", historical: ["required"], active: ["required"] },
      { value: 1, historical: ["type"], active: ["type"] },
      { value: "open", historical: ["allowed-values"], active: ["allowed-values"] },
    ] as const;
    for (const probe of probes) {
      const historical = admitV3Note(policy, "base", { status: probe.value }, undefined);
      const active = comparable(decoded.policy, null, { status: probe.value }, "");
      expect(historical.valid).toBe(false);
      expect(active.valid).toBe(false);
      expect(historical.violations.map(item => item.rule)).toEqual([...probe.historical]);
      expect(active.ruleset).toEqual([...probe.active]);
    }
  });

  it("reviews non-equivalent v3 date, datetime, and open tags independently of list allowedValues", () => {
    const shell = { version: 3, templateFolders: [], contracts: { base: { intent: "Base.", fields: {}, views: [] } }, templates: {} };
    const date = { ...shell, base: { fields: { when: { type: "date", required: true } } } };
    const time = { ...shell, base: { fields: { at: { type: "datetime", required: true } } } };
    const tags = { ...shell, base: { fields: { tags: { type: "tags", required: true } } } };
    const labels = { ...shell, base: { fields: { labels: { type: "list", required: true, allowedValues: ["a"] } } } };
    for (const policy of [date, time, tags]) expect(decodeLegacyPolicy(bytes(policy)).selectionBlocked).toBe(true);
    expect(admitV3Note(date, "base", { when: "2026-02-31" }, undefined).valid).toBe(true);
    expect(admitV3Note(time, "base", { at: "2026-02-31T00:00:00Z" }, undefined).valid).toBe(true);
    expect(admitV3Note(tags, "base", { tags: ["bad tag"] }, undefined).valid).toBe(true);
    const historical = admitV3Note(labels, "base", { labels: ["a"] }, undefined);
    expect(historical.valid).toBe(false);
    expect(historical.violations.some(item => item.rule === "allowed-values")).toBe(true);
    expect(decodeLegacyPolicy(bytes(labels)).selectionBlocked).toBe(true);
  });

  it("reviews v4 datetime and open tags, while a closed valid tag set matches admission", () => {
    const empty = v4Corpus.shared.emptyDigest;
    const open = {
      version: 4,
      properties: { at: { type: "datetime", intent: "When." }, tags: { type: "tags", intent: "Tags." } },
      default: { templatePath: ".oms/templates/default.md", approvedMarkdown: "", approvedMarkdownDigest: empty, fields: { at: { property: "at", required: true }, tags: { property: "tags", required: true } }, headings: [], semanticCriteria: [] },
      templates: {},
    };
    expect(evaluateV4Policy(open, null).disposition).toBe("evaluated");
    expect(decodeLegacyPolicy(bytes(open)).selectionBlocked).toBe(true);
    expect(admitV4Note(open, null, { at: "2026-02-31T00:00:00Z", tags: ["bad tag"] }, "").valid).toBe(true);
    const closed = {
      version: 4,
      properties: { tags: { type: "tags", intent: "Tags.", allowedValues: ["alpha", "beta"] } },
      default: { templatePath: ".oms/templates/default.md", approvedMarkdown: "", approvedMarkdownDigest: empty, fields: { tags: { property: "tags", required: true, allowedValues: ["alpha"] } }, headings: [], semanticCriteria: [] },
      templates: {},
    };
    const decoded = decodeLegacyPolicy(bytes(closed));
    expect(decoded.selectionBlocked).toBe(false);
    if (decoded.policy.common.status !== "active") return;
    expect(decoded.policy.common.additionalHeadings).toBe("allow");
    const accepted = { tags: ["alpha"] };
    const rejected = { tags: ["beta"] };
    expect(comparable(decoded.policy, null, accepted, "").valid).toBe(admitV4Note(closed, null, accepted, "").valid);
    expect(comparable(decoded.policy, null, rejected, "").valid).toBe(admitV4Note(closed, null, rejected, "").valid);
  });

  it("keeps every unproven legacy heading pending, including H3", () => {
    const policy = v4Case("v4-omitted-order-inherits-and-omitted-values-do-not-clear");
    const layer = policy.default as { headings: unknown[]; approvedMarkdown: string; approvedMarkdownDigest: string };
    layer.headings = [{ headingId: "detail", title: "Detail", level: 3, required: true }];
    layer.approvedMarkdown = "### Detail\n";
    layer.approvedMarkdownDigest = "sha256:f3060281e5d8024870efdb1d3b97736dac1c9c709c2c7b0d8f149071a214eb6b";
    const decoded = decodeLegacyPolicy(bytes(policy));
    expect(decoded.policy.common.status).toBe("review-required");
    expect(decoded.reasons.join(" ")).toMatch(/heading/);
  });
  it("activates only the sealed nonempty required field from the v4FieldOnly snapshot", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../test/fixtures/contract-migrations/publication.json", import.meta.url), "utf8")) as { readonly v4FieldOnly: Record<string, unknown> };
    const raw = fixture.v4FieldOnly;
    const observed = raw.observedBase64 as Record<string, string>;
    const policyBytes = new Uint8Array(Buffer.from(String(raw.policyBase64), "base64"));
    const verified = verifyLegacyPublicationEvidence({
      format: "v4",
      markerPath: String(raw.markerPath),
      markerBytes: String(raw.markerText),
      planPath: String(raw.planPath),
      planBytes: String(raw.planText),
      policyBytes,
      observedOutputs: Object.fromEntries(Object.entries(observed).map(([path, encoded]) => [path, new Uint8Array(Buffer.from(encoded, "base64"))])),
    });
    expect(verified.status).toBe("verified");
    if (verified.status !== "verified") return;
    expect(verifiedLegacySource(verified.proof, policyBytes, "note")).toMatchObject({ identity: "note", path: "Templates/note.md", rawDigest: v4Corpus.shared.emptyDigest });
    const decoded = decodeLegacyPolicy(policyBytes, verified.proof);
    expect(decoded.selectionBlocked).toBe(false);
    expect(decoded.automaticMigrationBlocked).toBe(true);
    expect(decoded.inventory).toContainEqual(expect.objectContaining({ path: "/completion", disposition: "review-required" }));
    expect(decoded.policy.templates.note?.status).toBe("active");
    if (decoded.policy.templates.note?.status !== "active") return;
    expect(decoded.policy.templates.note.fields.status).toMatchObject({ required: true });
    expect(decoded.policy.templates.note.additionalHeadings).toBe("allow");
    const policy = JSON.parse(exactText(policyBytes)) as unknown;
    expect(comparable(decoded.policy, "note", { status: "open" }, "").valid).toBe(admitV4Note(policy, "note", { status: "open" }, "").valid);
    expect(comparable(decoded.policy, "note", {}, "").valid).toBe(admitV4Note(policy, "note", {}, "").valid);
    expect(verifiedLegacySource(JSON.parse(JSON.stringify(verified.proof)), policyBytes, "note")).toBeNull();
  });
  it("retains invalid template identities in inventory without fabricating entries or dropping common", () => {
    const v3 = {
      version: 3,
      templateFolders: [],
      base: { fields: { status: { type: "select", required: true, allowedValues: ["open"] } } },
      contracts: { base: { intent: "Base.", fields: {}, views: [] } },
      templates: { note: { templateId: "note", contract: "base" }, "bad id": { templateId: "bad id", contract: "base" } },
    };
    const decodedV3 = decodeLegacyPolicy(bytes(v3));
    expect(decodedV3.selectionBlocked).toBe(false);
    expect(decodedV3.automaticMigrationBlocked).toBe(true);
    expect(decodedV3.policy.properties.status).toMatchObject({ type: "select" });
    expect(decodedV3.policy.templates).not.toHaveProperty("bad id");
    expect(decodedV3.policy.templates.note?.status).toBe("review-required");
    expect(decodedV3.inventory.some(entry => entry.path === "/templates/bad id" && entry.disposition === "review-required")).toBe(true);
    expect(exactText(decodedV3.archive.bytes)).toContain("bad id");
    const empty = v4Corpus.shared.emptyDigest;
    const v4 = {
      version: 4,
      properties: { status: { type: "select", intent: "State.", allowedValues: ["open"] } },
      default: { templatePath: ".oms/templates/default.md", approvedMarkdown: "", approvedMarkdownDigest: empty, fields: { status: { property: "status", required: true } }, headings: [], semanticCriteria: [] },
      templates: {
        note: { templatePath: ".oms/templates/note.md", approvedMarkdown: "", approvedMarkdownDigest: empty, fields: { status: { property: "status" } }, headings: [], semanticCriteria: [] },
        "bad id": { templatePath: ".oms/templates/bad.md", approvedMarkdown: "", approvedMarkdownDigest: empty, fields: {}, headings: [], semanticCriteria: [] },
      },
    };
    const decodedV4 = decodeLegacyPolicy(bytes(v4));
    expect(decodedV4.selectionBlocked).toBe(false);
    expect(decodedV4.automaticMigrationBlocked).toBe(true);
    expect(decodedV4.policy.common.status).toBe("active");
    expect(decodedV4.policy.templates).not.toHaveProperty("bad id");
    expect(decodedV4.policy.templates.note?.status).toBe("review-required");
    expect(decodedV4.inventory.some(entry => entry.path === "/templates/bad id" && entry.disposition === "review-required")).toBe(true);
  });

  it("blocks automatic migration for malformed discovery folders without blocking valid common", () => {
    const base = { status: { type: "select", required: true, allowedValues: ["open"] } };
    const contracts = { base: { intent: "Base.", fields: {}, views: [] } };
    const cases = [
      [{ path: "Templates/../secret" }],
      [{ path: "Templates" }, { path: "Templates" }],
      [{ path: "Templates", default: "yes" }],
      [{ path: "Alpha", default: true }, { path: "Beta", default: true }],
    ];
    for (const templateFolders of cases) {
      const decoded = decodeLegacyPolicy(bytes({ version: 3, templateFolders, base: { fields: base }, contracts, templates: {} }));
      expect(decoded.selectionBlocked).toBe(false);
      expect(decoded.automaticMigrationBlocked).toBe(true);
      expect(decoded.policy.common.status).toBe("active");
      expect(decoded.policy.properties.status).toMatchObject({ type: "select", allowedValues: ["open"] });
      expect(decoded.inventory.some(entry => entry.path.startsWith("/templateFolders/") && entry.disposition === "review-required")).toBe(true);
    }
    const valid = decodeLegacyPolicy(bytes({ version: 3, templateFolders: [{ path: "Templates", default: true }], base: { fields: base }, contracts, templates: {} }));
    expect(valid.selectionBlocked).toBe(false);
    expect(valid.automaticMigrationBlocked).toBe(true);
    expect(valid.inventory.some(entry => entry.path === "/templateFolders" && entry.disposition === "review-required")).toBe(true);
    expect(valid.policy.common.status).toBe("active");
    expect(valid.inventory.some(entry => entry.path === "/templateFolders/0" && entry.disposition === "review-required")).toBe(true);
  });
  it("keeps a valid common draft when contracts.base is missing or non-vacuous and blocks automatic migration", () => {
    const base = { fields: { status: { type: "select", required: true, allowedValues: ["open"] } } };
    const missing = { version: 3, templateFolders: [], base, contracts: {}, templates: {} };
    const nonVacuous = { version: 3, templateFolders: [], base, contracts: { base: { intent: "Base.", fields: { extra: { type: "text" } }, views: [] } }, templates: {} };
    const alternate = { version: 3, templateFolders: [], base, contracts: { base: { intent: "Base.", fields: {}, views: [] }, alternate: { intent: "Alternate.", fields: {}, views: [] } }, templates: {} };
    for (const [policy, path] of [[missing, "/contracts"], [nonVacuous, "/contracts/base"], [alternate, "/contracts/alternate"]] as const) {
      const decoded = decodeLegacyPolicy(bytes(policy));
      expect(decoded.selectionBlocked).toBe(false);
      expect(decoded.automaticMigrationBlocked).toBe(true);
      expect(decoded.policy.common.status).toBe("active");
      expect(decoded.policy.properties.status).toMatchObject({ type: "select", allowedValues: ["open"] });
      expect(decoded.inventory.some(entry => entry.path === path && entry.disposition === "review-required")).toBe(true);
      expect(exactText(decoded.archive.bytes)).toContain("status");
      const historical = evaluateV3Policy(policy);
      expect(historical.disposition).toBe("evaluated");
      if (historical.disposition === "evaluated" && policy === missing) expect(historical.fields).not.toHaveProperty("base");
    }
  });

  it("blocks automatic migration for explicit v4 completion without dropping valid common", () => {
    const empty = v4Corpus.shared.emptyDigest;
    const policy = {
      version: 4,
      properties: { status: { type: "select", intent: "State.", allowedValues: ["open"] } },
      default: { templatePath: ".oms/templates/default.md", approvedMarkdown: "", approvedMarkdownDigest: empty, fields: { status: { property: "status", required: true } }, headings: [], semanticCriteria: [] },
      templates: {},
      completion: { retryBudget: 1, agentRepair: { enabled: false, contexts: [] } },
    };
    const decoded = decodeLegacyPolicy(bytes(policy));
    expect(decoded.selectionBlocked).toBe(false);
    expect(decoded.automaticMigrationBlocked).toBe(true);
    expect(decoded.policy.common.status).toBe("active");
    expect(decoded.inventory.some(entry => entry.path === "/completion" && entry.disposition === "review-required")).toBe(true);
    expect(exactText(decoded.archive.bytes)).toContain("retryBudget");
    expect(evaluateV4Policy(policy, null).disposition).toBe("evaluated");
  });

  it("does not activate a v4 field alias that the frozen oracle rejects", () => {
    const empty = v4Corpus.shared.emptyDigest;
    const policy = {
      version: 4,
      properties: { canonical: { type: "select", intent: "State.", allowedValues: ["open"] } },
      default: { templatePath: ".oms/templates/default.md", approvedMarkdown: "", approvedMarkdownDigest: empty, fields: { status: { property: "canonical", required: true } }, headings: [], semanticCriteria: [] },
      templates: {},
    };
    const decoded = decodeLegacyPolicy(bytes(policy));
    expect(evaluateV4Policy(policy, null).disposition).toBe("review-required");
    expect(decoded.selectionBlocked).toBe(true);
    expect(decoded.automaticMigrationBlocked).toBe(true);
    expect(decoded.policy.common.status).toBe("review-required");
    expect(decoded.policy.templates).toEqual({});
    expect(exactText(decoded.archive.bytes)).toContain("canonical");
  });
  it("archives exact duplicate policy bytes and blocks selection without an empty active common", () => {
    const raw = '{"version":3,"templates":{"note":{"contract":"base"},"note":{"contract":"other"}},"base":{"fields":{}}}';
    const decoded = decodeLegacyPolicy(raw);
    expect(Buffer.from(decoded.archive.bytes).equals(Buffer.from(raw, "utf8"))).toBe(true);
    expect(decoded.selectionBlocked).toBe(true);
    expect(decoded.automaticMigrationBlocked).toBe(true);
    expect(decoded.policy.common.status).toBe("review-required");
    expect(decoded.policy.templates).toEqual({});
    expect(decoded.policy.properties).toEqual({});
    expect(decoded.inventory).toEqual([expect.objectContaining({ path: "", disposition: "review-required" })]);
    expect(decoded.reasons.join(" ")).toMatch(/duplicate|not exhaustively interpreted/);
    expect(() => composeContractV5(decoded.policy, null)).toThrow("CONTRACT_REVIEW_REQUIRED");
    expect(() => composeContractV5(decoded.policy, "note")).toThrow("CONTRACT_UNKNOWN_TEMPLATE");
  });
  it("reports invalid UTF-8 through the legacy policy error boundary", () => {
    expect(() => decodeLegacyPolicy(Uint8Array.of(0xff))).toThrow("LEGACY_POLICY_INVALID");
  });
  it.each([[4, 5], [3, 4]])("archives ambiguous version %i → %i without trusting the survivor", (first, last) => {
    const raw = `{"version":${first},"version":${last},"templates":{}}\r\n`;
    const decoded = decodeLegacyPolicy(raw);
    expect(decoded.sourceVersion).toBeNull();
    expect(Buffer.from(decoded.archive.bytes).equals(Buffer.from(raw, "utf8"))).toBe(true);
    expect(decoded.selectionBlocked).toBe(true);
    expect(decoded.automaticMigrationBlocked).toBe(true);
    expect(decoded.policy.common).toMatchObject({ status: "review-required", legacy: { format: "oms.legacy-policy.unknown" } });
    expect(decoded.policy.templates).toEqual({});
    expect(decoded.policy.properties).toEqual({});
    expect(decoded.inventory).toEqual([expect.objectContaining({ path: "", disposition: "review-required" })]);
    expect(() => composeContractV5(decoded.policy, null)).toThrow("CONTRACT_REVIEW_REQUIRED");
  });
});
