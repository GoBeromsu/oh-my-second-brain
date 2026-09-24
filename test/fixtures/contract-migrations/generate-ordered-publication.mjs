import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Synthetic protocol evidence, not a captured publication or human authorization.
// Independent of legacy-publication-evidence.ts. Historical authority:
// 46e8703e4c9f446a1d6eebaa7cd585b6adf0516f, transaction.ts:23-30,57-58,186-193;
// canonical.ts:233-246 sorts approval source preimages independently of manifest order.
const fixturePath = new URL("./publication.json", import.meta.url);
const originalText = readFileSync(fixturePath, "utf8");
const fixture = JSON.parse(originalText);
const original = fixture.v3;
const digest = value => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
const plan = JSON.parse(original.planText);
const marker = JSON.parse(original.markerText);
const { checksum: priorChecksum, ...priorBare } = marker;
if (digest(canonical(plan)) !== original.planDigest || digest(canonical(priorBare)) !== priorChecksum) {
  throw new Error("Original independent fixture pins changed; refusing generation");
}
const manifest = JSON.parse(plan.manifest);
const originalOrder = manifest.sources.map(source => `${source.templateId}\0${source.path}`);
manifest.sources.sort((left, right) => {
  const a = `${left.templateId}\0${left.path}`;
  const b = `${right.templateId}\0${right.path}`;
  return a < b ? -1 : a > b ? 1 : 0;
});
if (originalOrder.every((key, index) => key === `${manifest.sources[index].templateId}\0${manifest.sources[index].path}`)) {
  throw new Error("Original v3 section must remain the invalid-order negative fixture");
}
plan.manifest = canonical(manifest);
const planDigest = digest(canonical(plan));
const bare = { ...priorBare, planDigest };
const checksum = digest(canonical(bare));
const ordered = {
  ...original,
  markerText: `${canonical({ ...bare, checksum })}\n`,
  planText: `${canonical(plan)}\n`,
  planDigest,
  checksum,
  derivation: {
    classification: "synthetic-protocol-fixture",
    capturedVaultBytes: false,
    producerAttribution: "unavailable",
    source: "v3 section retained unchanged as invalid-order negative evidence",
    generator: "generate-ordered-publication.mjs",
    changed: ["manifest.sources order", "planDigest", "marker checksum"],
    unchanged: ["policy bytes", "observed nine outputs", "inputDigest", "approvalDigest", "outputDigest", "transactionId"],
  },
};
if (fixture.v3Ordered !== undefined) {
  if (canonical(fixture.v3Ordered) !== canonical(ordered)) throw new Error("Existing ordered pins differ; refusing replacement");
} else {
  if (!originalText.endsWith("\n}\n")) throw new Error("Unexpected fixture envelope; refusing reformatting");
  const section = JSON.stringify(ordered, null, 2).split("\n").map((line, index) => index === 0 ? line : `  ${line}`).join("\n");
  writeFileSync(fixturePath, `${originalText.slice(0, -3)},\n  "v3Ordered": ${section}\n}\n`);
}
console.log(JSON.stringify({ planDigest, checksum, transactionId: ordered.transactionId }));

// The original synthetic InputV2/approval pins also omitted historical sorting.
// Preserve both earlier sections as negative evidence; never change their pins.
// This generator deliberately accepts only already-canonical printable ASCII
// fixture data, where local quoting equals historical canonicalJson quoting.
function assertFrameValue(value) {
  if (typeof value === "string" && !/^[\x20-\x7e]*$/.test(value)) throw new Error("Non-ASCII fixture needs the full historical scalar encoder");
  if (typeof value === "number" && (!Number.isSafeInteger(value) || Object.is(value, -0))) throw new Error("Invalid historical frame number");
  if (Array.isArray(value)) value.forEach(assertFrameValue);
  else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) { assertFrameValue(key); assertFrameValue(child); }
  }
}
function framed(domain, value) {
  assertFrameValue(value);
  const json = canonical(value);
  return digest(`oms-hash-frame-v1\0${Buffer.byteLength(domain)}\0${domain}${Buffer.byteLength(json)}\0${json}`);
}
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const by = (...keys) => (left, right) => {
  for (const key of keys) { const difference = compare(left[key] ?? "", right[key] ?? ""); if (difference) return difference; }
  return 0;
};
function inputHash(input) {
  const templateFolders = input.templateFolders.map(folder => ({
    path: folder.path,
    ...(folder.default === true ? { default: true } : {}),
    ...(folder.extensions === undefined ? {} : { extensions: folder.extensions }),
  })).sort(by("path"));
  const authority = input.authority.map(entry => ({ ...entry, vaultRelativePath: entry.vaultRelativePath ?? null })).sort(by("kind", "logicalId", "vaultRelativePath"));
  const placement = [...input.placement].sort(by("templateId"));
  return framed("oms.template-migration.input.v2", { version: 2, templateFolders, authority, placement });
}
const correctManifest = structuredClone(manifest);
correctManifest.current.inputDigest = inputHash(correctManifest.current.input);
correctManifest.proposed.inputDigest = inputHash(correctManifest.proposed.input);
const expectedState = state => state.state === "absent" ? { state: "absent" } : { state: "present", signature: state.signature };
const approvalMaterial = {
  inputDigest: correctManifest.proposed.inputDigest,
  preimage: {
    currentInputDigest: correctManifest.current.inputDigest,
    controls: correctManifest.controls.map(control => ({ path: control.path, expectedCurrent: expectedState(control.expectedCurrent) })).sort(by("path")),
    sources: correctManifest.sources.map(source => ({ templateId: source.templateId, path: source.path, expectedCurrent: expectedState(source.expectedCurrent) })).sort(by("templateId", "path")),
  },
  operations: correctManifest.operations.map(operation => ({ ...operation, stableRelativeSuffix: operation.stableRelativeSuffix ?? null }))
    .sort(by("kind", "templateId", "destinationClass", "stableRelativeSuffix", "payloadDigest")),
  diagnostics: correctManifest.diagnostics.map(item => ({
    code: item.code, templateId: item.templateId ?? null, path: item.path ?? null,
    field: item.field ?? null, message: item.message ?? null, extensions: item.extensions ?? null,
  })).sort((left, right) => by("code", "templateId", "path", "field", "message")(left, right) || compare(canonical(left), canonical(right))),
};
correctManifest.approvalDigest = framed("oms.template-migration.approval.v2", approvalMaterial);
correctManifest.outputDigest = framed("oms.template-migration.output.v1", { outputs: [...correctManifest.outputs].sort(by("finalVaultRelativePath", "payloadDigest")) });
const correctId = createHash("sha256").update(`${correctManifest.approvalDigest}\0${correctManifest.outputDigest}`).digest("hex").slice(0, 32);
const correctPlan = { ...plan, transactionId: correctId, approvalDigest: correctManifest.approvalDigest, outputDigest: correctManifest.outputDigest, manifest: canonical(correctManifest) };
const correctPlanDigest = digest(canonical(correctPlan));
const correctBare = { ...priorBare, transactionId: correctId, inputDigest: correctManifest.proposed.inputDigest, approvalDigest: correctManifest.approvalDigest, outputDigest: correctManifest.outputDigest, planDigest: correctPlanDigest };
const correctChecksum = digest(canonical(correctBare));
const correct = {
  ...original,
  markerText: `${canonical({ ...correctBare, checksum: correctChecksum })}\n`,
  planText: `${canonical(correctPlan)}\n`,
  planPath: original.planPath.replace(original.transactionId, correctId),
  transactionId: correctId,
  inputDigest: correctBare.inputDigest,
  approvalDigest: correctBare.approvalDigest,
  outputDigest: correctBare.outputDigest,
  planDigest: correctPlanDigest,
  checksum: correctChecksum,
  derivation: {
    classification: "synthetic-protocol-fixture", capturedVaultBytes: false, producerAttribution: "unavailable",
    generator: "generate-ordered-publication.mjs",
    source: "Historical sorted InputV2 and approval formulas; original v3 and v3Ordered remain negative evidence",
    unchanged: ["policy bytes", "observed nine outputs"],
    sourceWitness: "Unavailable: the synthetic policy has no named source bindings",
  },
};
const currentText = readFileSync(fixturePath, "utf8");
const currentFixture = JSON.parse(currentText);
if (currentFixture.v3Canonical !== undefined) {
  if (canonical(currentFixture.v3Canonical) !== canonical(correct)) throw new Error("Existing canonical pins differ; refusing replacement");
} else {
  if (!currentText.endsWith("\n}\n")) throw new Error("Unexpected fixture envelope");
  const section = JSON.stringify(correct, null, 2).split("\n").map((line, index) => index === 0 ? line : `  ${line}`).join("\n");
  writeFileSync(fixturePath, `${currentText.slice(0, -3)},\n  "v3Canonical": ${section}\n}\n`);
}
console.log(JSON.stringify({ variant: "v3Canonical", transactionId: correctId, inputDigest: correctBare.inputDigest, approvalDigest: correctBare.approvalDigest, outputDigest: correctBare.outputDigest, planDigest: correctPlanDigest, checksum: correctChecksum }));
