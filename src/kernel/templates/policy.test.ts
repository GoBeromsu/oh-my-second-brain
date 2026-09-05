import { createHash } from "node:crypto";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";
import { TEMPLATE_POLICY_SCHEMA } from "../contracts/index.js";
import { sourceSignature } from "./resolver.js";
import type { Digest } from "./types.js";
import { applyTemplatePolicyChange, parseDerivedProjection, parseTemplatePolicy, serializeDerivedProjection, serializeTemplatePolicy, validateDerivedProjection, validateTemplateId } from "./policy.js";

const digest = `sha256:${"a".repeat(64)}`;
const policy = () => ({
  version: 3, templateFolders: [{ path: "Templates/OMS", mode: "auto", default: true }], defaultTemplate: "literature", owner: "vault",
  base: { fields: { template: { type: "string", required: true, immutable: true } } },
  contracts: { literature: { intent: "Processed source.", fields: { "source-url": { type: "text", required: true, format: "url", default: { kind: "literal", value: "https://example.test" } } }, views: [{ name: "by-source", keys: ["template", "source-url"], owner: "vault" }] } },
  templates: { literature: { templateId: "literature", destinationClass: "managed-default", sourceFolder: "Templates/OMS", sourcePath: "Templates/OMS/literature.md", contract: "literature", naming: "{{date}}-{{slug}}.md" } },
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

  it("keeps folder and template defaults distinct and preserves folder extensions", () => {
    const parsed = parseTemplatePolicy({
      ...policy(),
      templateFolders: [
        { path: "Templates/Generated", mode: "auto", scanner: "vault" },
        { path: "Templates/Curated", mode: "manual", default: true },
      ],
      templates: {
        literature: {
          ...policy().templates.literature,
          sourceFolder: "Templates/Generated",
          sourcePath: "Templates/Generated/literature.md",
        },
      },
    });
    expect(parsed.templateFolders[0]?.extensions).toEqual({ scanner: "vault" });
    expect(parsed.templateFolders[1]?.default).toBe(true);
    expect(parsed.defaultTemplate).toBe("literature");
  });

  it("allows an omitted default template and rejects a dangling default template", () => {
    const { defaultTemplate: _defaultTemplate, ...withoutDefaultTemplate } = policy();
    expect(parseTemplatePolicy(withoutDefaultTemplate).defaultTemplate).toBeUndefined();
    expect(() => parseTemplatePolicy({ ...policy(), defaultTemplate: "missing" })).toThrow("TEMPLATE_POLICY_INVALID");
  });

  it("allows no folder default but rejects duplicate, unsafe, and multiple-default registrations", () => {
    expect(parseTemplatePolicy({ ...policy(), templateFolders: [{ path: "Templates/OMS", mode: "manual" }] }).templateFolders[0]?.default).toBeUndefined();
    expect(() => parseTemplatePolicy({ ...policy(), templateFolders: [{ path: "Templates", mode: "auto" }, { path: "Templates/./", mode: "manual" }] })).toThrow("TEMPLATE_SOURCE_DUPLICATE");
    expect(() => parseTemplatePolicy({ ...policy(), templateFolders: [{ path: "../Templates", mode: "auto" }] })).toThrow("TEMPLATE_SOURCE_UNSAFE");
    expect(() => parseTemplatePolicy({ ...policy(), templateFolders: [{ path: "One", mode: "auto", default: true }, { path: "Two", mode: "manual", default: true }] })).toThrow("TEMPLATE_POLICY_INVALID");
  });

  it("regenerates a default-less multi-folder policy without changing bindings or folders", () => {
    const current = parseTemplatePolicy({
      ...policy(),
      defaultTemplate: undefined,
      templateFolders: [
        { path: "Templates/Generated", mode: "auto" },
        { path: "Templates/Curated", mode: "manual" },
      ],
      templates: {
        literature: {
          ...policy().templates.literature,
          sourceFolder: "Templates/Generated",
          sourcePath: "Templates/Generated/literature.md",
        },
        curated: {
          ...policy().templates.literature,
          templateId: "curated",
          destinationClass: "registered-existing",
          sourceFolder: "Templates/Curated",
          sourcePath: "Templates/Curated/custom.md",
        },
      },
    });
    const regenerated = applyTemplatePolicyChange(current, { mode: "regenerate" });
    expect(regenerated.templateFolders).toEqual(current.templateFolders);
    expect(regenerated.templates).toEqual(current.templates);
    expect(regenerated.defaultTemplate).toBeUndefined();
  });

  it("requires each binding source folder to be registered and contain its source", () => {
    expect(() => parseTemplatePolicy({
      ...policy(),
      templates: { literature: { ...policy().templates.literature, sourceFolder: "Unregistered", sourcePath: "Unregistered/literature.md" } },
    })).toThrow("TEMPLATE_SOURCE_INVALID");
    expect(() => parseTemplatePolicy({
      ...policy(),
      templates: { literature: { ...policy().templates.literature, sourcePath: "Other/literature.md" } },
    })).toThrow("TEMPLATE_SOURCE_INVALID");
  });

  it("parses and serializes a v3 user-owned writer registry with preserved extensions", () => {
    const parsed = parseTemplatePolicy({ ...policy(), writers: { field: "created_by", identifiers: ["oms-agent", "claude"], owner: "vault" } });
    const serialized = serializeTemplatePolicy(parsed);
    expect(parsed.writers).toEqual({ field: "created_by", identifiers: ["oms-agent", "claude"], extensions: { owner: "vault" } });
    expect(JSON.parse(serialized).writers).toEqual({ field: "created_by", identifiers: ["oms-agent", "claude"], extensions: { owner: "vault" } });
    expect(serializeTemplatePolicy(parseTemplatePolicy(serialized))).toBe(serialized);
  });

  it("rejects malformed writer registries", () => {
    expect(() => parseTemplatePolicy({ ...policy(), writers: { field: 1, identifiers: ["oms-agent"] } })).toThrow("TEMPLATE_POLICY_INVALID");
    expect(() => parseTemplatePolicy({ ...policy(), writers: { field: "created_by", identifiers: "oms-agent" } })).toThrow("TEMPLATE_POLICY_INVALID");
    expect(() => parseTemplatePolicy({ ...policy(), writers: { field: "created_by", identifiers: [] } })).toThrow("TEMPLATE_POLICY_INVALID");
    expect(() => parseTemplatePolicy({ ...policy(), writers: { field: "created_by", identifiers: ["oms-agent", "oms-agent"] } })).toThrow("TEMPLATE_POLICY_INVALID");
  });

  it("rejects unsupported policies and the legacy singular folder key without interpreting either", () => {
    expect(() => parseTemplatePolicy({ ...policy(), version: 2 })).toThrow("TEMPLATE_POLICY_VERSION_UNSUPPORTED");
    expect(() => parseTemplatePolicy({ ...policy(), templateFolder: "Legacy" })).toThrow("TEMPLATE_POLICY_VERSION_UNSUPPORTED");
  });

  it("keeps the exported schema aligned with v3 writer-registry parsing", () => {
    const validate = new AjvJsonSchemaValidator().getValidator(TEMPLATE_POLICY_SCHEMA);
    const parserAccepts = (input: unknown): boolean => {
      try {
        parseTemplatePolicy(input);
        return true;
      } catch {
        return false;
      }
    };

    const managed = { ...policy(), writers: { field: "created_by", identifiers: ["oms-agent"] } };
    expect(validate(managed).valid).toBe(true);
    expect(parserAccepts(managed)).toBe(true);

    for (const malformed of [
      { field: "created_by", identifiers: [] },
      { field: " ", identifiers: ["oms-agent"] },
    ]) {
      const invalid = { ...policy(), writers: malformed };
      expect(validate(invalid).valid).toBe(false);
      expect(parserAccepts(invalid)).toBe(false);
    }
  });

  it("retains canonical v3 bytes when no writer registry is configured", () => {
    const canonicalV3 = `{
  "base": {
    "fields": {}
  },
  "contracts": {},
  "extensions": {
    "owner": "vault"
  },
  "templateFolders": [],
  "templates": {},
  "version": 3
}
`;

    const serialized = serializeTemplatePolicy(parseTemplatePolicy(canonicalV3));
    expect(serialized).toBe(canonicalV3);
    const policyDigest = `sha256:${createHash("sha256").update(serialized).digest("hex")}` as Digest;
    expect(sourceSignature([{ logicalId: "template-policy", signature: policyDigest }])).toMatch(/^sha256:[0-9a-f]{64}$/);
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
        literature: { ...policy().templates.literature, sourcePath: "Templates/OMS/not-literature.md" },
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
      defaultTemplate: "literature--references",
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
