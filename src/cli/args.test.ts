import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args.js";

describe("CLI argument parser", () => {
  it("keeps public family arguments raw for their handlers", () => {
    for (const [family, args] of [
      ["host", ["install", "--runtime", "hermes", "--vault", "Vault"]],
      ["package", ["update", "--bogus"]],
      ["note", ["audit", "--folder", "references"]],
      ["link", ["check", "--json"]],
      ["setup", ["--vault", "Vault"]],
    ] as const) {
      const parsed = parseCliArgs([family, ...args]);
      expect(parsed.command).toBe(family);
      expect(parsed.help).toBe(false);
      expect(parsed.unknownFlags).toEqual(args);
    }
  });

  it("parses help without retaining it as an unknown family flag", () => {
    for (const args of [["--help"], ["-h"], ["setup", "--help"], ["note", "--help", "--vault", "missing"]]) {
      const parsed = parseCliArgs(args);
      expect(parsed.help).toBe(true);
      expect(parsed.unknownFlags).not.toContain("--help");
      expect(parsed.unknownFlags).not.toContain("-h");
    }
    expect(parseCliArgs(["--help"]).command).toBeUndefined();
  });
});
