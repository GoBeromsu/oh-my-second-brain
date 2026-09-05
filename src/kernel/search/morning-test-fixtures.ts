import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sourceSignature } from "../templates/index.js";
import type { SourceDescriptor } from "../templates/types.js";

const digest = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export async function writeMorningVaultFixture(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-morning-"));
  for (const directory of [".oms", ".obsidian", "Templates/OMS", "references"]) await mkdir(path.join(vault, directory), { recursive: true });
  const policy = JSON.stringify({ version: 3, templateFolders: [{ path: "Templates/OMS", mode: "manual", default: true }], base: { fields: {} }, contracts: { reference: { intent: "reference", fields: { template: { type: "text", required: true }, title: { type: "text", required: true }, "source-url": { type: "text" }, tags: { type: "list" } }, views: [] } }, templates: { reference: { templateId: "reference", destinationClass: "managed-default", sourceFolder: "Templates/OMS", sourcePath: "Templates/OMS/reference.md", contract: "reference", naming: "{{slug}}.md" } } });
  const taxonomy = JSON.stringify({ folders: {}, templates: { reference: { templateFolder: "Inbox" } } });
  const obsidianTypes = JSON.stringify({ types: { template: "text", title: "text", "source-url": "text", tags: "list" } });
  const template = "---\ntemplate: reference\ntitle: Untitled\nsource-url:\ntags: []\n---\n<!-- oms:content -->\n";
  const sources: SourceDescriptor[] = [{ logicalId: "template-policy", signature: digest(policy) }, { logicalId: "taxonomy", signature: digest(taxonomy) }, { logicalId: "obsidian-types", signature: digest(obsidianTypes) }, { path: "Templates/OMS/reference.md", signature: digest(template) }];
  const projection = JSON.stringify({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sources }, managed: { base: { fields: {} }, globalAxes: {}, templates: { reference: { templateId: "reference", destinationClass: "managed-default", sourcePath: "Templates/OMS/reference.md", targetFolder: "Inbox", keyOrder: ["template", "title", "source-url", "tags"], fields: { template: { type: "text", required: true }, title: { type: "text", required: true }, "source-url": { type: "text" }, tags: { type: "list" } }, views: [], naming: "{{slug}}.md", bodySignature: digest("<!-- oms:content -->\n") } } } });
  await Promise.all([
    writeFile(path.join(vault, ".oms/template-policy.json"), policy),
    writeFile(path.join(vault, ".oms/taxonomy.json"), taxonomy),
    writeFile(path.join(vault, ".oms/types.json"), projection),
    writeFile(path.join(vault, ".obsidian/types.json"), obsidianTypes),
    writeFile(path.join(vault, "Templates/OMS/reference.md"), template),
  ]);
  const note = (title: string, source: string | undefined, tags: readonly string[], body: string) => `---\ntemplate: reference\ntitle: ${title}\n${source === undefined ? "" : `source-url: ${source}\n`}tags:\n${tags.map(tag => `  - ${tag}`).join("\n")}\n---\n\n${body}\n`;
  await writeFile(path.join(vault, "references/Agent Retrieval.md"), note("Agent Retrieval", "https://example.com/agent-retrieval", ["agent-graph"], "Agent retrieval follows [[Graph Index]] and combines semantic evidence with graph context."));
  await writeFile(path.join(vault, "references/Graph Index.md"), note("Graph Index", "https://example.com/graph-index", ["agent-graph"], "Index note for graph neighborhoods."));
  await writeFile(path.join(vault, "references/Unrelated.md"), note("Unrelated", undefined, ["archive"], "Agent retrieval outside the selected graph should only appear for global semantic fusion."));
  return vault;
}
