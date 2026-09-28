import { readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { absolute, assertNonVacuous, collectFiles, findImports, isProductionTs, pathExists } from "./repo-root.js";

/**
 * The write path and the contract-evolution path stay apart:
 *   - nothing reachable from `src/kernel/write/**` can seal a contract, so a
 *     note write can never change the convention that judged it;
 *   - the interview modules never write notes through the write kernel.
 */

const STORE = "src/kernel/contract/store.ts";
const NOTE_WRITE = "src/kernel/write/note-write";
/**
 * The contract-side modules a write uses to record and report gaps, and the mutation
 * model a later evolution will apply. They describe contract changes; they never seal one.
 */
const GAP_MODULES = [
  "src/kernel/contract/gap-ledger.ts",
  "src/kernel/contract/mutation.ts",
  "src/kernel/contract/contradiction.ts",
  "src/kernel/contract/revision.ts",
  "src/kernel/contract/gaps-report.ts",
];

async function sourceFileOf(resolved: string): Promise<string | null> {
  for (const candidate of [`${resolved}.ts`, `${resolved}/index.ts`]) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

/** Production files reachable from `roots` through relative imports, roots included. */
async function importClosure(roots: readonly string[]): Promise<string[]> {
  const seen = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const edge of await findImports([file], () => true)) {
      const target = await sourceFileOf(edge.resolved);
      if (target === null || seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return [...seen].sort();
}

function mentions(source: string, name: string): boolean {
  const file = ts.createSourceFile("mention.ts", source, ts.ScriptTarget.Latest, false);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) found = true;
    else if (ts.isStringLiteralLike(node) && node.text === name) found = true;
    else ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

describe("write / evolution boundary", () => {
  it("nothing reachable from src/kernel/write or the gap modules names sealContract", async () => {
    const roots = [...await collectFiles("src/kernel/write", isProductionTs), ...GAP_MODULES];
    assertNonVacuous(roots, "write kernel production files");
    for (const file of GAP_MODULES) expect(await pathExists(file), file).toBe(true);
    const closure = await importClosure(roots);
    expect(closure.length).toBeGreaterThan(roots.length);
    const offenders: string[] = [];
    for (const file of closure) {
      // The store defines sealContract; reading the sealed contract through it is allowed.
      if (file === STORE) continue;
      if (mentions(await readFile(absolute(file), "utf8"), "sealContract")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("the gate would see a module that names sealContract", async () => {
    const source = await readFile(absolute("src/kernel/contract/interview.ts"), "utf8");
    expect(mentions(source, "sealContract")).toBe(true);
    expect(mentions("const x = store['sealContract'];", "sealContract")).toBe(true);
    expect(mentions("// sealContract in a comment\nconst y = 1;", "sealContract")).toBe(false);
  });

  it("the interview modules never reach the note write kernel", async () => {
    const roots = (await collectFiles("src/kernel/contract", isProductionTs)).filter(file => /\/interview[^/]*\.ts$/.test(file));
    assertNonVacuous(roots, "interview modules");
    const closure = await importClosure(roots);
    expect(closure.filter(file => file === `${NOTE_WRITE}.ts`)).toEqual([]);
    expect(await findImports(roots, resolved => resolved === NOTE_WRITE)).toEqual([]);
  });
});
