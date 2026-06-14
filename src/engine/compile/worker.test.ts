import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile, wasSkipped } from "./worker.js";
import { createDeterministicStub } from "./cot.js";
import { createNullGraph, createStubGraph } from "./cascade.js";
import type { FolderGradeMap, Material } from "./types.js";
import { applyGrades } from "./provenance.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "oms-worker-test-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const materials: Material[] = [
  { path: "notes/alpha.md", text: "Alpha is a foundational concept.", grade: "authored" },
  { path: "curated/beta.md", text: "Beta references and extends alpha.", grade: "curated" },
];

function makeOpts(
  cacheSubdir: string,
  overrides: Partial<Parameters<typeof compile>[0]> = {},
) {
  return {
    concept: "Alpha",
    materials,
    graph: createNullGraph(),
    llm: createDeterministicStub(),
    dotLlmwiki: path.join(dir, cacheSubdir),
    conceptId: "concepts/alpha.md",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// New concept (first compile)
// ---------------------------------------------------------------------------

describe("compile — new concept (no cache entry)", () => {
  it("returns a non-empty body", async () => {
    const result = await compile(makeOpts("llmwiki-new"));
    expect(typeof result.body).toBe("string");
    expect(result.body.length).toBeGreaterThan(0);
  });

  it("wasSkipped returns false on first compile", async () => {
    const result = await compile(makeOpts("llmwiki-new2"));
    expect(wasSkipped(result)).toBe(false);
  });

  it("sha is a 64-char hex string", async () => {
    const result = await compile(makeOpts("llmwiki-sha"));
    expect(result.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("provenance reflects input material grades", async () => {
    const result = await compile(makeOpts("llmwiki-prov"));
    expect(result.provenance).toContain("authored");
    expect(result.provenance).toContain("curated");
  });
});

// ---------------------------------------------------------------------------
// SHA unchanged → skip (R12 incremental)
// ---------------------------------------------------------------------------

describe("compile — SHA unchanged skips recompile", () => {
  it("second compile with identical materials returns wasSkipped=true", async () => {
    const cache = "llmwiki-unchanged";
    await compile(makeOpts(cache));               // first: new → compiles
    const second = await compile(makeOpts(cache)); // second: unchanged → skip
    expect(wasSkipped(second)).toBe(true);
  });

  it("skipped result has body === empty string", async () => {
    const cache = "llmwiki-empty-body";
    await compile(makeOpts(cache));
    const second = await compile(makeOpts(cache));
    expect(second.body).toBe("");
  });

  it("skipped result still carries correct sha", async () => {
    const cache = "llmwiki-skip-sha";
    const first = await compile(makeOpts(cache));
    const second = await compile(makeOpts(cache));
    expect(second.sha).toBe(first.sha);
  });
});

// ---------------------------------------------------------------------------
// SHA changed → recompile
// ---------------------------------------------------------------------------

describe("compile — SHA changed triggers recompile", () => {
  it("changed materials after first compile returns wasSkipped=false", async () => {
    const cache = "llmwiki-changed";
    await compile(makeOpts(cache));

    const changedMaterials: Material[] = [
      { path: "notes/alpha.md", text: "Alpha content has been updated.", grade: "authored" },
    ];
    const second = await compile(makeOpts(cache, { materials: changedMaterials }));
    expect(wasSkipped(second)).toBe(false);
    expect(second.body.length).toBeGreaterThan(0);
  });

  it("added material triggers recompile", async () => {
    const cache = "llmwiki-added";
    await compile(makeOpts(cache));

    const extendedMaterials: Material[] = [
      ...materials,
      { path: "external/gamma.md", text: "New external source added.", grade: "external-raw" },
    ];
    const second = await compile(makeOpts(cache, { materials: extendedMaterials }));
    expect(wasSkipped(second)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cascade backlinks
// ---------------------------------------------------------------------------

describe("compile — cascade affected_backlinks", () => {
  it("returns backlinks from the provided graph", async () => {
    const graph = createStubGraph({
      "concepts/alpha.md": ["wiki/related.md", "wiki/dependent.md"],
    });
    const result = await compile(
      makeOpts("llmwiki-cascade", { graph }),
    );
    expect(result.affected_backlinks).toContain("wiki/related.md");
    expect(result.affected_backlinks).toContain("wiki/dependent.md");
  });

  it("returns empty backlinks with null graph", async () => {
    const result = await compile(makeOpts("llmwiki-nullgraph"));
    expect(result.affected_backlinks).toEqual([]);
  });

  it("skipped compile still returns cascade backlinks", async () => {
    const cache = "llmwiki-skip-cascade";
    const graph = createStubGraph({
      "concepts/alpha.md": ["wiki/page.md"],
    });
    await compile(makeOpts(cache, { graph }));
    const second = await compile(makeOpts(cache, { graph }));
    expect(wasSkipped(second)).toBe(true);
    expect(second.affected_backlinks).toContain("wiki/page.md");
  });
});

// ---------------------------------------------------------------------------
// Multiple distinct concepts — independent SHA caches
// ---------------------------------------------------------------------------

describe("compile — multiple concepts use independent SHA entries", () => {
  it("compiling concept B does not affect concept A's cache", async () => {
    const cache = "llmwiki-multi";
    await compile(makeOpts(cache, { conceptId: "concepts/alpha.md" }));
    await compile(makeOpts(cache, { conceptId: "concepts/beta.md" }));

    // Alpha still unchanged
    const alphaSecond = await compile(makeOpts(cache, { conceptId: "concepts/alpha.md" }));
    expect(wasSkipped(alphaSecond)).toBe(true);

    // Beta still unchanged
    const betaSecond = await compile(makeOpts(cache, { conceptId: "concepts/beta.md" }));
    expect(wasSkipped(betaSecond)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M2 acceptance gate — clause 1: 10 representative concepts
// ---------------------------------------------------------------------------

/** FolderGradeMap covering all 3 provenance grades (injected, not hardcoded). */
const PARA_FOLDER_GRADE_MAP: FolderGradeMap = {
  notes: "authored",
  curated: "curated",
  external: "external-raw",
};

type ConceptRow = {
  conceptId: string;
  concept: string;
  rawMaterials: Array<{ path: string; text: string }>;
};

const CONCEPT_ROWS: ConceptRow[] = [
  {
    conceptId: "concepts/recursion.md",
    concept: "Recursion",
    rawMaterials: [{ path: "notes/recursion.md", text: "Recursion is a function calling itself." }],
  },
  {
    conceptId: "concepts/abstraction.md",
    concept: "Abstraction",
    rawMaterials: [{ path: "notes/abstraction.md", text: "Abstraction hides implementation complexity." }],
  },
  {
    conceptId: "concepts/composition.md",
    concept: "Composition",
    rawMaterials: [{ path: "curated/composition.md", text: "Prefer composition over inheritance." }],
  },
  {
    conceptId: "concepts/polymorphism.md",
    concept: "Polymorphism",
    rawMaterials: [{ path: "curated/polymorphism.md", text: "Polymorphism allows multiple type implementations." }],
  },
  {
    conceptId: "concepts/encapsulation.md",
    concept: "Encapsulation",
    rawMaterials: [
      { path: "notes/encapsulation.md", text: "Encapsulation bundles data and methods together." },
      { path: "external/encapsulation-ref.md", text: "External reference: encapsulation restricts direct access." },
    ],
  },
  {
    conceptId: "concepts/inheritance.md",
    concept: "Inheritance",
    rawMaterials: [{ path: "external/inheritance.md", text: "Inheritance is an OOP reuse mechanism." }],
  },
  {
    conceptId: "concepts/coupling.md",
    concept: "Coupling",
    rawMaterials: [
      { path: "notes/coupling.md", text: "Coupling measures module interdependence." },
      { path: "curated/coupling-guide.md", text: "Low coupling improves maintainability." },
    ],
  },
  {
    conceptId: "concepts/cohesion.md",
    concept: "Cohesion",
    rawMaterials: [
      { path: "curated/cohesion.md", text: "Cohesion measures focus within a module." },
      { path: "external/cohesion-ref.md", text: "High cohesion reduces defect rates." },
    ],
  },
  {
    conceptId: "concepts/dependency-injection.md",
    concept: "Dependency Injection",
    rawMaterials: [{ path: "external/di.md", text: "Dependency Injection decouples components via inversion." }],
  },
  {
    conceptId: "concepts/inversion-of-control.md",
    concept: "Inversion of Control",
    rawMaterials: [{ path: "notes/ioc.md", text: "Inversion of Control transfers flow control to a framework." }],
  },
];

describe("compile — M2 acceptance gate clause 1: 10 representative concepts", () => {
  it.each(CONCEPT_ROWS)(
    "$conceptId: first-compile / unchanged-skip / changed-recompile / processed-tier guard",
    async ({ conceptId, concept, rawMaterials }) => {
      const materials = applyGrades(rawMaterials, PARA_FOLDER_GRADE_MAP);
      const safeId = conceptId.replace(/\//g, "-").replace(/\.md$/, "");
      const dotLlmwiki = path.join(dir, `llmwiki-para-${safeId}`);
      const baseOpts = {
        concept,
        materials,
        graph: createNullGraph(),
        llm: createDeterministicStub(),
        dotLlmwiki,
        conceptId,
      };

      // (a) First compile: non-empty body, valid sha, non-empty provenance array
      const first = await compile(baseOpts);
      expect(first.body.length).toBeGreaterThan(0);
      expect(first.sha).toMatch(/^[0-9a-f]{64}$/);
      expect(Array.isArray(first.provenance)).toBe(true);
      expect(first.provenance.length).toBeGreaterThan(0);

      // (b) Second compile with UNCHANGED materials is skipped (diffSHA → "unchanged")
      const second = await compile(baseOpts);
      expect(wasSkipped(second)).toBe(true);

      // (c) Changed materials trigger recompile: not skipped, sha differs
      const changedMaterials = materials.map((m, i) =>
        i === 0 ? { ...m, text: `${m.text} [modified]` } : m,
      );
      const third = await compile({ ...baseOpts, materials: changedMaterials });
      expect(wasSkipped(third)).toBe(false);
      expect(third.sha).not.toBe(second.sha);

      // (d) No compile output landed under wiki/ or raw/ paths (processed-tier guard)
      const written = readdirSync(dotLlmwiki, { recursive: true }).map(String);
      expect(written.some(f => /(^|[\\/])(wiki|raw)[\\/]/.test(f))).toBe(false);
    },
  );

  it("10 concepts collectively cover ≥3 distinct provenance grades (spread proof)", () => {
    const allGrades = new Set(
      CONCEPT_ROWS.flatMap(({ rawMaterials }) =>
        applyGrades(rawMaterials, PARA_FOLDER_GRADE_MAP).map((m) => m.grade),
      ),
    );
    expect(allGrades.size).toBeGreaterThanOrEqual(3);
  });
});
