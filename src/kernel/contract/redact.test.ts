import { describe, expect, it } from "vitest";
import { buildRedactor, hiddenValuesOf, publicTokensOf, redactResponse, REDACTED } from "./redact.js";
import type { VaultContract } from "./types.js";

describe("buildRedactor", () => {
  it("replaces raw, quoted, escaped and normalised forms at token boundaries", () => {
    const redact = buildRedactor(["secret-value", "café", 'say "hi"', "it's"]);
    expect(redact("value is secret-value.")).toBe(`value is ${REDACTED}.`);
    expect(redact('{"v":"secret-value"}')).toBe(`{"v":${REDACTED}}`);
    expect(redact("café and caf\\u00e9")).toBe(`${REDACTED} and ${REDACTED}`);
    expect(redact('x: say \\"hi\\"')).toBe(`x: ${REDACTED}`);
    expect(redact("x: 'it''s'")).toBe(`x: ${REDACTED}`);
    expect(redact("SECRET-VALUE")).toBe(REDACTED);
  });

  it("does not redact inside a longer word", () => {
    const redact = buildRedactor(["open"]);
    expect(redact("reopen opener open")).toBe(`reopen opener ${REDACTED}`);
  });

  it("matches NFKC forms of the hidden value", () => {
    const redact = buildRedactor(["ＡＢＣ"]);
    expect(redact("code ABC")).toBe(`code ${REDACTED}`);
  });

  it("skips null, booleans, empty strings and public tokens", () => {
    const redact = buildRedactor([null, true, "", "status", 42], { publicTokens: ["Status"] });
    expect(redact("status true null 42")).toBe(`status true null ${REDACTED}`);
    expect(buildRedactor([])("anything")).toBe("anything");
  });

  it("escapes regex metacharacters in hidden values", () => {
    const redact = buildRedactor(["[A-Z]{3}-\\d+"]);
    expect(redact("pattern [A-Z]{3}-\\d+ here")).toBe(`pattern ${REDACTED} here`);
    expect(redact("ABC-1")).toBe("ABC-1");
  });
});

describe("hiddenValuesOf and publicTokensOf", () => {
  it("collects every rule value and every public word", () => {
    const contract: VaultContract = {
      folders: { Projects: { meaning: "work", searchExclude: false } },
      properties: { s: { meaning: "", type: "text", default: false, required: false, rules: [
        { kind: "allowed", values: ["a", "b"] }, { kind: "fixed", value: "c" }, { kind: "pattern", regex: "d+" }, { kind: "range", min: 1, max: "z" },
      ] } },
      templates: { Meeting: {
        source: "T/Meeting.md", sourceHash: `sha256:${"0".repeat(64)}`, requiredProperties: ["status"],
        narrowedRules: { s: [{ kind: "fixed", value: "e" }] }, requiredHeadings: ["Notes"],
      } },
    };
    expect(hiddenValuesOf(contract)).toEqual(["a", "b", "c", "d+", 1, "z", "e"]);
    expect(publicTokensOf(contract)).toEqual(expect.arrayContaining(["Projects", "s", "status", "Meeting", "Notes", "text", "tags"]));
    expect(publicTokensOf(contract)).not.toContain("T/Meeting.md");
    expect(publicTokensOf(null)).toContain("number");
  });
});

describe("redactResponse", () => {
  it("changes string leaves only and never mutates the input", () => {
    const input = { message: "got secret", nested: [{ value: "secret" }, 3, null, true], secret: "key stays" };
    const output = redactResponse(input, buildRedactor(["secret"]));
    expect(output).toEqual({ message: `got ${REDACTED}`, nested: [{ value: REDACTED }, 3, null, true], secret: `key stays` });
    expect(input.nested[0]).toEqual({ value: "secret" });
  });
});
