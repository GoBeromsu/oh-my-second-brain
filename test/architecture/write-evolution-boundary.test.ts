import { readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { absolute, assertNonVacuous, collectFiles, findImports, importSpecifiers, isProductionTs, nonLiteralDynamicImports, pathExists, underAny } from "./repo-root.js";

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

/**
 * Contract evolution seals only through its gate. `sealContract` is named by exactly the
 * interview (the owner's first seal) and the seal gate (every evolution, autonomous or
 * human-approved). Two test helpers seal fixture vaults and are allowlisted for that
 * reason only; they must stay out of every shipped entrypoint's import closure.
 *
 * Out of scope: `scripts/release-artifact-smoke.mjs:147-150` and
 * `scripts/bench/lineage-snapshots.mjs` call the built store from plain scripts that
 * never ship in the package, so they are not TypeScript product importers.
 */
const SEAL_PRODUCT_IMPORTERS = ["src/kernel/contract/interview.ts", "src/kernel/evolution/seal-gate.ts"];
const SEAL_TEST_HELPERS = [
  // Seals a throwaway vault for store and CLI tests; never imported by product code.
  "src/kernel/contract/contract-vault-fixture.ts",
  // Seals the truth-table vaults the judge and e2e tests read.
  "test/fixtures/contract-truth-table.ts",
];
const TEST_ONLY_MODULES = [...SEAL_TEST_HELPERS, "src/kernel/search/morning-test-fixtures.ts"];
const ENTRYPOINTS = ["src/cli/oms.ts", "src/mcp/server.ts"];
const HUMAN_APPROVAL = "src/kernel/evolution/human-approval";
const SEAL_GATE_HUMAN = "src/kernel/evolution/seal-gate-human";
const SEAL_GATE = "src/kernel/evolution/seal-gate";
const APPROVAL_TERMINAL = "src/cli/evolution-approve.ts";

async function productionFiles(): Promise<string[]> {
  const files = [...await collectFiles("src", isProductionTs), ...await collectFiles("test", isProductionTs)];
  assertNonVacuous(files, "production and helper TypeScript");
  return files;
}

describe("contract evolution seal boundary", () => {
  it("names sealContract only in the interview, the seal gate and the allowlisted test helpers", async () => {
    const namers: string[] = [];
    for (const file of await productionFiles()) {
      if (file === STORE) continue;
      if (mentions(await readFile(absolute(file), "utf8"), "sealContract")) namers.push(file);
    }
    // Exact match: a new importer fails, and so does a stale allowlist entry.
    expect(namers.filter(file => !SEAL_TEST_HELPERS.includes(file))).toEqual(SEAL_PRODUCT_IMPORTERS);
    expect(namers.filter(file => SEAL_TEST_HELPERS.includes(file))).toEqual([...SEAL_TEST_HELPERS].sort());
  });

  it("keeps the sealing test helpers out of the CLI and MCP entrypoint closures", async () => {
    for (const file of [...ENTRYPOINTS, ...TEST_ONLY_MODULES]) expect(await pathExists(file), file).toBe(true);
    const closure = await importClosure(ENTRYPOINTS);
    expect(closure.length).toBeGreaterThan(ENTRYPOINTS.length);
    expect(closure.filter(file => TEST_ONLY_MODULES.includes(file))).toEqual([]);
  });

  it("imports the human prompt and the human seal only from the owner's terminal", async () => {
    const files = await collectFiles("src", isProductionTs);
    assertNonVacuous(files, "src production files");
    const edges = await findImports(files, resolved => resolved === HUMAN_APPROVAL || resolved === SEAL_GATE_HUMAN);
    // Type-only imports count too: other CLI modules take the prompt types from the terminal module.
    expect([...new Set(edges.map(edge => edge.file))]).toEqual([APPROVAL_TERMINAL]);
    expect(new Set(edges.map(edge => edge.resolved))).toEqual(new Set([HUMAN_APPROVAL, SEAL_GATE_HUMAN]));
  });

  it("keeps the human prompt and the human seal out of every MCP closure, dynamic imports included", async () => {
    const src = await collectFiles("src", isProductionTs);
    const offenders: string[] = [];
    for (const file of src) {
      if (nonLiteralDynamicImports(await readFile(absolute(file), "utf8")).length > 0) offenders.push(file);
    }
    expect(offenders).toEqual([]);
    const mcp = src.filter(file => file.startsWith("src/mcp/"));
    assertNonVacuous(mcp, "src/mcp production files");
    const closure = await importClosure(mcp);
    expect(closure.filter(file => file === `${HUMAN_APPROVAL}.ts` || file === `${SEAL_GATE_HUMAN}.ts`)).toEqual([]);
  });

  it("the human prompt cannot seal and does not own the terminal", async () => {
    const file = `${HUMAN_APPROVAL}.ts`;
    const source = await readFile(absolute(file), "utf8");
    expect(mentions(source, "sealContract")).toBe(false);
    expect(mentions(source, "stdin")).toBe(false);
    expect(importSpecifiers(source).filter(specifier => specifier === "node:readline" || specifier === "readline")).toEqual([]);
    expect(await findImports([file], resolved => resolved === SEAL_GATE || resolved === STORE.replace(/\.ts$/, ""))).toEqual([]);
  });

  it("the human seal goes through the seal gate, never sealContract directly", async () => {
    const file = `${SEAL_GATE_HUMAN}.ts`;
    expect(mentions(await readFile(absolute(file), "utf8"), "sealContract")).toBe(false);
    expect((await findImports([file], resolved => resolved === SEAL_GATE)).length).toBeGreaterThan(0);
  });

  it("the maker and the evaluator never reach the note write kernel", async () => {
    const roots = (await collectFiles("src/kernel/evolution", isProductionTs))
      .filter(file => /\/(maker|evaluator|stage-[^/]+)\.ts$/.test(file));
    expect(roots).toEqual(expect.arrayContaining(["src/kernel/evolution/evaluator.ts", "src/kernel/evolution/maker.ts"]));
    const closure = await importClosure(roots);
    expect(closure.filter(file => underAny(file, ["src/kernel/write"]))).toEqual([]);
    const offenders: string[] = [];
    for (const file of closure) {
      if (mentions(await readFile(absolute(file), "utf8"), "atomicWriteNote")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("kernel/contract never imports kernel/evolution", async () => {
    const files = await collectFiles("src/kernel/contract", isProductionTs);
    assertNonVacuous(files, "kernel/contract production files");
    expect(await findImports(files, resolved => underAny(resolved, ["src/kernel/evolution"]))).toEqual([]);
  });
});
