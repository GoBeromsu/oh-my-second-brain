/**
 * `oms linkify` batch command tests.
 *
 * The contract that matters: the command is REPORT-ONLY unless the user opts
 * into mutation twice (`--apply --yes`). Every test therefore asserts real file
 * bytes on disk — a "we would have written" claim is not evidence, and a report
 * that silently mutated a vault is the exact failure this command must not have.
 */

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sourceSignature } from "../kernel/templates/index.js";
import type { SourceDescriptor } from "../kernel/templates/types.js";
import { runLinkify } from "./linkify.js";

let tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

const digest = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function writeAuthority(vault: string): Promise<void> {
  for (const directory of [".oms", ".obsidian", "Templates/OMS"]) await mkdir(path.join(vault, directory), { recursive: true });
  const policy = JSON.stringify({ version: 1, templateFolder: "Templates/OMS", base: { fields: {} }, contracts: { note: { intent: "note", fields: { template: { type: "text", required: true }, title: { type: "text", required: true } }, views: [] } }, templates: { note: { templateId: "note", destinationClass: "managed-default", sourcePath: "Templates/OMS/note.md", contract: "note", naming: "{{slug}}.md" } } });
  const taxonomy = JSON.stringify({ folders: {} });
  const obsidianTypes = JSON.stringify({ types: { template: "text", title: "text" } });
  const template = "---\ntemplate: note\ntitle: Untitled\n---\n<!-- oms:content -->\n";
  const sources: SourceDescriptor[] = [{ logicalId: "template-policy", signature: digest(policy) }, { logicalId: "taxonomy", signature: digest(taxonomy) }, { logicalId: "obsidian-types", signature: digest(obsidianTypes) }, { path: "Templates/OMS/note.md", signature: digest(template) }];
  const projection = JSON.stringify({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sources }, managed: { base: { fields: {} }, globalAxes: {}, templates: { note: { templateId: "note", destinationClass: "managed-default", sourcePath: "Templates/OMS/note.md", targetFolder: "Inbox", keyOrder: ["template", "title"], fields: { template: { type: "text", required: true }, title: { type: "text", required: true } }, views: [], naming: "{{slug}}.md", bodySignature: digest("<!-- oms:content -->\n") } } } });
  await Promise.all([writeFile(path.join(vault, ".oms/template-policy.json"), policy), writeFile(path.join(vault, ".oms/taxonomy.json"), taxonomy), writeFile(path.join(vault, ".oms/types.json"), projection), writeFile(path.join(vault, ".obsidian/types.json"), obsidianTypes), writeFile(path.join(vault, "Templates/OMS/note.md"), template)]);
}

/**
 * A vault with one `term` note (terms/Ataraxia.md) and one prose note
 * (notes/Sage.md) that mentions the term in plain text.
 */
async function makeVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-linkify-"));
  tempRoots.push(vault);
  await writeAuthority(vault);
  await mkdir(path.join(vault, "terms"), { recursive: true });
  await mkdir(path.join(vault, "notes"), { recursive: true });
  await writeFile(
    path.join(vault, "terms", "Ataraxia.md"),
    "---\ntemplate: note\ntitle: Ataraxia\n---\n\nFreedom from disturbance.\n",
    "utf-8",
  );
  await writeFile(
    path.join(vault, "notes", "Sage.md"),
    "---\ntemplate: note\ntitle: Sage\n---\n\nThe sage pursues Ataraxia daily.\n",
    "utf-8",
  );
  return vault;
}

function readNote(vault: string, relative: string): Promise<string> {
  return readFile(path.join(vault, relative), "utf-8");
}

/** Capture console.log/console.error for one invocation. */
async function captureOutput(run: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(" "));
  try {
    const code = await run();
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe("runLinkify — report mode", () => {
  it("lists candidates and leaves every note byte-identical", async () => {
    // Given: a vault whose prose note mentions a term note by name
    const vault = await makeVault();
    const before = await readNote(vault, "notes/Sage.md");

    // When: linkify runs with no --apply
    const result = await captureOutput(() => runLinkify({ vault, apply: false, yes: false }));

    // Then: the candidate is reported and nothing on disk changed
    expect(result.code).toBe(0);
    expect(result.out).toContain("notes/Sage.md");
    expect(result.out).toContain("Ataraxia");
    expect(await readNote(vault, "notes/Sage.md")).toBe(before);
  });

  it("reports nothing and exits 0 for a vault with no notes", async () => {
    // Given: an empty vault directory
    const vault = await mkdtemp(path.join(tmpdir(), "oms-linkify-empty-"));
    tempRoots.push(vault);
    await writeAuthority(vault);

    // When: linkify runs
    const result = await captureOutput(() => runLinkify({ vault, apply: false, yes: false }));

    // Then: it completes cleanly with a zero-candidate report
    expect(result.code).toBe(0);
    expect(result.out).toContain("0 candidate(s)");
  });

  it("reports zero candidates when no note mentions a term", async () => {
    // Given: a vault whose prose note shares no surface with any term note
    const vault = await makeVault();
    await writeFile(
      path.join(vault, "notes", "Sage.md"),
      "---\ntemplate: note\ntitle: Sage\n---\n\nNothing here matches a defined term.\n",
      "utf-8",
    );
    const before = await readNote(vault, "notes/Sage.md");

    // When: linkify runs
    const result = await captureOutput(() => runLinkify({ vault, apply: false, yes: false }));

    // Then: no candidates are proposed and the note is untouched
    expect(result.code).toBe(0);
    expect(result.out).toContain("0 candidate(s)");
    expect(await readNote(vault, "notes/Sage.md")).toBe(before);
  });
});

describe("runLinkify — apply gate", () => {
  it("refuses --apply without --yes, exiting non-zero without writing", async () => {
    // Given: a vault with a linkable mention
    const vault = await makeVault();
    const before = await readNote(vault, "notes/Sage.md");

    // When: apply is requested without confirmation
    const result = await captureOutput(() => runLinkify({ vault, apply: true, yes: false }));

    // Then: the command refuses and the note bytes are unchanged
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("--yes");
    expect(await readNote(vault, "notes/Sage.md")).toBe(before);
  });

  it("applies links when --apply --yes are both given", async () => {
    // Given: a vault with a linkable mention
    const vault = await makeVault();
    const before = await readNote(vault, "notes/Sage.md");

    // When: apply runs with confirmation
    const result = await captureOutput(() => runLinkify({ vault, apply: true, yes: true }));

    // Then: the note now carries the wikilink and its bytes really changed
    expect(result.code).toBe(0);
    const after = await readNote(vault, "notes/Sage.md");
    expect(after).toContain("[[Ataraxia]]");
    expect(after).not.toBe(before);
    expect(after).toContain("title: Sage");
  });
});

describe("runLinkify — folder scope", () => {
  it("skips notes outside the requested folder", async () => {
    // Given: a vault where the only mention lives in `notes`
    const vault = await makeVault();
    const before = await readNote(vault, "notes/Sage.md");

    // When: linkify applies with the scope restricted to `references`
    await mkdir(path.join(vault, "references"), { recursive: true });
    const result = await captureOutput(() =>
      runLinkify({ vault, folder: "references", apply: true, yes: true }),
    );

    // Then: the out-of-scope note is untouched
    expect(result.code).toBe(0);
    expect(await readNote(vault, "notes/Sage.md")).toBe(before);
  });

  it("rejects a folder that is not a declared top-level vault folder", async () => {
    // Given: a vault and a bogus scope
    const vault = await makeVault();

    // When: linkify is scoped to it
    const result = await captureOutput(() => runLinkify({ vault, folder: "notes/deep", apply: false, yes: false }));

    // Then: the command fails with the shared folder-scope message
    expect(result.code).toBe(1);
    expect(result.err).toContain("path separators");
  });
});
