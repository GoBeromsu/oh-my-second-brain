import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestBytes, hashCanonical, outputDigest } from "./canonical.js";
import { composeTemplateContract } from "./defaults.js";
import { parseTemplatePolicy, serializeDerivedProjection } from "./policy.js";
import {
  controlGenerationDigest,
  deriveFolderOntologyAxis,
  expectedProjectionManaged,
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
    expect(direct.targetFolders.get("literature")).toBe("Notes/Literature");
    expect(direct.targetFolders.has("other")).toBe(false);
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
