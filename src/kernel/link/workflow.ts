import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeNote, safeVaultNotePath } from "../capture/safe.js";
import { parseNote } from "../conventions/frontmatter.js";
import type { WriteTargetSource } from "../conventions/write-protocol.js";
import { mapWithConcurrency, walkVaultMarkdown } from "../conventions/vault-walk.js";
import { applyLinks, hashBody, type ApplyResult } from "../engine/linkify/apply.js";
import { suggestLinks, TERM_CONCEPT, termBoundNotes } from "../engine/linkify/suggest.js";
import type { LinkCandidate, TermNote } from "../engine/linkify/types.js";
import { resolveConcept } from "../ontology/resolver.js";
import type { Ontology } from "../ontology/types.js";

const READ_CONCURRENCY = 16;

export interface ScannedLinkNote {
  readonly path: string;
  readonly body: string;
  readonly concept: string | null;
  readonly aliases: readonly string[];
}

export interface LinkWorkflowTarget {
  readonly vault: string;
  readonly source: WriteTargetSource;
  readonly ontology: Ontology;
  readonly notePath: string;
}

export interface LinkScope {
  readonly folder?: string | undefined;
}

export interface IdentifiedLinkCandidate extends LinkCandidate {
  readonly id: string;
}

export interface LinkSuggestion {
  readonly notePath: string;
  readonly baseContentHash: string;
  readonly candidateNotes: number;
  readonly candidates: readonly IdentifiedLinkCandidate[];
}

export interface LinkApplyOutcome {
  readonly notePath: string;
  readonly requestedIds: readonly string[];
  readonly resolvedIds: readonly string[];
  readonly result: ApplyResult;
}

export interface BatchLinkifyResult {
  readonly notesInScope: number;
  readonly targetNotes: number;
  readonly candidates: readonly { readonly notePath: string; readonly candidates: readonly LinkCandidate[]; readonly outcome?: LinkApplyOutcome }[];
}

function aliasStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(aliasStrings);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

function inScope(notePath: string, folder: string | undefined): boolean {
  return folder === undefined || notePath.startsWith(`${folder}/`);
}

function toTermNote(note: ScannedLinkNote): TermNote {
  return { path: note.path, concept: note.concept, aliases: note.aliases };
}

export function linkCandidateId(candidate: LinkCandidate): string {
  return `${String(candidate.startOffset)}-${String(candidate.endOffset)}`;
}

function identify(candidate: LinkCandidate): IdentifiedLinkCandidate {
  return { ...candidate, id: linkCandidateId(candidate) };
}

export async function scanLinkNotes(vault: string, ontology: Ontology): Promise<ScannedLinkNote[]> {
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

async function readLinkNote(vault: string, notePath: string): Promise<{ normalized: string; body: string }> {
  const fullPath = safeVaultNotePath(vault, notePath);
  const raw = await readFile(fullPath, "utf-8");
  return { normalized: path.relative(vault, fullPath).replace(/\\/g, "/"), body: parseNote(raw).body };
}

export async function collectTermNotes(vault: string, ontology: Ontology, scope: LinkScope = {}): Promise<TermNote[]> {
  const notes = await scanLinkNotes(vault, ontology);
  return termBoundNotes(notes.filter((note) => inScope(note.path, scope.folder)).map(toTermNote));
}

export async function suggestLinksForNote(target: LinkWorkflowTarget, scope: LinkScope = {}): Promise<LinkSuggestion> {
  const { normalized, body } = await readLinkNote(target.vault, target.notePath);
  const notes = await collectTermNotes(target.vault, target.ontology, scope);
  return {
    notePath: normalized,
    baseContentHash: hashBody(body),
    candidateNotes: notes.length,
    candidates: suggestLinks(body, notes, { notePath: normalized }).map(identify),
  };
}

export async function applyLinksForNote(
  target: LinkWorkflowTarget,
  selection: { readonly baseContentHash: string; readonly candidateIds: readonly string[] },
  scope: LinkScope = {},
): Promise<LinkApplyOutcome> {
  const { normalized, body } = await readLinkNote(target.vault, target.notePath);
  const notes = await collectTermNotes(target.vault, target.ontology, scope);
  const wanted = new Set(selection.candidateIds);
  const accepted = suggestLinks(body, notes, { notePath: normalized }).filter((candidate) => wanted.has(linkCandidateId(candidate)));
  const result = await applyLinks({
    body,
    baseContentHash: selection.baseContentHash,
    accepted,
    writeNote,
    target: { target: { vault: target.vault, source: target.source }, ontology: target.ontology, notePath: normalized },
  });
  return { notePath: normalized, requestedIds: selection.candidateIds, resolvedIds: accepted.map(linkCandidateId), result };
}

export async function linkifyVault(
  target: Omit<LinkWorkflowTarget, "notePath">,
  options: { readonly folder?: string; readonly apply: boolean },
): Promise<BatchLinkifyResult> {
  const notes = await scanLinkNotes(target.vault, target.ontology);
  const targets = termBoundNotes(notes.map(toTermNote));
  const scoped = notes.filter((note) => inScope(note.path, options.folder));
  const candidates = [] as { notePath: string; candidates: readonly LinkCandidate[]; outcome?: LinkApplyOutcome }[];
  for (const note of scoped) {
    const proposed = suggestLinks(note.body, targets, { notePath: note.path });
    if (proposed.length === 0) continue;
    let outcome: LinkApplyOutcome | undefined;
    if (options.apply) {
      const result = await applyLinks({
        body: note.body,
        baseContentHash: hashBody(note.body),
        accepted: proposed,
        writeNote,
        target: { target: { vault: target.vault, source: target.source }, ontology: target.ontology, notePath: note.path },
      });
      outcome = {
        notePath: note.path,
        requestedIds: proposed.map(linkCandidateId),
        resolvedIds: proposed.map(linkCandidateId),
        result,
      };
    }
    candidates.push({ notePath: note.path, candidates: proposed, outcome });
  }
  return { notesInScope: scoped.length, targetNotes: targets.length, candidates };
}
