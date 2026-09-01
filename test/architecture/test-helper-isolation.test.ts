import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  absolute,
  assertNonVacuous,
  collectFiles,
  importSpecifiers,
  isProductionTs,
  resolveImportSource,
} from "./repo-root.js";

/**
 * Test-helper isolation gate.
 *
 * A `*.test-helper.ts` file exists to give tests something a real implementation
 * must never be: an embedder that fabricates vectors, a reranker that reorders
 * nothing. Each one carries a header saying it must not be imported by production
 * code — and until this gate existed, that was a comment, not a constraint.
 *
 * The risk is specific rather than theoretical. `PassthroughReranker` shipped from
 * the production retrieval barrel as the "default no-op reranker", and because the
 * MCP facade decides reranking is available by checking only whether a reranker is
 * defined, injecting it made an explicit `rerank: true` request report success
 * while returning the unchanged fused order. A fake capability reachable from
 * production is exactly the silent degradation ADR-007 forbids, so the boundary
 * that keeps such helpers out of production needs enforcement rather than trust.
 *
 * Scope note: helpers are still compiled into `dist/` and therefore published, so
 * this gate constrains *this repository's* production imports. It does not stop a
 * downstream consumer from reaching into `dist` on purpose; keeping them out of
 * the published artifact entirely would cost `npm run lint` its typechecking of
 * these files, which is a separate tradeoff and not silently changed here.
 */

const TEST_HELPER_SUFFIX = ".test-helper";

function isTestHelper(relativePath: string): boolean {
  return relativePath.endsWith(`${TEST_HELPER_SUFFIX}.ts`);
}

/** Production source excluding the helpers themselves. */
function isProductionNonHelper(relativePath: string): boolean {
  return isProductionTs(relativePath) && !isTestHelper(relativePath);
}

function helperImports(relativeFile: string, source: string): string[] {
  return importSpecifiers(source)
    .map((specifier) => resolveImportSource(relativeFile, specifier))
    .filter((resolved): resolved is string => resolved !== null)
    .filter((resolved) => resolved.endsWith(TEST_HELPER_SUFFIX));
}

describe("test helpers stay out of production code", () => {
  it("scans the real production tree", async () => {
    const files = await collectFiles("src", isProductionNonHelper);
    // A gate that silently stopped finding source would pass forever.
    assertNonVacuous(files, "src production TypeScript excluding test helpers");
  });

  it("finds the helpers it is meant to police", async () => {
    // If helpers were all renamed or removed, this gate would be guarding an
    // empty set while still reporting green. Failing here says the convention
    // changed and the gate needs revisiting, rather than quietly going vacuous.
    const helpers = await collectFiles("src", isTestHelper);
    assertNonVacuous(helpers, "src *.test-helper.ts files");
    expect(helpers).toContain("src/kernel/engine/retrieval/passthrough.test-helper.ts");
  });

  it("no production module imports a test helper", async () => {
    const files = await collectFiles("src", isProductionNonHelper);
    assertNonVacuous(files, "src production TypeScript excluding test helpers");

    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(absolute(file), "utf8");
      for (const resolved of helperImports(file, source)) {
        violations.push(`${file} imports ${resolved}`);
      }
    }

    expect(
      violations,
      "A test helper implements behavior production must never have (fabricated embeddings, " +
        "no-op reranking). Importing one from production makes a fake capability reachable as a " +
        "real one. Leave the capability absent so it fails loudly instead.",
    ).toEqual([]);
  });

  it("detects a production import of a helper", async () => {
    // Mutation fixture: proves the detector actually resolves and flags such an
    // import, so the clean result above means something.
    const mutated = [
      'import { passthroughReranker } from "./passthrough.test-helper.js";',
      "export const reranker = passthroughReranker;",
    ].join("\n");
    expect(helperImports("src/kernel/engine/retrieval/index.ts", mutated))
      .toEqual(["src/kernel/engine/retrieval/passthrough.test-helper"]);
  });

  it("does not flag a helper importing another helper, or ordinary imports", async () => {
    const helperToHelper = 'import { x } from "./other.test-helper.js";';
    // Helpers are excluded from the scanned set, so this pairing is legal.
    expect(isProductionNonHelper("src/kernel/engine/retrieval/passthrough.test-helper.ts")).toBe(false);
    expect(helperImports("src/kernel/engine/retrieval/passthrough.test-helper.ts", helperToHelper))
      .toEqual(["src/kernel/engine/retrieval/other.test-helper"]);

    const ordinary = 'import { fuseRRF } from "./rrf.js";';
    expect(helperImports("src/kernel/engine/retrieval/index.ts", ordinary)).toEqual([]);
  });

  it("keeps every helper labelled as test-only at the top of the file", async () => {
    // The header is how a reader learns the constraint before this gate ever
    // runs; an unlabelled helper invites exactly the import this gate forbids.
    const helpers = await collectFiles("src", isTestHelper);
    assertNonVacuous(helpers, "src *.test-helper.ts files");

    const unlabelled: string[] = [];
    for (const helper of helpers) {
      const source = await readFile(absolute(helper), "utf8");
      const head = source.slice(0, 600);
      if (!/TEST-ONLY/u.test(head) || !/MUST NOT be imported/u.test(head)) {
        unlabelled.push(helper);
      }
    }
    expect(unlabelled, "each test helper must open with a TEST-ONLY / MUST NOT be imported notice")
      .toEqual([]);
  });
});
