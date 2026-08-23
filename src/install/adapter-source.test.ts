import { describe, expect, it } from "vitest";
import path from "node:path";
import type { HarnessHostSurface } from "../harness/surface-registry.js";
import { HostAdapterSourceError, resolveHostAdapterSource, resolveSharedSkillsSource } from "./hosts.js";

describe("host registry adapter source resolution", () => {
  it("resolves root and asset manifest directories under the package root", () => {
    const registryHost: HarnessHostSurface = {
      runtime: "claude",
      adapterDir: ".",
      skillDirs: [],
      manifestFiles: [],
      guidanceFiles: [],
      hookFiles: [],
      ruleFiles: [],
      mcpConfigFiles: [],
      hardHookGuarantee: true,
    };

    const source = resolveHostAdapterSource("/package", registryHost);

    expect(source).toBe("/package");
    expect(resolveSharedSkillsSource("/package")).toBe(path.join("/package", "assets", "skills"));
  });

  it("rejects adapter directories outside the root and assets allowlist", () => {
    const registryHost: HarnessHostSurface = {
      runtime: "codex",
      adapterDir: "core/codex",
      skillDirs: [],
      manifestFiles: [],
      guidanceFiles: [],
      hookFiles: [],
      ruleFiles: [],
      mcpConfigFiles: [],
      hardHookGuarantee: false,
    };

    expect(() => resolveHostAdapterSource("/package", registryHost)).toThrow(HostAdapterSourceError);
  });
});
