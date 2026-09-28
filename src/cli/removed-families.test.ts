import { describe, expect, it } from "vitest";
import { REMOVED_0_19_FAMILIES, REMOVED_FAMILY_GUIDANCE, removedFamilyMessage } from "./removed-families.js";

describe("removed command families", () => {
  it("lists the ten families 0.19 removed, each with guidance", () => {
    expect(REMOVED_0_19_FAMILIES).toEqual(["contract", "note", "link", "bridge", "index", "graph", "host", "package", "model", "status"]);
    for (const family of REMOVED_0_19_FAMILIES) expect(Object.hasOwn(REMOVED_FAMILY_GUIDANCE, family), family).toBe(true);
  });

  it("names a 0.19 removal and its replacement", () => {
    expect(removedFamilyMessage("host")).toBe("[oms] Command `host` was removed in 0.19. Use `oms setup host install|remove|sync|status`.");
  });

  it("calls an older name retired rather than removed in 0.19", () => {
    expect(removedFamilyMessage("embed")).toBe("[oms] Command `embed` is retired. Use `oms doctor sync-embeddings --mode embed`.");
  });

  it("returns undefined for surviving and unknown commands", () => {
    for (const command of ["search", "write", "interview", "setup", "doctor", "serve", "hook", "nope", "toString", "constructor"]) {
      expect(removedFamilyMessage(command), command).toBeUndefined();
    }
  });

  it("points every guidance line at a surviving family", () => {
    const surviving = new Set(["search", "interview", "write", "setup", "doctor", "serve"]);
    for (const [command, guidance] of Object.entries(REMOVED_FAMILY_GUIDANCE)) {
      const spellings = [...guidance.matchAll(/`oms ([a-z-]+)/gu)].map(match => match[1]!);
      expect(spellings.length, command).toBeGreaterThan(0);
      for (const family of spellings) expect(surviving, `${command} -> ${family}`).toContain(family);
    }
  });
});
