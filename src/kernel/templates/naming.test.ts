import { describe, expect, it } from "vitest";
import { renderNoteName, slugify } from "./naming.js";

describe("renderNoteName", () => {
  it("renders only closed tokens from one prepared literal snapshot", () => {
    expect(renderNoteName({ pattern: "{{date}}-{{slug}}-{{field:kind}}.md", resolvedAt: "2026-08-30T10:11:12.000Z", fields: { title: "안녕, World!", kind: "note" } })).toBe("2026-08-30-안녕-world-note.md");
    expect(slugify("  A / B  ")).toBe("a-b");
  });

  it("reports missing and unsupported tokens", () => {
    expect(() => renderNoteName({ pattern: "{{title}}.md", resolvedAt: "2026-08-30T10:11:12.000Z", fields: {} })).toThrow(/NAMING_TOKEN_MISSING/);
    expect(() => renderNoteName({ pattern: "{{time}}.md", resolvedAt: "2026-08-30T10:11:12.000Z", fields: {} })).toThrow(/NAMING_TOKEN_UNSUPPORTED/);
  });

  it("rejects separator-bearing output rather than turning it into a path", () => {
    expect(() => renderNoteName({ pattern: "{{field:name}}.md", resolvedAt: "2026-08-30T10:11:12.000Z", fields: { name: "../escape" } })).toThrow(/NAMING_CANDIDATE_UNSAFE/);
    expect(() => renderNoteName({ pattern: "notes/{{slug}}.md", resolvedAt: "2026-08-30T10:11:12.000Z", fields: { title: "ok" } })).toThrow(/NAMING_CANDIDATE_UNSAFE/);
  });
});
