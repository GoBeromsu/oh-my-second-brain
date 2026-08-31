/**
 * Preflight readiness check for a real-vault parity run.
 *
 * The other parity modules each answer a question *about a run*: is the declared
 * evidence admissible, do the metrics clear their floors, did the process survive
 * the corpus. None of them answers the question an operator actually asks first —
 * **can this run happen at all on this machine right now, and if not, exactly what
 * is missing?**
 *
 * Without that, the blocking conditions live only in prose, and prose goes stale.
 * This turns them into an executable check whose output is evidence: it either
 * reports readiness or names each unmet requirement and says whether the agent or
 * the vault owner has to resolve it.
 *
 * Every probe is injectable so the contract is tested deterministically, and the
 * same functions run for real against the live host and vault.
 */

import { assertFrozenThresholds, FORBIDDEN_THRESHOLD_OVERRIDES } from "./parity-gate.js";
import { checkInstalledBaseline, PINNED_QMD_VERSION } from "./parity-preregistration.js";
import { snapshotCorpus, type CorpusSnapshot } from "./parity-corpus.js";

/** One checked precondition. */
export interface PreflightRequirement {
  readonly id: string;
  readonly satisfied: boolean;
  readonly detail: string;
  /**
   * True when only the vault owner can resolve it.
   *
   * The distinction is the point of this report: an agent-resolvable gap is work
   * still to do, while a human-only gap is a genuine handoff. Conflating them
   * either hides remaining work or invents a blocker.
   */
  readonly humanOnly: boolean;
}

export interface PreflightReport {
  readonly ready: boolean;
  readonly requirements: readonly PreflightRequirement[];
  readonly blockers: readonly PreflightRequirement[];
  /** Measured corpus digest, when the vault could be read. */
  readonly corpusDigest?: string;
  readonly corpusFileCount?: number;
}

export interface PreflightInput {
  readonly vaultPath: string;
  /** Raw `qmd --version` output, or undefined when no comparator is installed. */
  readonly installedComparatorVersion?: string;
  /** Full `git rev-parse HEAD` from the comparator checkout. */
  readonly installedComparatorCommit?: string;
  /** Exact corpus identity from the authoritative preregistration. */
  readonly expectedCorpusDigest?: string;
  readonly expectedCorpusFileCount?: number;
  readonly expectedQueriesSha256?: string;
  readonly observedQueriesSha256?: string;
  readonly expectedQrelsSha256?: string;
  readonly observedQrelsSha256?: string;
  /** Whether the owner supplied a frozen query set. */
  readonly queriesSupplied: boolean;
  /** Whether the owner supplied curated relevance labels. */
  readonly qrelsSupplied: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injectable corpus probe; defaults to a real filesystem walk. */
  readonly snapshot?: (vaultPath: string) => Promise<CorpusSnapshot>;
}

function requirement(
  id: string,
  satisfied: boolean,
  detail: string,
  humanOnly: boolean,
): PreflightRequirement {
  return { id, satisfied, detail, humanOnly };
}

/**
 * Evaluate every precondition for a parity run.
 *
 * All requirements are always reported, satisfied or not, so the output is a
 * complete picture rather than the first thing that happens to fail.
 */
export async function checkPreflight(input: PreflightInput): Promise<PreflightReport> {
  const requirements: PreflightRequirement[] = [];
  const env = input.env ?? process.env;

  // Thresholds first. If the environment is trying to move a frozen bound, the
  // run is inadmissible no matter how healthy everything else is, and finding
  // that out after a six-hour embed would be worse than useless.
  let thresholdDetail = "no frozen threshold is overridden by the environment";
  let thresholdsFrozen = true;
  try {
    assertFrozenThresholds(env);
  } catch (error) {
    thresholdsFrozen = false;
    thresholdDetail = error instanceof Error ? error.message : String(error);
  }

  requirements.push(
    requirement("thresholds-frozen", thresholdsFrozen, thresholdDetail, false),
  );

  let corpusDigest: string | undefined;
  let corpusFileCount: number | undefined;
  const snapshot = input.snapshot ?? ((vaultPath: string) => snapshotCorpus(vaultPath));
  try {
    const result = await snapshot(input.vaultPath);
    corpusDigest = result.digest;
    corpusFileCount = result.fileCount;
    requirements.push(
      requirement(
        "corpus-readable",
        result.fileCount > 0,
        result.fileCount > 0
          ? `${result.fileCount} markdown files digested to sha256:${result.digest}`
          : `${input.vaultPath} contains no markdown notes, so there is nothing to measure`,
        // An unreadable or empty vault is resolved by the owner, not by an agent:
        // neither granting access nor authoring notes is implementation work.
        true,
      ),
    );
  } catch (error) {
    requirements.push(
      requirement(
        "corpus-readable",
        false,
        `could not read ${input.vaultPath}: ${error instanceof Error ? error.message : String(error)}`,
        true,
      ),
    );
  }

  const expectedDigest = input.expectedCorpusDigest?.replace(/^sha256:/iu, "").toLowerCase();
  const corpusIdentitySupplied =
    expectedDigest !== undefined
    && /^[a-f0-9]{64}$/u.test(expectedDigest)
    && Number.isInteger(input.expectedCorpusFileCount)
    && input.expectedCorpusFileCount! > 0;
  const corpusMatches =
    corpusIdentitySupplied
    && corpusDigest === expectedDigest
    && corpusFileCount === input.expectedCorpusFileCount;
  requirements.push(
    requirement(
      "corpus-frozen",
      corpusMatches,
      !corpusIdentitySupplied
        ? "no authoritative preregistered corpus digest and file count were supplied"
        : corpusMatches
          ? `current corpus exactly matches ${input.expectedCorpusFileCount} files at sha256:${expectedDigest}`
          : `current corpus ${String(corpusFileCount)} files at sha256:${String(corpusDigest)} does not match ` +
            `the preregistered ${String(input.expectedCorpusFileCount)} files at sha256:${expectedDigest}`,
      true,
    ),
  );

  for (const [id, label, expectedRaw, observedRaw] of [
    [
      "queries-frozen",
      "query set",
      input.expectedQueriesSha256,
      input.observedQueriesSha256,
    ],
    [
      "qrels-frozen",
      "qrels",
      input.expectedQrelsSha256,
      input.observedQrelsSha256,
    ],
  ] as const) {
    const expected = expectedRaw?.replace(/^sha256:/iu, "").toLowerCase();
    const observed = observedRaw?.replace(/^sha256:/iu, "").toLowerCase();
    const supplied = expected !== undefined
      && observed !== undefined
      && /^[a-f0-9]{64}$/u.test(expected)
      && /^[a-f0-9]{64}$/u.test(observed);
    requirements.push(
      requirement(
        id,
        supplied && expected === observed,
        !supplied
          ? `authoritative and observed ${label} digests were not both supplied`
          : expected === observed
            ? `${label} exactly matches sha256:${expected}`
            : `${label} digest sha256:${observed} does not match preregistered sha256:${expected}`,
        true,
      ),
    );
  }

  const comparator = input.installedComparatorVersion === undefined
    ? { ok: false, reason: "no qmd comparator is installed on this host" }
    : checkInstalledBaseline(
      input.installedComparatorVersion,
      input.installedComparatorCommit,
    );
  requirements.push(
    requirement(
      "comparator-pinned",
      comparator.ok,
      comparator.ok
        ? `installed comparator is the pinned qmd ${PINNED_QMD_VERSION}`
        : comparator.reason ?? "comparator does not match the pinned baseline",
      false,
    ),
  );

  requirements.push(
    requirement(
      "queries-supplied",
      input.queriesSupplied,
      input.queriesSupplied
        ? "a frozen query set was supplied"
        : "no frozen query set was supplied; queries describe what the owner expects to find",
      true,
    ),
  );

  requirements.push(
    requirement(
      "qrels-supplied",
      input.qrelsSupplied,
      input.qrelsSupplied
        ? "curated relevance labels were supplied"
        : "no curated relevance labels were supplied; relevance is the owner's judgement about " +
          "their own notes and is never inferred",
      true,
    ),
  );

  const blockers = requirements.filter((entry) => !entry.satisfied);
  return {
    ready: blockers.length === 0,
    requirements,
    blockers,
    ...(corpusDigest === undefined ? {} : { corpusDigest }),
    ...(corpusFileCount === undefined ? {} : { corpusFileCount }),
  };
}

/** Render a report for a terminal, listing who must resolve each blocker. */
export function formatPreflightReport(report: PreflightReport): string {
  const lines = [report.ready ? "parity preflight: READY" : "parity preflight: BLOCKED"];
  for (const entry of report.requirements) {
    const mark = entry.satisfied ? "ok  " : entry.humanOnly ? "USER" : "TODO";
    lines.push(`  [${mark}] ${entry.id}: ${entry.detail}`);
  }
  if (!report.ready) {
    const humanOnly = report.blockers.filter((entry) => entry.humanOnly).length;
    const agentOwned = report.blockers.length - humanOnly;
    lines.push(
      `  ${report.blockers.length} blocker(s): ${humanOnly} require the vault owner, ` +
        `${agentOwned} are still implementation work.`,
    );
  }
  return lines.join("\n");
}

/** Environment variables the report warns about, re-exported for callers. */
export { FORBIDDEN_THRESHOLD_OVERRIDES };
