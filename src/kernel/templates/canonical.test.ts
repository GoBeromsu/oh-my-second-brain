import { describe, expect, it } from "vitest";
import { approvalDigest, frameHash, inputDigest, templateInput } from "./canonical.js";
import type { Digest, InputV2, TemplateCompositionManifest, TemplatePolicy } from "./types.js";

const minimal: InputV2 = { authority: [], placement: [], templateFolders: [], version: 2 };

describe("InputV2 canonical identity", () => {
  it("pins the approved minimal frame bytes and digest", () => {
    expect(Buffer.from(frameHash("oms.template-migration.input.v2", minimal)).toString("hex")).toBe(
      "6f6d732d686173682d6672616d652d7631003331006f6d732e74656d706c6174652d6d6967726174696f6e2e696e7075742e76323634007b22617574686f72697479223a5b5d2c22706c6163656d656e74223a5b5d2c2274656d706c617465466f6c64657273223a5b5d2c2276657273696f6e223a327d",
    );
    expect(inputDigest(minimal)).toBe("sha256:0d9461686e8dcb8adce4da4aa07b6c19518d95b3dc4280e249c1d6a73a7f489f");
  });

  it("preserves the resolver and doctor authority digest assembly", () => {
    const policy: TemplatePolicy = {
      version: 3,
      templateFolders: [
        { path: "Templates/zebra" as TemplatePolicy["templateFolders"][number]["path"], mode: "manual" },
        { path: "Templates/OMS" as TemplatePolicy["templateFolders"][number]["path"], mode: "auto", default: true },
      ],
      base: { fields: {} },
      contracts: {},
      templates: {
        zebra: { templateId: "zebra", destinationClass: "registered-existing", sourceFolder: "Templates/zebra" as TemplatePolicy["templates"][string]["sourceFolder"], sourcePath: "Templates/zebra/zebra.md" as TemplatePolicy["templates"][string]["sourcePath"], contract: "zebra", naming: "{{title}}" },
        alpha: { templateId: "alpha", destinationClass: "managed-default", sourceFolder: "Templates/OMS" as TemplatePolicy["templates"][string]["sourceFolder"], sourcePath: "Templates/OMS/alpha.md" as TemplatePolicy["templates"][string]["sourcePath"], contract: "alpha", naming: "{{title}}" },
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
      templateFolders: [...policy.templateFolders].sort((left, right) => left.path.localeCompare(right.path)),
      authority: [
        { kind: "policy", logicalId: "template-policy", vaultRelativePath: ".oms/template-policy.json", contentDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" },
        { kind: "taxonomy", logicalId: "taxonomy", vaultRelativePath: ".oms/taxonomy.json", contentDigest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" },
        { kind: "obsidian-types", logicalId: "obsidian-types", vaultRelativePath: ".obsidian/types.json", contentDigest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
        ...bindings.map((binding) => ({ kind: "template" as const, logicalId: binding.templateId, vaultRelativePath: binding.sourcePath, contentDigest: sourceDigest(binding.templateId) })),
      ].sort((left, right) => left.kind.localeCompare(right.kind) || left.logicalId.localeCompare(right.logicalId)),
      placement: bindings.map((binding) => ({ templateId: binding.templateId, destinationClass: binding.destinationClass, templateFolder: binding.destinationClass === "managed-default" ? binding.sourceFolder : null, sourceFolder: binding.sourceFolder, sourcePath: binding.sourcePath })),
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

  it("canonicalizes registration order while binding folder semantics into the digest", () => {
    const folderA = { path: "Templates/A" as TemplatePolicy["templateFolders"][number]["path"], mode: "auto" as const, default: true as const };
    const folderB = { path: "Templates/B" as TemplatePolicy["templateFolders"][number]["path"], mode: "manual" as const };
    const placement = {
      templateId: "alpha" as InputV2["placement"][number]["templateId"],
      destinationClass: "registered-existing" as const,
      templateFolder: null,
      sourceFolder: folderA.path,
      sourcePath: "Templates/A/alpha.md" as InputV2["placement"][number]["sourcePath"],
    };
    const input = (templateFolders: InputV2["templateFolders"], currentPlacement = placement): InputV2 => ({
      version: 2, authority: [], templateFolders, placement: [currentPlacement],
    });
    const folderAWithoutDefault = { path: folderA.path, mode: folderA.mode };
    expect(inputDigest(input([folderA, folderB]))).toBe(inputDigest(input([folderB, folderA])));
    expect(inputDigest(input([folderA, folderB]))).toBe(inputDigest(input([{ ...folderA, path: "Templates//A/." as typeof folderA.path }, folderB])));
    expect(inputDigest(input([folderA, folderB]))).not.toBe(inputDigest(input([{ ...folderA, mode: "manual" }, folderB])));
    expect(inputDigest(input([folderA, folderB]))).not.toBe(inputDigest(input([folderAWithoutDefault, { ...folderB, default: true }])));
    expect(inputDigest(input([folderA, folderB]))).not.toBe(inputDigest(input([folderA, folderB], { ...placement, sourceFolder: folderB.path })));
  });

  it("binds the current control and source CAS preimage even when the proposal is identical", () => {
    const digestA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Digest;
    const digestB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Digest;
    const proposed = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Digest;
    const preimage = (oldPolicy: Digest): Pick<TemplateCompositionManifest, "current" | "controls" | "sources"> => ({
      current: { inputDigest: digestA },
      controls: [
        { path: ".oms/template-policy.json", expectedCurrent: { state: "present", signature: oldPolicy } },
        { path: ".oms/taxonomy.json", expectedCurrent: { state: "present", signature: digestA } },
        { path: ".oms/types.json", expectedCurrent: { state: "present", signature: digestA } },
      ],
      sources: [{ templateId: "note", path: "Templates/note.md", expectedCurrent: { state: "present", signature: digestA } }],
    }) as unknown as Pick<TemplateCompositionManifest, "current" | "controls" | "sources">;

    const fromA = approvalDigest(proposed, [], [], preimage(digestA));
    const fromB = approvalDigest(proposed, [], [], preimage(digestB));
    expect(fromA).not.toBe(fromB);

    const reversed = {
      ...preimage(digestA),
      controls: [...preimage(digestA).controls].reverse(),
      sources: [...preimage(digestA).sources].reverse(),
    };
    expect(approvalDigest(proposed, [], [], reversed)).toBe(fromA);
  });
});
