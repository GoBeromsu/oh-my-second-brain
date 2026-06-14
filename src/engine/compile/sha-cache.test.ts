import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  diffSHA,
  fingerprint,
  loadSHACache,
  saveSHACache,
  sha256,
} from "./sha-cache.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "oms-sha-cache-test-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("sha256", () => {
  it("returns a 64-char hex string", () => {
    expect(sha256("hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input always produces same digest", () => {
    expect(sha256("hello")).toBe(sha256("hello"));
  });

  it("differs for different inputs", () => {
    expect(sha256("content-a")).not.toBe(sha256("content-b"));
  });
});

describe("fingerprint", () => {
  it("is deterministic regardless of material order", () => {
    const a = [
      { path: "a.md", text: "alpha" },
      { path: "b.md", text: "beta" },
    ];
    const b = [
      { path: "b.md", text: "beta" },
      { path: "a.md", text: "alpha" },
    ];
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("changes when a material's text is modified", () => {
    const before = [{ path: "a.md", text: "original content" }];
    const after = [{ path: "a.md", text: "modified content" }];
    expect(fingerprint(before)).not.toBe(fingerprint(after));
  });

  it("changes when a material is added", () => {
    const before = [{ path: "a.md", text: "alpha" }];
    const after = [
      { path: "a.md", text: "alpha" },
      { path: "b.md", text: "beta" },
    ];
    expect(fingerprint(before)).not.toBe(fingerprint(after));
  });

  it("changes when a material is removed", () => {
    const before = [
      { path: "a.md", text: "alpha" },
      { path: "b.md", text: "beta" },
    ];
    const after = [{ path: "a.md", text: "alpha" }];
    expect(fingerprint(before)).not.toBe(fingerprint(after));
  });

  it("returns a 64-char hex string", () => {
    expect(fingerprint([{ path: "x.md", text: "content" }])).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

describe("loadSHACache", () => {
  it("returns empty object when dotLlmwiki dir is absent", async () => {
    const cache = await loadSHACache(path.join(dir, "nonexistent-dir"));
    expect(cache).toEqual({});
  });

  it("returns empty object when sha-cache.json is absent", async () => {
    const subdir = path.join(dir, "empty-llmwiki");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(subdir, { recursive: true });
    const cache = await loadSHACache(subdir);
    expect(cache).toEqual({});
  });
});

describe("saveSHACache + loadSHACache round-trip", () => {
  it("persists and reloads cache entries", async () => {
    const subdir = path.join(dir, "llmwiki-rt");
    const initial: Record<string, string> = {};
    initial["concepts/alpha.md"] = sha256("material content for alpha");
    initial["concepts/beta.md"] = sha256("material content for beta");
    await saveSHACache(subdir, initial);
    const loaded = await loadSHACache(subdir);
    expect(loaded["concepts/alpha.md"]).toBe(sha256("material content for alpha"));
    expect(loaded["concepts/beta.md"]).toBe(sha256("material content for beta"));
  });

  it("creates the dotLlmwiki directory if absent", async () => {
    const subdir = path.join(dir, "llmwiki-autocreate");
    await expect(
      saveSHACache(subdir, { "x.md": "abc" }),
    ).resolves.not.toThrow();
    const loaded = await loadSHACache(subdir);
    expect(loaded["x.md"]).toBe("abc");
  });

  it("overwrites existing entries on re-save", async () => {
    const subdir = path.join(dir, "llmwiki-overwrite");
    await saveSHACache(subdir, { "a.md": "old-sha" });
    await saveSHACache(subdir, { "a.md": "new-sha" });
    const loaded = await loadSHACache(subdir);
    expect(loaded["a.md"]).toBe("new-sha");
  });
});

describe("diffSHA", () => {
  it("returns 'new' when concept is not in cache", () => {
    expect(diffSHA({}, "concepts/new.md", "abc123")).toBe("new");
  });

  it("returns 'unchanged' when SHA matches cached value", () => {
    expect(
      diffSHA({ "concepts/x.md": "deadbeef" }, "concepts/x.md", "deadbeef"),
    ).toBe("unchanged");
  });

  it("returns 'changed' when SHA differs from cached value", () => {
    expect(
      diffSHA({ "concepts/x.md": "old-sha" }, "concepts/x.md", "new-sha"),
    ).toBe("changed");
  });

  it("treats different concept IDs independently", () => {
    const cache = { "concepts/a.md": "sha-a", "concepts/b.md": "sha-b" };
    expect(diffSHA(cache, "concepts/a.md", "sha-a")).toBe("unchanged");
    expect(diffSHA(cache, "concepts/b.md", "sha-x")).toBe("changed");
    expect(diffSHA(cache, "concepts/c.md", "sha-c")).toBe("new");
  });
});
