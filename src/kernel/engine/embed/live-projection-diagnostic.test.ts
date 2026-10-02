import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { AxisObservationStore } from "../axes/store.js";
import { readSearchTemplateSource } from "../retrieval/template-source.js";
import { LiveLexicalSession, type LexicalSnapshotSelector } from "./live-lexical.js";
import { scanIndexSources } from "./freshness.js";
import type { EngineStore } from "./store.js";

// Deterministic correctness/read-count probe, with optional stage diagnostics.
// This does not time preview hydration, reranking, or the facade's final check.
const stages = vi.hoisted(() => ({ scanMs: 0, parseMs: 0, projectMs: 0, bodyReads: [] as string[] }));
vi.mock("./freshness.js", async importOriginal => {
  const original = await importOriginal<typeof import("./freshness.js")>();
  return { ...original, scanIndexSources: async (...args: Parameters<typeof original.scanIndexSources>) => {
    const start = performance.now();
    try { return await original.scanIndexSources(...args); }
    finally { stages.scanMs += performance.now() - start; }
  } };
});
vi.mock("../graph/builder.js", async importOriginal => {
  const original = await importOriginal<typeof import("../graph/builder.js")>();
  return {
    ...original,
    parseNodeProjectionDocument: (...args: Parameters<typeof original.parseNodeProjectionDocument>) => {
      const start = performance.now();
      try { return original.parseNodeProjectionDocument(...args); }
      finally { stages.parseMs += performance.now() - start; }
    },
    projectNodeIndex: (...args: Parameters<typeof original.projectNodeIndex>) => {
      const start = performance.now();
      try { return original.projectNodeIndex(...args); }
      finally { stages.projectMs += performance.now() - start; }
    },
  };
});
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const record = (filename: unknown) => { if (typeof filename === "string" && filename.endsWith(".md")) stages.bodyReads.push(filename); };
  return {
    ...original,
    readFile: (...args: Parameters<typeof original.readFile>) => { record(args[0]); return original.readFile(...args); },
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      const read = handle.readFile.bind(handle);
      handle.readFile = ((...readArgs: Parameters<typeof handle.readFile>) => { record(args[0]); return read(...readArgs); }) as typeof handle.readFile;
      return handle;
    },
  };
});
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
    if (typeof args[0] === "string" && args[0].endsWith(".md")) stages.bodyReads.push(args[0]);
    return original.readFileSync(...args);
  } };
});

it("measures dense warm/one-edit stages without rereading overflow bodies", async () => {
  const suppliedVault = process.env.OMS_LIVE_PROJECTION_DIAGNOSTIC_VAULT;
  let count = Number(process.env.OMS_LIVE_PROJECTION_DIAGNOSTIC_COUNT ?? 256);
  if (!Number.isSafeInteger(count) || count < 20 || count > 20_000) throw new Error("Diagnostic count must be between 20 and 20000.");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "oms-projection-diagnostic-")));
  const vault = suppliedVault === undefined ? path.join(root, "vault") : await realpath(suppliedVault);
  if (suppliedVault === undefined) await mkdir(vault);
  else count = (await scanIndexSources(vault)).files.size;
  const raw = (index: number) => `---\nsubject: ${index % 20 === 0 ? "[science, research]" : "general"}\nscore: ${index}\nenabled: ${index % 2 === 0}\ncreated: 2026-01-${String(index % 28 + 1).padStart(2, "0")}\ntags: [synthetic, group-${index % 100}, category-${index % 12}]\nunique: value-${index}\n${Array.from({ length: 16 }, (_, key) => `wide_${key}: ${String(index).padStart(5, "0")}-${key}-${"a".repeat(128)}`).join("\n")}\n---\nneedle synthetic material for note ${index}. No personal data.\n`;
  const filename = (index: number) => path.join(vault, `${String(index).padStart(5, "0")}.md`);
  let inputBytes = 0;
  for (let start = 0; suppliedVault === undefined && start < count; start += 100) await Promise.all(Array.from({ length: Math.min(100, count - start) }, async (_, offset) => {
    const text = raw(start + offset); inputBytes += Buffer.byteLength(text); await writeFile(filename(start + offset), text);
  }));
  const productionBudgets = process.env.OMS_LIVE_PROJECTION_DIAGNOSTIC_DEFAULT_BUDGETS === "1";
  const selected = new LiveLexicalSession({ vault, dbPath: path.join(root, "absent.sqlite"), ...(productionBudgets ? {} : { maxProjectionBytes: 64 * 1024, maxObservedBytes: 256 * 1024 }) });
  let backingReadDecodeMs = 0; let decodedDocuments = 0; let reconcileMs = 0; let eavQueryMs = 0; let nativeRetrievalMs = 0;
  const originalRead = AxisObservationStore.prototype.readLiveProjection;
  vi.spyOn(AxisObservationStore.prototype, "readLiveProjection").mockImplementation(function (this: AxisObservationStore, ...args) {
    const start = performance.now();
    try { const result = originalRead.apply(this, args); if (result !== undefined) decodedDocuments++; return result; }
    finally { backingReadDecodeMs += performance.now() - start; }
  });
  const originalReconcile = AxisObservationStore.prototype.reconcileObservedSnapshot;
  vi.spyOn(AxisObservationStore.prototype, "reconcileObservedSnapshot").mockImplementation(function (this: AxisObservationStore, ...args) {
    const start = performance.now();
    try { return originalReconcile.apply(this, args); }
    finally { reconcileMs += performance.now() - start; }
  });
  const measured = new WeakSet<EngineStore>();
  const internal = selected as unknown as { refreshSources(): Promise<unknown>; current: { store: EngineStore } };
  const refreshSources = internal.refreshSources.bind(selected);
  vi.spyOn(internal, "refreshSources").mockImplementation(async () => {
    const captured = await refreshSources();
    const store = internal.current.store;
    if (measured.has(store)) return captured;
    measured.add(store);
    const query = store.queryLexCandidates!.bind(store);
    store.queryLexCandidates = (...args) => {
      const start = performance.now();
      try { return query(...args); } finally { nativeRetrievalMs += performance.now() - start; }
    };
    const paths = store.queryLexPaths!.bind(store);
    store.queryLexPaths = (...args) => {
      const start = performance.now();
      try { return paths(...args); } finally { nativeRetrievalMs += performance.now() - start; }
    };
    return captured;
  });
  const selector: LexicalSnapshotSelector = (snapshot, documents, observations) => {
    const hash = createHash("sha256").update(snapshot.vault);
    for (const [docPath, sha] of [...snapshot.contentSha256!].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) hash.update(JSON.stringify([docPath, sha]));
    observations.reconcileObservedSnapshot(documents.map(document => ({ ...document, contentSha256: snapshot.contentSha256!.get(document.docPath)! })), hash.digest("hex"));
    const start = performance.now();
    const paths = observations.matchObservedFields(suppliedVault === undefined ? { subject: "science" } : {}, documents.map(document => document.docPath));
    eavQueryMs += performance.now() - start;
    return { paths, discover: matchingPaths => {
      const start = performance.now();
      try { return observations.discoverObservedFields({ ...(suppliedVault === undefined ? { key: "subject" } : {}), candidatePaths: matchingPaths }); }
      finally { eavQueryMs += performance.now() - start; }
    } };
  };
  const meta = await readSearchTemplateSource(vault);
  const run = async (phase: string) => {
    stages.scanMs = stages.parseMs = stages.projectMs = 0; stages.bodyReads.length = 0;
    backingReadDecodeMs = decodedDocuments = reconcileMs = eavQueryMs = nativeRetrievalMs = 0;
    const start = performance.now();
    const prepared = await selected.prepare(vault, suppliedVault === undefined ? ["needle"] : [], Number.MAX_SAFE_INTEGER, undefined, selector);
    const matches = suppliedVault === undefined ? prepared.store.queryLex("needle", Number.MAX_SAFE_INTEGER).length : prepared.candidatePaths!.length;
    expect((await prepared.nodeProjection(meta)).length).toBe(count);
    return { phase, totalMs: performance.now() - start, scanMs: stages.scanMs, parseMs: stages.parseMs,
      backingReadDecodeMs, decodedDocuments, projectMs: stages.projectMs, reconcileMs, eavQueryMs, nativeRetrievalMs,
      bodyReadCount: stages.bodyReads.length, bodyReadPaths: stages.bodyReads.map(name => path.relative(vault, name)), matches,
      retained: selected.retainedStorage() };
  };
  try {
    const cold = await run("cold");
    const warm = await run("warm");
    const runs = [cold, warm];
    expect(cold.bodyReadCount).toBe(count);
    expect(warm.bodyReadCount).toBe(0);
    expect(warm.matches).toBe(cold.matches);
    if (suppliedVault === undefined) {
      await writeFile(filename(0), raw(0).replace("[science, research]", "changed"));
      const edited = await run("one-edit"); runs.push(edited);
      expect(edited.bodyReadPaths).toEqual(["00000.md"]);
      expect(cold.matches).toBe(Math.ceil(count / 20));
      expect(edited.matches).toBe(cold.matches - 1);
    } else expect(cold.matches).toBe(count);
    expect(warm.retained.projectionBytes).toBeLessThanOrEqual(productionBudgets ? 64 * 1024 * 1024 : 64 * 1024);
    expect(warm.retained.projectionDocuments).toBe(cold.retained.projectionDocuments);
    if (process.env.OMS_LIVE_PROJECTION_DIAGNOSTICS === "1") console.log(JSON.stringify({ fixture: suppliedVault === undefined ? "synthetic dense projection stage probe" : "supplied read-only projection stage probe", count, ...(suppliedVault === undefined ? { keysPerNote: 22, inputBytes } : {}), productionBudgets, runs: runs.map(({ bodyReadPaths: _, ...run }) => run), peakRssBytes: process.resourceUsage().maxRSS * 1024 }, null, 2));
  } finally { await selected.dispose(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
}, 180_000);
