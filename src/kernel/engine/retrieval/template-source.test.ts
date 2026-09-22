import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { digestBytes, hashCanonical } from "../../templates/canonical.js";
import { composeTemplateContract } from "../../templates/defaults.js";
import { parseTemplatePolicy } from "../../templates/policy.js";
import {
  composeTemplateRetrievalSource,
  controlGenerationDigest,
  taxonomyRouting,
} from "../../templates/resolver.js";
import { readSearchTemplateSource, type SearchTemplateSource } from "./template-source.js";

const encoder = new TextEncoder();
const roots: string[] = [];
const MISSING_POLICY = "template policy missing (.oms/template-policy.json)";

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function absentDigest(policy: Uint8Array | null, taxonomy: Uint8Array | null) {
  return hashCanonical("oms.search-template-source.absent.v1", {
    policy: policy === null ? null : digestBytes(policy),
    taxonomy: taxonomy === null ? null : digestBytes(taxonomy),
  });
}

function asAvailable(value: SearchTemplateSource): Extract<SearchTemplateSource, { available: true }> {
  if (value.available) return value;
  throw new Error(value.reason);
}

async function makeVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-search-template-"));
  roots.push(vault);
  return vault;
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

function policyText(): string {
  return JSON.stringify({
    version: 4,
    properties: {
      status: { type: "select", intent: "Publication status.", allowedValues: ["open", "closed"] },
    },
    default: layer(".oms/templates/default.md", "", {
      fields: { status: { property: "status", required: true } },
    }),
    templates: {
      zeta: layer(".oms/templates/zeta.md", "Zeta\n", {
        templateId: "zeta",
        source: { path: "Sources/z.md", identity: "zeta-source", rawDigest: digestBytes("z") },
      }),
      alpha: layer(".oms/templates/alpha.md", "Alpha\n", {
        templateId: "alpha",
        fields: { status: { property: "status", allowedValues: ["open"] } },
        source: { path: "Sources/a.md", identity: "alpha-source", rawDigest: digestBytes("a") },
      }),
      note: layer(".oms/templates/note.md", "", { templateId: "note" }),
    },
  });
}

function taxonomyText(): string {
  return JSON.stringify({
    templates: {
      alpha: { templateFolder: "Notes/Alpha" },
      zeta: { templateFolder: "Notes/Zeta" },
    },
    folders: { "Notes/Alpha": { intent: "Alpha notes." } },
  });
}

async function writeControl(vault: string, name: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(path.join(vault, ".oms"), { recursive: true });
  await writeFile(path.join(vault, ".oms", name), contents);
}

describe("readSearchTemplateSource", () => {
  it("reports absent and malformed policy without inventing a contract or creating .oms", async () => {
    const emptyVault = await makeVault();
    const missing = await readSearchTemplateSource(emptyVault);
    expect(missing).toEqual({
      available: false,
      digest: absentDigest(null, null),
      reason: MISSING_POLICY,
      managedSourcePaths: [],
    });
    expect("source" in missing).toBe(false);
    expect(existsSync(path.join(emptyVault, ".oms"))).toBe(false);

    const taxonomyOnly = await makeVault();
    const taxonomy = encoder.encode("{}");
    await writeControl(taxonomyOnly, "taxonomy.json", taxonomy);
    const policyMissing = await readSearchTemplateSource(taxonomyOnly);
    expect(policyMissing).toEqual({
      available: false,
      digest: absentDigest(null, taxonomy),
      reason: MISSING_POLICY,
      managedSourcePaths: [],
    });
    expect(policyMissing.digest).not.toBe(missing.digest);

    const emptyPolicyVault = await makeVault();
    const emptyPolicy = new Uint8Array();
    await writeControl(emptyPolicyVault, "template-policy.json", emptyPolicy);
    const emptyRead = await readSearchTemplateSource(emptyPolicyVault);
    expect(emptyRead).toEqual({
      available: false,
      digest: absentDigest(emptyPolicy, null),
      reason: "template policy invalid: TEMPLATE_POLICY_INVALID: JSON parse failed",
      managedSourcePaths: [],
    });
    expect(emptyRead.digest).not.toBe(missing.digest);

    const malformedVault = await makeVault();
    const malformed = encoder.encode("{");
    const taxonomyObject = encoder.encode("{}");
    await writeControl(malformedVault, "template-policy.json", malformed);
    await writeControl(malformedVault, "taxonomy.json", taxonomyObject);
    const malformedRead = await readSearchTemplateSource(malformedVault);
    expect(malformedRead).toEqual({
      available: false,
      digest: controlGenerationDigest(malformed, taxonomyObject),
      reason: "template policy invalid: TEMPLATE_POLICY_INVALID: JSON parse failed",
      managedSourcePaths: [],
    });
    expect(malformedRead.digest).not.toBe(absentDigest(malformed, taxonomyObject));

    const versionVault = await makeVault();
    const version3 = encoder.encode(JSON.stringify({ version: 3 }));
    await writeControl(versionVault, "template-policy.json", version3);
    await writeControl(versionVault, "taxonomy.json", taxonomyObject);
    const unsupported = await readSearchTemplateSource(versionVault);
    expect(unsupported.available).toBe(false);
    if (unsupported.available) return;
    expect(unsupported.reason).toContain("template policy invalid: TEMPLATE_POLICY_VERSION_UNSUPPORTED:");
    expect(unsupported.digest).toBe(controlGenerationDigest(version3, taxonomyObject));
    expect(unsupported.managedSourcePaths).toEqual([]);
    expect("source" in unsupported).toBe(false);
  });

  it("composes the default and templates with P05 placement and lists source paths", async () => {
    const vault = await makeVault();
    const policy = policyText();
    const taxonomy = taxonomyText();
    await writeControl(vault, "template-policy.json", policy);
    await writeControl(vault, "taxonomy.json", taxonomy);
    const policyBytes = encoder.encode(policy);
    const taxonomyBytes = encoder.encode(taxonomy);
    const found = asAvailable(await readSearchTemplateSource(vault));
    const digest = controlGenerationDigest(policyBytes, taxonomyBytes);
    const composed = composeTemplateRetrievalSource(
      parseTemplatePolicy(policy),
      taxonomyRouting(".oms/taxonomy.json", taxonomyBytes),
      digest,
    );
    expect(found.digest).toBe(digest);
    expect(found.source.generationDigest).toBe(found.digest);
    expect(found.source).toEqual(composed);
    expect(found.managedSourcePaths).toEqual(["Sources/a.md", "Sources/z.md"]);
    expect(found.source.defaultContract.templateId).toBeNull();
    expect(found.source.defaultContract.contractDigest).toBe(composeTemplateContract(policy, null, null).contractDigest);
    expect(found.source.defaultContract.fields["status"]).toMatchObject({ required: true, allowedValues: ["closed", "open"] });
    expect(found.source.templates["alpha"]?.contractDigest).toBe(
      composeTemplateContract(policy, "alpha", { templateFolder: "Notes/Alpha" }).contractDigest,
    );
    expect(found.source.templates["alpha"]?.contractDigest).not.toBe(composeTemplateContract(policy, "alpha", null).contractDigest);
    expect(found.source.templates["alpha"]?.fields["status"]).toMatchObject({ required: true, allowedValues: ["open"] });
    expect(found.source.templates["zeta"]?.contractDigest).toBe(
      composeTemplateContract(policy, "zeta", { templateFolder: "Notes/Zeta" }).contractDigest,
    );
    expect(found.source.templates["note"]?.contractDigest).toBe(composeTemplateContract(policy, "note", null).contractDigest);
    expect(found.source.globalAxes["folder-ontology"]).toMatchObject({ kind: "folder", members: ["Notes/Alpha"] });
    expect(existsSync(path.join(vault, "Sources"))).toBe(false);
    expect((await readdir(path.join(vault, ".oms"))).sort()).toEqual(["taxonomy.json", "template-policy.json"]);
  });

  it("treats a missing taxonomy as empty routing and keeps empty bytes distinct", async () => {
    const vault = await makeVault();
    const policy = policyText();
    await writeControl(vault, "template-policy.json", policy);
    const policyBytes = encoder.encode(policy);
    const found = asAvailable(await readSearchTemplateSource(vault));
    expect(found.digest).toBe(absentDigest(policyBytes, null));
    expect(found.digest).not.toBe(controlGenerationDigest(policyBytes, new Uint8Array()));
    expect(found.digest).not.toBe(controlGenerationDigest(policyBytes, encoder.encode("{}")));
    expect(found.source.generationDigest).toBe(found.digest);
    expect(Object.keys(found.source.globalAxes)).toEqual([]);
    expect(Object.getPrototypeOf(found.source.globalAxes)).toBeNull();
    expect(found.managedSourcePaths).toEqual(["Sources/a.md", "Sources/z.md"]);
    for (const templateId of ["alpha", "zeta", "note"] as const) {
      expect(found.source.templates[templateId]?.contractDigest).toBe(composeTemplateContract(policy, templateId, null).contractDigest);
      expect(found.source.templates[templateId]?.contractDigest).not.toBe(
        composeTemplateContract(policy, templateId, { templateFolder: "Notes/Alpha" }).contractDigest,
      );
    }

    const emptyTaxonomy = new Uint8Array();
    await writeControl(vault, "taxonomy.json", emptyTaxonomy);
    const invalidTaxonomy = await readSearchTemplateSource(vault);
    expect(invalidTaxonomy).toEqual({
      available: false,
      digest: controlGenerationDigest(policyBytes, emptyTaxonomy),
      reason: "template taxonomy invalid: TEMPLATE_SOURCE_INVALID: taxonomy (.oms/taxonomy.json) must be valid JSON",
      managedSourcePaths: [],
    });
    expect(invalidTaxonomy.digest).not.toBe(found.digest);
  });

  it("invalidates on control bytes and does not read projection or marker", async () => {
    const vault = await makeVault();
    const policy = policyText();
    const taxonomy = taxonomyText();
    await writeControl(vault, "template-policy.json", policy);
    await writeControl(vault, "taxonomy.json", taxonomy);
    const taxonomyBytes = encoder.encode(taxonomy);
    const first = asAvailable(await readSearchTemplateSource(vault));
    const typesPath = path.join(vault, ".oms", "types.json");
    const markerPath = path.join(vault, ".oms", "template-transaction.json");
    await writeFile(typesPath, "{not json");
    await writeFile(markerPath, "{\"status\":\"in-progress\"}");
    await chmod(typesPath, 0o000);
    await chmod(markerPath, 0o000);
    try {
      const ignored = asAvailable(await readSearchTemplateSource(vault));
      expect(ignored.digest).toBe(first.digest);
      expect(ignored.source.generationDigest).toBe(first.digest);
    } finally {
      await chmod(typesPath, 0o644);
      await chmod(markerPath, 0o644);
    }

    const rewritten = `${policy}\n`;
    await writeFile(path.join(vault, ".oms", "template-policy.json"), rewritten);
    const next = asAvailable(await readSearchTemplateSource(vault));
    expect(next.digest).not.toBe(first.digest);
    expect(next.digest).toBe(controlGenerationDigest(encoder.encode(rewritten), taxonomyBytes));
    expect(next.source.generationDigest).toBe(next.digest);
    expect(next.source.templates["note"]?.contractDigest).toBe(first.source.templates["note"]?.contractDigest);

    const rewrittenTaxonomy = `${taxonomy}\n`;
    await writeFile(path.join(vault, ".oms", "taxonomy.json"), rewrittenTaxonomy);
    const afterTaxonomy = asAvailable(await readSearchTemplateSource(vault));
    expect(afterTaxonomy.digest).not.toBe(next.digest);
    expect(afterTaxonomy.digest).toBe(controlGenerationDigest(encoder.encode(rewritten), encoder.encode(rewrittenTaxonomy)));
    expect(afterTaxonomy.source.generationDigest).toBe(afterTaxonomy.digest);
  });

  it("propagates EACCES from either control file", async () => {
    const vault = await makeVault();
    await writeControl(vault, "template-policy.json", policyText());
    await writeControl(vault, "taxonomy.json", taxonomyText());
    const policyPath = path.join(vault, ".oms", "template-policy.json");
    const taxonomyPath = path.join(vault, ".oms", "taxonomy.json");
    await chmod(policyPath, 0o000);
    try {
      await expect(readSearchTemplateSource(vault)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(policyPath, 0o644);
    }
    await chmod(taxonomyPath, 0o000);
    try {
      await expect(readSearchTemplateSource(vault)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(taxonomyPath, 0o644);
    }
  });

  it("does not reference a projection, marker, store, or writer", async () => {
    const source = await readFile(fileURLToPath(new URL("./template-source.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/writeFile|mkdir|types\.json|template-transaction|loadResolvedTemplates|sqlite|createHash/);
  });
});
