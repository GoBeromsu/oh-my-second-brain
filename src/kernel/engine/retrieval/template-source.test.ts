import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestBytes } from "../../templates/canonical.js";
import { serializeContractPolicyV5, type ContractPolicyV5 } from "../../templates/contract-v5.js";
import { readSearchTemplateSource } from "./template-source.js";

const roots: string[] = [];
const encoder = new TextEncoder();

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function makeVault(controls: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-search-source-"));
  roots.push(root);
  for (const [name, content] of Object.entries(controls)) {
    await mkdir(path.join(root, ".oms"), { recursive: true });
    await writeFile(path.join(root, ".oms", name), content);
  }
  return root;
}

function policy(): ContractPolicyV5 {
  return {
    version: 5,
    revision: 3,
    properties: {
      title: { type: "text" },
      status: { type: "select", valuePolicy: "closed", allowedValues: ["open", "done"] },
      tags: { type: "tags", valuePolicy: "suggest", allowedValues: ["flower"], maxItems: 3 },
    },
    common: { status: "active", fields: { title: { required: true }, status: { required: true } } },
    templates: {
      zeta: {
        status: "active",
        source: { identity: "source-zeta", path: "Sources/z.md", rawDigest: digestBytes("zeta") },
        fields: { tags: { maxItems: 5 } },
      },
      alpha: {
        status: "active",
        source: { identity: "source-alpha", path: "Sources/a.md", rawDigest: digestBytes("alpha") },
        fields: { status: { required: false } },
      },
      held: { status: "review-required", reasons: ["legacy semantic rule"], legacy: { note: "kept" } },
    },
  };
}

const TAXONOMY = JSON.stringify({
  templates: { alpha: { templateFolder: "Notes" } },
  folders: { Notes: { intent: "Notes." } },
});

describe("readSearchTemplateSource", () => {
  it("composes effective V5 fields per registration and keeps a held contract identity", async () => {
    const vault = await makeVault({ "template-policy.json": serializeContractPolicyV5(policy()), "taxonomy.json": TAXONOMY });
    const read = await readSearchTemplateSource(vault);
    expect(read.source.generationDigest).toBe(read.digest);
    expect(read.source.defaultFields).toMatchObject({
      title: { property: "title", type: "text", required: true },
      status: { property: "status", type: "select", required: true, valuePolicy: "closed", allowedValues: ["open", "done"] },
    });
    expect(Object.keys(read.source.templates ?? {}).sort()).toEqual(["alpha", "held", "zeta"]);
    // An individual may relax the common rule; the pool definition still applies.
    expect(read.source.templates?.["alpha"]).toMatchObject({ status: { required: false, valuePolicy: "closed" } });
    expect(read.source.templates?.["zeta"]).toMatchObject({ tags: { type: "tags", valuePolicy: "suggest", maxItems: 5 } });
    // A review-required registration keeps its identity with unavailable rules.
    expect(read.source.templates?.["held"]).toBeNull();
    expect(read.diagnostics.map(item => item.code)).toContain("CONTRACT_REVIEW_REQUIRED");
    expect(read.source.sourcePaths).toEqual(["Sources/a.md", "Sources/z.md"]);
    // No approved Markdown, policy document, or projection travels with retrieval.
    expect(Object.keys(read.source).sort()).toEqual(["defaultFields", "generationDigest", "globalAxes", "sourcePaths", "templates"]);
  });

  it("reports an absent or unreadable contract without inventing one or creating .oms", async () => {
    const empty = await makeVault();
    const absent = await readSearchTemplateSource(empty);
    expect(absent.source).toMatchObject({ defaultFields: null, templates: null, sourcePaths: null });
    expect(absent.diagnostics.map(item => item.code)).toEqual(["TEMPLATE_POLICY_ABSENT"]);
    expect(existsSync(path.join(empty, ".oms"))).toBe(false);

    const malformed = await makeVault({ "template-policy.json": "{broken" });
    const invalid = await readSearchTemplateSource(malformed);
    expect(invalid.source.templates).toBeNull();
    // The exclusion inventory reports the same unreadable control independently.
    expect(invalid.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(["SOURCE_CONTROL_INVALID", "CONTRACT_POLICY_INVALID"]));
    expect(invalid.digest).not.toBe(absent.digest);

    const historical = await makeVault({ "template-policy.json": JSON.stringify({ version: 4, templates: {} }) });
    const legacy = await readSearchTemplateSource(historical);
    expect(legacy.source.templates).toBeNull();
    expect(legacy.diagnostics.map(item => item.code)).toContain("CONTRACT_VERSION_UNSUPPORTED");
  });

  it("keeps policy and taxonomy independent", async () => {
    const brokenTaxonomy = await makeVault({ "template-policy.json": serializeContractPolicyV5(policy()), "taxonomy.json": "{" });
    const withPolicy = await readSearchTemplateSource(brokenTaxonomy);
    expect(withPolicy.source.globalAxes).toBeNull();
    expect(withPolicy.source.defaultFields).not.toBeNull();
    expect(withPolicy.diagnostics.map(item => item.code)).toContain("TEMPLATE_TAXONOMY_UNREADABLE");

    const brokenPolicy = await makeVault({ "template-policy.json": "null", "taxonomy.json": TAXONOMY });
    const withTaxonomy = await readSearchTemplateSource(brokenPolicy);
    expect(withTaxonomy.source.defaultFields).toBeNull();
    expect(withTaxonomy.diagnostics.map(item => item.code)).toContain("CONTRACT_POLICY_INVALID");
    expect(withTaxonomy.source.globalAxes).not.toBeNull();
  });

  it("carries the source exclusion inventory and changes digest with any channel", async () => {
    const vault = await makeVault({ "template-policy.json": serializeContractPolicyV5(policy()), "taxonomy.json": TAXONOMY });
    const first = await readSearchTemplateSource(vault);
    expect(first.exclusions.paths).toEqual(["Sources/a.md", "Sources/z.md"]);

    await writeFile(path.join(vault, ".oms", "taxonomy.json"), JSON.stringify({ ...JSON.parse(TAXONOMY), exclude: ["drafts/**"] }));
    const withExclusion = await readSearchTemplateSource(vault);
    expect(withExclusion.exclusions.globs).toContain("drafts/**");
    expect(withExclusion.digest).not.toBe(first.digest);

    await writeFile(path.join(vault, ".oms", "settings.json"), `${JSON.stringify({ version: 1, vaultId: "11111111-1111-4111-8111-111111111111", templateRoots: ["Templates"] }, null, 2)}\n`);
    const withRoots = await readSearchTemplateSource(vault);
    expect(withRoots.exclusions.roots).toEqual(["Templates"]);
    expect(withRoots.digest).not.toBe(withExclusion.digest);
    expect(encoder.encode(withRoots.digest).byteLength).toBeGreaterThan(0);
  });
});
