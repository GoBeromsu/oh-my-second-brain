import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  withInterviewLedgerLock,
  readInterviewLedger,
  type InterviewLedger,
} from "./interview-ledger.js";
import type { WriteTarget } from "../capture/safe.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function target(vault: string, source: WriteTarget["source"] = "explicit"): WriteTarget {
  return { vault, source };
}

function ledger(censusDigest: `sha256:${string}`, raw: string): InterviewLedger {
  return {
    version: 1,
    censusDigest,
    answers: {
      "question-1": {
        anchorDigest: digest("anchor"),
        disposition: "confirm",
        raw,
        extension: { preserved: true },
      },
    },
    extension: { preserved: ["user", "data"] },
  };
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-interview-ledger-"));
  roots.push(root);
  return root;
}

describe("template interview ledger", () => {
  it("reads a missing ledger without creating .oms", async () => {
    const vault = await fixture();

    await expect(readInterviewLedger(vault)).resolves.toEqual({ ledger: null, digest: null });
    await expect(readdir(vault)).resolves.toEqual([]);
  });

  it("persists and reloads answers with unknown user data", async () => {
    const vault = await fixture();
    const censusDigest = digest("census");
    const saved = await withInterviewLedgerLock(
      target(vault),
      { expectedLedgerDigest: null, expectedCensusDigest: censusDigest, verifyCensus: async () => censusDigest },
      async ({ save }) => save(ledger(censusDigest, "confirmed")),
    );
    expect(saved.ledger?.answers["question-1"]?.raw).toBe("confirmed");
    expect(saved.digest).toEqual(expect.any(String));

    const reloaded = await readInterviewLedger(vault);
    expect(reloaded).toEqual(saved);
    expect(reloaded.ledger?.extension).toEqual({ preserved: ["user", "data"] });
    expect(reloaded.ledger?.answers["question-1"]?.extension).toEqual({ preserved: true });
  });

  it("allows a fresh census request to resume a ledger with an older historical census", async () => {
    const vault = await fixture();
    const oldCensusDigest = digest("old-census");
    const newCensusDigest = digest("new-census");
    const initial = await withInterviewLedgerLock(
      target(vault),
      { expectedLedgerDigest: null, expectedCensusDigest: oldCensusDigest, verifyCensus: async () => oldCensusDigest },
      async ({ save }) => save(ledger(oldCensusDigest, "before")),
    );
    const resumed = await withInterviewLedgerLock(
      target(vault),
      { expectedLedgerDigest: initial.digest!, expectedCensusDigest: newCensusDigest, verifyCensus: async () => newCensusDigest },
      async ({ ledger: current, save }) => {
        if (current === null) throw new Error("expected a persisted ledger");
        return save({
          ...current,
          censusDigest: newCensusDigest,
          answers: {
            ...current.answers,
            "question-2": {
              anchorDigest: digest("status-anchor"),
              disposition: "defer",
              raw: "later",
            },
          },
        });
      },
    );
    expect(resumed.ledger?.censusDigest).toBe(newCensusDigest);
    expect(resumed.ledger?.extension).toEqual({ preserved: ["user", "data"] });
    expect(resumed.ledger?.answers["question-1"]?.extension).toEqual({ preserved: true });
    expect(resumed.ledger?.answers["question-2"]?.raw).toBe("later");
    expect(resumed.ledger?.answers["question-2"]?.disposition).toBe("defer");
  });

  it("rejects stale ledger and census writes without changing bytes", async () => {
    const vault = await fixture();
    const censusDigest = digest("census");
    const first = await withInterviewLedgerLock(
      target(vault),
      { expectedLedgerDigest: null, expectedCensusDigest: censusDigest, verifyCensus: async () => censusDigest },
      async ({ save }) => save(ledger(censusDigest, "before")),
    );
    const before = await readFile(join(vault, ".oms", "template-interview.json"));

    await expect(withInterviewLedgerLock(
      target(vault),
      { expectedLedgerDigest: null, expectedCensusDigest: censusDigest, verifyCensus: async () => censusDigest },
      async ({ save }) => save(ledger(censusDigest, "wrong-ledger")),
    )).rejects.toThrow("TEMPLATE_INTERVIEW_STALE");
    await expect(withInterviewLedgerLock(
      target(vault),
      { expectedLedgerDigest: first.digest, expectedCensusDigest: censusDigest, verifyCensus: async () => digest("changed") },
      async ({ save }) => save(ledger(censusDigest, "wrong-census")),
    )).rejects.toThrow("TEMPLATE_INTERVIEW_STALE");
    await expect(readFile(join(vault, ".oms", "template-interview.json"))).resolves.toEqual(before);
  });

  it("serializes same-digest concurrent saves so only one succeeds", async () => {
    const vault = await fixture();
    const censusDigest = digest("census");
    const operation = (value: string) => withInterviewLedgerLock(
      target(vault),
      { expectedLedgerDigest: null, expectedCensusDigest: censusDigest, verifyCensus: async () => censusDigest },
      async ({ save }) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return save(ledger(censusDigest, value));
      },
    );
    const results = await Promise.allSettled([operation("first"), operation("second")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected" && String(result.reason).includes("TEMPLATE_INTERVIEW_STALE"))).toHaveLength(1);
  });

  it("reports malformed JSON and schema without overwriting", async () => {
    const vault = await fixture();
    await mkdir(join(vault, ".oms"), { recursive: true });
    const path = join(vault, ".oms", "template-interview.json");
    await writeFile(path, "{malformed");
    await expect(readInterviewLedger(vault)).rejects.toThrow("TEMPLATE_INTERVIEW_INVALID");
    await expect(readFile(path, "utf8")).resolves.toBe("{malformed");

    await writeFile(path, JSON.stringify({ version: 1, answers: {} }));
    await expect(readInterviewLedger(vault)).rejects.toThrow("TEMPLATE_INTERVIEW_INVALID");
    await expect(readFile(path, "utf8")).resolves.toBe(JSON.stringify({ version: 1, answers: {} }));
  });

  it("rejects a caller-shaped answer that tries to replace the server anchor", async () => {
    const vault = await fixture();
    const censusDigest = digest("census");
    await expect(withInterviewLedgerLock(
      target(vault),
      { expectedLedgerDigest: null, expectedCensusDigest: censusDigest, verifyCensus: async () => censusDigest },
      async ({ save }) => save({
        version: 1,
        censusDigest,
        answers: {
          "question-1": {
            anchorDigest: "not-a-digest",
            disposition: "confirm",
            raw: "no",
          },
        },
      }),
    )).rejects.toThrow("TEMPLATE_INTERVIEW_INVALID");
    await expect(readdir(vault)).resolves.toEqual([]);
  });

  it("rejects symlinked controls and unverified cwd targets before creation", async () => {
    const vault = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "oms-interview-ledger-outside-"));
    roots.push(outside);
    await symlink(outside, join(vault, ".oms"));
    await expect(readInterviewLedger(vault)).rejects.toThrow("TEMPLATE_SOURCE_UNSAFE");
    await expect(withInterviewLedgerLock(
      target(vault),
      { expectedLedgerDigest: null, expectedCensusDigest: digest("census"), verifyCensus: async () => digest("census") },
      async () => undefined,
    )).rejects.toThrow("TEMPLATE_SOURCE_UNSAFE");

    const linked = await fixture();
    await mkdir(join(linked, ".oms"), { recursive: true });
    const outsideLedger = join(outside, "template-interview.json");
    await writeFile(outsideLedger, JSON.stringify(ledger(digest("census"), "outside")));
    await symlink(outsideLedger, join(linked, ".oms", "template-interview.json"));
    await expect(readInterviewLedger(linked)).rejects.toThrow("TEMPLATE_SOURCE_UNSAFE");
    await expect(withInterviewLedgerLock(
      target(linked),
      { expectedLedgerDigest: null, expectedCensusDigest: digest("census"), verifyCensus: async () => digest("census") },
      async () => undefined,
    )).rejects.toThrow("TEMPLATE_SOURCE_UNSAFE");

    const unverified = await fixture();
    await expect(withInterviewLedgerLock(
      target(unverified, "cwd"),
      { expectedLedgerDigest: null, expectedCensusDigest: digest("census"), verifyCensus: async () => digest("census") },
      async () => undefined,
    )).rejects.toThrow("target-unverified");
    await expect(readdir(unverified)).resolves.toEqual([]);
  });
});
