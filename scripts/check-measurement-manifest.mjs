#!/usr/bin/env node
/**
 * Fail-closed checker for redacted R2 measurement manifests.
 *
 * Absence is advisory until OMS_MEASUREMENT_REQUIRED=1 (Phase D). Once a
 * manifest is present, schema, canonical qrels digest, preregistered arms,
 * and the selected measurement profile are always checked. The boost-c040
 * profile calculates C040 from recorded baseline/current metrics; the
 * model-default profile requires setup/model evidence; a claimed `verdict` is
 * evidence to compare, never evidence to trust. A required model-default check
 * may only be bypassed by a time-bounded, approved no-default waiver;
 * boost-c040 is never waivable.
 */
import { readFileSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";
import process from "node:process";

export const MEASUREMENT_SCHEMA_VERSION = 1;
export const RELEASED_BASELINE_RANKING_POLICY = "boost-additive";
export const DEFAULT_REQUIRED_ARM_IDS = Object.freeze([
  "boost-k-scale",
  "boost-per-list",
  "boost-zero",
]);
export const MEASUREMENT_PROFILES = Object.freeze(["boost-c040", "model-default"]);
export const REQUIRED_QUERY_CLASSES = Object.freeze([
  "ko",
  "ko-inflected",
  "ko-verb-inflected",
  "다단어-AND-0hit",
  "en",
  "mixed",
  "phrase",
  "conceptual",
  "frontmatter-constrained",
]);
/** Primary classes are frozen by preregistration; callers cannot redefine the gate. */
export const CANONICAL_PRIMARY_CLASSES = REQUIRED_QUERY_CLASSES;
export const DEFAULT_PRIMARY_CLASSES = CANONICAL_PRIMARY_CLASSES;
const HEX_DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/i;
const ARM_POLICY_BY_ID = Object.freeze({
  "boost-k-scale": "boost-k-scale",
  "boost-per-list": "boost-per-list",
  "boost-zero": "boost-zero",
});

function fail(message) {
  throw new Error(`[measurement] ${message}`);
}

function envValue(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

/**
 * Read the source declaration rather than importing it: this check must work
 * before the TypeScript build exists and must not guess a missing default.
 */
export function readShippedRankingPolicy(repoRoot) {
  const sourcePath = `${repoRoot}/src/kernel/engine/retrieval/dispatcher.ts`;
  let source;
  try {
    source = readFileSync(sourcePath, "utf8");
  } catch (error) {
    fail(
      `could not read shipped ranking policy source ${sourcePath}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const matches = [...source.matchAll(
    /^export const DEFAULT_DISPATCHER_POLICY: DispatcherPolicy = "([^"]+)";$/gm,
  )];
  if (matches.length !== 1) {
    fail(
      `expected exactly one DEFAULT_DISPATCHER_POLICY declaration in ${sourcePath}; found ${matches.length}`,
    );
  }
  return matches[0][1];
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") fail(`${field} must be a non-empty string`);
}
function requireFinite(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} must be finite`);
}
function normalizedDigest(value, field) {
  requireNonEmptyString(value, field);
  if (!HEX_DIGEST.test(value.trim())) fail(`${field} must be a sha256 digest`);
  return value.trim().replace(/^sha256:/i, "").toLowerCase();
}
function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function checkNumericMetric(value, field) {
  if (typeof value === "number") {
    requireFinite(value, field);
    return;
  }
  if (!isRecord(value) || Object.keys(value).length === 0) fail(`${field} must be a finite number or non-empty object`);
  for (const [key, metric] of Object.entries(value)) requireFinite(metric, `${field}.${key}`);
}
function verdictIsGreen(verdict) {
  if (typeof verdict === "string") return /^(?:pass|passed|green|approved)$/i.test(verdict.trim());
  if (!isRecord(verdict)) return false;
  const explicit = [verdict.pass, verdict.overallPass, verdict.green, verdict.status, verdict.overall]
    .find((value) => value !== undefined);
  if (typeof explicit === "boolean") return explicit;
  if (typeof explicit === "string") return /^(?:pass|passed|green|approved)$/i.test(explicit.trim());
  return false;
}

// ---------------------------------------------------------------------------
// Canonical qrels hashing (must stay byte-for-byte aligned with harness.ts)
// ---------------------------------------------------------------------------

export function normalizeQrels(input, source = "qrels") {
  const normalized = {};
  const seen = new Set();
  const add = (queryId, docPath, relevance) => {
    if (typeof queryId !== "string" || !queryId.trim() || typeof docPath !== "string" || !docPath.trim() ||
        typeof relevance !== "number" || !Number.isFinite(relevance) || relevance < 0) {
      fail(`${source} rows require queryId, docPath, and finite non-negative relevance`);
    }
    const key = `${queryId}\u0000${docPath}`;
    if (seen.has(key)) fail(`${source} contains duplicate qrel row: ${queryId}/${docPath}`);
    seen.add(key);
    (normalized[queryId] ??= {})[docPath] = relevance;
  };
  if (Array.isArray(input)) {
    for (const row of input) {
      if (!isRecord(row)) fail(`${source} qrel rows must be objects`);
      add(typeof row.queryId === "string" ? row.queryId : typeof row.query_id === "string" ? row.query_id : row.query,
        typeof row.docPath === "string" ? row.docPath : typeof row.doc_id === "string" ? row.doc_id : row.doc,
        row.relevance ?? row.rel);
    }
    return normalized;
  }
  if (!isRecord(input)) fail(`${source} must be an object keyed by query id`);
  for (const [queryId, value] of Object.entries(input)) {
    if (!queryId.trim() || (!isRecord(value) && !Array.isArray(value))) fail(`${source} qrels for ${queryId} must be an object`);
    if (Array.isArray(value)) {
      for (const row of value) {
        if (!isRecord(row)) fail(`${source} qrel rows for ${queryId} must be objects`);
        add(queryId, typeof row.docPath === "string" ? row.docPath : typeof row.doc_id === "string" ? row.doc_id : row.doc,
          row.relevance ?? row.rel);
      }
    } else {
      for (const [docPath, relevance] of Object.entries(value)) add(queryId, docPath, relevance);
    }
  }
  return normalized;
}

export function canonicalQrels(qrels) {
  const normalized = normalizeQrels(qrels);
  const rows = [];
  for (const queryId of Object.keys(normalized).sort()) {
    for (const docPath of Object.keys(normalized[queryId]).sort()) {
      rows.push({ queryId, docPath, relevance: normalized[queryId][docPath] });
    }
  }
  return JSON.stringify(rows);
}
export function qrelsSha256(qrels) {
  return createHash("sha256").update(canonicalQrels(qrels)).digest("hex");
}

// ---------------------------------------------------------------------------
// Actual C040 calculation
// ---------------------------------------------------------------------------

function metricPair(value, field) {
  if (!isRecord(value)) fail(`${field} must include baseline and current values`);
  requireFinite(value.baseline, `${field}.baseline`);
  const current = value.current ?? value.candidate;
  requireFinite(current, `${field}.current`);
  const delta = current - value.baseline;
  if (value.delta !== undefined) {
    requireFinite(value.delta, `${field}.delta`);
    if (Math.abs(value.delta - delta) > 1e-9) fail(`${field}.delta does not equal current-baseline`);
  }
  return { baseline: value.baseline, current, delta };
}

function metricValue(value, field) {
  if (typeof value === "number") {
    requireFinite(value, field);
    return value;
  }
  if (!isRecord(value)) fail(`${field} must be a finite number`);
  const current = value.current ?? value.candidate ?? value.baseline;
  requireFinite(current, `${field}.current`);
  return current;
}

function frozenArmIds(value, field = "armIds") {
  if (!Array.isArray(value) ||
      value.length !== DEFAULT_REQUIRED_ARM_IDS.length ||
      new Set(value).size !== DEFAULT_REQUIRED_ARM_IDS.length ||
      value.some((armId) => !DEFAULT_REQUIRED_ARM_IDS.includes(armId))) {
    fail(`${field} must exactly match the preregistered arm IDs: ${DEFAULT_REQUIRED_ARM_IDS.join(", ")}`);
  }
  return [...DEFAULT_REQUIRED_ARM_IDS];
}

/**
 * The selected winner is evidence, not a post-hoc checker default.  Accept
 * only the explicit spellings emitted by older harness revisions, and reject
 * conflicting aliases rather than silently preferring one.
 */
function selectedWinnerArmId(manifest) {
  const verdict = isRecord(manifest.verdict) ? manifest.verdict : {};
  const selection = isRecord(manifest.selection) ? manifest.selection : {};
  const selectedValues = [
    manifest.winnerArmId,
    manifest.winnerArm,
    manifest.selectedArmId,
    manifest.selectedArm,
    manifest.winner,
    selection.winnerArmId,
    selection.selectedArmId,
    selection.armId,
  ].filter((value) => value !== undefined);
  const verdictValues = [
    verdict.winnerArmId,
    verdict.winnerArm,
    verdict.selectedArmId,
    verdict.selectedArm,
    verdict.winner,
  ].filter((value) => value !== undefined);
  if (selectedValues.length === 0) fail("manifest must declare the selected winner arm");
  const values = [...selectedValues, ...verdictValues];
  if (values.some((value) => typeof value !== "string" || !value.trim())) {
    fail("selected winner arm must be a non-empty arm ID");
  }
  if (new Set(values).size !== 1) fail("manifest winner arm declarations disagree");
  const winner = values[0];
  if (!DEFAULT_REQUIRED_ARM_IDS.includes(winner)) {
    fail(`selected winner arm is not preregistered: ${winner}`);
  }
  return winner;
}

/** Calculate C040 checks from measured values, without consulting verdict. */
export function calculateC040(manifest, options = {}) {
  const ndcg = manifest.ndcgByClass;
  if (!isRecord(ndcg) || Object.keys(ndcg).length < REQUIRED_QUERY_CLASSES.length) {
    fail(`ndcgByClass must contain all ${REQUIRED_QUERY_CLASSES.length} preregistered class measurements`);
  }
  for (const queryClass of REQUIRED_QUERY_CLASSES) {
    if (!Object.hasOwn(ndcg, queryClass)) fail(`ndcgByClass is missing preregistered class: ${queryClass}`);
  }
  const configuredPrimary = manifest.primaryClasses;
  const isCanonicalPrimary = Array.isArray(configuredPrimary) &&
    configuredPrimary.length === CANONICAL_PRIMARY_CLASSES.length &&
    configuredPrimary.every((value) => typeof value === "string" && value.trim() !== "") &&
    new Set(configuredPrimary).size === CANONICAL_PRIMARY_CLASSES.length &&
    configuredPrimary.every((value) => CANONICAL_PRIMARY_CLASSES.includes(value)) &&
    CANONICAL_PRIMARY_CLASSES.every((value, index) => configuredPrimary[index] === value);
  if (!isCanonicalPrimary) {
    fail(`primaryClasses must exactly match the preregistered classes: ${CANONICAL_PRIMARY_CLASSES.join(", ")}`);
  }
  if (options.primaryClasses !== undefined &&
      JSON.stringify(options.primaryClasses) !== JSON.stringify(CANONICAL_PRIMARY_CLASSES)) {
    fail(`primaryClasses cannot be overridden; preregistration requires all ${CANONICAL_PRIMARY_CLASSES.length} classes`);
  }
  const primarySet = new Set(CANONICAL_PRIMARY_CLASSES);
  const classes = Object.entries(ndcg).map(([name, value]) => ({ name, ...metricPair(value, `ndcgByClass.${name}`) }));
  for (const name of primarySet) if (!Object.hasOwn(ndcg, name)) fail(`primaryClasses names unknown class: ${name}`);
  const primary = classes.filter((entry) => primarySet.has(entry.name));
  const secondary = classes.filter((entry) => !primarySet.has(entry.name));
  if (secondary.length !== 0) fail("ndcgByClass contains classes outside the preregistered primary set");
  const epsilon = 1e-12;
  const primaryPass = primary.every((entry) => entry.delta + epsilon >= 0.05);
  const secondaryPass = secondary.every((entry) => entry.delta + epsilon >= -0.02);

  let p95Value = manifest.p95;
  if (isRecord(manifest.latency) && manifest.latency.p95 !== undefined) p95Value = manifest.latency.p95;
  const p95 = metricPair(p95Value, "p95");
  const latencyPass = p95.baseline > 0 && p95.current <= p95.baseline * 1.5 + epsilon;

  const bootstrap = manifest.bootstrap;
  if (!isRecord(bootstrap)) fail("bootstrap must be an object");
  requireFinite(bootstrap.ciLow, "bootstrap.ciLow");
  requireFinite(bootstrap.ciHigh, "bootstrap.ciHigh");
  if (bootstrap.ciHigh < bootstrap.ciLow) fail("bootstrap.ciHigh must not be below ciLow");
  // The preregistered interval is for candidate-minus-baseline nDCG. A
  // positive lower bound is the non-self-attested significance requirement.
  const bootstrapPass = bootstrap.ciLow > 0;
  const pass = primaryPass && secondaryPass && latencyPass && bootstrapPass;
  return {
    pass,
    primary: primaryPass,
    secondary: secondaryPass,
    latency: latencyPass,
    bootstrap: bootstrapPass,
    primaryDeltas: Object.fromEntries(primary.map((entry) => [entry.name, entry.delta])),
    secondaryDeltas: Object.fromEntries(secondary.map((entry) => [entry.name, entry.delta])),
    p95Ratio: p95.current / p95.baseline,
    reasons: [
      ...(!primaryPass ? ["primary class nDCG improvement is below +0.05"] : []),
      ...(!secondaryPass ? ["non-primary class nDCG regression exceeds -0.02"] : []),
      ...(!latencyPass ? ["p95 latency exceeds the 1.5x baseline bound"] : []),
      ...(!bootstrapPass ? ["bootstrap CI does not exclude zero improvement"] : []),
    ],
  };
}

function checkArmResults(manifest, requiredArmIds) {
  const supplied = manifest.arms ?? manifest.armResults;
  let armResults;
  if (Array.isArray(supplied)) {
    const ids = supplied.map((result) => result?.armId);
    if (ids.some((armId) => typeof armId !== "string" || !armId.trim()) ||
        new Set(ids).size !== ids.length) {
      fail("arms array must contain unique non-empty arm IDs");
    }
    armResults = Object.fromEntries(supplied.map((result) => [result.armId, result]));
  } else {
    armResults = supplied;
  }
  if (!isRecord(armResults)) fail("arms must contain measured results for every preregistered arm");
  for (const armId of requiredArmIds) {
    const result = armResults[armId];
    if (!isRecord(result)) fail(`measured result missing for arm: ${armId}`);
    if (result.armId !== undefined && result.armId !== armId) {
      fail(`measured result armId mismatch: expected ${armId}, got ${result.armId}`);
    }
    const expectedPolicy = ARM_POLICY_BY_ID[armId];
    if (expectedPolicy !== undefined && result.policy !== expectedPolicy) {
      fail(`arm ${armId} policy mismatch: expected ${expectedPolicy}, got ${result.policy ?? "missing"}`);
    }
    if (!isRecord(result.ndcgByClass) || Object.keys(result.ndcgByClass).length === 0) fail(`arm ${armId} ndcgByClass is missing`);
    for (const [queryClass, value] of Object.entries(result.ndcgByClass)) {
      if (typeof value === "number") requireFinite(value, `arms.${armId}.ndcgByClass.${queryClass}`);
      else if (isRecord(value)) {
        requireFinite(value.baseline, `arms.${armId}.ndcgByClass.${queryClass}.baseline`);
        requireFinite(value.current, `arms.${armId}.ndcgByClass.${queryClass}.current`);
      } else {
        fail(`arms.${armId}.ndcgByClass.${queryClass} must be finite`);
      }
    }
    if (!Number.isInteger(result.scoredRows) || result.scoredRows < 1) {
      fail(`arms.${armId}.scoredRows must be a positive integer`);
    }
    checkNumericMetric(result.p50, `arms.${armId}.p50`);
    checkNumericMetric(result.p95, `arms.${armId}.p95`);
    if (!isRecord(result.bootstrap)) fail(`arms.${armId}.bootstrap is missing`);
    requireFinite(result.bootstrap.ciLow, `arms.${armId}.bootstrap.ciLow`);
    requireFinite(result.bootstrap.ciHigh, `arms.${armId}.bootstrap.ciHigh`);
  }
  for (const armId of Object.keys(armResults)) {
    if (!requiredArmIds.includes(armId)) fail(`unexpected measured arm: ${armId}`);
  }
  return armResults;
}

/**
 * The top-level C040 pairs are the selected candidate against the ablation
 * baseline (`boost-zero`). Keep those pairs tied to the arm evidence;
 * otherwise a manifest can pass by reporting one set of values while storing
 * unrelated arm measurements.
 */
function crossCheckC040Arms(manifest, armResults, winnerArmId) {
  const baseline = armResults["boost-zero"];
  const candidate = armResults[winnerArmId];
  if (!isRecord(baseline) || !isRecord(candidate)) {
    fail(`boost-c040 requires boost-zero and ${winnerArmId} arm evidence`);
  }
  if (winnerArmId === "boost-zero") {
    fail("boost-c040 winner must be a candidate arm, not the boost-zero ablation");
  }
  const epsilon = 1e-9;
  for (const queryClass of REQUIRED_QUERY_CLASSES) {
    const pair = metricPair(manifest.ndcgByClass[queryClass], `ndcgByClass.${queryClass}`);
    const baselineValue = metricValue(
      baseline.ndcgByClass?.[queryClass],
      `arms.boost-zero.ndcgByClass.${queryClass}`,
    );
    const candidateValue = metricValue(
      candidate.ndcgByClass?.[queryClass],
      `arms.${winnerArmId}.ndcgByClass.${queryClass}`,
    );
    if (Math.abs(pair.baseline - baselineValue) > epsilon ||
        Math.abs(pair.current - candidateValue) > epsilon) {
      fail(
        `C040 arm mismatch for ${queryClass}: ` +
        `expected baseline=${baselineValue}, current=${candidateValue}; ` +
        `got baseline=${pair.baseline}, current=${pair.current}`,
      );
    }
  }

  const p95Pair = metricPair(
    isRecord(manifest.p95) ? manifest.p95 : manifest.latency?.p95,
    "p95",
  );
  const baselineP95 = metricValue(baseline.p95, "arms.boost-zero.p95");
  const candidateP95 = metricValue(candidate.p95, `arms.${winnerArmId}.p95`);
  if (Math.abs(p95Pair.baseline - baselineP95) > epsilon ||
      Math.abs(p95Pair.current - candidateP95) > epsilon) {
    fail(
      `C040 arm mismatch for p95: expected baseline=${baselineP95}, current=${candidateP95}; ` +
      `got baseline=${p95Pair.baseline}, current=${p95Pair.current}`,
    );
  }
  // The top-level interval is the preregistered paired candidate-minus-
  // baseline bootstrap. Independent arm intervals are not a valid substitute:
  // they discard query pairing and can reject a genuine paired improvement.
  if (!isRecord(manifest.bootstrap)) fail("boost-c040 requires paired bootstrap evidence");
  requireFinite(manifest.bootstrap.ciLow, "bootstrap.ciLow");
  requireFinite(manifest.bootstrap.ciHigh, "bootstrap.ciHigh");
  if (manifest.bootstrap.ciHigh < manifest.bootstrap.ciLow) {
    fail("bootstrap.ciHigh must not be below ciLow");
  }
  if (manifest.bootstrap.paired !== undefined && manifest.bootstrap.paired !== true) {
    fail("boost-c040 bootstrap.paired must be true when provided");
  }
}

function checkPairedRawEvidence(manifest, armResults, requiredArmIds, required, expectedQrels) {
  const evidence = manifest.rawEvidence;
  if (evidence === undefined && !required) return;
  if (!isRecord(evidence)) fail("rawEvidence must be an object");
  if (evidence.kind !== "paired-production-seam-v1" || evidence.paired !== true) {
    fail("rawEvidence must identify paired-production-seam-v1 evidence");
  }
  if (!isRecord(evidence.arms)) fail("rawEvidence.arms must contain every measured arm");
  let pairedQueryIds;
  for (const armId of requiredArmIds) {
    const rawArm = evidence.arms[armId];
    const measuredArm = armResults[armId];
    if (!isRecord(rawArm)) fail(`rawEvidence is missing arm: ${armId}`);
    if (normalizedDigest(rawArm.outputDigest, `rawEvidence.arms.${armId}.outputDigest`) !==
        normalizedDigest(measuredArm.outputDigest, `arms.${armId}.outputDigest`)) {
      fail(`rawEvidence output digest mismatch for arm: ${armId}`);
    }
    if (rawArm.scoredRows !== measuredArm.scoredRows) fail(`rawEvidence scoredRows mismatch for arm: ${armId}`);
    if (!isRecord(rawArm.ndcgByQuery) || Object.keys(rawArm.ndcgByQuery).length !== measuredArm.scoredRows) {
      fail(`rawEvidence paired nDCG rows are incomplete for arm: ${armId}`);
    }
    const queryIds = Object.keys(rawArm.ndcgByQuery).sort();
    if (pairedQueryIds === undefined) pairedQueryIds = queryIds;
    else if (queryIds.length !== pairedQueryIds.length ||
        queryIds.some((queryId, index) => queryId !== pairedQueryIds[index])) {
      fail(`rawEvidence query-ID set is not paired across arms: ${armId}`);
    }
    for (const [queryId, value] of Object.entries(rawArm.ndcgByQuery)) {
      requireNonEmptyString(queryId, `rawEvidence.arms.${armId}.queryId`);
      requireFinite(value, `rawEvidence.arms.${armId}.ndcgByQuery.${queryId}`);
    }
  }
  for (const armId of Object.keys(evidence.arms)) {
    if (!requiredArmIds.includes(armId)) fail(`rawEvidence has unexpected arm: ${armId}`);
  }
  const rawDigest = normalizedDigest(manifest.rawDigest, "rawDigest");
  if (sha256Json(evidence) !== rawDigest) fail("rawDigest does not match rawEvidence");
  if (expectedQrels !== undefined) {
    const qrelsQueryIds = Object.keys(normalizeQrels(expectedQrels, "expected qrels")).sort();
    if (pairedQueryIds === undefined ||
        qrelsQueryIds.length !== pairedQueryIds.length ||
        qrelsQueryIds.some((queryId, index) => queryId !== pairedQueryIds[index])) {
      fail("paired raw evidence query IDs must exactly match qrels query IDs");
    }
  }
  if (manifest.queryIds !== undefined) {
    const declaredQueryIds = manifest.queryIds;
    if (!Array.isArray(declaredQueryIds) ||
        declaredQueryIds.some((queryId) => typeof queryId !== "string" || !queryId.trim()) ||
        new Set(declaredQueryIds).size !== declaredQueryIds.length ||
        pairedQueryIds === undefined ||
        declaredQueryIds.length !== pairedQueryIds.length ||
        [...declaredQueryIds].sort().some((queryId, index) => queryId !== pairedQueryIds[index])) {
      fail("manifest.queryIds must exactly match paired raw evidence query IDs");
    }
  }
}

/**
 * Return the immutable payload covered by a measurement attestation.
 *
 * For boost-c040, every value used by the C040 calculation and its evidence
 * chain is covered: paired arm metrics, top-level paired metrics/bootstrap,
 * and the paired raw evidence itself.  Keep this list explicit so adding a
 * mutable decision input cannot silently create an unsigned release gate.
 */
function attestationPayload(manifest, armResults) {
  const payload = {
    schemaVersion: manifest.schemaVersion,
    profile: manifest.profile,
    datasetId: manifest.datasetId,
    qrelsHash: manifest.qrelsHash,
    armIds: manifest.armIds,
    arms: armResults ?? manifest.arms ?? manifest.armResults,
    rawDigest: manifest.rawDigest,
    verdict: manifest.verdict,
    generatedAt: manifest.generatedAt,
  };
  if (manifest.profile === "boost-c040") {
    payload.winnerArmId = selectedWinnerArmId(manifest);
    payload.harnessCommit = manifest.harnessCommit;
    payload.primaryClasses = manifest.primaryClasses;
    payload.ndcgByClass = manifest.ndcgByClass;
    payload.p50 = manifest.p50;
    payload.p95 = manifest.p95;
    payload.bootstrap = manifest.bootstrap;
    payload.metrics = manifest.metrics;
    payload.pairedBootstrap = manifest.pairedBootstrap;
    payload.rawEvidence = manifest.rawEvidence;
    payload.queryIds = manifest.queryIds;
  } else if (manifest.profile === "model-default") {
    payload.harnessCommit = manifest.harnessCommit;
    payload.modelDefault = manifest.modelDefault ?? manifest.modelDefaultEvidence;
    if (manifest.aEmbedMetrics !== undefined) payload.aEmbedMetrics = manifest.aEmbedMetrics;
    else if (manifest.metrics !== undefined) payload.metrics = manifest.metrics;
    else if (payload.modelDefault?.aEmbedMetrics !== undefined) {
      payload.aEmbedMetrics = payload.modelDefault.aEmbedMetrics;
    }
    else if (payload.modelDefault?.metrics !== undefined) payload.metrics = payload.modelDefault.metrics;
    payload.rawEvidence = manifest.rawEvidence ?? payload.modelDefault?.rawEvidence;
    payload.armId = manifest.armId ?? payload.modelDefault?.armId;
    payload.queryIds = manifest.queryIds;
  }
  return payload;
}

function checkAttestation(manifest, required, trustedPublicKey, armResults) {
  const attestation = manifest.attestation;
  if (attestation === undefined && !required) return;
  if (!isRecord(attestation)) fail("attestation is required and must be an object");
  requireNonEmptyString(attestation.signedBy, "attestation.signedBy");
  const payload = attestationPayload(manifest, armResults);
  const expected = sha256Json(payload);
  if (normalizedDigest(attestation.payloadDigest, "attestation.payloadDigest") !== expected) {
    fail("attestation payloadDigest does not match immutable manifest payload");
  }
  if (attestation.algorithm !== "ed25519") {
    fail("attestation.algorithm must be ed25519");
  }
  requireNonEmptyString(attestation.publicKey, "attestation.publicKey");
  requireNonEmptyString(attestation.signature, "attestation.signature");
  if (required && (!trustedPublicKey || attestation.publicKey !== trustedPublicKey)) {
    fail("required attestation public key is not in the trusted release configuration");
  }
  let publicKey;
  let signature;
  try {
    publicKey = createPublicKey(attestation.publicKey);
    signature = Buffer.from(attestation.signature, "base64");
  } catch (error) {
    fail(`attestation key or signature is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (signature.length === 0 || !verify(null, Buffer.from(JSON.stringify(payload)), publicKey, signature)) {
    fail("attestation signature does not verify the immutable manifest payload");
  }
}

function checkModelDefaultEvidence(manifest, expected, options = {}) {
  const evidence = manifest.modelDefault ?? manifest.modelDefaultEvidence;
  if (!isRecord(evidence)) {
    fail("model-default profile requires modelDefault evidence");
  }
  const receipt = isRecord(evidence.receipt) ? evidence.receipt : {};
  const descriptor = isRecord(evidence.descriptor) ? evidence.descriptor : {};
  const provider = evidence.provider ?? receipt.provider ?? descriptor.provider;
  const model = evidence.model ?? receipt.model ?? descriptor.model;
  requireNonEmptyString(provider, "modelDefault.provider");
  requireNonEmptyString(model, "modelDefault.model");
  const source = evidence.source ?? evidence.resolutionSource ?? receipt.source;
  if (source !== undefined && source !== "installed-default" && source !== "setup") {
    fail("modelDefault.source must be installed-default or setup");
  }
  const digest = evidence.sha256 ?? evidence.modelSha256 ?? receipt.sha256 ?? descriptor.sha256;
  const normalizedSha = normalizedDigest(digest, "modelDefault.sha256");
  const strict = options.requirePairedEvidence === true ||
    options.required === true ||
    options.requireAttestation === true;
  if (strict) {
    if (!isRecord(evidence.descriptor)) fail("modelDefault.descriptor is required for a strict model-default measurement");
    const descriptorProvider = descriptor.provider;
    const descriptorModel = descriptor.model;
    const descriptorSha = descriptor.sha256 ?? descriptor.modelSha256;
    requireNonEmptyString(descriptorProvider, "modelDefault.descriptor.provider");
    requireNonEmptyString(descriptorModel, "modelDefault.descriptor.model");
    if (descriptorProvider !== provider || descriptorModel !== model) {
      fail("modelDefault.descriptor does not match provider/model");
    }
    if (normalizedDigest(descriptorSha, "modelDefault.descriptor.sha256") !== normalizedSha) {
      fail("modelDefault.descriptor SHA-256 does not match modelDefault.sha256");
    }
  }
  if (expected !== undefined) {
    if (!isRecord(expected)) fail("expectedModelDefault must be an object");
    requireNonEmptyString(expected.provider, "expectedModelDefault.provider");
    requireNonEmptyString(expected.model, "expectedModelDefault.model");
    if (provider !== expected.provider || model !== expected.model) {
      fail(
        `model-default evidence mismatch: expected ${expected.provider}/${expected.model}, ` +
        `got ${provider}/${model}`,
      );
    }
    if (expected.sha256 !== undefined &&
        normalizedDigest(expected.sha256, "expectedModelDefault.sha256") !== normalizedSha) {
      fail("model-default evidence SHA-256 mismatch");
    }
  }
  const profile = evidence.profile ?? evidence.profileName ?? receipt.profile;
  if (profile !== undefined && profile !== "model-default") {
    fail(`modelDefault.profile must be model-default, got ${profile}`);
  }
  if (evidence.armId !== undefined && evidence.armId !== "model-default") {
    fail(`modelDefault.armId must be model-default, got ${evidence.armId}`);
  }
  const rawEvidence = manifest.rawEvidence ?? evidence.rawEvidence;
  if (isRecord(rawEvidence) && rawEvidence.armId !== undefined &&
      rawEvidence.armId !== "model-default") {
    fail(`raw evidence armId must be model-default, got ${rawEvidence.armId}`);
  }
  const rawEvidenceDigest = manifest.rawDigest ??
    (isRecord(rawEvidence)
      ? rawEvidence.sha256 ?? rawEvidence.digest ?? rawEvidence.rawDigest
      : rawEvidence);
  const normalizedRawEvidenceDigest = rawEvidenceDigest === undefined
    ? undefined
    : normalizedDigest(rawEvidenceDigest, "rawDigest");
  if (options.requirePairedEvidence === true) {
    // A model-default measurement is an A-embed arm, not merely a capability
    // receipt.  Keep the arm identity next to the model bytes so a receipt
    // copied from another run cannot satisfy the required release gate.
    if (evidence.armId !== "model-default") {
      fail("modelDefault.armId must be model-default");
    }
    if (normalizedRawEvidenceDigest === undefined) fail("rawDigest must be present for paired model-default evidence");
    if (isRecord(rawEvidence) && rawEvidence.armId !== undefined &&
        rawEvidence.armId !== evidence.armId) {
      fail(
        `raw evidence armId mismatch: expected ${evidence.armId}, got ${rawEvidence.armId}`,
      );
    }
  }
  if (strict) {
    if (!isRecord(rawEvidence)) fail("model-default profile requires paired raw evidence");
    if (manifest.rawDigest === undefined) fail("model-default profile requires top-level rawDigest");
    if (evidence.armId !== "model-default") fail("modelDefault.armId must be model-default");
    if (rawEvidence.paired !== true) fail("model-default rawEvidence.paired must be true");
    if (rawEvidence.kind !== "a-embed-production-v1" &&
        rawEvidence.kind !== "a-embed-v1" &&
        rawEvidence.kind !== "paired-a-embed-v1" &&
        rawEvidence.kind !== "paired-production-seam-v1") {
      fail("model-default rawEvidence.kind must identify A-embed production evidence");
    }
    const rawArms = isRecord(rawEvidence.arms) ? rawEvidence.arms : undefined;
    if (rawArms !== undefined) {
      if (Object.keys(rawArms).length !== 1 || !isRecord(rawArms["model-default"])) {
        fail("model-default rawEvidence.arms must contain only model-default");
      }
    }
    const rawArm = rawArms?.["model-default"] ?? rawEvidence;
    if (!isRecord(rawArm)) fail("model-default raw evidence arm is missing");
    if (rawArm.armId !== undefined && rawArm.armId !== "model-default") {
      fail(`model-default raw evidence armId must be model-default, got ${rawArm.armId}`);
    }
    normalizedDigest(rawArm.outputDigest, "modelDefault.rawEvidence.outputDigest");
    if (!Number.isInteger(rawArm.scoredRows) || rawArm.scoredRows < 1) {
      fail("model-default raw evidence scoredRows must be a positive integer");
    }
    if (!isRecord(rawArm.ndcgByQuery) ||
        Object.keys(rawArm.ndcgByQuery).length !== rawArm.scoredRows) {
      fail("model-default raw evidence must include one finite nDCG value per scored query");
    }
    for (const [queryId, value] of Object.entries(rawArm.ndcgByQuery)) {
      requireNonEmptyString(queryId, "model-default raw evidence query ID");
      requireFinite(value, `model-default raw evidence ndcgByQuery.${queryId}`);
    }
    if (options.expectedQrels !== undefined) {
      const rawQueryIds = Object.keys(rawArm.ndcgByQuery).sort();
      const qrelsQueryIds = Object.keys(normalizeQrels(options.expectedQrels, "expected qrels")).sort();
      if (rawQueryIds.length !== qrelsQueryIds.length ||
          rawQueryIds.some((queryId, index) => queryId !== qrelsQueryIds[index])) {
        fail("model-default raw evidence query IDs must exactly match qrels query IDs");
      }
    }
    if (manifest.queryIds !== undefined) {
      const declaredQueryIds = manifest.queryIds;
      const rawQueryIds = Object.keys(rawArm.ndcgByQuery).sort();
      if (!Array.isArray(declaredQueryIds) ||
          declaredQueryIds.some((queryId) => typeof queryId !== "string" || !queryId.trim()) ||
          new Set(declaredQueryIds).size !== declaredQueryIds.length ||
          declaredQueryIds.length !== rawQueryIds.length ||
          [...declaredQueryIds].sort().some((queryId, index) => queryId !== rawQueryIds[index])) {
        fail("model-default manifest.queryIds must match raw evidence query IDs");
      }
    }
    if (normalizedRawEvidenceDigest === undefined) {
      fail("rawDigest must be present for strict model-default evidence");
    }
    if (sha256Json(rawEvidence) !== normalizedRawEvidenceDigest) {
      fail("rawDigest does not match model-default rawEvidence");
    }
  }
  const dimensions = evidence.dimensions ?? descriptor.dimensions;
  if (dimensions !== undefined &&
      (!Number.isInteger(dimensions) || dimensions < 1)) {
    fail("modelDefault.dimensions must be a positive integer");
  }

  const metricSource = manifest.aEmbedMetrics ?? manifest.metrics ??
    evidence.aEmbedMetrics ?? evidence.metrics;
  if (strict) {
    if (!isRecord(metricSource)) fail("model-default profile requires A-embed metrics");
    const ndcg = metricSource.ndcgAt10 ?? metricSource.ndcg ?? metricSource.ndcgByClass;
    if (ndcg === undefined) fail("model-default A-embed metrics must include nDCG");
    if (metricSource.ndcgByClass !== undefined) {
      if (!isRecord(metricSource.ndcgByClass) ||
          Object.keys(metricSource.ndcgByClass).length !== CANONICAL_PRIMARY_CLASSES.length ||
          new Set(Object.keys(metricSource.ndcgByClass)).size !== CANONICAL_PRIMARY_CLASSES.length ||
          Object.keys(metricSource.ndcgByClass).some((queryClass) =>
            !CANONICAL_PRIMARY_CLASSES.includes(queryClass))) {
        fail("model-default A-embed ndcgByClass must exactly match the preregistered classes");
      }
    }
    if (isRecord(ndcg) && ndcg.mean !== undefined) requireFinite(ndcg.mean, "aEmbedMetrics.ndcgAt10.mean");
    else if (isRecord(ndcg) && Object.values(ndcg).every((value) => isRecord(value))) {
      for (const [queryClass, value] of Object.entries(ndcg)) {
        metricPair(value, `aEmbedMetrics.ndcgByClass.${queryClass}`);
      }
    } else checkNumericMetric(ndcg, "aEmbedMetrics.ndcgAt10");
    const latency = isRecord(metricSource.latencyMs) ? metricSource.latencyMs : {};
    const p50 = metricSource.p50 ?? latency.p50;
    const p95 = metricSource.p95 ?? latency.p95;
    checkNumericMetric(p50, "aEmbedMetrics.p50");
    checkNumericMetric(p95, "aEmbedMetrics.p95");
    if (typeof p50 === "number" && typeof p95 === "number" && p95 < p50) {
      fail("aEmbedMetrics.p95 must not be less than p50");
    }
    const bootstrap = metricSource.bootstrap ??
      (isRecord(ndcg) && isRecord(ndcg.ci) ? ndcg.ci : undefined);
    if (!isRecord(bootstrap)) fail("model-default A-embed metrics require bootstrap evidence");
    if (!Number.isInteger(bootstrap.seed) || bootstrap.seed < 0) {
      fail("aEmbedMetrics.bootstrap.seed must be a non-negative integer");
    }
    if (!Number.isInteger(bootstrap.samples) || bootstrap.samples < 100) {
      fail("aEmbedMetrics.bootstrap.samples must be an integer >= 100");
    }
    requireFinite(bootstrap.ciLow, "aEmbedMetrics.bootstrap.ciLow");
    requireFinite(bootstrap.ciHigh, "aEmbedMetrics.bootstrap.ciHigh");
    if (bootstrap.ciHigh < bootstrap.ciLow) fail("aEmbedMetrics.bootstrap.ciHigh must not be below ciLow");
    const rawMetricArm = isRecord(rawEvidence) && isRecord(rawEvidence.arms)
      ? rawEvidence.arms["model-default"]
      : undefined;
    const scoredRows = metricSource.scoredRows ??
      (isRecord(rawMetricArm) && Number.isInteger(rawMetricArm.scoredRows)
        ? rawMetricArm.scoredRows
        : isRecord(rawEvidence) && Number.isInteger(rawEvidence.scoredRows)
          ? rawEvidence.scoredRows
          : undefined);
    if (!Number.isInteger(scoredRows) || scoredRows < 1) {
      fail("model-default A-embed metrics scoredRows must be a positive integer");
    }
    const evidenceScoredRows = isRecord(rawMetricArm)
      ? rawMetricArm.scoredRows
      : isRecord(rawEvidence) ? rawEvidence.scoredRows : undefined;
    if (evidenceScoredRows !== undefined && scoredRows !== evidenceScoredRows) {
      fail("model-default A-embed metrics scoredRows must match raw evidence");
    }
  }
  return {
    ...evidence,
    provider,
    model,
    source: source ?? "installed-default",
    sha256: `sha256:${normalizedSha}`,
    ...(strict ? { descriptor, aEmbedMetrics: metricSource } : {}),
    ...(normalizedRawEvidenceDigest === undefined
      ? {}
      : { rawDigest: `sha256:${normalizedRawEvidenceDigest}` }),
  };
}

function expectedArmsFromEnv() {
  const raw = envValue("OMS_PREREG_ARM_IDS");
  if (!raw) return [...DEFAULT_REQUIRED_ARM_IDS];
  let values;
  try {
    values = raw.trim().startsWith("[") ? JSON.parse(raw) : raw.split(",").map((arm) => arm.trim()).filter(Boolean);
  } catch {
    fail("OMS_PREREG_ARM_IDS must be comma-separated ids or a JSON array");
  }
  if (!Array.isArray(values) || values.length === 0 || values.some((arm) => typeof arm !== "string" || !arm.trim())) {
    fail("OMS_PREREG_ARM_IDS must contain non-empty arm ids");
  }
  if (new Set(values).size !== values.length) fail("OMS_PREREG_ARM_IDS must not contain duplicates");
  frozenArmIds(values, "OMS_PREREG_ARM_IDS");
  return [...DEFAULT_REQUIRED_ARM_IDS];
}
function expectedQrelsHashFromEnv() {
  const declaredHash = envValue("OMS_PREREG_QRELS_HASH");
  const qrelsPath = envValue("OMS_PREREG_QRELS");
  if (!qrelsPath) return declaredHash;
  try {
    const computedHash = qrelsSha256(JSON.parse(readFileSync(qrelsPath, "utf8")));
    if (declaredHash !== undefined &&
        normalizedDigest(declaredHash, "OMS_PREREG_QRELS_HASH") !== computedHash) {
      fail(`OMS_PREREG_QRELS_HASH does not match OMS_PREREG_QRELS: expected ${declaredHash}, got sha256:${computedHash}`);
    }
    return declaredHash ?? `sha256:${computedHash}`;
  } catch (error) {
    fail(`could not read preregistered qrels: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function preregisteredQrelsFromEnv() {
  const qrelsPath = envValue("OMS_PREREG_QRELS");
  if (!qrelsPath) return undefined;
  try {
    return JSON.parse(readFileSync(qrelsPath, "utf8"));
  } catch (error) {
    fail(`could not read preregistered qrels: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Validate and return a normalized manifest. */
export function validateMeasurementManifest(manifest, options = {}) {
  if (!isRecord(manifest)) fail("manifest must be a JSON object");
  if (manifest.schemaVersion !== MEASUREMENT_SCHEMA_VERSION && manifest.schemaVersion !== "oms.measurement.v1") {
    fail(`schemaVersion must be ${MEASUREMENT_SCHEMA_VERSION}`);
  }
  const profileValue = (
    options.profile ??
    envValue("OMS_MEASUREMENT_PROFILE") ??
    manifest.profile ??
    "boost-c040"
  );
  requireNonEmptyString(profileValue, "profile");
  const profile = profileValue.trim();
  if (!MEASUREMENT_PROFILES.includes(profile)) fail(`unknown measurement profile: ${profile}`);
  requireNonEmptyString(manifest.profile, "profile");
  if (manifest.profile !== profile) fail(`manifest profile mismatch: expected ${profile}, got ${manifest.profile}`);
  requireNonEmptyString(manifest.harnessCommit, "harnessCommit");
  const qrelsHash = manifest.qrelsHash === undefined
    ? undefined
    : normalizedDigest(manifest.qrelsHash, "qrelsHash");
  if (profile === "boost-c040" && qrelsHash === undefined) {
    fail("qrelsHash must be present for the boost-c040 profile");
  }
  const externalQrelsHash =
    options.expectedQrelsHash ??
    options.preregisteredQrelsHash ??
    (options.preregisteredQrels === undefined
      ? undefined
      : qrelsSha256(options.preregisteredQrels));
  const suppliedQrels = options.preregisteredQrels ?? options.qrels;
  if ((options.expectedQrelsHash ?? options.preregisteredQrelsHash) !== undefined &&
      suppliedQrels !== undefined &&
      normalizedDigest(options.expectedQrelsHash ?? options.preregisteredQrelsHash, "expectedQrelsHash") !==
        qrelsSha256(suppliedQrels)) {
    fail("expected qrels digest does not match supplied qrels");
  }
  const expectedQrelsHash = externalQrelsHash ??
    (options.qrels === undefined ? undefined : qrelsSha256(options.qrels));
  if (profile === "boost-c040" && options.required === true && externalQrelsHash === undefined) {
    fail(
      "required boost-c040 checks need an external preregistered qrels digest; " +
      "manifest qrelsHash is self-declared",
    );
  }
  if (expectedQrelsHash !== undefined && (qrelsHash === undefined ||
      normalizedDigest(expectedQrelsHash, "expectedQrelsHash") !== qrelsHash)) {
    fail(`qrels hash mismatch: expected ${expectedQrelsHash}, got ${manifest.qrelsHash}`);
  }
  if (options.requiredArmIds !== undefined) frozenArmIds(options.requiredArmIds, "requiredArmIds");
  const requiredArmIds = DEFAULT_REQUIRED_ARM_IDS;
  if (profile === "boost-c040") {
    frozenArmIds(manifest.armIds);
  }

  if (profile === "boost-c040") requireNonEmptyString(manifest.datasetId, "datasetId");
  else if (manifest.datasetId !== undefined) requireNonEmptyString(manifest.datasetId, "datasetId");
  if (profile === "model-default") {
    const modelDefault = checkModelDefaultEvidence(
      manifest,
      options.expectedModelDefault ?? options.modelDefault,
      {
        requirePairedEvidence: options.requirePairedEvidence === true || options.required === true,
        required: options.required === true,
        requireAttestation: options.requireAttestation === true,
        expectedQrels: options.preregisteredQrels ?? options.qrels,
      },
    );
    if (manifest.generatedAt !== undefined &&
        (typeof manifest.generatedAt !== "string" || !Number.isFinite(Date.parse(manifest.generatedAt)))) {
      fail("generatedAt must be a valid timestamp");
    }
    const strictModelDefault = options.required === true ||
      options.requirePairedEvidence === true ||
      options.requireAttestation === true;
    if (strictModelDefault) {
      if (!verdictIsGreen(manifest.verdict)) fail("model-default verdict must explicitly be pass/green");
      if (typeof manifest.generatedAt !== "string" || !Number.isFinite(Date.parse(manifest.generatedAt))) {
        fail("model-default generatedAt must be a valid timestamp");
      }
    }
    const rawDigestValue = manifest.rawDigest ?? modelDefault.rawDigest;
    if (rawDigestValue !== undefined) {
      const rawDigest = normalizedDigest(rawDigestValue, "rawDigest");
      checkAttestation(manifest, options.requireAttestation === true, options.trustedAttestationPublicKey ?? envValue("OMS_MEASUREMENT_TRUSTED_PUBLIC_KEY"));
      return {
        ...manifest,
        profile,
        ...(qrelsHash === undefined ? {} : { qrelsHash: `sha256:${qrelsHash}` }),
        rawDigest: `sha256:${rawDigest}`,
        modelDefault,
      };
    }
    checkAttestation(manifest, options.requireAttestation === true, options.trustedAttestationPublicKey ?? envValue("OMS_MEASUREMENT_TRUSTED_PUBLIC_KEY"));
    return {
      ...manifest,
      profile,
      ...(qrelsHash === undefined ? {} : { qrelsHash: `sha256:${qrelsHash}` }),
      modelDefault,
    };
  }
  if (!isRecord(manifest.ndcgByClass) || Object.keys(manifest.ndcgByClass).length === 0) fail("ndcgByClass must be a non-empty object");
  checkNumericMetric(manifest.p50, "p50");
  checkNumericMetric(manifest.p95, "p95");
  if (typeof manifest.p50 === "number" && typeof manifest.p95 === "number" && manifest.p95 < manifest.p50) fail("p95 must not be less than p50");
  if (!isRecord(manifest.bootstrap)) fail("bootstrap must be an object");
  if (!Number.isInteger(manifest.bootstrap.seed) || manifest.bootstrap.seed < 0) fail("bootstrap.seed must be a non-negative integer");
  if (!Number.isInteger(manifest.bootstrap.samples) || manifest.bootstrap.samples < 100) fail("bootstrap.samples must be an integer >= 100");
  requireFinite(manifest.bootstrap.ciLow, "bootstrap.ciLow");
  requireFinite(manifest.bootstrap.ciHigh, "bootstrap.ciHigh");
  if (manifest.bootstrap.ciHigh < manifest.bootstrap.ciLow) fail("bootstrap.ciHigh must not be below ciLow");
  if (!verdictIsGreen(manifest.verdict)) fail("verdict must explicitly be pass/green");
  if (typeof manifest.generatedAt !== "string" || !Number.isFinite(Date.parse(manifest.generatedAt))) fail("generatedAt must be a valid timestamp");
  const rawDigest = normalizedDigest(manifest.rawDigest, "rawDigest");
  let c040;
  let armResults;
  let winnerArmId;
  if (profile === "boost-c040") {
    armResults = checkArmResults(manifest, requiredArmIds);
    winnerArmId = selectedWinnerArmId(manifest);
    crossCheckC040Arms(manifest, armResults, winnerArmId);
    checkPairedRawEvidence(
      manifest,
      armResults,
      requiredArmIds,
      options.requirePairedEvidence === true || options.required === true,
      options.preregisteredQrels ?? options.qrels,
    );
    c040 = calculateC040(manifest, options);
    if (manifest.verdict.c040 !== undefined && Boolean(manifest.verdict.c040) !== c040.pass) {
      fail(`verdict.c040 disagrees with calculated C040 (${c040.pass})`);
    }
    if (!c040.pass) fail(`C040 failed: ${c040.reasons.join("; ")}`);
    if (options.release === true &&
        (manifest.datasetId === "vault-redacted-r2" || /(?:fixture|golden)/i.test(manifest.datasetId))) {
      fail("release measurement datasetId must identify a real vault, not a fixture dataset");
    }
  }
  checkAttestation(
    manifest,
    options.requireAttestation === true,
    options.trustedAttestationPublicKey ?? envValue("OMS_MEASUREMENT_TRUSTED_PUBLIC_KEY"),
    armResults,
  );
  return {
    ...manifest,
    profile,
    qrelsHash: `sha256:${qrelsHash}`,
    rawDigest: `sha256:${rawDigest}`,
    ...(winnerArmId === undefined ? {} : { winnerArmId }),
    ...(c040 === undefined ? {} : { c040 }),
  };
}

/**
 * E-1 permits only an approved, time-bounded absence of model-default
 * measurement evidence. It never permits a boost-C040 waiver.
 */
export function validateNoDefaultWaiver(waiver, profile) {
  if (!isRecord(waiver)) fail("measurement waiver must be a JSON object");
  if (profile !== "model-default") {
    fail("measurement waiver is only valid for the model-default profile; boost-c040 is never waivable");
  }
  if (waiver.profile !== "model-default") {
    fail(`measurement waiver profile mismatch: expected model-default, got ${waiver.profile ?? "missing"}`);
  }
  if (waiver.noDefault !== true) {
    fail("measurement waiver.noDefault must be true");
  }
  requireNonEmptyString(waiver.reason, "measurement waiver.reason");
  requireNonEmptyString(waiver.approvedBy ?? waiver.approver, "measurement waiver.approvedBy");
  if (typeof waiver.expiresAt !== "string" || !Number.isFinite(Date.parse(waiver.expiresAt))) {
    fail("measurement waiver.expiresAt must be a valid timestamp");
  }
  if (Date.parse(waiver.expiresAt) <= Date.now()) fail("measurement waiver has expired");
  return waiver;
}

/**
 * Exercise the runtime contract which permits a temporary absence of an
 * installed default model. The runtime hooks are deliberately injected: this
 * release-time checker must not acquire a model or contact a provider itself.
 */
export function verifyNoDefaultContract(contract) {
  if (!isRecord(contract) ||
      typeof contract.resolveEmbeddingModel !== "function" ||
      typeof contract.defaultDescriptorExists !== "function" ||
      typeof contract.runMcp !== "function" ||
      typeof contract.fetch !== "function") {
    fail(
      "no-default assertion failed: runtime contract requires resolveEmbeddingModel, " +
      "defaultDescriptorExists, runMcp, and fetch hooks",
    );
  }

  const fetchCalls = [];
  const fetchSettlements = [];
  const fetch = (...args) => {
    fetchCalls.push(args);
    const result = contract.fetch(...args);
    if (result && typeof result.then === "function") {
      fetchSettlements.push(Promise.resolve(result));
    }
    return result;
  };
  const emptyEnv = {};
  const verify = async () => {
  if (await contract.defaultDescriptorExists()) {
    fail("no-default assertion failed: no default descriptor pointer is introduced");
  }

  const unavailable = await contract.resolveEmbeddingModel({
    env: emptyEnv,
    installedDefault: null,
    fetch,
  });
  if (unavailable?.available !== false ||
      unavailable?.source !== "none" ||
      unavailable?.provider !== undefined ||
      unavailable?.model !== undefined ||
      typeof unavailable?.receipt?.guidance !== "string" ||
      !unavailable.receipt.guidance.includes("OMS_EMBEDDING_PROVIDER") ||
      !unavailable.receipt.guidance.includes("OMS_EMBEDDING_MODEL") ||
      await contract.defaultDescriptorExists()) {
    fail("no-default assertion failed: no default descriptor pointer is introduced");
  }

  const configuredEnv = {
    OMS_EMBEDDING_PROVIDER: "contract-provider",
    OMS_EMBEDDING_MODEL: "contract-model",
  };
  const withoutWaiver = await contract.resolveEmbeddingModel({
    env: configuredEnv,
    installedDefault: null,
    fetch,
    waiverActive: false,
  });
  const withWaiver = await contract.resolveEmbeddingModel({
    env: configuredEnv,
    installedDefault: null,
    fetch,
    waiverActive: true,
  });
  let halfPairError;
  try {
    await contract.resolveEmbeddingModel({
      env: { OMS_EMBEDDING_PROVIDER: "contract-provider" },
      installedDefault: null,
      fetch,
      waiverActive: true,
    });
  } catch (error) {
    halfPairError = error;
  }
  const halfPairMessage = halfPairError instanceof Error ? halfPairError.message : String(halfPairError ?? "");
  if (JSON.stringify(withoutWaiver) !== JSON.stringify(withWaiver) ||
      withoutWaiver?.available !== true ||
      withoutWaiver?.source !== "configured" ||
      withoutWaiver?.provider !== configuredEnv.OMS_EMBEDDING_PROVIDER ||
      withoutWaiver?.model !== configuredEnv.OMS_EMBEDDING_MODEL ||
      !halfPairMessage.includes("OMS_EMBEDDING_PROVIDER") ||
      !halfPairMessage.includes("OMS_EMBEDDING_MODEL")) {
    fail("no-default assertion failed: explicit configuration behaviour is unchanged");
  }

  await contract.runMcp({ fetch, waiverActive: true });
  await Promise.all(fetchSettlements);
  if (fetchCalls.length !== 0) {
    fail("no-default assertion failed: zero downloads");
  }
  };
  return verify();
}

/** Run the checker from environment configuration. */
export function checkMeasurementManifest(options = {}) {
  const manifestPath = options.manifestPath ?? envValue("OMS_MEASUREMENT_MANIFEST");
  const required = options.required ?? process.env.OMS_MEASUREMENT_REQUIRED === "1";
  const configuredArmIds = options.requiredArmIds ?? expectedArmsFromEnv();
  const waiverPath =
    options.waiverPath ??
    envValue("OMS_MEASUREMENT_WAIVER_PATH") ??
    envValue("OMS_MEASUREMENT_WAIVER");
  const selectedProfile = (
    options.profile ??
    envValue("OMS_MEASUREMENT_PROFILE") ??
    "boost-c040"
  );
  if (!MEASUREMENT_PROFILES.includes(selectedProfile)) fail(`unknown measurement profile: ${selectedProfile}`);
  let waiver = options.waiver;
  if (waiver === undefined && waiverPath && waiverPath.trim().startsWith("{")) {
    try {
      waiver = JSON.parse(waiverPath);
    } catch (error) {
      fail(`measurement waiver must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (waiver === undefined && waiverPath) {
    try {
      const raw = readFileSync(waiverPath, "utf8");
      waiver = raw.trim().startsWith("{") ? JSON.parse(raw) : undefined;
    } catch (error) {
      fail(`could not read measurement waiver ${waiverPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (waiver !== undefined) {
    waiver = validateNoDefaultWaiver(waiver, selectedProfile);
    if (manifestPath) fail("measurement manifest and waiver are mutually exclusive");
    const verified = options.noDefaultContract === undefined
      ? createProductionNoDefaultContract().then((contract) => verifyNoDefaultContract(contract))
      : verifyNoDefaultContract(options.noDefaultContract);
    return Promise.resolve(verified).then(() => ({
      present: false,
      advisory: !required,
      waived: true,
      waiver,
    }));
  }
  // The boost-c040 gate is scoped to releases that actually change the shipped
  // ranking default. A release that ships the released baseline adopts no
  // unmeasured optimisation, so no manifest is applicable. A release that ships
  // anything else must adopt exactly the arm the evidence declares the winner.
  let shippedRankingPolicy;
  if (required && selectedProfile === "boost-c040") {
    shippedRankingPolicy = readShippedRankingPolicy(options.repoRoot ?? process.cwd());
    if (shippedRankingPolicy === RELEASED_BASELINE_RANKING_POLICY) {
      return {
        present: false,
        advisory: false,
        notApplicable: true,
        shippedRankingPolicy,
      };
    }
    if (!DEFAULT_REQUIRED_ARM_IDS.includes(shippedRankingPolicy)) {
      fail(
        `shipped ranking default "${shippedRankingPolicy}" is neither the released baseline ` +
          `"${RELEASED_BASELINE_RANKING_POLICY}" nor a preregistered arm ` +
          `(${DEFAULT_REQUIRED_ARM_IDS.join(", ")}); it cannot be certified by a boost-c040 manifest`,
      );
    }
  }
  if (!manifestPath) {
    if (required) fail("OMS_MEASUREMENT_MANIFEST is required but not configured");
    return { present: false, advisory: true };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`could not read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const preregisteredQrels = options.preregisteredQrels ?? preregisteredQrelsFromEnv();
  const checked = validateMeasurementManifest(manifest, {
    expectedQrelsHash: options.expectedQrelsHash ?? options.preregisteredQrelsHash ?? expectedQrelsHashFromEnv(),
    qrels: options.qrels,
    preregisteredQrels,
    requiredArmIds: configuredArmIds,
    profile: options.profile ?? envValue("OMS_MEASUREMENT_PROFILE") ?? manifest.profile ?? "boost-c040",
    required,
    requirePairedEvidence: required,
    requireAttestation: options.requireAttestation ?? process.env.OMS_MEASUREMENT_ATTESTATION_REQUIRED === "1",
    release: options.release ?? process.env.OMS_MEASUREMENT_RELEASE === "1",
    // Forward the injected trust anchors so the wrapper API is usable without
    // process environment mutation; env stays the fallback for CI.
    trustedAttestationPublicKey: options.trustedAttestationPublicKey,
    expectedModelDefault: options.expectedModelDefault ?? options.modelDefault,
  });
  // Bind the decision to the evidence: authentic, signed, paired evidence for a
  // different arm must not authorise shipping this one.
  if (shippedRankingPolicy !== undefined) {
    if (checked.winnerArmId === undefined) {
      fail(
        `manifest declares no winning arm, so it cannot certify shipped ranking default "${shippedRankingPolicy}"`,
      );
    }
    if (checked.winnerArmId !== shippedRankingPolicy) {
      fail(
        `shipped ranking default "${shippedRankingPolicy}" does not match the measured winning arm ` +
          `"${checked.winnerArmId}"; ship the measured winner or measure the shipped policy`,
      );
    }
  }
  return {
    present: true,
    advisory: false,
    manifest: checked,
    ...(shippedRankingPolicy === undefined ? {} : { shippedRankingPolicy }),
  };
}

export const validateManifest = validateMeasurementManifest;
export const checkManifest = checkMeasurementManifest;

async function createProductionNoDefaultContract() {
  try {
    const adapter = await import("../dist/kernel/measurement/no-default-contract.js");
    return adapter.createNoDefaultContract();
  } catch (error) {
    fail(
      "could not load the production no-default contract; run the TypeScript build before this release check: " +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main() {
  try {
    const result = await checkMeasurementManifest();
    if (!result.present && result.waived) console.log("[measurement] manifest check waived with an approved waiver");
    else if (!result.present && result.notApplicable) {
      console.log(
        `measurement gate: ranking default is the released baseline (${result.shippedRankingPolicy}); boost-c040 manifest not applicable`,
      );
    }
    else if (!result.present) console.log("[measurement] manifest not configured (advisory until required sentinel is enabled)");
    else console.log(`[measurement] ok: ${envValue("OMS_MEASUREMENT_MANIFEST")}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main();
