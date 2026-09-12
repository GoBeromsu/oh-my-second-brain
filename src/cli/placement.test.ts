import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const roots: string[] = [];
const cli = path.resolve("dist/cli/oms.js");
const content = "---\ntitle: '{{title}}'\n---\n## Thinking\n- \n";
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-placement-"));
  roots.push(root);
  await Promise.all([".oms", ".obsidian", "Templates", "home"].map(p => mkdir(path.join(root, p))));
  await writeFile(path.join(root, ".oms/template-policy.json"), JSON.stringify({ version: 3, templateFolders: [{ path: "Templates", mode: "manual", default: true }], base: { fields: {} }, contracts: { base: { intent: "Base", fields: {}, views: [] } }, templates: {} }));
  await writeFile(path.join(root, ".oms/taxonomy.json"), "{\"folders\":{}}\n");
  await writeFile(path.join(root, ".obsidian/types.json"), "{\"types\":{\"title\":\"text\"}}\n");
  await writeFile(path.join(root, "content.md"), content);
  const projection = run(root, ["template", "regenerate-types", "--dry-run"]);
  expect(projection.code, JSON.stringify(projection.data)).toBe(0);
  expect(run(root, ["template", "regenerate-types", "--yes", "--approved-digest", projection.data.approvalDigest]).code).toBe(0);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
function run(root: string, args: readonly string[]) {
  const result = spawnSync(process.execPath, [cli, ...args, "--vault", root], { encoding: "utf8", env: { ...process.env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home") } });
  if (result.error) throw result.error;
  return { code: result.status, data: JSON.parse(result.stdout) };
}

it("CLI signs explicit Book placement together with source and naming; note --folder remains per-create", async () => {
  const root = await fixture();
  const args = ["template", "add", "--id", "book", "--from", path.join(root, "content.md"), "--target-folder", "80. References/01 Book", "--naming", "{{title}}.md"];
  const plan = run(root, [...args, "--dry-run"]);
  expect(plan.code, JSON.stringify(plan.data)).toBe(0);
  expect(plan.data.status).toBe("planned");
  expect(run(root, [...args, "--yes", "--approved-digest", plan.data.approvalDigest]).data.status).toBe("applied");
  expect(run(root, ["template", "show", "book"]).data.template).toMatchObject({ targetFolder: "80. References/01 Book", sourcePath: "Templates/book.md", naming: "{{title}}.md" });
  const note = ["note", "create", "book", "--frontmatter", '{"title":"The Attention Economy"}', "--body", "", "--dry-run"];
  expect(run(root, note).data.notePath).toBe("80. References/01 Book/The Attention Economy.md");
  expect(run(root, [...note, "--folder", "Chosen"]).data.notePath).toBe("Chosen/The Attention Economy.md");
  expect(run(root, ["template", "add", "Other", "--target-folder", "Books", "--dry-run"]).code).toBe(1);
  await writeFile(path.join(root, "Templates/other.md"), content);
  const existing = ["template", "add", "Templates/other.md", "--id", "other", "--naming", "{{title}}.md", "--target-folder", "Existing"];
  const existingPlan = run(root, [...existing, "--dry-run"]);
  expect(existingPlan.code).toBe(0);
  expect(run(root, [...existing, "--yes", "--approved-digest", existingPlan.data.approvalDigest]).data.status).toBe("applied");
  expect(run(root, ["template", "show", "other"]).data.template.targetFolder).toBe("Existing");
});

it("MCP permits location-free registration and requires a destination only for a note create", async () => {
  const root = await fixture();
  const client = new Client({ name: "placement-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "serve", "mcp", "--vault", root], env: { ...process.env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home") } });
  await client.connect(transport);
  try {
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: "write", arguments: args });
      const text = Array.isArray(result.content) ? result.content.find(item => item.type === "text")?.text : undefined;
      if (typeof text !== "string") throw new Error("missing MCP receipt");
      return JSON.parse(text);
    };
    const request = { op: "template", mode: "create", binding: { templateId: "book", destinationClass: "managed-default", renderer: "obsidian-core", sourceFolder: "Templates", sourcePath: "Templates/book.md", contract: "base", naming: "{{title}}.md" }, source: { path: "Templates/book.md", content, publication: "write" } };
    const plan = await call({ ...request, dryRun: true });
    expect(plan.status).toBe("planned");
    expect((await call({ ...request, approvedDigest: plan.approvalDigest })).status).toBe("applied");
    expect(await readFile(path.join(root, ".oms/taxonomy.json"), "utf8")).toBe('{"folders":{}}\n');
    const note = { op: "note", mode: "create", templateId: "book", frontmatter: { title: "Original Title" }, body: "", dryRun: true };
    expect((await call(note)).status).toBe("ask");
    expect((await call({ ...note, targetFolder: "Chosen" })).notePath).toBe("Chosen/Original Title.md");
    const placed = { ...request, binding: { ...request.binding, templateId: "placed", sourcePath: "Templates/placed.md" }, source: { ...request.source, path: "Templates/placed.md" }, targetFolder: "Books" };
    const placedPlan = await call({ ...placed, dryRun: true });
    expect((await call({ ...placed, approvedDigest: placedPlan.approvalDigest })).status).toBe("applied");
    expect((await call({ ...note, templateId: "placed" })).notePath).toBe("Books/Original Title.md");
    await writeFile(path.join(root, "Templates/existing.md"), content);
    const existing = { op: "template", mode: "register-existing", templateId: "existing", sourceFolder: "Templates", sourcePath: "Templates/existing.md", renderer: "obsidian-core", filledBy: [], contract: "base", naming: "{{title}}.md", targetFolder: "Existing" };
    const existingPlan = await call({ ...existing, dryRun: true });
    expect((await call({ ...existing, approvedDigest: existingPlan.approvalDigest })).status).toBe("applied");
    expect((await call({ ...note, templateId: "existing" })).notePath).toBe("Existing/Original Title.md");
    expect((await client.callTool({ name: "write", arguments: { ...note, targetFolder: 42 } })).isError).toBe(true);
    expect((await client.callTool({ name: "write", arguments: { op: "template", mode: "default", templateId: "book", targetFolder: "Books", dryRun: true } })).isError).toBe(true);
  } finally { await client.close(); }
});
