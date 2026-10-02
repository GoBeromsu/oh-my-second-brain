#!/usr/bin/env node
import assert from "node:assert/strict";
import { parseNodeProjectionDocument } from "../../dist/kernel/engine/graph/builder.js";

if (typeof globalThis.gc !== "function") throw new Error("Run with node --expose-gc after npm run build.");
for (let i = 0; i < 3; i++) parseNodeProjectionDocument("warm.md", "---\ntitle: Warm\n---\nbody", false);
globalThis.gc();
const before = process.memoryUsage().heapUsed;
const count = 24;
const bodyBytes = 1024 * 1024;
function capture() {
  const documents = [];
  for (let i = 0; i < count; i++) {
    const raw = `---\ntitle: A long title scalar ${i}\naliases: [A long alias scalar ${i}]\n---\n[[A long link target ${i}]]\n` + "x".repeat(bodyBytes);
    documents.push(parseNodeProjectionDocument(`note-${i}.md`, raw, false));
  }
  return documents;
}
const retained = capture();
globalThis.gc();
globalThis.gc();
const retainedHeapDelta = process.memoryUsage().heapUsed - before;
const estimatedBytes = retained.reduce((sum, document) => sum + document.retainedBytes, 0);
assert.equal(retained.length, count);
assert.ok(estimatedBytes < 256 * 1024, "compact representation estimate unexpectedly grew");
assert.ok(retainedHeapDelta < 8 * 1024 * 1024, "compact projections retain large raw-source backing strings");
console.log(JSON.stringify({ count, sourceBytes: count * bodyBytes, estimatedBytes, retainedHeapDelta, node: process.version }));
