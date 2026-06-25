import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseNote } from "../conventions/frontmatter.js";
import { detectLinkIssues } from "../conventions/lint.js";
import {
  aggregateDoctor,
  formatDoctorReport,
  formatLintReport,
  type NoteReport,
} from "../conventions/report.js";
import { validateFrontmatter } from "../conventions/validate.js";
import { loadOntology } from "../ontology/loader.js";
import { resolveConcept } from "../ontology/resolver.js";
import { resolveBundledAssetPaths } from "../runtime/assets.js";

const bundledAssets = resolveBundledAssetPaths();

async function* walkMarkdown(
  dir: string,
  base: string,
  skipDirs: Set<string>,
): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(full, base, skipDirs);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield path.relative(base, full).replace(/\\/g, "/");
    }
  }
}

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
    const skipDirs = new Set(["node_modules"]);
    const notes: NoteReport[] = [];

    for await (const relPath of walkMarkdown(vault, vault, skipDirs)) {
      const concept = resolveConcept(ontology, relPath);
      if (!concept) continue;

      const fullPath = path.join(vault, relPath);
      let raw: string;
      try {
        raw = await readFile(fullPath, "utf-8");
      } catch {
        console.warn(`[oms] Could not read ${relPath}`);
        continue;
      }

      const { frontmatter } = parseNote(raw);
      const result = validateFrontmatter(frontmatter, concept);
      notes.push({
        notePath: relPath,
        concept: concept.concept,
        violations: result.violations,
      });
    }

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
