import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { digestBytes } from "../templates/canonical.js";
import { serializeContractPolicyV5 } from "../templates/contract-v5.js";

const REFERENCE_SOURCE = "---\ntemplate: reference\ntitle: Untitled\ntags: []\n---\n\n## Summary\n";

/**
 * A real explicit V5 vault: a user-owned property pool, an always-on common
 * contract with no physical Markdown, and one registered template whose source
 * is the user's own file. Notes are written as an agent would write them; OMS
 * does not render them.
 */
export async function writeMorningVaultFixture(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-morning-"));
  for (const directory of [".oms/templates", ".obsidian", "references"]) {
    await mkdir(path.join(vault, directory), { recursive: true });
  }
  const policyText = serializeContractPolicyV5({
    version: 5,
    revision: 1,
    properties: {
      title: { type: "text", intent: "Note title." },
      "source-url": { type: "text", intent: "Where the reference came from.", format: "url" },
      tags: { type: "list", intent: "Retrieval tags." },
    },
    common: { status: "active", fields: {} },
    templates: {
      reference: {
        status: "active",
        source: { identity: "source-reference", path: "Templates/reference.md", rawDigest: digestBytes(REFERENCE_SOURCE) },
        fields: {
          title: { required: true },
          "source-url": {},
          tags: {},
        },
        headings: [{ headingId: "summary", title: "Summary", level: 2, required: true }],
      },
    },
  });
  const taxonomyText = JSON.stringify({
    templates: { reference: { templateFolder: "references" } },
    folders: { references: { intent: "Processed external sources." } },
  });
  const obsidianTypes = JSON.stringify({ types: { title: "text", "source-url": "text", tags: "list" } });
  await mkdir(path.join(vault, "Templates"), { recursive: true });
  await Promise.all([
    writeFile(path.join(vault, ".oms/template-policy.json"), policyText),
    writeFile(path.join(vault, ".oms/taxonomy.json"), taxonomyText),
    writeFile(path.join(vault, "Templates/reference.md"), REFERENCE_SOURCE),
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
