import {
  assertFrozenThresholds,
  evaluateOperabilityGate,
  evaluateParityGate,
  type GateVerdict,
  type OperabilityInput,
  type ParityGateVerdict,
  type ParityRelevanceInput,
} from "./parity-gate.js";
import {
  evaluateAdmissibility,
  type ParityPreregistration,
  type ParityProfile,
} from "./parity-preregistration.js";
import {
  decideStopPolicy,
  serializeOutcome,
  type ParityEvidenceRefs,
  type ParityOutcome,
} from "./parity-stop-policy.js";

export interface ObservedParityEvidence extends ParityEvidenceRefs {
  readonly queryCount: number;
  readonly corpusFileCount: number;
  readonly embedModel: string;
  readonly embedRevision: string;
  readonly embedSha256: string;
  readonly embedPromptScheme: string;
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

export interface AuditedParityOutcomeInput {
  readonly preregistration: ParityPreregistration;
  readonly observedEvidence: ObservedParityEvidence;
  readonly relevance: ParityRelevanceInput;
  readonly operability: OperabilityInput;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Required for b2-parity; preserves the complete audited B1 admission record. */
  readonly priorB1Record?: AuditedParityOutcome;
}

export interface AuditedParityOutcome {
  readonly schema: "oms.audited-parity-outcome.v1";
  readonly admissible: boolean;
  readonly admissibilityFailures: readonly string[];
  readonly preregistration: ParityPreregistration;
  readonly observedEvidence: ObservedParityEvidence;
  readonly relevanceMeasurement: ParityRelevanceInput;
  readonly operabilityMeasurement: OperabilityInput;
  readonly gate: ParityGateVerdict;
  readonly outcome: ParityOutcome;
}

function digest(value: string): string {
  return value.replace(/^sha256:/iu, "").toLowerCase();
}

function evidenceFailures(
  preregistration: ParityPreregistration,
  observed: ObservedParityEvidence,
): string[] {
  const failures: string[] = [];
  for (const field of [
    "corpusDigest",
    "queriesSha256",
    "qrelsSha256",
  ] as const) {
    if (digest(preregistration[field]) !== digest(observed[field])) {
      failures.push(
        `${field} drifted after preregistration: expected ${preregistration[field]}, ` +
          `observed ${observed[field]}`,
      );
    }
  }
  for (const field of [
    "rerankModel",
    "rerankRevision",
    "rerankSha256",
    "qmdRerankUri",
    "generateModel",
    "generateRevision",
    "generateSha256",
    "generatePromptScheme",
    "qmdGenerateUri",
  ] as const) {
    const expected = preregistration.settings[field];
    if (expected === undefined) continue;
    const actual = observed[field];
    if (
      actual === undefined
      || expected.replace(/^sha256:/iu, "").toLowerCase()
        !== actual.replace(/^sha256:/iu, "").toLowerCase()
    ) {
      failures.push(
        `${field} drifted after preregistration: expected ${expected}, ` +
          `observed ${String(actual)}`,
      );
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(digest(observed.rawResultsDigest))) {
    failures.push("observed rawResultsDigest must be a sha256 digest");
  }
  if (preregistration.baselineCommit !== observed.baselineCommit) {
    failures.push(
      `baselineCommit drifted after preregistration: expected ${preregistration.baselineCommit}, ` +
        `observed ${observed.baselineCommit}`,
    );
  }
  if (preregistration.queryCount !== observed.queryCount) {
    failures.push(
      `queryCount drifted after preregistration: expected ${preregistration.queryCount}, ` +
        `observed ${observed.queryCount}`,
    );
  }
  if (preregistration.corpusFileCount !== observed.corpusFileCount) {
    failures.push(
      `corpusFileCount drifted after preregistration: expected ${preregistration.corpusFileCount}, ` +
        `observed ${observed.corpusFileCount}`,
    );
  }
  for (const field of [
    "embedModel",
    "embedRevision",
    "embedSha256",
    "embedPromptScheme",
    "qmdEmbedUri",
  ] as const) {
    const expected = preregistration.settings[field].replace(/^sha256:/iu, "").toLowerCase();
    const actual = observed[field].replace(/^sha256:/iu, "").toLowerCase();
    if (expected !== actual) {
      failures.push(
        `${field} drifted after preregistration: expected ${preregistration.settings[field]}, ` +
          `observed ${observed[field]}`,
      );
    }
  }
  return failures;
}

export function validatePriorB1Record(
  current: ParityPreregistration,
  prior: AuditedParityOutcome | undefined,
): readonly string[] {
  if (prior === undefined) {
    return ["b2-parity requires a preserved complete audited b1-foundation record"];
  }
  const priorDeclared = evaluateAdmissibility(prior.preregistration);
  const priorEvidenceFailures = evidenceFailures(
    prior.preregistration,
    prior.observedEvidence,
  );
  const priorGate = prior.relevanceMeasurement === undefined
    ? undefined
    : evaluateParityGate(
      prior.relevanceMeasurement,
      prior.operabilityMeasurement,
      {},
    );
  const priorOutcome = priorGate === undefined
    ? undefined
    : decideStopPolicy("b1-foundation", priorGate, prior.observedEvidence);
  const commonPreregistrationFields = [
    "baselineRepo",
    "baselineCommit",
    "baselineVersion",
    "corpusDigest",
    "corpusFileCount",
    "queriesSha256",
    "qrelsSha256",
    "queryCount",
    "hardware",
    "seed",
  ] as const;
  const commonSettingFields = [
    "candidateLimit",
    "k",
    "rrfK",
    "embedModel",
    "embedRevision",
    "embedSha256",
    "embedPromptScheme",
    "qmdEmbedUri",
  ] as const;
  const commonEvidenceMatches =
    commonPreregistrationFields.every((field) =>
      prior.preregistration[field] === current[field])
    && commonSettingFields.every((field) =>
      prior.preregistration.settings[field] === current.settings[field]);
  if (
    prior.schema !== "oms.audited-parity-outcome.v1"
    || prior.preregistration.profile !== "b1-foundation"
    || !prior.admissible
    || prior.admissibilityFailures.length > 0
    || !priorDeclared.admissible
    || priorEvidenceFailures.length > 0
    || prior.preregistration.settings.expansion
    || prior.relevanceMeasurement === undefined
    || !prior.gate.relevance.passed
    || !prior.gate.operability.passed
    || !prior.outcome.passed
    || !prior.outcome.mayStartB2
    || JSON.stringify(prior.gate) !== JSON.stringify(priorGate)
    || JSON.stringify(prior.outcome) !== JSON.stringify(priorOutcome)
    || !commonEvidenceMatches
  ) {
    return [
      "b2-parity requires a preserved complete audited b1-foundation record " +
        "with recomputed clean gates/outcome and exact common frozen evidence",
    ];
  }
  return [];
}

function profileFailures(input: AuditedParityOutcomeInput): string[] {
  const failures: string[] = [];
  const expected = input.preregistration.profile === "b1-foundation"
    ? ["lex", "vec"]
    : ["lex", "vec", "hyde"];
  if (JSON.stringify(input.relevance.expectedModalities) !== JSON.stringify(expected)) {
    failures.push(
      `${input.preregistration.profile} must declare modalities ${expected.join(", ")} in frozen order`,
    );
  }
  const expansionExpected = input.preregistration.profile === "b2-parity";
  if (input.preregistration.settings.expansion !== expansionExpected) {
    failures.push(
      `${input.preregistration.profile} requires settings.expansion=${String(expansionExpected)}`,
    );
  }
  if (input.preregistration.settings.rerank !== expansionExpected) {
    failures.push(
      `${input.preregistration.profile} requires settings.rerank=${String(expansionExpected)}`,
    );
  }
  if (input.preregistration.profile === "b2-parity") {
    failures.push(...validatePriorB1Record(
      input.preregistration,
      input.priorB1Record,
    ));
  }
  return failures;
}

function inadmissibleGate(
  failures: readonly string[],
  operability: OperabilityInput,
): ParityGateVerdict {
  const relevance: GateVerdict = {
    passed: false,
    failures: ["relevance was not scored because the run is inadmissible"],
  };
  const operabilityVerdict = evaluateOperabilityGate(operability);
  return {
    passed: false,
    relevance,
    operability: operabilityVerdict,
    mayClaimReplacement: false,
    failures: [...failures, ...relevance.failures, ...operabilityVerdict.failures],
  };
}

/**
 * Admit, evaluate, and gate one frozen parity run through a single call.
 *
 * An inadmissible run is never scored for relevance. It still retains its
 * operability measurement and every evidence mismatch in the outcome, so a
 * failed or drifting run cannot disappear behind a later rerun.
 */
export function evaluateAuditedParityOutcome(
  input: AuditedParityOutcomeInput,
): AuditedParityOutcome {
  const declared = evaluateAdmissibility(input.preregistration);
  const failures = [
    ...declared.failures,
    ...evidenceFailures(input.preregistration, input.observedEvidence),
    ...profileFailures(input),
  ];
  try {
    assertFrozenThresholds(input.env ?? process.env);
  } catch (error: unknown) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  const gate = failures.length === 0
    ? evaluateParityGate(input.relevance, input.operability, input.env ?? process.env)
    : inadmissibleGate(failures, input.operability);
  const outcome = decideStopPolicy(
    input.preregistration.profile,
    gate,
    input.observedEvidence,
  );
  return {
    schema: "oms.audited-parity-outcome.v1",
    admissible: failures.length === 0,
    admissibilityFailures: failures,
    preregistration: input.preregistration,
    observedEvidence: input.observedEvidence,
    relevanceMeasurement: input.relevance,
    operabilityMeasurement: input.operability,
    gate,
    outcome,
  };
}

/** Deterministic complete record, including the stop-policy receipt. */
export function serializeAuditedParityOutcome(record: AuditedParityOutcome): string {
  return `${JSON.stringify({
    schema: record.schema,
    admissible: record.admissible,
    admissibilityFailures: record.admissibilityFailures,
    preregistration: {
      schemaVersion: record.preregistration.schemaVersion,
      profile: record.preregistration.profile,
      baselineRepo: record.preregistration.baselineRepo,
      baselineCommit: record.preregistration.baselineCommit,
      baselineVersion: record.preregistration.baselineVersion,
      corpusDigest: record.preregistration.corpusDigest,
      corpusFileCount: record.preregistration.corpusFileCount,
      queriesSha256: record.preregistration.queriesSha256,
      qrelsSha256: record.preregistration.qrelsSha256,
      queryCount: record.preregistration.queryCount,
      settings: {
        candidateLimit: record.preregistration.settings.candidateLimit,
        k: record.preregistration.settings.k,
        rrfK: record.preregistration.settings.rrfK,
        rerank: record.preregistration.settings.rerank,
        expansion: record.preregistration.settings.expansion,
        embedModel: record.preregistration.settings.embedModel,
        embedRevision: record.preregistration.settings.embedRevision,
        embedSha256: record.preregistration.settings.embedSha256,
        embedPromptScheme: record.preregistration.settings.embedPromptScheme,
        qmdEmbedUri: record.preregistration.settings.qmdEmbedUri,
        ...(record.preregistration.settings.rerankModel === undefined ? {} : {
          rerankModel: record.preregistration.settings.rerankModel,
          rerankRevision: record.preregistration.settings.rerankRevision,
          rerankSha256: record.preregistration.settings.rerankSha256,
          qmdRerankUri: record.preregistration.settings.qmdRerankUri,
        }),
        ...(record.preregistration.settings.generateModel === undefined ? {} : {
          generateModel: record.preregistration.settings.generateModel,
          generateRevision: record.preregistration.settings.generateRevision,
          generateSha256: record.preregistration.settings.generateSha256,
          generatePromptScheme: record.preregistration.settings.generatePromptScheme,
          qmdGenerateUri: record.preregistration.settings.qmdGenerateUri,
        }),
      },
      hardware: record.preregistration.hardware,
      seed: record.preregistration.seed,
    },
    observedEvidence: {
      baselineCommit: record.observedEvidence.baselineCommit,
      corpusDigest: record.observedEvidence.corpusDigest,
      queriesSha256: record.observedEvidence.queriesSha256,
      qrelsSha256: record.observedEvidence.qrelsSha256,
      rawResultsDigest: record.observedEvidence.rawResultsDigest,
      queryCount: record.observedEvidence.queryCount,
      corpusFileCount: record.observedEvidence.corpusFileCount,
      embedModel: record.observedEvidence.embedModel,
      embedRevision: record.observedEvidence.embedRevision,
      embedSha256: record.observedEvidence.embedSha256,
      embedPromptScheme: record.observedEvidence.embedPromptScheme,
      qmdEmbedUri: record.observedEvidence.qmdEmbedUri,
      ...(record.observedEvidence.rerankModel === undefined ? {} : {
        rerankModel: record.observedEvidence.rerankModel,
        rerankRevision: record.observedEvidence.rerankRevision,
        rerankSha256: record.observedEvidence.rerankSha256,
        qmdRerankUri: record.observedEvidence.qmdRerankUri,
      }),
      ...(record.observedEvidence.generateModel === undefined ? {} : {
        generateModel: record.observedEvidence.generateModel,
        generateRevision: record.observedEvidence.generateRevision,
        generateSha256: record.observedEvidence.generateSha256,
        generatePromptScheme: record.observedEvidence.generatePromptScheme,
        qmdGenerateUri: record.observedEvidence.qmdGenerateUri,
      }),
    },
    relevanceMeasurement: record.relevanceMeasurement,
    operabilityMeasurement: {
      exitCode: record.operabilityMeasurement.exitCode,
      scanned: record.operabilityMeasurement.scanned,
      indexed: record.operabilityMeasurement.indexed,
      skipped: record.operabilityMeasurement.skipped,
      errors: record.operabilityMeasurement.errors,
      vectorCount: record.operabilityMeasurement.vectorCount,
      expectedVectorCount: record.operabilityMeasurement.expectedVectorCount,
      peakRssBytes: record.operabilityMeasurement.peakRssBytes,
      embedWallMs: record.operabilityMeasurement.embedWallMs,
      plainQueryP95Ms: record.operabilityMeasurement.plainQueryP95Ms,
      ...(record.operabilityMeasurement.precisionQueryP95Ms === undefined
        ? {}
        : { precisionQueryP95Ms: record.operabilityMeasurement.precisionQueryP95Ms }),
    },
    gate: {
      passed: record.gate.passed,
      relevance: record.gate.relevance,
      operability: record.gate.operability,
      mayClaimReplacement: record.gate.mayClaimReplacement,
      failures: record.gate.failures,
    },
    // Keep the canonical stop-policy spelling nested verbatim as parsed JSON.
    outcome: JSON.parse(serializeOutcome(record.outcome)) as unknown,
  }, null, 2)}\n`;
}

export function expectedModalitiesForProfile(profile: ParityProfile): readonly ("lex" | "vec" | "hyde")[] {
  return profile === "b1-foundation" ? ["lex", "vec"] : ["lex", "vec", "hyde"];
}
