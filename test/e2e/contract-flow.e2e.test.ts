import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { runInterview, type InterviewIO, type Question } from "../../src/kernel/contract/interview.js";
import { storeRoot } from "../../src/kernel/contract/store.js";
import { createOMSMcpServer } from "../../src/mcp/server.js";

const bases: string[] = [];

afterEach(async () => {
  await Promise.all(bases.splice(0).map(base => rm(base, { recursive: true, force: true })));
});

/** Answers by question id; any unscripted question fails the flow. */
function scripted(answers: Readonly<Record<string, string>>): InterviewIO {
  return {
    say: () => undefined,
    ask: async (question: Question) => {
      const answer = answers[question.id];
      if (answer === undefined) throw new Error(`unscripted question ${question.id}`);
      return answer;
    },
  };
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as readonly { readonly type: string; readonly text?: string }[];
  return JSON.parse(content[0]?.text ?? "null") as Record<string, unknown>;
}

describe("contract flow e2e", () => {
  it("writes freely before a seal, seals through the interview, then judges every write", async () => {
    // The sealed store lives under the suite's isolated HOME, never the developer's.
    expect(homedir()).not.toBe(process.env["OMS_TEST_HOST_HOME"]);
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "oms-contract-flow-")));
    bases.push(base);
    const vault = path.join(base, "vault");
    await mkdir(path.join(vault, "Projects"), { recursive: true });
    await mkdir(path.join(vault, ".obsidian"));
    // Obsidian's own property types file is legal vault input the interview reads.
    await writeFile(path.join(vault, ".obsidian", "types.json"), JSON.stringify({ types: { status: "text" } }));

    const server = createOMSMcpServer({ vault, source: "explicit" });
    const client = new Client({ name: "oms-contract-flow", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const write = (args: Record<string, unknown>) => client.callTool({ name: "write", arguments: args });

    try {
      // An empty vault has no contract, so an ordinary write succeeds.
      expect(payload(await write({ path: "Projects/free.md", content: "---\nstatus: anything\n---\nFree\n" })))
        .toEqual({ ok: true, path: "Projects/free.md", missingDefaults: [] });

      const sealed = await runInterview({
        vault,
        root: storeRoot(),
        io: scripted({
          "template-folder:path": "",
          "folder:Projects:register": "y",
          "folder:Projects:meaning": "project notes",
          "folder:Projects:search-exclude": "n",
          "property:status:register": "y",
          "property:status:type": "",
          "property:status:required": "yes",
          "property:status:rule": "2",
          "property:status:allowed": "open, closed",
          "property:status:meaning": "workflow state",
          "seal": "y",
        }),
      });
      expect(sealed).toEqual({ state: "sealed", vaultIdCreated: true, folders: 1, properties: 1, templates: [] });

      const denied = await write({ path: "Projects/b.md", content: "---\nstatus: nope\n---\nBody\n" });
      expect(denied.isError).toBe(true);
      expect(payload(denied)).toMatchObject({ ok: false, violations: [{ field: "status", kind: "not-allowed" }] });
      expect(existsSync(path.join(vault, "Projects", "b.md"))).toBe(false);

      expect(payload(await write({ path: "Projects/b.md", content: "---\nstatus: closed\n---\nBody\n" })))
        .toEqual({ ok: true, path: "Projects/b.md", missingDefaults: [] });

      // The vault keeps only its settings file; the contract lives in the store.
      expect(await readdir(path.join(vault, ".oms"))).toEqual(["settings.json"]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
