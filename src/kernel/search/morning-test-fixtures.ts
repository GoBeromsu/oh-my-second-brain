import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { digestBytes } from "../templates/canonical.js";
import { parseTemplatePolicy, serializeDerivedProjection } from "../templates/policy.js";
import { controlGenerationDigest, expectedProjectionManaged, taxonomyRouting } from "../templates/resolver.js";

const encoder = new TextEncoder();

const DEFAULT_MARKDOWN = "";
const REFERENCE_MARKDOWN = "---\ntemplate: reference\ntitle: Untitled\ntags: []\n---\n\n## Summary\n";

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

/**
 * A real approved version 4 vault: a user-owned property pool, an always-on
 * empty default layer, and one additive template. Notes are written as an agent
 * would write them; OMS does not render them.
 */
export async function writeMorningVaultFixture(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-morning-"));
  for (const directory of [".oms/templates", ".obsidian", "references"]) {
    await mkdir(path.join(vault, directory), { recursive: true });
  }
  const policyText = JSON.stringify({
    version: 4,
    properties: {
      title: { type: "text", intent: "Note title." },
      "source-url": { type: "text", intent: "Where the reference came from.", format: "url" },
      tags: { type: "list", intent: "Retrieval tags." },
    },
    default: layer(".oms/templates/default.md", DEFAULT_MARKDOWN),
    templates: {
      reference: layer(".oms/templates/reference.md", REFERENCE_MARKDOWN, {
        templateId: "reference",
        fields: {
          title: { property: "title", required: true },
          "source-url": { property: "source-url" },
          tags: { property: "tags" },
        },
        headings: [{ headingId: "summary", title: "Summary", level: 2, required: true }],
      }),
    },
  });
  const taxonomyText = JSON.stringify({
    templates: { reference: { templateFolder: "references" } },
    folders: { references: { intent: "Processed external sources." } },
  });
  const obsidianTypes = JSON.stringify({ types: { title: "text", "source-url": "text", tags: "list" } });
  const policyBytes = encoder.encode(policyText);
  const taxonomyBytes = encoder.encode(taxonomyText);
  const generationDigest = controlGenerationDigest(policyBytes, taxonomyBytes);
  const projectionText = serializeDerivedProjection({
    version: "oms.types.v2",
    generatedFrom: generationDigest,
    managed: expectedProjectionManaged(
      parseTemplatePolicy(policyText),
      taxonomyRouting(".oms/taxonomy.json", taxonomyBytes),
      generationDigest,
    ),
  });
  await Promise.all([
    writeFile(path.join(vault, ".oms/template-policy.json"), policyText),
    writeFile(path.join(vault, ".oms/taxonomy.json"), taxonomyText),
    writeFile(path.join(vault, ".oms/types.json"), projectionText),
    writeFile(path.join(vault, ".oms/templates/default.md"), DEFAULT_MARKDOWN),
    writeFile(path.join(vault, ".oms/templates/reference.md"), REFERENCE_MARKDOWN),
    writeFile(path.join(vault, ".obsidian/types.json"), obsidianTypes),
  ]);
  const note = (title: string, source: string | undefined, tags: readonly string[], body: string): string =>
    `---\ntemplate: reference\ntitle: ${title}\n${source === undefined ? "" : `source-url: ${source}\n`}tags:\n${tags.map(tag => `  - ${tag}`).join("\n")}\n---\n\n## Summary\n\n${body}\n`;
  await writeFile(
    path.join(vault, "references/Agent Retrieval.md"),
    note("Agent Retrieval", "https://example.com/agent-retrieval", ["agent-graph"], "Agent retrieval follows [[Graph Index]] and combines semantic evidence with graph context."),
  );
  await writeFile(
    path.join(vault, "references/Graph Index.md"),
    note("Graph Index", "https://example.com/graph-index", ["agent-graph"], "Index note for graph neighborhoods."),
  );
  await writeFile(
    path.join(vault, "references/Unrelated.md"),
    note("Unrelated", undefined, ["archive"], "Agent retrieval outside the selected graph should only appear for global semantic fusion."),
  );
  return vault;
}
