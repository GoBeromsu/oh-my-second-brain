import { describe, expect, it } from "vitest";
import path from "node:path";
import type { HarnessHostSurface } from "../harness/surface-registry.js";
import { HostAdapterSourceError, resolveHostAdapterSource } from "./hosts.js";

describe("host registry adapter source resolution", () => {
  it("resolves registry adapterDir paths under the local adapter root", () => {
    const registryHost: HarnessHostSurface = {
      runtime: "claude",
      adapterDir: "adapters/custom-claude",
      skillDirs: [],
      manifestFiles: [],
      guidanceFiles: [],
      hookFiles: [],
      ruleFiles: [],
      mcpConfigFiles: [],
      hardHookGuarantee: true,
    };

    const source = resolveHostAdapterSource("/package/adapters", registryHost);

    expect(source).toBe(path.join("/package/adapters", "custom-claude"));
  });

  it("rejects malformed registry adapterDir paths outside adapters", () => {
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

    expect(() => resolveHostAdapterSource("/package/adapters", registryHost)).toThrow(HostAdapterSourceError);
  });
});
