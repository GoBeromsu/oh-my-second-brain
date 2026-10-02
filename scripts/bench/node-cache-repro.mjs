#!/usr/bin/env node
// Run after `npm run build`: node scripts/bench/node-cache-repro.mjs
// Synthetic only. A weak-metadata filesystem deliberately retains byte reads.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await fsp.mkdtemp(path.join(tmpdir(), "oms-node-cache-repro-"));
const vault = path.join(root, "vault");
const cache = path.join(root, "cache", "nodes.json");
const environment = ["HOME", "USERPROFILE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "OMS_RUNTIME_ROOT"];
const previous = new Map(environment.map(key => [key, process.env[key]]));
const originals = { readFile: fsp.readFile, open: fsp.open, readFileSync: fs.readFileSync, callbackReadFile: fs.readFile };
let calls = 0;
let bytes = 0;
function count(file, content) {
  if (String(file).startsWith(`${vault}${path.sep}`) && String(file).endsWith(".md")) {
    calls++;
    bytes += Buffer.byteLength(content);
  }
}

try {
  for (const key of environment) {
    process.env[key] = path.join(root, key.toLowerCase());
    await fsp.mkdir(process.env[key], { recursive: true });
  }
  await fsp.mkdir(vault);
  for (let index = 0; index < 50; index++) {
    await fsp.writeFile(path.join(vault, `note-${index}.md`), `alpha synthetic note ${index}\n`);
  }
  fsp.readFile = async function (file, ...args) { const data = await originals.readFile.call(this, file, ...args); count(file, data); return data; };
  fs.readFileSync = function (file, ...args) { const data = originals.readFileSync.call(this, file, ...args); count(file, data); return data; };
  fs.readFile = function (file, ...args) {
    const callback = args.pop();
    return originals.callbackReadFile.call(this, file, ...args, (error, data) => { if (!error) count(file, data); callback(error, data); });
  };
  fsp.open = async function (file, ...args) {
    const handle = await originals.open.call(this, file, ...args);
    const read = handle.readFile.bind(handle);
    handle.readFile = async (...options) => { const data = await read(...options); count(file, data); return data; };
    return handle;
  };
  syncBuiltinESMExports();
  const { buildGraphSnapshot, loadNodeIndexForVault, saveNodeIndex } = await import("../../dist/kernel/engine/graph/builder.js");
  const { readSearchTemplateSource } = await import("../../dist/kernel/engine/retrieval/template-source.js");
  const built = await buildGraphSnapshot(vault);
  await saveNodeIndex(cache, built.nodes, built.sourceSignature, built.meta.digest, built.metadataSignature);
  calls = 0; bytes = 0;
  const loaded = await loadNodeIndexForVault(cache, vault, await readSearchTemplateSource(vault));
  assert.deepEqual(loaded, built.nodes);
  const warmReads = calls;
  const warmBytes = bytes;
  if (built.metadataSignature !== null) assert.equal(warmReads, 0);

  const edited = path.join(vault, "note-0.md");
  const before = await fsp.stat(edited);
  await fsp.writeFile(edited, "bravo synthetic note 0\n");
  await fsp.utimes(edited, before.atime, before.mtime);
  await assert.rejects(loadNodeIndexForVault(cache, vault, await readSearchTemplateSource(vault)), /signature is stale/);
  const rebuilt = await buildGraphSnapshot(vault);
  const changed = rebuilt.nodes.find(node => node.path === "note-0.md");
  assert.equal(changed?.searchTerms.has("bravo"), true);
  assert.equal(changed?.searchTerms.has("alpha"), false);
  console.log(JSON.stringify({ notes: 50, metadataOnlyAvailable: built.metadataSignature !== null,
    warmOrdinaryBodyReads: warmReads, warmOrdinaryBodyBytes: warmBytes,
    sameSizeRestoredMtimeEditRejected: true, explicitRebuildHasFreshTerms: true }));
} catch {
  console.error("Synthetic node-cache repro failed");
  process.exitCode = 1;
} finally {
  fsp.readFile = originals.readFile; fsp.open = originals.open;
  fs.readFileSync = originals.readFileSync; fs.readFile = originals.callbackReadFile;
  syncBuiltinESMExports();
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await fsp.rm(root, { recursive: true, force: true });
}
