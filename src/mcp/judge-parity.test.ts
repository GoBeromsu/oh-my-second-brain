import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTruthTableRow, type TruthTableFixture } from "../../test/fixtures/contract-truth-table.js";
import type { TemplatedContract } from "../kernel/contract/legacy.js";
import type { JudgeInput, Violation } from "../kernel/contract/types.js";
import type { SealRow } from "../kernel/contract/vault-id.js";

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
const { formatDenyReason, WARNING_PREFIX } = await import("../kernel/contract/types.js");
const { runWriteCommand } = await import("../cli/write-command.js");

const CONTRACT: TemplatedContract = {
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
    input: { path: "Projects/edit-good.md", frontmatter: { status: "done" }, body: "## Goals\nShip.\n" },
    decision: "allow",
  },
  {
    name: "edit that drops the template heading, which the judge never reads",
    path: "Projects/edit-heading.md",
    previous: PREVIOUS,
    content: "---\nstatus: active\n---\n## Plans\nShip.\n",
    edit: { old_string: "## Goals", new_string: "## Plans" },
    input: { path: "Projects/edit-heading.md", frontmatter: { status: "active" }, body: "## Plans\nShip.\n" },
    decision: "allow",
  },
  {
    name: "edit that sets a disallowed property value",
    path: "Projects/edit-bad.md",
    previous: PREVIOUS,
    content: "---\nstatus: paused\n---\n## Goals\nShip.\n",
    edit: { old_string: "status: active", new_string: "status: paused" },
    input: { path: "Projects/edit-bad.md", frontmatter: { status: "paused" }, body: "## Goals\nShip.\n" },
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
  readonly fixes?: Array<Pick<Violation, "field" | "kind">>;
  readonly next?: string;
  readonly exitCode?: number | string | undefined;
}

type Decision = Row["decision"];

/**
 * The seal states the table runs under, with the decision each expects for a row. Only a
 * tampered seal refuses everything; an open or unreadable contract warns on every write.
 */
const SEALS: ReadonlyArray<{ readonly seal: SealRow; readonly expected: (row: Row) => Decision }> = [
  { seal: "sealed", expected: (row) => row.decision },
  { seal: "never-sealed", expected: (row) => (row.decision === "deny" ? "deny" : "warn") },
  { seal: "index-without-store", expected: (row) => (row.decision === "deny" ? "deny" : "warn") },
  { seal: "vault-id-tampered", expected: () => "deny" },
];

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

function hookPayload(fixture: TruthTableFixture, row: Row): string {
  const filePath = path.join(fixture.vault, row.path);
  return JSON.stringify(row.edit === undefined
    ? { tool_name: "Write", tool_input: { file_path: filePath, content: row.content }, cwd: fixture.vault }
    : { tool_name: "Edit", tool_input: { file_path: filePath, ...row.edit }, cwd: fixture.vault });
}

/** What the hook decided, read back from its response shape. */
/** `{field, kind}` pairs in a stable order, so two surfaces compare as sets. */
function sorted(findings: ReadonlyArray<Pick<Violation, "field" | "kind">>): string[] {
  return findings.map(finding => `${finding.field}/${finding.kind}`).sort();
}

/** The `{field, kind}` list a hook warning line carries. */
function warnedIn(message: string): Array<Pick<Violation, "field" | "kind">> {
  expect(message.startsWith(WARNING_PREFIX)).toBe(true);
  const list = message.slice(WARNING_PREFIX.length, message.lastIndexOf(" Run: "));
  return JSON.parse(list) as Array<Pick<Violation, "field" | "kind">>;
}

function hookDecision(response: unknown): { readonly decision: Decision; readonly message: string | null } {
  const shape = response as { systemMessage?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  if (shape.hookSpecificOutput?.permissionDecision === "deny") return { decision: "deny", message: shape.hookSpecificOutput.permissionDecisionReason ?? null };
  if (shape.systemMessage !== undefined) return { decision: "warn", message: shape.systemMessage };
  return { decision: "allow", message: null };
}

describe.each(SEALS)("MCP write, CLI write and the hook translator share one judge ($seal)", ({ seal, expected }) => {
  let fixture: TruthTableFixture;
  /** CLI writes land in their own vault so an allowed write cannot turn MCP's new note into an edit. */
  let cliFixture: TruthTableFixture;
  let client: Client;

  /** Runs `oms write` against the CLI vault with an injected stdin and an empty env, returning its receipt. */
  async function cliWrite(row: Row): Promise<Payload> {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env["HOME"] = path.join(cliFixture.base, "home");
    try {
      const ifMatch = ifMatchOf(row);
      const argv = ifMatch === undefined ? [row.path] : [row.path, "--if-match", ifMatch];
      await runWriteCommand([...argv, "--vault", cliFixture.vault], { env: {}, cwd: cliFixture.vault, readStdin: async () => row.content });
      const payload = JSON.parse(String(log.mock.calls[0]?.[0])) as Payload;
      // stderr carries only the finding lines: the warnings (with the next command) and the fixes, each when present.
      const findings = [
        ...(payload.warnings?.length ? [`[oms] warnings: ${JSON.stringify(payload.warnings)}${payload.next === undefined ? "" : ` Run: ${payload.next}`}`] : []),
        ...(payload.fixes?.length ? [`[oms] fixed: ${JSON.stringify(payload.fixes)}`] : []),
      ];
      expect(error.mock.calls.map(call => call[0])).toEqual(findings);
      return { ...payload, exitCode: process.exitCode };
    } finally {
      process.env["HOME"] = path.join(fixture.base, "home");
      process.exitCode = 0;
      log.mockRestore();
      error.mockRestore();
    }
  }

  beforeAll(async () => {
    fixture = await buildTruthTableRow(seal, CONTRACT);
    cliFixture = await buildTruthTableRow(seal, CONTRACT);
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

  it.each(ROWS)("$name", async (row) => {
    // The hook only reads, so it runs first; an allowed MCP write then changes the file.
    const hook = await translatePreToolUse(hookPayload(fixture, row), fixture.vault);
    const hookCalls = judgeSpy.calls.splice(0);

    const cli = await cliWrite(row);
    const cliCalls = judgeSpy.calls.splice(0);

    const result = await client.callTool({ name: "write", arguments: { path: row.path, content: row.content, ...(row.previous === undefined ? {} : { ifMatch: ifMatchOf(row) }) } });
    const mcpCalls = judgeSpy.calls.splice(0);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const payload = JSON.parse(text) as Payload;

    // Every surface judges the same notes, in the same order, against the same view.
    expect(mcpCalls.length).toBe(hookCalls.length);
    expect(cliCalls.length).toBe(hookCalls.length);
    for (const [index, call] of hookCalls.entries()) {
      expect(mcpCalls[index]).toEqual(call);
      expect(cliCalls[index]).toEqual(call);
    }
    if (seal === "sealed") {
      if (row.input === null) {
        expect(hookCalls).toEqual([]);
      } else {
        // An edit is judged twice: first the note it leaves, then the note on disk as the baseline.
        expect(hookCalls).toHaveLength(row.previous === undefined ? 1 : 2);
        expect(hookCalls[0]![0]).toEqual(row.input);
        if (row.previous !== undefined) {
          expect(hookCalls[1]![0]).toEqual({ path: row.path, frontmatter: { status: "active" }, body: "## Goals\nShip.\n" });
        }
      }
    }

    const { exitCode, ...cliPayload } = cli;
    expect(Object.keys(cliPayload).sort()).toEqual(Object.keys(payload).sort());
    expect(cliPayload.status).toEqual(payload.status);
    expect(cliPayload.refusals).toEqual(payload.refusals);
    expect(cliPayload.warnings).toEqual(payload.warnings);
    expect(cliPayload.fixes).toEqual(payload.fixes);

    // Cross-surface: hook deny <=> MCP denied, hook warn <=> MCP written or drafted with the same warnings.
    const decision = expected(row);
    const fromHook = hookDecision(hook.response);
    expect(fromHook.decision).toBe(decision);
    if (decision === "deny") {
      expect(payload).toMatchObject({ ok: false, status: "denied" });
      expect(result.isError).toBe(true);
      expect(exitCode).toBe(1);
      expect(hook.response).toEqual({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: formatDenyReason(payload.refusals!) },
      });
    } else {
      expect(payload.status).not.toBe("denied");
      expect(result.isError).toBeUndefined();
      // The hook never fixes, so it warns on everything MCP either kept as a warning or fixed.
      // A fix moves a finding from one list to the other, so the two compare as sets.
      const met = [...(payload.warnings ?? []), ...(payload.fixes ?? [])];
      if (decision === "warn") {
        // Let through: saved with its warnings, or kept as a draft when the frontmatter does not parse.
        expect(payload.ok === true || payload.status === "drafted").toBe(true);
        expect(met.length).toBeGreaterThan(0);
        const message = fromHook.message!;
        expect(hook.response).toEqual({ systemMessage: message, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: message } });
        expect(sorted(warnedIn(message))).toEqual(sorted(met));
      } else {
        expect(payload.ok).toBe(true);
        expect(met).toEqual([]);
        expect(exitCode).toBe(0);
        expect(hook.response).toEqual({ continue: true, suppressOutput: true });
      }
    }
  });
});
