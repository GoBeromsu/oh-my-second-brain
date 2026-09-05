import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseTemplate, TemplateExpressionError } from "./extract.js";

describe("parseTemplate", () => {
  it("preserves note shape and recognizes quoted and bare narrow expressions", () => {
    const bytes = Buffer.from("\ufeff---\r\ntitle: {{title}}\r\ncreated: '{{date}}'\r\ntime: {{time}}\r\n---\r\n# {{title}}\r\n<!-- oms:content -->\r\n", "utf8");
    const template = parseTemplate("Templates/OMS/note.md", bytes);
    expect(template).toMatchObject({ bom: true, eol: "crlf", finalNewline: true, keyOrder: ["title", "created", "time"], contentMarker: true });
    expect(template.frontmatter).toMatchObject({ title: "{{title}}", created: "{{date}}", time: "{{time}}" });
    expect(template.body).toBe("# {{title}}\r\n<!-- oms:content -->\r\n");
    expect(template.expressions.title).toEqual({ kind: "title" });
    expect(template.expressions.created).toEqual({ kind: "date" });
    expect(template.expressions.time).toEqual({ kind: "time" });
  });

  it("rejects bare arbitrary expressions with source and field diagnostics", () => {
    expect(() => parseTemplate("Templates/OMS/note.md", Buffer.from("---\ntitle: {{tp.system.run()}}\n---\n"))).toThrow(/TEMPLATE_EXPRESSION_UNSUPPORTED.*Templates\/OMS\/note.md:title.*\{\{tp\.system\.run\(\)\}\}/);
    expect(() => parseTemplate("Templates/OMS/note.md", Buffer.from("---\nmetadata:\n  nested:\n    - '{{tp.system.run()}}'\n---\n"))).toThrow(/TEMPLATE_EXPRESSION_UNSUPPORTED.*metadata\.nested\[0\]/);
  });

  it("rejects arbitrary body expressions and multiple content markers", () => {
    expect(() => parseTemplate("Templates/OMS/note.md", Buffer.from("---\ntitle: literal\n---\n{{tp.system.run()}}\n<!-- oms:content -->\n"))).toThrow(/TEMPLATE_EXPRESSION_UNSUPPORTED.*body/);
    expect(() => parseTemplate("Templates/OMS/note.md", Buffer.from("---\ntitle: literal\n---\n<!-- oms:content -->\n<!-- oms:content -->\n"))).toThrow(/multiple oms content markers/);
  });

  it("accepts formatted date and time tags in frontmatter and body without changing the byte digest", () => {
    const bytes = Buffer.from("---\ncreated: {{date:YYYY/MM/DD}}\nclock: '{{time:h:mm A}}'\n---\n# {{title}}\n{{date:YY-M-D}}T{{time:HH:mm:ss}}\n");
    const template = parseTemplate("Templates/OMS/note.md", bytes);
    expect(template.expressions.created).toEqual({ kind: "date", format: "YYYY/MM/DD" });
    expect(template.expressions.clock).toEqual({ kind: "time", format: "h:mm A" });
    expect(template.body).toContain("{{date:YY-M-D}}T{{time:HH:mm:ss}}");
    expect(template.sourceDigest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  });

  it("rejects unsupported format tokens and Templater syntax with precise context", () => {
    for (const token of ["{{date:YYYY[year]}}", "{{time:mm_S}}"]) {
      try {
        parseTemplate("Templates/OMS/note.md", Buffer.from(`---\ncreated: '${token}'\n---\n`));
        throw new Error("expected expression rejection");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(TemplateExpressionError);
        expect(error).toMatchObject({ sourcePath: "Templates/OMS/note.md", location: "created", rawToken: token });
      }
    }
    expect(() => parseTemplate("Templates/OMS/note.md", Buffer.from("---\ntitle: literal\n---\n<% tp.date.now() %>\n")))
      .toThrow(/TEMPLATE_EXPRESSION_UNSUPPORTED.*body.*<% tp\.date\.now\(\) %>/);
    expect(() => parseTemplate("Templates/OMS/note.md", Buffer.from("---\ntitle: literal\n---\nunmatched %>\n")))
      .toThrow(/TEMPLATE_EXPRESSION_UNSUPPORTED.*body.*%>/);
    expect(() => parseTemplate("Templates/OMS/note.md", Buffer.from("---\ntitle: '<% tp.file.title %>'\n---\n")))
      .toThrow(/TEMPLATE_EXPRESSION_UNSUPPORTED.*title/);
  });
});
