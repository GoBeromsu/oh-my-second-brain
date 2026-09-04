import { describe, expect, it } from "vitest";
import { frameHash, inputDigest, templateInput } from "./canonical.js";
import type { Digest, InputV2, TemplatePolicy } from "./types.js";

const minimal: InputV2 = { authority: [], placement: [], version: 2 };

describe("InputV2 canonical identity", () => {
  it("pins the approved minimal frame bytes and digest", () => {
    expect(Buffer.from(frameHash("oms.template-migration.input.v2", minimal)).toString("hex")).toBe(
      "6f6d732d686173682d6672616d652d7631003331006f6d732e74656d706c6174652d6d6967726174696f6e2e696e7075742e76323433007b22617574686f72697479223a5b5d2c22706c6163656d656e74223a5b5d2c2276657273696f6e223a327d",
    );
    expect(inputDigest(minimal)).toBe("sha256:0128ccd458153516abd0e9d49f6210a3034b71e73e0750eb652807294ab13642");
  });

  it("preserves the resolver and doctor authority digest assembly", () => {
    const policy: TemplatePolicy = {
      version: 1,
      templateFolder: "Templates/OMS" as TemplatePolicy["templateFolder"],
      base: { fields: {} },
      contracts: {},
      templates: {
        zebra: { templateId: "zebra", destinationClass: "registered-existing", sourcePath: "Templates/zebra.md" as TemplatePolicy["templates"][string]["sourcePath"], contract: "zebra", naming: "{{title}}" },
        alpha: { templateId: "alpha", destinationClass: "managed-default", sourcePath: "Templates/OMS/alpha.md" as TemplatePolicy["templates"][string]["sourcePath"], contract: "alpha", naming: "{{title}}" },
      },
    };
    const bindings = Object.values(policy.templates);
    const sourceDigests = new Map<string, Digest>([
      ["zebra", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      ["alpha", "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    ]);
    const sourceDigest = (templateId: string): Digest => {
      const value = sourceDigests.get(templateId);
      if (value === undefined) throw new Error(`missing digest for ${templateId}`);
      return value;
    };
    const legacy: InputV2 = {
      version: 2,
      authority: [
        { kind: "policy", logicalId: "template-policy", vaultRelativePath: ".oms/template-policy.json", contentDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" },
        { kind: "taxonomy", logicalId: "taxonomy", vaultRelativePath: ".oms/taxonomy.json", contentDigest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" },
        { kind: "obsidian-types", logicalId: "obsidian-types", vaultRelativePath: ".obsidian/types.json", contentDigest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
        ...bindings.map((binding) => ({ kind: "template" as const, logicalId: binding.templateId, vaultRelativePath: binding.sourcePath, contentDigest: sourceDigest(binding.templateId) })),
      ].sort((left, right) => left.kind.localeCompare(right.kind) || left.logicalId.localeCompare(right.logicalId)),
      placement: bindings.map((binding) => ({ templateId: binding.templateId, destinationClass: binding.destinationClass, templateFolder: binding.destinationClass === "managed-default" ? policy.templateFolder : null, sourcePath: binding.sourcePath })),
    };

    const shared = templateInput(policy, {
      policy: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      taxonomy: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      obsidianTypes: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      obsidianTypesPath: ".obsidian/types.json",
    }, bindings, (binding) => sourceDigest(binding.templateId));

    expect(shared).toEqual(legacy);
    expect(inputDigest(shared)).toBe(inputDigest(legacy));
  });
});
