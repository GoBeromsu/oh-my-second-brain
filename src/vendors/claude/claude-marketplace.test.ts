import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  MARKETPLACE_AUTO_UPDATE_MESSAGE,
  readMarketplaceName,
  resolveClaudeMarketplaceSource,
} from "./claude-marketplace.js";

async function makeRepoRoot(suffix: string, manifest: string | null): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `oms-marketplace-${suffix}-`));
  if (manifest !== null) {
    await mkdir(path.join(root, ".claude-plugin"), { recursive: true });
    await writeFile(path.join(root, ".claude-plugin", "marketplace.json"), manifest, "utf-8");
  }
  return root;
}

describe("readMarketplaceName", () => {
  it("returns the manifest name when the repo ships a marketplace manifest", async () => {
    // Given: a repo root whose marketplace manifest declares a name
    const root = await makeRepoRoot("named", JSON.stringify({ name: "oms", plugins: [] }));
    // When: the marketplace name is read
    const name = await readMarketplaceName(root);
    // Then: the declared name is returned verbatim
    expect(name).toBe("oms");
  });

  it("returns null when the manifest is absent", async () => {
    const root = await makeRepoRoot("absent", null);
    expect(await readMarketplaceName(root)).toBeNull();
  });

  it("returns null when the manifest declares no string name", async () => {
    const root = await makeRepoRoot("nameless", JSON.stringify({ plugins: [] }));
    expect(await readMarketplaceName(root)).toBeNull();
  });

  it("returns null when the manifest is malformed JSON", async () => {
    const root = await makeRepoRoot("malformed", "{ not json");
    expect(await readMarketplaceName(root)).toBeNull();
  });

  it("reads the repository's real manifest name", async () => {
    // Given: the repo root checked out for this test run
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    // When: the shipped marketplace manifest is read
    const name = await readMarketplaceName(repoRoot);
    // Then: the name matches the manifest committed at todo 9
    expect(name).toBe("oms");
  });
});

describe("resolveClaudeMarketplaceSource", () => {
  it("uses the local repo root when it ships a marketplace manifest", async () => {
    // Given: a repo checkout carrying the manifest at its plugin root. Since the
    // vendor topology move the plugin root IS the repository root, so the
    // resolver is handed the root directly rather than a vendor subdirectory.
    const root = await makeRepoRoot("local", JSON.stringify({ name: "oms", plugins: [] }));
    // When: the marketplace source is resolved from the plugin root
    const source = await resolveClaudeMarketplaceSource(root);
    // Then: the local checkout is preferred over the remote repo
    expect(source).toEqual({ kind: "local", source: root, marketplaceName: "oms" });
  });

  it("falls back to the GitHub repo when no local manifest exists", async () => {
    // Given: a plugin root with no marketplace manifest (npm install layout)
    const root = await makeRepoRoot("remote", null);
    // When: the marketplace source is resolved
    const source = await resolveClaudeMarketplaceSource(root);
    // Then: the published GitHub repo is used with the published marketplace name
    expect(source).toEqual({
      kind: "github",
      source: "GoBeromsu/oh-my-second-brain",
      marketplaceName: "oms",
    });
  });
});

describe("MARKETPLACE_AUTO_UPDATE_MESSAGE", () => {
  it("names the setting and the command without claiming OMS changed it", () => {
    // Given/When: the message shipped alongside the marketplace install
    const message = MARKETPLACE_AUTO_UPDATE_MESSAGE;
    // Then: it points at the real settings key and stays advisory
    expect(message).toContain("extraKnownMarketplaces");
    expect(message).toContain("autoUpdate");
  });
});
