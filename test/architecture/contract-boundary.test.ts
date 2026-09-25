import { describe, expect, it } from "vitest";
import { assertNonVacuous, collectFiles, findImports, isProductionTs, underAny } from "./repo-root.js";

describe("contract kernel boundary", () => {
  it("src/kernel/contract does not import kernel/templates", async () => {
    const files = await collectFiles("src/kernel/contract", isProductionTs);
    assertNonVacuous(files, "contract kernel production files");
    expect(await findImports(files, resolved => underAny(resolved, ["src/kernel/templates"]))).toEqual([]);
  });
});
