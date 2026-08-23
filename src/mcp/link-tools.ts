/**
 * MCP wiring for the linkify core: vault I/O + candidate universe for the
 * `oms_link_suggest` / `oms_link_apply` tools.
 *
 * The linkify core (mask → suggest → apply) is pure and dependency-injected; it
 * knows nothing about vaults, ontologies, or the filesystem. This module owns
 * exactly that translation and nothing else, so server.ts stays a dispatcher.
 *
 * Candidate identity is DERIVED, never cached. A candidate id is its body span,
 * and apply re-runs the same deterministic suggest pass over the note as it
 * exists right now. Two consequences that matter: the server holds no
 * cross-call state (a restart changes nothing), and a note edited between
 * suggest and apply is caught by the base-hash check the kernel-facing
 * `applyLinks` performs before any write.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { safeVaultNotePath, writeNote } from "../kernel/capture/safe.js";
import { parseNote } from "../kernel/conventions/frontmatter.js";
import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";
import { resolveConcept } from "../kernel/ontology/resolver.js";
import type { Ontology } from "../kernel/ontology/types.js";
import { applyLinks, hashBody, type ApplyResult } from "../kernel/engine/linkify/apply.js";
import { suggestLinks, TERM_CONCEPT, termBoundNotes } from "../kernel/engine/linkify/suggest.js";
import type { LinkCandidate, TermNote } from "../kernel/engine/linkify/types.js";

/** A candidate as the MCP surface reports it: the core shape plus a stable id. */
export interface IdentifiedCandidate extends LinkCandidate {
  /** Deterministic handle a client passes back to `oms_link_apply`. */
  readonly id: string;
}

/** Payload of a successful `oms_link_suggest` call. */
export interface LinkSuggestion {
  readonly notePath: string;
  /** sha256 of the body the candidates were computed against (apply's token). */
  readonly baseContentHash: string;
  readonly candidateNotes: number;
  readonly candidates: readonly IdentifiedCandidate[];
}

/** Everything both link tools need to address a vault note. */
export interface LinkToolTarget {
  readonly vault: string;
  readonly source: WriteTargetSource;
  readonly ontology: Ontology;
  /** Vault-relative markdown path of the note being linkified. */
  readonly notePath: string;
}

/** Restrict the candidate universe to one top-level vault folder. */
export interface LinkScope {
  readonly folder?: string | undefined;
}

/** A candidate id is the body span it claims — stable across identical bodies. */
function candidateId(candidate: LinkCandidate): string {
  return `${String(candidate.startOffset)}-${String(candidate.endOffset)}`;
}

function identify(candidate: LinkCandidate): IdentifiedCandidate {
  return { ...candidate, id: candidateId(candidate) };
}

/** Walk vault markdown, skipping dotted, dependency, and internal directories. */
async function* walkMarkdown(dir: string, base: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(full, base);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield path.relative(base, full).replace(/\\/g, "/");
    }
  }
}

/** Flatten a frontmatter `aliases` value to trimmed non-empty strings. */
function aliasStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(aliasStrings);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

/**
 * Every `term`-bound note in the vault, with its declared surface forms.
 *
 * Concept binding comes from the ontology's folder contract (the same resolver
 * the write kernel uses), NOT from a frontmatter field a note can claim for
 * itself — a note cannot opt into being a link target by asserting it is one.
 */
export async function collectTermNotes(
  vault: string,
  ontology: Ontology,
  scope: LinkScope = {},
): Promise<TermNote[]> {
  const root = scope.folder === undefined ? vault : path.join(vault, scope.folder);
  const notes: TermNote[] = [];
  for await (const notePath of walkMarkdown(root, vault)) {
    const concept = resolveConcept(ontology, notePath);
    if (concept?.concept !== TERM_CONCEPT) continue;
    const raw = await readFile(path.join(vault, notePath), "utf-8");
    notes.push({
      path: notePath,
      concept: concept.concept,
      aliases: aliasStrings(parseNote(raw).frontmatter["aliases"]),
    });
  }
  return termBoundNotes(notes);
}

/** Read one vault note's body, refusing unsafe paths and missing files loudly. */
async function readNoteBody(vault: string, notePath: string): Promise<{ normalized: string; body: string }> {
  const fullPath = safeVaultNotePath(vault, notePath);
  const raw = await readFile(fullPath, "utf-8");
  return {
    normalized: path.relative(vault, fullPath).replace(/\\/g, "/"),
    body: parseNote(raw).body,
  };
}

/**
 * Propose `[[wikilink]]` insertions for one note against the vault's term notes.
 *
 * Read-only: nothing is written and no state is retained. The returned
 * `baseContentHash` is the caller's optimistic-concurrency token for apply.
 */
export async function suggestLinksForNote(
  target: LinkToolTarget,
  scope: LinkScope = {},
): Promise<LinkSuggestion> {
  const { normalized, body } = await readNoteBody(target.vault, target.notePath);
  const notes = await collectTermNotes(target.vault, target.ontology, scope);
  const candidates = suggestLinks(body, notes, { notePath: normalized });
  return {
    notePath: normalized,
    baseContentHash: hashBody(body),
    candidateNotes: notes.length,
    candidates: candidates.map(identify),
  };
}

/** Payload of an `oms_link_apply` call: the core result plus what was selected. */
export interface LinkApplyOutcome {
  readonly notePath: string;
  readonly requestedIds: readonly string[];
  /** Requested ids that still name a live span in the note's current body. */
  readonly resolvedIds: readonly string[];
  readonly result: ApplyResult;
}

/**
 * Apply the selected candidates to a note and persist through the write kernel.
 *
 * The candidates are recomputed from the note's CURRENT body: ids that no
 * longer name a span simply do not resolve, and a body that drifted since
 * suggest fails the `baseContentHash` check inside `applyLinks` before any
 * write is attempted.
 */
export async function applyLinksForNote(
  target: LinkToolTarget,
  selection: { readonly baseContentHash: string; readonly candidateIds: readonly string[] },
  scope: LinkScope = {},
): Promise<LinkApplyOutcome> {
  const { normalized, body } = await readNoteBody(target.vault, target.notePath);
  const notes = await collectTermNotes(target.vault, target.ontology, scope);
  const wanted = new Set(selection.candidateIds);
  const accepted = suggestLinks(body, notes, { notePath: normalized }).filter((candidate) =>
    wanted.has(candidateId(candidate)),
  );

  const result = await applyLinks({
    body,
    baseContentHash: selection.baseContentHash,
    accepted,
    writeNote,
    target: {
      target: { vault: target.vault, source: target.source },
      ontology: target.ontology,
      notePath: normalized,
    },
  });

  return {
    notePath: normalized,
    requestedIds: selection.candidateIds,
    resolvedIds: accepted.map(candidateId),
    result,
  };
}

/** The MCP-facing JSON shape of an apply outcome: applied body + receipt, or a typed refusal. */
export function linkApplyPayload(outcome: LinkApplyOutcome): Record<string, unknown> {
  const common = {
    notePath: outcome.notePath,
    requestedIds: outcome.requestedIds,
    resolvedIds: outcome.resolvedIds,
  };
  const result = outcome.result;
  return result.applied
    ? {
        ...common,
        applied: true,
        contentHash: result.contentHash,
        body: result.body,
        receipt: result.write.receipt ?? null,
      }
    : {
        ...common,
        applied: false,
        reason: result.reason,
        write: result.write ?? null,
      };
}
