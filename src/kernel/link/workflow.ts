import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { safeVaultNotePath } from "../capture/safe.js";
import { parseNote } from "../conventions/frontmatter.js";
import { managedSourceExclusionMatcher } from "../conventions/note-exclude.js";
import type { WriteTargetSource } from "../conventions/write-protocol.js";
import { mapWithConcurrency, walkVaultMarkdown } from "../conventions/vault-walk.js";
import { suggestLinks } from "../engine/linkify/suggest.js";
import type { LinkCandidate, TermNote } from "../engine/linkify/types.js";

/**
 * Link suggestion and checking are read-only.
 *
 * The agent edits note bodies; OMS proposes wikilinks and reports link health.
 * Nothing here writes a note, and no note is skipped for being unbound,
 * incomplete, or in violation of its contract.
 */

const READ_CONCURRENCY = 16;

export interface ScannedLinkNote {
  readonly path: string;
  readonly body: string;
  /** Null when the note declares no known template. It is still linkable. */
  readonly templateId: string | null;
  readonly aliases: readonly string[];
  readonly diagnostics: readonly string[];
}

export interface LinkWorkflowTarget {
  readonly vault: string;
  readonly source: WriteTargetSource;
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
  readonly diagnostics: readonly string[];
}

export type LinkTargetState = "resolved" | "unresolved" | "ambiguous";

export interface CheckedLink {
  readonly target: string;
  readonly state: LinkTargetState;
  readonly matches: readonly string[];
}

export interface LinkCheckReport {
  readonly notePath: string;
  readonly links: readonly CheckedLink[];
  readonly unresolved: readonly string[];
  readonly ambiguous: readonly string[];
  readonly diagnostics: readonly string[];
}

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/gu;

function aliasStrings(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(aliasStrings);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

function inScope(notePath: string, folder: string | undefined): boolean {
  return folder === undefined || notePath === folder || notePath.startsWith(`${folder}/`);
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

function noteTitle(notePath: string): string {
  return notePath.replace(/\.md$/u, "").split("/").pop() ?? notePath;
}

/** Scans every ordinary note. Malformed frontmatter is a diagnostic, not an exclusion. */
export async function scanLinkNotes(vault: string, scope: LinkScope = {}): Promise<ScannedLinkNote[]> {
  const isExcluded = await managedSourceExclusionMatcher(vault);
  const paths: string[] = [];
  for await (const notePath of walkVaultMarkdown(vault)) if (!(await isExcluded(notePath))) paths.push(notePath);
  const scanned = await mapWithConcurrency(paths, READ_CONCURRENCY, async (notePath) => {
    const raw = await readFile(path.join(vault, notePath), "utf-8");
    const parsed = parseNote(raw);
    const identity = parsed.frontmatter["template"];
    return {
      path: notePath,
      body: parsed.diagnostics.length > 0 ? raw : parsed.body,
      templateId: typeof identity === "string" ? identity : null,
      aliases: aliasStrings(parsed.frontmatter["aliases"]),
      diagnostics: parsed.diagnostics.map(diagnostic => diagnostic.code),
    } satisfies ScannedLinkNote;
  });
  return scanned.filter(note => inScope(note.path, scope.folder));
}

async function readLinkNote(vault: string, notePath: string): Promise<ScannedLinkNote> {
  const fullPath = safeVaultNotePath(vault, notePath);
  const raw = await readFile(fullPath, "utf-8");
  const normalized = path.relative(vault, fullPath).replace(/\\/g, "/");
  if (await (await managedSourceExclusionMatcher(vault))(normalized)) {
    throw new Error(`Managed template source cannot be linked as a note: ${normalized}`);
  }
  const parsed = parseNote(raw);
  const identity = parsed.frontmatter["template"];
  return {
    path: normalized,
    body: parsed.diagnostics.length > 0 ? raw : parsed.body,
    templateId: typeof identity === "string" ? identity : null,
    aliases: aliasStrings(parsed.frontmatter["aliases"]),
    diagnostics: parsed.diagnostics.map(diagnostic => diagnostic.code),
  };
}

export async function collectTermNotes(vault: string, scope: LinkScope = {}): Promise<TermNote[]> {
  return (await scanLinkNotes(vault, scope)).map(toTermNote);
}

/** Proposes wikilinks for a saved note. It returns candidates and writes nothing. */
export async function suggestLinksForNote(target: LinkWorkflowTarget, scope: LinkScope = {}): Promise<LinkSuggestion> {
  const note = await readLinkNote(target.vault, target.notePath);
  const notes = await collectTermNotes(target.vault, scope);
  return {
    notePath: note.path,
    baseContentHash: hashBody(note.body),
    candidateNotes: notes.length,
    candidates: suggestLinks(note.body, notes, { notePath: note.path }).map(identify),
    diagnostics: note.diagnostics,
  };
}

/**
 * Reports whether each wikilink in a saved note resolves. This is link health,
 * not a completion verdict, and it never repairs the note.
 */
export async function checkLinksForNote(target: LinkWorkflowTarget, scope: LinkScope = {}): Promise<LinkCheckReport> {
  const note = await readLinkNote(target.vault, target.notePath);
  const universe = await scanLinkNotes(target.vault, scope);
  const byTitle = new Map<string, string[]>();
  for (const candidate of universe) {
    for (const key of [candidate.path, candidate.path.replace(/\.md$/u, ""), noteTitle(candidate.path), ...candidate.aliases]) {
      const normalizedKey = key.normalize("NFC");
      byTitle.set(normalizedKey, [...(byTitle.get(normalizedKey) ?? []), candidate.path]);
    }
  }
  const links: CheckedLink[] = [];
  for (const match of note.body.matchAll(WIKILINK)) {
    const raw = (match[1] ?? "").trim();
    if (raw === "") continue;
    const matches = [...new Set(byTitle.get(raw.normalize("NFC")) ?? [])].sort();
    links.push({
      target: raw,
      state: matches.length === 0 ? "unresolved" : matches.length === 1 ? "resolved" : "ambiguous",
      matches,
    });
  }
  return {
    notePath: note.path,
    links,
    unresolved: links.filter(link => link.state === "unresolved").map(link => link.target),
    ambiguous: links.filter(link => link.state === "ambiguous").map(link => link.target),
    diagnostics: note.diagnostics,
  };
}
