import path from "node:path";
import { admitWriteTarget } from "../capture/safe.js";
import { recordGaps, writeGapDraft, type GapLedgerDeps } from "../contract/gap-ledger.js";
import { decideWrite, resolveWriteTarget } from "../contract/judge-write.js";
import { storeRoot } from "../contract/store.js";
import type { Violation } from "../contract/types.js";
import { resolveSealState, type SealState } from "../contract/vault-id.js";
import type { Digest } from "../conventions/canonical.js";
import type { WriteRejection, WriteTargetSource } from "../conventions/write-protocol.js";
import { updateKeywordIndex, type KeywordUpdateOptions } from "../engine/index-update.js";
import type { GapFinding, Resolution } from "./ambiguity.js";
import { conform } from "./conform.js";
import { frameFor, type WriteFrame } from "./frame.js";
import { loadLiveTemplateSnapshot, selectTemplate, type TemplateSelection } from "./live-templates.js";
import { atomicWriteNote, type NoteWriteDeps } from "./note-write.js";
import { buildReceipt, contractRevision, noteRevision, type ConformChange, type GapLedgerState, type KeywordIndexState, type ReceiptGap, type WriteReceipt } from "./receipt.js";

/**
 * The one write path behind MCP `write` and CLI `oms write`:
 * frame -> conform -> decide -> if-match -> draft or atomic save -> gap ledger -> keyword
 * index -> vector queue. Only a refusal (vault boundary, path safety, a tampered seal,
 * a data-loss check) leaves the vault untouched; every other finding is a warning the
 * receipt lists. `check` runs the same decision, reports what the write would do, and
 * writes nothing anywhere.
 *
 * The seal state is read once. The contract revision derived from it is the one the
 * judge, every recorded gap and the receipt name, so a seal landing mid-write cannot
 * split a write across two revisions.
 */

export interface WriteRequest {
  readonly vault: string;
  readonly source: WriteTargetSource;
  /** Vault-relative note path, resolved against `vault`. */
  readonly path: string;
  readonly content: string;
  readonly template?: string | undefined;
  /** Revision of the note being overwritten, as a previous receipt reported it. */
  readonly ifMatch?: string | undefined;
  /** Judge only: resolve, conform and judge, then return without writing. */
  readonly check?: boolean | undefined;
}

export interface WriteCheck {
  /** False only when the write would be refused. */
  readonly ok: boolean;
  readonly path: string;
  /** Revision of the note on disk now, or null for a new or unreadable note. */
  readonly revision: Digest | null;
  readonly contractRevision: Digest | null;
  readonly refusals: readonly Violation[];
  readonly warnings: readonly Violation[];
  readonly fixes: readonly Violation[];
  /** @deprecated The same list as `refusals`. */
  readonly violations: readonly Violation[];
  readonly missingDefaults: readonly string[];
  readonly conformed: readonly ConformChange[];
  readonly frame: WriteFrame;
  /** What the real write would do with the same content; `ok` stays the judge's verdict on it as written. */
  readonly resolution: CheckResolution;
}

/** A write's ambiguity resolution as `check` predicts it: fields only, never values. */
export interface CheckResolution {
  readonly action: Resolution["action"];
  /** The gaps the write would meet: fields it would drop or draft, and open choices. */
  readonly gaps: readonly Omit<ReceiptGap, "id">[];
  /** True when the write would keep the note as a draft beside the gap ledger. */
  readonly wouldDraft: boolean;
  /** Present when the write would stop at the `ifMatch` check first, keeping no draft and recording no gap. */
  readonly precondition?: Precondition;
}

/** Why the `ifMatch` check would stop a write: the outcome kind, or the retry state. */
export type Precondition = "if-match-required" | "changed" | "absent";

export type WriteOutcome =
  | { readonly kind: "rejected"; readonly rejection: WriteRejection }
  | { readonly kind: "denied"; readonly refusals: readonly Violation[] }
  /** Nothing was saved in the vault; `draftRef` names the draft kept beside the gap ledger. */
  | { readonly kind: "drafted"; readonly draftRef: string; readonly warnings: readonly Violation[] }
  | { readonly kind: "if-match-required" }
  | { readonly kind: "retry"; readonly state: "changed" | "vanished" | "absent" | "source-changed" }
  | { readonly kind: "checked"; readonly check: WriteCheck }
  | { readonly kind: "written"; readonly receipt: WriteReceipt };

export interface WritePipelineDeps {
  readonly noteWrite: Partial<NoteWriteDeps>;
  readonly updateIndex: (options: KeywordUpdateOptions) => Promise<KeywordIndexState>;
  readonly now: () => Date;
  readonly resolveSealState: (vault: string) => Promise<SealState>;
  /** Store root the gap ledger and drafts live under. */
  readonly gapRoot: () => string;
  readonly gapLedger: Partial<GapLedgerDeps>;
}

/** Where a sealed write's gaps go; null when the contract is not sealed or the vault has no id. */
interface LedgerTarget {
  readonly root: string;
  readonly vaultId: string;
}

const REVISION = /^sha256:[0-9a-f]{64}$/;

function titleOf(notePath: string): string {
  return path.posix.basename(notePath).replace(/\.md$/i, "");
}

function folderOf(notePath: string): string | undefined {
  const folder = path.posix.dirname(notePath);
  return folder === "." ? undefined : folder;
}

/**
 * An overwrite must name the revision it replaces; a new note must not expect one. Reads
 * only what the target resolution already holds, so `check` can predict it too.
 */
function preconditionOf(previousContent: string | null | undefined, ifMatch: string | undefined): Precondition | undefined {
  if (previousContent !== undefined) {
    if (ifMatch === undefined) return "if-match-required";
    if (previousContent === null || noteRevision(previousContent) !== ifMatch) return "changed";
    return undefined;
  }
  // The caller expected to replace a note that is not there; retrying without ifMatch creates it.
  return ifMatch === undefined ? undefined : "absent";
}

/** The ledger rows for `findings` met writing `content` at `notePath` under contract `revision`. */
export function gapInputs(findings: readonly GapFinding[], notePath: string, content: string, revision: Digest, draftRef?: string) {
  const revisionOfNote = noteRevision(content);
  return findings.map(finding => ({
    notePath,
    noteRevision: revisionOfNote,
    contractRevision: revision,
    ...finding,
    ...(draftRef === undefined ? {} : { draftRef }),
  }));
}

/** The gaps as the receipt lists them when the ledger did not record them: no ids. */
function unrecorded(findings: readonly GapFinding[]): readonly ReceiptGap[] {
  return findings.map(finding => ({ axis: finding.axis, kind: finding.kind, field: finding.wanted.field }));
}

export async function runWritePipeline(request: WriteRequest, overrides: Partial<WritePipelineDeps> = {}): Promise<WriteOutcome> {
  const deps: WritePipelineDeps = {
    noteWrite: {},
    updateIndex: updateKeywordIndex,
    now: () => new Date(),
    resolveSealState: vault => resolveSealState(vault),
    gapRoot: storeRoot,
    gapLedger: {},
    ...overrides,
  };
  const { vault, source, template, ifMatch } = request;
  if (ifMatch !== undefined && !REVISION.test(ifMatch)) return { kind: "denied", refusals: [{ field: "ifMatch", kind: "unsupported-input" }] };
  // Diagnosis is allowed on any target; only a write needs a verified one.
  if (request.check !== true) {
    const rejection = await admitWriteTarget({ vault, source });
    if (rejection !== undefined) return { kind: "rejected", rejection };
  }
  // The one seal-state read; the judge's view and the ledger's vault id both come from it.
  const read: { seal?: SealState } = {};
  const resolved = await resolveWriteTarget(vault, path.resolve(vault, request.path), {
    resolveSealState: async root => (read.seal = await deps.resolveSealState(root)),
  });
  if (resolved.state === "denied") return { kind: "denied", refusals: resolved.verdict.refusals };
  const revision = contractRevision(resolved.view);
  const vaultId = read.seal?.vaultId ?? null;
  const ledger: LedgerTarget | null = revision !== null && vaultId !== null ? { root: deps.gapRoot(), vaultId } : null;

  const isNew = resolved.previousContent === undefined;
  // Templates are read live from `templateFolder` and scaffold only a new note; a named
  // template that is not there is reported on any write.
  const snapshot = await loadLiveTemplateSnapshot(resolved.vaultRoot);
  const { templates } = snapshot;
  // Existing notes without an explicit template do not depend on template selection.
  const validateSource = isNew || template !== undefined
    ? async () => (await loadLiveTemplateSnapshot(resolved.vaultRoot)).witness === snapshot.witness
    : undefined;
  const scaffold: TemplateSelection = isNew || template !== undefined
    ? selectTemplate(templates, { explicit: template, folder: folderOf(resolved.path) })
    : { kind: "none" };
  const frame = frameFor(resolved.view, { folder: folderOf(resolved.path), scaffold: scaffold.kind === "template" && isNew ? scaffold.template : undefined });
  const now = deps.now();
  const conformed = conform(request.content, {
    view: resolved.view,
    scaffold,
    isNew,
    title: titleOf(resolved.path),
    now,
  });
  const decision = decideWrite(resolved, conformed.content, { template, templates, now });
  const { verdict } = decision;
  const resolution: Resolution = decision.outcome === "deny" ? { action: "refuse", reason: "refused" }
    : decision.outcome === "draft" ? { action: "draft", findings: decision.findings, asWritten: decision.asWritten }
      : { action: "save", content: decision.fixedContent ?? conformed.content, verdict: decision.saved, findings: decision.findings };
  // Without a ledger no draft can be kept, so a write that would draft saves as written.
  const draftable = ledger !== null && revision !== null;

  // A refusal comes first, so a refused write never reaches the ifMatch check.
  const precondition = resolution.action === "refuse" ? undefined : preconditionOf(resolved.previousContent, ifMatch);
  if (request.check === true) {
    const action = resolution.action === "draft" && !draftable ? "save" : resolution.action;
    const findings = resolution.action === "refuse" ? [] : resolution.action === "draft" && !draftable ? resolution.asWritten : resolution.findings;
    const wouldDraft = action === "draft" && precondition === undefined;
    // A check reports what the real write would save: the fixed note's warnings and its fixes.
    const reported = resolution.action === "save" ? resolution.verdict : verdict;
    return {
      kind: "checked",
      check: {
        ok: verdict.ok,
        path: resolved.path,
        revision: typeof resolved.previousContent === "string" ? noteRevision(resolved.previousContent) : null,
        contractRevision: revision,
        refusals: verdict.refusals,
        warnings: reported.warnings,
        fixes: reported.fixes,
        violations: verdict.refusals,
        missingDefaults: reported.missingDefaults,
        conformed: conformed.applied,
        frame,
        resolution: { action, gaps: unrecorded(findings), wouldDraft, ...(precondition === undefined ? {} : { precondition }) },
      },
    };
  }
  if (resolution.action === "refuse") return { kind: "denied", refusals: verdict.refusals };

  // This runs before the draft, so a stale or missing ifMatch keeps nothing and records nothing.
  if (precondition === "if-match-required") return { kind: "if-match-required" };
  if (precondition !== undefined) return { kind: "retry", state: precondition };

  let save: Extract<Resolution, { readonly action: "save" }>;
  if (resolution.action === "draft") {
    // No ledger, or a state dir that cannot be written: the note is saved as written with its warnings.
    save = { action: "save", content: conformed.content, verdict, findings: resolution.asWritten };
    if (draftable) {
      if (validateSource !== undefined && !await validateSource()) return { kind: "retry", state: "source-changed" };
      let draftRef: string | undefined;
      try {
        draftRef = await writeGapDraft(ledger.root, ledger.vaultId, conformed.content, deps.gapLedger);
      } catch {
        draftRef = undefined;
      }
      if (draftRef !== undefined) {
        try {
          await recordGaps(ledger.root, ledger.vaultId, gapInputs(resolution.findings, resolved.path, conformed.content, revision, draftRef), deps.gapLedger);
        } catch {
          // The draft is kept; its ref still reaches the caller even though no gap points at it.
        }
        return { kind: "drafted", draftRef, warnings: verdict.warnings };
      }
    }
  } else {
    save = resolution;
  }

  const written = await atomicWriteNote(resolved.absolutePath, save.content, resolved.previousContent, deps.noteWrite, validateSource);
  if (written !== "written") return { kind: "retry", state: written };
  let gaps: readonly ReceiptGap[] = [];
  let gapLedger: GapLedgerState | undefined;
  if (save.findings.length > 0) {
    if (ledger === null || revision === null) {
      gaps = unrecorded(save.findings);
      gapLedger = "unavailable";
    } else {
      try {
        const records = await recordGaps(ledger.root, ledger.vaultId, gapInputs(save.findings, resolved.path, save.content, revision), deps.gapLedger);
        gaps = records.map(record => ({ id: record.id, axis: record.axis, kind: record.kind, field: record.wanted.field }));
      } catch {
        // The note is saved; the receipt still lists what it met, without ids, instead of failing the write.
        gaps = unrecorded(save.findings);
        gapLedger = "failed";
      }
    }
  }
  const keyword = await deps.updateIndex({ vault: path.resolve(vault), relPath: resolved.path });
  return {
    kind: "written",
    receipt: buildReceipt({
      path: resolved.path,
      content: save.content,
      view: resolved.view,
      contractRevision: revision,
      keyword,
      conformed: conformed.applied,
      missingDefaults: save.verdict.missingDefaults,
      // A fixed note is judged again: its warnings are the saved note's, and each fix is listed.
      warnings: save.verdict.warnings,
      fixes: save.verdict.fixes,
      gaps,
      ...(gapLedger === undefined ? {} : { gapLedger }),
    }),
  };
}
