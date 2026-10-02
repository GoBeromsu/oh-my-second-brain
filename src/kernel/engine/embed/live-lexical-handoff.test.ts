import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { LiveLexicalSession } from "./live-lexical.js";
import { syncEngineStore } from "./sync.js";
import { openEngineStoreCore } from "./store.js";
import { chunkDocument } from "./chunker.js";
import { indexSourcesUnchanged } from "./freshness.js";

it.each([0, 1, 2, 3, 4])("pins candidate capture across an external generation handoff at microtask depth %i", async depth => {
  const root = await mkdtemp(path.join(tmpdir(), "oms-live-handoff-"));
  const vault = path.join(root, "vault");
  const dbPath = path.join(root, "index.sqlite");
  await mkdir(vault);
  await writeFile(path.join(vault, "a.md"), "oldkeyword");
  await syncEngineStore({ vault, dbPath, embed: false });
  const selected = new LiveLexicalSession({ vault, dbPath });
  // Inject only scheduling at the private refresh boundary, leaving production
  // admission/candidate capture unchanged. The old finally-based release loses
  // recall at one of these schedules while its source snapshot still validates.
  const state = selected as unknown as { refresh(): Promise<unknown> };
  const original = state.refresh.bind(state);
  let injected = false;
  let next: ReturnType<typeof selected.prepare> | undefined;
  state.refresh = () => {
    const promise = original();
    if (!injected) {
      injected = true;
      void promise.then(() => {
        const replaceGeneration = () => {
          const writer = openEngineStoreCore(dbPath);
          try { writer.clearDocument("a.md"); writer.upsertLex(chunkDocument("a.md", "boguskeyword")); }
          finally { writer.close(); }
          next = selected.prepare(vault, ["oldkeyword"], 10);
        };
        let remaining = depth;
        const tick = () => { if (remaining-- === 0) replaceGeneration(); else queueMicrotask(tick); };
        queueMicrotask(tick);
      });
    }
    return promise;
  };
  try {
    const first = await selected.prepare(vault, ["oldkeyword"], 10);
    while (next === undefined) await new Promise(resolve => setImmediate(resolve));
    const second = await next;
    expect(await indexSourcesUnchanged(first.snapshot)).toBe(true);
    expect(first.store.queryLex("oldkeyword", 10)).toHaveLength(1);
    expect(second.store.queryLex("oldkeyword", 10)).toHaveLength(1);
  } finally { await selected.dispose(); await rm(root, { recursive: true, force: true }); }
});
