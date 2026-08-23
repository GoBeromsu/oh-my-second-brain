import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HostAdapterSourceError,
  resolveHostAdapterSource,
} from "./adapter-source.js";
import { SHARED_SKILLS_SOURCE, resolveSharedSkillsSource } from "../../assets/shared-skills.js";

const ROOT = path.join(path.sep, "tmp", "oms-package");

function resolve(adapterDir: string): string {
  return resolveHostAdapterSource(ROOT, { runtime: "claude", adapterDir });
}

/**
 * Rejection-order regression suite.
 *
 * `path.posix.normalize` collapses both `assets/..` and `""` to `"."`, which is
 * itself a legal adapterDir. A resolver that short-circuits on `normalized ===
 * "."` before running its traversal and emptiness checks therefore accepts both
 * while appearing to enforce them. Every case below fails against that ordering
 * and passes against the correct one.
 */
describe("adapter source resolver rejection ordering", () => {
  it("rejects traversal that normalizes to a legal value", () => {
    expect(() => resolve("assets/..")).toThrow(HostAdapterSourceError);
  });

  it("rejects an empty adapterDir that normalizes to a legal value", () => {
    expect(() => resolve("")).toThrow(HostAdapterSourceError);
    expect(() => resolve("   ")).toThrow(HostAdapterSourceError);
  });

  it("rejects traversal in every position", () => {
    for (const candidate of ["..", "../../assets", "assets/../..", "./..", "assets/../assets"]) {
      expect(() => resolve(candidate), candidate).toThrow(HostAdapterSourceError);
    }
  });

  it("rejects absolute paths on both posix and win32", () => {
    expect(() => resolve("/etc")).toThrow(HostAdapterSourceError);
    expect(() => resolve("C:\\Windows")).toThrow(HostAdapterSourceError);
  });

  it("rejects a plausible but unlisted directory", () => {
    for (const candidate of ["adapters", "assets/skills", "src", "core"]) {
      expect(() => resolve(candidate), candidate).toThrow(HostAdapterSourceError);
    }
  });

  it("accepts exactly the two real registry values", () => {
    expect(resolve(".")).toBe(ROOT);
    expect(resolve("assets")).toBe(path.join(ROOT, "assets"));
  });

  it("accepts the two real values through equivalent spellings", () => {
    expect(resolve("./")).toBe(ROOT);
    expect(resolve("assets/")).toBe(path.join(ROOT, "assets"));
    expect(resolve("./assets")).toBe(path.join(ROOT, "assets"));
  });

  it("resolves the shared skill source to one place for every host", () => {
    expect(SHARED_SKILLS_SOURCE).toBe("assets/skills");
    expect(resolveSharedSkillsSource(ROOT)).toBe(path.join(ROOT, "assets", "skills"));
  });
});
