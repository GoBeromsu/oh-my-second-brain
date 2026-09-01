/**
 * Vault-declared note exclusions for the scanning walkers.
 *
 * `taxonomy.yaml: exclude` names markdown files that are not notes - template
 * sources whose pre-substitution frontmatter is intentionally not valid YAML
 * (Templater tags, agent {{var}} placeholders), build staging, skill files.
 * Every template-derived graph/index walker uses this declaration so excluded
 * authored sources cannot abort a vault scan.
 *
 * This module gives those walkers the same exclusion policy without
 * requiring template resolution: it reads the vault exclusion declaration
 * directly and uses built-in system exclusions when none is configured.
 */
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Default audit exemptions - build artifacts, self-documenting templates, and
 * skill files that intentionally carry no frontmatter. This is the single
 * declaration shared by current vault walkers.
 */
export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  "25. Digital Garden/.deploy-staging/**",
  "**/*.template.md",
  "**/SKILL.md",
  ".obsidian/**",
  ".trash/**",
  ".oms/**",
  "_attachments/**",
];

/**
 * Convert a `*`/`**` glob into an anchored RegExp. `**` matches across `/`,
 * `*` does not.
 *
 * GLOBSTAR must be a placeholder character that (a) cannot appear in a glob
 * and (b) survives the escaping step below untouched. The NUL character
 * (written here as the escape sequence "\u0000") satisfies both. A printable
 * stand-in typed as the literal four-character escape sequence would not
 * survive: the escaping regex would itself escape its backslash, and the
 * later split on the placeholder would never match again - silently
 * disabling all "**" handling.
 */
function globToRegExp(glob: string): RegExp {
  const GLOBSTAR = "\u0000";
  const withPlaceholder = glob.replace(/\*\*/g, GLOBSTAR);
  const escaped = withPlaceholder.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withStar = escaped.replace(/\*/g, "[^/]*");
  const pattern = withStar.split(GLOBSTAR).join(".*");
  return new RegExp(`^${pattern}$`);
}

/** True when `notePath` matches at least one of `globs`. */
export function matchesAnyGlob(notePath: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(notePath));
}

/** One resolve per vault root per process; every walker level shares it. */
const matcherCache = new Map<string, Promise<RegExp[]>>();

function normalizedPath(notePath: string): string {
  const normalized = notePath.normalize("NFC").replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (
    normalized === ""
    || normalized.startsWith("/")
    || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    failure("MANAGED_SOURCE_RESOLUTION_FAILED", `unsafe path ${notePath}`);
  }
  return normalized;
}

function failure(code: string, evidence: string): never {
  throw new Error(`${code}: ${evidence}`);
}

async function loadExcludeMatchers(vaultRoot: string): Promise<RegExp[]> {
  const key = path.resolve(vaultRoot);
  let pending = matcherCache.get(key);
  if (pending === undefined) {
    pending = (async () => {
      let declared: string[] = [];
      try {
        const raw = await readFile(path.join(key, ".oms", "taxonomy.yaml"), "utf-8");
        const parsed = parseYaml(raw) as unknown;
        const rawExclude =
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)["exclude"]
            : undefined;
        if (Array.isArray(rawExclude) && rawExclude.every((item) => typeof item === "string")) {
          declared = rawExclude;
        } else if (rawExclude !== undefined) {
          failure("NOTE_EXCLUSION_RESOLUTION_FAILED", ".oms/taxonomy.yaml: exclude must be a list of strings");
        }
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          declared = [];
        } else {
          failure("NOTE_EXCLUSION_RESOLUTION_FAILED", `.oms/taxonomy.yaml: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const externalTemplatePaths = await loadExternalTemplatePaths(key);
      return [
        ...DEFAULT_EXCLUDE_GLOBS,
        ...declared,
        ...externalTemplatePaths.flatMap((templatePath) => [templatePath, `${templatePath}/**`]),
      ].map(globToRegExp);
    })();
    matcherCache.set(key, pending);
  }
  return pending;
}

function configuredPath(value: unknown, source: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    return failure("NOTE_EXCLUSION_RESOLUTION_FAILED", `${source} must be a non-empty string`);
  }
  return normalizedPath(value.trim().replace(/\/+$/g, ""));
}

async function configuredJson(pathname: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(pathname, "utf-8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return failure("NOTE_EXCLUSION_RESOLUTION_FAILED", `${pathname}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadExternalTemplatePaths(vaultRoot: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const obsidianTemplatesPath = path.join(vaultRoot, ".obsidian", "templates.json");
  const obsidianTemplates = await configuredJson(obsidianTemplatesPath);
  if (obsidianTemplates !== undefined) {
    if (obsidianTemplates === null || typeof obsidianTemplates !== "object" || Array.isArray(obsidianTemplates)) {
      failure("NOTE_EXCLUSION_RESOLUTION_FAILED", `${obsidianTemplatesPath} must be an object`);
    }
    const folder = (obsidianTemplates as Record<string, unknown>)["folder"];
    if (folder !== undefined) paths.push(configuredPath(folder, `${obsidianTemplatesPath}: folder`));
  }

  const templaterPath = path.join(vaultRoot, ".obsidian", "plugins", "templater-obsidian", "data.json");
  const templater = await configuredJson(templaterPath);
  if (templater !== undefined) {
    if (templater === null || typeof templater !== "object" || Array.isArray(templater)) {
      failure("NOTE_EXCLUSION_RESOLUTION_FAILED", `${templaterPath} must be an object`);
    }
    const settings = templater as Record<string, unknown>;
    if (settings["templates_folder"] !== undefined) {
      paths.push(configuredPath(settings["templates_folder"], `${templaterPath}: templates_folder`));
    }
    const folderTemplates = settings["folder_templates"];
    if (folderTemplates !== undefined) {
      if (!Array.isArray(folderTemplates)) {
        failure("NOTE_EXCLUSION_RESOLUTION_FAILED", `${templaterPath}: folder_templates must be a list`);
      }
      for (const [index, entry] of folderTemplates.entries()) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          failure("NOTE_EXCLUSION_RESOLUTION_FAILED", `${templaterPath}: folder_templates[${index}] must be an object`);
        }
        const template = (entry as Record<string, unknown>)["template"];
        if (template !== undefined) {
          paths.push(configuredPath(template, `${templaterPath}: folder_templates[${index}].template`));
        }
      }
    }
  }
  return [...new Set(paths)].sort();
}

async function managedSourcePaths(vaultRoot: string): Promise<readonly string[]> {
  const policyPath = path.join(vaultRoot, ".oms", "template-policy.json");
  let raw: string;
  try {
    raw = await readFile(policyPath, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    return failure("MANAGED_SOURCE_RESOLUTION_FAILED", `${policyPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return failure("MANAGED_SOURCE_RESOLUTION_FAILED", `${policyPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failure("MANAGED_SOURCE_RESOLUTION_FAILED", `${policyPath}: policy must be an object`);
  }
  const templates = (parsed as Record<string, unknown>)["templates"];
  if (templates === null || typeof templates !== "object" || Array.isArray(templates)) {
    return failure("MANAGED_SOURCE_RESOLUTION_FAILED", `${policyPath}: templates must be an object`);
  }
  const sources: string[] = [];
  for (const [templateId, binding] of Object.entries(templates)) {
    if (binding === null || typeof binding !== "object" || Array.isArray(binding)) {
      failure("MANAGED_SOURCE_RESOLUTION_FAILED", `${policyPath}: templates.${templateId} must be an object`);
    }
    const sourcePath = (binding as Record<string, unknown>)["sourcePath"];
    if (typeof sourcePath !== "string" || sourcePath === "") {
      failure("MANAGED_SOURCE_RESOLUTION_FAILED", `${policyPath}: templates.${templateId}.sourcePath must be a non-empty string`);
    }
    sources.push(normalizedPath(sourcePath));
  }
  return sources;
}

/** Exact managed template paths without requiring the derived projection. */
export async function managedSourcePathSet(vaultRoot: string): Promise<ReadonlySet<string>> {
  return new Set(await managedSourcePaths(path.resolve(vaultRoot)));
}

/**
 * Predicate over vault-relative, forward-slashed note paths.
 * Resolved once per vault root and reused by every walker level.
 */
export async function excludedNoteMatcher(
  vaultRoot: string,
  includeManagedSources = true,
): Promise<(notePath: string) => boolean> {
  const matchers = await loadExcludeMatchers(vaultRoot);
  const sources = includeManagedSources ? new Set(await managedSourcePaths(vaultRoot)) : new Set<string>();
  return (notePath: string) => {
    const normalized = normalizedPath(notePath);
    return sources.has(normalized) || matchers.some((pattern) => pattern.test(normalized));
  };
}

/**
 * Resolves managed source identities once and matches both lexical paths and
 * aliases that resolve to the same on-disk file. Resolution failures reject
 * the scan with the source path that could not be established.
 */
export async function managedSourceExclusionMatcher(
  vaultRoot: string,
  sourcePaths?: readonly string[],
): Promise<(notePath: string) => Promise<boolean>> {
  const root = await realpath(vaultRoot);
  const matchers = await loadExcludeMatchers(root);
  const lexical = new Set((sourcePaths ?? await managedSourcePaths(root)).map(normalizedPath));
  const resolved = new Set<string>();
  for (const sourcePath of lexical) {
    try {
      resolved.add(await realpath(path.resolve(root, sourcePath)));
    } catch (error) {
      failure("MANAGED_SOURCE_RESOLUTION_FAILED", `${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return async (notePath: string) => {
    const normalized = normalizedPath(notePath);
    if (lexical.has(normalized) || matchers.some((matcher) => matcher.test(normalized))) return true;
    let actual: string;
    try {
      actual = await realpath(path.resolve(root, normalized));
    } catch (error) {
      return failure("MANAGED_SOURCE_RESOLUTION_FAILED", `${normalized}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return resolved.has(actual);
  };
}
