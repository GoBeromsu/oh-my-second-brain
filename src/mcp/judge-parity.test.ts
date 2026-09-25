import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTruthTableRow, type TruthTableFixture } from "../../test/fixtures/contract-truth-table.js";
import type { JudgeInput, VaultContract, Violation } from "../kernel/contract/types.js";

/**
 * AC11: MCP `write` and the Claude hook translator hand the same `JudgeInput` to the
 * one judge for the same note, and the final verdicts match.
 */

const judgeSpy = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("../kernel/contract/judge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../kernel/contract/judge.js")>();
  return {
    ...actual,
    judge: (...args: Parameters<typeof actual.judge>) => {
      judgeSpy.calls.push(args);
      return actual.judge(...args);
    },
  };
});

const { createOMSMcpServer } = await import("./server.js");
const { translatePreToolUse } = await import("../vendors/claude/hook/pre-tool-use.js");
const { formatDenyReason } = await import("../kernel/contract/types.js");

const CONTRACT: VaultContract = {
  folders: { Projects: { meaning: "project notes", searchExclude: false }, Loose: { meaning: "loose notes", searchExclude: false } },
  properties: {
    status: { meaning: "state", type: "text", default: false, required: true, rules: [{ kind: "allowed", values: ["active", "done"] }] },
  },
  templates: {
    project: { source: "Templates/project.md", sourceHash: `sha256:${"0".repeat(64)}`, applyFolder: "Projects", requiredProperties: ["status"], narrowedRules: {}, requiredHeadings: ["Goals"] },
  },
};

const PREVIOUS = "---\nstatus: active\n---\n## Goals\nShip.\n";

interface Row {
  readonly name: string;
  readonly path: string;
  /** Existing note content, or undefined for a new file. */
  readonly previous?: string;
  /** Resulting note content. For an edit the hook receives old/new strings instead. */
  readonly content: string;
  readonly edit?: { readonly old_string: string; readonly new_string: string };
  /** The input the judge must receive from both surfaces; null when neither reaches it. */
  readonly input: JudgeInput | null;
  readonly ok: boolean;
}

const ROWS: readonly Row[] = [
  {
    name: "new note that satisfies folder, property and template axes",
    path: "Projects/new-good.md",
    content: "---\nstatus: active\n---\n## Goals\nShip.\n",
    input: { path: "Projects/new-good.md", frontmatter: { status: "active" }, body: "## Goals\nShip.\n" },
    ok: true,
  },
  {
    name: "new note with a disallowed property value",
    path: "Projects/new-bad.md",
    content: "---\nstatus: paused\n---\n## Goals\n",
    input: { path: "Projects/new-bad.md", frontmatter: { status: "paused" }, body: "## Goals\n" },
    ok: false,
  },
  {
    name: "new note missing a required property outside the template folder",
    path: "Loose/missing.md",
    content: "---\nextra: 1\n---\nBody\n",
    input: { path: "Loose/missing.md", frontmatter: { extra: 1 }, body: "Body\n" },
    ok: false,
  },
  {
    name: "new note in an unregistered folder",
    path: "Elsewhere/stray.md",
    content: "---\nstatus: done\n---\n",
    input: { path: "Elsewhere/stray.md", frontmatter: { status: "done" }, body: "" },
    ok: false,
  },
  {
    name: "edit that keeps the note valid",
    path: "Projects/edit-good.md",
    previous: PREVIOUS,
    content: "---\nstatus: done\n---\n## Goals\nShip.\n",
    edit: { old_string: "status: active", new_string: "status: done" },
    input: { path: "Projects/edit-good.md", frontmatter: { status: "done" }, body: "## Goals\nShip.\n", previousContent: PREVIOUS },
    ok: true,
  },
  {
    name: "edit that drops the template heading",
    path: "Projects/edit-bad.md",
    previous: PREVIOUS,
    content: "---\nstatus: active\n---\n## Plans\nShip.\n",
    edit: { old_string: "## Goals", new_string: "## Plans" },
    input: { path: "Projects/edit-bad.md", frontmatter: { status: "active" }, body: "## Plans\nShip.\n", previousContent: PREVIOUS },
    ok: false,
  },
  {
    name: "malformed frontmatter is refused before the judge",
    path: "Projects/broken.md",
    content: "---\nstatus: [\n---\n",
    input: null,
    ok: false,
  },
];

let fixture: TruthTableFixture;
let client: Client;
const originalHome = process.env["HOME"];

beforeAll(async () => {
  fixture = await buildTruthTableRow("sealed", CONTRACT);
  process.env["HOME"] = path.join(fixture.base, "home");
  for (const row of ROWS) {
    if (row.previous === undefined) continue;
    await mkdir(path.dirname(path.join(fixture.vault, row.path)), { recursive: true });
    await writeFile(path.join(fixture.vault, row.path), row.previous);
  }
  const server = createOMSMcpServer({ vault: fixture.vault, source: "explicit" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "judge-parity", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  await fixture.cleanup();
});

beforeEach(() => {
  judgeSpy.calls.length = 0;
});

function hookPayload(row: Row): string {
  const filePath = path.join(fixture.vault, row.path);
  return JSON.stringify(row.edit === undefined
    ? { tool_name: "Write", tool_input: { file_path: filePath, content: row.content }, cwd: fixture.vault }
    : { tool_name: "Edit", tool_input: { file_path: filePath, ...row.edit }, cwd: fixture.vault });
}

describe("MCP write and the hook translator share one judge", () => {
  it.each(ROWS)("$name", async (row) => {
    // The hook only reads, so it runs first; an allowed MCP write then changes the file.
    const hook = await translatePreToolUse(hookPayload(row), fixture.vault);
    const hookCalls = judgeSpy.calls.splice(0);

    const result = await client.callTool({ name: "write", arguments: { path: row.path, content: row.content } });
    const mcpCalls = judgeSpy.calls.splice(0);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const payload = JSON.parse(text) as { ok: boolean; violations?: Violation[] };

    if (row.input === null) {
      expect(hookCalls).toEqual([]);
      expect(mcpCalls).toEqual([]);
    } else {
      expect(hookCalls).toHaveLength(1);
      expect(mcpCalls).toHaveLength(1);
      expect(hookCalls[0]![0]).toEqual(row.input);
      expect(mcpCalls[0]![0]).toEqual(row.input);
      expect(mcpCalls[0]![1]).toEqual(hookCalls[0]![1]);
    }

    expect(payload.ok).toBe(row.ok);
    expect(result.isError === true).toBe(!row.ok);
    if (row.ok) {
      expect(hook.response).toEqual({ continue: true, suppressOutput: true });
    } else {
      expect(hook.response).toEqual({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: formatDenyReason(payload.violations!) },
      });
    }
  });
});
