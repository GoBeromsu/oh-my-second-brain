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

describe("explicit observed metadata arguments", () => {
  it("preserves predicates and discovery separately from declared axes", () => {
    const observed = { field: { subject: ["science"], created: { between: ["2026-01-01", "2026-02-01"] } }, discover: { key: "subject", limit: 5, cursor: "next" } };
    expect(semanticQueryOptionsFromArgs("/vault", { observed, limit: 0, axes: { field: { status: "open" } } })).toMatchObject({ observed, limit: 0, axes: { field: { status: "open" } } });
    expect(semanticQueryOptionsFromArgs("/vault", { query: "plain" })).not.toHaveProperty("observed");
  });

  it.each([null, [], {}, { nope: true }, { discover: null }, { discover: [] }, { discover: { limit: 0 } }, { discover: { limit: 101 } }, { discover: { key: " " } }, { discover: { key: "한".repeat(171) } }, { discover: { cursor: "" } }, { discover: { cursor: "x".repeat(8193) } }, { discover: { all: true } }, { field: null }, { field: { score: { nonsense: 1 } } }])("rejects malformed observed request %j", observed => {
    expect(() => semanticQueryOptionsFromArgs("/vault", { observed })).toThrow();
  });
});
