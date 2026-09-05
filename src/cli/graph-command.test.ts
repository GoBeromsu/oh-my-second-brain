import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sourceSignature } from "../kernel/templates/index.js";
import type { SourceDescriptor } from "../kernel/templates/types.js";
import { runGraphCommand } from "./graph-command.js";
import { runStatusCommand } from "./status-command.js";

const roots: string[] = [];
const digest = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function freshVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-graph-command-"));
  roots.push(vault);
  await Promise.all([
    mkdir(path.join(vault, ".oms"), { recursive: true }),
    mkdir(path.join(vault, ".obsidian"), { recursive: true }),
    mkdir(path.join(vault, "Templates/OMS"), { recursive: true }),
    mkdir(path.join(vault, "notes"), { recursive: true }),
  ]);
  const policy = JSON.stringify({ version: 3, templateFolders: [{ path: "Templates/OMS", mode: "manual", default: true }], defaultTemplate: "note", base: { fields: {} }, contracts: { note: { intent: "note", fields: { template: { type: "text", required: true }, status: { type: "text" } }, views: [] } }, templates: { note: { templateId: "note", destinationClass: "managed-default", sourceFolder: "Templates/OMS", sourcePath: "Templates/OMS/note.md", renderer: "obsidian-core", contract: "note", naming: "{{slug}}.md" } } });
  const taxonomy = JSON.stringify({ folders: {}, templates: { note: { templateFolder: "Inbox" } } });
  const obsidianTypes = JSON.stringify({ types: { template: "text", status: "text" } });
  const template = "---\ntemplate: note\nstatus: active\n---\n<!-- oms:content -->\n";
  const sources: SourceDescriptor[] = [
    { logicalId: "template-policy", signature: digest(policy) },
    { logicalId: "taxonomy", signature: digest(taxonomy) },
    { logicalId: "obsidian-types", signature: digest(obsidianTypes) },
    { path: "Templates/OMS/note.md", signature: digest(template) },
  ];
  const projection = JSON.stringify({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sources }, managed: { base: { fields: {} }, globalAxes: {}, templates: { note: { templateId: "note", destinationClass: "managed-default", sourcePath: "Templates/OMS/note.md", renderer: "obsidian-core", targetFolder: "Inbox", keyOrder: ["template", "status"], fields: { template: { type: "text", required: true }, status: { type: "text" } }, views: [], naming: "{{slug}}.md", bodySignature: digest("<!-- oms:content -->\n") } } } });
  await Promise.all([
    writeFile(path.join(vault, ".oms/template-policy.json"), policy),
    writeFile(path.join(vault, ".oms/taxonomy.json"), taxonomy),
    writeFile(path.join(vault, ".oms/types.json"), projection),
    writeFile(path.join(vault, ".obsidian/types.json"), obsidianTypes),
    writeFile(path.join(vault, "Templates/OMS/note.md"), template),
    writeFile(path.join(vault, "notes/alpha.md"), "---\ntemplate: note\nstatus: active\n---\nAlpha links [[beta]].\n"),
    writeFile(path.join(vault, "notes/beta.md"), "---\ntemplate: note\nstatus: reference\n---\nBeta note.\n"),
  ]);
  return vault;
}

async function fileSnapshot(root: string, relative = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      result[`${child}/`] = "directory";
      Object.assign(result, await fileSnapshot(root, child));
    } else {
      result[child] = digest((await readFile(path.join(root, child))).toString("base64"));
    }
  }
  return result;
}

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("graph command", () => {
  it("keeps status read-only and delegates a real build to the verified doctor operation", async () => {
    const vault = await freshVault();
    const output: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => output.push(JSON.parse(String(value))));

    const before = await fileSnapshot(vault);
    await runGraphCommand(["status", "--vault", vault]);
    expect(output.pop()).toEqual({ available: false, reason: "Graph cache not built" });
    expect(process.exitCode).toBe(1);
    expect(await fileSnapshot(vault)).toEqual(before);

    await runGraphCommand(["build", "--vault", vault]);
    const built = output.pop() as Record<string, unknown>;
    expect(built).toMatchObject({
      available: true,
      notes: 2,
      edges: 3,
      receipt: {
        operation: "build-graph",
        resolvedVault: vault,
        resolutionSource: "explicit",
        written: { summary: { notes: 2, edges: 3 } },
        postcondition: { kind: "template-graph-cache", notes: 2, edges: 3 },
      },
    });
    expect(process.exitCode).toBe(0);

    const afterBuild = await fileSnapshot(vault);
    await runGraphCommand(["status", "--vault", vault]);
    expect(output.pop()).toMatchObject({ available: true, notes: 2, edges: 3 });
    expect(process.exitCode).toBe(0);
    expect(await fileSnapshot(vault)).toEqual(afterBuild);
    expect(afterBuild).not.toEqual(before);
  });

  it("reports current convention, runtime history, and ephemeral engine availability without a store", async () => {
    const vault = await freshVault();
    const output: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => output.push(JSON.parse(String(value))));
    const before = await fileSnapshot(vault);

    await runStatusCommand(["--vault", vault]);

    expect(output.pop()).toMatchObject({
      vault,
      source: "explicit",
      convention: { defaultTemplate: "note", templates: { note: { id: "note" } } },
      history: { events: 0 },
      engine: { available: false, reason: "Engine store not found" },
      graph: { available: false, reason: "Graph cache not built" },
    });
    expect(process.exitCode).toBe(0);
    expect(await fileSnapshot(vault)).toEqual(before);
  });

  it("reports an absent convention and current read-only health without changing an empty vault", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-status-empty-"));
    roots.push(vault);
    const output: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => output.push(JSON.parse(String(value))));
    const before = await fileSnapshot(vault);

    await runStatusCommand(["--vault", vault]);

    expect(output.pop()).toEqual({
      vault,
      source: "explicit",
      convention: {
        status: "absent",
        diagnostics: [{
          code: "TEMPLATE_POLICY_ABSENT",
          remediation: `No template convention exists at "${path.join(vault, ".oms", "template-policy.json")}".`,
        }],
      },
      history: {
        events: 0,
        uses: 0,
        verifications: 0,
        gaps: 0,
        templates: {},
      },
      engine: { available: false, reason: "Engine store not found" },
      graph: { available: false, reason: "Graph cache not built" },
    });
    expect(process.exitCode).toBe(0);
    expect(await fileSnapshot(vault)).toEqual(before);
  });

  it("rejects unknown flags and does not invent a repair verb", async () => {
    const output: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => output.push(JSON.parse(String(value))));

    await runGraphCommand(["repair"]);

    expect(process.exitCode).toBe(1);
    expect(output.pop()).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "GRAPH_ARGS_INVALID" }],
    });
  });
});
