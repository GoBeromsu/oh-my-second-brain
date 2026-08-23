import type { Violation } from "./validate.js";
import type { VaultLintResult } from "./lint.js";

// ---------------------------------------------------------------------------
// Doctor: frontmatter convention aggregation
// ---------------------------------------------------------------------------

/** One scanned note and the violations found in its frontmatter (empty = clean). */
export interface NoteReport {
  notePath: string;
  concept: string;
  violations: readonly Violation[];
}

/** Aggregated counts for a single (field, rule) pair. */
export interface FieldRuleAgg {
  field: string;
  rule: string;
  /** Distinct notes that hit this field+rule at least once. */
  notes: number;
  /** Total occurrences of this field+rule across all notes. */
  violations: number;
}

export interface ConceptAgg {
  concept: string;
  notes: number;
  notesWithViolations: number;
  violations: number;
  /** Per (field, rule) breakdown, sorted by impact descending. */
  fields: FieldRuleAgg[];
}

export interface DoctorAggregate {
  totalNotes: number;
  notesWithViolations: number;
  totalViolations: number;
  /** Per-concept breakdown, sorted by violation count descending. */
  concepts: ConceptAgg[];
  /** Flat per-frontmatter-field rollup across all concepts, most-violated first. */
  fields: Array<FieldRuleAgg & { concept: string }>;
}

function fieldRuleKey(field: string, rule: string): string {
  return `${field}\u0000${rule}`;
}

function sortFieldRule(a: FieldRuleAgg, b: FieldRuleAgg): number {
  return (
    b.notes - a.notes ||
    b.violations - a.violations ||
    a.field.localeCompare(b.field) ||
    a.rule.localeCompare(b.rule)
  );
}

/**
 * Roll up per-note frontmatter violations into concept- and field-level
 * aggregates. Every scanned note (clean or not) should be passed so that
 * per-concept totals reflect coverage, not just failures.
 */
export function aggregateDoctor(notes: readonly NoteReport[]): DoctorAggregate {
  interface MutConcept {
    notes: number;
    notesWithViolations: number;
    violations: number;
    fields: Map<string, FieldRuleAgg>;
  }
  const conceptMap = new Map<string, MutConcept>();
  let totalNotes = 0;
  let notesWithViolations = 0;
  let totalViolations = 0;

  for (const note of notes) {
    totalNotes++;
    let entry = conceptMap.get(note.concept);
    if (!entry) {
      entry = { notes: 0, notesWithViolations: 0, violations: 0, fields: new Map() };
      conceptMap.set(note.concept, entry);
    }
    entry.notes++;
    if (note.violations.length === 0) continue;

    notesWithViolations++;
    totalViolations += note.violations.length;
    entry.notesWithViolations++;
    entry.violations += note.violations.length;

    // Count a note once per (field, rule) for `notes`, but every occurrence
    // for `violations`.
    const seenPairs = new Set<string>();
    for (const v of note.violations) {
      const key = fieldRuleKey(v.field, v.rule);
      let fr = entry.fields.get(key);
      if (!fr) {
        fr = { field: v.field, rule: v.rule, notes: 0, violations: 0 };
        entry.fields.set(key, fr);
      }
      fr.violations++;
      if (!seenPairs.has(key)) {
        seenPairs.add(key);
        fr.notes++;
      }
    }
  }

  const concepts: ConceptAgg[] = [];
  const fields: Array<FieldRuleAgg & { concept: string }> = [];
  for (const [concept, entry] of conceptMap) {
    const sortedFields = Array.from(entry.fields.values()).sort(sortFieldRule);
    concepts.push({
      concept,
      notes: entry.notes,
      notesWithViolations: entry.notesWithViolations,
      violations: entry.violations,
      fields: sortedFields,
    });
    for (const fr of sortedFields) fields.push({ ...fr, concept });
  }
  concepts.sort(
    (a, b) => b.violations - a.violations || a.concept.localeCompare(b.concept),
  );
  fields.sort(
    (a, b) =>
      b.notes - a.notes ||
      b.violations - a.violations ||
      a.concept.localeCompare(b.concept) ||
      a.field.localeCompare(b.field),
  );

  return { totalNotes, notesWithViolations, totalViolations, concepts, fields };
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

type Align = "left" | "right";

function renderTable(
  headers: readonly string[],
  aligns: readonly Align[],
  rows: readonly string[][],
  indent = "  ",
): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length), 0),
  );
  const renderRow = (cells: readonly string[]): string =>
    (
      indent +
      cells
        .map((c, i) =>
          aligns[i] === "right"
            ? (c ?? "").padStart(widths[i]!)
            : (c ?? "").padEnd(widths[i]!),
        )
        .join("  ")
    ).replace(/\s+$/, "");
  return [renderRow(headers), ...rows.map(renderRow)];
}

// ---------------------------------------------------------------------------
// Doctor formatting
// ---------------------------------------------------------------------------

export interface DoctorFormatOptions {
  vault: string;
  /** Append a per-note listing of every violation. */
  verbose?: boolean;
  /** Cap on notes listed per concept in verbose mode (default 50). */
  maxPerConcept?: number;
  /** Scanned notes — required for the verbose listing. */
  notes?: readonly NoteReport[];
}

export function formatDoctorReport(
  agg: DoctorAggregate,
  opts: DoctorFormatOptions,
): string {
  const lines: string[] = [];
  lines.push("Oh My Second Brain doctor — frontmatter convention check");
  lines.push(`Vault: ${opts.vault}`);
  lines.push("");

  if (agg.totalNotes === 0) {
    lines.push("No notes matched the active ontology (nothing to validate).");
    lines.push("");
    lines.push("All violations are warnings (onViolation: warn). Exit 0.");
    return lines.join("\n");
  }

  lines.push(
    `Scanned ${agg.totalNotes} notes across ${agg.concepts.length} concept(s).`,
  );
  lines.push(
    `${agg.notesWithViolations} notes with violations · ${agg.totalViolations} total violations.`,
  );

  if (agg.totalViolations === 0) {
    lines.push("");
    lines.push("No frontmatter violations. ✓");
    lines.push("");
    lines.push("All violations are warnings (onViolation: warn). Exit 0.");
    return lines.join("\n");
  }

  // Headline view: which frontmatter fields are systematically broken.
  lines.push("");
  lines.push("Violations by frontmatter field");
  lines.push(
    ...renderTable(
      ["concept", "field", "rule", "notes", "violations"],
      ["left", "left", "left", "right", "right"],
      agg.fields.map((f) => [
        f.concept,
        f.field,
        f.rule,
        String(f.notes),
        String(f.violations),
      ]),
    ),
  );

  // Per-concept rollup.
  lines.push("");
  lines.push("Violations by concept");
  lines.push(
    ...renderTable(
      ["concept", "notes (viol/total)", "violations"],
      ["left", "right", "right"],
      agg.concepts
        .filter((c) => c.violations > 0)
        .map((c) => [
          c.concept,
          `${c.notesWithViolations}/${c.notes}`,
          String(c.violations),
        ]),
    ),
  );

  if (opts.verbose && opts.notes) {
    const max = opts.maxPerConcept ?? 50;
    const byConcept = new Map<string, NoteReport[]>();
    for (const n of opts.notes) {
      if (n.violations.length === 0) continue;
      const arr = byConcept.get(n.concept) ?? [];
      arr.push(n);
      byConcept.set(n.concept, arr);
    }
    lines.push("");
    lines.push("Affected notes");
    for (const c of agg.concepts) {
      const arr = byConcept.get(c.concept);
      if (!arr || arr.length === 0) continue;
      lines.push("");
      lines.push(`  [${c.concept}] ${arr.length} note(s)`);
      for (const n of arr.slice(0, max)) {
        const summary = n.violations.map((v) => `${v.field}:${v.rule}`).join(", ");
        lines.push(`    ${n.notePath} — ${summary}`);
      }
      if (arr.length > max) {
        lines.push(`    … and ${arr.length - max} more`);
      }
    }
  }

  lines.push("");
  lines.push("All violations are warnings (onViolation: warn). Exit 0.");
  if (!opts.verbose) {
    lines.push("Run `oms doctor --verbose` to list affected notes.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Lint formatting (broken links + orphans)
// ---------------------------------------------------------------------------

export interface LintFormatOptions {
  vault: string;
  /** List every broken link and orphan instead of a capped summary. */
  verbose?: boolean;
  /** Max offending notes listed for broken links (default 20). */
  maxBroken?: number;
  /** Max orphan notes listed (default 20). */
  maxOrphans?: number;
}

export function formatLintReport(
  result: VaultLintResult,
  opts: LintFormatOptions,
): string {
  const byNote = new Map<string, string[]>();
  for (const { notePath, target } of result.brokenLinks) {
    const arr = byNote.get(notePath) ?? [];
    arr.push(target);
    byNote.set(notePath, arr);
  }
  const offenders = Array.from(byNote.entries())
    .map(([notePath, targets]) => ({ notePath, targets }))
    .sort(
      (a, b) =>
        b.targets.length - a.targets.length ||
        a.notePath.localeCompare(b.notePath),
    );

  const lines: string[] = [];
  lines.push("Oh My Second Brain lint — link & structure check");
  lines.push(`Vault: ${opts.vault}`);
  lines.push("");
  lines.push(`Scanned ${result.totalNotes} notes.`);
  lines.push(
    `${result.brokenLinks.length} broken wikilink(s) across ${offenders.length} note(s) · ${result.orphanPaths.length} orphan note(s).`,
  );

  if (result.brokenLinks.length > 0) {
    lines.push("");
    lines.push("Broken wikilinks — notes with the most dangling targets");
    const maxNotes = opts.verbose ? offenders.length : opts.maxBroken ?? 20;
    for (const o of offenders.slice(0, maxNotes)) {
      lines.push(`  ${o.notePath} (${o.targets.length})`);
      const targetMax = opts.verbose ? o.targets.length : 5;
      for (const t of o.targets.slice(0, targetMax)) {
        lines.push(`    -> [[${t}]]`);
      }
      if (o.targets.length > targetMax) {
        lines.push(`    … and ${o.targets.length - targetMax} more`);
      }
    }
    if (offenders.length > maxNotes) {
      lines.push(
        `  … and ${offenders.length - maxNotes} more note(s) with broken links`,
      );
    }
  } else {
    lines.push("");
    lines.push("Broken wikilinks: 0 ✓");
  }

  if (result.orphanPaths.length > 0) {
    lines.push("");
    lines.push(`Orphan notes (no incoming links): ${result.orphanPaths.length}`);
    const maxOrph = opts.verbose ? result.orphanPaths.length : opts.maxOrphans ?? 20;
    for (const p of result.orphanPaths.slice(0, maxOrph)) {
      lines.push(`  ${p}`);
    }
    if (result.orphanPaths.length > maxOrph) {
      lines.push(`  … and ${result.orphanPaths.length - maxOrph} more`);
    }
  } else {
    lines.push("");
    lines.push("Orphan notes: 0 ✓");
  }

  lines.push("");
  lines.push("Lint findings are warnings (non-blocking). Exit 0.");
  if (!opts.verbose) {
    lines.push("Run `oms lint --verbose` to list every finding.");
  }
  return lines.join("\n");
}
