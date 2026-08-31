import { describe, expect, it } from "vitest";
import {
  checkInstalledBaseline,
  evaluateAdmissibility,
  PARITY_PROFILES,
  PINNED_QMD_COMMIT,
  PINNED_QMD_REPO,
  PINNED_QMD_VERSION,
  type FrozenSettings,
  type ParityPreregistration,
} from "./parity-preregistration.js";

const CORPUS = "a".repeat(64);
const QUERIES = "b".repeat(64);
const QRELS = "c".repeat(64);

function settings(overrides: Partial<FrozenSettings> = {}): FrozenSettings {
  return {
    candidateLimit: 40,
    k: 10,
    rrfK: 60,
    rerank: false,
    expansion: false,
    embedModel: "embeddinggemma-300m-q8_0",
    embedRevision: "0f741b5a6585bd53aeb15cd1372c56f2a0f65e12",
    embedSha256: "d".repeat(64),
    embedPromptScheme: "embeddinggemma-v1",
    qmdEmbedUri: "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
    ...overrides,
  };
}

function preregistration(
  overrides: Partial<Record<keyof ParityPreregistration, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    profile: "b1-foundation",
    baselineRepo: PINNED_QMD_REPO,
    baselineCommit: PINNED_QMD_COMMIT,
    baselineVersion: PINNED_QMD_VERSION,
    corpusDigest: CORPUS,
    corpusFileCount: 20_959,
    queriesSha256: QUERIES,
    qrelsSha256: QRELS,
    queryCount: 30,
    settings: settings(),
    hardware: "Apple M1 Pro, 32 GiB",
    seed: 20260830,
    ...overrides,
  };
}

describe("admissibility of a declared parity run", () => {
  it("admits a fully frozen declaration", () => {
    expect(evaluateAdmissibility(preregistration())).toEqual({ admissible: true, failures: [] });
  });

  it("admits both declared profiles", () => {
    for (const profile of PARITY_PROFILES) {
      expect(evaluateAdmissibility(preregistration({ profile })).admissible).toBe(true);
    }
  });

  it("rejects a non-object declaration", () => {
    for (const bad of [null, undefined, 42, "prereg", []]) {
      const verdict = evaluateAdmissibility(bad);
      expect(verdict.admissible).toBe(false);
      expect(verdict.failures.join("\n")).toMatch(/must be an object/);
    }
  });

  it("rejects an unknown schema version or profile", () => {
    expect(evaluateAdmissibility(preregistration({ schemaVersion: 2 })).failures.join("\n"))
      .toMatch(/schemaVersion must be 1/);
    expect(evaluateAdmissibility(preregistration({ profile: "b3-someday" })).failures.join("\n"))
      .toMatch(/profile must be one of/);
  });

  it("rejects a comparator that is not the pinned baseline", () => {
    // This is the whole basis of a parity claim: a different build is a different
    // comparator, so the commit is matched exactly rather than by version range.
    const wrongCommit = evaluateAdmissibility(
      preregistration({ baselineCommit: "0".repeat(40) }),
    );
    expect(wrongCommit.admissible).toBe(false);
    expect(wrongCommit.failures.join("\n")).toMatch(/must be the pinned/);
    expect(wrongCommit.failures.join("\n")).toMatch(/requires a new preregistration/);

    expect(evaluateAdmissibility(preregistration({ baselineVersion: "2.1.0" })).admissible).toBe(false);
    expect(evaluateAdmissibility(preregistration({ baselineRepo: "https://example.invalid/qmd" })).admissible)
      .toBe(false);
  });

  it.each(["corpusDigest", "queriesSha256", "qrelsSha256"] as const)(
    "requires %s to be a real sha256 digest",
    (field) => {
      for (const bad of ["", "not-a-digest", "a".repeat(63), "A".repeat(64) + "z", 12345]) {
        const verdict = evaluateAdmissibility(preregistration({ [field]: bad }));
        expect(verdict.admissible).toBe(false);
        expect(verdict.failures.join("\n")).toMatch(new RegExp(field));
      }
    },
  );

  it("accepts a sha256-prefixed or upper-case digest as the same digest", () => {
    const verdict = evaluateAdmissibility(
      preregistration({ corpusDigest: `sha256:${CORPUS.toUpperCase()}` }),
    );
    expect(verdict).toEqual({ admissible: true, failures: [] });
  });

  it("rejects reusing one artifact as both queries and labels", () => {
    const verdict = evaluateAdmissibility(preregistration({ qrelsSha256: QUERIES }));
    expect(verdict.admissible).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/must be distinct artifacts/);
  });

  it("still catches the reuse when the two digests differ only in spelling", () => {
    // `sha256:AB…` and `ab…` are the same digest; comparing raw strings would let
    // that difference hide the defect.
    const verdict = evaluateAdmissibility(
      preregistration({ qrelsSha256: `sha256:${QUERIES.toUpperCase()}` }),
    );
    expect(verdict.admissible).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/must be distinct artifacts/);
  });

  it("requires a positive query count", () => {
    for (const bad of [0, -5, 1.5, "30"]) {
      expect(evaluateAdmissibility(preregistration({ queryCount: bad })).admissible).toBe(false);
    }
  });

  it("requires the exact frozen corpus file count", () => {
    for (const corpusFileCount of [undefined, 0, -1, 1.5, Number.NaN]) {
      const verdict = evaluateAdmissibility(preregistration({
        corpusFileCount,
      } as Partial<ParityPreregistration>));
      expect(verdict.admissible).toBe(false);
      expect(verdict.failures.join("\n")).toMatch(/corpusFileCount must be a positive integer/);
    }
  });

  it("requires reproducibility inputs", () => {
    expect(evaluateAdmissibility(preregistration({ hardware: "  " })).failures.join("\n"))
      .toMatch(/hardware must be a nonblank string/);
    expect(evaluateAdmissibility(preregistration({ seed: 1.5 })).failures.join("\n"))
      .toMatch(/seed must be an integer/);
  });

  it("requires frozen retrieval settings to be complete", () => {
    expect(evaluateAdmissibility(preregistration({ settings: "default" })).failures.join("\n"))
      .toMatch(/settings must be an object/);
    for (const field of ["candidateLimit", "k", "rrfK"] as const) {
      const verdict = evaluateAdmissibility(
        preregistration({ settings: settings({ [field]: 0 }) }),
      );
      expect(verdict.failures.join("\n")).toMatch(new RegExp(`settings.${field}`));
    }
    for (const field of ["rerank", "expansion"] as const) {
      const verdict = evaluateAdmissibility(
        preregistration({ settings: { ...settings(), [field]: "yes" } }),
      );
      expect(verdict.failures.join("\n")).toMatch(new RegExp(`settings.${field} must be a boolean`));
    }
    for (const field of ["embedModel", "embedRevision", "embedPromptScheme", "qmdEmbedUri"] as const) {
      const verdict = evaluateAdmissibility(
        preregistration({ settings: settings({ [field]: "" }) }),
      );
      expect(verdict.failures.join("\n")).toMatch(new RegExp(`settings\\.${field}`));
    }
  });

  it("requires the frozen embedding artifact checksum", () => {
    for (const embedSha256 of ["", "bad", "g".repeat(64), "a".repeat(63)]) {
      const verdict = evaluateAdmissibility(
        preregistration({ settings: settings({ embedSha256 }) }),
      );
      expect(verdict.admissible).toBe(false);
      expect(verdict.failures.join("\n")).toMatch(/settings\.embedSha256/);
    }
  });

  it("requires full rerank and generate identities when precision capabilities are enabled", () => {
    const verdict = evaluateAdmissibility(preregistration({
      profile: "b2-parity",
      settings: settings({ rerank: true, expansion: true }),
    }));

    expect(verdict.admissible).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/settings\.rerankModel/);
    expect(verdict.failures.join("\n")).toMatch(/settings\.rerankSha256/);
    expect(verdict.failures.join("\n")).toMatch(/settings\.generateModel/);
    expect(verdict.failures.join("\n")).toMatch(/settings\.generateSha256/);
    expect(verdict.failures.join("\n")).toMatch(/settings\.generatePromptScheme/);
  });

  it("rejects a metric depth deeper than the candidate pool", () => {
    // Scoring at k=50 over 40 candidates would measure truncation, not ranking.
    const verdict = evaluateAdmissibility(
      preregistration({ settings: settings({ candidateLimit: 40, k: 50 }) }),
    );
    expect(verdict.admissible).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/k must not exceed settings.candidateLimit/);
  });

  it("allows k exactly equal to the candidate pool", () => {
    expect(
      evaluateAdmissibility(preregistration({ settings: settings({ candidateLimit: 10, k: 10 }) }))
        .admissible,
    ).toBe(true);
  });

  it("reports every defect in one pass", () => {
    const verdict = evaluateAdmissibility({
      schemaVersion: 9,
      profile: "nope",
      baselineCommit: "abc",
      corpusDigest: "bad",
    });
    expect(verdict.admissible).toBe(false);
    expect(verdict.failures.length).toBeGreaterThanOrEqual(6);
  });
});

describe("installed comparator baseline", () => {
  it("accepts the pinned version", () => {
    expect(checkInstalledBaseline(
      `qmd ${PINNED_QMD_VERSION}`,
      PINNED_QMD_COMMIT,
    )).toEqual({ ok: true });
    expect(checkInstalledBaseline(
      `  QMD ${PINNED_QMD_VERSION}\n`,
      PINNED_QMD_COMMIT.toUpperCase(),
    ).ok).toBe(true);
  });

  it("rejects a matching semver without exact commit provenance", () => {
    expect(checkInstalledBaseline(`qmd ${PINNED_QMD_VERSION}`)).toEqual({
      ok: false,
      reason: expect.stringMatching(/semver alone is insufficient/),
    });
    expect(checkInstalledBaseline(
      `qmd ${PINNED_QMD_VERSION}`,
      "e".repeat(40),
    ).reason).toMatch(/installed qmd commit/);
  });

  it("rejects the version actually installed on this host today", () => {
    // Recorded deliberately: the local binary is 2.1.0, so a comparator arm run
    // here would not be measuring the pinned baseline at all.
    const result = checkInstalledBaseline("qmd 2.1.0");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/installed qmd is 2\.1\.0/);
    expect(result.reason).toMatch(new RegExp(PINNED_QMD_COMMIT));
  });

  it("rejects output it cannot parse rather than assuming a match", () => {
    for (const bad of ["", "not a version", "qmd unknown"]) {
      const result = checkInstalledBaseline(bad);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/could not parse a qmd version/);
    }
  });
});
