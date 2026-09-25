import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { digestBytes } from "../conventions/canonical.js";
import { serializeVaultSettings } from "../vault/settings.js";
import { sealContract } from "./store.js";
import type { FieldType, Rule, VaultContract } from "./types.js";

/**
 * Writes a contract vault for tests and tools that need one.
 *
 * The vault itself carries only `.oms/settings.json`, the Obsidian type map,
 * template sources and notes. The contract is sealed into the (test) home
 * store, which is what runtime readers consult.
 */

export interface ContractTemplateFixture {
  /** Property names this template declares, each required unless listed optional. */
  readonly fields?: readonly string[];
  readonly optionalFields?: readonly string[];
  readonly headings?: readonly { readonly headingId: string; readonly title: string; readonly level: number }[];
  readonly approvedMarkdown?: string;
  /** Optional raw source; when absent the source is `Templates/<id>.md` with the approved bytes. */
  readonly rawSource?: { readonly path: string; readonly identity: string; readonly bytes: string } | null;
  readonly targetFolder?: string;
}

export interface ContractVaultFixture {
  /** Portable identity written into `.oms/settings.json`. */
  readonly vaultId?: string;
  /** Sealed-contract store root; subprocess suites pass their child HOME's `.oms/vaults`. */
  readonly contractStoreRoot?: string;
  readonly templateFolder?: string;
  readonly properties?: Readonly<Record<string, { readonly type: string; readonly intent: string; readonly allowedValues?: readonly string[]; readonly valuePolicy?: "free" | "suggest" | "closed" }>>;
  readonly templates?: Readonly<Record<string, ContractTemplateFixture>>;
  readonly folders?: Readonly<Record<string, { readonly intent: string }>>;
  readonly notes?: Readonly<Record<string, string>>;
  readonly obsidianTypes?: Readonly<Record<string, string>>;
}

async function writeAt(root: string, relative: string, bytes: string): Promise<void> {
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
}

export async function writeContractVault(root: string, fixture: ContractVaultFixture = {}): Promise<void> {
  const sources = Object.entries(fixture.templates ?? {}).map(([templateId, template]) => {
    const source = template.rawSource ?? { path: `Templates/${templateId}.md`, bytes: template.approvedMarkdown ?? "" };
    return { path: source.path, bytes: source.bytes };
  });
  // Each fixture vault gets its own identity so two fixtures never read as shared copies.
  const vaultId = fixture.vaultId ?? randomUUID();
  await writeAt(root, path.join(".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId, templateFolder: fixture.templateFolder ?? "Templates" }));
  await writeAt(root, path.join(".obsidian", "types.json"), JSON.stringify({ types: fixture.obsidianTypes ?? {} }));
  for (const source of sources) await writeAt(root, source.path, source.bytes);
  for (const [notePath, content] of Object.entries(fixture.notes ?? {})) await writeAt(root, notePath, content);

  const sealed = { vaultRealPath: await realpath(root), vaultId, contract: sealedFixtureContract(fixture, sources) };
  if (fixture.contractStoreRoot === undefined) await sealContract(sealed);
  else await sealContract(sealed, fixture.contractStoreRoot);
}

function sealedFixtureContract(
  fixture: ContractVaultFixture,
  sources: readonly { readonly path: string; readonly bytes: string }[],
): VaultContract {
  const folders = Object.fromEntries(Object.entries(fixture.folders ?? {}).map(([folder, { intent }]) =>
    [folder, { meaning: intent, searchExclude: false }]));
  const properties = Object.fromEntries(Object.entries(fixture.properties ?? {}).map(([name, definition]) => {
    const rules: Rule[] = definition.valuePolicy === "closed" && definition.allowedValues !== undefined
      ? [{ kind: "allowed", values: [...definition.allowedValues] }]
      : [];
    return [name, { meaning: definition.intent, type: definition.type as FieldType, default: false, required: false, rules }];
  }));
  const templates = Object.fromEntries(Object.entries(fixture.templates ?? {}).map(([templateId, template], index) => {
    const optional = new Set(template.optionalFields ?? []);
    const source = sources[index]!;
    return [templateId, {
      source: source.path,
      sourceHash: digestBytes(source.bytes),
      ...(template.targetFolder === undefined ? {} : { applyFolder: template.targetFolder }),
      requiredProperties: (template.fields ?? []).filter(name => !optional.has(name)),
      narrowedRules: {},
      requiredHeadings: (template.headings ?? []).map(heading => heading.title),
    }];
  }));
  return { folders, properties, templates };
}
