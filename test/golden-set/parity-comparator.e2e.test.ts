import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  buildPairedRelevance,
  pairParityRows,
  runQmdComparatorArm,
  type ParityArmRow,
} from "./parity-comparator.js";
import type { FrozenSettings } from "./parity-preregistration.js";
import { syncEngineStore } from "../../src/kernel/engine/embed/sync.js";
import { assembleCoreSemanticEngineReadOnly } from "../../src/kernel/engine/assemble.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.skipIf(process.env["OMS_QMD_ROOT"] === undefined)(
  "runs a real lexical arm through the exact pinned qmd checkout",
  async () => {
    const qmdRoot = process.env["OMS_QMD_ROOT"]!;
    const root = await mkdtemp(path.join(tmpdir(), "oms-pinned-qmd-e2e-"));
    roots.push(root);
    const vault = path.join(root, "vault");
    const configDir = path.join(root, "config");
    const cacheDir = path.join(root, "cache");
    await mkdir(path.join(vault, "notes"), { recursive: true });
    await mkdir(configDir);
    await mkdir(cacheDir);
    await writeFile(
      path.join(vault, "notes", "ataraxia.md"),
      "# Ataraxia\n\nFreedom from mental disturbance.\n",
    );
    const executable = path.join(qmdRoot, "bin", "qmd");
    const env = {
      ...process.env,
      CI: undefined,
      QMD_CONFIG_DIR: configDir,
      XDG_CACHE_HOME: cacheDir,
    };
    execFileSync(executable, [
      "--index", "parity", "collection", "add", vault, "--name", "vault",
    ], { env, stdio: "ignore" });
    execFileSync(executable, ["--index", "parity", "update"], {
      env,
      stdio: "ignore",
    });
    const settings: FrozenSettings = {
      candidateLimit: 40,
      k: 10,
      rrfK: 60,
      rerank: false,
      expansion: false,
      embedModel: "not-used-by-lex",
      embedRevision: "pinned",
      embedSha256: "e".repeat(64),
      embedPromptScheme: "embeddinggemma-v1",
      qmdEmbedUri: "hf:example/not-used.gguf",
    };

    const rows = runQmdComparatorArm([{
      id: "lex-ataraxia",
      type: "lex",
      queryClass: "en",
      query: "mental disturbance",
    }], settings, {
      root: qmdRoot,
      index: "parity",
      collection: "vault",
      vaultPath: vault,
      env: {
        QMD_CONFIG_DIR: configDir,
        XDG_CACHE_HOME: cacheDir,
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.error).toBeUndefined();
    expect(rows[0]?.hits[0]?.path).toBe("notes/ataraxia.md");

    // Bind the real qmd result to a real OMS lexical result over the same files.
    await syncEngineStore({ vault, embed: false });
    const engine = assembleCoreSemanticEngineReadOnly({ vault });
    if (engine === null) throw new Error("expected the synced read-only OMS engine");
    try {
      const result = await engine.adapter.semanticQuery({
        query: "mental disturbance",
        limit: 10,
      });
      if (!result.available) throw new Error(result.reason);
      const oms: ParityArmRow[] = [{
        id: "lex-ataraxia",
        type: "lex",
        queryClass: "en",
        query: "mental disturbance",
        hits: result.hits.map((hit) => ({ path: hit.path, score: hit.score })),
        latencyMs: 1,
      }];
      const paired = pairParityRows(oms, rows, ["lex"]);
      const relevance = buildPairedRelevance(
        paired,
        { "lex-ataraxia": { "notes/ataraxia.md": 3 } },
        ["lex"],
      );

      expect(relevance.aggregate).toMatchObject({
        scoredRows: 1,
        curatedRows: 1,
        oms: { recallAt10: 1, ndcgAt10: 1, mrrAt10: 1 },
        qmd: { recallAt10: 1, ndcgAt10: 1, mrrAt10: 1 },
      });
    } finally {
      await engine.dispose();
    }
  },
  30_000,
);
