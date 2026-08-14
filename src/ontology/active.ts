import { stat } from "node:fs/promises";
import path from "node:path";
import { resolveBundledAssetPaths } from "../core/runtime/assets.js";
import { loadOntology } from "../core/ontology/loader.js";
import type { Ontology } from "../core/ontology/types.js";

export type ActiveOntologySource = "vault" | "bundled";

export interface ActiveOntology {
  readonly ontology: Ontology;
  readonly source: ActiveOntologySource;
}

const bundledAssets = resolveBundledAssetPaths();

async function pathKind(target: string): Promise<"missing" | "file" | "directory" | "other"> {
  try {
    const info = await stat(target);
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

export async function resolveActiveOntology(vault: string): Promise<ActiveOntology> {
  const localOntologyDir = path.join(vault, ".oms");
  const omsKind = await pathKind(localOntologyDir);
  if (omsKind === "missing") {
    return { ontology: await loadOntology(bundledAssets.ontologyDir), source: "bundled" };
  }
  if (omsKind !== "directory") {
    throw new Error("Local .oms exists but is not a directory.");
  }

  const taxonomyKind = await pathKind(path.join(localOntologyDir, "taxonomy.yaml"));
  const conceptsKind = await pathKind(path.join(localOntologyDir, "concepts"));

  if (taxonomyKind === "missing" && conceptsKind === "missing") {
    return { ontology: await loadOntology(bundledAssets.ontologyDir), source: "bundled" };
  }
  if (taxonomyKind !== "file" || conceptsKind !== "directory") {
    throw new Error("Local .oms ontology is incomplete; expected .oms/taxonomy.yaml and .oms/concepts/.");
  }

  return { ontology: await loadOntology(localOntologyDir), source: "vault" };
}
