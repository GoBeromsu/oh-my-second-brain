import { describe, expect, it } from "vitest";
import { parseLegacyJson } from "./legacy-json.js";

const unique = { version: 3, templates: { note: { contract: "base" } }, values: ["{", "\"a\": 1", null, true] };

describe("legacy JSON member accounting", () => {
  it("keeps the JSON.parse value and reports unique members", () => {
    const text = JSON.stringify(unique);
    const parsed = parseLegacyJson(text);
    expect(parsed.members).toBe("unique");
    expect(parsed.value).toEqual(unique);
    expect(parsed.value).not.toBe(unique);
  });

  it("reports a raw duplicate template key without canonicalizing the survivor", () => {
    const text = '{"templates":{"note":{"contract":"base"},"note":{"contract":"other"}}}';
    const parsed = parseLegacyJson(text);
    expect(parsed.members).toBe("duplicate");
    expect(parsed.value).toEqual({ templates: { note: { contract: "other" } } });
  });

  it("reports escaped-equivalent keys that stringify to the same member", () => {
    const text = '{"a\\u002f":1,"a/":2}';
    const parsed = parseLegacyJson(text);
    expect(parsed.members).toBe("duplicate");
    expect(parsed.value).toEqual({ "a/": 2 });
  });

  it("reports a nested property duplicate while leaving arrays and key-looking strings unique", () => {
    expect(parseLegacyJson('{"base":{"fields":{"status":{"type":"text"},"status":{"type":"select"}}}}').members).toBe("duplicate");
    const text = '{"items":[1,{"k":2}],"body":"{ \\"status\\": 1 }","label":"status"}';
    const parsed = parseLegacyJson(text);
    expect(parsed.members).toBe("unique");
    expect(parsed.value).toEqual({ items: [1, { k: 2 }], body: '{ "status": 1 }', label: "status" });
  });

  it("accepts legal JSON spacing without rewriting the parsed value", () => {
    const text = `{\r\n  "version": 3,\r\n  "templates": {}\r\n}`;
    const parsed = parseLegacyJson(text);
    expect(parsed.members).toBe("unique");
    expect(parsed.value).toEqual({ version: 3, templates: {} });
  });

  it("fails closed before YAML inspection for oversized text and deep values", () => {
    const oversized = `{"k":"${"x".repeat(8 * 1024 * 1024)}"}`;
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(8 * 1024 * 1024);
    expect(parseLegacyJson(oversized).members).toBe("uninspectable");
    let deep = "0";
    for (let depth = 0; depth < 65; depth += 1) deep = `[${deep}]`;
    expect(parseLegacyJson(deep).members).toBe("uninspectable");
    expect(parseLegacyJson(deep).value).toEqual(JSON.parse(deep));
  });

  it("rejects YAML that is not JSON and does not treat comments or single quotes as unique", () => {
    expect(() => parseLegacyJson("{version: 3}")).toThrow(/LEGACY_JSON_INVALID/);
    expect(() => parseLegacyJson("{'version': 3}")).toThrow(/LEGACY_JSON_INVALID/);
    expect(() => parseLegacyJson('{"version": 3} # kept')).toThrow(/LEGACY_JSON_INVALID/);
    expect(() => parseLegacyJson('\uFEFF{"version": 3}')).toThrow(/LEGACY_JSON_INVALID/);
    expect(() => parseLegacyJson("")).toThrow(/LEGACY_JSON_INVALID/);
  });

  it("bounds raw duplicate tokens even when JSON.parse retains only one member", () => {
    const text = `{"same":0${',"same":0'.repeat(50_001)}}`;
    const parsed = parseLegacyJson(text);
    expect(parsed.value).toEqual({ same: 0 });
    expect(parsed.members).toBe("uninspectable");
  });
});
