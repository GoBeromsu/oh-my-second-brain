import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backfillDefaults, diagnoseTemplates, regenerateTypes } from "./doctor.js";
import { sourceSignature } from "./resolver.js";
import type { Digest } from "./types.js";

const roots: string[] = [];
const sha = (value: string): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;
async function vault(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-template-doctor-"));
  roots.push(root);
  await Promise.all([".oms", ".obsidian", "Templates", "notes"].map(dir => mkdir(path.join(root, dir), { recursive: true })));
  const policy = `${JSON.stringify({ version: 1, templateFolder: "Templates", base: { fields: {} }, contracts: { note: { intent: "note", fields: {}, views: [] } }, templates: { note: { templateId: "note", destinationClass: "registered-existing", sourcePath: "Templates/note.md", contract: "note", naming: "{{slug}}.md" } } })}\n`;
  const taxonomy = JSON.stringify({ folders: { notes: { concept: "note" } } });
  const obsidian = "{\"title\":\"text\"}\n";
  const template = "---\ntitle: template\n---\nbody\n";
  const descriptors = [{ logicalId: "template-policy", signature: sha(policy) }, { logicalId: "taxonomy", signature: sha(taxonomy) }, { logicalId: "obsidian-types", signature: sha(obsidian) }, { path: "Templates/note.md", signature: sha(template) }];
  const projection = `${JSON.stringify({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(descriptors), sources: descriptors }, managed: { base: { fields: {} }, globalAxes: {}, templates: { note: { templateId: "note", destinationClass: "registered-existing", sourcePath: "Templates/note.md", targetFolder: "Inbox", keyOrder: ["title"], fields: { title: { type: "text" } }, views: [], naming: "{{slug}}.md", bodySignature: sha("body\n") } } } }, null, 2)}\n`;
  await Promise.all([
    writeFile(path.join(root, ".oms", "template-policy.json"), policy, "utf8"),
    writeFile(path.join(root, ".oms", "taxonomy.json"), taxonomy, "utf8"),
    writeFile(path.join(root, ".oms", "types.json"), projection, "utf8"),

    writeFile(path.join(root, ".obsidian", "types.json"), obsidian, "utf8"),
    writeFile(path.join(root, "Templates", "note.md"), template, "utf8"),
  ]);
  return root;
}
async function note(root: string, content = "---\nconcept: note\ncustom: keep\n---\nbody\r\n"): Promise<void> { await writeFile(path.join(root, "notes", "one.md"), content, "utf8"); }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("template doctor", () => {
  it("diagnoses a healthy vault without writing", async () => {
    const root = await vault();
    const before = await readFile(path.join(root, ".oms", "types.json"), "utf8");
    expect((await diagnoseTemplates({ vault: root, source: "cwd" })).status).toBe("healthy");
    expect(await readFile(path.join(root, ".oms", "types.json"), "utf8")).toBe(before);
  });

  it("caps vault-level findings with maxPerTemplate", async () => {
    const root = await vault();
    await writeFile(path.join(root, ".oms", "template-policy.json"), "{}\n");
    await writeFile(path.join(root, ".oms", "types.json"), "{}\n");
    const diagnosis = await diagnoseTemplates({
      vault: root,
      source: "explicit",
      maxPerTemplate: 1,
    });
    expect(diagnosis.status).toBe("needs-repair");
    expect(diagnosis.diagnostics).toHaveLength(1);
  });
  it("reports projection drift", async () => {
    const root = await vault();
    await writeFile(path.join(root, "Templates", "note.md"), "---\ntitle: changed\n---\nbody\n", "utf8");
    expect((await diagnoseTemplates({ vault: root, source: "explicit" })).diagnostics.some(item => item.code === "TEMPLATE_SOURCE_DRIFT")).toBe(true);
  });
  it("regenerates a drifted projection from dry-run to approved apply", async () => {
    const root = await vault();
    await writeFile(path.join(root, "Templates", "note.md"), "---\ntitle: changed\n---\nbody\n", "utf8");
    const dry = await regenerateTypes({ target: { vault: root, source: "explicit" }, request: { dryRun: true } });
    expect(dry.status).toBe("planned");
    if (dry.status !== "planned") return;
    const applied = await regenerateTypes({ target: { vault: root, source: "explicit" }, request: { approvedDigest: dry.approvalDigest } });
    expect(applied.status).toBe("applied");
    expect((await diagnoseTemplates({ vault: root, source: "explicit" })).status).toBe("healthy");
  });
  it.each(["missing", "malformed"] as const)("regenerates a %s projection from authority", async state => {
    const root = await vault();
    const projectionPath = path.join(root, ".oms", "types.json");
    if (state === "missing") await rm(projectionPath);
    else await writeFile(projectionPath, "{}\n");
    const dry = await regenerateTypes({ target: { vault: root, source: "explicit" }, request: { dryRun: true } });
    expect(dry.status).toBe("planned");
    if (dry.status !== "planned") return;
    const applied = await regenerateTypes({
      target: { vault: root, source: "explicit" },
      request: { approvedDigest: dry.approvalDigest },
    });
    expect(applied.status).toBe("applied");
    expect((await diagnoseTemplates({ vault: root, source: "explicit" })).status).toBe("healthy");
  });
  it("rejects stale regeneration approval without changing the vault", async () => {
    const root = await vault();
    await writeFile(path.join(root, "Templates", "note.md"), "---\ntitle: changed\n---\nbody\n", "utf8");
    const dry = await regenerateTypes({ target: { vault: root, source: "explicit" }, request: { dryRun: true } });
    if (dry.status !== "planned") return;
    await writeFile(path.join(root, "Templates", "note.md"), "---\ntitle: newer\n---\nbody\n", "utf8");
    const before = await readFile(path.join(root, ".oms", "types.json"), "utf8");
    expect((await regenerateTypes({ target: { vault: root, source: "explicit" }, request: { approvedDigest: dry.approvalDigest } })).status).toBe("rejected");
    expect(await readFile(path.join(root, ".oms", "types.json"), "utf8")).toBe(before);
  });
  it("backfills exactly one note with a server-verifiable receipt", async () => {
    const root = await vault(); await note(root);
    const dry = await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one.md", request: { dryRun: true } });
    expect(dry.status).toBe("planned");
    if (dry.status !== "planned") return;
    const applied = await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one.md", request: { approvedDigest: dry.approvalDigest } });
    expect(applied).toMatchObject({ status: "applied", markerState: "complete" });
    expect(applied.status === "applied" && applied.verified.some(item => item.path === "notes/one.md" && item.state === "present")).toBe(true);
  });
  it("preserves unknown frontmatter and body bytes", async () => {
    const root = await vault(); await note(root);
    const dry = await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one.md", request: { dryRun: true } });
    if (dry.status !== "planned") return;
    await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one.md", request: { approvedDigest: dry.approvalDigest } });
    expect(await readFile(path.join(root, "notes", "one.md"), "utf8")).toBe("---\ntemplate: note\ncustom: keep\n---\nbody\r\n");
  });
  it("backfills BOM and CRLF notes without changing body bytes", async () => {
    const root = await vault();
    const original = "\ufeff---\r\nconcept: note\r\ncustom: keep\r\n---\r\nbody\r\n\r\n";
    await note(root, original);
    const dry = await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one.md", request: { dryRun: true } });
    if (dry.status !== "planned") throw new Error("expected planned backfill");
    expect((await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one.md", request: { approvedDigest: dry.approvalDigest } })).status).toBe("applied");
    expect(await readFile(path.join(root, "notes", "one.md"), "utf8")).toBe("\ufeff---\r\ntemplate: note\r\ncustom: keep\r\n---\r\nbody\r\n\r\n");
  });
  it("refuses unresolved legacy identity", async () => {
    const root = await vault(); await note(root, "---\nconcept: missing\n---\nbody\n");
    expect((await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one.md", request: { dryRun: true } })).status).toBe("rejected");
  });
  it("refuses an ambiguous folder binding", async () => {
    const root = await vault();
    await mkdir(path.join(root, "notes", "one"), { recursive: true });
    await writeFile(path.join(root, "notes", "one", "child.md"), "---\nconcept: note\n---\nbody\n", "utf8");
    await writeFile(path.join(root, ".oms", "taxonomy.json"), JSON.stringify({ folders: { notes: { concept: "note" }, "notes/one": { concept: "note" } } }), "utf8");
    expect((await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one/child.md", request: { dryRun: true } })).status).toBe("rejected");
  });
  it("rejects symlink and escaping note paths", async () => {
    const root = await vault(); await note(root); await symlink(path.join(root, "notes", "one.md"), path.join(root, "notes", "link.md"));
    expect((await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/link.md", request: { dryRun: true } })).status).toBe("rejected");
    expect((await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "../escape.md", request: { dryRun: true } })).status).toBe("rejected");
  });
  it("rejects cwd-inferred repair before filesystem mutation", async () => {
    const root = await vault(); await note(root); const before = await readFile(path.join(root, "notes", "one.md"), "utf8");
    expect((await backfillDefaults({ target: { vault: root, source: "cwd" }, notePath: "notes/one.md", request: { dryRun: true } })).status).toBe("rejected");
    expect(await readFile(path.join(root, "notes", "one.md"), "utf8")).toBe(before);
  });
  it("fails closed for malformed migration evidence before convention repair", async () => {
    const root = await vault(); await note(root);
    await writeFile(path.join(root, ".oms", "template-migration.json"), "{\"status\":\"in-progress\"}\n", "utf8");
    const diagnosis = await diagnoseTemplates({ vault: root, source: "explicit" });
    expect(diagnosis.migrationMarker).toBe("invalid");
    expect(diagnosis.diagnostics.some(item => item.code === "migration-incomplete")).toBe(true);
    const repaired = await backfillDefaults({ target: { vault: root, source: "explicit" }, notePath: "notes/one.md", request: { dryRun: true } });
    expect(repaired).toMatchObject({ status: "rejected", code: "migration-incomplete" });
  });
});
