import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const descriptorRead = vi.hoisted(() => ({
  mode: "none" as "none" | "short" | "error" | "grow" | "vanish",
  target: "",
  reads: 0,
  closes: 0,
}));

const folderScan = vi.hoisted(() => ({
  mode: "none" as "none" | "error",
  target: "",
}));

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (folderScan.mode === "error" && folderScan.target !== "") {
        const openedPath = String(args[0]);
        const canonicalOpenedPath = await actual.realpath(openedPath).catch(() => openedPath);
        const canonicalTargetPath = await actual.realpath(folderScan.target).catch(() => folderScan.target);
        if (canonicalOpenedPath === canonicalTargetPath) throw new Error("injected directory scan failure");
      }
      return actual.readdir(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (descriptorRead.target === "") return handle;
      const openedPath = String(args[0]);
      const canonicalOpenedPath = await actual.realpath(openedPath).catch(() => openedPath);
      const canonicalTargetPath = await actual.realpath(descriptorRead.target).catch(() => descriptorRead.target);
      if (canonicalTargetPath !== canonicalOpenedPath) return handle;
      const read = async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null,
      ) => {
        descriptorRead.reads += 1;
        if (descriptorRead.mode === "error") throw new Error("injected descriptor read failure");
        if (descriptorRead.mode === "grow" && descriptorRead.reads === 1) {
          const result = await handle.read(buffer, offset, length, position);
          await actual.appendFile(String(args[0]), Buffer.from([0]));
          return result;
        }
        if (descriptorRead.mode === "vanish" && descriptorRead.reads === 1) {
          const result = await handle.read(buffer, offset, length, position);
          await actual.unlink(String(args[0]));
          return result;
        }
        if (descriptorRead.mode !== "short") return handle.read(buffer, offset, length, position);
        return handle.read(buffer, offset, Math.max(1, Math.ceil(length / 2)), position);
      };
      const close = async () => {
        descriptorRead.closes += 1;
        return handle.close();
      };
      return new Proxy(handle, {
        get(target, property) {
          if (property === "read") return read;
          if (property === "close") return close;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

import { proposedTemplateId, templateCensus, type CensusPriorEntry } from "./census.js";
import { deriveContentFormatContract } from "./content-contract.js";
import { normalizeTemplateFolderPath, normalizeTemplateSourcePath } from "./paths.js";
import { MAX_TEMPLATE_SOURCE_BYTES } from "./renderer.js";
import type { Digest, TemplateBinding, TemplatePolicy } from "./types.js";

const roots: string[] = [];
const folder = normalizeTemplateFolderPath("Templates");

function policy(bindings: readonly TemplateBinding[] = []): TemplatePolicy {
  return {
    version: 3,
    templateFolders: [{ path: folder }],
    base: { fields: {} },
    contracts: {},
    templates: Object.fromEntries(bindings.map(binding => [binding.templateId, binding])),
  };
}

function binding(templateId: string, sourcePath: string): TemplateBinding {
  return {
    templateId: templateId as TemplateBinding["templateId"],
    destinationClass: "registered-existing",
    renderer: "none",
    sourceFolder: folder,
    sourcePath: normalizeTemplateSourcePath(sourcePath),
    contract: templateId,
    naming: "{{slug}}.md",
  };
}

async function fixture(): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), "oms-template-census-"));
  roots.push(vault);
  await mkdir(join(vault, "Templates"), { recursive: true });
  return vault;
}

async function put(vault: string, path: string, content: string | Uint8Array): Promise<void> {
  const absolute = join(vault, path);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content);
}

function priorOf(result: Awaited<ReturnType<typeof templateCensus>>): CensusPriorEntry[] {
  return result.entries.flatMap(entry => entry.templateId === undefined
    ? []
    : [{ sourcePath: entry.sourcePath, templateId: entry.templateId, signature: entry.signature, signatureVerified: true }]);
}

const body = "---\ntitle: Note\n---\nbody\n";

function sha(value: string): Digest {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}` as Digest;
}

afterEach(async () => {
  descriptorRead.mode = "none";
  descriptorRead.target = "";
  descriptorRead.reads = 0;
  descriptorRead.closes = 0;
  folderScan.mode = "none";
  folderScan.target = "";
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("template census", () => {
  it("exports the canonical stable Unicode template-id derivation", () => {
    expect(proposedTemplateId("Templates/Daily Note.template.md")).toBe("daily-note");
    expect(proposedTemplateId("Templates/zt-cite.eta.md")).toBe("zt-cite");
    expect(proposedTemplateId("Templates/한글 노트.md")).toBe("한글-노트");
    expect(proposedTemplateId("Templates/---.md")).toBeNull();
  });

  it("reports add, edit, and delete transitions without writing OMS controls", async () => {
    const vault = await fixture();
    await put(vault, "Templates/note.md", body);
    const added = await templateCensus(vault, policy());
    expect(added.entries.map(entry => entry.sourcePath)).toEqual(["Templates/note.md"]);
    expect(added.diffs).toEqual([expect.objectContaining({ kind: "added", sourcePath: "Templates/note.md", templateId: "note" })]);
    expect(existsSync(join(vault, ".oms"))).toBe(false);

    const prior = priorOf(added);
    await put(vault, "Templates/note.md", body.replace("Note", "Edited"));
    const edited = await templateCensus(vault, policy(), prior);
    expect(edited.diffs).toEqual([expect.objectContaining({ kind: "edited", sourcePath: "Templates/note.md", templateId: "note" })]);

    await rm(join(vault, "Templates/note.md"));
    const deleted = await templateCensus(vault, policy(), prior);
    expect(deleted.entries).toEqual([]);
    expect(deleted.diffs).toEqual([expect.objectContaining({ kind: "deleted", sourcePath: "Templates/note.md", templateId: "note" })]);
    expect(existsSync(join(vault, ".oms"))).toBe(false);
  });

  it("treats a selected directory proven absent as empty and emits retireable binding deletion evidence", async () => {
    const vault = await fixture();
    const note = binding("note", "Templates/note.md");
    await put(vault, "Templates/note.md", body);
    await rm(join(vault, "Templates"), { recursive: true, force: true });

    const result = await templateCensus(vault, policy([note]));

    expect(result.entries).toEqual([]);
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: "TEMPLATE_FOLDER_INVALID" }));
    expect(result.diffs).toEqual([expect.objectContaining({
      kind: "deleted",
      sourcePath: "Templates/note.md",
      templateId: "note",
      confirmationRequired: false,
    })]);
  });

  it("keeps a selected path that is not a directory as failed evidence", async () => {
    const vault = await fixture();
    await put(vault, "Templates/note.md", body);
    const first = await templateCensus(vault, policy());
    const prior = priorOf(first);
    await rm(join(vault, "Templates"), { recursive: true, force: true });
    await writeFile(join(vault, "Templates"), "not a directory");

    const result = await templateCensus(vault, policy(), prior);

    expect(result.diffs).not.toContainEqual(expect.objectContaining({ kind: "deleted", sourcePath: "Templates/note.md" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_FOLDER_INVALID",
      path: "Templates",
    }));
  });

  it("keeps an unsafe selected directory as failed evidence", async () => {
    const vault = await fixture();
    await put(vault, "Templates/note.md", body);
    const first = await templateCensus(vault, policy());
    const prior = priorOf(first);
    const outside = await mkdtemp(join(tmpdir(), "oms-template-census-folder-unsafe-"));
    roots.push(outside);
    await rm(join(vault, "Templates"), { recursive: true, force: true });
    await symlink(outside, join(vault, "Templates"));

    const result = await templateCensus(vault, policy(), prior);

    expect(result.diffs).not.toContainEqual(expect.objectContaining({ kind: "deleted", sourcePath: "Templates/note.md" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_SOURCE_UNSAFE",
      path: "Templates",
    }));
  });

  it("derives NFC Unicode ids and preserves policy and verified-prior identities", async () => {
    const vault = await fixture();
    await put(vault, "Templates/한글 노트.md", body);
    const discovered = await templateCensus(vault, policy());
    expect(discovered.entries[0]).toMatchObject({ sourcePath: "Templates/한글 노트.md", templateId: "한글-노트" });

    const known = await templateCensus(vault, policy([binding("known-template", "Templates/한글 노트.md")]));
    expect(known.entries[0]?.templateId).toBe("known-template");

    const prior: CensusPriorEntry[] = [{
      sourcePath: normalizeTemplateSourcePath("Templates/한글 노트.md"),
      templateId: "verified-prior" as CensusPriorEntry["templateId"],
      signature: discovered.entries[0]!.signature,
      signatureVerified: true,
    }];
    const carried = await templateCensus(vault, policy(), prior);
    expect(carried.entries[0]?.templateId).toBe("verified-prior");
  });

  it("rejects duplicate derived ids and case-colliding paths instead of suffixing a winner", async () => {
    const vault = await fixture();
    await put(vault, "Templates/a b.md", body);
    await put(vault, "Templates/a_b.md", body);
    const duplicate = await templateCensus(vault, policy());
    expect(duplicate.entries.map(entry => entry.templateId)).toEqual(["a-b", "a-b"]);
    expect(duplicate.entries.every(entry => entry.diagnostics.some(item => item.code === "TEMPLATE_ID_DUPLICATE"))).toBe(true);
    expect(duplicate.entries.map(entry => entry.templateId)).not.toContain("a-b-2");

    // Case-sensitive filesystems expose this pair; case-insensitive filesystems cannot represent it.
    await put(vault, "Templates/Case.md", body);
    await put(vault, "Templates/case.md", body);
    const names = await readdir(join(vault, "Templates"));
    if (names.includes("Case.md") && names.includes("case.md")) {
      const collision = await templateCensus(vault, policy());
      const colliding = collision.entries.filter(entry => entry.sourcePath.toLocaleLowerCase() === "templates/case.md");
      expect(colliding).toHaveLength(2);
      expect(colliding.every(entry => entry.diagnostics.some(item => item.message.includes("case")))).toBe(true);
    }
  });

  it("auto-pairs only a unique one-to-one identical-byte rename", async () => {
    const vault = await fixture();
    await put(vault, "Templates/old.md", body);
    const first = await templateCensus(vault, policy());
    const prior = priorOf(first);
    await rm(join(vault, "Templates/old.md"));
    await put(vault, "Templates/new.md", body);
    const renamed = await templateCensus(vault, policy(), prior);
    expect(renamed.diffs).toEqual([expect.objectContaining({
      kind: "renamed",
      oldSourcePath: "Templates/old.md",
      newSourcePath: "Templates/new.md",
      templateId: "old",
      automatic: true,
      confirmationRequired: false,
      strategy: "identical-bytes",
    })]);
    expect(renamed.entries[0]?.templateId).toBe("old");
  });

  it("does not auto-pair ambiguous identical-byte renames or transfer old ids", async () => {
    const vault = await fixture();
    await put(vault, "Templates/old-a.md", body);
    await put(vault, "Templates/old-b.md", body);
    const first = await templateCensus(vault, policy());
    const prior = priorOf(first);
    await rm(join(vault, "Templates/old-a.md"));
    await rm(join(vault, "Templates/old-b.md"));
    await put(vault, "Templates/new-a.md", body);
    await put(vault, "Templates/new-b.md", body);
    const renamed = await templateCensus(vault, policy(), prior);
    expect(renamed.diffs.filter(diff => diff.kind === "renamed").every(diff => diff.automatic === false && diff.confirmationRequired)).toBe(true);
    expect(renamed.entries.map(entry => entry.templateId)).toEqual(["new-a", "new-b"]);
    expect(renamed.entries.map(entry => entry.templateId)).not.toContain("old-a");
    expect(renamed.entries.map(entry => entry.templateId)).not.toContain("old-b");
  });

  it("keeps unique body-only pairs in a 2x2 rename set confirmation-only", async () => {
    const vault = await fixture();
    const oldA = "---\ntitle: Old A\n---\nbody-a\n";
    const oldB = "---\ntitle: Old B\n---\nbody-b\n";
    await put(vault, "Templates/old-a.md", oldA);
    await put(vault, "Templates/old-b.md", oldB);
    const first = await templateCensus(vault, policy());
    const prior: CensusPriorEntry[] = first.entries.map(entry => ({
      sourcePath: entry.sourcePath,
      templateId: entry.templateId!,
      signature: entry.signature,
      signatureVerified: false,
      // Body signatures are policy-approved confirmation evidence; the full
      // descriptor signatures remain intentionally unverified.
      bodySignature: entry.sourcePath.endsWith("old-a.md") ? sha("body-a\n") : sha("body-b\n"),
    }));
    await rm(join(vault, "Templates/old-a.md"));
    await rm(join(vault, "Templates/old-b.md"));
    await put(vault, "Templates/new-a.md", "---\ntitle: New A\n---\nbody-a\n");
    await put(vault, "Templates/new-b.md", "---\ntitle: New B\n---\nbody-b\n");

    const renamed = await templateCensus(vault, policy(), prior);
    const bodyPairs = renamed.diffs.filter(diff => diff.kind === "renamed" && diff.strategy === "body-signature");

    expect(bodyPairs).toHaveLength(2);
    expect(bodyPairs.every(diff => diff.automatic === false && diff.confirmationRequired)).toBe(true);
    expect(renamed.entries.map(entry => entry.templateId)).toEqual(["new-a", "new-b"]);
  });

  it("prefers independently approved policy body evidence over the content fallback", async () => {
    const vault = await fixture();
    const old = "---\ntitle: Old\n---\nold-body\n";
    const moved = "---\ntitle: Moved\n---\napproved-body\n";
    const approvedBinding = {
      ...binding("old", "Templates/old.md"),
      approvedSourceSignature: sha(old),
      approvedBodySignature: sha("approved-body\n"),
      content: deriveContentFormatContract("fallback-body\n", { templateId: "old" }).contract,
    };
    await put(vault, "Templates/old.md", old);
    await rm(join(vault, "Templates/old.md"));
    await put(vault, "Templates/moved.md", moved);

    const renamed = await templateCensus(vault, policy([approvedBinding]));

    expect(renamed.diffs).toEqual([expect.objectContaining({
      kind: "renamed",
      oldSourcePath: "Templates/old.md",
      newSourcePath: "Templates/moved.md",
      strategy: "body-signature",
      automatic: false,
      confirmationRequired: true,
    })]);
    expect(renamed.entries[0]?.templateId).toBe("moved");
  });

  it("uses policy content body evidence when no independent body approval exists", async () => {
    const vault = await fixture();
    const old = "---\ntitle: Old\n---\nold-body\n";
    const moved = "---\ntitle: Moved\n---\npolicy-body\n";
    const policyBinding = {
      ...binding("old", "Templates/old.md"),
      approvedSourceSignature: sha(old),
      content: deriveContentFormatContract("policy-body\n", { templateId: "old" }).contract,
    };
    await put(vault, "Templates/old.md", old);
    await rm(join(vault, "Templates/old.md"));
    await put(vault, "Templates/moved.md", moved);

    const renamed = await templateCensus(vault, policy([policyBinding]));

    expect(renamed.diffs).toEqual([expect.objectContaining({
      kind: "renamed",
      oldSourcePath: "Templates/old.md",
      newSourcePath: "Templates/moved.md",
      strategy: "body-signature",
      automatic: false,
      confirmationRequired: true,
    })]);
  });

  it("keeps a lone changed-content move as confirmation-only", async () => {
    const vault = await fixture();
    await put(vault, "Templates/old.md", body);
    const first = await templateCensus(vault, policy());
    const prior = priorOf(first);
    await rm(join(vault, "Templates/old.md"));
    await put(vault, "Templates/new.md", "---\ntitle: Changed\n---\nother body\n");
    const result = await templateCensus(vault, policy(), prior);
    expect(result.diffs).toEqual([expect.objectContaining({
      kind: "renamed",
      strategy: "lone-delete-add",
      automatic: false,
      confirmationRequired: true,
    })]);
    expect(result.entries[0]?.templateId).toBe("new");
  });

  it("does not duplicate sources from nested selected folders", async () => {
    const vault = await fixture();
    await mkdir(join(vault, "Templates/nested"), { recursive: true });
    await put(vault, "Templates/nested/note.md", body);
    const nestedPolicy = { ...policy(), templateFolders: [
      { path: folder },
      { path: normalizeTemplateFolderPath("Templates/nested") },
    ] };
    const result = await templateCensus(vault, nestedPolicy);
    expect(result.entries.map(entry => entry.sourcePath)).toEqual(["Templates/nested/note.md"]);
  });

  it("never follows symlinked files or directories outside the selected scope", async () => {
    const vault = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "oms-template-census-outside-"));
    roots.push(outside);
    await put(outside, "outside.md", body);
    await symlink(join(outside, "outside.md"), join(vault, "Templates/link.md"));
    await symlink(outside, join(vault, "Templates/linked"));
    const result = await templateCensus(vault, policy());
    expect(result.entries).toEqual([]);
    expect(result.diagnostics.filter(item => item.code === "TEMPLATE_SOURCE_UNSAFE")).toHaveLength(2);
    expect(result.diagnostics.some(item => item.path?.includes("outside.md"))).toBe(false);
  });

  it("does not turn an unsafe replacement into deleted evidence", async () => {
    const vault = await fixture();
    const sourcePath = join(vault, "Templates/note.md");
    await put(vault, "Templates/note.md", body);
    const first = await templateCensus(vault, policy());
    const prior = priorOf(first);
    const outside = await mkdtemp(join(tmpdir(), "oms-template-census-unsafe-"));
    roots.push(outside);
    await put(outside, "outside.md", body);
    await rm(sourcePath);
    await symlink(join(outside, "outside.md"), sourcePath);

    const result = await templateCensus(vault, policy(), prior);

    expect(result.diffs).not.toContainEqual(expect.objectContaining({ kind: "deleted", sourcePath: "Templates/note.md" }));
    expect(result.diffs).not.toContainEqual(expect.objectContaining({ oldSourcePath: "Templates/note.md" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_SOURCE_UNSAFE",
      path: "Templates/note.md",
    }));
  });

  it("reports only an oversized source while retaining valid siblings", async () => {
    const vault = await fixture();
    await put(vault, "Templates/oversized.md", new Uint8Array(MAX_TEMPLATE_SOURCE_BYTES + 1));
    await put(vault, "Templates/valid.md", body);

    const result = await templateCensus(vault, policy());

    expect(result.entries.map(entry => entry.sourcePath)).toEqual(["Templates/valid.md"]);
    expect(result.diagnostics).toEqual([{
      code: "TEMPLATE_PROPOSAL_OVERSIZE",
      path: "Templates/oversized.md",
      message: `Template source exceeds the ${MAX_TEMPLATE_SOURCE_BYTES}-byte source limit`,
    }]);
  });

  it("does not turn an oversized replacement into deleted evidence", async () => {
    const vault = await fixture();
    await put(vault, "Templates/note.md", body);
    const first = await templateCensus(vault, policy());
    const prior = priorOf(first);
    await put(vault, "Templates/note.md", new Uint8Array(MAX_TEMPLATE_SOURCE_BYTES + 1));

    const result = await templateCensus(vault, policy(), prior);

    expect(result.diffs).not.toContainEqual(expect.objectContaining({ kind: "deleted", sourcePath: "Templates/note.md" }));
    expect(result.diffs).not.toContainEqual(expect.objectContaining({ oldSourcePath: "Templates/note.md" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_PROPOSAL_OVERSIZE",
      path: "Templates/note.md",
    }));
  });

  it("does not turn a non-regular source replacement into deleted evidence", async () => {
    const vault = await fixture();
    await put(vault, "Templates/note.md", body);
    const first = await templateCensus(vault, policy());
    const prior = priorOf(first);
    await rm(join(vault, "Templates/note.md"));
    await mkdir(join(vault, "Templates/note.md"));

    const result = await templateCensus(vault, policy(), prior);

    expect(result.diffs).not.toContainEqual(expect.objectContaining({ kind: "deleted", sourcePath: "Templates/note.md" }));
  });

  it("accepts the exact byte limit and rejects the next byte", async () => {
    const vault = await fixture();
    await put(vault, "Templates/exact.md", new Uint8Array(MAX_TEMPLATE_SOURCE_BYTES));
    await put(vault, "Templates/over.md", new Uint8Array(MAX_TEMPLATE_SOURCE_BYTES + 1));

    const result = await templateCensus(vault, policy());

    expect(result.entries.map(entry => [entry.sourcePath, entry.bytes.byteLength])).toEqual([
      ["Templates/exact.md", MAX_TEMPLATE_SOURCE_BYTES],
    ]);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "TEMPLATE_PROPOSAL_OVERSIZE",
      path: "Templates/over.md",
    })]);
  });

  it("measures the source limit in UTF-8 bytes rather than characters", async () => {
    const vault = await fixture();
    const source = Buffer.from("é".repeat((MAX_TEMPLATE_SOURCE_BYTES / 2) + 1), "utf8");
    expect(source.byteLength).toBe(MAX_TEMPLATE_SOURCE_BYTES + 2);
    await put(vault, "Templates/unicode.md", source);

    const result = await templateCensus(vault, policy());

    expect(result.entries).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "TEMPLATE_PROPOSAL_OVERSIZE",
      path: "Templates/unicode.md",
    })]);
  });

  it("reconstructs exact source bytes when descriptor reads return short chunks", async () => {
    const vault = await fixture();
    const source = Buffer.from(body, "utf8");
    const sourcePath = join(vault, "Templates/short-read.md");
    await put(vault, "Templates/short-read.md", source);
    descriptorRead.mode = "short";
    descriptorRead.target = sourcePath;

    const result = await templateCensus(vault, policy());

    expect(result.entries[0]?.sourcePath).toBe("Templates/short-read.md");
    expect(result.entries[0]?.bytes).toEqual(source);
    expect(descriptorRead.reads).toBeGreaterThan(1);
    expect(descriptorRead.closes).toBe(1);
  });

  it("closes a descriptor when a source read fails and preserves the read diagnostic", async () => {
    const vault = await fixture();
    const sourcePath = join(vault, "Templates/read-error.md");
    await put(vault, "Templates/read-error.md", body);
    descriptorRead.mode = "error";
    descriptorRead.target = sourcePath;

    const result = await templateCensus(vault, policy());

    expect(result.entries).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "TEMPLATE_SOURCE_READ_FAILED",
      path: "Templates/read-error.md",
      message: expect.stringContaining("injected descriptor read failure"),
    })]);
    expect(descriptorRead.closes).toBe(1);
  });

  it("does not turn an unreadable source into deleted evidence", async () => {
    const vault = await fixture();
    const sourcePath = join(vault, "Templates/read-error.md");
    await put(vault, "Templates/read-error.md", body);
    const first = await templateCensus(vault, policy());
    const prior = priorOf(first);
    descriptorRead.mode = "error";
    descriptorRead.target = sourcePath;

    const result = await templateCensus(vault, policy(), prior);

    expect(result.diffs).not.toContainEqual(expect.objectContaining({ kind: "deleted", sourcePath: "Templates/read-error.md" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_SOURCE_READ_FAILED",
      path: "Templates/read-error.md",
    }));
  });

  it("diagnoses source growth between descriptor reads without loading it as valid content", async () => {
    const vault = await fixture();
    const sourcePath = join(vault, "Templates/growing.md");
    await put(vault, "Templates/growing.md", new Uint8Array(MAX_TEMPLATE_SOURCE_BYTES));
    descriptorRead.mode = "grow";
    descriptorRead.target = sourcePath;

    const result = await templateCensus(vault, policy());

    expect(result.entries).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "TEMPLATE_PROPOSAL_OVERSIZE",
      path: "Templates/growing.md",
    })]);
    expect(descriptorRead.reads).toBeGreaterThan(1);
    expect(descriptorRead.closes).toBe(1);
  });

  it("does not turn a source removed during scanning into deleted evidence", async () => {
    const vault = await fixture();
    const sourcePath = join(vault, "Templates/raced.md");
    await put(vault, "Templates/raced.md", body);
    const first = await templateCensus(vault, policy());
    const prior = priorOf(first);
    descriptorRead.mode = "vanish";
    descriptorRead.target = sourcePath;

    const result = await templateCensus(vault, policy(), prior);

    expect(result.diffs).not.toContainEqual(expect.objectContaining({ kind: "deleted", sourcePath: "Templates/raced.md" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_SOURCE_READ_FAILED",
      path: "Templates/raced.md",
    }));
  });

  it("does not turn a failed directory scan into deleted evidence", async () => {
    const vault = await fixture();
    const note = binding("note", "Templates/raced.md");
    await put(vault, "Templates/raced.md", body);
    const first = await templateCensus(vault, policy([note]));
    const prior = priorOf(first);
    await rm(join(vault, "Templates/raced.md"));
    folderScan.mode = "error";
    folderScan.target = join(vault, "Templates");

    const result = await templateCensus(vault, policy(), prior);

    expect(result.diffs).not.toContainEqual(expect.objectContaining({ kind: "deleted", sourcePath: "Templates/raced.md" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "TEMPLATE_SOURCE_READ_FAILED",
      path: "Templates",
    }));
  });

  it("accepts depth sixteen, reports deeper sources, and continues an unaffected sibling", async () => {
    const vault = await fixture();
    const atLimitSegments = Array.from({ length: 16 }, (_, index) => `level-${index}`);
    const atLimitPath = `Templates/${atLimitSegments.join("/")}/at-limit.md`;
    const tooDeepSegments = [...atLimitSegments, "level-16"];
    const tooDeepPath = `Templates/${tooDeepSegments.join("/")}/too-deep.md`;
    await put(vault, atLimitPath, body);
    await put(vault, tooDeepPath, body);
    await put(vault, "Templates/sibling.md", body);

    const result = await templateCensus(vault, policy());

    expect(result.entries.map(entry => entry.sourcePath)).toEqual([atLimitPath, "Templates/sibling.md"]);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "TEMPLATE_PROPOSAL_OVERSIZE",
      path: `Templates/${tooDeepSegments.join("/")}`,
    })]);
  });
});
