import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  mrrAtK,
  ndcgAtK,
  qrelsSha256,
  type Qrels,
  type QueryReport,
} from "./harness.js";
import type {
  ParityMetric,
  ParityModality,
  ParityRelevanceInput,
  ParityScopeMeasurement,
} from "./parity-gate.js";
import {
  checkInstalledBaseline,
  PINNED_QMD_COMMIT,
  type FrozenSettings,
  type ParityPreregistration,
} from "./parity-preregistration.js";
import type { McpEngineAdapter } from "../../src/kernel/engine/mcp/facade.js";

export interface ParityRankedHit {
  readonly path: string;
  readonly score: number;
}

export interface ParityArmRow {
  readonly id: string;
  readonly type: ParityModality;
  readonly queryClass: string;
  readonly query: string;
  readonly hits: readonly ParityRankedHit[];
  readonly latencyMs: number;
  readonly error?: string;
}

export interface PairedParityRow {
  readonly id: string;
  readonly type: ParityModality;
  readonly queryClass: string;
  readonly query: string;
  readonly oms: Omit<ParityArmRow, "id" | "type" | "queryClass" | "query">;
  readonly qmd: Omit<ParityArmRow, "id" | "type" | "queryClass" | "query">;
}

export interface CommandExecution {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs: number;
  },
) => CommandExecution;

export interface QmdComparatorConfig {
  readonly root: string;
  readonly index: string;
  readonly collection?: string;
  readonly vaultPath: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run?: CommandRunner;
  readonly now?: () => number;
}

export interface QmdEmbeddingIdentityConfig {
  readonly configPath: string;
  readonly modelCacheDir: string;
}

export interface QmdEmbeddingIdentityEvidence {
  readonly uri: string;
  readonly artifactName: string;
  readonly sha256: string;
}

export interface QmdModelSetIdentityEvidence {
  readonly embed: QmdEmbeddingIdentityEvidence;
  readonly rerank?: QmdEmbeddingIdentityEvidence;
  readonly generate?: QmdEmbeddingIdentityEvidence;
}

export interface QmdPreparationEvidence {
  readonly collection: string;
  readonly documents: number;
  readonly vectors: number;
  readonly pending: number;
  readonly updateWallMs: number;
  readonly embedWallMs: number;
  readonly updateOutputSha256: string;
  readonly embedOutputSha256: string;
}

export interface QmdExpectedContext {
  readonly globalContext?: string;
  readonly pathContexts: Readonly<Record<string, string>>;
}

async function sha256File(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Prove qmd resolves the same embedding bytes preregistered for OMS.
 *
 * Model names alone are insufficient: two files may share a display name while
 * differing by quantization or revision. The config URI and resolved cache
 * artifact checksum are both exact.
 */
export async function assertQmdEmbeddingIdentity(
  settings: FrozenSettings,
  config: QmdEmbeddingIdentityConfig,
): Promise<QmdEmbeddingIdentityEvidence> {
  const parsed: unknown = parseYaml(await readFile(config.configPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("qmd comparator config must be an object");
  }
  const models = (parsed as Record<string, unknown>)["models"];
  if (typeof models !== "object" || models === null || Array.isArray(models)) {
    throw new Error("qmd comparator config has no models mapping");
  }
  const uri = (models as Record<string, unknown>)["embed"];
  if (uri !== settings.qmdEmbedUri) {
    throw new Error(
      `qmd embed URI ${String(uri)} does not match preregistered ${settings.qmdEmbedUri}`,
    );
  }
  const artifactBasename = settings.qmdEmbedUri.split("/").at(-1);
  if (artifactBasename === undefined || artifactBasename.trim() === "") {
    throw new Error("preregistered qmd embed URI has no artifact filename");
  }
  const candidates = (await readdir(config.modelCacheDir))
    .filter((name) => name.endsWith(artifactBasename))
    .sort();
  if (candidates.length !== 1) {
    throw new Error(
      `qmd model cache must contain exactly one artifact ending ${artifactBasename}; ` +
        `found ${candidates.length}`,
    );
  }
  const artifactName = candidates[0]!;
  const sha256 = await sha256File(path.join(config.modelCacheDir, artifactName));
  if (sha256 !== settings.embedSha256.replace(/^sha256:/iu, "").toLowerCase()) {
    throw new Error(
      `qmd embedding artifact checksum ${sha256} does not match preregistered ` +
        `${settings.embedSha256}`,
    );
  }
  return { uri: settings.qmdEmbedUri, artifactName, sha256 };
}

async function assertQmdAdditionalIdentity(
  capability: "rerank" | "generate",
  expectedUri: string,
  expectedSha256: string,
  config: QmdEmbeddingIdentityConfig,
): Promise<QmdEmbeddingIdentityEvidence> {
  const parsed: unknown = parseYaml(await readFile(config.configPath, "utf8"));
  const models = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)["models"]
    : undefined;
  const uri = typeof models === "object" && models !== null && !Array.isArray(models)
    ? (models as Record<string, unknown>)[capability]
    : undefined;
  if (uri !== expectedUri) {
    throw new Error(
      `qmd ${capability} URI ${String(uri)} does not match preregistered ${expectedUri}`,
    );
  }
  const artifactBasename = expectedUri.split("/").at(-1);
  if (artifactBasename === undefined || artifactBasename.trim() === "") {
    throw new Error(`preregistered qmd ${capability} URI has no artifact filename`);
  }
  const candidates = (await readdir(config.modelCacheDir))
    .filter((name) => name.endsWith(artifactBasename))
    .sort();
  if (candidates.length !== 1) {
    throw new Error(
      `qmd model cache must contain exactly one ${capability} artifact ending ` +
        `${artifactBasename}; found ${candidates.length}`,
    );
  }
  const artifactName = candidates[0]!;
  const sha256 = await sha256File(path.join(config.modelCacheDir, artifactName));
  if (sha256 !== expectedSha256.replace(/^sha256:/iu, "").toLowerCase()) {
    throw new Error(
      `qmd ${capability} artifact checksum ${sha256} does not match preregistered ` +
        `${expectedSha256}`,
    );
  }
  return { uri: expectedUri, artifactName, sha256 };
}

export async function assertQmdModelSetIdentity(
  settings: FrozenSettings,
  config: QmdEmbeddingIdentityConfig,
): Promise<QmdModelSetIdentityEvidence> {
  const embed = await assertQmdEmbeddingIdentity(settings, config);
  const rerank = settings.rerank
    ? await assertQmdAdditionalIdentity(
      "rerank",
      settings.qmdRerankUri!,
      settings.rerankSha256!,
      config,
    )
    : undefined;
  const generate = settings.expansion
    ? await assertQmdAdditionalIdentity(
      "generate",
      settings.qmdGenerateUri!,
      settings.generateSha256!,
      config,
    )
    : undefined;
  return {
    embed,
    ...(rerank === undefined ? {} : { rerank }),
    ...(generate === undefined ? {} : { generate }),
  };
}

function outputSha256(result: CommandExecution): string {
  return createHash("sha256")
    .update(result.stdout)
    .update("\0")
    .update(result.stderr)
    .digest("hex");
}

function statusCount(output: string, label: string): number {
  const match = new RegExp(`${label}:\\s+([\\d,]+)`, "iu").exec(output);
  if (match === null) throw new Error(`qmd status did not report ${label}`);
  return Number(match[1]!.replaceAll(",", ""));
}

function optionalStatusCount(output: string, label: string): number | undefined {
  const match = new RegExp(`${label}:\\s+([\\d,]+)`, "iu").exec(output);
  return match === null ? undefined : Number(match[1]!.replaceAll(",", ""));
}

/**
 * Update and embed the exact configured collection before the comparator arm.
 * This refuses stale/wrong-path indexes instead of scoring whichever qmd DB the
 * operator happened to have on disk.
 */
export async function prepareQmdComparator(
  config: QmdComparatorConfig & { readonly configPath: string },
  expectedCorpusFileCount: number,
  expectedContext: QmdExpectedContext,
): Promise<QmdPreparationEvidence> {
  if (config.collection === undefined) {
    throw new Error("qmd comparator preparation requires one explicit collection");
  }
  if (path.basename(config.configPath) !== `${config.index}.yml`) {
    throw new Error(
      `qmd comparator config filename must be ${config.index}.yml for the selected index`,
    );
  }
  const parsed: unknown = parseYaml(await readFile(config.configPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("qmd comparator config must be an object");
  }
  const collections = (parsed as Record<string, unknown>)["collections"];
  if (typeof collections !== "object" || collections === null || Array.isArray(collections)) {
    throw new Error("qmd comparator config has no collections mapping");
  }
  const entries = Object.entries(collections as Record<string, unknown>);
  if (entries.length !== 1 || entries[0]![0] !== config.collection) {
    throw new Error(
      `qmd comparator index must contain exactly collection ${config.collection}`,
    );
  }
  const declared = entries[0]![1];
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
    throw new Error(`qmd collection ${config.collection} must be an object`);
  }
  const collection = declared as Record<string, unknown>;
  if (
    typeof collection["path"] !== "string"
    || path.resolve(collection["path"]) !== path.resolve(config.vaultPath)
  ) {
    throw new Error(
      `qmd collection ${config.collection} does not target the frozen vault`,
    );
  }
  if (collection["pattern"] !== "**/*.md") {
    throw new Error(
      `qmd collection ${config.collection} must use the frozen **/*.md pattern`,
    );
  }
  if (Array.isArray(collection["ignore"]) && collection["ignore"].length > 0) {
    throw new Error(`qmd collection ${config.collection} must not exclude frozen corpus files`);
  }
  if (collection["update"] !== undefined) {
    throw new Error(`qmd collection ${config.collection} must not run an update command`);
  }
  const globalContext = (parsed as Record<string, unknown>)["global_context"];
  if (globalContext !== expectedContext.globalContext) {
    throw new Error("qmd global context does not match the taxonomy intent projection");
  }
  const actualPathContexts = collection["context"] === undefined
    ? {}
    : collection["context"];
  if (
    typeof actualPathContexts !== "object"
    || actualPathContexts === null
    || Array.isArray(actualPathContexts)
  ) {
    throw new Error(`qmd collection ${config.collection} context must be a mapping`);
  }
  const canonicalContexts = (value: Readonly<Record<string, unknown>>): string =>
    JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0)));
  if (
    canonicalContexts(actualPathContexts as Readonly<Record<string, unknown>>)
    !== canonicalContexts(expectedContext.pathContexts)
  ) {
    throw new Error("qmd path contexts do not match the taxonomy folder intents");
  }

  const run = config.run ?? defaultRun;
  const env = commandEnv(config.env);
  const now = config.now ?? (() => performance.now());
  const invoke = (args: readonly string[]): { result: CommandExecution; wallMs: number } => {
    const started = now();
    const result = run(executable(config), args, {
      cwd: config.root,
      env,
      timeoutMs: config.timeoutMs ?? 6 * 60 * 60_000,
    });
    return { result, wallMs: now() - started };
  };
  const update = invoke(["update", "--index", config.index]);
  if (update.result.exitCode !== 0) {
    throw new Error(`qmd update failed: ${update.result.stderr.trim()}`);
  }
  const embed = invoke([
    "embed",
    "--index",
    config.index,
    "-c",
    config.collection,
    "--timeout",
    "360",
  ]);
  if (embed.result.exitCode !== 0) {
    throw new Error(`qmd embed failed: ${embed.result.stderr.trim()}`);
  }
  const status = invoke(["status", "--index", config.index]);
  if (status.result.exitCode !== 0) {
    throw new Error(`qmd status failed: ${status.result.stderr.trim()}`);
  }
  const documents = statusCount(status.result.stdout, "Total");
  const vectors = statusCount(status.result.stdout, "Vectors");
  // qmd omits the Pending line entirely once every document is embedded.
  const pending = optionalStatusCount(status.result.stdout, "Pending") ?? 0;
  if (documents !== expectedCorpusFileCount) {
    throw new Error(
      `qmd index contains ${documents} documents; frozen corpus requires ` +
        `${expectedCorpusFileCount}`,
    );
  }
  if (pending !== 0) {
    throw new Error(`qmd index still has ${pending} documents pending embedding`);
  }
  if (documents > 0 && vectors <= 0) {
    throw new Error("qmd index reports no vectors for a non-empty frozen corpus");
  }
  return {
    collection: config.collection,
    documents,
    vectors,
    pending,
    updateWallMs: update.wallMs,
    embedWallMs: embed.wallMs,
    updateOutputSha256: outputSha256(update.result),
    embedOutputSha256: outputSha256(embed.result),
  };
}

function defaultRun(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs: number;
  },
): CommandExecution {
  const result = spawnSync(executable, [...args], {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    exitCode: result.status ?? (result.error === undefined ? 1 : 127),
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${result.error === undefined ? "" : `\n${result.error.message}`}`,
  };
}

function commandEnv(overrides: QmdComparatorConfig["env"]): Readonly<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...process.env, ...overrides };
  // qmd intentionally disables generation/reranking whenever CI is present.
  // A real comparator arm must execute those capabilities, not score a CI refusal.
  delete env["CI"];
  // Model identity is frozen in the verified index config. Ambient model
  // overrides would make qmd execute different bytes after that verification.
  delete env["QMD_EMBED_MODEL"];
  delete env["QMD_RERANK_MODEL"];
  delete env["QMD_GENERATE_MODEL"];
  if (overrides?.["INDEX_PATH"] === undefined) delete env["INDEX_PATH"];
  return env;
}

function executable(config: QmdComparatorConfig): string {
  return path.join(config.root, "bin", "qmd");
}

/** Verify the comparator executable and checkout before any query is scored. */
export function assertPinnedComparator(config: QmdComparatorConfig): void {
  const run = config.run ?? defaultRun;
  const env = commandEnv(config.env);
  const version = run(executable(config), ["--version"], {
    cwd: config.root,
    env,
    timeoutMs: config.timeoutMs ?? 60_000,
  });
  const commit = run("git", ["-C", config.root, "rev-parse", "HEAD"], {
    cwd: config.root,
    env,
    timeoutMs: config.timeoutMs ?? 60_000,
  });
  if (version.exitCode !== 0) {
    throw new Error(`qmd comparator version probe failed: ${version.stderr.trim()}`);
  }
  if (commit.exitCode !== 0) {
    throw new Error(`qmd comparator commit probe failed: ${commit.stderr.trim()}`);
  }
  const verdict = checkInstalledBaseline(version.stdout, commit.stdout);
  if (!verdict.ok) throw new Error(verdict.reason ?? "qmd comparator does not match the pinned baseline");
}

function qmdArguments(
  row: Pick<ParityArmRow, "type" | "query">,
  settings: FrozenSettings,
  config: QmdComparatorConfig,
): string[] {
  const expansion = settings.expansion;
  const command = expansion ? "query" : row.type === "lex" ? "search" : row.type === "vec" ? "vsearch" : "query";
  const query = expansion ? row.query : row.type === "hyde" ? `hyde: ${row.query}` : row.query;
  return [
    command,
    query,
    "--index",
    config.index,
    "--format",
    "json",
    "-n",
    String(settings.k),
    "-C",
    String(settings.candidateLimit),
    ...(settings.rerank ? [] : ["--no-rerank"]),
    ...(config.collection === undefined ? [] : ["-c", config.collection]),
  ];
}

function qmdPath(value: string, config: QmdComparatorConfig): string {
  if (value.startsWith("qmd://")) {
    const withoutQuery = value.slice("qmd://".length).split("?", 1)[0]!;
    const slash = withoutQuery.indexOf("/");
    return decodeURIComponent(slash < 0 ? withoutQuery : withoutQuery.slice(slash + 1));
  }
  if (path.isAbsolute(value) && (value === config.vaultPath || value.startsWith(`${config.vaultPath}${path.sep}`))) {
    return path.relative(config.vaultPath, value).replace(/\\/gu, "/");
  }
  return value.replace(/^\.\//u, "").replace(/\\/gu, "/");
}

function parseQmdHits(raw: string, config: QmdComparatorConfig): ParityRankedHit[] {
  const parsed: unknown = JSON.parse(raw);
  const values = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>)["results"])
      ? (parsed as Record<string, unknown>)["results"] as unknown[]
      : undefined;
  if (values === undefined) throw new Error("qmd JSON output must be an array or contain a results array");
  return values.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`qmd result ${index + 1} must be an object`);
    }
    const record = value as Record<string, unknown>;
    const file = record["file"] ?? record["path"] ?? record["filepath"];
    if (typeof file !== "string" || file.trim() === "") {
      throw new Error(`qmd result ${index + 1} has no file path`);
    }
    const score = record["score"];
    return {
      path: qmdPath(file, config),
      score: typeof score === "number" && Number.isFinite(score) ? score : values.length - index,
    };
  });
}

/** Run the exact pinned qmd arm and preserve every per-query failure as raw evidence. */
export function runQmdComparatorArm(
  queries: readonly Pick<QueryReport, "id" | "type" | "queryClass" | "query">[],
  settings: FrozenSettings,
  config: QmdComparatorConfig,
): readonly ParityArmRow[] {
  assertPinnedComparator(config);
  const expected = settings.expansion ? ["lex", "vec", "hyde"] : ["lex", "vec"];
  const selected = queries
    .filter((query): query is typeof query & { readonly type: ParityModality } =>
      expected.includes(query.type))
    .sort((left, right) => left.id.localeCompare(right.id));
  const run = config.run ?? defaultRun;
  const env = commandEnv(config.env);
  const now = config.now ?? (() => performance.now());
  return selected.map((query): ParityArmRow => {
    const started = now();
    const result = run(executable(config), qmdArguments(query, settings, config), {
      cwd: config.root,
      env,
      timeoutMs: config.timeoutMs ?? 10 * 60_000,
    });
    const latencyMs = now() - started;
    if (result.exitCode !== 0) {
      return {
        id: query.id,
        type: query.type,
        queryClass: query.queryClass,
        query: query.query,
        hits: [],
        latencyMs,
        error: `qmd exited ${result.exitCode}: ${result.stderr.trim()}`,
      };
    }
    try {
      return {
        id: query.id,
        type: query.type,
        queryClass: query.queryClass,
        query: query.query,
        hits: parseQmdHits(result.stdout, config),
        latencyMs,
      };
    } catch (error: unknown) {
      return {
        id: query.id,
        type: query.type,
        queryClass: query.queryClass,
        query: query.query,
        hits: [],
        latencyMs,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export function omsRowsFromHarness(report: readonly QueryReport[]): readonly ParityArmRow[] {
  return report
    .filter((row): row is QueryReport & { readonly type: ParityModality } =>
      row.type === "lex" || row.type === "vec" || row.type === "hyde")
    .map((row) => ({
      id: row.id,
      type: row.type,
      queryClass: row.queryClass,
      query: row.query,
      hits: row.engineTop10.map((hitPath, index) => ({ path: hitPath, score: 10 - index })),
      latencyMs: row.latencyMs,
      ...(row.error === undefined ? {} : { error: row.error }),
    }));
}

/** Execute the OMS half through the public adapter with the frozen profile settings. */
export async function runOmsComparatorArm(
  queries: readonly Pick<QueryReport, "id" | "type" | "queryClass" | "query">[],
  settings: FrozenSettings,
  adapter: Pick<McpEngineAdapter, "semanticQuery">,
  now: () => number = () => performance.now(),
): Promise<readonly ParityArmRow[]> {
  const expected = settings.expansion ? ["lex", "vec", "hyde"] : ["lex", "vec"];
  const selected = queries
    .filter((query): query is typeof query & { readonly type: ParityModality } =>
      expected.includes(query.type))
    .sort((left, right) => left.id.localeCompare(right.id));
  const rows: ParityArmRow[] = [];
  for (const query of selected) {
    const started = now();
    const result = await adapter.semanticQuery(settings.expansion
      ? {
        query: query.query,
        strategy: { kind: "expand", profile: "qmd-v2.8.3" },
        rerank: settings.rerank,
        candidateLimit: settings.candidateLimit,
        limit: settings.k,
      }
      : {
        searches: [{ type: query.type, query: query.query }],
        rerank: settings.rerank,
        candidateLimit: settings.candidateLimit,
        limit: settings.k,
      });
    const latencyMs = now() - started;
    rows.push(result.available
      ? {
        id: query.id,
        type: query.type,
        queryClass: query.queryClass,
        query: query.query,
        hits: result.hits.map((hit) => ({ path: hit.path, score: hit.score })),
        latencyMs,
      }
      : {
        id: query.id,
        type: query.type,
        queryClass: query.queryClass,
        query: query.query,
        hits: [],
        latencyMs,
        error: result.reason,
      });
  }
  return rows;
}

type ParityQueryIdentity = Pick<
  ParityArmRow,
  "id" | "type" | "queryClass" | "query"
>;

function queryDigestRows(rows: readonly ParityQueryIdentity[]): unknown[] {
  return [...rows]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(({ id, type, queryClass, query }) => ({ id, type, queryClass, query }));
}

export function parityQueriesSha256(rows: readonly ParityQueryIdentity[]): string {
  return createHash("sha256").update(JSON.stringify(queryDigestRows(rows))).digest("hex");
}

export function pairParityRows(
  omsRows: readonly ParityArmRow[],
  qmdRows: readonly ParityArmRow[],
  expectedModalities: readonly ParityModality[],
): readonly PairedParityRow[] {
  const qmd = new Map(qmdRows.map((row) => [row.id, row]));
  const selected = omsRows
    .filter((row) => expectedModalities.includes(row.type))
    .sort((left, right) => left.id.localeCompare(right.id));
  return selected.map((oms): PairedParityRow => {
    const comparator = qmd.get(oms.id);
    if (comparator === undefined) {
      return {
        id: oms.id,
        type: oms.type,
        queryClass: oms.queryClass,
        query: oms.query,
        oms: { hits: oms.hits, latencyMs: oms.latencyMs, ...(oms.error === undefined ? {} : { error: oms.error }) },
        qmd: { hits: [], latencyMs: 0, error: "matching qmd row is absent" },
      };
    }
    if (comparator.type !== oms.type || comparator.query !== oms.query) {
      throw new Error(`qmd row ${oms.id} does not match the OMS query identity`);
    }
    return {
      id: oms.id,
      type: oms.type,
      queryClass: oms.queryClass,
      query: oms.query,
      oms: { hits: oms.hits, latencyMs: oms.latencyMs, ...(oms.error === undefined ? {} : { error: oms.error }) },
      qmd: {
        hits: comparator.hits,
        latencyMs: comparator.latencyMs,
        ...(comparator.error === undefined ? {} : { error: comparator.error }),
      },
    };
  });
}

function languageStrata(rows: readonly PairedParityRow[]): readonly ("ko" | "en-or-mixed")[] {
  const strata = new Set<"ko" | "en-or-mixed">();
  for (const row of rows) {
    strata.add(row.queryClass.startsWith("ko") ? "ko" : "en-or-mixed");
  }
  return [...strata].sort();
}

function metric(
  hits: readonly ParityRankedHit[],
  qrel: Readonly<Record<string, number>>,
): Readonly<Record<ParityMetric, number>> {
  const relevant = Object.entries(qrel).filter(([, grade]) => grade > 0).map(([docPath]) => docPath);
  const ranked = hits.map(({ path: docPath, score }) => ({ docPath, score }));
  const found = new Set(hits.slice(0, 10).map(({ path: hitPath }) => hitPath.toLowerCase()));
  return {
    recallAt10: relevant.length === 0
      ? 0
      : relevant.filter((docPath) => found.has(docPath.toLowerCase())).length / relevant.length,
    ndcgAt10: ndcgAtK(ranked, qrel, 10),
    mrrAt10: mrrAtK(ranked, qrel, 10),
  };
}

function meanMetrics(values: readonly Readonly<Record<ParityMetric, number>>[]): Readonly<Record<ParityMetric, number>> {
  if (values.length === 0) return { recallAt10: 0, ndcgAt10: 0, mrrAt10: 0 };
  return {
    recallAt10: values.reduce((sum, value) => sum + value.recallAt10, 0) / values.length,
    ndcgAt10: values.reduce((sum, value) => sum + value.ndcgAt10, 0) / values.length,
    mrrAt10: values.reduce((sum, value) => sum + value.mrrAt10, 0) / values.length,
  };
}

function scope(rows: readonly PairedParityRow[], qrels: Qrels): ParityScopeMeasurement {
  // Every row declared by a parity profile must be curated. Unlike the general
  // golden harness there is no unscored exploratory row class here: omitting a
  // qrel must reduce scoredRows and fail the exact scored/curated gate.
  const curated = rows;
  const scored = curated.filter((row) =>
    qrels[row.id] !== undefined
    && row.oms.error === undefined
    && row.qmd.error === undefined);
  return {
    scoredRows: scored.length,
    curatedRows: curated.length,
    languageStrata: languageStrata(curated),
    oms: meanMetrics(scored.map((row) => metric(row.oms.hits, qrels[row.id]!))),
    qmd: meanMetrics(scored.map((row) => metric(row.qmd.hits, qrels[row.id]!))),
  };
}

export function buildPairedRelevance(
  rows: readonly PairedParityRow[],
  qrels: Qrels,
  expectedModalities: readonly ParityModality[],
): ParityRelevanceInput {
  return {
    expectedModalities,
    modalities: Object.fromEntries(expectedModalities.map((modality) => [
      modality,
      scope(rows.filter((row) => row.type === modality), qrels),
    ])),
    aggregate: scope(rows, qrels),
  };
}

export function pairedRawResultsDigest(rows: readonly PairedParityRow[]): string {
  return parityRawEvidenceDigest(
    [...rows].sort((left, right) => left.id.localeCompare(right.id)),
  );
}

function canonicalEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEvidence);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalEvidence(entry)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("raw parity evidence numbers must be finite");
  }
  return value;
}

/** Post-run immutable seal; unlike preregistration it contains observed results. */
export function parityRawEvidenceDigest(evidence: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalEvidence(evidence)))
    .digest("hex");
}

export function assertRawEvidenceSeal(
  record: Readonly<Record<string, unknown>>,
  expectedDigest?: string,
): void {
  const claimed = record["rawResultsDigest"];
  if (typeof claimed !== "string" || !/^[a-f0-9]{64}$/u.test(claimed)) {
    throw new Error("raw parity evidence has no valid rawResultsDigest seal");
  }
  const core = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "rawResultsDigest"),
  );
  const actual = parityRawEvidenceDigest(core);
  if (actual !== claimed) {
    throw new Error(`raw parity evidence seal mismatch: expected ${claimed}, got ${actual}`);
  }
  if (
    expectedDigest !== undefined
    && claimed !== expectedDigest.replace(/^sha256:/iu, "").toLowerCase()
  ) {
    throw new Error(
      `raw parity evidence seal ${claimed} does not match audited outcome ${expectedDigest}`,
    );
  }
}

export function assertEvidenceBoundToPreregistration(
  preregistration: ParityPreregistration,
  omsRows: readonly ParityArmRow[],
  qrels: Qrels,
): void {
  const failures: string[] = [];
  const queries = parityQueriesSha256(omsRows);
  const labels = qrelsSha256(qrels);
  if (queries !== preregistration.queriesSha256) failures.push(`queries digest ${queries} != ${preregistration.queriesSha256}`);
  if (labels !== preregistration.qrelsSha256) failures.push(`qrels digest ${labels} != ${preregistration.qrelsSha256}`);
  if (omsRows.length !== preregistration.queryCount) failures.push(`query count ${omsRows.length} != ${preregistration.queryCount}`);
  if (preregistration.baselineCommit !== PINNED_QMD_COMMIT) failures.push("preregistration baseline commit is not pinned");
  if (failures.length > 0) throw new Error(`paired parity evidence does not match preregistration:\n${failures.join("\n")}`);
}
