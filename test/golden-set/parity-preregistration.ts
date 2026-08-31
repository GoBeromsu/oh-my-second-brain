/**
 * The preregistration contract for a real-vault parity run.
 *
 * A parity claim is only as trustworthy as the inputs it was measured against.
 * Nothing here scores anything; this module decides whether a run is *admissible*
 * before its numbers are allowed to mean anything, by requiring every input that
 * could otherwise be adjusted after seeing the result to be frozen and declared
 * up front: the comparator's exact commit, the corpus, the query set, the
 * relevance labels, and the retrieval settings. Observed rankings and timings
 * do not exist yet; the runner seals their complete raw record after execution.
 *
 * The ordering matters. Admissibility is checked first and independently of the
 * gate in `parity-gate.ts`, so a run against a different qmd build or a mutated
 * qrels file is rejected outright rather than scored and then argued about.
 */

/** The parity baseline pinned by the approved plan. */
export const PINNED_QMD_REPO = "https://github.com/tobi/qmd" as const;
export const PINNED_QMD_COMMIT = "facd35e01359e59d938bc9418e93fb9318addee3" as const;
export const PINNED_QMD_VERSION = "2.8.3" as const;

/**
 * Profiles differ only in which modalities they score.
 *
 * `b1-foundation` is the pre-B2 gate: lexical and vector, with qmd's own
 * expansion disabled so the arms compare like for like. `b2-parity` adds the
 * explicit generated strategy once that capability exists.
 */
export const PARITY_PROFILES = ["b1-foundation", "b2-parity"] as const;
export type ParityProfile = (typeof PARITY_PROFILES)[number];

const SHA256 = /^[a-f0-9]{64}$/;

/** Retrieval settings that must be identical across compared arms. */
export interface FrozenSettings {
  /** Candidates retrieved before reranking. */
  readonly candidateLimit: number;
  /** Result depth every metric is computed at. */
  readonly k: number;
  /** RRF smoothing constant. */
  readonly rrfK: number;
  /** Whether reranking was enabled for this arm pair. */
  readonly rerank: boolean;
  /** Whether query expansion was enabled for this arm pair. */
  readonly expansion: boolean;
  /** Embedding model identity, including its immutable revision. */
  readonly embedModel: string;
  readonly embedRevision: string;
  readonly embedSha256: string;
  /** Declared embedding prompt scheme. */
  readonly embedPromptScheme: string;
  /** Exact qmd model URI whose resolved bytes must match embedSha256. */
  readonly qmdEmbedUri: string;
  readonly rerankModel?: string;
  readonly rerankRevision?: string;
  readonly rerankSha256?: string;
  readonly qmdRerankUri?: string;
  readonly generateModel?: string;
  readonly generateRevision?: string;
  readonly generateSha256?: string;
  readonly generatePromptScheme?: string;
  readonly qmdGenerateUri?: string;
}

export interface ParityPreregistration {
  readonly schemaVersion: 1;
  readonly profile: ParityProfile;
  /** Comparator baseline. Must be the pinned repo/commit/version. */
  readonly baselineRepo: string;
  readonly baselineCommit: string;
  readonly baselineVersion: string;
  /**
   * Deterministic digest of the corpus snapshot (file list plus contents).
   * Re-indexing a changed vault therefore invalidates the run.
   */
  readonly corpusDigest: string;
  /** Exact Markdown file count in the frozen corpus snapshot. */
  readonly corpusFileCount: number;
  /** Digest of the sorted query set. */
  readonly queriesSha256: string;
  /** Digest of the curated relevance labels. */
  readonly qrelsSha256: string;
  /** Rows in the frozen query set. */
  readonly queryCount: number;
  readonly settings: FrozenSettings;
  /** Host description, so a latency bound is interpretable. */
  readonly hardware: string;
  /** Seed for bootstrap resampling, so intervals are reproducible. */
  readonly seed: number;
}

export interface AdmissibilityVerdict {
  readonly admissible: boolean;
  readonly failures: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip an optional `sha256:` prefix and case, so one digest has one spelling. */
function normalizeDigest(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/^sha256:/iu, "").toLowerCase();
}

function digestFailure(value: unknown, field: string): string | undefined {
  const normalized = normalizeDigest(value);
  if (normalized === undefined) return `${field} must be a sha256 digest string`;
  if (!SHA256.test(normalized)) return `${field} must be a 64-character sha256 digest`;
  return undefined;
}

function positiveIntFailure(value: unknown, field: string): string | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return `${field} must be a positive integer`;
  }
  return undefined;
}

function nonblankFailure(value: unknown, field: string): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return `${field} must be a nonblank string`;
  return undefined;
}

function settingsFailures(value: unknown): string[] {
  if (!isRecord(value)) return ["settings must be an object"];
  const failures: string[] = [];
  for (const [field, raw] of [
    ["candidateLimit", value.candidateLimit],
    ["k", value.k],
    ["rrfK", value.rrfK],
  ] as const) {
    const failure = positiveIntFailure(raw, `settings.${field}`);
    if (failure !== undefined) failures.push(failure);
  }
  for (const field of ["rerank", "expansion"] as const) {
    if (typeof value[field] !== "boolean") failures.push(`settings.${field} must be a boolean`);
  }
  for (const field of ["embedModel", "embedRevision", "embedPromptScheme", "qmdEmbedUri"] as const) {
    const failure = nonblankFailure(value[field], `settings.${field}`);
    if (failure !== undefined) failures.push(failure);
  }
  const embedShaFailure = digestFailure(value.embedSha256, "settings.embedSha256");
  if (embedShaFailure !== undefined) failures.push(embedShaFailure);
  if (value.rerank) {
    for (const field of [
      "rerankModel",
      "rerankRevision",
      "qmdRerankUri",
    ] as const) {
      const failure = nonblankFailure(value[field], `settings.${field}`);
      if (failure !== undefined) failures.push(failure);
    }
    const rerankShaFailure = digestFailure(value.rerankSha256, "settings.rerankSha256");
    if (rerankShaFailure !== undefined) failures.push(rerankShaFailure);
  }
  if (value.expansion) {
    for (const field of [
      "generateModel",
      "generateRevision",
      "generatePromptScheme",
      "qmdGenerateUri",
    ] as const) {
      const failure = nonblankFailure(value[field], `settings.${field}`);
      if (failure !== undefined) failures.push(failure);
    }
    const generateShaFailure = digestFailure(
      value.generateSha256,
      "settings.generateSha256",
    );
    if (generateShaFailure !== undefined) failures.push(generateShaFailure);
  }
  // A metric computed at a depth deeper than the candidate pool would silently
  // measure truncation rather than ranking.
  if (typeof value.k === "number" && typeof value.candidateLimit === "number" &&
      Number.isInteger(value.k) && Number.isInteger(value.candidateLimit) &&
      value.k > value.candidateLimit) {
    failures.push("settings.k must not exceed settings.candidateLimit");
  }
  return failures;
}

/**
 * Decide whether a declared run may be scored at all.
 *
 * Returns every reason rather than the first, so a preregistration is repaired
 * in one pass instead of one rejection at a time.
 */
export function evaluateAdmissibility(input: unknown): AdmissibilityVerdict {
  const failures: string[] = [];
  if (!isRecord(input)) {
    return { admissible: false, failures: ["preregistration must be an object"] };
  }
  if (input.schemaVersion !== 1) failures.push("schemaVersion must be 1");
  if (typeof input.profile !== "string" || !PARITY_PROFILES.includes(input.profile as ParityProfile)) {
    failures.push(`profile must be one of: ${PARITY_PROFILES.join(", ")}`);
  }

  // The comparator identity is the whole basis of a parity claim. A different
  // build is a different comparator, so this is an exact match, not a range.
  if (input.baselineRepo !== PINNED_QMD_REPO) {
    failures.push(`baselineRepo must be ${PINNED_QMD_REPO}, got ${String(input.baselineRepo)}`);
  }
  if (input.baselineCommit !== PINNED_QMD_COMMIT) {
    failures.push(
      `baselineCommit must be the pinned ${PINNED_QMD_COMMIT}, got ${String(input.baselineCommit)}; ` +
        "a changed baseline invalidates the run and requires a new preregistration",
    );
  }
  if (input.baselineVersion !== PINNED_QMD_VERSION) {
    failures.push(
      `baselineVersion must be ${PINNED_QMD_VERSION}, got ${String(input.baselineVersion)}`,
    );
  }

  for (const [field, raw] of [
    ["corpusDigest", input.corpusDigest],
    ["queriesSha256", input.queriesSha256],
    ["qrelsSha256", input.qrelsSha256],
  ] as const) {
    const failure = digestFailure(raw, field);
    if (failure !== undefined) failures.push(failure);
  }

  const queryCountFailure = positiveIntFailure(input.queryCount, "queryCount");
  if (queryCountFailure !== undefined) failures.push(queryCountFailure);
  const corpusCountFailure = positiveIntFailure(input.corpusFileCount, "corpusFileCount");
  if (corpusCountFailure !== undefined) failures.push(corpusCountFailure);

  failures.push(...settingsFailures(input.settings));

  const hardwareFailure = nonblankFailure(input.hardware, "hardware");
  if (hardwareFailure !== undefined) failures.push(hardwareFailure);
  if (typeof input.seed !== "number" || !Number.isInteger(input.seed)) {
    failures.push("seed must be an integer so bootstrap intervals are reproducible");
  }

  // Queries and labels must be distinct artifacts. An identical digest means one
  // file was used as both, which cannot express relevance judgements. Compared
  // after normalization, because `sha256:AB…` and `ab…` are the same digest and a
  // raw string comparison would let that spelling difference hide the defect.
  const queriesDigest = normalizeDigest(input.queriesSha256);
  const qrelsDigest = normalizeDigest(input.qrelsSha256);
  if (queriesDigest !== undefined && queriesDigest === qrelsDigest) {
    failures.push("queriesSha256 and qrelsSha256 must be distinct artifacts");
  }

  return { admissible: failures.length === 0, failures };
}

/**
 * Confirm an installed comparator binary is the pinned baseline.
 *
 * `qmd --version` prints a bare `qmd <semver>` line, which cannot prove a commit.
 * A matching version is therefore necessary but not sufficient, and this returns
 * the reason rather than a bare boolean so the caller reports what was wrong.
 */
export function checkInstalledBaseline(
  versionOutput: string,
  commit?: string,
): { readonly ok: boolean; readonly reason?: string } {
  const match = /qmd\s+(\d+\.\d+\.\d+)/iu.exec(versionOutput.trim());
  if (match === null) {
    return { ok: false, reason: `could not parse a qmd version from: ${versionOutput.trim()}` };
  }
  const found = match[1]!;
  if (found !== PINNED_QMD_VERSION) {
    return {
      ok: false,
      reason:
        `installed qmd is ${found}, but the pinned parity baseline is ${PINNED_QMD_VERSION} ` +
        `(commit ${PINNED_QMD_COMMIT}). Install the pinned build before running the comparator arm.`,
    };
  }
  if (commit === undefined || commit.trim() === "") {
    return {
      ok: false,
      reason:
        `installed qmd reports ${PINNED_QMD_VERSION}, but no full commit provenance was supplied. ` +
        `The comparator must be exactly ${PINNED_QMD_COMMIT}; a semver alone is insufficient.`,
    };
  }
  if (commit.trim().toLowerCase() !== PINNED_QMD_COMMIT) {
    return {
      ok: false,
      reason:
        `installed qmd commit is ${commit.trim()}, but the pinned comparator is ` +
        `${PINNED_QMD_COMMIT}.`,
    };
  }
  return { ok: true };
}
