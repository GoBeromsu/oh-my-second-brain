import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { digestBytes, hashCanonical, outputDigest } from "./canonical.js";
import { parseTemplatePolicy, serializeDerivedProjection } from "./policy.js";
import { readTemplateReviewContext } from "./review-context.js";
import { controlGenerationDigest, expectedProjectionManaged, taxonomyRouting } from "./resolver.js";

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
const RAW_SYNTAX = "---\ntitle: {{title}}\n---\n# Fake\n<!-- oms:content -->\nRAW_SYNTAX_NOT_A_CONTRACT\n";
const roots: string[] = [];

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

async function installVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-review-"));
  roots.push(root);
  const policy = {
    version: 4,
    properties: { status: { type: "select", intent: "Publication status.", allowedValues: ["open", "closed"] } },
    default: layer(".oms/templates/default.md", "", {
      fields: { status: { property: "status", required: true } },
      headings: [{ headingId: "summary", title: "Summary", level: 2, required: true }],
    }),
    templates: {
      literature: layer(".oms/templates/literature.md", LITERATURE_MARKDOWN, {
        templateId: "literature",
        fields: { status: { property: "status", allowedValues: ["open"] } },
        headings: [{ headingId: "sources", title: "Sources", level: 2, required: true }],
        source: { path: "Sources/literature.md", identity: "literature-source", rawDigest: digestBytes(SOURCE_TEXT) },
      }),
      other: layer(".oms/templates/other.md", OTHER_MARKDOWN, { templateId: "other" }),
    },
  };
  const taxonomy = {
    templates: { literature: { templateFolder: "Notes/Literature" } },
    folders: { "Notes/Literature": { intent: "Published literature." } },
  };
  const policyText = JSON.stringify(policy);
  const taxonomyText = JSON.stringify(taxonomy);
  const policyBytes = encoder.encode(policyText);
  const taxonomyBytes = encoder.encode(taxonomyText);
  const projectionText = serializeDerivedProjection({
    version: "oms.types.v2",
    generatedFrom: controlGenerationDigest(policyBytes, taxonomyBytes),
    managed: expectedProjectionManaged(parseTemplatePolicy(policyText), taxonomyRouting(".oms/taxonomy.json", taxonomyBytes), controlGenerationDigest(policyBytes, taxonomyBytes)),
  });
  await mkdir(join(root, ".oms", "templates"), { recursive: true });
  await mkdir(join(root, "Sources"), { recursive: true });
  await writeFile(join(root, ".oms", "template-policy.json"), policyText);
  await writeFile(join(root, ".oms", "taxonomy.json"), taxonomyText);
  await writeFile(join(root, ".oms", "types.json"), projectionText);
  await writeFile(join(root, ".oms", "templates", "default.md"), "");
  await writeFile(join(root, ".oms", "templates", "literature.md"), LITERATURE_MARKDOWN);
  await writeFile(join(root, ".oms", "templates", "other.md"), OTHER_MARKDOWN);
  await writeFile(join(root, "Sources", "literature.md"), SOURCE_TEXT);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("template review context", () => {
  it("exposes approved markdown and raw identity without executing raw syntax", async () => {
    const root = await installVault();
    await writeFile(join(root, "Sources", "literature.md"), RAW_SYNTAX);
    const before = await vaultSignature(root);
    const context = await readTemplateReviewContext(root);
    expect(await vaultSignature(root)).toBe(before);
    expect(context.vault).toBe(await realpath(root));
    expect(context.approved.map(row => [row.templateId, row.approvedMarkdown, row.approvedMarkdownDigest])).toEqual([
      [null, "", digestBytes("")],
      ["literature", LITERATURE_MARKDOWN, digestBytes(LITERATURE_MARKDOWN)],
      ["other", OTHER_MARKDOWN, digestBytes(OTHER_MARKDOWN)],
    ]);
    expect(context.raw).toEqual([{
      templateId: "literature",
      path: "Sources/literature.md",
      identity: "literature-source",
      approvedRawDigest: digestBytes(SOURCE_TEXT),
      observedRawDigest: digestBytes(RAW_SYNTAX),
      drift: "SOURCE_DRIFT",
    }]);
    expect(context.raw[0]).not.toHaveProperty("body");
    expect(context.raw[0]).not.toHaveProperty("frontmatter");
    const rawEvidence = JSON.stringify(context.raw);
    expect(rawEvidence).not.toContain("RAW_SYNTAX_NOT_A_CONTRACT");
    expect(rawEvidence).not.toContain("{{title}}");
    expect(rawEvidence).not.toContain("oms:content");
    expect(context.resolved.templates["literature"]?.headings.map(heading => heading.headingId)).toEqual(["summary", "sources"]);
    expect(context.resolved.templates["other"]?.approved.templateLayer?.approvedMarkdown).toBe(OTHER_MARKDOWN);
  });

  it("keeps last approved markdown when the managed draft is missing", async () => {
    const root = await installVault();
    await rm(join(root, ".oms", "templates", "literature.md"));
    const context = await readTemplateReviewContext(root);
    expect(context.approved.find(row => row.templateId === "literature")?.approvedMarkdown).toBe(LITERATURE_MARKDOWN);
    expect(context.resolved.diagnostics.some(diagnostic => diagnostic.code === "MANAGED_TEMPLATE_DRIFT" && diagnostic.templateId === "literature")).toBe(true);
    expect(context.resolved.templates["other"]?.templateId).toBe("other");
    expect(context.raw[0]?.drift).toBeNull();
  });

  it("does not read through an in-progress publication", async () => {
    const root = await installVault();
    await writePublication(root, "in-progress");
    await expect(readTemplateReviewContext(root)).rejects.toThrow("CONTRACT_TRANSACTION_IN_PROGRESS: template transaction is in progress");
  });

  it("does not write or parse raw template syntax", async () => {
    const source = await readFile(fileURLToPath(new URL("./review-context.ts", import.meta.url)), "utf8");
    for (const forbidden of [
      "writeFile",
      "appendFile",
      "createWriteStream",
      "mkdir",
      "deriveTemplateSourcePath",
      "from \"./extract.js\"",
      "from \"./renderer.js\"",
      "from \"./census.js\"",
      "from \"./content-contract.js\"",
    ]) expect(source).not.toContain(forbidden);
  });
});
