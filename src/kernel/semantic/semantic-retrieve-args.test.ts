import { describe, expect, it } from "vitest";
import {
  semanticQueryOptionsFromArgs,
} from "./semantic-retrieve-args.js";

const EXPAND = { kind: "expand", profile: "qmd-v2.8.3", maxQueries: 8 } as const;

describe("semantic strategy argument parsing", () => {
  it("preserves the closed strategy on a direct semantic query", () => {
    expect(semanticQueryOptionsFromArgs("/vault", {
      query: "ataraxia",
      strategy: EXPAND,
      rerank: true,
    })).toMatchObject({
      vault: "/vault",
      query: "ataraxia",
      strategy: EXPAND,
      rerank: true,
    });
  });

  it.each([
    null,
    "expand",
    { kind: "expand", profile: "latest" },
    { kind: "expand", profile: "qmd-v2.8.3", extra: true },
    { kind: "expand", profile: "qmd-v2.8.3", maxQueries: 1.5 },
  ])("rejects malformed strategy %j before the adapter", (strategy) => {
    expect(() => semanticQueryOptionsFromArgs("/vault", { strategy })).toThrow(/strategy/i);
  });
});
