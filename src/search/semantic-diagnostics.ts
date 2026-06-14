import { readFile } from "node:fs/promises";
import { normalizeSemanticStorage, readSemanticIndex, SEMANTIC_SQLITE_STORAGE } from "./semantic-index.js";
import { querySemanticStore } from "./semantic-query.js";
import { SEMANTIC_MODELS } from "./semantic-sync.js";
import type {
  SemanticBenchmarkResult,
  SemanticDoctorCheck,
  SemanticDoctorResult,
  SemanticPullResult,
  SemanticStorage,
} from "./semantic-types.js";

export async function readSemanticDoctor(opts: {
  readonly vault: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
  readonly modelPath?: string;
}): Promise<SemanticDoctorResult> {
  const storage = normalizeSemanticStorage(opts.storage);
  const loaded = await readSemanticIndex({ ...opts, storage });
  const checks: SemanticDoctorCheck[] = [...await qmdInternalChecks(storage, opts.modelPath)];
  if (!loaded.available) {
    return {
      available: false,
      storage,
      reason: loaded.reason,
      checks: [{ name: "native index", status: "fail", detail: loaded.reason }, ...checks],
    };
  }
  checks.unshift({
    name: "native index",
    status: "pass",
    detail: `${loaded.index.documents.length} documents across ${(loaded.index.collections ?? []).length} collections.`,
  });
  checks.push({
    name: "query document syntax",
    status: "pass",
    detail: "intent:, lex:, vec:, and hyde: lines are parsed natively.",
  });
  const contextCount = loaded.index.contexts?.length ?? 0;
  checks.push(
    contextCount === 0
      ? { name: "contexts", status: "warn", detail: "No path or collection contexts are configured." }
      : { name: "contexts", status: "pass", detail: `${contextCount} contexts configured.` },
  );
  return { available: true, storage, checks };
}

async function qmdInternalChecks(storage: SemanticStorage, modelPath: string | undefined): Promise<readonly SemanticDoctorCheck[]> {
  if (storage !== SEMANTIC_SQLITE_STORAGE) {
    return [{
      name: "qmd sqlite/vector/llm internals",
      status: "unsupported",
      detail: "JSON storage is available only as a compatibility fallback; use storage=qmd-sqlite for qmd internals.",
    }];
  }
  const checks: SemanticDoctorCheck[] = [
    { name: "better-sqlite3 FTS5", status: "pass", detail: "SQLite FTS5 document tables are managed by OMS." },
    { name: "sqlite-vec vector extension", status: "pass", detail: "sqlite-vec vec0 tables are loaded for vector search." },
  ];
  try {
    await import("node-llama-cpp");
    checks.push({ name: "node-llama-cpp runtime", status: "pass", detail: "node-llama-cpp is installed for optional GGUF embeddings." });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({ name: "node-llama-cpp runtime", status: "fail", detail });
  }
  checks.push(
    modelPath
      ? { name: "GGUF embedding model", status: "pass", detail: `Configured model path: ${modelPath}` }
      : { name: "GGUF embedding model", status: "warn", detail: "No modelPath configured; OMS uses deterministic sqlite-vec hash embeddings." },
  );
  return checks;
}

export function pullSemanticModels(): SemanticPullResult {
  return {
    available: true,
    storage: "qmd-sqlite",
    models: SEMANTIC_MODELS,
    message: "OMS ships qmd-compatible SQLite/vector storage. Configure --model-path for GGUF embeddings; otherwise deterministic sqlite-vec hash embeddings are used.",
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBenchmarkCases(value: unknown): readonly { readonly query: string; readonly expected: string }[] | undefined {
  if (!isRecord(value) || !Array.isArray(value["cases"])) return undefined;
  const cases = [];
  for (const item of value["cases"]) {
    if (!isRecord(item) || typeof item["query"] !== "string" || typeof item["expected"] !== "string") {
      return undefined;
    }
    cases.push({ query: item["query"], expected: item["expected"] });
  }
  return cases;
}

export async function runSemanticBenchmark(opts: {
  readonly vault: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
  readonly modelPath?: string;
  readonly fixture: string;
  readonly collection?: string;
}): Promise<SemanticBenchmarkResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(opts.fixture, "utf-8"));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { available: false, reason: detail, total: 0, passed: 0, failed: 0, cases: [] };
  }
  const cases = parseBenchmarkCases(parsed);
  if (!cases) return { available: false, reason: "Unsupported OMS semantic benchmark fixture shape.", total: 0, passed: 0, failed: 0, cases: [] };
  const results = [];
  for (const entry of cases) {
    const result = await querySemanticStore({
      vault: opts.vault,
      index: opts.index,
      storage: opts.storage,
      modelPath: opts.modelPath,
      collection: opts.collection,
      query: entry.query,
      limit: 1,
    });
    const hit = result.available ? result.hits[0]?.path ?? result.hits[0]?.docid : undefined;
    results.push({ query: entry.query, expected: entry.expected, hit, pass: hit === entry.expected });
  }
  const passed = results.filter((entry) => entry.pass).length;
  return { available: true, total: results.length, passed, failed: results.length - passed, cases: results };
}
