// Public, synthetic-only reproduction. Run npm run build first.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assembleCoreSemanticEngineReadOnly } from "../../dist/kernel/engine/assemble.js";
import { syncEngineStore } from "../../dist/kernel/engine/embed/sync.js";

const vault = await mkdtemp(path.join(tmpdir(), "oms-freshness-vault-"));
const storeDirectory = await mkdtemp(path.join(tmpdir(), "oms-freshness-store-"));
const dbPath = path.join(storeDirectory, "index.sqlite");
const note = path.join(vault, "example.md");
const results = [];
async function query(label, term) {
  const engine = assembleCoreSemanticEngineReadOnly({ vault, dbPath });
  assert(engine);
  try {
    const result = await engine.adapter.semanticQuery({ query: term });
    results.push({ label, available: result.available, hits: result.hits.length, indexDrift: result.receipt.indexDrift });
    return result;
  } finally { await engine.dispose(); }
}
try {
  await writeFile(note, "# Example\noldkeyword\n");
  assert((await syncEngineStore({ vault, dbPath, embed: false })).available);
  assert.equal((await query("indexed", "oldkeyword")).hits.length, 1);
  const unchangedStore = await readFile(dbPath);
  const before = await stat(note);
  await writeFile(note, "# Example\nnewkeyword\n");
  await utimes(note, before.atime, before.mtime);
  assert.equal((await stat(note)).size, before.size);
  for (const term of ["oldkeyword", "newkeyword"]) {
    const result = await query(`edited:${term}`, term);
    assert.equal(result.available, false);
    assert.equal(result.receipt.indexDrift, true);
  }
  assert.deepEqual(await readFile(dbPath), unchangedStore);
  assert((await syncEngineStore({ vault, dbPath, embed: false })).available);
  assert.equal((await query("resynced", "newkeyword")).hits.length, 1);
  console.log(JSON.stringify({ synthetic: true, persistedStoreUnchangedBySearch: true, results }, null, 2));
} finally {
  await rm(vault, { recursive: true, force: true });
  await rm(storeDirectory, { recursive: true, force: true });
}
