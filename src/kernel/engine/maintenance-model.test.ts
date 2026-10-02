import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalModelIdentityKey } from "./embed/config.js";
import * as model from "./embed/model.js";
import * as snapshot from "../conventions/file-snapshot.js";
import { createMaintenanceEmbedding } from "./maintenance-model.js";
import { requireRealEmbeddingProvider } from "./embed/provider.js";

vi.mock("./embed/provider.js", () => ({ requireRealEmbeddingProvider: vi.fn(() => ({ model: "fixture", dimensions: 768, embed: vi.fn(), dispose: vi.fn(async () => {}) })) }));
let root: string; let vault: string; let cache: string; let filename: string;
const bytes = "local synthetic model fixture";
const selection = { provider: "gguf" as const, model: "fixture.gguf", revision: "v1.2.3", sha256: createHash("sha256").update(bytes).digest("hex"), promptScheme: "embeddinggemma-v1" };
function receipt() { return { schemaVersion: 1, artifacts: [{ capability: "embed", selection, path: filename, embedShape: { dimensions: 768, contextLength: 2048, mrlDim: 0, normalization: "l2" } }], defaults: [canonicalModelIdentityKey(selection)] }; }
function installed() { writeFileSync(filename, bytes); writeFileSync(path.join(cache, model.INSTALLED_MODELS_RECEIPT), JSON.stringify(receipt())); }
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "oms-maintenance-model-")); vault = path.join(root, "vault"); cache = path.join(root, "models"); mkdirSync(vault); mkdirSync(cache); filename = path.join(cache, "fixture.gguf"); });
afterEach(() => { vi.restoreAllMocks(); vi.mocked(requireRealEmbeddingProvider).mockClear(); rmSync(root, { recursive: true, force: true }); });
const options = () => ({ modelCacheDir: cache, modelEnv: {} });

describe("maintenance embedding capability", () => {
  it("resolves and verifies the existing local model without opening a database", () => {
    installed(); const selected = createMaintenanceEmbedding(vault, options());
    expect(selected.identity).toMatchObject({ provider: "gguf", model: selection.model, sha256: selection.sha256, dimensions: 768 });
    expect(selected.isCurrent()).toBe(true);
    expect(requireRealEmbeddingProvider).toHaveBeenCalledWith(expect.objectContaining({ model: filename, prefixScheme: "embeddinggemma-v1", localOnly: true }));
  });

  it("fails explicitly when no installed model is selected", () => {
    expect(() => createMaintenanceEmbedding(vault, options())).toThrow();
    expect(requireRealEmbeddingProvider).not.toHaveBeenCalled();
  });

  it.each(["bad-json", "directory", "bad-checksum"])("rejects %s before creating a provider", kind => {
    installed();
    if (kind === "bad-json") writeFileSync(path.join(cache, model.INSTALLED_MODELS_RECEIPT), "{");
    if (kind === "directory") { rmSync(path.join(cache, model.INSTALLED_MODELS_RECEIPT)); mkdirSync(path.join(cache, model.INSTALLED_MODELS_RECEIPT)); }
    if (kind === "bad-checksum") writeFileSync(filename, "different");
    expect(() => createMaintenanceEmbedding(vault, options())).toThrow();
    expect(requireRealEmbeddingProvider).not.toHaveBeenCalled();
  });

  it.each(["receipt", "artifact", "missing", "environment", "settings"])("invalidates pending jobs after %s changes", kind => {
    installed(); const modelEnv: Record<string, string> = {};
    const selected = createMaintenanceEmbedding(vault, { modelCacheDir: cache, modelEnv });
    if (kind === "receipt") writeFileSync(path.join(cache, model.INSTALLED_MODELS_RECEIPT), JSON.stringify({ ...receipt(), defaults: [] }));
    if (kind === "artifact") writeFileSync(filename, "different");
    if (kind === "missing") rmSync(filename);
    if (kind === "environment") modelEnv.OMS_EMBEDDING_MODEL = "other.gguf";
    if (kind === "settings") { mkdirSync(path.join(vault, ".oms")); writeFileSync(path.join(vault, ".oms/settings.json"), "{"); }
    expect(selected.isCurrent()).toBe(false);
  });

  it("uses byte evidence when artifact metadata cannot authorize reuse", () => {
    installed(); vi.spyOn(snapshot, "fileMetadataWitness").mockReturnValue(null);
    const selected = createMaintenanceEmbedding(vault, options());
    expect(selected.isCurrent()).toBe(true);
    writeFileSync(filename, "different"); expect(selected.isCurrent()).toBe(false);
  });

  it("refuses a selection changed during integrity verification", () => {
    installed(); const original = model.readInstalledModelsReceiptSync;
    const modelEnv: Record<string, string> = {};
    vi.spyOn(model, "readInstalledModelsReceiptSync").mockImplementationOnce(input => { const result = original(input); modelEnv.OMS_EMBEDDING_MODEL = "changed.gguf"; return result; });
    expect(() => createMaintenanceEmbedding(vault, { modelCacheDir: cache, modelEnv })).toThrow();
    expect(requireRealEmbeddingProvider).not.toHaveBeenCalled();
  });
});
