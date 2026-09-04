import { describe, expect, it } from "vitest";
import { parseDerivedProjection, parseTemplatePolicy, serializeDerivedProjection, serializeTemplatePolicy, validateDerivedProjection, validateTemplateId } from "./policy.js";

const digest = `sha256:${"a".repeat(64)}`;
const policy = () => ({
  version: 1, templateFolder: "Templates/OMS", owner: "vault",
  base: { fields: { template: { type: "string", required: true, immutable: true } } },
  contracts: { literature: { intent: "Processed source.", fields: { "source-url": { type: "text", required: true, format: "url", default: { kind: "literal", value: "https://example.test" } } }, views: [{ name: "by-source", keys: ["template", "source-url"], owner: "vault" }] } },
  templates: { literature: { templateId: "literature", destinationClass: "managed-default", sourcePath: "Templates/OMS/literature.md", contract: "literature", naming: "{{date}}-{{slug}}.md" } },
});

describe("template policy", () => {
  it("supports every approved Obsidian type", () => {
    const types = ["text", "string", "select", "number", "boolean", "checkbox", "date", "datetime", "list", "multitext", "multi", "tags", "aliases", "file"];
    const value = {
      ...policy(),
      contracts: {
        literature: {
          intent: "Processed source.",
          fields: Object.fromEntries(types.map(type => [type, { type }])),
          views: [],
        },
      },
    };
    expect(Object.keys(parseTemplatePolicy(value).contracts.literature!.fields)).toEqual(types);
  });

  it("preserves extensions in a stable canonical round trip", () => {
    const parsed = parseTemplatePolicy(policy());
    const serialized = serializeTemplatePolicy(parsed);
    expect(JSON.parse(serialized)).toMatchObject({ extensions: { owner: "vault" }, contracts: { literature: { views: [{ extensions: { owner: "vault" } }] } } });
    expect(serializeTemplatePolicy(parseTemplatePolicy(serialized))).toBe(serialized);
  });

  it("parses and serializes a user-owned writer registry", () => {
    const parsed = parseTemplatePolicy({ ...policy(), writers: { field: "created_by", identifiers: ["oms-agent", "claude"] } });
    const serialized = serializeTemplatePolicy(parsed);
    expect(parsed.writers).toEqual({ field: "created_by", identifiers: ["oms-agent", "claude"] });
    expect(JSON.parse(serialized).writers).toEqual({ field: "created_by", identifiers: ["oms-agent", "claude"] });
    expect(serializeTemplatePolicy(parseTemplatePolicy(serialized))).toBe(serialized);
  });

  it("rejects malformed writer registries", () => {
    expect(() => parseTemplatePolicy({ ...policy(), writers: { field: 1, identifiers: ["oms-agent"] } })).toThrow("TEMPLATE_POLICY_INVALID");
    expect(() => parseTemplatePolicy({ ...policy(), writers: { field: "created_by", identifiers: "oms-agent" } })).toThrow("TEMPLATE_POLICY_INVALID");
    expect(() => parseTemplatePolicy({ ...policy(), writers: { field: "created_by", identifiers: [] } })).toThrow("TEMPLATE_POLICY_INVALID");
    expect(() => parseTemplatePolicy({ ...policy(), writers: { field: "created_by", identifiers: ["oms-agent", "oms-agent"] } })).toThrow("TEMPLATE_POLICY_INVALID");
  });

  it("does not serialize a writer registry when none is configured", () => {
    expect(JSON.parse(serializeTemplatePolicy(parseTemplatePolicy(policy())))).not.toHaveProperty("writers");
  });

  it("validates static and dynamic defaults, types, and URL format", () => {
    expect(() => parseTemplatePolicy({ ...policy(), base: { fields: { ...policy().base.fields, n: { type: "number", default: { kind: "literal", value: "1" } } } } })).toThrow("DEFAULT_TYPE_MISMATCH");
    expect(() => parseTemplatePolicy({ ...policy(), base: { fields: { ...policy().base.fields, url: { type: "text", format: "url", default: { kind: "literal", value: "not-a-url" } } } } })).toThrow("FORMAT_URL_INVALID");
    expect(parseTemplatePolicy({ ...policy(), base: { fields: { ...policy().base.fields, today: { type: "date", default: { kind: "token", token: "today" } } } } }).base.fields.today!.default).toEqual({ kind: "token", token: "today" });
  });

  it("rejects base weakening, dangling views, duplicate IDs and paths, and bad managed destinations", () => {
    const weak = {
      ...policy(),
      contracts: {
        literature: {
          ...policy().contracts.literature,
          fields: { ...policy().contracts.literature.fields, template: { required: false } },
        },
      },
    };
    expect(() => parseTemplatePolicy(weak)).toThrow("BASE_CONTRACT_CONFLICT");
    const widened = {
      ...policy(),
      base: { fields: { ...policy().base.fields, status: { type: "text", allowedValues: ["open"] } } },
      contracts: {
        literature: {
          ...policy().contracts.literature,
          fields: { ...policy().contracts.literature.fields, status: { type: "text", allowedValues: ["open", "closed"] } },
        },
      },
    };
    expect(() => parseTemplatePolicy(widened)).toThrow("BASE_CONTRACT_CONFLICT");
    const dangling = {
      ...policy(),
      contracts: {
        literature: { ...policy().contracts.literature, views: [{ name: "bad", keys: ["missing"] }] },
      },
    };
    expect(() => parseTemplatePolicy(dangling)).toThrow("TEMPLATE_POLICY_DANGLING_FIELD");
    const duplicate = {
      ...policy(),
      templates: {
        ...policy().templates,
        second: {
          ...policy().templates.literature,
          templateId: "second",
          destinationClass: "registered-existing",
          sourcePath: "Templates/OMS/literature.md",
        },
      },
    };
    expect(() => parseTemplatePolicy(duplicate)).toThrow("TEMPLATE_SOURCE_DUPLICATE");
    const badDestination = {
      ...policy(),
      templates: {
        literature: { ...policy().templates.literature, sourcePath: "Elsewhere/literature.md" },
      },
    };
    expect(() => parseTemplatePolicy(badDestination)).toThrow("TEMPLATE_RECLASSIFY_PATH_MISMATCH");
  });

  it("rejects malformed input and reserved extension tampering", () => {
    expect(() => parseTemplatePolicy("{")).toThrow("TEMPLATE_POLICY_INVALID");
    expect(() => parseTemplatePolicy({ ...policy(), extensions: { templates: {} } })).toThrow("TEMPLATE_EXTENSION_RESERVED");
    expect(() => parseTemplatePolicy({
      ...policy(),
      templates: {
        literature: { ...policy().templates.literature, templateId: "other" },
      },
    })).toThrow("templateId must equal its stable map key");
  });

  it("uses one stable-ID grammar for policy map keys and deterministic clones", () => {
    const clone = {
      ...policy(),
      templates: {
        "literature--references": {
          ...policy().templates.literature,
          templateId: "literature--references",
          sourcePath: "Templates/OMS/literature--references.md",
        },
      },
    };
    expect(parseTemplatePolicy(clone).templates["literature--references"]?.templateId).toBe("literature--references");
    expect(validateTemplateId("literature--references")).toBe("literature--references");
    for (const invalid of ["-literature", "literature-", "literature/reference", "literature.reference"]) {
      expect(() => validateTemplateId(invalid)).toThrow("TEMPLATE_SOURCE_INVALID");
    }
  });

  it("preserves folder and link axes in a deterministic projection", () => {
    const projection = {
      version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: digest, sources: [{ logicalId: "template-policy", signature: digest }] },
      managed: { base: { fields: {} }, templates: {}, globalAxes: {
        folders: { kind: "folder", key: "area", type: "select", members: [{ path: "Areas", owner: "vault" }] },
        links: { kind: "link", key: "parent", type: "file", members: ["Projects"] },
      } }, extension: { retained: true },
    };
    const parsed = parseDerivedProjection(projection);
    expect(parsed.managed.globalAxes.folders!.members).toEqual([{ path: "Areas", owner: "vault" }]);
    expect(serializeDerivedProjection(parseDerivedProjection(serializeDerivedProjection(parsed)))).toBe(serializeDerivedProjection(parsed));
  });

  it("distinguishes stable logical sources from vault-relative source paths", () => {
    const projection = {
      version: "oms.types.v1",
      generatedFrom: {
        algorithm: "sha256-lp-v1",
        inputSignature: digest,
        sources: [
          { logicalId: "template-policy", signature: digest },
          { path: "Templates/OMS/literature.md", signature: digest },
        ],
      },
      managed: { base: { fields: {} }, templates: {}, globalAxes: {} },
    };
    expect(parseDerivedProjection(projection).generatedFrom.sources).toHaveLength(2);
    expect(() => parseDerivedProjection({
      ...projection,
      generatedFrom: { ...projection.generatedFrom, sources: [{ logicalId: "template-policy", path: "template-policy", signature: digest }] },
    })).toThrow("PROJECTION_INVALID");
  });

  it("rejects projection managed payload shape tampering and duplicate source paths", () => {
    expect(() => parseDerivedProjection({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: digest, sources: [] }, managed: { base: { fields: {} }, templates: {}, globalAxes: [] } })).toThrow("PROJECTION_INVALID");
    const projection = parseDerivedProjection({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: digest, sources: [] }, managed: { base: { fields: {} }, templates: {}, globalAxes: {} } });
    expect(() => validateDerivedProjection(projection, { ...projection.managed, globalAxes: { changed: { kind: "folder", key: "area", type: "select", members: [] } } })).toThrow("PROJECTION_PAYLOAD_TAMPERED");
  });

  it("detects canonical managed payload tampering independently of source signatures", () => {
    const projection = {
      version: "oms.types.v1",
      generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: digest, sources: [] },
      managed: { base: { fields: {} }, templates: {}, globalAxes: {} },
    };
    const expected = parseDerivedProjection(projection).managed;
    const tampered = { ...projection, managed: { ...projection.managed, base: { fields: { injected: { type: "text" } } } } };
    expect(() => validateDerivedProjection(tampered, expected)).toThrow("PROJECTION_PAYLOAD_TAMPERED");
  });
});
