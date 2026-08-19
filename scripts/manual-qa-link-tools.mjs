#!/usr/bin/env node
/**
 * Manual QA for the oms_link_suggest / oms_link_apply MCP tools.
 *
 * Boots the real `oms mcp` stdio server against a throwaway fixture vault (two
 * term notes, one carrying a Korean alias, plus a note that mentions both),
 * drives both tools through a genuine MCP handshake, and prints the candidates
 * alongside the persisted note bytes so a human can see the [[links]] landed.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

function payload(result) {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error(`expected a text content block, got ${block?.type}`);
  return JSON.parse(block.text);
}

async function main() {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-linkify-qa-"));
  await mkdir(path.join(vault, "terms"), { recursive: true });
  await mkdir(path.join(vault, "notes"), { recursive: true });
  await writeFile(
    path.join(vault, "terms", "Ataraxia.md"),
    "---\ntitle: Ataraxia\naliases:\n  - 아타락시아\n---\n\nFreedom from disturbance.\n",
    "utf-8",
  );
  await writeFile(
    path.join(vault, "terms", "Stoicism.md"),
    "---\ntitle: Stoicism\n---\n\nA school of thought.\n",
    "utf-8",
  );
  const notePath = "notes/sage.md";
  const noteFile = path.join(vault, notePath);
  await writeFile(
    noteFile,
    "---\ntitle: Sage\n---\n\n아타락시아를 향한 길은 Stoicism 안에 있다.\nThe sage also pursues Ataraxia, but `Ataraxia` in code stays protected.\n",
    "utf-8",
  );

  console.log(`vault: ${vault}`);
  console.log("--- note BEFORE ---");
  console.log(await readFile(noteFile, "utf-8"));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distCli, "mcp", "--vault", vault],
    cwd: repoRoot,
    stderr: "inherit",
  });
  const client = new Client({ name: "oms-linkify-qa", version: "0.0.0" });

  try {
    await client.connect(transport);

    const suggested = payload(
      await client.callTool({ name: "oms_link_suggest", arguments: { notePath } }),
    );
    console.log("--- oms_link_suggest ---");
    console.log(JSON.stringify(suggested, null, 2));

    const stale = payload(
      await client.callTool({
        name: "oms_link_apply",
        arguments: {
          notePath,
          baseContentHash: "0".repeat(64),
          candidateIds: suggested.candidates.map((candidate) => candidate.id),
        },
      }),
    );
    console.log("--- oms_link_apply (STALE hash: must refuse, no write) ---");
    console.log(JSON.stringify(stale, null, 2));
    console.log(`file unchanged after stale apply: ${(await readFile(noteFile, "utf-8")).includes("[[") === false}`);

    const applied = payload(
      await client.callTool({
        name: "oms_link_apply",
        arguments: {
          notePath,
          baseContentHash: suggested.baseContentHash,
          candidateIds: suggested.candidates.map((candidate) => candidate.id),
        },
      }),
    );
    console.log("--- oms_link_apply (CURRENT hash) ---");
    console.log(JSON.stringify(applied, null, 2));

    console.log("--- note AFTER (bytes read back off disk) ---");
    console.log(await readFile(noteFile, "utf-8"));
  } finally {
    await client.close();
    await rm(vault, { recursive: true, force: true });
  }
}

await main();
