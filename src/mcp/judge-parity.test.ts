import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTruthTableRow, type TruthTableFixture } from "../../test/fixtures/contract-truth-table.js";
import type { JudgeInput, VaultContract, Violation } from "../kernel/contract/types.js";

/**
 * AC11: MCP `write`, CLI `oms write` and the Claude hook translator hand the same
 * `JudgeInput` to the one judge for the same note, and agree on the decision: only a
 * refusal denies, a note that breaks the contract is let through with the same warnings.
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
const { formatDenyReason, formatWarnings } = await import("../kernel/contract/types.js");
const { runWriteCommand } = await import("../cli/write-command.js");

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
  readonly decision: "allow" | "warn" | "deny";
}

const ROWS: readonly Row[] = [
  {
    name: "new note that satisfies folder, property and template axes",
    path: "Projects/new-good.md",
    content: "---\nstatus: active\n---\n## Goals\nShip.\n",
    input: { path: "Projects/new-good.md", frontmatter: { status: "active" }, body: "## Goals\nShip.\n" },
    decision: "allow",
  },
  {
    name: "new note with a disallowed property value",
    path: "Projects/new-bad.md",
    content: "---\nstatus: paused\n---\n## Goals\n",
    input: { path: "Projects/new-bad.md", frontmatter: { status: "paused" }, body: "## Goals\n" },
    decision: "warn",
  },
  {
    name: "new note missing a required property outside the template folder",
    path: "Loose/missing.md",
    content: "---\nextra: 1\n---\nBody\n",
    input: { path: "Loose/missing.md", frontmatter: { extra: 1 }, body: "Body\n" },
    decision: "warn",
  },
  {
    name: "new note in an unregistered folder",
    path: "Elsewhere/stray.md",
    content: "---\nstatus: done\n---\n",
    input: { path: "Elsewhere/stray.md", frontmatter: { status: "done" }, body: "" },
    decision: "warn",
  },
  {
    name: "edit that keeps the note valid",
    path: "Projects/edit-good.md",
    previous: PREVIOUS,
    content: "---\nstatus: done\n---\n## Goals\nShip.\n",
    edit: { old_string: "status: active", new_string: "status: done" },
    input: { path: "Projects/edit-good.md", frontmatter: { status: "done" }, body: "## Goals\nShip.\n", previousContent: PREVIOUS },
    decision: "allow",
  },
  {
    name: "edit that drops the template heading",
    path: "Projects/edit-bad.md",
    previous: PREVIOUS,
    content: "---\nstatus: active\n---\n## Plans\nShip.\n",
    edit: { old_string: "## Goals", new_string: "## Plans" },
    input: { path: "Projects/edit-bad.md", frontmatter: { status: "active" }, body: "## Plans\nShip.\n", previousContent: PREVIOUS },
    decision: "warn",
  },
  {
    name: "malformed frontmatter is let through with a warning",
    path: "Projects/broken.md",
    content: "---\nstatus: [\n---\n",
    input: null,
    decision: "warn",
  },
  {
    name: "a control path is refused before the judge",
    path: ".oms/note.md",
    content: "---\nstatus: active\n---\n",
    input: null,
    decision: "deny",
  },
];

interface Payload {
  readonly ok: boolean;
  readonly status?: string;
  readonly refusals?: Violation[];
  readonly warnings?: Array<Pick<Violation, "field" | "kind">>;
  readonly exitCode?: number | string | undefined;
}

let fixture: TruthTableFixture;
/** CLI writes land in their own sealed vault so an allowed write cannot turn MCP's new note into an edit. */
let cliFixture: TruthTableFixture;
let client: Client;
const originalHome = process.env["HOME"];

async function seedPrevious(target: TruthTableFixture): Promise<void> {
  for (const row of ROWS) {
    if (row.previous === undefined) continue;
    await mkdir(path.dirname(path.join(target.vault, row.path)), { recursive: true });
    await writeFile(path.join(target.vault, row.path), row.previous);
  }
}

/** An edit names the revision it replaces, as the write pipeline requires of every overwrite. */
function ifMatchOf(row: Row): string | undefined {
  return row.previous === undefined ? undefined : `sha256:${createHash("sha256").update(row.previous).digest("hex")}`;
}

/** Runs `oms write` against the CLI vault with an injected stdin and an empty env, returning its receipt. */
async function cliWrite(row: Row): Promise<Payload> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  process.env["HOME"] = path.join(cliFixture.base, "home");
  try {
    const ifMatch = ifMatchOf(row);
    const argv = ifMatch === undefined ? [row.path] : [row.path, "--if-match", ifMatch];
    await runWriteCommand([...argv, "--vault", cliFixture.vault], { env: {}, cwd: cliFixture.vault, readStdin: async () => row.content });
    expect(error).not.toHaveBeenCalled();
    return { ...(JSON.parse(String(log.mock.calls[0]?.[0])) as Payload), exitCode: process.exitCode };
  } finally {
    process.env["HOME"] = path.join(fixture.base, "home");
    process.exitCode = 0;
    log.mockRestore();
    error.mockRestore();
  }
}

beforeAll(async () => {
  fixture = await buildTruthTableRow("sealed", CONTRACT);
  cliFixture = await buildTruthTableRow("sealed", CONTRACT);
  process.env["HOME"] = path.join(fixture.base, "home");
  await seedPrevious(fixture);
  await seedPrevious(cliFixture);
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
  await cliFixture.cleanup();
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

describe("MCP write, CLI write and the hook translator share one judge", () => {
  it.each(ROWS)("$name", async (row) => {
    // The hook only reads, so it runs first; an allowed MCP write then changes the file.
    const hook = await translatePreToolUse(hookPayload(row), fixture.vault);
    const hookCalls = judgeSpy.calls.splice(0);

    const cli = await cliWrite(row);
    const cliCalls = judgeSpy.calls.splice(0);

    const result = await client.callTool({ name: "write", arguments: { path: row.path, content: row.content, ...(row.previous === undefined ? {} : { ifMatch: ifMatchOf(row) }) } });
    const mcpCalls = judgeSpy.calls.splice(0);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const payload = JSON.parse(text) as Payload;

    if (row.input === null) {
      expect(hookCalls).toEqual([]);
      expect(mcpCalls).toEqual([]);
      expect(cliCalls).toEqual([]);
    } else {
      // An edit is judged twice: first the note it leaves, then the note on disk as the baseline.
      const calls = row.previous === undefined ? 1 : 2;
      expect(hookCalls).toHaveLength(calls);
      expect(mcpCalls).toHaveLength(calls);
      expect(cliCalls).toHaveLength(calls);
      expect(hookCalls[0]![0]).toEqual(row.input);
      expect(mcpCalls[0]![0]).toEqual(row.input);
      expect(cliCalls[0]![0]).toEqual(row.input);
      expect(mcpCalls[0]![1]).toEqual(hookCalls[0]![1]);
      expect(cliCalls[0]![1]).toEqual(hookCalls[0]![1]);
      if (row.previous !== undefined) {
        const baseline = { path: row.path, frontmatter: { status: "active" }, body: "## Goals\nShip.\n" };
        for (const calls of [hookCalls, mcpCalls, cliCalls]) expect(calls[1]![0]).toEqual(baseline);
      }
    }

    const { exitCode, ...cliPayload } = cli;
    expect(Object.keys(cliPayload).sort()).toEqual(Object.keys(payload).sort());
    expect(cliPayload.status).toEqual(payload.status);
    expect(cliPayload.refusals).toEqual(payload.refusals);
    expect(cliPayload.warnings).toEqual(payload.warnings);
    if (row.decision === "deny") {
      expect(payload).toMatchObject({ ok: false, status: "denied" });
      expect(result.isError).toBe(true);
      expect(exitCode).toBe(1);
      expect(hook.response).toEqual({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: formatDenyReason(payload.refusals!) },
      });
    } else if (row.decision === "warn") {
      expect(payload.warnings!.length).toBeGreaterThan(0);
      // Let through: saved with its warnings, or kept as a draft when a new gap cannot be repaired.
      expect(payload.ok === true || payload.status === "drafted").toBe(true);
      expect(result.isError).toBeUndefined();
      const message = formatWarnings(payload.warnings!);
      expect(hook.response).toEqual({ systemMessage: message, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: message } });
    } else {
      expect(payload.ok).toBe(true);
      expect(payload.warnings).toEqual([]);
      expect(result.isError).toBeUndefined();
      expect(exitCode).toBe(0);
      expect(hook.response).toEqual({ continue: true, suppressOutput: true });
    }
  });
});
