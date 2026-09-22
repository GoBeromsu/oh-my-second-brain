import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestBytes } from "./canonical.js";
import { parseTemplatePolicy, serializeDerivedProjection } from "./policy.js";
import { controlGenerationDigest, expectedProjectionManaged, taxonomyRouting } from "./resolver.js";
import { diagnoseTemplates, regenerateTypes } from "./doctor.js";

const roots: string[] = [];
const encoder = new TextEncoder();
let previousRuntime: string | undefined;

beforeEach(() => { previousRuntime = process.env.OMS_RUNTIME_ROOT; });
afterEach(async () => {
  if (previousRuntime === undefined) delete process.env.OMS_RUNTIME_ROOT;
  else process.env.OMS_RUNTIME_ROOT = previousRuntime;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const TEMPLATE_MARKDOWN = "---\ntemplate: note\nstatus: open\n---\n\n## Summary\n";

function layer(templatePath: string, markdown: string, extra: Record<string, unknown> = {}) {
  return {
    templatePath,
    approvedMarkdown: markdown,
    approvedMarkdownDigest: digestBytes(markdown),
    fields: {},
    headings: [],
    semanticCriteria: [],
    ...extra,
  };
}

function policyText(source?: { readonly path: string; readonly identity: string; readonly rawDigest: string }): string {
  return JSON.stringify({
    version: 4,
    properties: { status: { type: "select", intent: "Workflow state.", allowedValues: ["open", "closed"] } },
    default: layer(".oms/templates/default.md", ""),
    templates: {
      note: layer(".oms/templates/note.md", TEMPLATE_MARKDOWN, {
        templateId: "note",
        fields: { status: { property: "status", required: true } },
        ...(source === undefined ? {} : { source }),
      }),
    },
  });
}

async function vault(options: { readonly policy?: string } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-doctor-"));
  roots.push(root);
  process.env.OMS_RUNTIME_ROOT = join(root, "runtime");
  const policy = options.policy ?? policyText();
  const taxonomy = JSON.stringify({ templates: { note: { templateFolder: "notes" } }, folders: { notes: { intent: "Notes." } } });
  const generationDigest = controlGenerationDigest(encoder.encode(policy), encoder.encode(taxonomy));
  await mkdir(join(root, "vault", ".oms", "templates"), { recursive: true });
  await mkdir(join(root, "vault", "notes"), { recursive: true });
  const vaultRoot = join(root, "vault");
  await writeFile(join(vaultRoot, ".oms", "template-policy.json"), policy);
  await writeFile(join(vaultRoot, ".oms", "taxonomy.json"), taxonomy);
  await writeFile(join(vaultRoot, ".oms", "types.json"), serializeDerivedProjection({
    version: "oms.types.v2",
    generatedFrom: generationDigest,
    managed: expectedProjectionManaged(parseTemplatePolicy(policy), taxonomyRouting(".oms/taxonomy.json", encoder.encode(taxonomy)), generationDigest),
  }));
  await writeFile(join(vaultRoot, ".oms", "templates", "default.md"), "");
  await writeFile(join(vaultRoot, ".oms", "templates", "note.md"), TEMPLATE_MARKDOWN);
  await writeFile(join(vaultRoot, "notes", "one.md"), "---\ntemplate: note\nstatus: open\n---\n\n## Summary\n\nBody.\n");
  return vaultRoot;
}

async function signature(root: string): Promise<string> {
  const files = [".oms/template-policy.json", ".oms/taxonomy.json", ".oms/types.json", ".oms/templates/note.md", "notes/one.md"];
  const rows = await Promise.all(files.map(async file => `${file}:${digestBytes(await readFile(join(root, file)))}`));
  return rows.join("\n");
}

describe("template doctor diagnosis", () => {
  it("reports a healthy approved contract without a verified target", async () => {
    const root = await vault();
    const before = await signature(root);
    const diagnosis = await diagnoseTemplates({ vault: root, source: "cwd" });
    expect(diagnosis.status).toBe("healthy");
    expect(diagnosis.diagnostics).toEqual([]);
    expect(diagnosis.transactionMarker).toBe("absent");
    expect(await signature(root)).toBe(before);
  });

  it("reports a missing approved authority instead of an empty contract", async () => {
    const root = await vault();
    await rm(join(root, ".oms", "template-policy.json"));
    const diagnosis = await diagnoseTemplates({ vault: root, source: "explicit" });
    expect(diagnosis.status).toBe("needs-repair");
    expect(diagnosis.diagnostics[0]?.code).toBe("CONTRACT_UNVERIFIABLE");
  });

  it("stops reading contract state while a publication is in progress", async () => {
    const root = await vault();
    await writeFile(join(root, ".oms", "template-transaction.json"), JSON.stringify({ status: "in-progress" }));
    const diagnosis = await diagnoseTemplates({ vault: root, source: "explicit" });
    expect(diagnosis.transactionMarker).not.toBe("absent");
    expect(diagnosis.diagnostics.map(item => item.code)).toEqual(["CONTRACT_TRANSACTION_IN_PROGRESS"]);
  });

  it("reports raw source drift for one template and keeps the approved contract", async () => {
    const raw = "<%* original raw template %>\n";
    const root = await vault({ policy: policyText({ path: "Sources/note.md", identity: "note-source", rawDigest: digestBytes(raw) }) });
    await mkdir(join(root, "Sources"), { recursive: true });
    await writeFile(join(root, "Sources", "note.md"), "<%* edited raw template %>\n");
    const diagnosis = await diagnoseTemplates({ vault: root, source: "explicit" });
    expect(diagnosis.diagnostics.map(item => item.code)).toContain("SOURCE_DRIFT");
    expect(diagnosis.managedSourceExclusions).toContain("Sources/note.md");
  });

  it("reports an unreadable note without rewriting it", async () => {
    const root = await vault();
    const broken = "---\ntitle: [unclosed\n---\n\nBody.\n";
    await writeFile(join(root, "notes", "broken.md"), broken);
    const diagnosis = await diagnoseTemplates({ vault: root, source: "explicit" });
    expect(diagnosis.invalidNotes).toEqual(["notes/broken.md"]);
    expect(diagnosis.diagnostics.map(item => item.code)).toContain("NOTE_FRONTMATTER_INVALID");
    expect(await readFile(join(root, "notes", "broken.md"), "utf8")).toBe(broken);
  });
});

describe("template doctor repair", () => {
  it("refuses repair on a current-directory target before touching the vault", async () => {
    const root = await vault();
    const before = await signature(root);
    const repair = await regenerateTypes({ target: { vault: root, source: "cwd" }, request: { dryRun: true } });
    expect(repair.status).toBe("rejected");
    if (repair.status === "rejected") expect(repair.code).toBe("target-unverified");
    expect(await signature(root)).toBe(before);
  });

  it("refuses an unguarded repair request", async () => {
    const root = await vault();
    const repair = await regenerateTypes({
      target: { vault: root, source: "explicit" },
      request: { dryRun: true, approvedDigest: digestBytes("nope") } as never,
    });
    expect(repair.status).toBe("rejected");
    if (repair.status === "rejected") expect(repair.code).toBe("TEMPLATE_REQUEST_INVALID");
  });

  it("does not publish derived state without going through the reviewed interview", async () => {
    const root = await vault();
    const before = await signature(root);
    const repair = await regenerateTypes({ target: { vault: root, source: "explicit" }, request: { dryRun: true } });
    // Either the interview owns the next step, or the dry run proposes without writing.
    expect(["rejected", "planned", "unchanged", "applied"]).toContain(repair.status);
    if (repair.status === "applied") throw new Error("a dry run must not apply");
    expect(await signature(root)).toBe(before);
  });
});
