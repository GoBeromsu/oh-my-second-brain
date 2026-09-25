import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

export type TemplatePathProvenance =
  | "obsidian-core"
  | "templater-folder"
  | "templater-file-templates"
  | "templater-startup";

export interface ConfiguredTemplatePath {
  readonly path: string;
  readonly kind: "file" | "folder";
  readonly provenance: readonly TemplatePathProvenance[];
}

const OBSIDIAN_TEMPLATES = ".obsidian/templates.json";
const TEMPLATER_SETTINGS = ".obsidian/plugins/templater-obsidian/data.json";

function fail(evidence: string): never {
  throw new Error(`TEMPLATE_HINT_RESOLUTION_FAILED: ${evidence}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function normalizeConfiguredPath(value: unknown, source: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${source} must be a non-empty string`);
  const normalized = value.trim().normalize("NFC").replaceAll("\\", "/").replace(/\/+$/g, "");
  if (
    normalized === ""
    || normalized.includes("\0")
    || normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").some((segment) =>
      segment === "" || segment === "." || segment === ".." || segment.startsWith(".")
    )
  ) {
    fail(`${source} contains unsafe path ${JSON.stringify(value)}`);
  }
  return normalized;
}

async function assertConfined(root: string, relativePath: string, source: string): Promise<void> {
  let candidate = path.resolve(root, relativePath);
  if (!isInside(root, candidate)) fail(`${source} resolves outside the vault`);
  for (;;) {
    try {
      const canonical = await realpath(candidate);
      if (!isInside(root, canonical)) fail(`${source} resolves outside the vault through a symlink`);
      return;
    } catch (error) {
      if (!isMissing(error)) fail(`${source}: ${errorMessage(error)}`);
      const parent = path.dirname(candidate);
      if (parent === candidate || !isInside(root, parent)) fail(`${source} has no confined parent`);
      candidate = parent;
    }
  }
}

async function configuredJson(root: string, relativePath: string): Promise<unknown | undefined> {
  const absolute = path.join(root, relativePath);
  try {
    const canonical = await realpath(absolute);
    if (!isInside(root, canonical)) fail(`${relativePath} resolves outside the vault through a symlink`);
    return JSON.parse(await readFile(canonical, "utf-8")) as unknown;
  } catch (error) {
    if (isMissing(error)) return undefined;
    if (error instanceof Error && error.message.startsWith("TEMPLATE_HINT_RESOLUTION_FAILED:")) throw error;
    fail(`${relativePath}: ${errorMessage(error)}`);
  }
}

function objectSettings(value: unknown, source: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${source} must be an object`);
  return value as Record<string, unknown>;
}

async function addConfiguredPath(
  root: string,
  paths: Map<string, Set<TemplatePathProvenance>>,
  value: unknown,
  kind: "file" | "folder",
  provenance: TemplatePathProvenance,
  source: string,
): Promise<void> {
  const configured = normalizeConfiguredPath(value, source);
  await assertConfined(root, configured, source);
  const key = `${kind}\0${configured}`;
  const sources = paths.get(key) ?? new Set<TemplatePathProvenance>();
  sources.add(provenance);
  paths.set(key, sources);
}

async function addTemplateArray(
  root: string,
  paths: Map<string, Set<TemplatePathProvenance>>,
  settings: Record<string, unknown>,
  field: "folder_templates" | "file_templates",
  provenance: TemplatePathProvenance,
): Promise<void> {
  const value = settings[field];
  if (value === undefined) return;
  if (!Array.isArray(value)) fail(`${TEMPLATER_SETTINGS}: ${field} must be a list`);
  for (const [index, entry] of value.entries()) {
    const record = objectSettings(entry, `${TEMPLATER_SETTINGS}: ${field}[${index}]`);
    if (record["template"] !== undefined) {
      await addConfiguredPath(
        root,
        paths,
        record["template"],
        "file",
        provenance,
        `${TEMPLATER_SETTINGS}: ${field}[${index}].template`,
      );
    }
  }
}

/**
 * Reads only authoritative Obsidian and Templater settings. File-valued
 * settings stay files so note exclusion never expands them to their siblings.
 */
export async function loadConfiguredTemplatePaths(vaultRoot: string): Promise<readonly ConfiguredTemplatePath[]> {
  let root: string;
  try {
    root = await realpath(vaultRoot);
  } catch (error) {
    fail(`${vaultRoot}: ${errorMessage(error)}`);
  }
  const paths = new Map<string, Set<TemplatePathProvenance>>();
  const obsidian = await configuredJson(root, OBSIDIAN_TEMPLATES);
  if (obsidian !== undefined) {
    const settings = objectSettings(obsidian, OBSIDIAN_TEMPLATES);
    if (settings["folder"] !== undefined) {
      await addConfiguredPath(root, paths, settings["folder"], "folder", "obsidian-core", `${OBSIDIAN_TEMPLATES}: folder`);
    }
  }

  const templater = await configuredJson(root, TEMPLATER_SETTINGS);
  if (templater !== undefined) {
    const settings = objectSettings(templater, TEMPLATER_SETTINGS);
    if (settings["templates_folder"] !== undefined) {
      await addConfiguredPath(
        root,
        paths,
        settings["templates_folder"],
        "folder",
        "templater-folder",
        `${TEMPLATER_SETTINGS}: templates_folder`,
      );
    }
    await addTemplateArray(root, paths, settings, "folder_templates", "templater-folder");
    await addTemplateArray(root, paths, settings, "file_templates", "templater-file-templates");
    const startup = settings["startup_templates"];
    if (startup !== undefined) {
      if (!Array.isArray(startup)) fail(`${TEMPLATER_SETTINGS}: startup_templates must be a list`);
      for (const [index, template] of startup.entries()) {
        await addConfiguredPath(
          root,
          paths,
          template,
          "file",
          "templater-startup",
          `${TEMPLATER_SETTINGS}: startup_templates[${index}]`,
        );
      }
    }
  }

  return [...paths.entries()]
    .map(([key, provenance]) => {
      const [kind, configuredPath] = key.split("\0") as ["file" | "folder", string];
      return { path: configuredPath, kind, provenance: [...provenance].sort() };
    })
    .sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
}
