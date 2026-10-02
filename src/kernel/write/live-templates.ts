import path from "node:path";
import { compareCodePoints, digestBytes, type Digest } from "../conventions/canonical.js";
import { parseNote } from "../conventions/frontmatter.js";
import { scanContractHeadings, scanTemplateSources, type TemplateSourceInventory } from "../contract/scan.js";
import { readVaultSettings } from "../vault/settings.js";

/**
 * Templates are generators, read live from the vault's `templateFolder` whenever a note is
 * written. They are never sealed and never judged: a template only scaffolds a new note
 * with its frontmatter as defaults and its headings as the skeleton.
 */

/** One top-level frontmatter key of a template, as its raw YAML lines. */
export interface TemplateField {
  readonly name: string;
  readonly text: string;
}

export interface TemplateHeading {
  readonly title: string;
  readonly level: number;
}

export interface LiveTemplate {
  /** The file name without `.md`. */
  readonly name: string;
  /** Vault-relative path of the template file. */
  readonly source: string;
  /** The template's `folder:` value: the folder it scaffolds notes for, or null. */
  readonly folder: string | null;
  /** The defaults, in template order; the `folder:` selector and empty keys are not among them. */
  readonly fields: readonly TemplateField[];
  readonly headings: readonly TemplateHeading[];
}

export type TemplateSelection =
  | { readonly kind: "template"; readonly template: LiveTemplate }
  /** Two or more templates match the folder and none was named: no scaffold, a ② choice. */
  | { readonly kind: "choice"; readonly candidates: readonly string[] }
  /** The named template is not in `templateFolder`: no scaffold, and a warning. */
  | { readonly kind: "missing"; readonly name: string }
  | { readonly kind: "none" };

const FOLDER_KEY = "folder";
const KEY_LINE = /^(?:"([^"]+)"|'([^']+)'|([^\s:#'"-][^:#]*?))\s*:(?:\s|$)/;

function trimFolder(folder: string): string {
  return folder.normalize("NFC").replace(/^\/+|\/+$/g, "");
}

/** Splits raw frontmatter into top-level keys; indented and `-` lines stay with the key above. */
export function templateFields(frontmatterRaw: string): TemplateField[] {
  const fields: { name: string; lines: string[] }[] = [];
  for (const line of frontmatterRaw.split(/\r?\n/)) {
    const match = /^\s/.test(line) || line.startsWith("-") ? null : KEY_LINE.exec(line);
    const name = match === null ? null : (match[1] ?? match[2] ?? match[3] ?? null);
    if (name !== null) fields.push({ name, lines: [line] });
    else if (fields.length > 0 && line.trim() !== "") fields.at(-1)!.lines.push(line);
  }
  return fields.map(field => ({ name: field.name, text: field.lines.join("\n") }));
}

/** Null when the template is not a readable note: it then scaffolds nothing. */
export function parseLiveTemplate(source: string, text: string): LiveTemplate | null {
  const parsed = parseNote(text);
  if (parsed.diagnostics.length > 0) return null;
  let headings: TemplateHeading[];
  try {
    headings = scanContractHeadings(parsed.body, true).map(heading => ({ title: heading.title.normalize("NFC"), level: heading.level }));
  } catch {
    return null;
  }
  const folderValue = parsed.frontmatter[FOLDER_KEY];
  // An empty key is a prompt for the writer, not a default: it would only be saved empty.
  const fields = templateFields(parsed.frontmatterRaw).filter(field => field.name !== FOLDER_KEY
    && Object.hasOwn(parsed.frontmatter, field.name) && parsed.frontmatter[field.name] !== null && parsed.frontmatter[field.name] !== "");
  return {
    name: path.posix.basename(source).replace(/\.md$/i, "").normalize("NFC"),
    source,
    folder: typeof folderValue === "string" && trimFolder(folderValue) !== "" ? trimFolder(folderValue) : null,
    fields,
    headings,
  };
}

/** The raw source observation that produced the parsed templates; not a filesystem transaction. */
export interface LiveTemplateSnapshot {
  readonly templates: readonly LiveTemplate[];
  readonly witness: Digest;
}

function parsedTemplates(inventory: TemplateSourceInventory): readonly LiveTemplate[] {
  return inventory.sources
    .filter(source => /\.md$/i.test(source.path) && source.text !== null)
    .map(source => parseLiveTemplate(source.path, source.text!))
    .filter((template): template is LiveTemplate => template !== null)
    .sort((left, right) => compareCodePoints(left.name, right.name) || compareCodePoints(left.source, right.source));
}

async function readTemplateSnapshot(vault: string, folder: string): Promise<LiveTemplateSnapshot> {
  try {
    const inventory = await scanTemplateSources(vault, [{ path: folder, kind: "folder" }]);
    // Include all discovered raw sources, even malformed ones: adding/fixing a candidate
    // can change the selection. Hash exact paths/bytes without Unicode normalization.
    const witness = digestBytes(JSON.stringify({
      folder,
      sources: inventory.sources.map(source => [source.path, source.rawDigest]),
      diagnostics: inventory.diagnostics.map(item => [item.code, item.path ?? null]),
    }));
    return { templates: parsedTemplates(inventory), witness };
  } catch {
    return { templates: [], witness: digestBytes(JSON.stringify({ folder, unavailable: true })) };
  }
}

/** Best-effort live templates plus a witness of the settings selector and source inventory. */
export async function loadLiveTemplateSnapshot(vault: string): Promise<LiveTemplateSnapshot> {
  try {
    const folder = (await readVaultSettings(vault))?.templateFolder;
    return folder === undefined
      ? { templates: [], witness: digestBytes("no-template-folder") }
      : await readTemplateSnapshot(vault, folder);
  } catch {
    return { templates: [], witness: digestBytes("unreadable-template-settings") };
  }
}

/**
 * Every readable Markdown template under `templateFolder`, by name. Best effort: a vault
 * without a template folder, or one that cannot be read, has no templates.
 */
export async function loadLiveTemplates(vault: string): Promise<readonly LiveTemplate[]> {
  return (await loadLiveTemplateSnapshot(vault)).templates;
}

/** Every readable Markdown template under `folder`, by name; best effort like `loadLiveTemplates`. */
export async function readLiveTemplates(vault: string, folder: string): Promise<readonly LiveTemplate[]> {
  return (await readTemplateSnapshot(vault, folder)).templates;
}

/** Templates whose file name is the folder's last segment, or whose `folder:` is the folder. */
export function templatesForFolder(templates: readonly LiveTemplate[], folder: string | undefined): readonly LiveTemplate[] {
  if (folder === undefined) return [];
  const target = trimFolder(folder);
  const leaf = path.posix.basename(target);
  return templates.filter(template => template.folder === target || template.name === leaf);
}

function named(template: LiveTemplate, name: string): boolean {
  const wanted = name.normalize("NFC");
  return template.name === wanted || template.source === wanted || template.source === `${wanted}.md`;
}

/**
 * The template that scaffolds a note in `folder`: the explicit name first, else the unique
 * template that matches the folder. Two or more matches leave the choice open; none, no scaffold.
 */
export function selectTemplate(templates: readonly LiveTemplate[], options: { readonly explicit?: string | undefined; readonly folder?: string | undefined }): TemplateSelection {
  if (options.explicit !== undefined) {
    const template = templates.find(candidate => named(candidate, options.explicit!));
    return template === undefined ? { kind: "missing", name: options.explicit } : { kind: "template", template };
  }
  const candidates = templatesForFolder(templates, options.folder);
  if (candidates.length === 1) return { kind: "template", template: candidates[0]! };
  if (candidates.length > 1) return { kind: "choice", candidates: candidates.map(template => template.name) };
  return { kind: "none" };
}
