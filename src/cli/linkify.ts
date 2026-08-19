/**
 * `oms linkify` — batch retrofit of `[[wikilinks]]` over EXISTING vault notes.
 *
 * Report-only by default. Mutation requires BOTH `--apply` and `--yes`, checked
 * before any note is read, so a half-typed command can never reach the disk.
 *
 * The command owns scope and reporting only: span detection stays in
 * engine/linkify (pure), and every write goes through the capture kernel's
 * `writeNote`, which keeps path safety, the concept contract, and the
 * postcondition read-back unduplicated here.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseNote } from "../conventions/frontmatter.js";
import { mapWithConcurrency, walkVaultMarkdown } from "../conventions/vault-walk.js";
import { writeNote } from "../capture/safe.js";
import { resolveConcept } from "../core/ontology/resolver.js";
import type { Ontology } from "../core/ontology/types.js";
import { applyLinks, hashBody } from "../engine/linkify/apply.js";
import { suggestLinks, termBoundNotes } from "../engine/linkify/suggest.js";
import type { LinkCandidate, TermNote } from "../engine/linkify/types.js";
import { validateVaultLintFolder } from "../engine/conventions/vault-lint.js";
import { resolveActiveOntology } from "../ontology/active.js";

/** Parallel note reads; the walk itself is cheap, contents are the hot cost. */
const READ_CONCURRENCY = 16;

export interface LinkifyOptions {
  readonly vault: string;
  /** Restrict both scan and writes to one top-level vault folder. */
  readonly folder?: string;
  readonly apply: boolean;
  readonly yes: boolean;
}

/** One scanned note: its path, its body, and the term surfaces it exposes. */
interface ScannedNote {
  readonly path: string;
  readonly body: string;
  readonly concept: string | null;
  readonly aliases: readonly string[];
}

/** Flatten an unknown frontmatter `aliases` value to trimmed non-empty strings. */
function aliasStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(aliasStrings);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

/** Read every markdown note in the vault, parsed into body + surface forms. */
async function scanVault(vault: string, ontology: Ontology): Promise<ScannedNote[]> {
  const paths: string[] = [];
  for await (const notePath of walkVaultMarkdown(vault)) paths.push(notePath);

  return mapWithConcurrency(paths, READ_CONCURRENCY, async (notePath) => {
    const raw = await readFile(path.join(vault, notePath), "utf-8");
    const parsed = parseNote(raw);
    return {
      path: notePath,
      body: parsed.body,
      concept: resolveConcept(ontology, notePath)?.concept ?? null,
      aliases: aliasStrings(parsed.frontmatter["aliases"]),
    };
  });
}

/** True when `notePath` sits inside `folder` (or when no scope was requested). */
function inScope(notePath: string, folder: string | undefined): boolean {
  return folder === undefined || notePath.startsWith(`${folder}/`);
}

function toTermNote(note: ScannedNote): TermNote {
  return { path: note.path, concept: note.concept, aliases: note.aliases };
}

function describeCandidate(candidate: LinkCandidate): string {
  const ambiguity = candidate.ambiguous ? ` (ambiguous: ${candidate.rivalPaths.join(", ")})` : "";
  return `    ${candidate.matchedText} → ${candidate.renderedReplacement}  [${candidate.targetPath}]${ambiguity}`;
}

/** Print one note's proposals; returns how many candidates it had. */
function reportNote(notePath: string, candidates: readonly LinkCandidate[]): void {
  console.log(`\n  ${notePath}`);
  for (const candidate of candidates) console.log(describeCandidate(candidate));
}

/** Persist one note's candidates through the capture kernel. */
async function applyNote(
  vault: string,
  ontology: Ontology,
  note: ScannedNote,
  candidates: readonly LinkCandidate[],
): Promise<boolean> {
  const result = await applyLinks({
    body: note.body,
    baseContentHash: hashBody(note.body),
    accepted: candidates,
    writeNote,
    target: { target: { vault, source: "explicit" }, ontology, notePath: note.path },
  });
  if (result.applied) return true;
  console.error(`[oms] linkify skipped ${note.path}: ${result.reason}`);
  return false;
}

/**
 * Scan (and optionally link) a vault, restricting link TARGETS to notes bound
 * to the `term` concept.
 */
export async function runLinkify(options: LinkifyOptions): Promise<number> {
  if (options.apply && !options.yes) {
    console.error("[oms] linkify --apply rewrites notes in place; re-run with --yes to confirm. Nothing was written.");
    return 1;
  }

  try {
    const { ontology } = await resolveActiveOntology(options.vault);
    await validateVaultLintFolder(options.vault, ontology, options.folder);

    const notes = await scanVault(options.vault, ontology);
    const targets = termBoundNotes(notes.map(toTermNote));
    const scoped = notes.filter((note) => inScope(note.path, options.folder));

    console.log(
      `\nOh My Second Brain linkify: ${String(scoped.length)} note(s) in scope, ${String(targets.length)} term note(s) available as link targets.`,
    );

    let candidateCount = 0;
    let appliedNotes = 0;
    for (const note of scoped) {
      const candidates = suggestLinks(note.body, targets, { notePath: note.path });
      if (candidates.length === 0) continue;
      candidateCount += candidates.length;
      reportNote(note.path, candidates);
      if (options.apply && (await applyNote(options.vault, ontology, note, candidates))) {
        appliedNotes++;
      }
    }

    console.log(
      options.apply
        ? `\n${String(candidateCount)} candidate(s); applied to ${String(appliedNotes)} note(s).\n`
        : `\n${String(candidateCount)} candidate(s) proposed across ${String(scoped.length)} note(s). Report only — nothing was written. Re-run with --apply --yes to write.\n`,
    );
    return 0;
  } catch (error) {
    console.error(`[oms] linkify could not complete: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
