import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeContractVault } from "../contract/contract-vault-fixture.js";

const REFERENCE_SOURCE = "---\ntemplate: reference\ntitle: Untitled\ntags: []\n---\n\n## Summary\n";

const note = (title: string, source: string | undefined, tags: readonly string[], body: string): string =>
  `---\ntemplate: reference\ntitle: ${title}\n${source === undefined ? "" : `source-url: ${source}\n`}tags:\n${tags.map(tag => `  - ${tag}`).join("\n")}\n---\n\n## Summary\n\n${body}\n`;

/**
 * A real sealed vault: `.oms/settings.json` in the vault and the contract (one
 * `reference` template whose source is the user's own file) sealed into the
 * contract store. Notes are written as an agent would write them; OMS does not
 * render them. Subprocess suites pass their child HOME's `.oms/vaults`.
 */
export async function writeMorningVaultFixture(contractStoreRoot?: string): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-morning-"));
  await writeContractVault(vault, {
    ...(contractStoreRoot === undefined ? {} : { contractStoreRoot }),
    properties: {
      title: { type: "text", intent: "Note title." },
      "source-url": { type: "text", intent: "Where the reference came from." },
      tags: { type: "list", intent: "Retrieval tags." },
    },
    templates: {
      reference: {
        fields: ["title", "source-url", "tags"],
        optionalFields: ["source-url", "tags"],
        headings: [{ headingId: "summary", title: "Summary", level: 2 }],
        approvedMarkdown: REFERENCE_SOURCE,
        targetFolder: "references",
      },
    },
    folders: { references: { intent: "Processed external sources." } },
    obsidianTypes: { title: "text", "source-url": "text", tags: "list" },
    notes: {
      "references/Agent Retrieval.md": note("Agent Retrieval", "https://example.com/agent-retrieval", ["agent-graph"], "Agent retrieval follows [[Graph Index]] and combines semantic evidence with graph context."),
      "references/Graph Index.md": note("Graph Index", "https://example.com/graph-index", ["agent-graph"], "Index note for graph neighborhoods."),
      "references/Unrelated.md": note("Unrelated", undefined, ["archive"], "Agent retrieval outside the selected graph should only appear for global semantic fusion."),
    },
  });
  return vault;
}
