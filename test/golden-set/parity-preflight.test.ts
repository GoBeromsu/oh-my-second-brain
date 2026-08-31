import { describe, expect, it } from "vitest";
import {
  checkPreflight,
  formatPreflightReport,
  FORBIDDEN_THRESHOLD_OVERRIDES,
  type PreflightInput,
  type PreflightReport,
} from "./parity-preflight.js";
import { FORBIDDEN_THRESHOLD_OVERRIDES as GATE_OVERRIDES } from "./parity-gate.js";
import {
  PINNED_QMD_COMMIT,
  PINNED_QMD_VERSION,
} from "./parity-preregistration.js";
import type { CorpusSnapshot } from "./parity-corpus.js";

const DIGEST = "e".repeat(64);

function snapshot(fileCount = 21_045, digest = DIGEST): (vaultPath: string) => Promise<CorpusSnapshot> {
  return async () => ({ digest, fileCount, entries: [] });
}

/** A host where every precondition is met, so each test fails for one reason. */
function readyInput(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    vaultPath: "/vault",
    installedComparatorVersion: `qmd ${PINNED_QMD_VERSION}`,
    installedComparatorCommit: PINNED_QMD_COMMIT,
    expectedCorpusDigest: DIGEST,
    expectedCorpusFileCount: 21_045,
    expectedQueriesSha256: DIGEST,
    observedQueriesSha256: DIGEST,
    expectedQrelsSha256: DIGEST,
    observedQrelsSha256: DIGEST,
    queriesSupplied: true,
    qrelsSupplied: true,
    env: {},
    snapshot: snapshot(),
    ...overrides,
  };
}

function byId(report: PreflightReport, id: string) {
  const found = report.requirements.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`report is missing requirement ${id}`);
  return found;
}

describe("preflight readiness", () => {
  it("reports ready when every precondition is met", async () => {
    const report = await checkPreflight(readyInput());
    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.corpusDigest).toBe(DIGEST);
    expect(report.corpusFileCount).toBe(21_045);
  });

  it("always reports every requirement, not just the first failure", async () => {
    // A partial picture would send an operator round the loop once per blocker.
    const report = await checkPreflight(
      readyInput({
        installedComparatorVersion: "qmd 2.1.0",
        queriesSupplied: false,
        qrelsSupplied: false,
      }),
    );
    expect(report.requirements.map((entry) => entry.id)).toEqual([
      "thresholds-frozen",
      "corpus-readable",
      "corpus-frozen",
      "queries-frozen",
      "qrels-frozen",
      "comparator-pinned",
      "queries-supplied",
      "qrels-supplied",
    ]);
    expect(report.blockers).toHaveLength(3);
  });

  it("refuses a run whose frozen thresholds the environment tries to move", async () => {
    // Catching this before a multi-hour embed is the entire reason it is checked
    // first: discovering it afterwards would waste the run and tempt a re-tune.
    for (const name of FORBIDDEN_THRESHOLD_OVERRIDES) {
      const report = await checkPreflight(readyInput({ env: { [name]: "0.1" } }));
      expect(report.ready).toBe(false);
      const entry = byId(report, "thresholds-frozen");
      expect(entry.satisfied).toBe(false);
      expect(entry.detail).toMatch(/thresholds are frozen/);
      // Implementation hygiene, not the owner's problem.
      expect(entry.humanOnly).toBe(false);
    }
  });

  it("re-exports exactly the gate's forbidden override list", () => {
    // Two divergent lists would let a variable be refused by one and honoured by
    // the other.
    expect(FORBIDDEN_THRESHOLD_OVERRIDES).toBe(GATE_OVERRIDES);
  });

  it("rejects a comparator that is not the pinned build", async () => {
    const report = await checkPreflight(readyInput({ installedComparatorVersion: "qmd 2.1.0" }));
    const entry = byId(report, "comparator-pinned");
    expect(entry.satisfied).toBe(false);
    expect(entry.detail).toMatch(/installed qmd is 2\.1\.0/);
    expect(entry.humanOnly).toBe(false);
  });

  it("reports an absent comparator distinctly from a mismatched one", async () => {
    const report = await checkPreflight(readyInput({ installedComparatorVersion: undefined }));
    const entry = byId(report, "comparator-pinned");
    expect(entry.satisfied).toBe(false);
    expect(entry.detail).toMatch(/no qmd comparator is installed/);
  });

  it("rejects the pinned version when full commit provenance is absent", async () => {
    const report = await checkPreflight(readyInput({
      installedComparatorCommit: undefined,
    }));
    expect(byId(report, "comparator-pinned")).toMatchObject({
      satisfied: false,
      humanOnly: false,
    });
    expect(byId(report, "comparator-pinned").detail).toMatch(/semver alone is insufficient/);
  });

  it("accepts the pinned comparator version and exact commit", async () => {
    const report = await checkPreflight(readyInput());
    expect(byId(report, "comparator-pinned")).toMatchObject({ satisfied: true });
  });

  it("treats missing queries and labels as the owner's to supply", async () => {
    const report = await checkPreflight(
      readyInput({ queriesSupplied: false, qrelsSupplied: false }),
    );
    expect(byId(report, "queries-supplied")).toMatchObject({ satisfied: false, humanOnly: true });
    const qrels = byId(report, "qrels-supplied");
    expect(qrels).toMatchObject({ satisfied: false, humanOnly: true });
    expect(qrels.detail).toMatch(/never inferred/);
  });

  it("records the measured corpus digest so the declaration can be filled from evidence", async () => {
    const report = await checkPreflight(readyInput({ snapshot: snapshot(12, "f".repeat(64)) }));
    expect(byId(report, "corpus-readable").detail).toMatch(/12 markdown files digested to sha256:f{64}/);
    expect(byId(report, "corpus-frozen")).toMatchObject({
      satisfied: false,
      humanOnly: true,
    });
    expect(byId(report, "corpus-frozen").detail).toMatch(/does not match the preregistered/);
  });

  it("refuses readiness when no authoritative corpus identity is supplied", async () => {
    const report = await checkPreflight(readyInput({
      expectedCorpusDigest: undefined,
      expectedCorpusFileCount: undefined,
    }));

    expect(report.ready).toBe(false);
    expect(byId(report, "corpus-frozen").detail).toMatch(/no authoritative preregistered corpus/);
  });

  it("rejects query or qrels drift before expensive measurement", async () => {
    const report = await checkPreflight(readyInput({
      observedQueriesSha256: "a".repeat(64),
      observedQrelsSha256: "b".repeat(64),
    }));

    expect(byId(report, "queries-frozen").detail).toMatch(/does not match preregistered/);
    expect(byId(report, "qrels-frozen").detail).toMatch(/does not match preregistered/);
    expect(report.blockers.filter((entry) => entry.humanOnly)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "queries-frozen" }),
        expect.objectContaining({ id: "qrels-frozen" }),
      ]),
    );
  });

  it("fails an empty vault rather than measuring nothing", async () => {
    const report = await checkPreflight(readyInput({ snapshot: snapshot(0) }));
    expect(report.ready).toBe(false);
    expect(byId(report, "corpus-readable").detail).toMatch(/contains no markdown notes/);
  });

  it("reports an unreadable vault as a blocker instead of throwing", async () => {
    // A preflight that crashes tells the operator less than one that explains.
    const report = await checkPreflight(
      readyInput({
        snapshot: async () => {
          throw new Error("EACCES: permission denied");
        },
      }),
    );
    expect(report.ready).toBe(false);
    const entry = byId(report, "corpus-readable");
    expect(entry.satisfied).toBe(false);
    expect(entry.detail).toMatch(/could not read \/vault: EACCES/);
    expect(entry.humanOnly).toBe(true);
    expect(report.corpusDigest).toBeUndefined();
  });

  it("separates owner-resolvable blockers from remaining implementation work", async () => {
    // The distinction is what makes a pause honest: conflating them either hides
    // work or invents a handoff.
    const report = await checkPreflight(
      readyInput({
        env: { OMS_GOLDEN_MIN_RECALL: "0.1" },
        installedComparatorVersion: "qmd 2.1.0",
        qrelsSupplied: false,
      }),
    );
    expect(report.blockers.filter((entry) => entry.humanOnly).map((entry) => entry.id))
      .toEqual(["qrels-supplied"]);
    expect(report.blockers.filter((entry) => !entry.humanOnly).map((entry) => entry.id))
      .toEqual(["thresholds-frozen", "comparator-pinned"]);
  });
});

describe("preflight report rendering", () => {
  it("announces readiness and marks each satisfied requirement", async () => {
    const text = formatPreflightReport(await checkPreflight(readyInput()));
    expect(text).toMatch(/^parity preflight: READY/u);
    expect(text).toMatch(/\[ok {2}\] comparator-pinned/);
    expect(text).not.toMatch(/blocker\(s\)/);
  });

  it("marks owner-owned blockers USER and implementation gaps TODO", async () => {
    const text = formatPreflightReport(
      await checkPreflight(
        readyInput({
          env: { OMS_GOLDEN_MIN_RECALL: "0.1" },
          installedComparatorVersion: "qmd 2.1.0",
          queriesSupplied: false,
        }),
      ),
    );
    expect(text).toMatch(/^parity preflight: BLOCKED/u);
    expect(text).toMatch(/\[TODO\] thresholds-frozen/);
    expect(text).toMatch(/\[TODO\] comparator-pinned/);
    expect(text).toMatch(/\[USER\] queries-supplied/);
    expect(text).toMatch(/3 blocker\(s\): 1 require the vault owner, 2 are still implementation work\./);
  });
});
