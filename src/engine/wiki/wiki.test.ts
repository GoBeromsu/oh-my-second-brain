/**
 * M3 Wiki tests — co-located with the module under test.
 *
 * Covers every completion-gate requirement:
 *   - 5-state FSM: every state reachable + each transition
 *   - Delete-to-reset escape hatch
 *   - wiki/index.md and wiki/log.md generation/format
 *   - processed→wiki promotion via real fs inspection
 *   - Link-graph closure (dangling link detection)
 *   - Cascade: affected_backlinks flips CLEAN→DIRTY
 *   - M2 integration: real compile() + createDeterministicStub() (no network)
 *
 * All fs operations use mkdtempSync temp dirs — the real vault is never touched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// M2 imports — read-only, no modification
import { compile } from "../compile/worker.js";
import { createDeterministicStub } from "../compile/cot.js";
import { createNullGraph, createStubGraph } from "../compile/cascade.js";
import { applyGrades } from "../compile/provenance.js";

// M3 imports
import {
  applyAffectedBacklinks,
  loadLedger,
  resetLedger,
  saveLedger,
  transitionClean,
  transitionConflict,
  transitionDirty,
  transitionOrphan,
  transitionStub,
} from "./ledger.js";
import { appendLog, indexPath, logPath, regenerateIndex } from "./navigation.js";
import {
  checkLinkClosure,
  conceptToProcessedPath,
  conceptToWikiPath,
  extractWikilinks,
  promoteToWiki,
  runCollection,
} from "./collection.js";
import { runLint } from "./lint.js";
import type { StalenessLedger } from "./types.js";

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

let baseDir: string;
beforeAll(() => {
  baseDir = mkdtempSync(path.join(tmpdir(), "oms-m3-test-"));
});
afterAll(() => rmSync(baseDir, { recursive: true, force: true }));

/** Deterministic clock for all tests. */
const NOW_A = () => "2024-01-15T10:00:00.000Z";
const NOW_B = () => "2024-01-16T10:00:00.000Z";

function subdir(name: string): string {
  return path.join(baseDir, name);
}

// ---------------------------------------------------------------------------
// 1. Staleness FSM — state reachability + transitions
// ---------------------------------------------------------------------------

describe("ledger — 5-state FSM", () => {
  it("DIRTY: transitionDirty produces DIRTY entry", () => {
    const ledger = transitionDirty({}, "concepts/alpha.md", NOW_A);
    expect(ledger["concepts/alpha.md"]?.state).toBe("DIRTY");
    expect(ledger["concepts/alpha.md"]?.updatedAt).toBe("2024-01-15T10:00:00.000Z");
  });

  it("CLEAN: transitionClean produces CLEAN entry", () => {
    const ledger = transitionClean({}, "concepts/alpha.md", NOW_A);
    expect(ledger["concepts/alpha.md"]?.state).toBe("CLEAN");
  });

  it("STUB: transitionStub produces STUB entry", () => {
    const ledger = transitionStub({}, "concepts/beta.md", NOW_A);
    expect(ledger["concepts/beta.md"]?.state).toBe("STUB");
  });

  it("ORPHAN: transitionOrphan produces ORPHAN entry", () => {
    const ledger = transitionOrphan({}, "concepts/gamma.md", NOW_A);
    expect(ledger["concepts/gamma.md"]?.state).toBe("ORPHAN");
  });

  it("CONFLICT: transitionConflict produces CONFLICT with note", () => {
    const ledger = transitionConflict(
      {},
      "concepts/delta.md",
      NOW_A,
      "source-A claims X; source-B claims Y",
    );
    expect(ledger["concepts/delta.md"]?.state).toBe("CONFLICT");
    expect(ledger["concepts/delta.md"]?.conflictNote).toBe(
      "source-A claims X; source-B claims Y",
    );
  });

  it("transition DIRTY → CLEAN", () => {
    let ledger: StalenessLedger = {};
    ledger = transitionDirty(ledger, "concepts/alpha.md", NOW_A);
    expect(ledger["concepts/alpha.md"]?.state).toBe("DIRTY");
    ledger = transitionClean(ledger, "concepts/alpha.md", NOW_B);
    expect(ledger["concepts/alpha.md"]?.state).toBe("CLEAN");
    expect(ledger["concepts/alpha.md"]?.updatedAt).toBe("2024-01-16T10:00:00.000Z");
  });

  it("transition CLEAN → DIRTY via cascade flip", () => {
    let ledger: StalenessLedger = {};
    ledger = transitionClean(ledger, "concepts/alpha.md", NOW_A);
    // Simulate cascade: affected_backlinks includes alpha
    const { ledger: updated, flipped } = applyAffectedBacklinks(
      ledger,
      ["concepts/alpha.md"],
      NOW_B,
    );
    expect(updated["concepts/alpha.md"]?.state).toBe("DIRTY");
    expect(flipped).toContain("concepts/alpha.md");
  });

  it("cascade flip only affects CLEAN pages (not DIRTY/STUB/ORPHAN/CONFLICT)", () => {
    let ledger: StalenessLedger = {};
    ledger = transitionDirty(ledger, "concepts/dirty.md", NOW_A);
    ledger = transitionStub(ledger, "concepts/stub.md", NOW_A);
    ledger = transitionOrphan(ledger, "concepts/orphan.md", NOW_A);
    ledger = transitionConflict(ledger, "concepts/conflict.md", NOW_A, "note");
    ledger = transitionClean(ledger, "concepts/clean.md", NOW_A);

    const { ledger: updated, flipped } = applyAffectedBacklinks(
      ledger,
      [
        "concepts/dirty.md",
        "concepts/stub.md",
        "concepts/orphan.md",
        "concepts/conflict.md",
        "concepts/clean.md",
      ],
      NOW_B,
    );

    expect(flipped).toEqual(["concepts/clean.md"]);
    expect(updated["concepts/dirty.md"]?.state).toBe("DIRTY");
    expect(updated["concepts/stub.md"]?.state).toBe("STUB");
    expect(updated["concepts/orphan.md"]?.state).toBe("ORPHAN");
    expect(updated["concepts/conflict.md"]?.state).toBe("CONFLICT");
    expect(updated["concepts/clean.md"]?.state).toBe("DIRTY"); // flipped
  });
});

// ---------------------------------------------------------------------------
// 2. Ledger persistence + delete-to-reset escape hatch
// ---------------------------------------------------------------------------

describe("ledger — persistence and escape hatch", () => {
  it("loadLedger returns empty object when file is absent", async () => {
    const dot = subdir("ledger-absent");
    const ledger = await loadLedger(dot);
    expect(ledger).toEqual({});
  });

  it("saveLedger + loadLedger round-trips correctly", async () => {
    const dot = subdir("ledger-roundtrip");
    let ledger: StalenessLedger = {};
    ledger = transitionClean(ledger, "a.md", NOW_A);
    ledger = transitionDirty(ledger, "b.md", NOW_A);
    await saveLedger(dot, ledger);

    const loaded = await loadLedger(dot);
    expect(loaded["a.md"]?.state).toBe("CLEAN");
    expect(loaded["b.md"]?.state).toBe("DIRTY");
  });

  it("escape hatch: resetLedger removes staleness.json and returns all DIRTY", async () => {
    const dot = subdir("ledger-reset");
    let ledger: StalenessLedger = {};
    ledger = transitionClean(ledger, "a.md", NOW_A);
    ledger = transitionStub(ledger, "b.md", NOW_A);
    await saveLedger(dot, ledger);

    const reset = await resetLedger(dot, NOW_B);

    // All known concepts now DIRTY
    expect(reset["a.md"]?.state).toBe("DIRTY");
    expect(reset["b.md"]?.state).toBe("DIRTY");

    // staleness.json has been deleted
    const reloaded = await loadLedger(dot);
    expect(reloaded).toEqual({});
  });

  it("escape hatch: resetLedger is no-op when staleness.json is already absent", async () => {
    const dot = subdir("ledger-reset-nofile");
    const reset = await resetLedger(dot, NOW_A);
    expect(reset).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 3. Navigation — index.md and log.md
// ---------------------------------------------------------------------------

describe("navigation — index.md", () => {
  it("regenerateIndex creates index.md with expected header and date", async () => {
    const wiki = subdir("nav-index-header");
    await regenerateIndex(wiki, ["concepts/alpha.md", "concepts/beta.md"], NOW_A);

    const content = await readFile(indexPath(wiki), "utf8");
    expect(content).toContain("# Wiki Index");
    expect(content).toContain("Generated: 2024-01-15");
  });

  it("regenerateIndex writes [[wikilink]] entries for each concept", async () => {
    const wiki = subdir("nav-index-links");
    await regenerateIndex(wiki, ["concepts/alpha.md", "wiki/beta.md"], NOW_A);

    const content = await readFile(indexPath(wiki), "utf8");
    expect(content).toContain("[[alpha]]");
    expect(content).toContain("[[beta]]");
  });

  it("regenerateIndex overwrites previous content (not append)", async () => {
    const wiki = subdir("nav-index-overwrite");
    await regenerateIndex(wiki, ["concepts/alpha.md"], NOW_A);
    await regenerateIndex(wiki, ["concepts/gamma.md"], NOW_B);

    const content = await readFile(indexPath(wiki), "utf8");
    expect(content).not.toContain("[[alpha]]");
    expect(content).toContain("[[gamma]]");
    expect(content).toContain("Generated: 2024-01-16");
  });
});

describe("navigation — log.md (append-only)", () => {
  it("appendLog creates log.md with correct format", async () => {
    const wiki = subdir("nav-log-format");
    await appendLog(wiki, "Alpha", NOW_A);

    const content = await readFile(logPath(wiki), "utf8");
    expect(content).toContain("## [2024-01-15] compile | Alpha");
  });

  it("appendLog is append-only — does not overwrite prior entries", async () => {
    const wiki = subdir("nav-log-append");
    await appendLog(wiki, "Alpha", NOW_A);
    await appendLog(wiki, "Beta", NOW_B);

    const content = await readFile(logPath(wiki), "utf8");
    expect(content).toContain("## [2024-01-15] compile | Alpha");
    expect(content).toContain("## [2024-01-16] compile | Beta");

    // Alpha entry appears before Beta entry (chronological order preserved)
    const idxAlpha = content.indexOf("Alpha");
    const idxBeta = content.indexOf("Beta");
    expect(idxAlpha).toBeLessThan(idxBeta);
  });

  it("appendLog can be called many times without losing old entries", async () => {
    const wiki = subdir("nav-log-many");
    const names = ["A", "B", "C", "D", "E"];
    for (const name of names) {
      await appendLog(wiki, name, NOW_A);
    }
    const content = await readFile(logPath(wiki), "utf8");
    for (const name of names) {
      expect(content).toContain(`compile | ${name}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Link-graph closure — dangling link detection
// ---------------------------------------------------------------------------

describe("checkLinkClosure", () => {
  it("returns closed=true when there are no wikilinks", async () => {
    const wiki = subdir("closure-none");
    const result = await checkLinkClosure(wiki, "No links here.");
    expect(result.closed).toBe(true);
    expect(result.dangling).toHaveLength(0);
  });

  it("returns closed=true when all wikilinks resolve to pages in wiki/", async () => {
    const wiki = subdir("closure-resolved");
    await mkdir(wiki, { recursive: true });
    await writeFile(path.join(wiki, "beta.md"), "Beta page", "utf8");

    const result = await checkLinkClosure(wiki, "Links to [[beta]].");
    expect(result.closed).toBe(true);
    expect(result.dangling).toHaveLength(0);
  });

  it("returns dangling link when target page is absent from wiki/", async () => {
    const wiki = subdir("closure-dangling");
    await mkdir(wiki, { recursive: true });

    const result = await checkLinkClosure(wiki, "Links to [[missing-page]].");
    expect(result.closed).toBe(false);
    expect(result.dangling).toContain("missing-page");
  });

  it("handles multiple links — partial resolution", async () => {
    const wiki = subdir("closure-partial");
    await mkdir(wiki, { recursive: true });
    await writeFile(path.join(wiki, "exists.md"), "Exists", "utf8");

    const result = await checkLinkClosure(
      wiki,
      "See [[exists]] and [[missing]].",
    );
    expect(result.closed).toBe(false);
    expect(result.dangling).toContain("missing");
    expect(result.dangling).not.toContain("exists");
  });
});

describe("extractWikilinks", () => {
  it("extracts all [[wikilinks]] from markdown", () => {
    const links = extractWikilinks("See [[alpha]] and [[beta]].");
    expect(links).toEqual(["alpha", "beta"]);
  });

  it("returns empty array when no wikilinks present", () => {
    expect(extractWikilinks("No links here.")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Processed → wiki promotion (real fs inspection)
// ---------------------------------------------------------------------------

describe("promoteToWiki — processed→wiki promotion", () => {
  it("copies file from processedDir to wikiDir", async () => {
    const processed = subdir("promote-src");
    const wiki = subdir("promote-dst");
    await mkdir(processed, { recursive: true });
    await writeFile(
      conceptToProcessedPath(processed, "concepts/alpha.md"),
      "# Alpha\n\nCompiled content.",
      "utf8",
    );

    // Assert wikiDir does NOT have file before promotion
    await expect(
      readFile(conceptToWikiPath(wiki, "concepts/alpha.md"), "utf8"),
    ).rejects.toThrow();

    await promoteToWiki(processed, wiki, "concepts/alpha.md");

    // Assert wikiDir NOW has file after promotion
    const content = await readFile(
      conceptToWikiPath(wiki, "concepts/alpha.md"),
      "utf8",
    );
    expect(content).toContain("# Alpha");
  });

  it("compile() result never lands in wiki/ directly — only promotion does", async () => {
    // Run real compile with deterministic stub
    const dot = subdir("m2-integration-direct");
    const processed = subdir("m2-integration-processed");
    const wiki = subdir("m2-integration-wiki");
    await mkdir(processed, { recursive: true });

    const materials = applyGrades(
      [{ path: "notes/alpha.md", text: "Alpha is foundational." }],
      { "notes/": "authored" },
    );

    const result = await compile({
      concept: "Alpha",
      materials,
      graph: createNullGraph(),
      llm: createDeterministicStub(),
      dotLlmwiki: dot,
      conceptId: "concepts/alpha.md",
    });

    // compile() returns a body — it does NOT write to wiki/
    expect(result.body.length).toBeGreaterThan(0);

    // wiki/ must NOT contain alpha.md at this point
    let wikiFiles: string[] = [];
    try {
      const { readdir } = await import("node:fs/promises");
      wikiFiles = await readdir(wiki);
    } catch {
      wikiFiles = []; // wiki/ doesn't exist — correct
    }
    expect(wikiFiles).not.toContain("alpha.md");

    // Write compile output to processed/ (simulating Phase-B caller)
    await writeFile(
      path.join(processed, "alpha.md"),
      result.body,
      "utf8",
    );

    // Now promote
    await promoteToWiki(processed, wiki, "concepts/alpha.md");

    // Only now does wiki/ contain the file
    const promoted = await readFile(path.join(wiki, "alpha.md"), "utf8");
    expect(promoted).toBe(result.body);
  });
});

// ---------------------------------------------------------------------------
// 6. Cascade integration — affected_backlinks flips CLEAN→DIRTY
// ---------------------------------------------------------------------------

describe("cascade — affected_backlinks consumption", () => {
  it("CLEAN pages in affected_backlinks are flipped to DIRTY", () => {
    let ledger: StalenessLedger = {};
    ledger = transitionClean(ledger, "wiki/page-a.md", NOW_A);
    ledger = transitionClean(ledger, "wiki/page-b.md", NOW_A);

    const { ledger: updated, flipped } = applyAffectedBacklinks(
      ledger,
      ["wiki/page-a.md"],
      NOW_B,
    );

    expect(updated["wiki/page-a.md"]?.state).toBe("DIRTY");
    expect(updated["wiki/page-b.md"]?.state).toBe("CLEAN"); // untouched
    expect(flipped).toEqual(["wiki/page-a.md"]);
  });

  it("cascade with M2 compile real affected_backlinks", async () => {
    const dot = subdir("cascade-m2-real");

    // Set up a stub graph that reports alpha.md is backlinked-from beta.md
    const graph = createStubGraph({ "concepts/alpha.md": ["concepts/beta.md"] });

    const materials = applyGrades(
      [{ path: "notes/alpha.md", text: "Alpha concept text." }],
      { "notes/": "authored" },
    );

    const result = await compile({
      concept: "Alpha",
      materials,
      graph,
      llm: createDeterministicStub(),
      dotLlmwiki: dot,
      conceptId: "concepts/alpha.md",
    });

    // affected_backlinks should include beta.md
    expect(result.affected_backlinks).toContain("concepts/beta.md");

    // Simulate beta.md being CLEAN before cascade
    let ledger: StalenessLedger = {};
    ledger = transitionClean(ledger, "concepts/beta.md", NOW_A);

    const { ledger: updated, flipped } = applyAffectedBacklinks(
      ledger,
      result.affected_backlinks,
      NOW_B,
    );

    expect(updated["concepts/beta.md"]?.state).toBe("DIRTY");
    expect(flipped).toContain("concepts/beta.md");
  });
});

// ---------------------------------------------------------------------------
// 7. runCollection — full integration (M2 + M3 together)
// ---------------------------------------------------------------------------

describe("runCollection — full collection cycle", () => {
  let processed: string;
  let wiki: string;
  let dot: string;

  beforeAll(async () => {
    processed = subdir("collection-processed");
    wiki = subdir("collection-wiki");
    dot = subdir("collection-dot");
    await mkdir(processed, { recursive: true });

    // Run real M2 compile
    const materials = applyGrades(
      [
        {
          path: "notes/alpha.md",
          text: "Alpha is a foundational concept.",
        },
      ],
      { "notes/": "authored" },
    );

    const graph = createStubGraph({
      "concepts/alpha.md": ["concepts/beta.md"],
    });

    const compileResult = await compile({
      concept: "Alpha",
      materials,
      graph,
      llm: createDeterministicStub(),
      dotLlmwiki: dot,
      conceptId: "concepts/alpha.md",
    });

    // Write compile output to processed/ (Phase-B caller responsibility)
    await writeFile(
      path.join(processed, "alpha.md"),
      compileResult.body,
      "utf8",
    );

    // Pre-seed beta.md as CLEAN so cascade flip can be observed
    let ledger: StalenessLedger = {};
    ledger = transitionClean(ledger, "concepts/beta.md", NOW_A);
    await saveLedger(dot, ledger);
  });

  it("promotes file to wiki/ and wiki/ file matches processed/ content", async () => {
    // wiki/ should not have alpha.md before runCollection
    await expect(
      readFile(path.join(wiki, "alpha.md"), "utf8"),
    ).rejects.toThrow();

    await runCollection({
      processedDir: processed,
      wikiDir: wiki,
      dotLlmwiki: dot,
      conceptId: "concepts/alpha.md",
      conceptName: "Alpha",
      affectedBacklinks: ["concepts/beta.md"],
      now: NOW_A,
    });

    // Now wiki/ has the file
    const wikiContent = await readFile(path.join(wiki, "alpha.md"), "utf8");
    const processedContent = await readFile(
      path.join(processed, "alpha.md"),
      "utf8",
    );
    expect(wikiContent).toBe(processedContent);
  });

  it("compiled concept is CLEAN in ledger after runCollection", async () => {
    const ledger = await loadLedger(dot);
    expect(ledger["concepts/alpha.md"]?.state).toBe("CLEAN");
  });

  it("cascade: beta.md flipped from CLEAN to DIRTY", async () => {
    const ledger = await loadLedger(dot);
    expect(ledger["concepts/beta.md"]?.state).toBe("DIRTY");
  });

  it("index.md is written with the CLEAN concept listed", async () => {
    const content = await readFile(indexPath(wiki), "utf8");
    expect(content).toContain("# Wiki Index");
    expect(content).toContain("[[alpha]]");
  });

  it("log.md is written with correct append-only format", async () => {
    const content = await readFile(logPath(wiki), "utf8");
    expect(content).toContain("## [2024-01-15] compile | Alpha");
  });

  it("second runCollection appends to log.md (append-only verified)", async () => {
    // Write another concept to processed/
    await writeFile(
      path.join(processed, "gamma.md"),
      "# Gamma\n\nGamma is another concept.",
      "utf8",
    );

    await runCollection({
      processedDir: processed,
      wikiDir: wiki,
      dotLlmwiki: dot,
      conceptId: "concepts/gamma.md",
      conceptName: "Gamma",
      affectedBacklinks: [],
      now: NOW_B,
    });

    const content = await readFile(logPath(wiki), "utf8");
    // Both entries present
    expect(content).toContain("## [2024-01-15] compile | Alpha");
    expect(content).toContain("## [2024-01-16] compile | Gamma");
    // Alpha appears before Gamma
    expect(content.indexOf("Alpha")).toBeLessThan(content.indexOf("Gamma"));
  });
});

// ---------------------------------------------------------------------------
// 8. Orphan detection
// ---------------------------------------------------------------------------

describe("orphan detection via runCollection", () => {
  it("page with no incoming links is marked ORPHAN", async () => {
    const processed2 = subdir("orphan-processed");
    const wiki2 = subdir("orphan-wiki");
    const dot2 = subdir("orphan-dot");
    await mkdir(processed2, { recursive: true });

    // Write a page that has no wikilinks pointing to it
    await writeFile(
      path.join(processed2, "lonely.md"),
      "# Lonely\n\nThis page has no incoming links.",
      "utf8",
    );

    const result = await runCollection({
      processedDir: processed2,
      wikiDir: wiki2,
      dotLlmwiki: dot2,
      conceptId: "concepts/lonely.md",
      conceptName: "Lonely",
      affectedBacklinks: [],
      now: NOW_A,
    });

    // lonely.md itself has no incoming links → ORPHAN
    const ledger = result.ledger;
    const orphanEntry = Object.entries(ledger).find(
      ([, e]) => e.state === "ORPHAN",
    );
    expect(orphanEntry).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 9. Lint
// ---------------------------------------------------------------------------

describe("runLint", () => {
  it("reports CONFLICT state pages as factual-contradiction", async () => {
    const wiki3 = subdir("lint-conflict-wiki");
    await mkdir(wiki3, { recursive: true });

    let ledger: StalenessLedger = {};
    ledger = transitionConflict(
      ledger,
      "concepts/conflicted.md",
      NOW_A,
      "source-A says true; source-B says false",
    );

    const result = await runLint({ wikiDir: wiki3, ledger });

    const conflicts = result.reported.filter(
      (f) => f.kind === "factual-contradiction",
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.message).toContain("**Conflict:**");
    expect(conflicts[0]?.message).toContain("Unresolved.");
  });

  it("reports ORPHAN state pages as orphan-page", async () => {
    const wiki4 = subdir("lint-orphan-wiki");
    await mkdir(wiki4, { recursive: true });

    let ledger: StalenessLedger = {};
    ledger = transitionOrphan(ledger, "wiki/isolated.md", NOW_A);

    const result = await runLint({ wikiDir: wiki4, ledger });

    const orphans = result.reported.filter((f) => f.kind === "orphan-page");
    expect(orphans.length).toBeGreaterThan(0);
    expect(orphans[0]?.pageId).toBe("wiki/isolated.md");
  });

  it("auto-fixes missing See-Also sections", async () => {
    const wiki5 = subdir("lint-see-also");
    await mkdir(wiki5, { recursive: true });
    await writeFile(
      path.join(wiki5, "page.md"),
      "# Page\n\nContent without See-Also.",
      "utf8",
    );
    // Create index.md so indexPath read doesn't fail
    await writeFile(
      indexPath(wiki5),
      "# Wiki Index\n\n- [[page]]\n",
      "utf8",
    );

    const result = await runLint({ wikiDir: wiki5, ledger: {} });

    const seeAlso = result.autoFixed.filter((f) => f.kind === "missing-see-also");
    expect(seeAlso).toHaveLength(1);

    // File was actually modified
    const content = await readFile(path.join(wiki5, "page.md"), "utf8");
    expect(content).toContain("## See Also");
  });

  it("auto-fixes index inconsistency when page is in wiki/ but not index.md", async () => {
    const wiki6 = subdir("lint-index-fix");
    await mkdir(wiki6, { recursive: true });
    await writeFile(path.join(wiki6, "extra.md"), "# Extra\n\n## See Also\n\n", "utf8");
    // Write index.md that is missing [[extra]]
    await writeFile(indexPath(wiki6), "# Wiki Index\n\n## Concepts\n\n", "utf8");

    const result = await runLint({ wikiDir: wiki6, ledger: {} });

    const fixes = result.autoFixed.filter((f) => f.kind === "index-inconsistency");
    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.pageId).toContain("extra");

    const indexContent = await readFile(indexPath(wiki6), "utf8");
    expect(indexContent).toContain("[[extra]]");
  });

  it("reports DIRTY pages as outdated-ref", async () => {
    const wiki7 = subdir("lint-dirty-wiki");

    let ledger: StalenessLedger = {};
    ledger = transitionDirty(ledger, "concepts/stale.md", NOW_A);

    const result = await runLint({ wikiDir: wiki7, ledger });

    const outdated = result.reported.filter((f) => f.kind === "outdated-ref");
    expect(outdated).toHaveLength(1);
    expect(outdated[0]?.pageId).toBe("concepts/stale.md");
  });
});

// ---------------------------------------------------------------------------
// 10. M2 integration — real compile() + createDeterministicStub() (no network)
// ---------------------------------------------------------------------------

describe("M2→M3 integration — real compile() with deterministic stub", () => {
  it("compile returns CascadeResult with body + affected_backlinks", async () => {
    const dot = subdir("m2m3-basic");
    const graph = createStubGraph({ "wiki/alpha.md": ["wiki/beta.md"] });
    const materials = applyGrades(
      [{ path: "notes/alpha.md", text: "Alpha content for integration test." }],
      { "notes/": "authored" },
    );

    const result = await compile({
      concept: "Alpha",
      materials,
      graph,
      llm: createDeterministicStub(),
      dotLlmwiki: dot,
      conceptId: "wiki/alpha.md",
    });

    expect(result.body.length).toBeGreaterThan(0);
    expect(result.affected_backlinks).toContain("wiki/beta.md");
    expect(result.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("full pipeline: compile → write processed/ → runCollection → wiki/ populated", async () => {
    const dot = subdir("m2m3-full");
    const processed = subdir("m2m3-processed");
    const wiki = subdir("m2m3-wiki");
    await mkdir(processed, { recursive: true });

    const materials = applyGrades(
      [{ path: "notes/concept.md", text: "This is a concept about knowledge." }],
      { "notes/": "authored" },
    );

    // Step 1: M2 compile (no network — deterministic stub)
    const compileResult = await compile({
      concept: "Knowledge",
      materials,
      graph: createNullGraph(),
      llm: createDeterministicStub(),
      dotLlmwiki: dot,
      conceptId: "concepts/knowledge.md",
    });

    expect(compileResult.body.length).toBeGreaterThan(0);

    // Step 2: Phase-B caller writes compile output to processed/
    await writeFile(
      path.join(processed, "knowledge.md"),
      compileResult.body,
      "utf8",
    );

    // Step 3: wiki/ is empty before collection run
    let wikiFiles: string[] = [];
    try {
      wikiFiles = await (await import("node:fs/promises")).readdir(wiki);
    } catch {
      wikiFiles = [];
    }
    expect(wikiFiles).not.toContain("knowledge.md");

    // Step 4: M3 collection run (promotion + navigation + ledger)
    const collectResult = await runCollection({
      processedDir: processed,
      wikiDir: wiki,
      dotLlmwiki: dot,
      conceptId: "concepts/knowledge.md",
      conceptName: "Knowledge",
      affectedBacklinks: compileResult.affected_backlinks,
      now: NOW_A,
    });

    // Step 5: verify wiki/ now has the file
    const wikiContent = await readFile(path.join(wiki, "knowledge.md"), "utf8");
    expect(wikiContent).toBe(compileResult.body);

    // Step 6: ledger shows CLEAN
    expect(collectResult.ledger["concepts/knowledge.md"]?.state).toBe("CLEAN");

    // Step 7: index.md and log.md written
    const indexContent = await readFile(indexPath(wiki), "utf8");
    expect(indexContent).toContain("[[knowledge]]");

    const logContent = await readFile(logPath(wiki), "utf8");
    expect(logContent).toContain("compile | Knowledge");
  });
});
