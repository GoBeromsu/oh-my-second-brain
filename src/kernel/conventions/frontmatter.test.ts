import { describe, expect, it } from "vitest";
import { parseNote } from "./frontmatter.js";

describe("parseNote frontmatter diagnostics", () => {
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
