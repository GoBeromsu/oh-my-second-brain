import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, it } from "vitest";

import { loadResolvedTemplates, sourceSignature } from "./resolver.js";
import { serializeDerivedProjection, serializeTemplatePolicy } from "./policy.js";
import { registerExistingTemplate } from "./register.js";
import type { Digest, TemplatePolicy } from "./types.js";

const vaults: string[] = [];
const source = "---\nname: {{title}}\ntags: []\n---\n# Person\n";
function sha(value: string): Digest { return `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest; }
async function fixture(): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), "oms-register-")); vaults.push(vault);
  await Promise.all([mkdir(join(vault, ".oms")), mkdir(join(vault, ".obsidian")), mkdir(join(vault, "Templates/manual"), { recursive: true })]);
  const policy: TemplatePolicy = { version: 1, templateFolder: "Templates/OMS" as TemplatePolicy["templateFolder"], base: { fields: {} }, contracts: { people: { intent: "people", fields: {}, views: [] } }, templates: {} };
  const policyBytes = serializeTemplatePolicy(policy); const taxonomy = "{\"folders\":{}}\n"; const obsidian = "{\"types\":{\"name\":\"text\",\"tags\":\"tags\"}}\n";
  const projection = serializeDerivedProjection({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature([{ logicalId: "template-policy", signature: sha(policyBytes) }, { logicalId: "taxonomy", signature: sha(taxonomy) }, { logicalId: "obsidian-types", signature: sha(obsidian) }]), sources: [{ logicalId: "template-policy", signature: sha(policyBytes) }, { logicalId: "taxonomy", signature: sha(taxonomy) }, { logicalId: "obsidian-types", signature: sha(obsidian) }] }, managed: { base: { fields: {} }, globalAxes: {}, templates: {} } });
  await Promise.all([writeFile(join(vault, ".oms/template-policy.json"), policyBytes), writeFile(join(vault, ".oms/taxonomy.json"), taxonomy), writeFile(join(vault, ".oms/types.json"), projection), writeFile(join(vault, ".obsidian/types.json"), obsidian), writeFile(join(vault, "Templates/manual/people.template.md"), source)]);
  return vault;
}
afterEach(async () => { await Promise.all(vaults.splice(0).map(vault => rm(vault, { recursive: true, force: true }))); });

/** Every file in the vault, so a registration that silently copies or renames one is caught. */
async function tree(root: string, directory = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await tree(root, absolute));
    else found.push(relative(root, absolute));
  }
  return found.sort();
}

const request = { templateId: "people", sourcePath: "Templates/manual/people.template.md", contract: "people", naming: "{{name}}" };

async function register(vault: string, overrides: Partial<typeof request> = {}): Promise<void> {
  const input = { ...request, ...overrides };
  const planned = await registerExistingTemplate(vault, input, { dryRun: true });
  if (planned.status !== "planned") throw new Error(`expected a plan, got ${planned.status}`);
  const applied = await registerExistingTemplate(vault, input, { approvedDigest: planned.approvalDigest });
  expect(applied.status).toBe("applied");
}

it("registers an existing source in place and derives its projection", async () => {
  const vault = await fixture(); const path = join(vault, "Templates/manual/people.template.md"); const before = await readFile(path);
  const request = { templateId: "people", sourcePath: "Templates/manual/people.template.md", contract: "people", naming: "{{name}}" };
  const planned = await registerExistingTemplate(vault, request, { dryRun: true });
  expect(planned.status).toBe("planned");
  if (planned.status !== "planned") throw new Error("expected plan");
  const applied = await registerExistingTemplate(vault, request, { approvedDigest: planned.approvalDigest });
  expect(applied.status).toBe("applied"); expect(await readFile(path)).toEqual(before);
  const types = await readFile(join(vault, ".oms/types.json"), "utf8"); expect(types).toContain('"people"'); expect(types).toContain('"name"');
});

it("exposes the registered template through the resolved convention the listing reads", async () => {
  const vault = await fixture();
  await register(vault);
  // `oms_search { op: "templates" }` renders exactly this resolved convention.
  const convention = await loadResolvedTemplates(vault);
  const people = convention.templates["people"];
  expect(people).toBeDefined();
  expect(people?.destinationClass).toBe("registered-existing");
  expect(people?.sourcePath).toBe(request.sourcePath);
  expect(people?.keyOrder).toEqual(["name", "tags"]);
  expect(Object.keys(people?.fields ?? {})).toEqual(expect.arrayContaining(["name", "tags"]));
});

it("rejects source drift after dry run", async () => {
  const vault = await fixture();
  const planned = await registerExistingTemplate(vault, request, { dryRun: true }); if (planned.status !== "planned") throw new Error("expected plan");
  await writeFile(join(vault, request.sourcePath), source.replace("Person", "Changed"));
  expect((await registerExistingTemplate(vault, request, { approvedDigest: planned.approvalDigest })).status).toBe("rejected");
});

it("publishes control files only, never creating, moving, or renaming a vault file", async () => {
  const vault = await fixture();
  // `.oms/` is OMS-owned control state the transaction legitimately publishes.
  // Everything else is the user's vault and must come out of registration
  // exactly as it went in.
  const owned = (paths: readonly string[]): readonly string[] => paths.filter(path => !path.startsWith(".oms/"));
  const before = owned(await tree(vault));
  const sourceBytes = await readFile(join(vault, request.sourcePath));
  await register(vault);
  expect(owned(await tree(vault))).toEqual(before);
  expect(await readFile(join(vault, request.sourcePath))).toEqual(sourceBytes);
});

it("refuses a contract the policy does not declare and leaves the vault untouched", async () => {
  const vault = await fixture();
  const before = await Promise.all((await tree(vault)).map(async path => [path, await readFile(join(vault, path), "utf8")] as const));
  await expect(registerExistingTemplate(vault, { ...request, contract: "ghost" }, { dryRun: true }))
    .rejects.toThrow(/^TEMPLATE_CONTRACT_UNKNOWN:/u);
  for (const [path, content] of before) expect(await readFile(join(vault, path), "utf8"), path).toBe(content);
});

it("refuses a templateId already bound to a different source", async () => {
  const vault = await fixture();
  await writeFile(join(vault, "Templates/manual/other.template.md"), source);
  await register(vault);
  await expect(registerExistingTemplate(vault, { ...request, sourcePath: "Templates/manual/other.template.md" }, { dryRun: true }))
    .rejects.toThrow(/^TEMPLATE_ID_DUPLICATE:/u);
});

it("names an identical re-registration as already registered rather than a collision", async () => {
  const vault = await fixture();
  await register(vault);
  const sourceBytes = await readFile(join(vault, request.sourcePath));
  await expect(registerExistingTemplate(vault, request, { dryRun: true }))
    .rejects.toThrow(/^TEMPLATE_ALREADY_REGISTERED:/u);
  expect(await readFile(join(vault, request.sourcePath))).toEqual(sourceBytes);
});
