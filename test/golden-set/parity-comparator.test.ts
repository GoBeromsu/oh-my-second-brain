import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertEvidenceBoundToPreregistration,
  assertRawEvidenceSeal,
  assertQmdEmbeddingIdentity,
  assertQmdModelSetIdentity,
  assertPinnedComparator,
  buildPairedRelevance,
  omsRowsFromHarness,
  pairParityRows,
  parityRawEvidenceDigest,
  parityQueriesSha256,
  prepareQmdComparator,
  runOmsComparatorArm,
  runQmdComparatorArm,
  type CommandRunner,
  type ParityArmRow,
  type QmdComparatorConfig,
} from "./parity-comparator.js";
import { evaluateRelevanceGate, type ParityModality } from "./parity-gate.js";
import {
  PINNED_QMD_COMMIT,
  PINNED_QMD_REPO,
  PINNED_QMD_VERSION,
  type FrozenSettings,
  type ParityPreregistration,
} from "./parity-preregistration.js";
import { qrelsSha256, type Qrels, type QueryReport } from "./harness.js";

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const settings = (expansion = false): FrozenSettings => ({
  candidateLimit: 40,
  k: 10,
  rrfK: 60,
  rerank: expansion,
  expansion,
  embedModel: "embeddinggemma",
  embedRevision: "pinned",
  embedSha256: "e".repeat(64),
  embedPromptScheme: "embeddinggemma-v1",
  qmdEmbedUri: "hf:example/embeddinggemma.gguf",
  ...(expansion ? {
    rerankModel: "reranker",
    rerankRevision: "rerank-revision",
    rerankSha256: "1".repeat(64),
    qmdRerankUri: "hf:example/reranker.gguf",
    generateModel: "generator",
    generateRevision: "generate-revision",
    generateSha256: "2".repeat(64),
    generatePromptScheme: "qmd-query-expansion-v2.8.3",
    qmdGenerateUri: "hf:example/generator.gguf",
  } : {}),
});

function fakeRunner(outputs: string[]): CommandRunner {
  let query = 0;
  return vi.fn((executable, args) => {
    if (executable === "git") {
      return { exitCode: 0, stdout: `${PINNED_QMD_COMMIT}\n`, stderr: "" };
    }
    if (args[0] === "--version") {
      return { exitCode: 0, stdout: `qmd ${PINNED_QMD_VERSION} (facd35e)\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: outputs[query++] ?? "[]", stderr: "" };
  });
}

function config(run: CommandRunner): QmdComparatorConfig {
  let now = 0;
  return {
    root: "/qmd",
    index: "parity",
    collection: "vault",
    vaultPath: "/vault",
    run,
    now: () => ++now,
  };
}

const queries = [
  { id: "lex-1", type: "lex" as const, queryClass: "ko", query: "평온" },
  { id: "vec-1", type: "vec" as const, queryClass: "en", query: "inner calm" },
  { id: "hyde-1", type: "hyde" as const, queryClass: "mixed", query: "answer passage" },
  { id: "graph-1", type: "graph" as const, queryClass: "en", query: "seed.md" },
];

describe("runQmdComparatorArm", () => {
  it("verifies full commit and routes the B1 modalities through pinned qmd", () => {
    const run = fakeRunner([
      JSON.stringify([{ file: "qmd://vault/notes/calm.md", score: 0.9 }]),
      JSON.stringify({ results: [{ path: "/vault/references/calm.md", score: 0.8 }] }),
    ]);

    const rows = runQmdComparatorArm(queries, settings(false), {
      ...config(run),
      env: { QMD_EMBED_MODEL: "hf:evil/model.gguf" },
    });

    expect(rows.map(({ id, hits }) => [id, hits[0]?.path])).toEqual([
      ["lex-1", "notes/calm.md"],
      ["vec-1", "references/calm.md"],
    ]);
    const calls = vi.mocked(run).mock.calls;
    expect(calls.some(([, args]) => args[0] === "search")).toBe(true);
    expect(calls.some(([, args]) => args[0] === "vsearch")).toBe(true);
    expect(calls.some(([, args]) => args.includes("--no-rerank"))).toBe(true);
    expect(calls.every(([, , options]) => options.env["CI"] === undefined)).toBe(true);
    expect(calls.every(([, , options]) =>
      options.env["QMD_EMBED_MODEL"] === undefined)).toBe(true);
  });

  it("uses qmd's real expanded query pipeline for every B2 modality", () => {
    const run = fakeRunner(["[]", "[]", "[]"]);

    const rows = runQmdComparatorArm(queries, settings(true), config(run));

    expect(rows.map(({ type }) => type)).toEqual(["hyde", "lex", "vec"]);
    const queryCalls = vi.mocked(run).mock.calls.filter(([, args]) => args[0] === "query");
    expect(queryCalls).toHaveLength(3);
    expect(queryCalls.every(([, args]) => !args.includes("--no-rerank"))).toBe(true);
  });

  it("preserves comparator exit and malformed-JSON failures as rows", () => {
    const run = fakeRunner(["not-json"]);
    vi.mocked(run).mockImplementationOnce((_exe, args) =>
      args[0] === "--version"
        ? { exitCode: 0, stdout: `qmd ${PINNED_QMD_VERSION}\n`, stderr: "" }
        : { exitCode: 0, stdout: `${PINNED_QMD_COMMIT}\n`, stderr: "" });

    const rows = runQmdComparatorArm([queries[0]!], settings(false), config(run));

    expect(rows[0]).toMatchObject({ hits: [], error: expect.stringMatching(/JSON/) });
  });

  it("rejects semver without exact commit provenance before querying", () => {
    const run: CommandRunner = vi.fn((executable, args) =>
      executable === "git"
        ? { exitCode: 0, stdout: "wrong-commit\n", stderr: "" }
        : { exitCode: 0, stdout: `qmd ${PINNED_QMD_VERSION}\n`, stderr: "" });

    expect(() => assertPinnedComparator(config(run))).toThrow(/installed qmd commit/);
  });
});

describe("assertQmdEmbeddingIdentity", () => {
  it("binds the qmd config URI and resolved bytes to the frozen checksum", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-qmd-identity-"));
    tempRoots.push(root);
    const cache = path.join(root, "models");
    await mkdir(cache);
    const bytes = Buffer.from("exact shared model bytes");
    const uri = "hf:org/model/shared-model.gguf";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(root, "index.yml"), `models:\n  embed: ${uri}\n`);
    await writeFile(path.join(cache, "hf_org_model_shared-model.gguf"), bytes);

    const evidence = await assertQmdEmbeddingIdentity(
      { ...settings(false), qmdEmbedUri: uri, embedSha256: sha256 },
      { configPath: path.join(root, "index.yml"), modelCacheDir: cache },
    );

    expect(evidence).toEqual({
      uri,
      artifactName: "hf_org_model_shared-model.gguf",
      sha256,
    });
  });

  it("rejects a URI or byte mismatch before comparator queries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-qmd-identity-"));
    tempRoots.push(root);
    const cache = path.join(root, "models");
    await mkdir(cache);
    await writeFile(path.join(root, "index.yml"), "models:\n  embed: hf:org/wrong/model.gguf\n");
    await writeFile(path.join(cache, "hf_example_embeddinggemma.gguf"), "wrong bytes");

    await expect(assertQmdEmbeddingIdentity(
      settings(false),
      { configPath: path.join(root, "index.yml"), modelCacheDir: cache },
    )).rejects.toThrow(/qmd embed URI/);

    await writeFile(
      path.join(root, "index.yml"),
      `models:\n  embed: ${settings(false).qmdEmbedUri}\n`,
    );
    await expect(assertQmdEmbeddingIdentity(
      settings(false),
      { configPath: path.join(root, "index.yml"), modelCacheDir: cache },
    )).rejects.toThrow(/checksum/);
  });

  it("binds B2 rerank and generate URIs and bytes as well as embedding", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-qmd-model-set-"));
    tempRoots.push(root);
    const cache = path.join(root, "models");
    await mkdir(cache);
    const base = settings(true);
    const hashes: string[] = [];
    for (const uri of [
      base.qmdEmbedUri,
      base.qmdRerankUri!,
      base.qmdGenerateUri!,
    ]) {
      const basename = uri.split("/").at(-1)!;
      const bytes = Buffer.from(`${basename}-bytes`);
      const actual = createHash("sha256").update(bytes).digest("hex");
      await writeFile(path.join(cache, `hf_example_${basename}`), bytes);
      hashes.push(actual);
    }
    const precise: FrozenSettings = {
      ...base,
      embedSha256: hashes[0]!,
      rerankSha256: hashes[1]!,
      generateSha256: hashes[2]!,
    };
    await writeFile(
      path.join(root, "index.yml"),
      `models:\n  embed: ${precise.qmdEmbedUri}\n` +
        `  rerank: ${precise.qmdRerankUri}\n  generate: ${precise.qmdGenerateUri}\n`,
    );

    const evidence = await assertQmdModelSetIdentity(precise, {
      configPath: path.join(root, "index.yml"),
      modelCacheDir: cache,
    });

    expect(evidence).toMatchObject({
      embed: { uri: precise.qmdEmbedUri },
      rerank: { uri: precise.qmdRerankUri },
      generate: { uri: precise.qmdGenerateUri },
    });
  });
});

describe("prepareQmdComparator", () => {
  it("updates, embeds, and verifies the exact one-collection corpus", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-qmd-prepare-"));
    tempRoots.push(root);
    const configPath = path.join(root, "parity.yml");
    await writeFile(
      configPath,
      "collections:\n  vault:\n    path: /vault\n    pattern: \"**/*.md\"\n",
    );
    const run = fakeRunner([
      "updated",
      "embedded",
      "Documents\n  Total: 20,959 files indexed\n  Vectors: 110,000 embedded\n  Pending: 0 need embedding\n",
    ]);

    const evidence = await prepareQmdComparator(
      { ...config(run), configPath },
      20_959,
      { pathContexts: {} },
    );

    expect(evidence).toMatchObject({
      collection: "vault",
      documents: 20_959,
      vectors: 110_000,
      pending: 0,
      updateWallMs: 1,
      embedWallMs: 1,
    });
    expect(vi.mocked(run).mock.calls.map(([, args]) => args[0])).toEqual([
      "update",
      "embed",
      "status",
    ]);
  });

  it("rejects a qmd index whose active document count differs from the frozen corpus", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-qmd-prepare-"));
    tempRoots.push(root);
    const configPath = path.join(root, "parity.yml");
    await writeFile(
      configPath,
      "collections:\n  vault:\n    path: /vault\n    pattern: \"**/*.md\"\n",
    );
    const run = fakeRunner([
      "updated",
      "embedded",
      "Documents\n  Total: 21,067 files indexed\n  Vectors: 110,000 embedded\n  Pending: 0 need embedding\n",
    ]);

    await expect(prepareQmdComparator(
      { ...config(run), configPath },
      20_959,
      { pathContexts: {} },
    )).rejects.toThrow(/contains 21067 documents/);
  });

  it("requires qmd global and path context to equal the taxonomy projection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-qmd-prepare-"));
    tempRoots.push(root);
    const configPath = path.join(root, "parity.yml");
    await writeFile(
      configPath,
      "global_context: wrong\ncollections:\n  vault:\n    path: /vault\n" +
        "    pattern: \"**/*.md\"\n    context:\n      /notes: wrong\n",
    );

    await expect(prepareQmdComparator(
      { ...config(fakeRunner([])), configPath },
      20_959,
      {
        globalContext: "- notes: Owner-authored notes",
        pathContexts: { "/notes": "Owner-authored notes" },
      },
    )).rejects.toThrow(/global context/);
  });
});

describe("runOmsComparatorArm", () => {
  it("executes B1 as explicit typed channels without expansion or reranking", async () => {
    const semanticQuery = vi.fn().mockResolvedValue({
      available: true,
      hits: [{ path: "notes/calm.md", score: 0.9 }],
    });

    const rows = await runOmsComparatorArm(queries, settings(false), { semanticQuery }, () => 1);

    expect(rows.map(({ type }) => type)).toEqual(["lex", "vec"]);
    expect(semanticQuery).toHaveBeenCalledWith(expect.objectContaining({
      searches: [{ type: "lex", query: "평온" }],
      rerank: false,
      candidateLimit: 40,
      limit: 10,
    }));
    expect(semanticQuery.mock.calls.every(([options]) => options.strategy === undefined)).toBe(true);
  });

  it("executes B2 through the explicit expansion strategy and preserves failures", async () => {
    const semanticQuery = vi.fn()
      .mockResolvedValueOnce({ available: false, reason: "generate unavailable", hits: [] })
      .mockResolvedValue({ available: true, hits: [] });

    const rows = await runOmsComparatorArm(queries, settings(true), { semanticQuery }, () => 1);

    expect(rows.map(({ type }) => type)).toEqual(["hyde", "lex", "vec"]);
    expect(rows[0]?.error).toBe("generate unavailable");
    expect(semanticQuery).toHaveBeenCalledWith(expect.objectContaining({
      strategy: { kind: "expand", profile: "qmd-v2.8.3" },
      rerank: true,
    }));
    expect(semanticQuery.mock.calls.every(([options]) => options.searches === undefined)).toBe(true);
  });
});

function armRows(modality: ParityModality, prefix: string): ParityArmRow[] {
  return Array.from({ length: 6 }, (_, index) => ({
    id: `${modality}-${index}`,
    type: modality,
    queryClass: index === 0 ? "ko" : "en",
    query: `${modality} query ${index}`,
    hits: [{ path: `${prefix}/${modality}-${index}.md`, score: 1 }],
    latencyMs: index + 1,
  }));
}

function qrelsFor(rows: readonly ParityArmRow[], prefix = "relevant"): Qrels {
  return Object.fromEntries(rows.map((row) => [row.id, { [`${prefix}/${row.id}.md`]: 3 }]));
}

describe("paired relevance evidence", () => {
  it("computes matching OMS/qmd metrics per modality and aggregate", () => {
    const oms = [...armRows("lex", "relevant"), ...armRows("vec", "relevant")];
    const qmd = oms.map((row) => ({ ...row }));
    const qrels = qrelsFor(oms);
    const paired = pairParityRows(oms, qmd, ["lex", "vec"]);

    const relevance = buildPairedRelevance(paired, qrels, ["lex", "vec"]);

    expect(relevance.modalities.lex).toMatchObject({
      scoredRows: 6,
      curatedRows: 6,
      languageStrata: ["en-or-mixed", "ko"],
      oms: { recallAt10: 1, ndcgAt10: 1, mrrAt10: 1 },
      qmd: { recallAt10: 1, ndcgAt10: 1, mrrAt10: 1 },
    });
    expect(relevance.aggregate.oms).toEqual({ recallAt10: 1, ndcgAt10: 1, mrrAt10: 1 });
    expect(evaluateRelevanceGate(relevance).passed).toBe(true);
  });

  it("turns a missing qmd row into an unscored curated row and a hard gate failure", () => {
    const oms = armRows("lex", "relevant");
    const paired = pairParityRows(oms, oms.slice(0, 5), ["lex"]);
    const relevance = buildPairedRelevance(paired, qrelsFor(oms), ["lex"]);

    expect(relevance.modalities.lex).toMatchObject({ scoredRows: 5, curatedRows: 6 });
    expect(evaluateRelevanceGate(relevance).failures.join("\n")).toMatch(/scored 5 of 6/);
  });

  it("turns a missing qrel into an unscored declared row and a hard failure", () => {
    const oms = armRows("lex", "relevant");
    const qrels = qrelsFor(oms.slice(0, 5));
    const paired = pairParityRows(oms, oms, ["lex"]);

    const relevance = buildPairedRelevance(paired, qrels, ["lex"]);

    expect(relevance.modalities.lex).toMatchObject({ scoredRows: 5, curatedRows: 6 });
    expect(evaluateRelevanceGate(relevance).failures.join("\n")).toMatch(/scored 5 of 6/);
  });

  it("binds query, qrels, and query count to preregistration", () => {
    const oms = [...armRows("lex", "relevant"), ...armRows("vec", "relevant")];
    const qrels = qrelsFor(oms);
    const preregistration: ParityPreregistration = {
      schemaVersion: 1,
      profile: "b1-foundation",
      baselineRepo: PINNED_QMD_REPO,
      baselineCommit: PINNED_QMD_COMMIT,
      baselineVersion: PINNED_QMD_VERSION,
      corpusDigest: "a".repeat(64),
      corpusFileCount: 20_959,
      queriesSha256: parityQueriesSha256(oms),
      qrelsSha256: qrelsSha256(qrels),
      queryCount: oms.length,
      settings: settings(false),
      hardware: "M1 Pro",
      seed: 1,
    };

    expect(() => assertEvidenceBoundToPreregistration(
      preregistration,
      oms,
      qrels,
    )).not.toThrow();
  });

  it("seals observed raw evidence after the run and detects any mutation", () => {
    const core = {
      schema: "oms.paired-parity-raw.v1",
      rows: [{ id: "lex-1", latencyMs: 12, hits: ["notes/a.md"] }],
    };
    const record = {
      ...core,
      rawResultsDigest: parityRawEvidenceDigest(core),
    };

    expect(() => assertRawEvidenceSeal(record)).not.toThrow();
    expect(() => assertRawEvidenceSeal({
      ...record,
      rows: [{ id: "lex-1", latencyMs: 13, hits: ["notes/a.md"] }],
    })).toThrow(/seal mismatch/);
    expect(() => assertRawEvidenceSeal(record, "f".repeat(64)))
      .toThrow(/does not match audited outcome/);
  });

  it("converts actual harness rows without trusting precomputed aggregate metrics", () => {
    const report = [{
      id: "lex-1",
      type: "lex",
      queryClass: "ko",
      query: "평온",
      engineTop10: ["notes/calm.md"],
      latencyMs: 12,
    }] as QueryReport[];

    expect(omsRowsFromHarness(report)).toEqual([{
      id: "lex-1",
      type: "lex",
      queryClass: "ko",
      query: "평온",
      hits: [{ path: "notes/calm.md", score: 10 }],
      latencyMs: 12,
    }]);
  });
});

it.skipIf(process.env["OMS_QMD_ROOT"] === undefined)(
  "verifies the installed pinned comparator checkout",
  () => {
    assertPinnedComparator({
      root: process.env["OMS_QMD_ROOT"]!,
      index: "unused",
      vaultPath: "/unused",
    });
  },
);
