import { digestBytes, hashCanonical } from "../../src/kernel/templates/canonical.js";

/**
 * Synthetic consistency seals only. They are reconstructed from the documented
 * verifier and fixture-generator protocol. They are not captured vault bytes,
 * human authorization, or a claim that frozen publication.json pins prove
 * semantic migration. Those pins are never read or changed here.
 */

const encoder = new TextEncoder();
const POLICY_PATH = ".oms/template-policy.json";
const TAXONOMY_PATH = ".oms/taxonomy.json";
const PROJECTION_PATH = ".oms/types.json";
const MARKER_PATH = ".oms/template-transaction.json";
const V3_MARKER_PATH = ".oms/template-migration.json";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
function framed(domain: string, value: unknown): string { return hashCanonical(domain, value); }
function publicationId(approval: string, output: string): string {
  return digestBytes(`${approval}\0${output}`).slice("sha256:".length, "sha256:".length + 32);
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function by(keys: readonly string[]) {
  return (left: Record<string, unknown>, right: Record<string, unknown>): number => {
    for (const key of keys) {
      const difference = compare(String(left[key] ?? ""), String(right[key] ?? ""));
      if (difference !== 0) return difference;
    }
    return 0;
  };
}
function absent(): { state: "absent" } { return { state: "absent" }; }
function present(bytes: Uint8Array): { state: "present"; bytes: { bytes: string }; signature: string } {
  return { state: "present", bytes: { bytes: Buffer.from(bytes).toString("base64") }, signature: digestBytes(bytes) };
}
function expected(state: { state: "absent" } | { state: "present"; signature: string }): { state: "absent" } | { state: "present"; signature: string } {
  return state.state === "absent" ? absent() : { state: "present", signature: state.signature };
}

interface ControlBytes { readonly path: string; readonly kind: "policy" | "taxonomy" | "projection"; readonly bytes: Uint8Array }
export interface HistoricalBundle { readonly markerPath: string; readonly markerBytes: Uint8Array; readonly planPath: string; readonly planBytes: Uint8Array; readonly observed: Record<string, Uint8Array>; readonly policy: Uint8Array }

export function v4Policy(markdown = ""): Record<string, unknown> {
  return {
    version: 4,
    properties: { status: { type: "select", intent: "Workflow state.", allowedValues: ["open", "closed"] } },
    default: {
      templatePath: ".oms/templates/default.md",
      approvedMarkdown: "",
      approvedMarkdownDigest: digestBytes(""),
      fields: { status: { property: "status", required: true, allowedValues: ["open"] } },
      headings: [],
      headingOrder: "unordered",
      semanticCriteria: [],
    },
    templates: {
      note: {
        templateId: "note",
        templatePath: ".oms/templates/note.md",
        approvedMarkdown: markdown,
        approvedMarkdownDigest: digestBytes(markdown),
        fields: {},
        headings: [],
        headingOrder: "unordered",
        semanticCriteria: [],
        source: { identity: "note", path: "Templates/note.md", rawDigest: digestBytes(markdown) },
      },
    },
  };
}
export function v4Bundle(policy = v4Policy(), extra: Record<string, Uint8Array> = {}): HistoricalBundle {
  const policyBytes = encoder.encode(JSON.stringify(policy));
  const boundaries = [{ path: POLICY_PATH, templateId: null, expected: absent(), proposed: { state: "present", signature: digestBytes(policyBytes) } }];
  const outputs = [{ finalVaultRelativePath: POLICY_PATH, payloadDigest: digestBytes(policyBytes) }];
  const templates = policy.templates as Record<string, { approvedMarkdown: string; templatePath: string; templateId: string }>;
  for (const template of Object.values(templates)) {
    const managed = encoder.encode(template.approvedMarkdown);
    boundaries.push({ path: template.templatePath, templateId: template.templateId, expected: absent(), proposed: { state: "present", signature: digestBytes(managed) } });
    outputs.push({ finalVaultRelativePath: template.templatePath, payloadDigest: digestBytes(managed) });
  }
  for (const [path, bytes] of Object.entries(extra)) {
    boundaries.push({ path, templateId: null, expected: absent(), proposed: { state: "present", signature: digestBytes(bytes) } });
    outputs.push({ finalVaultRelativePath: path, payloadDigest: digestBytes(bytes) });
  }
  const approval = digestBytes("synthetic-v4-consistency-not-authorization");
  const output = hashCanonical("oms.contract-publish.output.v1", { outputs: [...outputs].sort((left, right) => compare(left.finalVaultRelativePath, right.finalVaultRelativePath)) });
  const transactionId = publicationId(approval, output);
  const material = { version: 1, transactionId, approvalDigest: approval, outputDigest: output, boundaries, outputs };
  const plan = { ...material, planDigest: hashCanonical("oms.contract-publish.plan.v1", material) };
  const marker = { status: "complete", transactionId, approvalDigest: approval, outputDigest: output, planDigest: plan.planDigest };
  const observed: Record<string, Uint8Array> = { [POLICY_PATH]: policyBytes, ...extra };
  for (const template of Object.values(templates)) observed[template.templatePath] = encoder.encode(template.approvedMarkdown);
  return {
    markerPath: MARKER_PATH,
    markerBytes: encoder.encode(`${canonical({ ...marker, checksum: hashCanonical("oms.contract-publish.marker.v1", marker) })}\n`),
    planPath: `.oms/.template-transactions/${transactionId}/plan.json`,
    planBytes: encoder.encode(`${canonical(plan)}\n`),
    observed,
    policy: policyBytes,
  };
}
function v3Policy(): Record<string, unknown> {
  return {
    version: 3,
    templateFolders: [],
    base: { fields: {} },
    contracts: { base: { fields: {}, intent: "Vacuous common contract.", views: [] } },
    templates: {},
  };
}
function inputV2(policyDigest: string, taxonomyDigest: string, projectionDigest: string): Record<string, unknown> {
  return {
    version: 2,
    templateFolders: [],
    authority: [
      { kind: "obsidian-types", logicalId: "obsidian-types", vaultRelativePath: PROJECTION_PATH, contentDigest: projectionDigest },
      { kind: "policy", logicalId: "template-policy", vaultRelativePath: POLICY_PATH, contentDigest: policyDigest },
      { kind: "taxonomy", logicalId: "taxonomy", vaultRelativePath: TAXONOMY_PATH, contentDigest: taxonomyDigest },
    ].sort(by(["kind", "logicalId", "vaultRelativePath"])),
    placement: [],
  };
}
export function v3Bundle(): HistoricalBundle {
  const policy = encoder.encode(JSON.stringify(v3Policy()));
  const taxonomy = encoder.encode("{}\n");
  const projection = encoder.encode("{}\n");
  const controls: ControlBytes[] = [
    { path: POLICY_PATH, kind: "policy", bytes: policy },
    { path: TAXONOMY_PATH, kind: "taxonomy", bytes: taxonomy },
    { path: PROJECTION_PATH, kind: "projection", bytes: projection },
  ];
  const currentInput = inputV2(digestBytes("absent-policy"), digestBytes(taxonomy), digestBytes(projection));
  const proposedInput = inputV2(digestBytes(policy), digestBytes(taxonomy), digestBytes(projection));
  const currentDigest = framed("oms.template-migration.input.v2", currentInput);
  const proposedDigest = framed("oms.template-migration.input.v2", proposedInput);
  const manifestControls = controls.map(control => ({
    path: control.path,
    action: "write",
    kind: control.kind,
    expectedCurrent: absent(),
    current: absent(),
    proposed: present(control.bytes),
  }));
  const outputs = controls.map(control => ({ finalVaultRelativePath: control.path, payloadDigest: digestBytes(control.bytes) }));
  const approvalMaterial = {
    inputDigest: proposedDigest,
    preimage: {
      currentInputDigest: currentDigest,
      controls: manifestControls.map(control => ({ path: control.path, expectedCurrent: expected(control.expectedCurrent) })).sort(by(["path"])),
      sources: [],
    },
    operations: [],
    diagnostics: [],
  };
  const approval = framed("oms.template-migration.approval.v2", approvalMaterial);
  const output = framed("oms.template-migration.output.v1", { outputs: [...outputs].sort(by(["finalVaultRelativePath", "payloadDigest"])) });
  const transactionId = publicationId(approval, output);
  const manifest = {
    version: 1,
    mode: "create",
    approvalDigest: approval,
    outputDigest: output,
    controls: manifestControls,
    sources: [],
    operations: [],
    diagnostics: [],
    outputs,
    current: { input: currentInput, inputDigest: currentDigest, bindings: [], resolvedTemplates: [] },
    proposed: { input: proposedInput, inputDigest: proposedDigest, bindings: [], resolvedTemplates: [] },
    moves: [],
  };
  const plan = {
    version: 1,
    transactionId,
    approvalDigest: approval,
    outputDigest: output,
    current: { input: currentInput, inputDigest: currentDigest },
    proposed: { input: proposedInput, inputDigest: proposedDigest },
    operations: [],
    moves: [],
    outputs,
    manifest: canonical(manifest),
    boundaries: controls.map(control => ({ path: control.path, expected: absent(), proposed: present(control.bytes) })),
  };
  const planDigest = digestBytes(canonical(plan));
  const marker = { status: "complete", transactionId, inputDigest: proposedDigest, approvalDigest: approval, outputDigest: output, planDigest };
  return {
    markerPath: V3_MARKER_PATH,
    markerBytes: encoder.encode(`${canonical({ ...marker, checksum: digestBytes(canonical(marker)) })}\n`),
    planPath: `.oms/.template-transactions/${transactionId}/template-migration/plan.json`,
    planBytes: encoder.encode(`${canonical(plan)}\n`),
    observed: Object.fromEntries(controls.map(control => [control.path, control.bytes])),
    policy,
  };
}
