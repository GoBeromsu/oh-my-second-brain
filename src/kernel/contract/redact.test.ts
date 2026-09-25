import { describe, expect, it } from "vitest";
import { buildRedactor, hiddenValuesOf, publicTokensOf, redactResponse, rejectionMessage, REDACTED } from "./redact.js";
import type { PublicManifest, SealedLayer, ViolationKind } from "./types.js";

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
    const layer: SealedLayer = {
      sealId: "00000000-0000-4000-8000-000000000001",
      fields: [{ name: "s", type: "text", required: false, description: "", variable: null, rules: [
        { kind: "allowed", values: ["a", "b"] }, { kind: "fixed", value: "c" }, { kind: "pattern", regex: "d+" }, { kind: "range", min: 1, max: "z" },
      ] }],
      requiredHeadings: [], applyFolder: null, sourcePath: null, sourceHash: null, answers: {},
    };
    expect(hiddenValuesOf([layer])).toEqual(["a", "b", "c", "d+", 1, "z"]);
    const manifest: PublicManifest = {
      version: 1,
      common: { sealId: "00000000-0000-4000-8000-000000000002", fields: [{ name: "status", type: "text", required: true, description: "" }] },
      templates: [{ id: "T/Meeting.md", name: "Meeting", applyFolder: null, fields: [], requiredHeadings: ["Notes"], sourceHash: `sha256:${"0".repeat(64)}`, sealId: "00000000-0000-4000-8000-000000000003" }],
    };
    expect(publicTokensOf(manifest)).toEqual(expect.arrayContaining(["status", "T/Meeting.md", "Meeting", "Notes", "text", "tags"]));
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

describe("rejectionMessage", () => {
  it("uses fixed wording with the field name only", () => {
    const kinds: ViolationKind[] = [
      "yaml-syntax", "path-unsafe", "path-required", "outside-vault", "outside-apply-folder", "required", "type", "not-allowed", "not-fixed",
      "pattern", "range", "unsubstituted-variable", "heading-missing", "contract-unreadable", "template-unknown", "template-ambiguous", "exists",
    ];
    for (const kind of kinds) {
      const text = rejectionMessage({ field: "status", kind });
      expect(text.length).toBeGreaterThan(0);
    }
    expect(rejectionMessage({ field: "status", kind: "not-allowed" })).toBe("Field 'status' is not one of the defined values.");
    expect(rejectionMessage({ field: null, kind: "unsubstituted-variable" })).toBe("The body still contains a template variable.");
  });
});
