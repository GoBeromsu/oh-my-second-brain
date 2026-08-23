import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Ontology } from "../ontology/types.js";
import { applyLinksForNote, linkifyVault, suggestLinksForNote } from "./workflow.js";

let roots: string[] = [];

const ontology: Ontology = {
  taxonomy: {
    version: 1,
    folders: {
      terms: { intent: "Terms", concept: "term" },
      notes: { intent: "Notes", concept: "note" },
    },
  },
  concepts: new Map([
    ["term", { concept: "term", intent: "Term", folder: "terms", fields: [] }],
    ["note", { concept: "note", intent: "Note", folder: "notes", fields: [] }],
  ]),
};

async function makeVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-link-workflow-"));
  roots.push(vault);
  await mkdir(path.join(vault, "terms"));
  await mkdir(path.join(vault, "notes"));
  await writeFile(path.join(vault, "terms", "Ataraxia.md"), "---\ntitle: Ataraxia\n---\n\nA term.\n", "utf8");
  await writeFile(path.join(vault, "notes", "Sage.md"), "---\ntitle: Sage\n---\n\nAtaraxia is useful.\n", "utf8");
  return vault;
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

describe("link workflow", () => {
  it("provides stable candidates and refuses stale applies without writing", async () => {
    const vault = await makeVault();
    const target = { vault, source: "explicit" as const, ontology, notePath: "notes/Sage.md" };
    const suggestion = await suggestLinksForNote(target);
    expect(suggestion.candidateNotes).toBe(1);
    expect(suggestion.candidates).toHaveLength(1);
    expect(suggestion.candidates[0]?.id).toMatch(/^\d+-\d+$/);

    const outcome = await applyLinksForNote(target, {
      baseContentHash: "0".repeat(64),
      candidateIds: suggestion.candidates.map((candidate) => candidate.id),
    });
    expect(outcome.result).toMatchObject({ applied: false, reason: "note-changed" });
    expect(await readFile(path.join(vault, "notes", "Sage.md"), "utf8")).not.toContain("[[Ataraxia]]");
  });

  it("orchestrates a batch scan and sequential writes through the kernel", async () => {
    const vault = await makeVault();
    const result = await linkifyVault({ vault, source: "explicit", ontology }, { apply: true });
    expect(result.notesInScope).toBe(2);
    expect(result.targetNotes).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.outcome?.result.applied).toBe(true);
    expect(await readFile(path.join(vault, "notes", "Sage.md"), "utf8")).toContain("[[Ataraxia]]");
  });
});
