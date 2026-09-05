import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { absolute, assertNonVacuous, collectFiles } from "./repo-root.js";

/**
 * Bilingual README fact parity.
 *
 * `README.md` and `README.ko.md` both ship in the npm tarball, so a stale
 * translation is a user-facing defect rather than an internal inconsistency. The
 * Korean file drifted three separate ways in one release cycle:
 *
 *   1. it told readers to set `OMS_MODEL_PATH`, a name nothing reads;
 *   2. it advertised eleven retired detail operations as the MCP surface;
 *   3. it credited one retired top-level alias with another alias's job.
 *
 * Each was found by hand, after shipping. Nothing read `README.ko.md`, so
 * nothing could have caught them.
 *
 * This gate compares **identifiers, never prose**. Wording, tone, and sentence
 * structure are a translator's business; the set of commands, the set of MCP
 * tools, and the set of environment variables are facts about the product and
 * must agree. All three historical defects were disagreements of exactly that
 * kind, which is the evidence that this is the right seam to hold.
 *
 * Where an authoritative source exists in code, both files are checked against
 * it rather than against each other — two files can drift together, and mutual
 * agreement would then certify a shared error.
 */

const EN = "README.md";
const KO = "README.ko.md";
const MCP_SERVER = "src/mcp/server.ts";

/** Section boundaries differ per language, so each is sliced by its own heading. */
const SECTIONS = {
  cli: { [EN]: "## CLI", [KO]: "## CLI" },
  mcp: { [EN]: "## MCP tools", [KO]: "## MCP 도구" },
} as const;

async function read(relativePath: string): Promise<string> {
  return readFile(absolute(relativePath), "utf8");
}

/**
 * Return the body of the `## ` section that starts with `heading`, up to the
 * next `## ` heading. Throws when the heading is absent: a renamed section must
 * fail loudly rather than silently reduce this gate to comparing empty sets.
 */
function section(source: string, heading: string, file: string): string {
  const start = source.indexOf(`\n${heading}`);
  if (start === -1) throw new Error(`${file} has no "${heading}" section; update readme-parity.test.ts`);
  const bodyStart = start + 1 + heading.length;
  const next = source.indexOf("\n## ", bodyStart);
  return source.slice(bodyStart, next === -1 ? source.length : next);
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function matches(text: string, pattern: RegExp): string[] {
  return sorted(text.match(pattern) ?? []);
}

/** `oms <command>` entries listed at the start of a line in the CLI block. */
function cliCommands(text: string): string[] {
  return matches(text, /^oms [a-z-]+/gmu);
}

/** Canonical command-family surfaces before the aligned prose description. */
function cliSurfaces(text: string): string[] {
  return sorted(
    text
      .split("\n")
      .filter((line) => line.startsWith("oms "))
      .map((line) => line.split(/\s{2,}/u, 1)[0] ?? ""),
  );
}

/** Capability-only MCP tool identifiers listed in the MCP surface line. */
function toolNames(text: string): string[] {
  const surfaceLine = text.split("\n").find((line) => line.includes("·"));
  return surfaceLine === undefined
    ? []
    : matches(surfaceLine, /`([a-z][a-z-]*)`/gu).map((entry) => entry.slice(1, -1));
}

/** `OMS_*` environment variable identifiers. */
function envVars(text: string): string[] {
  return matches(text, /OMS_[A-Z0-9_]+/gu);
}

/** The tool names the MCP server actually advertises from `omsMcpTools`. */
function advertisedTools(serverSource: string): string[] {
  const start = serverSource.indexOf("export const omsMcpTools");
  if (start === -1) throw new Error(`${MCP_SERVER} no longer declares omsMcpTools; update readme-parity.test.ts`);
  const end = serverSource.indexOf("\n];", start);
  if (end === -1) throw new Error(`${MCP_SERVER} omsMcpTools array is unterminated`);
  return matches(serverSource.slice(start, end), /name: "([a-z_]+)"/gu).map((entry) =>
    entry.replace(/^name: "|"$/gu, ""),
  );
}

const CLI_FAMILIES = [
  "oms bridge",
  "oms graph",
  "oms hook",
  "oms host",
  "oms index",
  "oms link",
  "oms model",
  "oms note",
  "oms package",
  "oms search",
  "oms serve",
  "oms setup",
  "oms status",
  "oms template",
] as const;

const MCP_TOOLS = ["doctor", "link", "search", "status", "write"] as const;

const CLI_SURFACES = [
  "oms bridge add|remove|status",
  "oms graph build|status",
  "oms hook pre|post",
  "oms host install|remove|sync|status",
  "oms index sync|embed|repair|status|clean",
  "oms link check|suggest|apply",
  "oms model install|select|waive|status",
  "oms note create|append|update|audit|backfill|get",
  "oms package check|update",
  "oms search query|context",
  "oms serve mcp|http",
  "oms setup",
  "oms status",
  "oms template scan|list|show|add|update|move|remove|default|check|regenerate-types",
] as const;

const CURRENT_CLI_SURFACES = [
  "oms search query",
  "oms search context",
  "oms index sync|embed|repair|status|clean",
  "oms index status --view status|collections|contexts",
  "oms note create|append|update|audit|backfill|get",
  "oms host install|remove|sync|status",
  "oms package check|update",
  "oms serve mcp|http",
] as const;

const RETIRED_TOP_LEVEL =
  /\boms (?:doctor|audit|reconcile|linkify|embed|doc|mcp|lint|install|uninstall|update)\b/gu;

describe("README.md and README.ko.md agree on product facts", () => {
  it("advertises the same MCP tools both languages, matching the server", async () => {
    // Checked against the server rather than language-to-language: the Korean
    // file once listed eleven retired detail operations, and comparing it only
    // with English would have caught that, but comparing both with the source
    // also catches the case where both files drift together.
    const [en, ko, server] = await Promise.all([read(EN), read(KO), read(MCP_SERVER)]);
    const advertised = advertisedTools(server);

    assertNonVacuous(advertised, `${MCP_SERVER} omsMcpTools entries`);
    expect(advertised).toEqual(MCP_TOOLS);
    expect(toolNames(section(en, SECTIONS.mcp[EN], EN))).toEqual(advertised);
    expect(toolNames(section(ko, SECTIONS.mcp[KO], KO))).toEqual(advertised);
  });

  it("lists the complete current CLI families and synchronized canonical surfaces", async () => {
    const [en, ko] = await Promise.all([read(EN), read(KO)]);
    for (const [file, source] of [[EN, en], [KO, ko]] as const) {
      const cli = section(source, SECTIONS.cli[file], file);
      expect(cliCommands(cli)).toEqual(CLI_FAMILIES);
      expect(cliSurfaces(cli)).toEqual(CLI_SURFACES);
      for (const surface of CURRENT_CLI_SURFACES) {
        expect(cli, `${file} omits current surface ${surface}`).toContain(surface);
      }
      expect(matches(source, RETIRED_TOP_LEVEL), `${file} contains retired top-level guidance`).toEqual([]);
    }
  });

  it("never instructs readers to set an environment variable nothing reads", async () => {
    // The Korean file documented `OMS_MODEL_PATH` for two releases. Following
    // it produced no embeddings and no explanation.
    //
    // Shell scripts are included deliberately: an earlier sweep that scanned
    // only .ts/.mjs reported three false positives, because `OMS_PACKAGE_SPEC`,
    // `OMS_INSTALL_RUNTIME`, and `OMS_EXECUTE_EXTERNAL` are read by the shipped
    // install scripts. A gate that cannot see every reader would condemn
    // correct documentation.
    const sources = [
      ...(await collectFiles("src", (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))),
      ...(await collectFiles("scripts", (file) => /\.(mjs|js|sh)$/u.test(file))),
    ];
    assertNonVacuous(sources, "source files that could read an OMS_ environment variable");

    const read_ = await Promise.all(sources.map((file) => readFile(absolute(file), "utf8")));
    const known = new Set(read_.flatMap((source) => envVars(source)));

    const [en, ko] = await Promise.all([read(EN), read(KO)]);
    for (const [file, source] of [[EN, en], [KO, ko]] as const) {
      const documented = envVars(source);
      assertNonVacuous(documented, `${file} environment variables`);
      const dead = documented.filter((name) => !known.has(name));
      expect(
        dead,
        `${file} documents environment variable(s) no source file reads: ${dead.join(", ")}. ` +
          "Either the name is stale and should be corrected, or its reader was deleted.",
      ).toEqual([]);
    }
  });
});
