import { realpath } from "node:fs/promises";
import { loadResolvedTemplates, type ResolvedTemplateSnapshot } from "./resolver.js";
import type { Digest, ManagedTemplatePath, TemplateId, TemplateSourcePath } from "./types.js";

/**
 * Approved markdown and raw-source identity for a later interview.
 * Raw bytes are identified by digest only. Their syntax is not parsed or executed.
 */

export interface TemplateApprovedEvidence {
  readonly templateId: TemplateId | null;
  readonly templatePath: ManagedTemplatePath;
  readonly approvedMarkdown: string;
  readonly approvedMarkdownDigest: Digest;
}

export interface TemplateRawEvidence {
  readonly templateId: TemplateId;
  readonly path: TemplateSourcePath;
  readonly identity: string;
  readonly approvedRawDigest: Digest;
  readonly observedRawDigest: Digest | null;
  readonly drift: "SOURCE_DRIFT" | null;
}

export interface TemplateReviewContext {
  readonly vault: string;
  readonly resolved: ResolvedTemplateSnapshot;
  readonly approved: readonly TemplateApprovedEvidence[];
  readonly raw: readonly TemplateRawEvidence[];
}

function compareText(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0) ?? 0);
  const b = Array.from(right, character => character.codePointAt(0) ?? 0);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function approvedEvidence(snapshot: ResolvedTemplateSnapshot): readonly TemplateApprovedEvidence[] {
  const rows: TemplateApprovedEvidence[] = [{
    templateId: null,
    templatePath: snapshot.defaultContract.approved.defaultLayer.templatePath,
    approvedMarkdown: snapshot.defaultContract.approved.defaultLayer.approvedMarkdown,
    approvedMarkdownDigest: snapshot.defaultContract.approved.defaultLayer.approvedMarkdownDigest,
  }];
  for (const templateId of Object.keys(snapshot.templates).sort(compareText)) {
    const contract = snapshot.templates[templateId];
    const layer = contract?.approved.templateLayer;
    if (contract === undefined || layer === undefined || contract.templateId === null) continue;
    rows.push({
      templateId: contract.templateId,
      templatePath: layer.templatePath,
      approvedMarkdown: layer.approvedMarkdown,
      approvedMarkdownDigest: layer.approvedMarkdownDigest,
    });
  }
  return rows;
}

function rawEvidence(snapshot: ResolvedTemplateSnapshot): readonly TemplateRawEvidence[] {
  return snapshot.sources.map(source => ({
    templateId: source.templateId,
    path: source.source.path,
    identity: source.source.identity,
    approvedRawDigest: source.source.rawDigest,
    observedRawDigest: source.observedRawDigest,
    drift: source.drift,
  }));
}

export async function readTemplateReviewContext(vault: string): Promise<TemplateReviewContext> {
  const root = await realpath(vault);
  const resolved = await loadResolvedTemplates(root);
  return {
    vault: resolved.vault,
    resolved,
    approved: approvedEvidence(resolved),
    raw: rawEvidence(resolved),
  };
}
