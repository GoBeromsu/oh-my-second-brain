import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTruthTableRow, TRUTH_TABLE_ROWS, type TruthTableFixture } from "../../../../test/fixtures/contract-truth-table.js";
import { openGaps, readGapLedger } from "../../../kernel/contract/gap-ledger.js";
import { formatDenyReason, formatWarnings, GUIDANCE, GUIDANCE_FOR, VIOLATION_KINDS, WARNING_PREFIX, type VaultContract } from "../../../kernel/contract/types.js";
import type { SealRow } from "../../../kernel/contract/vault-id.js";
import { readVaultSettings, serializeVaultSettings, SETTINGS_PATH } from "../../../kernel/vault/settings.js";
import { HOOK_MATCHER } from "../claude-hooks.js";

const stdin = vi.hoisted(() => ({ value: "{}", truncated: false }));
vi.mock("./stdin.js", () => ({ readStdinTimeout: async () => ({ text: stdin.value, truncated: stdin.truncated, timedOut: false }) }));
const liveTemplates = vi.hoisted(() => ({ loads: [] as string[] }));
vi.mock("../../../kernel/write/live-templates.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../../kernel/write/live-templates.js")>();
  return { ...original, loadLiveTemplates: async (vault: string) => { liveTemplates.loads.push(vault); return original.loadLiveTemplates(vault); } };
});

const { runPreToolUse, translatePreToolUse, WRITE_TOOLS } = await import("./pre-tool-use.js");
type HookResult = Awaited<ReturnType<typeof translatePreToolUse>>;
type PreToolUseDeps = import("./pre-tool-use.js").PreToolUseDeps;

const ALLOW = '{"continue":true,"suppressOutput":true}\n';

const CONTRACT: VaultContract = {
  folders: { Projects: { meaning: "project notes", searchExclude: false } },
  properties: { status: { meaning: "state", type: "text", default: false, required: true, rules: [{ kind: "allowed", values: ["open", "done"] }] } },
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
  "settings-missing": "unreadable",
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

type Decision = { decision: "allow" | "warn" | "deny"; reason: string | null; warning: string | null };

function decisionOf(result: HookResult): Decision {
  const response = result.response;
  if ("permissionDecision" in (("hookSpecificOutput" in response) ? response.hookSpecificOutput : {})) {
    const output = (response as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput;
    return { decision: "deny", reason: output.permissionDecisionReason, warning: result.warning };
  }
  if ("systemMessage" in response) return { decision: "warn", reason: response.systemMessage, warning: result.warning };
  return { decision: "allow", reason: null, warning: result.warning };
}

async function decide(vault: string, raw: string, overrides: Partial<PreToolUseDeps> = {}): Promise<Decision> {
  return decisionOf(await translatePreToolUse(raw, vault, { truncated: false }, overrides));
}

const GOOD = "---\nstatus: open\n---\nbody\n";
const BAD = "---\nstatus: maybe\n---\nbody\n";

beforeEach(() => {
  liveTemplates.loads.length = 0;
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

const OPEN = formatWarnings([{ field: "contract", kind: "contract-open" }]);
const BROKEN = formatWarnings([{ field: "contract", kind: "contract-unreadable" }]);
const TAMPERED = formatDenyReason([{ field: "contract", kind: "contract-tampered" }]);
const NOT_ALLOWED = formatWarnings([{ field: "status", kind: "not-allowed" }]);

describe("translatePreToolUse over the truth table", () => {
  for (const name of TRUTH_TABLE_ROWS) {
    it(`judges a Write in row ${name} by its view (${EXPECTED_VIEW[name]})`, async () => {
      const { vault } = await row(name);
      const good = await decide(vault, payload("Write", { file_path: join(vault, "Projects/a.md"), content: GOOD }));
      const bad = await decide(vault, payload("Write", { file_path: join(vault, "Projects/a.md"), content: BAD }));
      const view = EXPECTED_VIEW[name];
      if (view === "open") {
        expect(good).toEqual({ decision: "warn", reason: OPEN, warning: null });
        expect(bad).toEqual({ decision: "warn", reason: OPEN, warning: null });
      } else if (name === "vault-id-tampered") {
        expect(good).toEqual({ decision: "deny", reason: TAMPERED, warning: null });
        expect(bad).toEqual({ decision: "deny", reason: TAMPERED, warning: null });
      } else if (view === "unreadable") {
        expect(good).toEqual({ decision: "warn", reason: BROKEN, warning: null });
        expect(bad).toEqual({ decision: "warn", reason: BROKEN, warning: null });
        expect(good.reason).toContain("Run: oms interview");
      } else {
        expect(good).toEqual({ decision: "allow", reason: null, warning: null });
        expect(bad).toEqual({ decision: "warn", reason: NOT_ALLOWED, warning: null });
      }
    });
  }
});

describe("translatePreToolUse response shapes", () => {
  it("pins the warning shape: systemMessage plus additionalContext, no permissionDecision", async () => {
    const { vault } = await row("sealed");
    const result = await translatePreToolUse(payload("Write", { file_path: join(vault, "Projects/a.md"), content: BAD }), vault);
    expect(result.response).toEqual({ systemMessage: NOT_ALLOWED, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: NOT_ALLOWED } });
    expect(JSON.stringify(result.response)).not.toContain("permissionDecision");
    expect(NOT_ALLOWED.startsWith(WARNING_PREFIX)).toBe(true);
  });

  it("keeps the bare allow shape for a clean write", async () => {
    const { vault } = await row("sealed");
    const result = await translatePreToolUse(payload("Write", { file_path: join(vault, "Projects/a.md"), content: GOOD }), vault);
    expect(result).toEqual({ response: { continue: true, suppressOutput: true }, warning: null });
  });
});

describe("translatePreToolUse gap ledger", () => {
  it("records the warnings a write adds as kept gaps", async () => {
    const fixture = await row("sealed");
    const gapRoot = join(fixture.base, "gaps");
    const result = await decide(fixture.vault, payload("Write", { file_path: join(fixture.vault, "Projects/a.md"), content: BAD }), { gapRoot: () => gapRoot });
    expect(result.decision).toBe("warn");
    const ledger = await readGapLedger(gapRoot, fixture.vaultId);
    const gaps = openGaps(ledger.events);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.reason.startsWith("kept:")).toBe(true);
  });

  it("keeps a value the write pipeline would fix as a warning and leaves the tool input unchanged", async () => {
    const fixture = await row("sealed");
    const gapRoot = join(fixture.base, "gaps");
    const input = { file_path: join(fixture.vault, "Projects/a.md"), content: "---\nstatus: \" OPEN \"\n---\nbody\n" };
    const result = await translatePreToolUse(payload("Write", input), fixture.vault, { truncated: false }, { gapRoot: () => gapRoot });
    expect(result.response).toEqual({ systemMessage: NOT_ALLOWED, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: NOT_ALLOWED } });
    expect(JSON.stringify(result.response)).not.toContain("updatedInput");
    const gaps = openGaps((await readGapLedger(gapRoot, fixture.vaultId)).events);
    expect(gaps.map(gap => [gap.kind, gap.wanted, gap.reason])).toEqual([["kept", { field: "status", value: " OPEN " }, "kept: not-allowed"]]);
  });

  it("records the open template choice for a new note, as MCP write does, without changing the verdict", async () => {
    const fixture = await row("sealed");
    const gapRoot = join(fixture.base, "gaps");
    await mkdir(join(fixture.vault, "Templates"), { recursive: true });
    await writeFile(join(fixture.vault, "Templates", "Projects.md"), "## Goals\n");
    await writeFile(join(fixture.vault, "Templates", "meeting.md"), "---\nfolder: Projects\n---\n## Agenda\n");
    const settings = await readVaultSettings(fixture.vault);
    if (settings === null) throw new Error("the sealed fixture has no settings");
    await writeFile(join(fixture.vault, SETTINGS_PATH), serializeVaultSettings({ ...settings, templateFolder: "Templates" }));
    const result = await decide(fixture.vault, payload("Write", { file_path: join(fixture.vault, "Projects/a.md"), content: GOOD }), { gapRoot: () => gapRoot });
    expect(result).toEqual({ decision: "allow", reason: null, warning: null });
    const gaps = openGaps((await readGapLedger(gapRoot, fixture.vaultId)).events);
    expect(gaps.map(gap => gap.kind)).toEqual(["choice"]);
  });

  it("reads the live templates only for a new note, never for an edit of an existing one", async () => {
    const fixture = await row("sealed");
    const gapRoot = join(fixture.base, "gaps");
    await mkdir(join(fixture.vault, "Templates"), { recursive: true });
    await writeFile(join(fixture.vault, "Templates", "Projects.md"), "## Goals\n");
    await writeFile(join(fixture.vault, "Templates", "meeting.md"), "---\nfolder: Projects\n---\n## Agenda\n");
    const settings = await readVaultSettings(fixture.vault);
    if (settings === null) throw new Error("the sealed fixture has no settings");
    await writeFile(join(fixture.vault, SETTINGS_PATH), serializeVaultSettings({ ...settings, templateFolder: "Templates" }));
    await mkdir(join(fixture.vault, "Projects"), { recursive: true });
    await writeFile(join(fixture.vault, "Projects", "old.md"), GOOD);
    const edit = await decide(fixture.vault, payload("Write", { file_path: join(fixture.vault, "Projects/old.md"), content: GOOD }), { gapRoot: () => gapRoot });
    expect(edit).toEqual({ decision: "allow", reason: null, warning: null });
    expect(liveTemplates.loads).toEqual([]);
    await decide(fixture.vault, payload("Write", { file_path: join(fixture.vault, "Projects/new.md"), content: GOOD }), { gapRoot: () => gapRoot });
    expect(liveTemplates.loads).toHaveLength(1);
    expect(openGaps((await readGapLedger(gapRoot, fixture.vaultId)).events).map(gap => gap.kind)).toEqual(["choice"]);
  });

  it("warns with the whole verdict but records nothing when an edit adds no finding over the note on disk", async () => {
    const fixture = await row("sealed");
    const gapRoot = join(fixture.base, "gaps");
    const note = join(fixture.vault, "Projects/a.md");
    await mkdir(join(fixture.vault, "Projects"), { recursive: true });
    await writeFile(note, BAD);
    const result = await decide(fixture.vault, payload("Edit", { file_path: note, old_string: "body", new_string: "text" }), { gapRoot: () => gapRoot });
    expect(result).toEqual({ decision: "warn", reason: NOT_ALLOWED, warning: null });
    expect(openGaps((await readGapLedger(gapRoot, fixture.vaultId)).events)).toEqual([]);
  });

  it("records nothing for an open vault", async () => {
    const fixture = await row("never-sealed");
    const gapRoot = join(fixture.base, "gaps");
    expect((await decide(fixture.vault, payload("Write", { file_path: join(fixture.vault, "a.md"), content: BAD }), { gapRoot: () => gapRoot })).decision).toBe("warn");
    expect(openGaps((await readGapLedger(gapRoot, fixture.vaultId)).events)).toEqual([]);
  });

  it("still warns when the ledger cannot be written", async () => {
    const fixture = await row("sealed");
    const blocked = join(fixture.base, "not-a-dir");
    await writeFile(blocked, "x");
    const result = await decide(fixture.vault, payload("Write", { file_path: join(fixture.vault, "Projects/a.md"), content: BAD }), {
      gapRoot: () => blocked,
      gapLedger: { newId: () => { throw new Error("ledger down"); } },
    });
    expect(result).toEqual({ decision: "warn", reason: NOT_ALLOWED, warning: null });
  });

  it("warns and records nothing when the seal state cannot be read", async () => {
    const fixture = await row("sealed");
    const gapRoot = join(fixture.base, "gaps");
    const result = await decide(fixture.vault, payload("Write", { file_path: join(fixture.vault, "Projects/a.md"), content: BAD }), {
      gapRoot: () => gapRoot,
      resolveSealState: async () => { throw new Error("seal unreadable"); },
    });
    expect(result).toEqual({ decision: "warn", reason: BROKEN, warning: null });
    expect(openGaps((await readGapLedger(gapRoot, fixture.vaultId)).events)).toEqual([]);
  });
});

describe("translatePreToolUse content reconstruction", () => {
  it("judges an Edit on the note the edit leaves behind", async () => {
    const { vault } = await row("sealed");
    const note = join(vault, "Projects/a.md");
    await mkdir(join(vault, "Projects"), { recursive: true });
    await writeFile(note, GOOD);
    expect((await decide(vault, payload("Edit", { file_path: note, old_string: "status: open", new_string: "status: done" }))).decision).toBe("allow");
    expect(await decide(vault, payload("Edit", { file_path: note, old_string: "status: open", new_string: "status: maybe" })))
      .toEqual({ decision: "warn", reason: NOT_ALLOWED, warning: null });
  });

  it("warns on an edit that matches nothing or matches twice without replace_all in a sealed vault", async () => {
    const { vault } = await row("sealed");
    const note = join(vault, "Projects/a.md");
    await mkdir(join(vault, "Projects"), { recursive: true });
    await writeFile(note, "---\nstatus: open\n---\nx x\n");
    const notJudged = formatWarnings([{ field: "content", kind: "unsupported-input" }]);
    for (const edit of [{ old_string: "absent", new_string: "y" }, { old_string: "x", new_string: "y" }]) {
      expect(await decide(vault, payload("Edit", { file_path: note, ...edit })))
        .toEqual({ decision: "warn", reason: notJudged, warning: null });
    }
  });

  it("warns on an edit that does not apply when the contract is broken", async () => {
    const { vault } = await row("index-without-store");
    const note = join(vault, "a.md");
    await writeFile(note, GOOD);
    expect(await decide(vault, payload("Edit", { file_path: note, old_string: "absent", new_string: "y" }))).toEqual({
      decision: "warn",
      reason: formatWarnings([{ field: "contract", kind: "contract-unreadable" }, { field: "content", kind: "unsupported-input" }]),
      warning: null,
    });
  });

  it("denies an edit that does not apply when the seal is tampered", async () => {
    const { vault } = await row("vault-id-tampered");
    const note = join(vault, "a.md");
    await writeFile(note, GOOD);
    expect(await decide(vault, payload("Edit", { file_path: note, old_string: "absent", new_string: "y" })))
      .toEqual({ decision: "deny", reason: TAMPERED, warning: null });
  });

  it("warns contract-open on an edit that does not apply in an open vault", async () => {
    const { vault } = await row("never-sealed");
    const note = join(vault, "a.md");
    await writeFile(note, "x x\n");
    const open = formatWarnings([{ field: "contract", kind: "contract-open" }]);
    const none = await decide(vault, payload("Edit", { file_path: note, old_string: "absent", new_string: "y" }));
    expect(none).toEqual({ decision: "warn", reason: open, warning: expect.stringMatching(/^\[oms\] /) });
    const twice = await decide(vault, payload("Edit", { file_path: note, old_string: "x", new_string: "y" }));
    expect(twice).toEqual({ decision: "warn", reason: open, warning: expect.stringMatching(/^\[oms\] /) });
  });

  it("applies replace_all to every match", async () => {
    const { vault } = await row("sealed");
    const note = join(vault, "Projects/a.md");
    await mkdir(join(vault, "Projects"), { recursive: true });
    await writeFile(note, "---\nstatus: open\n---\nopen\n");
    expect((await decide(vault, payload("Edit", { file_path: note, old_string: "open", new_string: "maybe", replace_all: true }))).decision).toBe("warn");
    expect((await decide(vault, payload("Edit", { file_path: note, old_string: "open", new_string: "done", replace_all: true }))).decision).toBe("allow");
  });

  it("applies MultiEdit edits in sequence", async () => {
    const { vault } = await row("sealed");
    const note = join(vault, "Projects/a.md");
    await mkdir(join(vault, "Projects"), { recursive: true });
    await writeFile(note, GOOD);
    const edits = [{ old_string: "status: open", new_string: "status: done" }, { old_string: "status: done", new_string: "status: maybe" }];
    expect((await decide(vault, payload("MultiEdit", { file_path: note, edits })))).toMatchObject({ decision: "warn" });
    expect((await decide(vault, payload("MultiEdit", { file_path: note, edits: edits.slice(0, 1) })))).toMatchObject({ decision: "allow" });
  });

  it("accepts lowercase tool names", async () => {
    const { vault } = await row("sealed");
    expect((await decide(vault, payload("write", { file_path: join(vault, "Projects/a.md"), content: BAD }))).decision).toBe("warn");
    expect((await decide(vault, payload("multiedit", { file_path: join(vault, "Projects/n.md"), edits: [{ old_string: "", new_string: BAD }] }))).decision).toBe("warn");
  });

  it("resolves a relative target against the payload cwd", async () => {
    const { vault } = await row("sealed");
    expect((await decide(vault, payload("Write", { file_path: "Projects/a.md", content: BAD }, vault))).decision).toBe("warn");
  });

  it("reads camelCase toolInput when tool_input is absent", async () => {
    const { vault } = await row("sealed");
    const raw = JSON.stringify({ toolName: "Write", toolInput: { file_path: join(vault, "Projects/a.md"), content: BAD } });
    expect(await decide(vault, raw)).toEqual({ decision: "warn", reason: NOT_ALLOWED, warning: null });
  });

  it("expands ~ against HOME and denies ~user targets", async () => {
    const { vault } = await row("sealed");
    expect(await decide(vault, payload("Write", { file_path: "~/../vault/Projects/a.md", content: BAD }, "/")))
      .toEqual({ decision: "warn", reason: NOT_ALLOWED, warning: null });
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

  it("judges a Write over an unreadable existing file as new and warns that it could not be read", async () => {
    const sealedRow = await row("sealed");
    const note = join(sealedRow.vault, "Projects/a.md");
    await mkdir(join(sealedRow.vault, "Projects"), { recursive: true });
    await writeFile(note, GOOD);
    await chmod(note, 0o000);
    try {
      expect(await decide(sealedRow.vault, payload("Write", { file_path: note, content: GOOD })))
        .toEqual({ decision: "warn", reason: formatWarnings([{ field: "content", kind: "contract-unreadable" }]), warning: null });
      expect(await decide(sealedRow.vault, payload("Edit", { file_path: note, old_string: "open", new_string: "done" })))
        .toEqual({ decision: "warn", reason: formatWarnings([{ field: "content", kind: "contract-unreadable" }]), warning: null });
    } finally {
      await chmod(note, 0o644);
    }
    const openRow = await row("never-sealed");
    const openNote = join(openRow.vault, "a.md");
    await writeFile(openNote, GOOD);
    await chmod(openNote, 0o000);
    try {
      expect((await decide(openRow.vault, payload("Write", { file_path: openNote, content: BAD }))).decision).toBe("warn");
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
    stdin.value = payload("Write", { file_path: join(vault, ".oms/settings.json"), content: "{}" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runPreToolUse({ vault });
    const printed = JSON.parse(String(out.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(printed).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: formatDenyReason([{ field: "path", kind: "control-path" }]) } });
    expect(Object.hasOwn(printed, "continue")).toBe(false);
  });

  it("prints the warning shape with no permissionDecision", async () => {
    const { vault } = await row("sealed");
    stdin.value = payload("Write", { file_path: join(vault, "Projects/a.md"), content: BAD });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runPreToolUse({ vault });
    expect(out.mock.calls.map(call => call[0])).toEqual([
      `${JSON.stringify({ systemMessage: NOT_ALLOWED, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: NOT_ALLOWED } })}\n`,
    ]);
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
    expect(String(out.mock.calls[0]?.[0])).toContain('"systemMessage"');
  });
});

describe("write tool set", () => {
  it("matches the Claude hook matcher", () => {
    expect([...WRITE_TOOLS].sort()).toEqual(HOOK_MATCHER.toLowerCase().split("|").sort());
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
