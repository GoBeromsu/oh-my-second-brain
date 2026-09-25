import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePublicManifest, PUBLIC_MANIFEST_PATH, readPublicManifest, renderPublicGuidance, serializePublicManifest, writePublicManifest } from "./public.js";
import type { PublicManifest, SealedField } from "./types.js";

const roots: string[] = [];
const HASH = `sha256:${"a".repeat(64)}`;
const SEAL_A = "00000000-0000-4000-8000-00000000000a";
const SEAL_B = "00000000-0000-4000-8000-00000000000b";
const SEAL_C = "00000000-0000-4000-8000-00000000000c";

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-contract-public-"));
  roots.push(root);
  return root;
}

function manifest(): PublicManifest {
  return {
    version: 1,
    common: { sealId: SEAL_A, fields: [{ name: "status", type: "text", required: true, description: "Workflow state" }] },
    templates: [
      { id: "Templates/Zeta.md", name: "Zeta", applyFolder: null, fields: [], requiredHeadings: [], sourceHash: HASH, sealId: SEAL_C },
      { id: "Templates/Meeting.md", name: "Meeting", applyFolder: "Meetings", fields: [{ name: "date", type: "date", required: false, description: "" }], requiredHeadings: ["Agenda"], sourceHash: HASH, sealId: SEAL_B },
    ],
  };
}

describe("public manifest", () => {
  it("round-trips through disk with templates sorted by id", async () => {
    const root = await vault();
    expect(await writePublicManifest(root, manifest())).toEqual({ ok: true });
    const read = await readPublicManifest(root);
    expect(read.state).toBe("ok");
    if (read.state !== "ok") return;
    expect(read.manifest.templates.map(template => template.id)).toEqual(["Templates/Meeting.md", "Templates/Zeta.md"]);
    expect(read.manifest.common?.fields[0]?.name).toBe("status");
  });

  it("drops hidden keys when a sealed field is passed by mistake", () => {
    const sealed: SealedField = { name: "status", type: "text", required: true, description: "", rules: [{ kind: "allowed", values: ["hidden-value"] }], variable: null };
    const bytes = serializePublicManifest({ version: 1, common: { sealId: SEAL_A, fields: [sealed] }, templates: [] });
    expect(bytes).not.toContain("hidden-value");
    expect(bytes).not.toContain("rules");
    expect(bytes).not.toContain("variable");
  });

  it("rejects invalid shapes", () => {
    expect(parsePublicManifest({ version: 2, common: null, templates: [] })).toBeNull();
    expect(parsePublicManifest({ version: 1, common: { sealId: "nope", fields: [] }, templates: [] })).toBeNull();
    const twice = manifest();
    expect(parsePublicManifest({ ...twice, templates: [twice.templates[0], twice.templates[0]] })).toBeNull();
    expect(parsePublicManifest({ ...twice, templates: [{ ...twice.templates[0], sealId: SEAL_B }, twice.templates[1]] })).toBeNull();
    expect(parsePublicManifest({ ...twice, templates: [{ ...twice.templates[0], sourceHash: "md5:x" }] })).toBeNull();
    expect(parsePublicManifest({ version: 1, common: { sealId: SEAL_A, fields: [{ name: "a", type: "text", required: true, description: "" }, { name: "a", type: "text", required: true, description: "" }] }, templates: [] })).toBeNull();
    expect(parsePublicManifest(manifest())).not.toBeNull();
  });

  it("reports absent without creating anything and invalid for bad JSON", async () => {
    const root = await vault();
    expect(await readPublicManifest(root)).toEqual({ state: "absent" });
    expect(await readdir(root)).toEqual([]);
    await mkdir(join(root, ".oms"));
    await writeFile(join(root, PUBLIC_MANIFEST_PATH), "{");
    expect((await readPublicManifest(root)).state).toBe("invalid");
    await writeFile(join(root, PUBLIC_MANIFEST_PATH), JSON.stringify({ version: 1 }));
    expect((await readPublicManifest(root)).state).toBe("invalid");
  });

  it("writes stable bytes", async () => {
    const root = await vault();
    await writePublicManifest(root, manifest());
    expect(await readFile(join(root, PUBLIC_MANIFEST_PATH), "utf8")).toBe(serializePublicManifest(manifest()));
  });
});

describe("renderPublicGuidance", () => {
  it("states the base rules when there is no contract", () => {
    expect(renderPublicGuidance(null)).toBe("Every note needs valid YAML frontmatter and a path inside the vault.");
  });

  it("lists only public parts", () => {
    const text = renderPublicGuidance(parsePublicManifest(manifest()));
    expect(text).toBe([
      "Every note needs valid YAML frontmatter and a path inside the vault.",
      "",
      "Common fields (every note):",
      "- status (text, required): Workflow state",
      "",
      "Template Meeting (Templates/Meeting.md)",
      "Apply folder: Meetings",
      "Fields:",
      "- date (date, optional)",
      "Required headings:",
      "- Agenda",
      "",
      "Template Zeta (Templates/Zeta.md)",
      "Apply folder: any folder",
    ].join("\n"));
  });
});
