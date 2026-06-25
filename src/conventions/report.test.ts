import { describe, it, expect } from "vitest";
import {
  aggregateDoctor,
  formatDoctorReport,
  formatLintReport,
  type NoteReport,
} from "./report.js";
import type { VaultLintResult } from "./lint.js";

// ---------------------------------------------------------------------------
// aggregateDoctor
// ---------------------------------------------------------------------------

describe("aggregateDoctor", () => {
  it("rolls up totals across all scanned notes", () => {
    const notes: NoteReport[] = [
      { notePath: "a.md", concept: "literature", violations: [] },
      {
        notePath: "b.md",
        concept: "literature",
        violations: [
          { field: "title", rule: "required", message: "x" },
          { field: "source-url", rule: "required", message: "y" },
        ],
      },
      {
        notePath: "c.md",
        concept: "literature",
        violations: [{ field: "title", rule: "required", message: "x" }],
      },
    ];

    const agg = aggregateDoctor(notes);

    expect(agg.totalNotes).toBe(3);
    expect(agg.notesWithViolations).toBe(2);
    expect(agg.totalViolations).toBe(3);
  });

  it("aggregates by frontmatter field: distinct notes vs total occurrences", () => {
    const notes: NoteReport[] = [
      {
        notePath: "b.md",
        concept: "literature",
        violations: [
          { field: "title", rule: "required", message: "x" },
          { field: "source-url", rule: "required", message: "y" },
        ],
      },
      {
        notePath: "c.md",
        concept: "literature",
        violations: [{ field: "title", rule: "required", message: "x" }],
      },
    ];

    const agg = aggregateDoctor(notes);

    // title:required affects 2 notes (b, c) → notes:2, violations:2
    const title = agg.fields.find((f) => f.field === "title");
    expect(title).toMatchObject({
      concept: "literature",
      rule: "required",
      notes: 2,
      violations: 2,
    });

    // source-url:required affects 1 note → notes:1, violations:1
    const sourceUrl = agg.fields.find((f) => f.field === "source-url");
    expect(sourceUrl).toMatchObject({ notes: 1, violations: 1 });

    // Most-violated field first.
    expect(agg.fields[0]?.field).toBe("title");
  });

  it("counts a field once per note even with duplicate same-field violations", () => {
    const notes: NoteReport[] = [
      {
        notePath: "b.md",
        concept: "references",
        violations: [
          { field: "tags", rule: "type", message: "x" },
          { field: "tags", rule: "type", message: "x again" },
        ],
      },
    ];

    const agg = aggregateDoctor(notes);
    const tags = agg.fields.find((f) => f.field === "tags");
    expect(tags).toMatchObject({ notes: 1, violations: 2 });
  });

  it("separates aggregation per concept", () => {
    const notes: NoteReport[] = [
      {
        notePath: "lit.md",
        concept: "literature",
        violations: [{ field: "title", rule: "required", message: "x" }],
      },
      {
        notePath: "ref.md",
        concept: "references",
        violations: [{ field: "title", rule: "required", message: "x" }],
      },
    ];

    const agg = aggregateDoctor(notes);
    expect(agg.concepts).toHaveLength(2);
    // title:required appears once per concept as distinct rows.
    expect(agg.fields.filter((f) => f.field === "title")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// formatDoctorReport
// ---------------------------------------------------------------------------

describe("formatDoctorReport", () => {
  it("renders the per-field aggregation table when violations exist", () => {
    const notes: NoteReport[] = [
      {
        notePath: "b.md",
        concept: "literature",
        violations: [{ field: "title", rule: "required", message: "x" }],
      },
    ];
    const out = formatDoctorReport(aggregateDoctor(notes), { vault: "/v" });

    expect(out).toContain("Violations by frontmatter field");
    expect(out).toContain("Violations by concept");
    expect(out).toContain("title");
    expect(out).toContain("required");
    // No per-note flood without --verbose.
    expect(out).not.toContain("b.md");
    expect(out).toContain("Run `oms doctor --verbose`");
  });

  it("lists affected notes only in verbose mode", () => {
    const notes: NoteReport[] = [
      {
        notePath: "b.md",
        concept: "literature",
        violations: [{ field: "title", rule: "required", message: "x" }],
      },
    ];
    const out = formatDoctorReport(aggregateDoctor(notes), {
      vault: "/v",
      verbose: true,
      notes,
    });
    expect(out).toContain("Affected notes");
    expect(out).toContain("b.md — title:required");
  });

  it("reports a clean bill of health when there are no violations", () => {
    const notes: NoteReport[] = [
      { notePath: "a.md", concept: "literature", violations: [] },
    ];
    const out = formatDoctorReport(aggregateDoctor(notes), { vault: "/v" });
    expect(out).toContain("No frontmatter violations");
    expect(out).not.toContain("Violations by frontmatter field");
  });

  it("handles an empty vault", () => {
    const out = formatDoctorReport(aggregateDoctor([]), { vault: "/v" });
    expect(out).toContain("No notes matched the active ontology");
  });
});

// ---------------------------------------------------------------------------
// formatLintReport
// ---------------------------------------------------------------------------

describe("formatLintReport", () => {
  const result: VaultLintResult = {
    totalNotes: 3,
    brokenLinks: [
      { notePath: "a.md", target: "Missing1" },
      { notePath: "a.md", target: "Missing2" },
      { notePath: "b.md", target: "Missing3" },
    ],
    orphanPaths: ["c.md"],
  };

  it("summarizes broken links by offending note, most first", () => {
    const out = formatLintReport(result, { vault: "/v" });
    expect(out).toContain("3 broken wikilink(s) across 2 note(s)");
    expect(out).toContain("a.md (2)");
    expect(out).toContain("[[Missing1]]");
    // a.md (2 broken) should be listed before b.md (1 broken).
    expect(out.indexOf("a.md")).toBeLessThan(out.indexOf("b.md"));
  });

  it("reports orphan notes", () => {
    const out = formatLintReport(result, { vault: "/v" });
    expect(out).toContain("Orphan notes (no incoming links): 1");
    expect(out).toContain("c.md");
  });

  it("does not report frontmatter — that is doctor's job (MECE)", () => {
    const out = formatLintReport(result, { vault: "/v" });
    expect(out).not.toContain("frontmatter");
    expect(out).not.toContain("concept");
  });

  it("gives a clean report when there are no link issues", () => {
    const clean: VaultLintResult = {
      totalNotes: 1,
      brokenLinks: [],
      orphanPaths: [],
    };
    const out = formatLintReport(clean, { vault: "/v" });
    expect(out).toContain("Broken wikilinks: 0 ✓");
    expect(out).toContain("Orphan notes: 0 ✓");
  });
});
