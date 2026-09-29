#!/usr/bin/env node
// Contract lineage and snapshot storage over many seals, measured against the built kernel.
//
//   npm run build && node scripts/bench/lineage-snapshots.mjs [generations]
//
// Every run seals into its own temporary store root, never the home store, and removes it
// afterwards. Prints one JSON array; docs/measurements/contract-lineage-snapshots.md records it.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
const { sealContract } = await import(path.join(dist, "kernel/contract/store.js"));
const { lineageAppender } = await import(path.join(dist, "kernel/contract/lineage.js"));
const { snapshotInventory } = await import(path.join(dist, "kernel/contract/generation-snapshot.js"));

const generations = Number(process.argv[2] ?? 1000);
if (!Number.isInteger(generations) || generations < 1) throw new TypeError("generations must be a positive integer");

const sha = text => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** The contract-vault fixture's shape: one folder, one property, one Meeting template. */
function fixtureContract(revision) {
  return {
    folders: { notes: { meaning: "Notes.", searchExclude: false } },
    properties: { title: { meaning: `Note title.${revision}`, type: "text", default: false, required: false, rules: [] } },
    templates: { Meeting: { source: "Templates/Meeting.md", sourceHash: sha("---\ntitle: x\n---\n"), applyFolder: "notes", requiredProperties: ["title"], narrowedRules: {}, requiredHeadings: [] } },
  };
}

/** Ten templates, thirty properties, ten folders, three required headings per template. */
function syntheticContract(revision) {
  const properties = {};
  for (let i = 0; i < 30; i++) {
    properties[`field${i}`] = {
      meaning: `Property ${i}: what this field records for the notes that carry it.${i === 0 ? revision : ""}`,
      type: i % 3 === 0 ? "date" : "text",
      default: false,
      required: false,
      rules: i % 5 === 0 ? [{ kind: "allowed", values: ["draft", "review", "done"] }] : [],
    };
  }
  const folders = {};
  const templates = {};
  for (let t = 0; t < 10; t++) {
    folders[`area${t}`] = { meaning: `Area ${t}: notes filed by the template-${t} workflow.`, searchExclude: false };
    templates[`Template${t}`] = {
      source: `Templates/Template${t}.md`,
      sourceHash: sha(`t${t}`),
      applyFolder: `area${t}`,
      requiredProperties: [0, 1, 2, 3, 4, 5].map(k => `field${(t * 3 + k) % 30}`),
      narrowedRules: {},
      requiredHeadings: ["Summary", "Details", "Next steps"],
    };
  }
  return { folders, properties, templates };
}

/** Logical bytes: the sum of file sizes under a directory. */
async function bytesOf(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    total += entry.isDirectory() ? await bytesOf(full) : (await stat(full)).size;
  }
  return total;
}

/** Allocated bytes on disk, directories included. */
async function diskOf(target) {
  const info = await lstat(target);
  let total = info.blocks * 512;
  if (info.isDirectory()) for (const entry of await readdir(target)) total += await diskOf(path.join(target, entry));
  return total;
}

async function run(name, make, changes) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "oms-lineage-bench-")));
  const root = path.join(base, "store");
  const vaultId = randomUUID();
  const snapshots = path.join(root, `.${vaultId}.state`, "generations");
  let oneSnapshotBytes = 0;
  let noDedupBytes = 0;
  const started = performance.now();
  try {
    for (let g = 0; g < generations; g++) {
      const sealed = await sealContract({ vaultRealPath: base, vaultId, contract: make(changes ? g : 0), onSealed: lineageAppender({ proposer: "fixture", evaluator: "none" }) }, root);
      // Without dedup every seal would keep its own copy of the snapshot it installed.
      const bytes = await bytesOf(path.join(snapshots, sealed.digest.slice("sha256:".length)));
      if (g === 0) oneSnapshotBytes = bytes;
      noDedupBytes += bytes;
    }
    const ms = performance.now() - started;
    const inventory = await snapshotInventory(root, vaultId);
    const lineageBytes = (await stat(path.join(root, `.${vaultId}.state`, "lineage", "events.jsonl"))).size;
    return {
      contract: name,
      workload: changes ? "every seal changes the contract" : "the same contract resealed",
      generations,
      oneSnapshotBytes,
      snapshots: inventory.digests.length,
      snapshotBytesDedup: inventory.bytes,
      snapshotBytesNoDedup: noDedupBytes,
      snapshotDiskDedup: await diskOf(snapshots),
      lineageBytes,
      lineageBytesPerEvent: Math.round(lineageBytes / generations),
      msPerSeal: Math.round(ms / generations),
    };
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const results = [];
for (const [name, make] of [["fixture", fixtureContract], ["synthetic 10-template", syntheticContract]]) {
  for (const changes of [true, false]) results.push(await run(name, make, changes));
}
console.log(JSON.stringify(results, null, 2));
