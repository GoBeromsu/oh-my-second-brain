import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestBytes, hashCanonical, outputDigest } from "./canonical.js";
import { composeTemplateContract } from "./defaults.js";
import { parseTemplatePolicy, serializeDerivedProjection } from "./policy.js";
import {
  assertStableControlRead,
  controlGenerationDigest,
  deriveFolderOntologyAxis,
  expectedProjectionManaged,
  composeTemplateRetrievalSource,
  loadResolvedTemplates,
  loadResolvedTemplatesIfPresent,
  requireTaxonomyPlacement,
  taxonomyRouting,
} from "./resolver.js";

const encoder = new TextEncoder();

async function writePublication(root: string, status: "complete" | "in-progress", options?: { readonly plan?: boolean }): Promise<string> {
  const approvalDigest = digestBytes("approval");
  const published = outputDigest([]);
  const transactionId = digestBytes(`${approvalDigest}\0${published}`).slice("sha256:".length, "sha256:".length + 32);
  const plan = {
    version: 1 as const,
    transactionId,
    approvalDigest,
    outputDigest: published,
    boundaries: [],
    outputs: [],
  };
  const planDigest = hashCanonical("oms.contract-publish.plan.v1", plan);
  const material = { status, transactionId, approvalDigest, outputDigest: published, planDigest };
  const markerText = JSON.stringify({ ...material, checksum: hashCanonical("oms.contract-publish.marker.v1", material) });
  await mkdir(join(root, ".oms"), { recursive: true });
  await writeFile(join(root, ".oms", "template-transaction.json"), markerText);
  const planPath = join(root, ".oms", ".template-transactions", transactionId, "plan.json");
  if (options?.plan === false) {
    await rm(planPath, { force: true });
  } else {
    await mkdir(join(root, ".oms", ".template-transactions", transactionId), { recursive: true });
    await writeFile(planPath, JSON.stringify({ ...plan, planDigest }));
  }
  return markerText;
}
const SOURCE_TEXT = "Source body\n";
const LITERATURE_MARKDOWN = "Body\n";
const OTHER_MARKDOWN = "Other\n";
const DEFAULT_MARKDOWN = "";
const roots: string[] = [];

interface Fixture {
  readonly root: string;
  readonly policyText: string;
  readonly taxonomyText: string;
  readonly projectionText: string;
}

function layer(templatePath: string, markdown: string, extra: Record<string, unknown> = {}) {
  return {
    templatePath,
    approvedMarkdown: markdown,
    approvedMarkdownDigest: digestBytes(markdown),
    fields: {},
    headings: [],
    semanticCriteria: [],
    ...extra,
  };
}

function policyDocument() {
  return {
    version: 4,
    properties: {
      status: { type: "select", intent: "Publication status.", allowedValues: ["open", "closed"] },
      alias: { type: "text", intent: "Free note." },
    },
    default: layer(".oms/templates/default.md", DEFAULT_MARKDOWN, {
      fields: { status: { property: "status", required: true } },
      headings: [{ headingId: "summary", title: "Summary", level: 2, required: true }],
    }),
    templates: {
      literature: layer(".oms/templates/literature.md", LITERATURE_MARKDOWN, {
        templateId: "literature",
        fields: { status: { property: "status", allowedValues: ["open"] } },
        headings: [{ headingId: "sources", title: "Sources", level: 2, required: true }],
        source: {
          path: "Sources/literature.md",
          identity: "literature-source",
          rawDigest: digestBytes(SOURCE_TEXT),
        },
      }),
      other: layer(".oms/templates/other.md", OTHER_MARKDOWN, { templateId: "other" }),
    },
  };
}

function taxonomyDocument() {
  return {
    templates: { literature: { templateFolder: "Notes/Literature" } },
    folders: { "Notes/Literature": { intent: "Published literature." } },
  };
}

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

async function vaultSignature(root: string): Promise<string> {
  const rows: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const name = relative(root, full);
      if (entry.isDirectory()) {
        rows.push(`dir ${name}`);
        await walk(full);
      } else if (entry.isFile()) rows.push(`file ${name} ${digestBytes(await readFile(full))}`);
      else rows.push(`other ${name}`);
    }
  }
  await walk(root);
  return rows.join("\n");
}

async function installVault(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-resolver-"));
  roots.push(root);
  const policyText = JSON.stringify(policyDocument());
  const taxonomyText = JSON.stringify(taxonomyDocument());
  const policyBytes = encoder.encode(policyText);
  const taxonomyBytes = encoder.encode(taxonomyText);
  const projectionText = serializeDerivedProjection({
    version: "oms.types.v2",
    generatedFrom: controlGenerationDigest(policyBytes, taxonomyBytes),
    managed: expectedProjectionManaged(parseTemplatePolicy(policyText), taxonomyRouting(".oms/taxonomy.json", taxonomyBytes), controlGenerationDigest(policyBytes, taxonomyBytes)),
  });
  await mkdir(join(root, ".oms", "templates"), { recursive: true });
  await mkdir(join(root, "Sources"), { recursive: true });
  await mkdir(join(root, ".obsidian"), { recursive: true });
  await writeFile(join(root, ".oms", "template-policy.json"), policyText);
  await writeFile(join(root, ".oms", "taxonomy.json"), taxonomyText);
  await writeFile(join(root, ".oms", "types.json"), projectionText);
  await writeFile(join(root, ".oms", "templates", "default.md"), DEFAULT_MARKDOWN);
  await writeFile(join(root, ".oms", "templates", "literature.md"), LITERATURE_MARKDOWN);
  await writeFile(join(root, ".oms", "templates", "other.md"), OTHER_MARKDOWN);
  await writeFile(join(root, "Sources", "literature.md"), SOURCE_TEXT);
  await writeFile(join(root, ".obsidian", "types.json"), JSON.stringify({ types: { status: "select", alias: "input" } }));
  return { root, policyText, taxonomyText, projectionText };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("control generation", () => {
  it("hashes policy and taxonomy bytes only", () => {
    const policy = encoder.encode("policy");
    const taxonomy = encoder.encode("taxonomy");
    expect(controlGenerationDigest(policy, taxonomy)).toBe(hashCanonical("oms.template-control.generation.v4", {
      policy: digestBytes(policy),
      taxonomy: digestBytes(taxonomy),
    }));
    expect(controlGenerationDigest(policy, taxonomy)).not.toBe(controlGenerationDigest(encoder.encode("policy\n"), taxonomy));
  });
});

describe("torn control reads", () => {
  it("accepts two identical control generations", () => {
    const policy = encoder.encode("policy");
    const taxonomy = encoder.encode("taxonomy");
    expect(() => assertStableControlRead(
      { policy, taxonomy, projection: null, marker: null },
      { policy: new Uint8Array(policy), taxonomy: new Uint8Array(taxonomy), projection: null, marker: null },
    )).not.toThrow();
  });

  it("stops when a control changes between the pre and post read", () => {
    const left = encoder.encode("left");
    const right = encoder.encode("right");
    expect(() => assertStableControlRead(
      { policy: left, taxonomy: left, projection: left, marker: left },
      { policy: right, taxonomy: left, projection: right, marker: null },
    )).toThrow("CONTRACT_TRANSACTION_IN_PROGRESS: marker, policy, projection changed while reading controls");
  });
});

describe("taxonomy routing", () => {
  it("derives folder ontology from declared intents and invents no members", () => {
    expect(deriveFolderOntologyAxis(undefined)).toBeNull();
    expect(deriveFolderOntologyAxis({ "Notes/A": { templateId: "literature" }, "Notes/B": {} })).toBeNull();
    expect(deriveFolderOntologyAxis({
      "Notes/B": { intent: "Second." },
      "Notes/A": { intent: "  First.  " },
    })).toEqual({
      kind: "folder",
      key: "folder",
      type: "text",
      intent: "Semantic meanings of vault folders.",
      members: ["Notes/A", "Notes/B"],
      extensions: { intents: { "Notes/A": "First.", "Notes/B": "Second." } },
    });
  });

  it("rejects an empty intent or a non-mapping", () => {
    expect(() => deriveFolderOntologyAxis({ Notes: { intent: "   " } })).toThrow("taxonomy.folders.Notes.intent must be a non-empty string");
    expect(() => deriveFolderOntologyAxis([], "custom.folders")).toThrow("custom.folders must be a mapping");
    expect(() => deriveFolderOntologyAxis({ Notes: "Keep." })).toThrow("taxonomy.folders.Notes must be a mapping");
  });

  it("keeps declared placement and lets folder entries overlay template entries", () => {
    const direct = taxonomyRouting("taxonomy.json", bytes({
      templates: { literature: { templateFolder: "Notes/./Literature" } },
    }));
    expect(requireTaxonomyPlacement(direct, "literature")).toBe("Notes/Literature");
    expect(() => requireTaxonomyPlacement(direct, "other")).toThrow("TEMPLATE_PLACEMENT_UNDECLARED: taxonomy placement is undeclared for template other");
    expect(direct.targetFolders.has("Inbox")).toBe(false);

    const overlaid = taxonomyRouting("taxonomy.json", bytes({
      templates: { literature: { templateFolder: "Notes/FromTemplate" } },
      folders: { "Notes/FromFolder": { template: "literature", templateFolder: "Notes/Override" } },
    }));
    expect(overlaid.targetFolders.get("literature")).toBe("Notes/Override");

    const listed = taxonomyRouting("taxonomy.json", bytes({
      folders: {
        "Notes/Published": { templateId: "literature" },
        "Notes/Shared": { templates: ["other"] },
      },
    }));
    expect(listed.targetFolders.get("literature")).toBe("Notes/Published");
    expect(listed.targetFolders.get("other")).toBe("Notes/Shared");
  });

  it("preserves explicit axes, skips malformed axes, and reserves folder-ontology", () => {
    const routing = taxonomyRouting("taxonomy.json", bytes({
      globalAxes: {
        broken: { kind: "widget" },
        weight: { kind: "link", key: " weight", type: "number", intent: "  Weight. ", members: [1, "two"] },
      },
      axes: { ignored: { kind: "link", key: "ignored", type: "text", members: ["no"] } },
    }));
    expect(Object.keys(routing.globalAxes)).toEqual(["weight"]);
    expect(routing.globalAxes["weight"]).toEqual({
      kind: "link",
      key: " weight",
      type: "number",
      intent: "Weight.",
      members: [1, "two"],
    });

    const alias = taxonomyRouting("taxonomy.json", bytes({
      axes: { topic: { kind: "link", key: "topic", type: "text", members: ["a"] } },
    }));
    expect(alias.globalAxes["topic"]?.kind).toBe("link");

    expect(() => taxonomyRouting("taxonomy.json", bytes({ templates: [] }))).toThrow("taxonomy.templates must be a mapping");
    expect(() => taxonomyRouting("taxonomy.json", bytes({ templates: { literature: [] } }))).toThrow("taxonomy.templates.literature has invalid placement");
    expect(() => taxonomyRouting("taxonomy.json", bytes({
      folders: { "Notes/Shared": { templates: ["literature", 2] } },
    }))).toThrow("taxonomy (taxonomy.json) folders.Notes/Shared.templates must contain template IDs");
    expect(() => taxonomyRouting("taxonomy.json", bytes({
      folders: { Notes: { templateId: "literature", templateFolder: 1 } },
    }))).toThrow("taxonomy.folders.Notes.templateFolder must be a string");
    expect(() => taxonomyRouting("taxonomy.json", bytes([]))).toThrow("taxonomy (taxonomy.json) must be a JSON object");
    expect(() => taxonomyRouting("taxonomy.json", encoder.encode("{"))).toThrow("taxonomy (taxonomy.json) must be valid JSON");
    expect(() => taxonomyRouting("taxonomy.json", bytes({
      globalAxes: { "folder-ontology": { kind: "folder", key: "folder", type: "text", members: [] } },
      folders: { Notes: { intent: "Keep." } },
    }))).toThrow("taxonomy (taxonomy.json) globalAxes.folder-ontology is reserved");
  });
});

describe("approved snapshot reader", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await installVault();
  });

  it("returns composed contracts, placement, and exact controls without writing", async () => {
    const before = await vaultSignature(fixture.root);
    const snapshot = await loadResolvedTemplates(fixture.root);
    expect(await vaultSignature(fixture.root)).toBe(before);
    expect(snapshot.vault).toBe(await realpath(fixture.root));
    expect(snapshot.policy.version).toBe(4);
    expect(snapshot.policy.completion.retryBudget).toBe(2);
    expect(snapshot.policy.properties["status"]?.allowedValues).toEqual(["closed", "open"]);
    expect(snapshot.defaultContract.templateId).toBeNull();
    expect(snapshot.defaultContract.headingOrder).toBe("unordered");
    expect(snapshot.defaultContract.contractDigest).toBe(composeTemplateContract(fixture.policyText, null, null).contractDigest);
    const literature = snapshot.templates["literature"];
    const other = snapshot.templates["other"];
    expect(literature?.headings.map(heading => [heading.headingId, heading.origin])).toEqual([
      ["summary", "default"],
      ["sources", "template"],
    ]);
    expect(literature?.fields["status"]).toMatchObject({ type: "select", required: true, allowedValues: ["open"] });
    expect(other?.fields["status"]?.allowedValues).toEqual(["closed", "open"]);
    expect(other?.fields["alias"]).toBeUndefined();
    expect(snapshot.placement).toEqual({ literature: "Notes/Literature" });
    expect(literature?.contractDigest).toBe(composeTemplateContract(fixture.policyText, "literature", { templateFolder: "Notes/Literature" }).contractDigest);
    expect(literature?.contractDigest).not.toBe(composeTemplateContract(fixture.policyText, "literature", null).contractDigest);
    expect(other?.contractDigest).toBe(composeTemplateContract(fixture.policyText, "other", null).contractDigest);
    expect(literature?.approved.templateLayer?.approvedMarkdown).toBe(LITERATURE_MARKDOWN);
    expect(snapshot.globalAxes["folder-ontology"]).toEqual({
      kind: "folder",
      key: "folder",
      type: "text",
      intent: "Semantic meanings of vault folders.",
      members: ["Notes/Literature"],
      extensions: { intents: { "Notes/Literature": "Published literature." } },
    });
    expect(snapshot.generationDigest).toBe(controlGenerationDigest(snapshot.controls.policy.bytes, snapshot.controls.taxonomy.bytes));
    expect(snapshot.projection.generatedFrom).toBe(snapshot.generationDigest);
    expect(snapshot.projection.managed.headings.map(heading => heading.headingId)).toEqual(["summary"]);
    expect(snapshot.projection.managed.templates["literature"]?.headings.map(heading => heading.headingId)).toEqual(["summary", "sources"]);
    expect(snapshot.projection.managed.templates["literature"]?.contractDigest).toBe(literature?.contractDigest);
    expect(snapshot.projection.managed.templates["other"]?.fields["status"]?.allowedValues).toEqual(["closed", "open"]);
    expect("origin" in (snapshot.projection.managed.headings[0] ?? {})).toBe(false);
    expect(JSON.stringify(snapshot.projection)).not.toContain("Source body");
    expect(new TextDecoder().decode(snapshot.controls.policy.bytes)).toBe(fixture.policyText);
    expect(new TextDecoder().decode(snapshot.controls.taxonomy.bytes)).toBe(fixture.taxonomyText);
    expect(new TextDecoder().decode(snapshot.controls.projection.bytes)).toBe(fixture.projectionText);
    expect(snapshot.controls.marker).toBeNull();
    expect(snapshot.obsidianTypes).toEqual({ status: "select", alias: "text" });
    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.drafts.map(draft => [draft.templateId, draft.drift, draft.observedDraftDigest === draft.approvedMarkdownDigest])).toEqual([
      [null, null, true],
      ["literature", null, true],
      ["other", null, true],
    ]);
    expect(snapshot.sources).toEqual([{
      templateId: "literature",
      source: { path: "Sources/literature.md", identity: "literature-source", rawDigest: digestBytes(SOURCE_TEXT) },
      observedRawDigest: digestBytes(SOURCE_TEXT),
      drift: null,
    }]);
  });

  it("returns the shared retrieval composition, including placement", async () => {
    const snapshot = await loadResolvedTemplates(fixture.root);
    const policyBytes = encoder.encode(fixture.policyText);
    const taxonomyBytes = encoder.encode(fixture.taxonomyText);
    const routing = taxonomyRouting(".oms/taxonomy.json", taxonomyBytes);
    const generationDigest = controlGenerationDigest(policyBytes, taxonomyBytes);
    const source = composeTemplateRetrievalSource(snapshot.policy, routing, generationDigest);
    expect(source.policy).toBe(snapshot.policy);
    expect(source.generationDigest).toBe(snapshot.generationDigest);
    expect(source.defaultContract).toEqual(snapshot.defaultContract);
    expect(source.templates).toEqual(snapshot.templates);
    expect(source.globalAxes).toBe(routing.globalAxes);
    expect(source.globalAxes).toEqual(snapshot.globalAxes);
    expect(Object.getPrototypeOf(source.templates)).toBeNull();
    expect(source.defaultContract.contractDigest).toBe(composeTemplateContract(fixture.policyText, null, null).contractDigest);
    expect(source.templates["literature"]?.contractDigest).toBe(
      composeTemplateContract(fixture.policyText, "literature", { templateFolder: "Notes/Literature" }).contractDigest,
    );
    expect(source.templates["literature"]?.contractDigest).not.toBe(
      composeTemplateContract(fixture.policyText, "literature", null).contractDigest,
    );
    expect(source.templates["other"]?.contractDigest).toBe(composeTemplateContract(fixture.policyText, "other", null).contractDigest);
  });

  it("reports raw drift without replacing approved markdown or another contract", async () => {
    const drifted = "CHANGED {{title}}\n<!-- oms:content -->\n";
    await writeFile(join(fixture.root, "Sources", "literature.md"), drifted);
    const before = await vaultSignature(fixture.root);
    const snapshot = await loadResolvedTemplates(fixture.root);
    expect(await vaultSignature(fixture.root)).toBe(before);
    expect(snapshot.diagnostics).toEqual([{
      code: "SOURCE_DRIFT",
      templateId: "literature",
      path: "Sources/literature.md",
      message: "raw source Sources/literature.md does not match the approved raw digest",
    }]);
    expect(snapshot.sources[0]).toMatchObject({ observedRawDigest: digestBytes(drifted), drift: "SOURCE_DRIFT" });
    expect(snapshot.templates["literature"]?.approved.templateLayer?.approvedMarkdown).toBe(LITERATURE_MARKDOWN);
    expect(snapshot.templates["literature"]?.contractDigest).toBe(composeTemplateContract(fixture.policyText, "literature", { templateFolder: "Notes/Literature" }).contractDigest);
    expect(snapshot.templates["other"]?.approved.templateLayer?.approvedMarkdown).toBe(OTHER_MARKDOWN);
    expect(JSON.stringify(snapshot.policy)).not.toContain("{{title}}");
    expect(snapshot.generationDigest).toBe(controlGenerationDigest(encoder.encode(fixture.policyText), encoder.encode(fixture.taxonomyText)));
  });

  it("reports a missing raw source and still returns the other contract", async () => {
    await rm(join(fixture.root, "Sources", "literature.md"));
    const snapshot = await loadResolvedTemplates(fixture.root);
    expect(snapshot.diagnostics).toEqual([{
      code: "SOURCE_DRIFT",
      templateId: "literature",
      path: "Sources/literature.md",
      message: "raw source Sources/literature.md is missing",
    }]);
    expect(snapshot.sources[0]?.observedRawDigest).toBeNull();
    expect(snapshot.templates["other"]?.contractDigest).toBe(composeTemplateContract(fixture.policyText, "other", null).contractDigest);
    expect(snapshot.drafts.every(draft => draft.drift === null)).toBe(true);
  });

  it("reports managed-draft drift and keeps the approved markdown", async () => {
    await writeFile(join(fixture.root, ".oms", "templates", "literature.md"), "STALE\n");
    const snapshot = await loadResolvedTemplates(fixture.root);
    expect(snapshot.diagnostics).toEqual([{
      code: "MANAGED_TEMPLATE_DRIFT",
      templateId: "literature",
      path: ".oms/templates/literature.md",
      message: "managed draft .oms/templates/literature.md does not match the approved markdown digest",
    }]);
    expect(snapshot.templates["literature"]?.approved.templateLayer?.approvedMarkdown).toBe(LITERATURE_MARKDOWN);
    expect(snapshot.drafts.find(draft => draft.templateId === "other")?.drift).toBeNull();
    expect(snapshot.sources[0]?.drift).toBeNull();
  });

  it("reports missing managed drafts without blocking an unrelated contract", async () => {
    await rm(join(fixture.root, ".oms", "templates", "default.md"));
    await rm(join(fixture.root, ".oms", "templates", "literature.md"));
    const snapshot = await loadResolvedTemplates(fixture.root);
    expect(snapshot.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.templateId ?? null, diagnostic.message])).toEqual([
      ["MANAGED_TEMPLATE_DRIFT", null, "managed draft .oms/templates/default.md is missing"],
      ["MANAGED_TEMPLATE_DRIFT", "literature", "managed draft .oms/templates/literature.md is missing"],
    ]);
    expect(snapshot.defaultContract.approved.defaultLayer.approvedMarkdown).toBe(DEFAULT_MARKDOWN);
    expect(snapshot.templates["literature"]?.approved.templateLayer?.approvedMarkdown).toBe(LITERATURE_MARKDOWN);
    expect(snapshot.templates["other"]?.approved.templateLayer?.approvedMarkdown).toBe(OTHER_MARKDOWN);
    expect(snapshot.drafts.find(draft => draft.templateId === "other")?.drift).toBeNull();
  });

  it("rejects a projection whose header matches but whose managed payload does not", async () => {
    const projection = JSON.parse(await readFile(join(fixture.root, ".oms", "types.json"), "utf8")) as {
      generatedFrom: string;
      managed: { templates: { literature: { contractDigest: string } } };
    };
    const generatedFrom = projection.generatedFrom;
    projection.managed.templates.literature.contractDigest = digestBytes("tampered");
    await writeFile(join(fixture.root, ".oms", "types.json"), JSON.stringify(projection));
    await expect(loadResolvedTemplates(fixture.root)).rejects.toThrow("PROJECTION_PAYLOAD_TAMPERED: managed payload does not match the derived projection");
    const reread = JSON.parse(await readFile(join(fixture.root, ".oms", "types.json"), "utf8")) as { generatedFrom: string };
    expect(reread.generatedFrom).toBe(generatedFrom);
  });

  it("keeps an Obsidian type conflict beside the approved contracts", async () => {
    await writeFile(join(fixture.root, ".obsidian", "types.json"), JSON.stringify({ types: { status: "text", alias: "input" } }));
    const snapshot = await loadResolvedTemplates(fixture.root);
    expect(snapshot.diagnostics).toEqual([{
      code: "OBSIDIAN_TYPE_CONFLICT",
      field: "status",
      path: ".obsidian/types.json",
      message: "property status is select in the policy pool and text in Obsidian types",
    }]);
    expect(snapshot.templates["literature"]?.fields["status"]?.type).toBe("select");
    expect(snapshot.obsidianTypes?.["alias"]).toBe("text");
    expect(snapshot.generationDigest).toBe(controlGenerationDigest(encoder.encode(fixture.policyText), encoder.encode(fixture.taxonomyText)));
  });

  it("does not fail the read when Obsidian types are absent, invalid, or not a file", async () => {
    await rm(join(fixture.root, ".obsidian", "types.json"));
    const absent = await loadResolvedTemplates(fixture.root);
    expect(absent.obsidianTypes).toBeNull();
    expect(absent.controls.obsidianTypes).toBeNull();
    expect(absent.diagnostics).toEqual([]);
    expect(absent.templates["literature"]?.templateId).toBe("literature");

    await writeFile(join(fixture.root, ".obsidian", "types.json"), "{");
    const invalid = await loadResolvedTemplates(fixture.root);
    expect(invalid.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["OBSIDIAN_TYPE_CONFLICT"]);
    expect(invalid.diagnostics[0]?.message).toContain("Obsidian types could not be read");
    expect(invalid.obsidianTypes).toBeNull();
    expect(invalid.templates["other"]?.approved.templateLayer?.approvedMarkdown).toBe(OTHER_MARKDOWN);

    await rm(join(fixture.root, ".obsidian", "types.json"));
    await mkdir(join(fixture.root, ".obsidian", "types.json"));
    const directory = await loadResolvedTemplates(fixture.root);
    expect(directory.diagnostics).toEqual([{
      code: "OBSIDIAN_TYPE_CONFLICT",
      path: ".obsidian/types.json",
      message: "Obsidian types could not be read: .obsidian/types.json is not a regular file",
    }]);
    expect(directory.defaultContract.templateId).toBeNull();
  });

  it("admits a durable complete marker without rechecking drafts and rejects an open marker", async () => {
    const markerText = await writePublication(fixture.root, "complete");
    const snapshot = await loadResolvedTemplates(fixture.root);
    expect(snapshot.diagnostics).toEqual([]);
    expect(new TextDecoder().decode(snapshot.controls.marker?.bytes ?? new Uint8Array())).toBe(markerText);

    await writeFile(join(fixture.root, ".oms", "templates", "literature.md"), "STALE\n");
    const drifted = await loadResolvedTemplates(fixture.root);
    expect(drifted.diagnostics).toEqual([{
      code: "MANAGED_TEMPLATE_DRIFT",
      templateId: "literature",
      path: ".oms/templates/literature.md",
      message: "managed draft .oms/templates/literature.md does not match the approved markdown digest",
    }]);
    expect(drifted.templates["literature"]?.approved.templateLayer?.approvedMarkdown).toBe(LITERATURE_MARKDOWN);

    await writePublication(fixture.root, "in-progress");
    await expect(loadResolvedTemplates(fixture.root)).rejects.toThrow("CONTRACT_TRANSACTION_IN_PROGRESS: template transaction is in progress");

    await writePublication(fixture.root, "complete", { plan: false });
    await expect(loadResolvedTemplates(fixture.root)).rejects.toThrow("CONTRACT_TRANSACTION_IN_PROGRESS: transaction marker is invalid");

    await writeFile(join(fixture.root, ".oms", "template-transaction.json"), JSON.stringify({
      status: "complete",
      transactionId: "tx-1",
      approvalDigest: digestBytes("approval"),
      outputDigest: digestBytes("output"),
    }));
    await expect(loadResolvedTemplates(fixture.root)).rejects.toThrow("CONTRACT_TRANSACTION_IN_PROGRESS: transaction marker is invalid");
  });

  it("fails closed for absent, invalid, unsupported, or mismatched controls", async () => {
    const failures: Array<[(root: string) => Promise<void>, string]> = [
      [async root => { await rm(join(root, ".oms", "template-policy.json")); }, "CONTRACT_UNVERIFIABLE: approved policy is absent"],
      [async root => { await writeFile(join(root, ".oms", "template-policy.json"), "{"); }, "CONTRACT_UNVERIFIABLE: approved policy is not valid JSON"],
      [async root => { await writeFile(join(root, ".oms", "template-policy.json"), Buffer.from([0xff, 0xfe])); }, "CONTRACT_UNVERIFIABLE: approved policy is not UTF-8"],
      [async root => {
        const policy = JSON.parse(await readFile(join(root, ".oms", "template-policy.json"), "utf8")) as { default: { approvedMarkdownDigest: string } };
        policy.default.approvedMarkdownDigest = digestBytes("not-the-markdown");
        await writeFile(join(root, ".oms", "template-policy.json"), JSON.stringify(policy));
      }, "CONTRACT_UNVERIFIABLE: policy.default.approvedMarkdownDigest does not match the exact approved markdown bytes"],
      [async root => { await writeFile(join(root, ".oms", "template-policy.json"), JSON.stringify({ version: 3 })); }, "TEMPLATE_POLICY_VERSION_UNSUPPORTED:"],
      [async root => { await rm(join(root, ".oms", "taxonomy.json")); }, "TEMPLATE_SOURCE_INVALID: .oms/taxonomy.json is absent"],
      [async root => { await writeFile(join(root, ".oms", "taxonomy.json"), "{"); }, "TEMPLATE_SOURCE_INVALID: taxonomy (.oms/taxonomy.json) must be valid JSON"],
      [async root => { await rm(join(root, ".oms", "types.json")); }, "PROJECTION_INVALID: .oms/types.json is absent"],
      [async root => { await writeFile(join(root, ".oms", "types.json"), Buffer.from([0xff])); }, "PROJECTION_INVALID: .oms/types.json is not UTF-8"],
      [async root => { await writeFile(join(root, ".oms", "types.json"), JSON.stringify({ version: "oms.types.v1" })); }, "oms.types.v1 is not migrated"],
      [async root => { await writeFile(join(root, ".oms", "template-policy.json"), `${fixture.policyText}\n`); }, "CONTRACT_TRANSACTION_IN_PROGRESS: projection generatedFrom does not match policy and taxonomy bytes"],
      [async root => { await writeFile(join(root, ".oms", "template-transaction.json"), "[]"); }, "CONTRACT_TRANSACTION_IN_PROGRESS: transaction marker is invalid"],
      [async root => { await writeFile(join(root, ".oms", "template-transaction.json"), Buffer.from([0xff])); }, "CONTRACT_TRANSACTION_IN_PROGRESS: transaction marker is invalid"],
      [async root => {
        await writeFile(join(root, ".oms", "template-transaction.json"), JSON.stringify({
          status: "complete",
          transactionId: "tx-1",
          approvalDigest: digestBytes("approval"),
          outputDigest: "sha256:not-a-digest",
        }));
      }, "CONTRACT_TRANSACTION_IN_PROGRESS: transaction marker is invalid"],
    ];
    for (const [mutate, message] of failures) {
      const { root } = await installVault();
      await mutate(root);
      await expect(loadResolvedTemplates(root)).rejects.toThrow(message);
    }
  });

  it("returns null only when policy, taxonomy, projection, and marker are all absent", async () => {
    const empty = await mkdtemp(join(tmpdir(), "oms-template-resolver-empty-"));
    roots.push(empty);
    expect(await loadResolvedTemplatesIfPresent(empty)).toBeNull();
    await mkdir(join(empty, ".obsidian"), { recursive: true });
    await writeFile(join(empty, ".obsidian", "types.json"), JSON.stringify({ types: { status: "select" } }));
    expect(await loadResolvedTemplatesIfPresent(empty)).toBeNull();

    const marked = await mkdtemp(join(tmpdir(), "oms-template-resolver-marker-"));
    roots.push(marked);
    await writePublication(marked, "in-progress");
    await expect(loadResolvedTemplatesIfPresent(marked)).rejects.toThrow("CONTRACT_TRANSACTION_IN_PROGRESS: template transaction is in progress");

    const policyOnly = await mkdtemp(join(tmpdir(), "oms-template-resolver-policy-"));
    roots.push(policyOnly);
    await mkdir(join(policyOnly, ".oms"), { recursive: true });
    await writeFile(join(policyOnly, ".oms", "template-policy.json"), fixture.policyText);
    await expect(loadResolvedTemplatesIfPresent(policyOnly)).rejects.toThrow("TEMPLATE_SOURCE_INVALID: .oms/taxonomy.json is absent");
    expect((await loadResolvedTemplatesIfPresent(fixture.root))?.templates["other"]?.templateId).toBe("other");
  });
});

describe("resolver module", () => {
  it("does not write, render, or keep retired v3 gates", async () => {
    const source = await readFile(fileURLToPath(new URL("./resolver.ts", import.meta.url)), "utf8");
    for (const forbidden of [
      "writeFile",
      "appendFile",
      "createWriteStream",
      "mkdir",
      "deriveTemplateSourcePath",
      "sourceSignature",
      "sharedAuthoritySignature",
      "buildTemplateCompositionManifest",
      "approvalDigest",
      "from \"./extract.js\"",
      "from \"./renderer.js\"",
      "from \"./census.js\"",
      "from \"./interview.js\"",
      "from \"./content-contract.js\"",
      "templateTransactionMarkerState",
      "oms.contract-publish.marker.v1",
    ]) expect(source).not.toContain(forbidden);
  });
});
