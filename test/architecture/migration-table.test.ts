import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REMOVED_0_19_FAMILIES, removedFamilyMessage } from "../../src/cli/removed-families.js";
import { omsMcpTools } from "../../src/mcp/server.js";
import { absolute } from "./repo-root.js";

/**
 * The 0.19 migration table is a promise to every upgrading user: each 0.18
 * spelling in the left column now fails with guidance, and each 0.19 spelling
 * in the right columns reaches a real handler. Prose cannot be trusted to stay
 * true, so every row is dispatched against the built CLI and the live MCP tool
 * schemas. A row whose spelling is not dispatch-checked fails this gate.
 */

const MIGRATION_DOC = "docs/migration-0.19.md";
const distCli = absolute("dist/cli/oms.js");

/**
 * Each 0.19 CLI spelling, probed with a flag no handler accepts. The owning
 * handler rejects it with its own marker before doing any work, which proves
 * the spelling is routed there without running the command.
 */
const PROBE_FLAG = "--oms-migration-probe";
const CLI_PROBES: Readonly<Record<string, { readonly argv: readonly string[]; readonly marker: string }>> = {
  "search": { argv: ["search", "text"], marker: "unknown query flag" },
  "search --path": { argv: ["search", "--path", "note.md"], marker: "--path is mutually exclusive" },
  "search --context": { argv: ["search", "--context"], marker: "unknown context flag" },
  "search --link": { argv: ["search", "--link", "note.md"], marker: "LINK_ARGS_INVALID" },
  "doctor status": { argv: ["doctor", "status"], marker: "STATUS_ARGS_INVALID" },
  "doctor contract": { argv: ["doctor", "contract"], marker: "CONTRACT_ARGS_INVALID" },
  "doctor audit": { argv: ["doctor", "audit"], marker: "NOTE_ARGS_INVALID" },
  "doctor link-check": { argv: ["doctor", "link-check"], marker: "LINK_ARGS_INVALID" },
  "doctor sync-embeddings --mode": { argv: ["doctor", "sync-embeddings", "--mode", "sync"], marker: "is not valid for index sync" },
  "doctor cleanup": { argv: ["doctor", "cleanup"], marker: "is not valid for index clean" },
  "doctor build-graph": { argv: ["doctor", "build-graph"], marker: "GRAPH_ARGS_INVALID" },
  "setup": { argv: ["setup"], marker: "CONTRACT_ARGS_INVALID" },
  "setup extract": { argv: ["setup", "extract"], marker: "CONTRACT_ARGS_INVALID" },
  "setup status": { argv: ["setup", "status"], marker: "CONTRACT_ARGS_INVALID" },
  "setup host": { argv: ["setup", "host", "status"], marker: "HOST_ARGS_INVALID" },
  "setup model": { argv: ["setup", "model", "status"], marker: "MODEL_ARGS_INVALID" },
  "setup package": { argv: ["setup", "package", "check"], marker: "Unsupported package option" },
  "setup bridge": { argv: ["setup", "bridge", "status"], marker: "LINK_ARGS_INVALID" },
  "interview": { argv: ["interview"], marker: "interview: unknown argument" },
  "write": { argv: ["write", "note.md"], marker: "unknown write option" },
};

interface MigrationRow {
  readonly before: readonly string[];
  readonly cli: readonly string[];
  readonly mcp: string;
}

function backticked(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);
}

async function migrationRows(): Promise<MigrationRow[]> {
  const doc = await readFile(absolute(MIGRATION_DOC), "utf8");
  const section = doc.split("## Command map")[1]?.split("\n## ")[0] ?? "";
  const rows = section.split("\n")
    .filter((line) => line.startsWith("|") && !line.startsWith("|---") && !line.startsWith("| 0.18"))
    // `sync|embed|repair` inside a code span is not a column separator.
    .map((line) => line.replace(/`[^`]*`/gu, (span) => span.replaceAll("|", "\u0000")))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.replaceAll("\u0000", "|").trim()));
  return rows.map(([before = "", cli = "", mcp = ""]) => ({ before: backticked(before), cli: backticked(cli), mcp }));
}

/** `oms doctor sync-embeddings --mode sync|embed|repair` becomes `doctor sync-embeddings --mode`. */
function spellingKey(spelling: string): string {
  const tokens = spelling.split(/\s+/u).slice(1);
  const kept: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("<") || token.startsWith("[") || token.startsWith("(") || token.includes("|") || token === "...") break;
    kept.push(token);
  }
  return kept.join(" ");
}

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("OMS_") || key.startsWith("XDG_") || key === "HOME" || key === "USERPROFILE") continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    OMS_NON_INTERACTIVE: "1",
    OMS_UPDATE_NOTICE: "0",
    OMS_NO_UPDATE_NOTICE: "1",
  };
}

let home = "";
let cwd = "";
const realOmsDir = path.join(homedir(), ".oms");
let realOmsBefore: string | null = null;

/** Path, size and mtime of every entry, so any write under the real `~/.oms` shows. */
function snapshotDir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const entries: string[] = [];
  const walk = (current: string, rel: string): void => {
    for (const name of readdirSync(current).sort()) {
      const child = path.join(current, name);
      const relChild = rel === "" ? name : `${rel}/${name}`;
      const st = statSync(child);
      entries.push(st.isDirectory() ? `${relChild}/` : `${relChild}:${st.size}:${st.mtimeMs}`);
      if (st.isDirectory()) walk(child, relChild);
    }
  };
  walk(dir, "");
  return entries.join("\n");
}

function runCli(argv: readonly string[]) {
  if (!existsSync(distCli)) throw new Error("dist/cli/oms.js is missing; run npm run build before the migration-table gate.");
  return spawnSync(process.execPath, [distCli, ...argv], { cwd, env: isolatedEnv(home), input: "", encoding: "utf8" });
}

beforeAll(async () => {
  realOmsBefore = snapshotDir(realOmsDir);
  home = await realpath(await mkdtemp(path.join(tmpdir(), "oms-migration-home-")));
  cwd = await realpath(await mkdtemp(path.join(tmpdir(), "oms-migration-cwd-")));
});

afterAll(async () => {
  expect(snapshotDir(realOmsDir)).toBe(realOmsBefore);
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe("0.19 migration table", () => {
  it("has a row for every removed 0.19 family", async () => {
    const rows = await migrationRows();
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const families = new Set(rows.flatMap((row) => row.before).map((spelling) => spellingKey(spelling).split(" ")[0]));
    for (const family of REMOVED_0_19_FAMILIES) expect(families, `${family} has no migration row`).toContain(family);
  });

  it("prints the exact removal message the guide quotes", async () => {
    const doc = await readFile(absolute(MIGRATION_DOC), "utf8");
    const quoted = /```text\n(\[oms\][^\n]+)\n```/u.exec(doc)?.[1];
    const family = /Command `([a-z-]+)`/u.exec(quoted ?? "")?.[1] ?? "";
    expect(quoted).toBe(removedFamilyMessage(family));
  });

  it("rejects every 0.18 spelling with its migration and runs nothing", async () => {
    const keys = new Set((await migrationRows())
      .flatMap((row) => row.before)
      .filter((spelling) => spelling.startsWith("oms "))
      .map(spellingKey));
    expect(keys.size).toBeGreaterThan(0);
    for (const key of keys) {
      const [family = ""] = key.split(" ");
      const result = runCli(key.split(" "));
      expect(result.status, key).toBe(1);
      expect(result.stdout, key).toBe("");
      if (REMOVED_0_19_FAMILIES.includes(family)) {
        expect(result.stderr.trim(), key).toBe(removedFamilyMessage(family));
      } else {
        // A surviving family refuses its removed 0.18 leaf by name instead.
        expect(result.stderr, key).toContain(`\`${key}\` was removed in 0.19`);
      }
    }
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("dispatches every 0.19 CLI spelling to its owning handler", async () => {
    const spellings = (await migrationRows()).flatMap((row) => row.cli).filter((spelling) => spelling.startsWith("oms "));
    const keys = [...new Set(spellings.map(spellingKey))];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const probe = CLI_PROBES[key];
      expect(probe, `migration spelling \`oms ${key}\` has no dispatch probe`).toBeDefined();
      const result = runCli([...probe!.argv, PROBE_FLAG]);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, key).toBe(1);
      expect(output, key).toContain(probe!.marker);
      expect(output, key).not.toMatch(/Unknown command|Unknown doctor leaf|was removed in 0\.19|is retired/u);
    }
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("names only MCP tools and operations the server advertises", async () => {
    const tools = new Map(omsMcpTools.map((tool) => [tool.name, tool]));
    const rows = await migrationRows();
    let checked = 0;
    for (const row of rows) {
      if (row.mcp === "none") continue;
      // "`search` with `op: link`, `doctor` with `op: link-check`" names two tools.
      for (const clause of row.mcp.split(/,\s*(?=`)/u)) {
        const [toolName = "", ...rest] = backticked(clause);
        const tool = tools.get(toolName);
        expect(tool, `${clause} names an unknown tool`).toBeDefined();
        const schema = tool!.inputSchema as { properties?: Record<string, { enum?: readonly string[] }> };
        const ops = schema.properties?.["op"]?.enum ?? [];
        const fields = rest.filter((span) => !span.startsWith("op: "));
        const named = rest.filter((span) => span.startsWith("op: ")).map((span) => span.slice(4));
        // "`doctor` ops unchanged": each doctor leaf in the CLI column is an op of the same name.
        if (/ops unchanged/u.test(clause)) {
          named.push(...row.cli.map(spellingKey).map((key) => key.split(" ")[1]!));
        }
        for (const name of named) expect(ops, `${toolName} has no op \`${name}\``).toContain(name);
        for (const field of fields) expect(Object.keys(schema.properties ?? {}), `${toolName} has no field \`${field}\``).toContain(field);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
