import { describe, expect, it } from "vitest";
import { contractRevision } from "./revision.js";
import type { VaultContract } from "./types.js";

const CONTRACT: VaultContract = { folders: { Inbox: { meaning: "", searchExclude: false } }, properties: null, templates: {} };

describe("contractRevision", () => {
  it("digests a sealed contract deterministically and tells contracts apart", () => {
    const revision = contractRevision({ state: "sealed", contract: CONTRACT });
    expect(revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contractRevision({ state: "sealed", contract: structuredClone(CONTRACT) })).toBe(revision);
    expect(contractRevision({ state: "sealed", contract: { ...CONTRACT, folders: {} } })).not.toBe(revision);
  });

  it("has no revision for an open or unreadable contract", () => {
    expect(contractRevision({ state: "open" })).toBeNull();
    expect(contractRevision({ state: "unreadable" })).toBeNull();
  });
});
