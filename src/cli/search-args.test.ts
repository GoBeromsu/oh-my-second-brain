import { describe, expect, it } from "vitest";
import { parseSearchArgs, searchQueryOptions } from "./search-args.js";

describe("search CLI explicit expansion", () => {
  it("keeps an ordinary query lexical-only", () => {
    const options = searchQueryOptions(
      "query",
      "/vault",
      parseSearchArgs([]),
      "exact words",
    );

    expect(options).toMatchObject({
      query: "exact words",
    });
    expect(options.lex).toBeUndefined();
    expect(options.strategy).toBeUndefined();
    expect(options.vec).toBeUndefined();
    expect(options.hyde).toBeUndefined();
  });

  it("maps --expand to the one closed profile without adding an implicit lex channel", () => {
    const options = searchQueryOptions(
      "query",
      "/vault",
      parseSearchArgs(["--expand", "--max-queries", "7"]),
      "what is ataraxia",
    );

    expect(options.strategy).toEqual({
      kind: "expand",
      profile: "qmd-v2.8.3",
      maxQueries: 7,
    });
    expect(options.lex).toBeUndefined();
  });

  it("maps --rerank independently from expansion", () => {
    const plain = searchQueryOptions(
      "query",
      "/vault",
      parseSearchArgs(["--rerank"]),
      "q",
    );
    const expanded = searchQueryOptions(
      "query",
      "/vault",
      parseSearchArgs(["--expand", "--rerank"]),
      "q",
    );

    expect(plain.rerank).toBe(true);
    expect(expanded.rerank).toBe(true);
    expect(expanded.strategy?.kind).toBe("expand");
  });

  it.each([
    ["lex", ["--expand", "--lex", "x"]],
    ["vec", ["--expand", "--vec", "x"]],
    ["hyde", ["--expand", "--hyde", "x"]],
    ["axis", ["--expand", "--folder", "notes"]],
  ] as const)("rejects expansion combined with %s", (_case, argv) => {
    expect(() => searchQueryOptions(
      "query",
      "/vault",
      parseSearchArgs(argv),
      "q",
    )).toThrow(/conflicts/);
  });

  it("rejects --expand outside the canonical search command", () => {
    expect(() => searchQueryOptions(
      "search",
      "/vault",
      parseSearchArgs(["--expand"]),
      "q",
    )).toThrow(/supported only by the "search" command/);
  });

  it.each([
    ["missing", ["--expand", "--max-queries"]],
    ["nonnumeric", ["--expand", "--max-queries", "no"]],
    ["noninteger", ["--expand", "--max-queries", "1.5"]],
    ["zero", ["--expand", "--max-queries", "0"]],
    ["above range", ["--expand", "--max-queries", "33"]],
    ["overflow", ["--expand", "--max-queries", "999999999999999999999999"]],
  ] as const)("rejects a %s --max-queries value", (_case, argv) => {
    expect(() => searchQueryOptions("query", "/vault", parseSearchArgs(argv), "q")).toThrow(
      /max-queries.*integer between 1 and 32/i,
    );
  });

  it.each([
    ["embed", ["embed", "--embed"]],
    ["index sync", ["index", "sync", "--no-embed"]],
  ] as const)("rejects an embedding strategy override on %s", (_case, argv) => {
    expect(() => parseSearchArgs(argv)).toThrow(/pinned embedding strategy/);
  });
});

describe("CLI observed metadata object", () => {
  it("keeps a facet-produced exact selector and rejects noncanonical dates", () => {
    const observed = { field: { when: { exact: { valueType: "date", value: "2026-01-01T00:00:00.000Z" } } } };
    expect(searchQueryOptions("query", "/vault", parseSearchArgs(["--observed", JSON.stringify(observed)]), "")).toMatchObject({ observed });
    expect(() => searchQueryOptions("query", "/vault", parseSearchArgs(["--observed", '{"field":{"when":{"exact":{"valueType":"date","value":"2026-02-31T00:00:00.000Z"}}}}']), "")).toThrow("canonical ISO");
  });
  it("accepts explicit metadata-only discovery without changing declared fields", () => {
    const observed = { field: { subject: { containsAll: ["science", "research"] } }, discover: { limit: 20 } };
    const args = parseSearchArgs(["--observed", JSON.stringify(observed), "--field", "status=open", "--limit", "0"]);
    expect(searchQueryOptions("query", "/vault", args, "")).toMatchObject({ observed, axes: { field: { status: "open" } }, limit: 0 });
  });
  it.each(["", " ", "not json", "null", "{}", '{"discover":{"limit":101}}'])("rejects invalid observed JSON %s", input => {
    expect(() => searchQueryOptions("query", "/vault", parseSearchArgs(["--observed", input]), "")).toThrow();
  });
  it("rejects duplicate observed flags and expansion", () => {
    expect(() => parseSearchArgs(["--observed", '{"discover":{}}', "--observed", '{"discover":{}}'])).toThrow("one JSON object");
    expect(() => searchQueryOptions("query", "/vault", parseSearchArgs(["--observed", '{"discover":{}}', "--expand"]), "science")).toThrow("conflicts");
  });
});
