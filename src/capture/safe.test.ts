import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadOntology } from "../core/ontology/loader.js";
import type { Concept, Ontology } from "../core/ontology/types.js";
import { commitCapture, prepareCapture, safeVaultNotePath, writeNote } from "./safe.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
const fixtureVault = path.join(repoRoot, "test", "fixtures", "vault");
const ontologyDir = path.join(repoRoot, "core", "ontology");

let tmpVault: string | undefined;

afterEach(async () => {
  if (tmpVault) {
    await rm(tmpVault, { recursive: true, force: true });
    tmpVault = undefined;
  }
});

describe("safe capture", () => {
  it("rejects paths outside the vault and internal Oh My Second Brain folders", () => {
    expect(() => safeVaultNotePath("/tmp/vault", "../escape.md")).toThrow(/unsafe|inside/);
    expect(() => safeVaultNotePath("/tmp/vault", "/tmp/vault/note.md")).toThrow(/relative/);
    expect(() => safeVaultNotePath("/tmp/vault", ".oms/cache/bad.md")).toThrow(/internal/);
    expect(() => safeVaultNotePath("/tmp/vault", "references/no-extension")).toThrow(/\.md/);
  });

  it("asks for missing required fields instead of writing incomplete captures", async () => {
    const ontology = await loadOntology(ontologyDir);
    const plan = prepareCapture({
      vault: "/tmp/vault",
      ontology,
      concept: "literature",
      frontmatter: { title: "Incomplete" },
    });

    expect(plan.action).toBe("ask-missing-fields");
    expect(plan.missingFields).toEqual(["source-url"]);

    const whitespacePlan = prepareCapture({
      vault: "/tmp/vault",
      ontology,
      concept: "literature",
      frontmatter: { title: "   ", "source-url": "https://example.com" },
    });
    expect(whitespacePlan.action).toBe("ask-missing-fields");
    expect(whitespacePlan.missingFields).toEqual(["title"]);
  });

  it("routes ambiguous captures to inbox", async () => {
    const ontology = await loadOntology(ontologyDir);
    const plan = prepareCapture({
      vault: "/tmp/vault",
      ontology,
      concept: "missing-concept",
      folder: "unknown",
      frontmatter: { title: "Loose thought" },
    });

    expect(plan.action).toBe("route-to-inbox");
    expect(plan.folder).toBe("inbox");
    expect(plan.notePath.startsWith("inbox/")).toBe(true);
  });

  it("does not return unsafe planned paths from caller-supplied filenames", async () => {
    const ontology = await loadOntology(ontologyDir);
    const plan = prepareCapture({
      vault: "/tmp/vault",
      ontology,
      concept: "literature",
      filename: "../escape.md",
      frontmatter: {
        title: "Safe title",
        "source-url": "https://example.com/safe-title",
      },
    });

    expect(plan.action).toBe("route-to-inbox");
    expect(plan.notePath).toMatch(/^inbox\/\d{4}-\d{2}-\d{2}-safe-title\.md$/);
    expect(plan.notePath).not.toContain("..");
  });

  it("creates and appends only inside the vault after contract validation", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-capture-"));
    await cp(fixtureVault, tmpVault, { recursive: true });
    const ontology = await loadOntology(ontologyDir);
    const notePath = "references/new-book.md";
    const frontmatter = {
      title: "New Book",
      "source-url": "https://example.com/new-book",
    };

    await expect(
      commitCapture({
        vault: tmpVault,
        ontology,
        notePath,
        frontmatter,
        body: "Initial body.",
        mode: "create",
      }),
    ).resolves.toEqual({ written: true, mode: "create", notePath });

    await expect(
      commitCapture({
        vault: tmpVault,
        ontology,
        notePath,
        frontmatter,
        body: "Appended body.",
        mode: "append",
      }),
    ).resolves.toEqual({ written: true, mode: "append", notePath });

    const written = await readFile(path.join(tmpVault, notePath), "utf-8");
    expect(written).toContain("Initial body.");
    expect(written).toContain("Appended body.");

    await expect(
      commitCapture({
        vault: tmpVault,
        ontology,
        notePath: "../outside.md",
        frontmatter,
        body: "Bad",
        mode: "create",
      }),
    ).rejects.toThrow(/unsafe|inside/);
  });
});

const LITERATURE: Concept = {
  concept: "literature",
  intent: "A processed reference.",
  folder: "references",
  fields: [
    { name: "title", type: "string", required: true, intent: "Title." },
    { name: "source-url", type: "url", required: true, intent: "Canonical URL." },
    {
      name: "status",
      type: "string",
      required: false,
      intent: "Publication state.",
      enum: ["draft", "published", "archived"],
    },
  ],
};

function testOntology(): Ontology {
  return {
    taxonomy: {
      version: 1,
      folders: {
        references: { intent: "refs", concept: "literature" },
        inbox: { intent: "inbox", concept: "inbox" },
      },
    },
    concepts: new Map([
      ["literature", LITERATURE],
      ["inbox", { concept: "inbox", intent: "inbox", folder: "inbox", fields: [] }],
    ]),
  };
}

describe("writeNote kernel", () => {
  it("asks on create when required or enum fields fail and does not write", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-write-ask-"));
    const ontology = testOntology();
    const missing = await writeNote({
      vault: tmpVault,
      ontology,
      mode: "create",
      dryRun: false,
      concept: "literature",
      frontmatter: { title: "Only title" },
      body: "Body",
    });
    expect(missing.status).toBe("ask");
    expect(missing.missingFields).toContain("source-url");
    expect(missing.fields.map((field) => field.name)).toContain("source-url");

    const badEnum = await writeNote({
      vault: tmpVault,
      ontology,
      mode: "create",
      dryRun: false,
      notePath: "references/enum.md",
      frontmatter: {
        title: "Enum",
        "source-url": "https://example.com/enum",
        status: "preview",
      },
      body: "Body",
    });
    expect(badEnum.status).toBe("ask");
    expect(badEnum.violations.map((violation) => violation.rule)).toContain("enum");
  });

  it("creates, appends, and updates when the contract passes, preserving extra keys", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-write-ok-"));
    const ontology = testOntology();
    const notePath = "references/new-book.md";
    const created = await writeNote({
      vault: tmpVault,
      ontology,
      mode: "create",
      dryRun: false,
      notePath,
      frontmatter: {
        title: "New Book",
        "source-url": "https://example.com/new-book",
        "my-rating": 5,
      },
      body: "Initial body.",
    });
    expect(created).toMatchObject({ status: "written", mode: "create", notePath });

    const appended = await writeNote({
      vault: tmpVault,
      ontology,
      mode: "append",
      dryRun: false,
      notePath,
      body: "Appended body.",
    });
    expect(appended).toMatchObject({ status: "written", mode: "append", notePath });

    const updated = await writeNote({
      vault: tmpVault,
      ontology,
      mode: "update",
      dryRun: false,
      notePath,
      frontmatter: { status: "published" },
    });
    expect(updated.status).toBe("written");
    expect(updated.frontmatter["my-rating"]).toBe(5);
    expect(updated.frontmatter["status"]).toBe("published");

    const written = await readFile(path.join(tmpVault, notePath), "utf-8");
    expect(written).toContain("Initial body.");
    expect(written).toContain("Appended body.");
    expect(written).toContain("my-rating: 5");
    expect(written).toContain("status: published");
  });

  it("rejects update that breaks required fields and leaves the file unchanged", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-write-reject-"));
    const ontology = testOntology();
    const notePath = "references/keep.md";
    await writeNote({
      vault: tmpVault,
      ontology,
      mode: "create",
      dryRun: false,
      notePath,
      frontmatter: {
        title: "Keep",
        "source-url": "https://example.com/keep",
      },
      body: "Original.",
    });

    const rejected = await writeNote({
      vault: tmpVault,
      ontology,
      mode: "update",
      dryRun: false,
      notePath,
      frontmatter: { title: "" },
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.violations.map((violation) => violation.rule)).toContain("required");

    const written = await readFile(path.join(tmpVault, notePath), "utf-8");
    expect(written).toContain("title: Keep");
    expect(written).toContain("Original.");
  });

  it("rejects an explicit unsafe notePath instead of writing", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-write-path-"));
    const rejected = await writeNote({
      vault: tmpVault,
      ontology: testOntology(),
      mode: "create",
      dryRun: false,
      notePath: "../outside.md",
      frontmatter: {
        title: "Nope",
        "source-url": "https://example.com/nope",
      },
      body: "Bad",
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.reason).toMatch(/unsafe|inside|relative/);
  });
});

