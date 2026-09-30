import { describe, expect, it } from "vitest";
import { parseNote } from "./frontmatter.js";

describe("parseNote frontmatter diagnostics", () => {
  it("retains the body when an unresolved YAML alias fails during conversion", () => {
    const parsed = parseNote("---\nvalue: *missing\n---\nSearchable body.\n");
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe("Searchable body.\n");
    expect(parsed.frontmatterRaw).toBe("value: *missing");
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({ code: "frontmatter-yaml-parse-error", message: expect.stringContaining("alias") }),
    ]);
  });

  it("parses BOM-prefixed CRLF frontmatter with byte-accurate range", () => {
    const parsed = parseNote("\ufeff---\r\ntemplate: note\r\n---\r\nBody\r\n");
    expect(parsed.frontmatter).toEqual({ template: "note" });
    expect(parsed.body).toBe("Body\r\n");
    expect(parsed.frontmatterRange).toEqual({ start: 6, end: 20 });
  });

  it("does not treat a markdown line that only starts with dashes as frontmatter", () => {
    const raw = "---not frontmatter\nBody stays readable.\n";

    const parsed = parseNote(raw);

    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe(raw);
    expect(parsed.diagnostics).toEqual([]);
  });

  it("returns diagnostics instead of throwing when YAML frontmatter is malformed", () => {
    const raw = "---\ntitle: [broken\n---\nBody stays readable.\n";

    const parsed = parseNote(raw);

    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe("Body stays readable.\n");
    expect(parsed.frontmatterRaw).toBe("title: [broken");
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({
        code: "frontmatter-yaml-parse-error",
      }),
    ]);
  });

  it("reads an empty or comment-only block as empty frontmatter, not a malformed one", () => {
    expect(parseNote("---\n---\nBody\n")).toEqual({ frontmatter: {}, body: "Body\n", hasFrontmatter: true, diagnostics: [], frontmatterRaw: "", frontmatterRange: { start: 4, end: 4 } });
    expect(parseNote("\ufeff---\r\n---")).toMatchObject({ frontmatter: {}, body: "", diagnostics: [], frontmatterRange: { start: 6, end: 6 } });
    expect(parseNote("---\n# a comment\n---\nBody\n")).toEqual({ frontmatter: {}, body: "Body\n", hasFrontmatter: true, diagnostics: [], frontmatterRaw: "# a comment", frontmatterRange: { start: 4, end: 15 } });
    expect(parseNote("---\n~\n---\nBody\n").diagnostics).toEqual([expect.objectContaining({ code: "frontmatter-not-map" })]);
  });

  it("closes an empty block at the first fence, so a later fenced block is body text", () => {
    // Obsidian reads the same text this way: the first `---` pair is the (empty) frontmatter.
    expect(parseNote("---\n---\nk: v\n---\nbody")).toEqual({ frontmatter: {}, body: "k: v\n---\nbody", hasFrontmatter: true, diagnostics: [], frontmatterRaw: "", frontmatterRange: { start: 4, end: 4 } });
  });

  it("reports an unclosed frontmatter fence without treating the body as valid YAML", () => {
    const raw = "---\ntitle: Missing close\nBody is not a fence.\n";

    const parsed = parseNote(raw);

    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe("");
    expect(parsed.frontmatterRaw).toBe("title: Missing close\nBody is not a fence.\n");
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({
        code: "frontmatter-unclosed-fence",
      }),
    ]);
  });
});
