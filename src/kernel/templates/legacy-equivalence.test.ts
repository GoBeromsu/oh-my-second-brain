import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateContractV5 } from "./contract-check.js";
import { digestBytes, hashCanonical } from "./canonical.js";
import { composeContractV5 } from "./contract-v5.js";
import {
  createLegacyEquivalenceArchive,
  executeLegacyDecoderEquivalence,
  materializeLegacyEquivalenceArchive,
  replayLegacyDecoderEquivalence,
  LEGACY_DECODER_EXECUTION_VERSION,
  type LegacyEquivalenceArchiveInput,
  type LegacyEquivalenceExecution,
  type LegacyEquivalenceMaterial,
  type LegacyEquivalenceProof,
} from "./legacy-equivalence.js";
import { admitV4Note } from "../../../test/fixtures/contract-migrations/legacy-oracle.js";

/**
 * Honest synthetic consistency seals seeded from the read-only publication fixture.
 * These cases do not prove full migration behavior, live original observation,
 * publication atomicity, activation, or human authorization. The fixture file is
 * never written, and its negative pins are never changed.
 */

const fixture = JSON.parse(readFileSync(new URL("../../../test/fixtures/contract-migrations/publication.json", import.meta.url), "utf8")) as {
  readonly v4FieldOnly: Record<string, unknown>;
};
const encoder = new TextEncoder();
const EMPTY_DIGEST = String(fixture.v4FieldOnly["emptyDigest"]);

interface SyntheticPlan {
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

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function localCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(localCanonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${localCanonical(record[key])}`).join(",")}}`;
}

function seedBundle(): LegacyEquivalenceArchiveInput {
  const raw = fixture.v4FieldOnly;
  const observed = raw["observedBase64"] as Record<string, string>;
  return {
    format: "v4",
    markerPath: String(raw["markerPath"]),
    markerBytes: encoder.encode(String(raw["markerText"])),
    planPath: String(raw["planPath"]),
    planBytes: encoder.encode(String(raw["planText"])),
    policyPath: ".oms/template-policy.json",
    policyBytes: decodeBase64(String(raw["policyBase64"])),
    observedOutputs: new Map(Object.entries(observed).map(([path, encoded]) => [path, decodeBase64(encoded)])),
  };
}

function snapshotPolicy(): {
  version: number;
  properties: Record<string, { type: string; intent: string; allowedValues?: string[] }>;
  default: Record<string, unknown>;
  templates: Record<string, Record<string, unknown>>;
  completion?: unknown;
} {
  return JSON.parse(new TextDecoder().decode(seedBundle().policyBytes));
}

/** Inline synthetic seal. The fixture approval token is consistency material, not authorization. */
function reseal(policyText: string, change?: (plan: SyntheticPlan, observed: Map<string, Uint8Array>) => void): LegacyEquivalenceArchiveInput {
  const seed = seedBundle();
  const policyBytes = encoder.encode(policyText);
  const plan = JSON.parse(new TextDecoder().decode(seed.planBytes)) as SyntheticPlan;
  const observed = new Map(seed.observedOutputs);
  observed.set(".oms/template-policy.json", policyBytes);
  const boundary = plan.boundaries.find(item => item.path === ".oms/template-policy.json");
  if (boundary === undefined) throw new Error("synthetic policy boundary missing");
  boundary.proposed = { state: "present", signature: digestBytes(policyBytes) };
  change?.(plan, observed);
  plan.outputs = plan.outputs.map(output => {
    const content = observed.get(output.finalVaultRelativePath);
    return { ...output, payloadDigest: content instanceof Uint8Array ? digestBytes(content) : output.payloadDigest };
  });
  plan.outputDigest = hashCanonical("oms.contract-publish.output.v1", {
    outputs: [...plan.outputs].sort((left, right) => left.finalVaultRelativePath < right.finalVaultRelativePath ? -1 : left.finalVaultRelativePath > right.finalVaultRelativePath ? 1 : 0),
  });
  plan.transactionId = createHash("sha256").update(`${plan.approvalDigest}\0${plan.outputDigest}`).digest("hex").slice(0, 32);
  const { planDigest: _ignored, ...material } = plan;
  plan.planDigest = hashCanonical("oms.contract-publish.plan.v1", material);
  const marker = { status: "complete", transactionId: plan.transactionId, approvalDigest: plan.approvalDigest, outputDigest: plan.outputDigest, planDigest: plan.planDigest };
  return {
    format: "v4",
    markerPath: ".oms/template-transaction.json",
    markerBytes: encoder.encode(`${localCanonical({ ...marker, checksum: hashCanonical("oms.contract-publish.marker.v1", marker) })}\n`),
    planPath: `.oms/.template-transactions/${plan.transactionId}/plan.json`,
    planBytes: encoder.encode(`${localCanonical(plan)}\n`),
    policyPath: ".oms/template-policy.json",
    policyBytes,
    observedOutputs: observed,
  };
}
function commonOnly(policyText: string): LegacyEquivalenceArchiveInput {
  return reseal(policyText, (plan, observed) => {
    plan.boundaries = plan.boundaries.filter(boundary => boundary.templateId === null);
    plan.outputs = plan.outputs.filter(output => plan.boundaries.some(boundary => boundary.path === output.finalVaultRelativePath));
    for (const path of [...observed.keys()]) {
      if (!plan.outputs.some(output => output.finalVaultRelativePath === path)) observed.delete(path);
    }
  });
}

function commonPolicy(completion = false): Record<string, unknown> {
  return {
    version: 4,
    properties: { status: { type: "select", intent: "Workflow state.", allowedValues: ["open", "closed"] } },
    default: {
      templatePath: ".oms/templates/default.md",
      approvedMarkdown: "",
      approvedMarkdownDigest: EMPTY_DIGEST,
      fields: { status: { property: "status", required: true, allowedValues: ["open"] } },
      headings: [],
      semanticCriteria: [],
    },
    templates: {},
    ...(completion ? { completion: { retryBudget: 2, agentRepair: { enabled: false } } } : {}),
  };
}

function notePolicy(): Record<string, unknown> {
  const policy = snapshotPolicy();
  delete policy.completion;
  return policy;
}

function archive(input: LegacyEquivalenceArchiveInput = seedBundle()) {
  return createLegacyEquivalenceArchive(input);
}

function proved(input: LegacyEquivalenceArchiveInput = reseal(JSON.stringify(notePolicy()))): Extract<LegacyEquivalenceExecution, { disposition: "proved" }> {
  const execution = executeLegacyDecoderEquivalence(archive(input));
  expect(execution.disposition, JSON.stringify(execution)).toBe("proved");
  if (execution.disposition !== "proved") throw new Error("synthetic proof was not minted");
  return execution;
}

describe("legacy decoder equivalence", () => {
  it("rejects forged public proof", () => {
    const execution = proved();
    const same = archive(reseal(JSON.stringify(notePolicy())));
    expect(replayLegacyDecoderEquivalence({}, same)).toMatchObject({ disposition: "rejected" });
    const forged = { equivalent: true, approved: true, material: execution.proposal.material, candidate: execution.proposal.candidate } as unknown as LegacyEquivalenceProof;
    expect(replayLegacyDecoderEquivalence(forged, same)).toMatchObject({ disposition: "rejected" });
    expect(replayLegacyDecoderEquivalence(JSON.parse(JSON.stringify(execution.proof)), same)).toMatchObject({ disposition: "rejected" });
    expect(replayLegacyDecoderEquivalence(execution.proof, same).disposition).toBe("recovered");
  });

  it("rejects observer evidence mismatch", () => {
    const execution = proved();
    const changed = reseal(JSON.stringify(notePolicy()));
    const types = changed.observedOutputs.get(".oms/types.json");
    if (types === undefined) throw new Error("seed observation missing");
    changed.observedOutputs.set(".oms/types.json", Uint8Array.of(...types, 1));
    expect(executeLegacyDecoderEquivalence(archive(changed)).disposition).not.toBe("proved");
    expect(replayLegacyDecoderEquivalence(execution.proof, archive(changed)).disposition).toBe("rejected");
  });

  it("isolates candidate mutation", () => {
    const input = reseal(JSON.stringify(notePolicy()));
    const first = archive(input);
    const execution = executeLegacyDecoderEquivalence(first);
    expect(execution.disposition).toBe("proved");
    if (execution.disposition !== "proved") return;
    const original = execution.proposal.candidate.canonicalPolicy;
    const owned = materializeLegacyEquivalenceArchive(first).policy.digest;
    (execution.proposal.candidate as { canonicalPolicy: string }).canonicalPolicy = "mutated";
    (execution.proposal.candidate.policy as { revision: number }).revision = 99;
    execution.proposal.decoding.archive.bytes[0] = 0;
    input.policyBytes[0] = 0;
    input.observedOutputs.clear();
    const recovered = replayLegacyDecoderEquivalence(execution.proof, archive(reseal(JSON.stringify(notePolicy()))));
    expect(recovered.disposition).toBe("recovered");
    if (recovered.disposition !== "recovered") return;
    expect(recovered.candidate.canonicalPolicy).toBe(original);
    expect(recovered.material.policy.digest).toBe(owned);
    expect(recovered.candidate.policy.revision).toBe(0);
  });

  it("binds every raw component", () => {
    const baseline = reseal(JSON.stringify(notePolicy()));
    const callerMarker = baseline.markerBytes;
    const callerPlan = baseline.planBytes;
    const callerPolicy = baseline.policyBytes;
    const callerObserved = baseline.observedOutputs.get(".oms/types.json");
    if (callerObserved === undefined) throw new Error("seed observation missing");
    const created = archive(baseline);
    callerMarker[0] = 0;
    callerPlan[0] = 0;
    callerPolicy[0] = 0;
    callerObserved[0] = 0;
    baseline.observedOutputs.clear();
    expect(materializeLegacyEquivalenceArchive(created).policy.digest).not.toBe(digestBytes(callerPolicy));

    const fresh = reseal(JSON.stringify(notePolicy()));
    const mismatches: LegacyEquivalenceArchiveInput[] = [
      { ...fresh, markerBytes: Uint8Array.of(0xef, 0xbb, 0xbf, ...fresh.markerBytes) },
      { ...fresh, planBytes: Uint8Array.of(0xef, 0xbb, 0xbf, ...fresh.planBytes) },
      { ...fresh, policyBytes: Uint8Array.of(0xef, 0xbb, 0xbf, ...fresh.policyBytes) },
      { ...fresh, markerPath: ".oms/template-migration.json" },
      { ...fresh, planPath: `${fresh.planPath}.other` },
      { ...fresh, observedOutputs: new Map([...fresh.observedOutputs].map(([path, bytes]) => [path, path.endsWith("types.json") ? Uint8Array.of(...bytes, 2) : bytes])) },
    ];
    for (const mismatch of mismatches) {
      const execution = executeLegacyDecoderEquivalence(archive(mismatch));
      expect(execution.disposition).not.toBe("proved");
    }
    expect(replayLegacyDecoderEquivalence(proved(fresh).proof, archive(mismatches[0]!)).disposition).toBe("rejected");
  });

  it("replays deterministic material and candidate", () => {
    const text = JSON.stringify(notePolicy());
    const first = reseal(text);
    const reversed = new Map([...first.observedOutputs].reverse());
    const second = reseal(text);
    second.observedOutputs.clear();
    for (const [path, bytes] of reversed) second.observedOutputs.set(path, bytes);
    const proof = proved(first);
    const recovered = replayLegacyDecoderEquivalence(proof.proof, archive(second));
    expect(recovered.disposition).toBe("recovered");
    if (recovered.disposition !== "recovered") return;
    expect(recovered.material).toEqual(proof.proposal.material);
    expect(recovered.candidate.canonicalPolicy).toBe(proof.proposal.candidate.canonicalPolicy);

    const changed = snapshotPolicy();
    delete changed.completion;
    (changed.properties.status!.allowedValues as string[]).push("archived");
    const other = reseal(JSON.stringify(changed));
    const resealed = executeLegacyDecoderEquivalence(archive(other));
    expect(resealed.disposition, JSON.stringify(resealed)).toBe("proved");
    if (resealed.disposition !== "proved") return;
    expect(resealed.proposal.material.archiveDigest).not.toBe(proof.proposal.material.archiveDigest);
    expect(resealed.proposal.candidate.canonicalPolicy).not.toBe(proof.proposal.candidate.canonicalPolicy);
    expect(replayLegacyDecoderEquivalence(proof.proof, archive(other)).disposition).toBe("rejected");
  });

  it("withholds proof for blocked metadata", () => {
    const execution = executeLegacyDecoderEquivalence(archive(commonOnly(JSON.stringify(commonPolicy(true)))));
    expect(execution.disposition, JSON.stringify(execution)).toBe("proposed");
    if (execution.disposition !== "proposed") return;
    expect(execution.proposal.decoding.automaticMigrationBlocked).toBe(true);
    expect(execution.proposal.decoding.inventory).toContainEqual(expect.objectContaining({ path: "/completion", disposition: "review-required" }));
    expect(execution.proposal.candidate.sourceVersion).toBe(4);
    expect("proof" in execution).toBe(false);
  });

  it("proves only valid synthetic common fields", () => {
    const policy = commonPolicy();
    const execution = executeLegacyDecoderEquivalence(archive(commonOnly(JSON.stringify(policy))));
    expect(execution.disposition, JSON.stringify(execution)).toBe("proved");
    if (execution.disposition !== "proved") return;
    expect(execution.proposal.candidate.policy.templates).toEqual({});
    const contract = composeContractV5(execution.proposal.candidate.policy, null);
    const accepted = { status: "open" };
    const rejected = { status: "closed" };
    expect(evaluateContractV5(accepted, "", contract).valid).toBe(admitV4Note(policy, null, accepted, "").valid);
    expect(evaluateContractV5(rejected, "", contract).valid).toBe(admitV4Note(policy, null, rejected, "").valid);
    expect(admitV4Note(policy, null, rejected, "").valid).toBe(false);
  });

  it("distinguishes available and unavailable historical sources", () => {
    const available = proved(reseal(JSON.stringify(notePolicy())));
    expect(available.proposal.availableHistoricalSources).toContainEqual(expect.objectContaining({
      templateId: "note",
      identity: "note",
      path: "Templates/note.md",
      rawDigest: EMPTY_DIGEST,
    }));
    expect(available.proposal.availableHistoricalSources[0]?.historicalBytes).toEqual(new Uint8Array());
    expect(available.proposal.unavailableHistoricalSources).toEqual([]);

    const policy = snapshotPolicy();
    delete policy.completion;
    policy.templates.other = {
      ...structuredClone(policy.templates.note!),
      templateId: "other",
      templatePath: ".oms/templates/other.md",
      source: { identity: "other", path: "Templates/other.md", rawDigest: `sha256:${"ab".repeat(32)}` },
    };
    const input = reseal(JSON.stringify(policy), plan => {
      plan.boundaries.push({ path: ".oms/templates/other.md", templateId: "other", expected: { state: "absent" }, proposed: { state: "present", signature: EMPTY_DIGEST } });
      plan.outputs.push({ finalVaultRelativePath: ".oms/templates/other.md", payloadDigest: EMPTY_DIGEST });
    });
    input.observedOutputs.set(".oms/templates/other.md", new Uint8Array());
    const execution = executeLegacyDecoderEquivalence(archive(input));
    expect(execution.disposition).toBe("proposed");
    if (execution.disposition !== "proposed") return;
    expect(execution.proposal.unavailableHistoricalSources.map(source => source.templateId)).toContain("other");
    expect(execution.proposal.availableHistoricalSources.map(source => source.templateId)).toContain("note");
    expect(execution.proposal.availableHistoricalSources.find(source => source.templateId === "other")).toBeUndefined();
    expect("proof" in execution).toBe(false);
  });

  it("keeps marker-absent common-only observation blocked", () => {
    const input = commonOnly(JSON.stringify(commonPolicy()));
    input.markerBytes = encoder.encode("{}\n");
    input.planBytes = encoder.encode("{}\n");
    const execution = executeLegacyDecoderEquivalence(archive(input));
    expect(execution.disposition, JSON.stringify(execution)).toBe("proposed");
    if (execution.disposition !== "proposed") return;
    expect(execution.proposal.candidate.sourceVersion).toBe(4);
    expect(execution.proposal.candidate.policy.common.status).toBe("active");
    expect("proof" in execution).toBe(false);
  });

  it("blocks duplicate raw policy members", () => {
    const policy = commonPolicy();
    const raw = JSON.stringify(policy).replace('"status":', `"status":${JSON.stringify(policy.properties.status)},"status":`);
    const execution = executeLegacyDecoderEquivalence(archive(commonOnly(raw)));
    expect(execution.disposition, JSON.stringify(execution)).toBe("invalid");
    if (execution.disposition !== "invalid") return;
    expect(execution.proposal?.candidate.sourceVersion).toBeNull();
    expect(execution.proposal?.decoding.selectionBlocked).toBe(true);
    expect(execution.proposal?.decoding.automaticMigrationBlocked).toBe(true);
    expect(execution.proposal?.decoding.reasons.join(" ")).toMatch(/duplicate/);
    expect("proof" in execution).toBe(false);
  });

  it("rejects malformed paths and preserves the fixture negative pins", () => {
    const fresh = commonOnly(JSON.stringify(commonPolicy()));
    expect(() => archive({ ...fresh, policyPath: ".oms/other-policy.json" as ".oms/template-policy.json" })).toThrow(/exact historical policy path/);
    expect(() => archive({ ...fresh, markerPath: "Templates/../secret.json" })).toThrow(/malformed/);
    expect(() => archive({ ...fresh, observedOutputs: new Map([["notes/./ordinary.md", new Uint8Array()]]) })).toThrow(/malformed/);
    expect(fixture.v4FieldOnly["checksum"]).toBe("sha256:444aad48b7ab0cda2fdef43471bd7dc32e1df95e392eb84db36e6c64ff03183d");
    expect(fixture.v4FieldOnly["transactionId"]).toBe("6f1b106a8b897b022382535bc9091a2b");
  });

  it("reports descriptive material without accepting it as authority", () => {
    const input = commonOnly(JSON.stringify(commonPolicy()));
    const created = archive(input);
    const material: LegacyEquivalenceMaterial = materializeLegacyEquivalenceArchive(created);
    expect(material.policy.path).toBe(".oms/template-policy.json");
    expect(material.policy.digest).toBe(digestBytes(input.policyBytes));
    expect(material.observedOutputs.map(output => output.path)).toEqual([...material.observedOutputs.map(output => output.path)].sort());
    expect(replayLegacyDecoderEquivalence(material, created).disposition).toBe("rejected");
    expect(material.decoderExecutionVersion).toBe(LEGACY_DECODER_EXECUTION_VERSION);
    expect(material.archiveDigest.startsWith("sha256:")).toBe(true);
  });
  it("preserves valid scalar paths and distinguishes NFC from NFD material", () => {
    const fresh = commonOnly(JSON.stringify(commonPolicy()));
    const scalar = `notes/${String.fromCodePoint(0x20000)}.json`;
    const preserved = archive({ ...fresh, observedOutputs: new Map([...fresh.observedOutputs, [scalar, Uint8Array.of(1)]]) });
    expect(materializeLegacyEquivalenceArchive(preserved).observedOutputs.map(output => output.path)).toContain(scalar);
    expect(() => archive({ ...fresh, observedOutputs: new Map([...fresh.observedOutputs, [`notes/${String.fromCharCode(0xd800)}.json`, Uint8Array.of(1)]]) })).toThrow(/malformed/);
    const nfc = archive({ ...fresh, observedOutputs: new Map([...fresh.observedOutputs, ["notes/é.json", Uint8Array.of(1)]]) });
    const nfd = archive({ ...fresh, observedOutputs: new Map([...fresh.observedOutputs, ["notes/é.json".normalize("NFD"), Uint8Array.of(1)]]) });
    const nfcMaterial = materializeLegacyEquivalenceArchive(nfc);
    const nfdMaterial = materializeLegacyEquivalenceArchive(nfd);
    expect(nfcMaterial.archiveDigest).not.toBe(nfdMaterial.archiveDigest);
    expect(nfcMaterial.observedOutputs.map(output => output.path)).not.toEqual(nfdMaterial.observedOutputs.map(output => output.path));
  });
});
