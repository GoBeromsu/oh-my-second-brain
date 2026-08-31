import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { safeVaultNotePath, writeResolvedTemplateNote, type TemplateWriteResult } from "../capture/safe.js";
import { parseNote } from "../conventions/frontmatter.js";
import { managedSourceExclusionMatcher } from "../conventions/note-exclude.js";
import type { WriteTargetSource } from "../conventions/write-protocol.js";
import { mapWithConcurrency, walkVaultMarkdown } from "../conventions/vault-walk.js";
import { suggestLinks } from "../engine/linkify/suggest.js";
import type { LinkCandidate, TermNote } from "../engine/linkify/types.js";
import type { ResolvedConvention } from "../templates/types.js";

const READ_CONCURRENCY = 16;

export interface ScannedLinkNote {
  readonly path: string;
  readonly body: string;
  readonly templateId: string;
  readonly aliases: readonly string[];
}

export interface LinkWorkflowTarget {
  readonly vault: string;
  readonly source: WriteTargetSource;
  readonly convention: ResolvedConvention;
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

export type LinkApplyResult =
  | { readonly applied: true; readonly body: string; readonly contentHash: string; readonly write: TemplateWriteResult }
  | { readonly applied: false; readonly reason: "note-changed" | "no-candidates" | "candidate-drift" | "overlapping-candidates" | "write-rejected"; readonly write?: TemplateWriteResult };

export interface LinkApplyOutcome {
  readonly notePath: string;
  readonly requestedIds: readonly string[];
  readonly resolvedIds: readonly string[];
  readonly result: LinkApplyResult;
}

export interface BatchLinkifyResult {
  readonly notesInScope: number;
  readonly targetNotes: number;
  readonly candidates: readonly { readonly notePath: string; readonly candidates: readonly LinkCandidate[]; readonly outcome?: LinkApplyOutcome }[];
}

function aliasStrings(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(aliasStrings);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

function inScope(notePath: string, folder: string | undefined): boolean {
  return folder === undefined || notePath === folder || notePath.startsWith(`${folder}/`);
}

function templateId(frontmatter: Readonly<Record<string, unknown>>, convention: ResolvedConvention, notePath: string): string {
  const value = frontmatter["template"];
  if (typeof value !== "string" || convention.templates[value] === undefined) {
    throw new Error(`Link target ${notePath} must declare a known stable template identity.`);
  }
  return value;
}

function toTermNote(note: ScannedLinkNote): TermNote {
  return { path: note.path, aliases: note.aliases };
}

function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf-8").digest("hex");
}

export function linkCandidateId(candidate: LinkCandidate): string {
  return `${String(candidate.startOffset)}-${String(candidate.endOffset)}`;
}

function identify(candidate: LinkCandidate): IdentifiedLinkCandidate {
  return { ...candidate, id: linkCandidateId(candidate) };
}

export async function scanLinkNotes(vault: string, convention: ResolvedConvention): Promise<ScannedLinkNote[]> {
  const isExcluded = await managedSourceExclusionMatcher(vault, convention.managedSourcePaths);
  const paths: string[] = [];
  for await (const notePath of walkVaultMarkdown(vault)) if (!(await isExcluded(notePath))) paths.push(notePath);
  const scanned = await mapWithConcurrency(paths, READ_CONCURRENCY, async (notePath) => {
    const raw = await readFile(path.join(vault, notePath), "utf-8");
    const parsed = parseNote(raw);
    const value = parsed.frontmatter["template"];
    if (typeof value !== "string" || convention.templates[value] === undefined) return undefined;
    return { path: notePath, body: parsed.body, templateId: value, aliases: aliasStrings(parsed.frontmatter["aliases"]) };
  });
  return scanned.filter((note): note is ScannedLinkNote => note !== undefined);
}

async function readLinkNote(vault: string, convention: ResolvedConvention, notePath: string): Promise<{ normalized: string; body: string; templateId: string }> {
  const fullPath = safeVaultNotePath(vault, notePath);
  const raw = await readFile(fullPath, "utf-8");
  const normalized = path.relative(vault, fullPath).replace(/\\/g, "/");
  if (await (await managedSourceExclusionMatcher(vault, convention.managedSourcePaths))(normalized)) {
    throw new Error(`Managed template source cannot be linked as a note: ${normalized}`);
  }
  const parsed = parseNote(raw);
  return { normalized, body: parsed.body, templateId: templateId(parsed.frontmatter, convention, normalized) };
}

export async function collectTermNotes(vault: string, convention: ResolvedConvention, scope: LinkScope = {}): Promise<TermNote[]> {
  const notes = await scanLinkNotes(vault, convention);
  return notes.filter((note) => inScope(note.path, scope.folder)).map(toTermNote);
}

export async function suggestLinksForNote(target: LinkWorkflowTarget, scope: LinkScope = {}): Promise<LinkSuggestion> {
  const { normalized, body } = await readLinkNote(target.vault, target.convention, target.notePath);
  const notes = await collectTermNotes(target.vault, target.convention, scope);
  return { notePath: normalized, baseContentHash: hashBody(body), candidateNotes: notes.length, candidates: suggestLinks(body, notes, { notePath: normalized }).map(identify) };
}

function applyCandidates(body: string, baseContentHash: string, accepted: readonly LinkCandidate[]): { readonly body?: string; readonly reason?: Extract<LinkApplyResult, { readonly applied: false }>["reason"] } {
  if (hashBody(body) !== baseContentHash) return { reason: "note-changed" };
  if (accepted.length === 0) return { reason: "no-candidates" };
  const sorted = accepted.slice().sort((left, right) => left.startOffset - right.startOffset);
  if (sorted.some((candidate, index) => index > 0 && candidate.startOffset < sorted[index - 1]!.endOffset)) return { reason: "overlapping-candidates" };
  if (sorted.some((candidate) => body.slice(candidate.startOffset, candidate.endOffset) !== candidate.matchedText)) return { reason: "candidate-drift" };
  return { body: sorted.reduceRight((result, candidate) => result.slice(0, candidate.startOffset) + candidate.renderedReplacement + result.slice(candidate.endOffset), body) };
}

export async function applyLinksForNote(
  target: LinkWorkflowTarget,
  selection: { readonly baseContentHash: string; readonly candidateIds: readonly string[] },
  scope: LinkScope = {},
): Promise<LinkApplyOutcome> {
  const { normalized, body } = await readLinkNote(target.vault, target.convention, target.notePath);
  const notes = await collectTermNotes(target.vault, target.convention, scope);
  const wanted = new Set(selection.candidateIds);
  const accepted = suggestLinks(body, notes, { notePath: normalized }).filter((candidate) => wanted.has(linkCandidateId(candidate)));
  const applied = applyCandidates(body, selection.baseContentHash, accepted);
  if (applied.reason !== undefined) return { notePath: normalized, requestedIds: selection.candidateIds, resolvedIds: accepted.map(linkCandidateId), result: { applied: false, reason: applied.reason } };
  const write = await writeResolvedTemplateNote({ target: { vault: target.vault, source: target.source }, convention: target.convention, notePath: normalized, mode: "update", dryRun: false, body: applied.body! });
  const result: LinkApplyResult = write.status === "written"
    ? { applied: true, body: applied.body!, contentHash: hashBody(applied.body!), write }
    : { applied: false, reason: "write-rejected", write };
  return { notePath: normalized, requestedIds: selection.candidateIds, resolvedIds: accepted.map(linkCandidateId), result };
}

export async function linkifyVault(
  target: Omit<LinkWorkflowTarget, "notePath">,
  options: { readonly folder?: string; readonly apply: boolean },
): Promise<BatchLinkifyResult> {
  const notes = await scanLinkNotes(target.vault, target.convention);
  const targets = notes.map(toTermNote);
  const scoped = notes.filter((note) => inScope(note.path, options.folder));
  const candidates = [] as { notePath: string; candidates: readonly LinkCandidate[]; outcome?: LinkApplyOutcome }[];
  for (const note of scoped) {
    const proposed = suggestLinks(note.body, targets, { notePath: note.path });
    if (proposed.length === 0) continue;
    const outcome = options.apply
      ? await applyLinksForNote({ ...target, notePath: note.path }, { baseContentHash: hashBody(note.body), candidateIds: proposed.map(linkCandidateId) }, { folder: options.folder })
      : undefined;
    candidates.push({ notePath: note.path, candidates: proposed, ...(outcome === undefined ? {} : { outcome }) });
  }
  return { notesInScope: scoped.length, targetNotes: targets.length, candidates };
}
