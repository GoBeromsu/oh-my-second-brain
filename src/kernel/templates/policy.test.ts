import { createHash } from "node:crypto";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";
import { TEMPLATE_POLICY_SCHEMA } from "../contracts/index.js";
import { deriveContentFormatContract } from "./content-contract.js";
import { sourceSignature } from "./resolver.js";
import type { Digest } from "./types.js";
import { applyTemplatePolicyChange, normalizeTemplateSemanticChange, parseDerivedProjection, parseTemplatePolicy, serializeDerivedProjection, serializeTemplatePolicy, validateDerivedProjection, validateTemplateId } from "./policy.js";

const digest = `sha256:${"a".repeat(64)}`;
const policy = () => ({
  version: 3, templateFolders: [{ path: "Templates/OMS", default: true }], defaultTemplate: "literature", owner: "vault",
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
        { path: "Templates/Generated", scanner: "vault" },
        { path: "Templates/Curated", default: true },
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

  it("preserves an authored old mode as an inert unknown folder extension", () => {
    const parsed = parseTemplatePolicy({
      ...policy(),
      templateFolders: [{ path: "Templates/OMS", mode: "auto", default: true }],
    });
    expect(parsed.templateFolders[0]).toEqual({
      path: "Templates/OMS",
      default: true,
      extensions: { mode: "auto" },
    });
    const serialized = JSON.parse(serializeTemplatePolicy(parsed)) as { templateFolders: Array<Record<string, unknown>> };
    expect(serialized.templateFolders[0]).toEqual({
      path: "Templates/OMS",
      default: true,
      extensions: { mode: "auto" },
    });
    expect(serializeTemplatePolicy(parseTemplatePolicy(serialized))).toBe(serializeTemplatePolicy(parsed));
  });

  it("accepts a new folder registration without mode", () => {
    const parsed = parseTemplatePolicy({
      ...policy(),
      templateFolders: [{ path: "Templates/New", default: true }],
      templates: {
        literature: {
          ...policy().templates.literature,
          sourceFolder: "Templates/New",
          sourcePath: "Templates/New/literature.md",
        },
      },
    });
    expect(parsed.templateFolders).toEqual([{ path: "Templates/New", default: true }]);
  });

  it("parses and preserves an approved binding content contract", () => {
    const content = deriveContentFormatContract("# Literature\n<!-- oms:content -->").contract;
    const parsed = parseTemplatePolicy({
      ...policy(),
      templates: { literature: { ...policy().templates.literature, content } },
    });
    expect(parsed.templates.literature?.content).toEqual(content);
    expect(JSON.parse(serializeTemplatePolicy(parsed)).templates.literature.content).toEqual(content);
  });

  it("allows an omitted default template and rejects a dangling default template", () => {
    const { defaultTemplate: _defaultTemplate, ...withoutDefaultTemplate } = policy();
    expect(parseTemplatePolicy(withoutDefaultTemplate).defaultTemplate).toBeUndefined();
    expect(() => parseTemplatePolicy({ ...policy(), defaultTemplate: "missing" })).toThrow("TEMPLATE_POLICY_INVALID");
  });

  it("allows no folder default but rejects duplicate, unsafe, and multiple-default registrations", () => {
    expect(parseTemplatePolicy({ ...policy(), templateFolders: [{ path: "Templates/OMS" }] }).templateFolders[0]?.default).toBeUndefined();
    expect(() => parseTemplatePolicy({ ...policy(), templateFolders: [{ path: "Templates" }, { path: "Templates/./" }] })).toThrow("TEMPLATE_SOURCE_DUPLICATE");
    expect(() => parseTemplatePolicy({ ...policy(), templateFolders: [{ path: "../Templates" }] })).toThrow("TEMPLATE_SOURCE_UNSAFE");
    expect(() => parseTemplatePolicy({ ...policy(), templateFolders: [{ path: "One", default: true }, { path: "Two", default: true }] })).toThrow("TEMPLATE_POLICY_INVALID");
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

    const unicode = {
      ...policy(),
      defaultTemplate: "한글-노트",
      templates: {
        "한글-노트": {
          ...policy().templates.literature,
          templateId: "한글-노트",
          sourcePath: "Templates/OMS/한글-노트.md",
        },
      },
    };
    expect(validate(unicode).valid).toBe(true);
    expect(parserAccepts(unicode)).toBe(true);
    expect(validate({ ...policy(), templateFolders: [{ path: "Templates/New" }] }).valid).toBe(true);

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
    expect(parseTemplatePolicy({
      ...policy(),
      defaultTemplate: "한글-노트",
      templates: {
        "한글-노트": {
          ...policy().templates.literature,
          templateId: "한글-노트",
          sourcePath: "Templates/OMS/한글-노트.md",
        },
      },
    }).defaultTemplate).toBe("한글-노트");
    for (const invalid of ["-literature", "literature-", "literature/reference", "literature.reference"]) {
      expect(() => validateTemplateId(invalid)).toThrow("TEMPLATE_SOURCE_INVALID");
    }
  });

  it("canonicalizes equivalent template keys, binding IDs, and default references", () => {
    const nfd = "cafe\u0301-note";
    const nfc = nfd.normalize("NFC");
    const parsed = parseTemplatePolicy({
      ...policy(),
      defaultTemplate: nfd,
      templates: {
        [nfd]: {
          ...policy().templates.literature,
          templateId: nfd,
          sourcePath: `Templates/OMS/${nfc}.md`,
        },
      },
    });
    expect(Object.keys(parsed.templates)).toEqual([nfc]);
    expect(parsed.templates[nfc]?.templateId).toBe(nfc);
    expect(parsed.defaultTemplate).toBe(nfc);
  });

  it("rejects canonically equivalent template map keys", () => {
    const nfd = "cafe\u0301-note";
    const nfc = nfd.normalize("NFC");
    expect(() => parseTemplatePolicy({
      ...policy(),
      templates: {
        [nfd]: {
          ...policy().templates.literature,
          templateId: nfd,
          sourcePath: `Templates/OMS/${nfd}.md`,
        },
        [nfc]: {
          ...policy().templates.literature,
          templateId: nfc,
          sourcePath: `Templates/OMS/${nfc}-other.md`,
        },
      },
    })).toThrow("TEMPLATE_ID_DUPLICATE");
  });

  it("preserves omitted update metadata and strictly validates supplied content and source stamps", () => {
    const content = deriveContentFormatContract("# First\n# Second\n").contract;
    const current = parseTemplatePolicy({
      ...policy(),
      templates: {
        literature: {
          ...policy().templates.literature,
          content,
          approvedSourceSignature: digest,
          approvedBodySignature: digest,
          extensions: { owner: "vault", retained: true },
        },
      },
    });
    const existing = current.templates.literature!;
    const updated = applyTemplatePolicyChange(current, {
      mode: "update",
      templateId: existing.templateId,
      binding: {
        ...existing,
        naming: "{{title}}",
        content: undefined,
        extensions: undefined,
        approvedSourceSignature: undefined,
        approvedBodySignature: undefined,
      },
      source: { path: existing.sourcePath, bytes: new TextEncoder().encode("# First\n# Second\n"), publication: "verify-existing" },
    });
    expect(updated.templates.literature).toMatchObject({
      templateId: existing.templateId,
      destinationClass: existing.destinationClass,
      renderer: existing.renderer,
      sourceFolder: existing.sourceFolder,
      sourcePath: existing.sourcePath,
      contract: existing.contract,
      content,
      approvedSourceSignature: digest,
      approvedBodySignature: digest,
      extensions: { owner: "vault", retained: true },
      naming: "{{title}}",
    });
    expect(JSON.parse(serializeTemplatePolicy(updated)).templates.literature).toMatchObject({
      approvedSourceSignature: digest,
      approvedBodySignature: digest,
      extensions: { owner: "vault", retained: true },
    });
    expect(() => applyTemplatePolicyChange(current, {
      mode: "update",
      templateId: existing.templateId,
      binding: { ...existing, content: {} as never },
      source: { path: existing.sourcePath, bytes: new Uint8Array(), publication: "verify-existing" },
    })).toThrow("CONTENT_CONTRACT_INVALID");
    expect(() => applyTemplatePolicyChange(current, {
      mode: "update",
      templateId: existing.templateId,
      binding: { ...existing, approvedSourceSignature: "sha256:not-a-digest" as Digest },
      source: { path: existing.sourcePath, bytes: new Uint8Array(), publication: "verify-existing" },
    })).toThrow("TEMPLATE_POLICY_INVALID");
    expect(() => applyTemplatePolicyChange(current, {
      mode: "update",
      templateId: existing.templateId,
      binding: { ...existing, approvedBodySignature: "sha256:not-a-digest" as Digest },
      source: { path: existing.sourcePath, bytes: new Uint8Array(), publication: "verify-existing" },
    })).toThrow("TEMPLATE_POLICY_INVALID");
  });

  it("normalizes every identity-bearing mutation mode without rewriting nonidentity values", () => {
    const id = "메모";
    const nfd = id.normalize("NFD") as typeof id;
    const sourceBytes = new Uint8Array([0, 1, 2]);
    const binding = {
      ...policy().templates.literature,
      templateId: nfd,
      naming: "  authored naming  ",
    };
    const create = normalizeTemplateSemanticChange({
      mode: "create",
      binding,
      source: { path: "Templates/OMS/메모.md", bytes: sourceBytes, publication: "write" },
    });
    expect(create.mode).toBe("create");
    if (create.mode !== "create") throw new Error("expected create");
    expect(create.binding.templateId).toBe(id);
    expect(create.binding.naming).toBe(binding.naming);
    expect(create.source.bytes).toBe(sourceBytes);
    const update = normalizeTemplateSemanticChange({
      mode: "update",
      templateId: nfd,
      binding,
      source: { path: "Templates/OMS/메모.md", bytes: sourceBytes, publication: "write" },
    });
    expect(update.mode).toBe("update");
    if (update.mode !== "update") throw new Error("expected update");
    expect(update.templateId).toBe(id);
    expect(update.binding.templateId).toBe(id);
    for (const mode of ["reclassify", "remove", "default"] as const) {
      const normalized = normalizeTemplateSemanticChange(mode === "reclassify"
        ? { mode, templateId: nfd, toClass: "registered-existing" as const }
        : mode === "remove"
          ? { mode, templateId: nfd, deleteSource: false }
          : { mode, templateId: nfd });
      expect(normalized.templateId).toBe(id);
    }
  });

  it("preserves folder and link axes in a deterministic projection", () => {
    const projection = {
      version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: digest, sharedAuthoritySignature: digest, sources: [{ logicalId: "template-policy", signature: digest }] },
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
        sharedAuthoritySignature: digest,
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
    const projection = parseDerivedProjection({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: digest, sharedAuthoritySignature: digest, sources: [] }, managed: { base: { fields: {} }, templates: {}, globalAxes: {} } });
    expect(() => validateDerivedProjection(projection, { ...projection.managed, globalAxes: { changed: { kind: "folder", key: "area", type: "select", members: [] } } })).toThrow("PROJECTION_PAYLOAD_TAMPERED");
  });

  it("rejects a projection that omits the required shared authority signature", () => {
    expect(() => parseDerivedProjection({
      version: "oms.types.v1",
      generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: digest, sources: [] },
      managed: { base: { fields: {} }, templates: {}, globalAxes: {} },
    })).toThrow("PROJECTION_INVALID");
  });

  it("requires content on every derived template while allowing unapproved policy bindings", () => {
    const content = deriveContentFormatContract("Body\n", { templateId: "note" }).contract;
    const template = {
      templateId: "note",
      destinationClass: "registered-existing",
      renderer: "obsidian-core",
      sourcePath: "Templates/note.md",
      keyOrder: ["title"],
      fields: { title: { type: "text" } },
      views: [],
      naming: "{{title}}",
      bodySignature: content.bodySignature,
      content,
    };
    const projection = {
      version: "oms.types.v1",
      generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: digest, sharedAuthoritySignature: digest, sources: [] },
      managed: { base: { fields: {} }, templates: { note: template }, globalAxes: {} },
    };
    expect(parseDerivedProjection(projection).managed.templates.note?.content).toEqual(content);
    const { content: _content, ...withoutContent } = template;
    expect(() => parseDerivedProjection({
      ...projection,
      managed: { ...projection.managed, templates: { note: withoutContent } },
    })).toThrow("CONTENT_CONTRACT_INVALID");
  });

  it("detects canonical managed payload tampering independently of source signatures", () => {
    const projection = {
      version: "oms.types.v1",
      generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: digest, sharedAuthoritySignature: digest, sources: [] },
      managed: { base: { fields: {} }, templates: {}, globalAxes: {} },
    };
    const expected = parseDerivedProjection(projection).managed;
    const tampered = { ...projection, managed: { ...projection.managed, base: { fields: { injected: { type: "text" } } } } };
    expect(() => validateDerivedProjection(tampered, expected)).toThrow("PROJECTION_PAYLOAD_TAMPERED");
  });
});
