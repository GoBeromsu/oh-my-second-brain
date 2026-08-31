import { describe, expect, it } from "vitest";
import { parseSemanticArgs, semanticQueryOptions } from "./semantic-args.js";

describe("semantic CLI explicit expansion", () => {
  it("keeps an ordinary query lexical-only", () => {
    const options = semanticQueryOptions(
      "query",
      "/vault",
      parseSemanticArgs([]),
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
    const options = semanticQueryOptions(
      "query",
      "/vault",
      parseSemanticArgs(["--expand", "--max-queries", "7"]),
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
    const plain = semanticQueryOptions(
      "query",
      "/vault",
      parseSemanticArgs(["--rerank"]),
      "q",
    );
    const expanded = semanticQueryOptions(
      "query",
      "/vault",
      parseSemanticArgs(["--expand", "--rerank"]),
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
    expect(() => semanticQueryOptions(
      "query",
      "/vault",
      parseSemanticArgs(argv),
      "q",
    )).toThrow(/conflicts/);
  });

  it("rejects --expand on search or vsearch commands", () => {
    for (const mode of ["search", "vsearch"] as const) {
      expect(() => semanticQueryOptions(
        mode,
        "/vault",
        parseSemanticArgs(["--expand"]),
        "q",
      )).toThrow(/supported only by the "query" command/);
    }
  });
});
