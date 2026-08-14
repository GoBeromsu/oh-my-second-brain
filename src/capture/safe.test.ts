import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadOntology } from "../core/ontology/loader.js";
import { commitCapture, prepareCapture, safeVaultNotePath } from "./safe.js";

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
