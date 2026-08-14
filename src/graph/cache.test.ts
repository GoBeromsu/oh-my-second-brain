import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadOntology } from "../core/ontology/loader.js";
import {
  buildGraphCache,
  graphCacheStatus,
  lazyLoadNoteBody,
} from "./cache.js";

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

describe("derived graph cache", () => {
  it("builds folder/property/search slices and lazy-loads note bodies", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-graph-"));
    await cp(fixtureVault, tmpVault, { recursive: true });
    const ontology = await loadOntology(ontologyDir);

    const cache = await buildGraphCache({ vault: tmpVault, ontology, write: true });

    expect(cache.notes.map((note) => note.path)).toContain("references/clean-architecture.md");
    expect(cache.edges).toContainEqual({
      type: "folder-concept",
      from: "references/clean-architecture.md",
      to: "concept:literature",
    });
    expect(
      cache.edges.some(
        (edge) =>
          edge.type === "property-value" &&
          edge.axis === "tags" &&
          edge.value === "software-architecture",
      ),
    ).toBe(true);

    const literature = cache.notes.find((note) => note.path === "references/clean-architecture.md");
    expect(literature?.axes["tags"]).toContain("software-architecture");

    const body = await lazyLoadNoteBody(tmpVault, "references/clean-architecture.md");
    expect(body.body).toContain("Dependency Rule");
    await expect(lazyLoadNoteBody(tmpVault, ".oms/taxonomy.yaml")).rejects.toThrow(
      /hidden|internal|dependency|\.md/,
    );
    await expect(lazyLoadNoteBody(tmpVault, "references/not-markdown.txt")).rejects.toThrow(
      /\.md/,
    );
  });

  it("reports search-only staleness for body text changes without frontmatter changes", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-graph-"));
    await cp(fixtureVault, tmpVault, { recursive: true });
    const ontology = await loadOntology(ontologyDir);
    await buildGraphCache({ vault: tmpVault, ontology, write: true });

    await writeFile(
      path.join(tmpVault, "references", "clean-architecture.md"),
      `---\ntitle: "Clean Architecture: A Craftsman's Guide to Software Structure and Design"\nsource-url: https://www.oreilly.com/library/view/clean-architecture-a/9780134494272/\nauthor:\n  - Robert C. Martin\ntags:\n  - software-architecture\n  - design\n  - clean-code\n---\n\nBody changed without new links.\n`,
      "utf-8",
    );

    const status = await graphCacheStatus(tmpVault, ontology);
    expect(status.exists).toBe(true);
    expect(status.staleness.schemaStale).toBe(false);
    expect(status.staleness.graphStale).toBe(false);
    expect(status.staleness.searchStale).toBe(true);
    expect(status.staleness.embeddingStale).toBe("not-configured");
  });

  it("marks graph and search stale when frontmatter changes because axes feed search terms", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-graph-"));
    await cp(fixtureVault, tmpVault, { recursive: true });
    const ontology = await loadOntology(ontologyDir);
    await buildGraphCache({ vault: tmpVault, ontology, write: true });

    await writeFile(
      path.join(tmpVault, "references", "clean-architecture.md"),
      `---\ntitle: \"Changed Architecture\"\nsource-url: https://www.oreilly.com/library/view/clean-architecture-a/9780134494272/\nauthor:\n  - Robert C. Martin\ntags:\n  - changed-axis\n---\n\n## Summary\n\nRobert C. Martin's *Clean Architecture* argues that the primary value of software is its ability to change.\n`,
      "utf-8",
    );

    const status = await graphCacheStatus(tmpVault, ontology);
    expect(status.staleness.schemaStale).toBe(false);
    expect(status.staleness.graphStale).toBe(true);
    expect(status.staleness.searchStale).toBe(true);
    expect(status.staleness.validationStale).toBe(true);
  });
});
