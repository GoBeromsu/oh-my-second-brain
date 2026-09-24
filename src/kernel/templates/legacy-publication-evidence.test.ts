import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { digestBytes, hashCanonical } from "./canonical.js";
import { verifiedLegacySource, verifyLegacyPublicationEvidence, type LegacyPublicationEvidenceInput } from "./legacy-publication-evidence.js";
import { parseTemplatePolicy } from "./policy.js";

const fixture = JSON.parse(readFileSync(new URL("../../../test/fixtures/contract-migrations/publication.json", import.meta.url), "utf8")) as {
  readonly classification: string;
  readonly producerAttribution: string;
  readonly v3: Record<string, unknown>;
  readonly v3Ordered: Record<string, unknown>;
  readonly v3Canonical: Record<string, unknown>;
  readonly v4: Record<string, unknown>;
  readonly v4FieldOnly: Record<string, unknown>;
};

function bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}
function bundle(section: "v3" | "v3Ordered" | "v3Canonical" | "v4" | "v4FieldOnly", patch: Partial<LegacyPublicationEvidenceInput> = {}): LegacyPublicationEvidenceInput {
  const raw = fixture[section];
  const observed = raw["observedBase64"] as Record<string, string>;
  return {
    format: section.startsWith("v3") ? "v3" : "v4",
    markerPath: String(raw["markerPath"]),
    markerBytes: String(raw["markerText"]),
    planPath: String(raw["planPath"]),
    planBytes: String(raw["planText"]),
    policyBytes: bytes(String(raw["policyBase64"])),
    observedOutputs: Object.fromEntries(Object.entries(observed).map(([path, encoded]) => [path, bytes(encoded)])),
    ...patch,
  };
}
function localCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(localCanonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${localCanonical(record[key])}`).join(",")}}`;
}

interface SyntheticV4Plan {
  version: number;
  transactionId: string;
  approvalDigest: string;
  outputDigest: string;
  planDigest: string;
  boundaries: {
    path: string;
    templateId: string | null;
    expected: { state: "absent" | "present"; signature?: string };
    proposed: { state: "absent" | "present"; signature?: string };
  }[];
  outputs: { finalVaultRelativePath: string; payloadDigest: string }[];
}
/** Synthetic consistency seals only; the opaque approval token is not authorization. */
function resealV4(policyText: string, change?: (plan: SyntheticV4Plan, observed: Record<string, Uint8Array | null>) => void): LegacyPublicationEvidenceInput {
  const input = bundle("v4FieldOnly");
  const policyBytes = new TextEncoder().encode(policyText);
  const plan = JSON.parse(input.planBytes) as SyntheticV4Plan;
  const observed: Record<string, Uint8Array | null> = { ...input.observedOutputs, ".oms/template-policy.json": policyBytes };
  const policyBoundary = plan.boundaries.find(boundary => boundary.path === ".oms/template-policy.json")!;
  policyBoundary.proposed = { state: "present", signature: digestBytes(policyBytes) };
  change?.(plan, observed);
  plan.outputs = plan.outputs.map(output => {
    const content = observed[output.finalVaultRelativePath];
    return { ...output, payloadDigest: content instanceof Uint8Array ? digestBytes(content) : output.payloadDigest };
  });
  plan.outputDigest = hashCanonical("oms.contract-publish.output.v1", {
    outputs: [...plan.outputs].sort((left, right) => left.finalVaultRelativePath < right.finalVaultRelativePath ? -1 : left.finalVaultRelativePath > right.finalVaultRelativePath ? 1 : 0),
  });
  plan.transactionId = createHash("sha256").update(`${plan.approvalDigest}\0${plan.outputDigest}`).digest("hex").slice(0, 32);
  const { planDigest: _oldPlanDigest, ...material } = plan;
  plan.planDigest = hashCanonical("oms.contract-publish.plan.v1", material);
  const marker = { status: "complete", transactionId: plan.transactionId, approvalDigest: plan.approvalDigest, outputDigest: plan.outputDigest, planDigest: plan.planDigest };
  return {
    ...input,
    policyBytes,
    observedOutputs: observed,
    planPath: `.oms/.template-transactions/${plan.transactionId}/plan.json`,
    planBytes: `${localCanonical(plan)}\n`,
    markerBytes: `${localCanonical({ ...marker, checksum: hashCanonical("oms.contract-publish.marker.v1", marker) })}\n`,
  };
}
function snapshotPolicy() {
  return JSON.parse(new TextDecoder().decode(bundle("v4FieldOnly").policyBytes)) as {
    version?: number;
    templates: Record<string, {
      templateId: string;
      templatePath: string;
      approvedMarkdown: string;
      approvedMarkdownDigest: string;
      source: { identity: string; path: string; rawDigest: string };
    }>;
  };
}

describe("legacy publication protocol fixture", () => {
  it("keeps static historical pins and does not claim the uncaptured producer", () => {
    expect(fixture.classification).toBe("protocol-fixture");
    expect(fixture.producerAttribution).toBe("unavailable");
    const v3 = fixture.v3;
    const parsedMarker = JSON.parse(String(v3["markerText"])) as Record<string, unknown>;
    const bare = { ...parsedMarker };
    delete bare["checksum"];
    expect(digestBytes(localCanonical(bare))).toBe(v3["checksum"]);
    expect(digestBytes(String(v3["planText"]).replace(/\n$/, ""))).toBe(v3["planDigest"]);
    expect(createHash("sha256").update(`${v3["approvalDigest"]}\0${v3["outputDigest"]}`).digest("hex").slice(0, 32)).toBe(v3["transactionId"]);
    const v4 = fixture.v4;
    const v4Marker = JSON.parse(String(v4["markerText"])) as Record<string, string>;
    expect(v4["checksum"]).toBe("sha256:a59ef49c17190a03eb1df0ebc16f476a685acb67ad6eee138f697ce0e9a3ade7");
    expect(v4["planDigest"]).toBe("sha256:1e86e601226a52464298cda9cd7df228e44edbea15095c5960a1f2f436a5ccc5");
    expect(v4["transactionId"]).toBe("e365c2672e2c49964b0270df55ccffe3");
    expect(v4Marker["checksum"]).toBe(v4["checksum"]);
    expect(v4Marker["planDigest"]).toBe(v4["planDigest"]);
    expect(createHash("sha256").update(`${v4["approvalDigest"]}\0${v4["outputDigest"]}`).digest("hex").slice(0, 32)).toBe(v4["transactionId"]);
    expect(fixture.v3Ordered["transactionId"]).toBe("fe5ef95fd03a4916f4eaa94404104ad5");
    expect(fixture.v3Ordered["planDigest"]).toBe("sha256:300f78c6991ddc2b79da0d7efacf4272e637e5847529973f556397ec14967f93");
    expect(fixture.v3Ordered["checksum"]).toBe("sha256:b20126a447af96ea3c9641837078794bcbcf8f50fa6809e38624bfde324c21cc");
    expect(fixture.v3["planDigest"]).toBe("sha256:882c53ffee3396a165dd96eb601f6104553365c86a794680ccd3c40e3e9811c7");
    expect(fixture.v3["checksum"]).toBe("sha256:1b44b830d75f5c6aac1240748413559e5ebff72429350c025ba5b7c6cb1d0c36");
    expect(fixture.v3Canonical["transactionId"]).toBe("b44c7d0d84c258b86efe3aff676b0ee8");
    expect(fixture.v3Canonical["planDigest"]).toBe("sha256:2b0b60060b8e5d30b177496d55eb0dacec2df64b55ab55801cc09d7adbc3d124");
    expect(fixture.v3Canonical["checksum"]).toBe("sha256:09b84ab8a75685599f770abc3dc124d8e611e77eeb91c200d4dee09bc88c4820");
  });

  it("verifies the ordered v3 transaction without inventing absent policy source bindings", () => {
    const ordered = bundle("v3Canonical");
    const result = verifyLegacyPublicationEvidence(ordered);
    expect(result.status, JSON.stringify(result)).toBe("verified");
    if (result.status !== "verified") return;
    expect(result.proof).toEqual({ format: "v3", policyDigest: digestBytes(ordered.policyBytes), sealDigest: fixture.v3Canonical["approvalDigest"] });
    expect(Object.keys(ordered.observedOutputs)).toHaveLength(9);
    expect(result.unavailableSources.map(source => source.templateId)).toEqual(["alpha", "beta", "delta", "epsilon", "gamma", "zeta"]);
    for (const source of result.unavailableSources) {
      expect(source.reason).toContain("captured policy does not bind");
      expect(verifiedLegacySource(result.proof, ordered.policyBytes, source.templateId)).toBeNull();
    }
    expect(verifiedLegacySource(JSON.parse(JSON.stringify(result.proof)), ordered.policyBytes, "alpha")).toBeNull();
    expect(verifiedLegacySource({ ...result.proof, approved: true }, ordered.policyBytes, "alpha")).toBeNull();
    expect(verifiedLegacySource(result.proof, new Uint8Array([1]), "alpha")).toBeNull();
    expect(verifiedLegacySource(result.proof, ordered.policyBytes, "missing")).toBeNull();
    const unordered = verifyLegacyPublicationEvidence(bundle("v3"));
    expect(unordered.status).toBe("invalid");
    if (unordered.status === "invalid") expect(unordered.reasons).toEqual(["v3 sources are not ordered"]);
    const unsortedInput = verifyLegacyPublicationEvidence(bundle("v3Ordered"));
    expect(unsortedInput.status).toBe("invalid");
    if (unsortedInput.status === "invalid") expect(unsortedInput.reasons).toEqual(["v3 input digest does not match revived InputV2"]);
  });

  it("rejects a tampered marker, wrong policy, wrong path, wrong id, and a missing plan", () => {
    const valid = bundle("v3Canonical");
    const marker = JSON.parse(valid.markerBytes) as Record<string, unknown>;
    const tampered = { ...marker, outputDigest: `sha256:${"ab".repeat(32)}` };
    expect(verifyLegacyPublicationEvidence({ ...valid, markerBytes: `${localCanonical(tampered)}\n` }).status).toBe("invalid");
    expect(verifyLegacyPublicationEvidence({ ...valid, policyBytes: Uint8Array.of(9) }).status).toBe("invalid");
    expect(verifyLegacyPublicationEvidence({ ...valid, planPath: valid.planPath.replace("template-migration", "other") }).status).toBe("invalid");
    expect(verifyLegacyPublicationEvidence({ ...valid, markerPath: ".oms/template-backfill.json" }).status).toBe("invalid");
    expect(verifyLegacyPublicationEvidence({ ...valid, planBytes: "" }).status).toBe("invalid");
  });

  it("keeps in-progress unavailable and rejects duplicates, ordinary paths, BOM, and CRLF", () => {
    const valid = bundle("v3Canonical");
    const marker = JSON.parse(valid.markerBytes) as Record<string, unknown>;
    const progress = { ...marker, status: "in-progress" };
    const bare = { ...progress };
    delete bare["checksum"];
    progress["checksum"] = digestBytes(localCanonical(bare));
    expect(verifyLegacyPublicationEvidence({ ...valid, markerBytes: `${localCanonical(progress)}\n` }).status).toBe("unavailable");
    expect(verifyLegacyPublicationEvidence({ ...valid, observedOutputs: { ...valid.observedOutputs, "Sources/alpha.md": null } }).status).toBe("invalid");
    expect(verifyLegacyPublicationEvidence({ ...valid, observedOutputs: { ...valid.observedOutputs, "notes/ordinary.md": Uint8Array.of(1) } }).status).toBe("invalid");
    expect(verifyLegacyPublicationEvidence({ ...valid, markerBytes: `\uFEFF${valid.markerBytes}` }).status).toBe("invalid");
    expect(verifyLegacyPublicationEvidence({ ...valid, planBytes: valid.planBytes.replaceAll("\n", "\r\n") }).status).toBe("invalid");
  });

  it("verifies v4 seals while leaving historical sources unavailable", () => {
    const result = verifyLegacyPublicationEvidence(bundle("v4"));
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    expect(result.proof.policyDigest).toBe(digestBytes(bytes(String(fixture.v4["policyBase64"]))));
    expect(result.proof.sealDigest).toBe(fixture.v4["approvalDigest"]);
    expect(result.unavailableSources.map(item => item.templateId)).toEqual(["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]);
    expect(verifiedLegacySource(result.proof, bytes(String(fixture.v4["policyBase64"])), "alpha")).toBeNull();
    const valid = bundle("v4");
    expect(verifyLegacyPublicationEvidence({ ...valid, policyBytes: new Uint8Array([3]) }).status).toBe("invalid");
    expect(verifyLegacyPublicationEvidence({ ...valid, planPath: `${valid.planPath}.missing` }).status).toBe("invalid");
    expect(verifyLegacyPublicationEvidence({ ...valid, markerPath: ".oms/template-migration.json" }).status).toBe("invalid");
    expect(verifyLegacyPublicationEvidence({ ...valid, format: "v5" as "v4" }).status).toBe("unavailable");
    const marker = JSON.parse(valid.markerBytes) as Record<string, unknown>;
    marker["status"] = "in-progress";
    expect(verifyLegacyPublicationEvidence({ ...valid, markerBytes: `${JSON.stringify(marker)}\n` }).status).toBe("invalid");
    expect(verifyLegacyPublicationEvidence({ ...valid, markerBytes: `\uFEFF${valid.markerBytes}` }).status).toBe("invalid");
    const progressMaterial = { status: "in-progress" as const, transactionId: marker["transactionId"], approvalDigest: marker["approvalDigest"], outputDigest: marker["outputDigest"], planDigest: marker["planDigest"] };
    const progress = { ...progressMaterial, checksum: hashCanonical("oms.contract-publish.marker.v1", progressMaterial) };
    expect(verifyLegacyPublicationEvidence({ ...valid, markerBytes: `${localCanonical(progress)}\n` }).status).toBe("unavailable");
    expect(verifyLegacyPublicationEvidence({ ...valid, observedOutputs: { ...valid.observedOutputs, ".oms/templates/alpha.md": null } }).status).toBe("invalid");
    expect(verifyLegacyPublicationEvidence({ ...valid, planBytes: valid.planBytes.replaceAll("\n", "\r\n") }).status).toBe("invalid");
    const verified = verifyLegacyPublicationEvidence(valid);
    expect(verified.status).toBe("verified");
    if (verified.status !== "verified") return;
    expect(verified.unavailableSources).toHaveLength(6);
    expect(verifiedLegacySource(verified.proof, valid.policyBytes, "alpha")).toBeNull();
  });
  it("returns a field-only verified historical policy snapshot and rejects stale identity, path, and digest", () => {
    const valid = bundle("v4FieldOnly");
    const result = verifyLegacyPublicationEvidence(valid);
    expect(result.status, JSON.stringify(result)).toBe("verified");
    if (result.status !== "verified") return;
    const source = verifiedLegacySource(result.proof, valid.policyBytes, "note");
    expect(source).toMatchObject({ identity: "note", path: "Templates/note.md", rawDigest: fixture.v4FieldOnly["emptyDigest"] });
    expect(source?.historicalBytes).toEqual(new Uint8Array());
    expect(verifiedLegacySource(JSON.parse(JSON.stringify(result.proof)), valid.policyBytes, "note")).toBeNull();
    expect(verifiedLegacySource({ approved: true, ...result.proof }, valid.policyBytes, "note")).toBeNull();
    const policy = JSON.parse(new TextDecoder().decode(valid.policyBytes)) as { templates: { note: { source: { identity: string; path: string; rawDigest: string } } } };
    policy.templates.note.source.identity = "other";
    expect(verifiedLegacySource(result.proof, new TextEncoder().encode(JSON.stringify(policy)), "note")).toBeNull();
    policy.templates.note.source.identity = "note";
    policy.templates.note.source.path = "Templates/other.md";
    expect(verifiedLegacySource(result.proof, new TextEncoder().encode(JSON.stringify(policy)), "note")).toBeNull();
    policy.templates.note.source.path = "Templates/note.md";
    policy.templates.note.source.rawDigest = `sha256:${"ab".repeat(32)}`;
    expect(verifiedLegacySource(result.proof, new TextEncoder().encode(JSON.stringify(policy)), "note")).toBeNull();
  });

  it("witnesses unchanged policy snapshots outside the write set and isolates nonempty returned bytes", () => {
    const policy = snapshotPolicy();
    const text = "Historical policy snapshot.\r\n";
    policy.templates.unchanged = {
      ...structuredClone(policy.templates.note!),
      templateId: "unchanged",
      templatePath: ".oms/templates/unchanged.md",
      approvedMarkdown: text,
      approvedMarkdownDigest: digestBytes(text),
      source: { identity: "unchanged-source", path: "Templates/unchanged.md", rawDigest: digestBytes(text) },
    };
    expect(() => parseTemplatePolicy(policy)).not.toThrow();
    const input = resealV4(JSON.stringify(policy));
    expect(Object.hasOwn(input.observedOutputs, "Templates/unchanged.md")).toBe(false);
    expect(Object.hasOwn(input.observedOutputs, ".oms/templates/unchanged.md")).toBe(false);
    const result = verifyLegacyPublicationEvidence(input);
    expect(result.status, JSON.stringify(result)).toBe("verified");
    if (result.status !== "verified") return;
    expect(Object.keys(result.proof).sort()).toEqual(["format", "policyDigest", "sealDigest"]);
    const source = verifiedLegacySource(result.proof, input.policyBytes, "unchanged");
    expect(source?.historicalBytes).toEqual(new TextEncoder().encode(text));
    source!.historicalBytes[0] = 0;
    expect(verifiedLegacySource(result.proof, input.policyBytes, "unchanged")?.historicalBytes).toEqual(new TextEncoder().encode(text));
  });

  it("rejects a freshly sealed v4 draft deletion rather than treating it as a write", () => {
    const input = resealV4(JSON.stringify(snapshotPolicy()), (plan, observed) => {
      const draft = plan.boundaries.find(boundary => boundary.templateId === "note")!;
      draft.expected = { state: "present", signature: draft.proposed.signature! };
      draft.proposed = { state: "absent" };
      plan.outputs = plan.outputs.filter(output => output.finalVaultRelativePath !== draft.path);
      delete observed[draft.path];
    });
    expect(verifyLegacyPublicationEvidence(input)).toMatchObject({ status: "invalid", reasons: ["v4 boundary is not a closed path and signature pair"] });
  });

  it.each(["missing-version", "wrong-id", "unsafe-path", "empty-identity", "control-identity", "raw-digest", "approved-digest"] as const)(
    "withholds a source witness from freshly sealed %s policy",
    flaw => {
      const policy = snapshotPolicy();
      const note = policy.templates.note!;
      if (flaw === "missing-version") delete policy.version;
      if (flaw === "wrong-id") note.templateId = "other";
      if (flaw === "unsafe-path") note.source.path = "../outside.md";
      if (flaw === "empty-identity") note.source.identity = " ";
      if (flaw === "control-identity") note.source.identity = "note\nsource";
      if (flaw === "raw-digest") note.source.rawDigest = digestBytes("different source");
      if (flaw === "approved-digest") note.approvedMarkdownDigest = digestBytes("different snapshot");
      const input = resealV4(JSON.stringify(policy));
      const result = verifyLegacyPublicationEvidence(input);
      expect(result.status, JSON.stringify(result)).toBe("verified");
      if (result.status !== "verified") return;
      expect(verifiedLegacySource(result.proof, input.policyBytes, "note")).toBeNull();
      expect(result.unavailableSources.map(source => source.templateId)).toContain("note");
    },
  );

  it("does not erase duplicate raw policy members when issuing source witnesses", () => {
    const policy = snapshotPolicy();
    const raw = JSON.stringify(policy).replace('"note":', `"note":${JSON.stringify(policy.templates.note)},"note":`);
    const input = resealV4(raw);
    const result = verifyLegacyPublicationEvidence(input);
    expect(result.status, JSON.stringify(result)).toBe("verified");
    if (result.status !== "verified") return;
    expect(verifiedLegacySource(result.proof, input.policyBytes, "note")).toBeNull();
    expect(result.unavailableSources.map(source => source.templateId)).toContain("note");
  });

  it.each([[4, 5], [3, 4]])("withholds witnesses for duplicate version %i → %i", (first, last) => {
    const raw = JSON.stringify(snapshotPolicy()).replace('"version":4', `"version":${first},"version":${last}`);
    const input = resealV4(raw);
    const result = verifyLegacyPublicationEvidence(input);
    expect(result.status, JSON.stringify(result)).toBe("verified");
    if (result.status !== "verified") return;
    expect(verifiedLegacySource(result.proof, input.policyBytes, "note")).toBeNull();
    expect(result.unavailableSources.map(source => source.templateId)).toContain("note");
  });

  it.each(["marker", "plan", "boundary", "output"] as const)("refuses unsealed %s authorization metadata", where => {
    const input = resealV4(JSON.stringify(snapshotPolicy()));
    const marker = JSON.parse(input.markerBytes) as Record<string, unknown>;
    const plan = JSON.parse(input.planBytes) as Record<string, unknown>;
    if (where === "marker") marker["humanApproved"] = true;
    if (where === "plan") plan["authorization"] = "owner";
    if (where === "boundary") (plan["boundaries"] as Record<string, unknown>[])[0]!["authorization"] = "owner";
    if (where === "output") (plan["outputs"] as Record<string, unknown>[])[0]!["authorization"] = "owner";
    const result = verifyLegacyPublicationEvidence({ ...input, markerBytes: `${localCanonical(marker)}\n`, planBytes: `${localCanonical(plan)}\n` });
    expect(result.status).toBe("invalid");
  });
});
