import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { judge } from "../contract/judge.js";
import type { PropertyContract, VaultContract } from "../contract/types.js";
import { serializeVaultSettings, SETTINGS_PATH } from "../vault/settings.js";
import { mechanicalStage, type NoteJudge } from "./stage-mechanical.js";

const status = (values: string[]): PropertyContract => ({ meaning: "state", type: "text", default: null, required: false, rules: [{ kind: "allowed", values }] });
const PARENT: VaultContract = {
  folders: { Projects: { meaning: "projects", searchExclude: false } },
  properties: { status: status(["a", "b"]) },
};

const bases: string[] = [];
afterEach(async () => {
  await Promise.all(bases.splice(0).map(base => rm(base, { recursive: true, force: true })));
});

async function vaultWith(notes: Record<string, string>): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "oms-stage1-")));
  bases.push(base);
  const vault = join(base, "vault");
  for (const [path, content] of Object.entries(notes)) {
    await mkdir(join(vault, path, ".."), { recursive: true });
    await writeFile(join(vault, path), content);
  }
  await mkdir(vault, { recursive: true });
  return vault;
}

describe("mechanicalStage", () => {
  it("reports zero delta for a neutral candidate", async () => {
    const vault = await vaultWith({ "Projects/a.md": "---\nstatus: a\n---\n", "Projects/b.md": "---\nstatus: z\n---\n" });
    const neutral: VaultContract = { ...PARENT, folders: { Projects: { meaning: "active work", searchExclude: false } } };
    const result = await mechanicalStage(vault, PARENT, neutral);
    expect(result).toMatchObject({ scannedNotes: 2, newRefusals: 0, parentWarnings: 1, candidateWarnings: 1, warningDelta: 0, passed: true, notes: [] });
  });

  it("scores a tightening candidate by the warnings it adds, per note in path order", async () => {
    const vault = await vaultWith({ "Projects/z.md": "---\nstatus: b\n---\n", "Projects/a.md": "---\nstatus: b\n---\n", "Projects/ok.md": "---\nstatus: a\n---\n" });
    const tighter: VaultContract = { ...PARENT, properties: { status: status(["a"]) } };
    const result = await mechanicalStage(vault, PARENT, tighter);
    expect(result.passed).toBe(true);
    expect(result.warningDelta).toBe(2);
    expect(result.notes.map(note => note.path)).toEqual(["Projects/a.md", "Projects/z.md"]);
    expect(result.notes[0]!.newWarnings).toEqual([{ field: "status", kind: "not-allowed" }]);
  });

  it("reports a negative delta when the candidate clears warnings", async () => {
    const vault = await vaultWith({ "Projects/a.md": "---\nstatus: c\n---\n" });
    const wider: VaultContract = { ...PARENT, properties: { status: status(["a", "b", "c"]) } };
    expect((await mechanicalStage(vault, PARENT, wider)).warningDelta).toBe(-1);
  });

  it("judges broken YAML as a yaml-syntax warning under both contracts", async () => {
    const vault = await vaultWith({ "Projects/broken.md": "---\nstatus: [\n---\n" });
    const result = await mechanicalStage(vault, PARENT, { ...PARENT, properties: { status: status(["a"]) } });
    expect(result).toMatchObject({ parentWarnings: 1, candidateWarnings: 1, warningDelta: 0, newRefusals: 0 });
  });

  it.skipIf(process.getuid?.() === 0)("counts an unreadable note as refused under both, never as a new refusal", async () => {
    const vault = await vaultWith({ "Projects/locked.md": "---\nstatus: a\n---\n" });
    await chmod(join(vault, "Projects/locked.md"), 0o000);
    try {
      const result = await mechanicalStage(vault, PARENT, PARENT);
      expect(result).toMatchObject({ scannedNotes: 1, newRefusals: 0, passed: true });
    } finally {
      await chmod(join(vault, "Projects/locked.md"), 0o600);
    }
  });

  it("skips notes under the managed template folder", async () => {
    const vault = await vaultWith({ "Projects/a.md": "---\nstatus: a\n---\n", "Templates/t.md": "---\nstatus: \"{{s}}\"\n---\n" });
    await mkdir(join(vault, ".oms"), { recursive: true });
    await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c", templateFolder: "Templates" }));
    expect((await mechanicalStage(vault, PARENT, PARENT)).scannedNotes).toBe(1);
  });

  it("judges every note when the exclusion settings are unreadable", async () => {
    const vault = await vaultWith({ "Projects/a.md": "---\nstatus: a\n---\n", "Templates/t.md": "---\nstatus: a\n---\n" });
    await mkdir(join(vault, ".oms"), { recursive: true });
    await writeFile(join(vault, SETTINGS_PATH), "{ not json");
    expect((await mechanicalStage(vault, PARENT, PARENT)).scannedNotes).toBe(2);
  });

  it("fails when the candidate makes the judge refuse a note it did not refuse before", async () => {
    const vault = await vaultWith({ "Projects/a.md": "---\nstatus: a\n---\n" });
    const candidate: VaultContract = { ...PARENT, properties: { status: status(["a"]) } };
    const refusing: NoteJudge = (input, view) => view.state === "sealed" && view.contract === candidate
      ? { ...judge(input, view), ok: false, refusals: [{ field: "path", kind: "control-path" }] }
      : judge(input, view);
    const result = await mechanicalStage(vault, PARENT, candidate, refusing);
    expect(result).toMatchObject({ newRefusals: 1, passed: false });
    expect(result.notes).toEqual([{ path: "Projects/a.md", newRefusals: [{ field: "path", kind: "control-path" }], newWarnings: [] }]);
  });
});
