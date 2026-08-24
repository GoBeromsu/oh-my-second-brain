import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applySetup, decideNonInteractiveSetup, inspectSetup } from "./service.js";

let vault: string | undefined;

afterEach(async () => {
  if (vault !== undefined) await rm(vault, { recursive: true, force: true });
  vault = undefined;
});

describe("setup service", () => {
  it("resolves non-interactive bindings and previews persistence without writing", async () => {
    vault = await mkdtemp(path.join(tmpdir(), "oms-setup-service-"));
    await mkdir(path.join(vault, "references"));
    await writeFile(path.join(vault, "references", "source.md"), "---\nsource-url: https://example.test\n---\n", "utf-8");
    const state = await inspectSetup({ vault, ontologyDir: path.resolve("core/ontology") });
    const decision = decideNonInteractiveSetup(state, true);

    expect(decision.taxonomy).toEqual({ version: 0, folders: { references: { intent: "References", concept: "literature" } } });
    expect(decision.concepts.find(({ concept }) => concept.concept === "literature")?.concept.fields.map((field) => field.name)).toContain("source-url");

    await applySetup(decision, { dryRun: true });
    expect(existsSync(path.join(vault, ".oms"))).toBe(false);

    await applySetup(decision);
    expect(await readFile(path.join(vault, ".oms", "taxonomy.yaml"), "utf-8")).toContain("references:");
    expect(await readFile(path.join(vault, ".oms", "concepts", "literature.yaml"), "utf-8")).toContain("source-url");
  });
});
