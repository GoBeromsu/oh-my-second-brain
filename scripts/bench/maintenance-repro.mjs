#!/usr/bin/env node
// Anonymous fixture only. Run npm run build first. No models or private notes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
let notes = 20_000; let parent = tmpdir(); let output;
for (let index = 0; index < args.length; index++) {
  const flag = args[index]; const value = args[++index];
  if (flag === "--notes") notes = Number(value);
  else if (flag === "--work-dir") parent = path.resolve(value);
  else if (flag === "--output") output = path.resolve(value);
  else throw new Error(`Unknown option: ${flag}`);
}
assert(Number.isSafeInteger(notes) && notes >= 1200 && notes <= 100_000, "--notes must be between 1200 and 100000");
await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, "oms-maintenance-repro-"));
const vault = path.join(root, "vault"); const dbPath = path.join(root, "state", "index.sqlite");
await mkdir(vault); await mkdir(path.dirname(dbPath));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { syncEngineStore } = await import(path.join(repo, "dist/kernel/engine/embed/sync.js"));
const { startIndexMaintenance } = await import(path.join(repo, "dist/kernel/engine/index-maintenance.js"));
const { readMaintenanceState } = await import(path.join(repo, "dist/kernel/engine/embed/maintenance.js"));
const { openEngineStoreCoreReadOnly } = await import(path.join(repo, "dist/kernel/engine/embed/store.js"));
const { mapWithConcurrency } = await import(path.join(repo, "dist/kernel/conventions/vault-walk.js"));
const expected = new Map();
const filename = index => `${String(index).padStart(5, "0")}.md`;
const digest = text => createHash("sha256").update(text).digest("hex");
const raw = (index, marker = "initialmarker") => `---\n${Array.from({ length: 22 }, (_, key) => `field${key}: [value${index % 17}, shared]`).join("\n")}\n---\n# Note ${index}\n${marker}\n${"anonymous synthetic text ".repeat(20)}\n`;
let inputBytes = 0;
await mapWithConcurrency(Array.from({ length: notes }, (_, index) => index), 32, async index => {
  const content = raw(index); inputBytes += Buffer.byteLength(content); expected.set(filename(index), digest(content));
  await writeFile(path.join(vault, filename(index)), content);
});
const seedStart = performance.now();
assert.equal((await syncEngineStore({ vault, dbPath, embed: false })).available, true);
const seedMs = performance.now() - seedStart;

let bodyReads = 0; let bodyBytes = 0;
const originalOpen = fs.promises.open;
fs.promises.open = async function(...values) {
  const handle = await originalOpen.apply(this, values);
  const candidate = String(values[0]);
  if (candidate.startsWith(`${vault}${path.sep}`) && candidate.endsWith(".md")) {
    const originalRead = handle.readFile.bind(handle);
    handle.readFile = async function(...readArgs) {
      const bytes = await originalRead(...readArgs); bodyReads++; bodyBytes += Buffer.byteLength(bytes); return bytes;
    };
  }
  return handle;
};
syncBuiltinESMExports();
const phases = [];
let owner;
async function verifyNotes() {
  const actual = (await readdir(vault)).sort();
  assert.deepEqual(actual, [...expected.keys()].sort());
  await mapWithConcurrency(actual, 32, async note => assert.equal(digest(await readFile(path.join(vault, note))), expected.get(note)));
}
async function phase(label, notify) {
  bodyReads = bodyBytes = 0;
  notify?.();
  const before = performance.now(); await owner.controller.flush(); const elapsedMs = performance.now() - before;
  const status = owner.status();
  assert.equal(status.phase, "idle", `${label}: ${JSON.stringify(status)}`);
  const result = { label, elapsedMs: Math.round(elapsedMs * 1000) / 1000, bodyReads, bodyBytes, status };
  phases.push(result); await verifyNotes(); return result;
}
function hits(term) {
  const store = openEngineStoreCoreReadOnly(dbPath); assert(store);
  try { return store.queryLex(term, notes + 1).map(hit => hit.docPath); } finally { store.close(); }
}
try {
  owner = await startIndexMaintenance({ vault, dbPath, source: "explicit", mode: "lexical", debounceMs: 60_000, reconcileMs: 60_000 }, {
    // Deterministic kernel measurement: OS event latency is tested separately.
    watch: () => ({ close() {} }),
  });
  await phase("startup-reconcile");
  const warm = await phase("unchanged-full-reconcile", () => owner.notify());
  assert.equal(warm.bodyReads, 0, "Strong-witness unchanged reconciliation reread note bodies");
  for (const count of [100, 1000]) {
    await mapWithConcurrency(Array.from({ length: count }, (_, index) => index), 32, async index => {
      const content = raw(index, `batch${count}marker`); const note = filename(index);
      expected.set(note, digest(content)); await writeFile(path.join(vault, note), content); owner.notify(note);
    });
    const changed = await phase(`edit-${count}`);
    assert.equal(changed.bodyReads, count, "Only changed source bodies should be captured");
    assert.equal(hits(`batch${count}marker`).length, count);
  }
  for (let index = 1000; index < 1100; index++) {
    const old = filename(index); const next = `renamed-${old}`;
    await rename(path.join(vault, old), path.join(vault, next)); expected.set(next, expected.get(old)); expected.delete(old);
  }
  for (let index = 1100; index < 1200; index++) { const note = filename(index); await rm(path.join(vault, note)); expected.delete(note); }
  const transition = await phase("rename-100-delete-100", () => owner.notify());
  assert.equal(transition.bodyReads, 100);
  const state = readMaintenanceState(dbPath);
  assert.equal(state.documents.size, notes - 100);
  for (let index = 1000; index < 1200; index++) assert(!state.documents.has(filename(index)));
  for (let index = 1000; index < 1100; index++) assert(state.documents.has(`renamed-${filename(index)}`));
  await owner.stop();
  for (const suffix of [".maintenance.owners", ".writer.owners"]) assert.deepEqual(await readdir(`${dbPath}${suffix}`), []);
  const result = { fixture: "anonymous synthetic maintenance", notes, inputBytes, initializedIndexSeedMs: seedMs,
    mode: "lexical", measurementScope: "existing-index controller flush; file mutation, validation reads, OS watch delivery, query latency and embedding inference excluded",
    runtime: { node: process.version, sqlite: state.sqliteVersion }, phases, indexBytes: (await stat(dbPath)).size,
    peakRssBytes: process.resourceUsage().maxRSS * 1024, finalDocuments: state.documents.size, cleanup: "all ownership records released; fixture removed in finally" };
  if (output !== undefined) await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await owner?.stop(); fs.promises.open = originalOpen; syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true });
}
