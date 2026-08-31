import { describe, expect, it } from "vitest";
import { resolveDefaults, validateBaseSpecialization } from "./defaults.js";

describe("resolveDefaults", () => {
  it("resolves dynamic defaults once, validates, normalizes, and preserves extras", () => {
    const result = resolveDefaults({
      mode: "create",
      resolvedAt: "2026-08-30T10:11:12.000Z",
      fields: {
        title: { type: "text", required: true, normalize: "trim" },
        created: { type: "date", default: { kind: "token", token: "today" } },
        source: { type: "text", format: "url" },
        state: { type: "select", normalize: "lower", allowedValues: ["open"] },
      },
      template: { state: "OPEN" },
      caller: { title: "  Hello  ", source: "https://example.test", extra: 0 },
    });
    expect(result).toEqual({ resolvedAt: "2026-08-30T10:11:12.000Z", fields: { title: "Hello", created: "2026-08-30", source: "https://example.test", state: "open", extra: 0 } });
  });

  it("does not use create defaults for append or update patches", () => {
    const request = { fields: { title: { type: "text" as const, required: true, default: { kind: "literal" as const, value: "template" } } }, template: {} };
    expect(resolveDefaults({ ...request, mode: "create" }).fields.title).toBe("template");
    expect(resolveDefaults({ ...request, mode: "append" }).fields).toEqual({});
    expect(resolveDefaults({ ...request, mode: "update", caller: { extra: "x" } }).fields).toEqual({ extra: "x" });
  });

  it("rejects incompatible defaults and URL values", () => {
    expect(() => resolveDefaults({ mode: "create", fields: { count: { type: "number", default: { kind: "literal", value: "1" } } }, template: {} })).toThrow(/DEFAULT_TYPE_MISMATCH/);
    expect(() => resolveDefaults({ mode: "create", fields: { source: { type: "text", format: "url" } }, template: {}, caller: { source: "file:///tmp/x" } })).toThrow(/FORMAT_URL_INVALID/);
  });

  it("accepts literals for every supported field type", () => {
    const fields = {
      text: { type: "text" as const }, string: { type: "string" as const }, select: { type: "select" as const }, file: { type: "file" as const },
      number: { type: "number" as const }, boolean: { type: "boolean" as const }, checkbox: { type: "checkbox" as const },
      date: { type: "date" as const }, datetime: { type: "datetime" as const },
      list: { type: "list" as const }, multi: { type: "multi" as const }, multitext: { type: "multitext" as const }, tags: { type: "tags" as const }, aliases: { type: "aliases" as const },
    };
    const caller = {
      text: "x", string: "x", select: "x", file: "x", number: 1, boolean: false, checkbox: true,
      date: "2026-08-30", datetime: "2026-08-30T10:11:12.000Z", list: [1], multi: [1], multitext: ["x"], tags: ["x"], aliases: ["x"],
    };
    expect(resolveDefaults({ mode: "create", fields, template: {}, caller }).fields).toEqual(caller);
  });

  it("rejects base invariant weakening", () => {
    expect(() => validateBaseSpecialization({ fields: { template: { type: "text", required: true, immutable: true } } }, { fields: { template: { type: "text", required: false } } })).toThrow(/BASE_CONTRACT_CONFLICT/);
  });
});
