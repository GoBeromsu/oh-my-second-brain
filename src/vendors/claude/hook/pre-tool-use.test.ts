import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTruthTableRow, TRUTH_TABLE_ROWS, type TruthTableFixture } from "../../../../test/fixtures/contract-truth-table.js";
import { formatDenyReason, GUIDANCE, GUIDANCE_FOR, VIOLATION_KINDS, type VaultContract } from "../../../kernel/contract/types.js";
import type { SealRow } from "../../../kernel/contract/vault-id.js";

const stdin = vi.hoisted(() => ({ value: "{}", truncated: false }));
vi.mock("./stdin.js", () => ({ readStdinTimeout: async () => ({ text: stdin.value, truncated: stdin.truncated, timedOut: false }) }));

const { runPreToolUse, translatePreToolUse } = await import("./pre-tool-use.js");

const ALLOW = '{"continue":true,"suppressOutput":true}\n';

const CONTRACT: VaultContract = {
  folders: { Projects: { meaning: "project notes", searchExclude: false } },
  properties: { status: { meaning: "state", type: "text", default: false, required: true, rules: [{ kind: "allowed", values: ["open", "done"] }] } },
  templates: {},
};

const EXPECTED_VIEW: Readonly<Record<SealRow, "open" | "unreadable" | "sealed">> = {
  "never-sealed": "open",
  "synced-second-machine": "open",
  "store-without-index": "sealed",
  "vault-moved": "sealed",
  "sealed": "sealed",
  "index-without-store": "unreadable",
  "vault-id-tampered": "unreadable",
  "index-corrupt": "sealed",
};

const fixtures: TruthTableFixture[] = [];
const originalHome = process.env["HOME"];

async function row(name: SealRow): Promise<TruthTableFixture> {
  const fixture = await buildTruthTableRow(name, CONTRACT);
  fixtures.push(fixture);
  process.env["HOME"] = join(fixture.base, "home");
  return fixture;
}

function payload(tool: string, input: Record<string, unknown>, cwd?: string): string {
  return JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, ...(cwd === undefined ? {} : { cwd }) });
}

async function decide(vault: string, raw: string): Promise<{ decision: "allow" | "deny"; reason: string | null; warning: string | null }> {
  const result = await translatePreToolUse(raw, vault);
  if ("hookSpecificOutput" in result.response) {
    return { decision: "deny", reason: result.response.hookSpecificOutput.permissionDecisionReason, warning: result.warning };
  }
  return { decision: "allow", reason: null, warning: result.warning };
}

const GOOD = "---\nstatus: open\n---\nbody\n";
const BAD = "---\nstatus: maybe\n---\nbody\n";

beforeEach(() => {
  stdin.value = "{}";
  stdin.truncated = false;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
});

describe("translatePreToolUse over the truth table", () => {
  for (const name of TRUTH_TABLE_ROWS) {
    it(`judges a Write in row ${name} by its view (${EXPECTED_VIEW[name]})`, async () => {
      const { vault } = await row(name);
      const good = await decide(vault, payload("Write", { file_path: join(vault, "Projects/a.md"), content: GOOD }));
      const bad = await decide(vault, payload("Write", { file_path: join(vault, "Projects/a.md"), content: BAD }));
      const view = EXPECTED_VIEW[name];
      if (view === "open") {
        expect([good.decision, bad.decision]).toEqual(["allow", "allow"]);
      } else if (view === "unreadable") {
        expect(good).toEqual({ decision: "deny", reason: formatDenyReason([{ field: "contract", kind: "contract-unreadable" }]), warning: null });
        expect(bad.decision).toBe("deny");
      } else {
        expect(good.decision).toBe("allow");
        expect(bad).toEqual({ decision: "deny", reason: formatDenyReason([{ field: "status", kind: "not-allowed" }]), warning: null });
      }
    });
  }
});

describe("translatePreToolUse content reconstruction", () => {
  it("judges an Edit on the note the edit leaves behind", async () => {
    const { vault } = await row("sealed");
    const note = join(vault, "Projects/a.md");
    await mkdir(join(vault, "Projects"), { recursive: true });
    await writeFile(note, GOOD);
    expect((await decide(vault, payload("Edit", { file_path: note, old_string: "status: open", new_string: "status: done" }))).decision).toBe("allow");
    expect((await decide(vault, payload("Edit", { file_path: note, old_string: "status: open", new_string: "status: maybe" }))).decision).toBe("deny");
  });

  it("denies an edit that matches nothing or matches twice without replace_all in a sealed vault", async () => {
    const { vault } = await row("sealed");
    const note = join(vault, "Projects/a.md");
    await mkdir(join(vault, "Projects"), { recursive: true });
    await writeFile(note, "---\nstatus: open\n---\nx x\n");
    const refused = { decision: "deny", reason: formatDenyReason([{ field: "content", kind: "unsupported-input" }]), warning: null };
    expect(await decide(vault, payload("Edit", { file_path: note, old_string: "absent", new_string: "y" }))).toEqual(refused);
    expect(await decide(vault, payload("Edit", { file_path: note, old_string: "x", new_string: "y" }))).toEqual(refused);
  });

  it("denies an edit that does not apply when the contract is unreadable", async () => {
    const { vault } = await row("index-without-store");
    const note = join(vault, "a.md");
    await writeFile(note, GOOD);
    expect((await decide(vault, payload("Edit", { file_path: note, old_string: "absent", new_string: "y" }))).decision).toBe("deny");
  });

  it("allows with a warning an edit that does not apply in an open vault", async () => {
    const { vault } = await row("never-sealed");
    const note = join(vault, "a.md");
    await writeFile(note, "x x\n");
    const none = await decide(vault, payload("Edit", { file_path: note, old_string: "absent", new_string: "y" }));
    expect(none.decision).toBe("allow");
    expect(none.warning).toMatch(/^\[oms\] /);
    const twice = await decide(vault, payload("Edit", { file_path: note, old_string: "x", new_string: "y" }));
    expect(twice.decision).toBe("allow");
    expect(twice.warning).toMatch(/^\[oms\] /);
  });

  it("applies replace_all to every match", async () => {
    const { vault } = await row("sealed");
    const note = join(vault, "Projects/a.md");
    await mkdir(join(vault, "Projects"), { recursive: true });
    await writeFile(note, "---\nstatus: open\n---\nopen\n");
    expect((await decide(vault, payload("Edit", { file_path: note, old_string: "open", new_string: "maybe", replace_all: true }))).decision).toBe("deny");
    expect((await decide(vault, payload("Edit", { file_path: note, old_string: "open", new_string: "done", replace_all: true }))).decision).toBe("allow");
  });

  it("applies MultiEdit edits in sequence", async () => {
    const { vault } = await row("sealed");
    const note = join(vault, "Projects/a.md");
    await mkdir(join(vault, "Projects"), { recursive: true });
    await writeFile(note, GOOD);
    const edits = [{ old_string: "status: open", new_string: "status: done" }, { old_string: "status: done", new_string: "status: maybe" }];
    expect((await decide(vault, payload("MultiEdit", { file_path: note, edits })))).toMatchObject({ decision: "deny" });
    expect((await decide(vault, payload("MultiEdit", { file_path: note, edits: edits.slice(0, 1) })))).toMatchObject({ decision: "allow" });
  });

  it("accepts lowercase tool names", async () => {
    const { vault } = await row("sealed");
    expect((await decide(vault, payload("write", { file_path: join(vault, "Projects/a.md"), content: BAD }))).decision).toBe("deny");
    expect((await decide(vault, payload("multiedit", { file_path: join(vault, "Projects/n.md"), edits: [{ old_string: "", new_string: BAD }] }))).decision).toBe("deny");
  });

  it("resolves a relative target against the payload cwd", async () => {
    const { vault } = await row("sealed");
    expect((await decide(vault, payload("Write", { file_path: "Projects/a.md", content: BAD }, vault))).decision).toBe("deny");
  });

  it("reads camelCase toolInput when tool_input is absent", async () => {
    const { vault } = await row("sealed");
    const raw = JSON.stringify({ toolName: "Write", toolInput: { file_path: join(vault, "Projects/a.md"), content: BAD } });
    expect(await decide(vault, raw)).toEqual({ decision: "deny", reason: formatDenyReason([{ field: "status", kind: "not-allowed" }]), warning: null });
  });

  it("expands ~ against HOME and denies ~user targets", async () => {
    const { vault } = await row("sealed");
    expect(await decide(vault, payload("Write", { file_path: "~/../vault/Projects/a.md", content: BAD }, "/")))
      .toEqual({ decision: "deny", reason: formatDenyReason([{ field: "status", kind: "not-allowed" }]), warning: null });
    expect((await decide(vault, payload("Write", { file_path: "~/../vault/Projects/a.md", content: GOOD }, "/"))).decision).toBe("allow");
    expect(await decide(vault, payload("Write", { file_path: "~other/vault/Projects/a.md", content: GOOD })))
      .toEqual({ decision: "deny", reason: formatDenyReason([{ field: "path", kind: "path-unsafe" }]), warning: null });
  });
});

describe("translatePreToolUse path rules", () => {
  it("applies path rules only to NotebookEdit and non-markdown targets", async () => {
    const { vault } = await row("sealed");
    expect((await decide(vault, payload("NotebookEdit", { notebook_path: join(vault, "Projects/a.ipynb"), new_source: "x" }))).decision).toBe("allow");
    expect((await decide(vault, payload("Write", { file_path: join(vault, "Projects/a.txt"), content: BAD }))).decision).toBe("allow");
    expect(await decide(vault, payload("NotebookEdit", { notebook_path: join(vault, ".oms/x.ipynb"), new_source: "x" })))
      .toEqual({ decision: "deny", reason: formatDenyReason([{ field: "path", kind: "control-path" }]), warning: null });
  });

  it("denies control paths in an open vault", async () => {
    const { vault } = await row("never-sealed");
    expect(await decide(vault, payload("Write", { file_path: join(vault, ".oms/settings.json"), content: "{}" })))
      .toEqual({ decision: "deny", reason: formatDenyReason([{ field: "path", kind: "control-path" }]), warning: null });
  });

  it("allows targets outside the vault and tools that do not write", async () => {
    const { vault, base } = await row("sealed");
    expect((await decide(vault, payload("Write", { file_path: join(base, "elsewhere.md"), content: BAD }))).decision).toBe("allow");
    expect((await decide(vault, payload("Read", { file_path: join(vault, "Projects/a.md") })))).toEqual({ decision: "allow", reason: null, warning: null });
  });

  it("fails closed on an unreadable target only when a contract is sealed", async () => {
    const sealedRow = await row("sealed");
    const note = join(sealedRow.vault, "Projects/a.md");
    await mkdir(join(sealedRow.vault, "Projects"), { recursive: true });
    await writeFile(note, GOOD);
    await chmod(note, 0o000);
    try {
      expect(await decide(sealedRow.vault, payload("Write", { file_path: note, content: GOOD })))
        .toEqual({ decision: "deny", reason: formatDenyReason([{ field: "contract", kind: "contract-unreadable" }]), warning: null });
    } finally {
      await chmod(note, 0o644);
    }
    const openRow = await row("never-sealed");
    const openNote = join(openRow.vault, "a.md");
    await writeFile(openNote, GOOD);
    await chmod(openNote, 0o000);
    try {
      expect((await decide(openRow.vault, payload("Write", { file_path: openNote, content: BAD }))).decision).toBe("allow");
    } finally {
      await chmod(openNote, 0o644);
    }
  });

  it("denies unparseable input", async () => {
    const { vault } = await row("sealed");
    expect(await decide(vault, "{not json"))
      .toEqual({ decision: "deny", reason: formatDenyReason([{ field: "input", kind: "unsupported-input" }]), warning: null });
  });

  it("denies a truncated payload even when the prefix parses", async () => {
    const { vault } = await row("never-sealed");
    const result = await translatePreToolUse(payload("Write", { file_path: join(vault, "a.md"), content: GOOD }), vault, { truncated: true });
    expect(result.response).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: formatDenyReason([{ field: "input", kind: "unsupported-input" }]) } });
  });
});

describe("runPreToolUse output", () => {
  it("prints the deny shape with no continue key", async () => {
    const { vault } = await row("sealed");
    stdin.value = payload("Write", { file_path: join(vault, "Projects/a.md"), content: BAD });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runPreToolUse({ vault });
    const printed = JSON.parse(String(out.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(printed).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: formatDenyReason([{ field: "status", kind: "not-allowed" }]) } });
    expect(Object.hasOwn(printed, "continue")).toBe(false);
  });

  it("denies when stdin was cut off at the size cap", async () => {
    const { vault } = await row("never-sealed");
    stdin.value = payload("Write", { file_path: join(vault, "a.md"), content: GOOD });
    stdin.truncated = true;
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runPreToolUse({ vault });
    expect(String(out.mock.calls[0]?.[0])).toContain('"permissionDecision":"deny"');
  });

  it("prints exactly the allow shape for an empty payload", async () => {
    const { vault } = await row("sealed");
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runPreToolUse({ vault });
    expect(out.mock.calls.map(call => call[0])).toEqual([ALLOW]);
    expect(err).not.toHaveBeenCalled();
  });

  it("ignores the retired guard environment switch", async () => {
    const { vault } = await row("sealed");
    vi.stubEnv(["OMS", "GUARD"].join("_"), "0");
    stdin.value = payload("Write", { file_path: join(vault, "Projects/a.md"), content: BAD });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runPreToolUse({ vault });
    expect(String(out.mock.calls[0]?.[0])).toContain('"permissionDecision":"deny"');
  });
});

describe("deny reasons", () => {
  it("name only guidance from the allowed set and carry field/kind only", () => {
    expect(Object.keys(GUIDANCE_FOR).sort()).toEqual([...VIOLATION_KINDS].sort());
    for (const kind of VIOLATION_KINDS) {
      const reason = formatDenyReason([{ field: "status", kind }]);
      expect(reason).toBe(`[oms] write denied: ${JSON.stringify([{ field: "status", kind }])} Run: ${GUIDANCE_FOR[kind]}`);
      expect(GUIDANCE).toContain(GUIDANCE_FOR[kind]);
    }
  });
});
