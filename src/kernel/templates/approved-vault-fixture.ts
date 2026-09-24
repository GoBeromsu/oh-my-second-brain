import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { digestBytes } from "./canonical.js";
import { parseContractPolicyV5, serializeContractPolicyV5 } from "./contract-v5.js";
import { parseTemplatePolicy, serializeDerivedProjection } from "./policy.js";
import { controlGenerationDigest, expectedProjectionManaged, taxonomyRouting } from "./resolver.js";
import type { JsonValue } from "./types.js";

/**
 * Writes an approved version 4 vault for tests and tools that need one.
 *
 * The policy, taxonomy, and derived projection are produced by the same kernel
 * functions the runtime uses, so a fixture cannot drift from the real contract
 * shape. Notes are written exactly as an agent would save them.
 */

const encoder = new TextEncoder();

export interface ApprovedTemplateFixture {
  /** Property names this template declares, each required unless listed optional. */
  readonly fields?: readonly string[];
  readonly optionalFields?: readonly string[];
  readonly headings?: readonly { readonly headingId: string; readonly title: string; readonly level: number }[];
  readonly approvedMarkdown?: string;
  /** Optional raw source reference; its bytes are written unless `rawSource` is null. */
  readonly rawSource?: { readonly path: string; readonly identity: string; readonly bytes: string } | null;
  readonly targetFolder?: string;
}

export interface ApprovedVaultFixture {
  readonly properties?: Readonly<Record<string, { readonly type: string; readonly intent: string; readonly allowedValues?: readonly string[] }>>;
  readonly templates?: Readonly<Record<string, ApprovedTemplateFixture>>;
  readonly folders?: Readonly<Record<string, { readonly intent: string }>>;
  readonly notes?: Readonly<Record<string, string>>;
  readonly obsidianTypes?: Readonly<Record<string, string>>;
}

function layer(templatePath: string, markdown: string, extra: Record<string, JsonValue | unknown> = {}): Record<string, unknown> {
  return {
    templatePath,
    approvedMarkdown: markdown,
    approvedMarkdownDigest: digestBytes(markdown),
    fields: {},
    headings: [],
    semanticCriteria: [],
    ...extra,
  };
}

export function approvedPolicyDocument(fixture: ApprovedVaultFixture): Record<string, unknown> {
  const templates: Record<string, unknown> = {};
  for (const [templateId, template] of Object.entries(fixture.templates ?? {})) {
    const optional = new Set(template.optionalFields ?? []);
    const fields: Record<string, unknown> = {};
    for (const name of template.fields ?? []) {
      fields[name] = { property: name, ...(optional.has(name) ? {} : { required: true }) };
    }
    templates[templateId] = layer(`.oms/templates/${templateId}.md`, template.approvedMarkdown ?? "", {
      templateId,
      fields,
      headings: (template.headings ?? []).map(heading => ({ ...heading, required: true })),
      ...(template.rawSource === undefined || template.rawSource === null
        ? {}
        : { source: { path: template.rawSource.path, identity: template.rawSource.identity, rawDigest: digestBytes(template.rawSource.bytes) } }),
    });
  }
  return {
    version: 4,
    properties: fixture.properties ?? {},
    default: layer(".oms/templates/default.md", ""),
    templates,
  };
}

/** Creates the vault on disk and returns the exact control bytes it wrote. */
export async function writeApprovedVault(root: string, fixture: ApprovedVaultFixture = {}): Promise<{
  readonly policyText: string;
  readonly taxonomyText: string;
  readonly projectionText: string;
  readonly generationDigest: ReturnType<typeof controlGenerationDigest>;
}> {
  const policyText = JSON.stringify(approvedPolicyDocument(fixture));
  const taxonomyText = JSON.stringify({
    templates: Object.fromEntries(Object.entries(fixture.templates ?? {}).flatMap(([templateId, template]) =>
      template.targetFolder === undefined ? [] : [[templateId, { templateFolder: template.targetFolder }]])),
    folders: fixture.folders ?? {},
  });
  const generationDigest = controlGenerationDigest(encoder.encode(policyText), encoder.encode(taxonomyText));
  const projectionText = serializeDerivedProjection({
    version: "oms.types.v2",
    generatedFrom: generationDigest,
    managed: expectedProjectionManaged(
      parseTemplatePolicy(policyText),
      taxonomyRouting(".oms/taxonomy.json", encoder.encode(taxonomyText)),
      generationDigest,
    ),
  });

  await mkdir(path.join(root, ".oms", "templates"), { recursive: true });
  await mkdir(path.join(root, ".obsidian"), { recursive: true });
  await writeFile(path.join(root, ".oms", "template-policy.json"), policyText);
  await writeFile(path.join(root, ".oms", "taxonomy.json"), taxonomyText);
  await writeFile(path.join(root, ".oms", "types.json"), projectionText);
  await writeFile(path.join(root, ".oms", "templates", "default.md"), "");
  await writeFile(
    path.join(root, ".obsidian", "types.json"),
    JSON.stringify({ types: fixture.obsidianTypes ?? {} }),
  );
  for (const [templateId, template] of Object.entries(fixture.templates ?? {})) {
    await writeFile(path.join(root, ".oms", "templates", `${templateId}.md`), template.approvedMarkdown ?? "");
    if (template.rawSource !== undefined && template.rawSource !== null) {
      const sourcePath = path.join(root, template.rawSource.path);
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, template.rawSource.bytes);
    }
  }
  for (const [notePath, content] of Object.entries(fixture.notes ?? {})) {
    const absolute = path.join(root, notePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return { policyText, taxonomyText, projectionText, generationDigest };
}

/**
 * Writes an explicit version 5 vault: a user-owned property pool, an always-on
 * common contract with no physical Markdown, and registered templates whose
 * sources are the user's own files. Search and graph read this contract.
 */
export async function writeContractVault(root: string, fixture: ApprovedVaultFixture = {}): Promise<{
  readonly policyText: string;
  readonly taxonomyText: string;
}> {
  const properties: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(fixture.properties ?? {})) {
    properties[name] = { type: definition.type, ...(definition.intent === undefined ? {} : { intent: definition.intent }), ...(definition.allowedValues === undefined ? {} : { allowedValues: [...definition.allowedValues] }) };
  }
  const templates: Record<string, unknown> = {};
  const sources: { path: string; bytes: string }[] = [];
  for (const [templateId, template] of Object.entries(fixture.templates ?? {})) {
    const optional = new Set(template.optionalFields ?? []);
    const fields: Record<string, unknown> = {};
    for (const name of template.fields ?? []) fields[name] = optional.has(name) ? {} : { required: true };
    const source = template.rawSource ?? {
      path: `Templates/${templateId}.md`,
      identity: `source-${templateId}`,
      bytes: template.approvedMarkdown ?? "",
    };
    sources.push({ path: source.path, bytes: source.bytes });
    templates[templateId] = {
      status: "active",
      source: { identity: source.identity, path: source.path, rawDigest: digestBytes(source.bytes) },
      fields,
      ...(template.headings === undefined ? {} : { headings: template.headings.map(heading => ({ ...heading, required: true })) }),
    };
  }
  const policyText = serializeContractPolicyV5(parseContractPolicyV5({
    version: 5,
    revision: 1,
    properties,
    common: { status: "active", fields: {} },
    templates,
  }));
  const taxonomyText = JSON.stringify({
    templates: Object.fromEntries(Object.entries(fixture.templates ?? {}).flatMap(([templateId, template]) =>
      template.targetFolder === undefined ? [] : [[templateId, { templateFolder: template.targetFolder }]])),
    folders: fixture.folders ?? {},
  });

  await mkdir(path.join(root, ".oms"), { recursive: true });
  await mkdir(path.join(root, ".obsidian"), { recursive: true });
  await writeFile(path.join(root, ".oms", "template-policy.json"), policyText);
  await writeFile(path.join(root, ".oms", "taxonomy.json"), taxonomyText);
  await writeFile(path.join(root, ".obsidian", "types.json"), JSON.stringify({ types: fixture.obsidianTypes ?? {} }));
  for (const source of sources) {
    const absolute = path.join(root, source.path);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, source.bytes);
  }
  for (const [notePath, content] of Object.entries(fixture.notes ?? {})) {
    const absolute = path.join(root, notePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return { policyText, taxonomyText };
}
