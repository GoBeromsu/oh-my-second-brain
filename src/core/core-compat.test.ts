import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { HarnessRuntimeAssetRoot } from "../harness/surface-registry.js";
import * as legacyAssets from "../runtime/assets.js";
import * as legacyOntologyLoader from "../ontology/loader.js";
import * as legacyOntologyResolver from "../ontology/resolver.js";
import * as coreAssets from "./runtime/assets.js";
import * as coreOntologyLoader from "./ontology/loader.js";
import * as coreOntologyResolver from "./ontology/resolver.js";
import type { Ontology } from "./ontology/types.js";

describe("core compatibility barrels", () => {
  it("exports identical runtime asset implementations from old and core paths", () => {
    expect(coreAssets.resolveBundledAssetPaths).toBe(legacyAssets.resolveBundledAssetPaths);
    expect(coreAssets.MissingBundledAssetRootError).toBe(legacyAssets.MissingBundledAssetRootError);
  });

  it("preserves missing bundled asset root errors through old and core paths", () => {
    const moduleUrl = pathToFileURL(
      path.join(path.sep, "tmp", "oms-package", "dist", "core", "runtime", "assets.js"),
    ).href;
    const roots = [
      { id: "ontology", path: "core/ontology", owner: "core" },
      { id: "adapters", path: "adapters", owner: "runtime" },
    ] satisfies readonly HarnessRuntimeAssetRoot[];

    expect(() => coreAssets.resolveBundledAssetPaths(moduleUrl, roots)).toThrow(
      coreAssets.MissingBundledAssetRootError,
    );
    expect(() => legacyAssets.resolveBundledAssetPaths(moduleUrl, roots)).toThrow(
      legacyAssets.MissingBundledAssetRootError,
    );
  });

  it("exports identical ontology implementations from old and core paths", () => {
    expect(coreOntologyLoader.loadOntology).toBe(legacyOntologyLoader.loadOntology);
    expect(coreOntologyResolver.resolveConcept).toBe(legacyOntologyResolver.resolveConcept);
  });

  it("preserves ontology resolver edge behavior through old and core paths", () => {
    const inboxConcept = {
      concept: "inbox",
      intent: "capture inbox",
      folder: "notes",
      fields: [],
    };
    const ontology: Ontology = {
      taxonomy: {
        version: 1,
        folders: {
          notes: { intent: "notes", concept: "inbox" },
          empty: { intent: "empty", concept: null },
          ordered: { intent: "ordered", concept: ["missing", "inbox"] },
        },
      },
      concepts: new Map([["inbox", inboxConcept]]),
    };

    expect(coreOntologyResolver.resolveConcept(ontology, "unknown/file.md")).toBeUndefined();
    expect(legacyOntologyResolver.resolveConcept(ontology, "empty/file.md")).toBeUndefined();
    expect(coreOntologyResolver.resolveConcept(ontology, "ordered/file.md")).toBe(inboxConcept);
    expect(legacyOntologyResolver.resolveConcept(ontology, "ordered/file.md")).toBe(inboxConcept);
  });
});
