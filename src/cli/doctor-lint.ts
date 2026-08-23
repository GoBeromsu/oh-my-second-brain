import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseNote } from "../kernel/conventions/frontmatter.js";
import { detectLinkIssues } from "../kernel/conventions/lint.js";
import {
  aggregateDoctor,
  formatDoctorReport,
  formatLintReport,
  type NoteReport,
} from "../kernel/conventions/report.js";
import { mapWithConcurrency, walkVaultMarkdown } from "../kernel/conventions/vault-walk.js";
import { validateFrontmatter } from "../kernel/conventions/validate.js";
import { loadOntology } from "../kernel/ontology/loader.js";
import { resolveConcept } from "../kernel/ontology/resolver.js";
import type { Concept } from "../kernel/ontology/types.js";
import { resolveBundledAssetPaths } from "../kernel/runtime/assets.js";

const bundledAssets = resolveBundledAssetPaths();

export async function runDoctor(opts: {
  vault: string;
  verbose?: boolean;
  json?: boolean;
  maxPerConcept?: number;
}): Promise<number> {
  const { vault } = opts;

  try {
    const localOntologyDir = path.join(vault, ".oms");
    let ontologyDir: string;
    try {
      await readdir(path.join(localOntologyDir, "concepts"));
      ontologyDir = localOntologyDir;
    } catch {
      ontologyDir = bundledAssets.ontologyDir;
    }

    const ontology = await loadOntology(ontologyDir);
    const candidates: { relPath: string; concept: Concept }[] = [];
    for await (const relPath of walkVaultMarkdown(vault)) {
      const concept = resolveConcept(ontology, relPath);
      if (concept) candidates.push({ relPath, concept });
    }

    const scanned = await mapWithConcurrency(
      candidates,
      64,
      async ({ relPath, concept }): Promise<NoteReport | null> => {
        try {
          const raw = await readFile(path.join(vault, relPath), "utf-8");
          const { frontmatter } = parseNote(raw);
          const result = validateFrontmatter(frontmatter, concept);
          return {
            notePath: relPath,
            concept: concept.concept,
            violations: result.violations,
          };
        } catch {
          console.warn(`[oms] Could not read ${relPath}`);
          return null;
        }
      },
    );
    const notes = scanned.filter((note): note is NoteReport => note !== null);

    const aggregate = aggregateDoctor(notes);
    if (opts.json) {
      console.log(JSON.stringify(aggregate, null, 2));
    } else {
      console.log(
        formatDoctorReport(aggregate, {
          vault,
          verbose: opts.verbose,
          maxPerConcept: opts.maxPerConcept,
          notes,
        }),
      );
    }
  } catch (err) {
    console.warn("[oms] doctor could not complete:", err);
  }

  return 0;
}

export async function runLint(opts: {
  vault: string;
  verbose?: boolean;
  json?: boolean;
}): Promise<number> {
  const { vault } = opts;

  try {
    const result = await detectLinkIssues(vault);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            totalNotes: result.totalNotes,
            brokenLinks: result.brokenLinks,
            orphanPaths: result.orphanPaths,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(formatLintReport(result, { vault, verbose: opts.verbose }));
    }
  } catch (err) {
    console.warn("[oms] lint could not complete:", err);
  }

  return 0;
}
