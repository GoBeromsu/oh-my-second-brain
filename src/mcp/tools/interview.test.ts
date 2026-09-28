import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTruthTableRow, type TruthTableFixture } from "../../../test/fixtures/contract-truth-table.js";
import { omsMcpTools } from "../server.js";
import { handleInterview } from "./interview.js";
import type { ToolContext } from "./shared.js";

const fixtures: TruthTableFixture[] = [];
const scratch: string[] = [];
let savedEnv: Record<string, string | undefined>;

/** Every entry with its content digest (or link target), so any write shows. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isSymbolicLink()) out.set(rel, `<link>${await readlink(full)}`);
      else if (entry.isDirectory()) {
        out.set(`${rel}/`, "<dir>");
        await walk(full);
      } else out.set(rel, createHash("sha256").update(await readFile(full)).digest("hex"));
    }
  };
  await walk(root);
  return out;
}

/** handleInterview reads only the verified vault from its context. */
function context(vault: string): ToolContext {
  return { vault, source: "explicit" } as unknown as ToolContext;
}

function payload(result: Awaited<ReturnType<typeof handleInterview>>): Record<string, unknown> {
  const first = result.content[0];
  return JSON.parse(first?.type === "text" ? first.text : "{}") as Record<string, unknown>;
}

function useHome(home: string): void {
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
}

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OMS_") || key.startsWith("XDG_")) delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("MCP interview", () => {
  it("lists questions for an unsealed vault and seals nothing", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "oms-mcp-interview-")));
    scratch.push(base);
    const vault = path.join(base, "vault");
    const home = path.join(base, "home");
    await mkdir(path.join(vault, "Projects"), { recursive: true });
    await mkdir(home);
    useHome(home);
    const before = await snapshot(base);

    const result = await handleInterview(context(vault), {});
    const body = payload(result);
    expect(result.isError).not.toBe(true);
    expect(body["status"]).toBe("questions");
    expect(Array.isArray(body["questions"]) && body["questions"].length).toBeGreaterThan(0);
    expect(String(body["next"])).toContain("This tool seals nothing");
    expect(await snapshot(base)).toEqual(before);
  });

  it("leaves a sealed contract and its store unchanged, with or without reask", async () => {
    const fixture = await buildTruthTableRow("sealed");
    fixtures.push(fixture);
    useHome(path.join(fixture.base, "home"));
    const before = await snapshot(fixture.base);

    for (const args of [{}, { reask: true }]) {
      const body = payload(await handleInterview(context(fixture.vault), args));
      expect(body["contract"]).toMatchObject({ contract: "sealed", row: "sealed" });
      expect(["questions", "refused"]).toContain(body["status"]);
    }
    expect(await snapshot(fixture.base)).toEqual(before);
  });

  it("accepts only an optional reask flag and has no seal operation", () => {
    const tool = omsMcpTools.find((candidate) => candidate.name === "interview");
    const validate = new AjvJsonSchemaValidator().getValidator(tool!.inputSchema);
    expect(validate({}).valid).toBe(true);
    expect(validate({ reask: true }).valid).toBe(true);
    expect(validate({ op: "seal" }).valid).toBe(false);
    expect(tool!.annotations?.readOnlyHint).not.toBe(true);
  });
});
