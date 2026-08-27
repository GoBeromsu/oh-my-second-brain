/**
 * Vault-declared note exclusions for the scanning walkers.
 *
 * `taxonomy.yaml: exclude` names markdown files that are not notes - template
 * sources whose pre-substitution frontmatter is intentionally not valid YAML
 * (Templater tags, agent {{var}} placeholders), build staging, skill files.
 * The vault-lint lane already honours it via `resolveExcludeGlobs` in
 * ../engine/conventions/vault-lint.ts, but the walkers that feed retrieval
 * (the engine graph builder, the EAV axis scan, the graph cache) never saw
 * it and threw on the first excluded note, aborting the whole vault scan.
 *
 * This module gives those walkers the same exclusion policy without
 * requiring a full Ontology load (two of the three call sites intentionally
 * do not load one): it reads <vaultRoot>/.oms/taxonomy.yaml directly and
 * degrades to the built-in defaults when the file is missing or malformed.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Default audit exemptions - build artifacts, self-documenting templates, and
 * skill files that intentionally carry no frontmatter. This is the single
 * declaration; ../engine/conventions/vault-lint.ts re-exports it so its
 * existing importers are unaffected.
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
        }
      } catch {
        // A vault with no (or an unparsable) taxonomy.yaml still gets the
        // built-in defaults - a missing exclude declaration is not fatal.
      }
      return [...DEFAULT_EXCLUDE_GLOBS, ...declared].map(globToRegExp);
    })();
    matcherCache.set(key, pending);
  }
  return pending;
}

/**
 * Predicate over vault-relative, forward-slashed note paths.
 * Resolved once per vault root and reused by every walker level.
 */
export async function excludedNoteMatcher(
  vaultRoot: string,
): Promise<(notePath: string) => boolean> {
  const matchers = await loadExcludeMatchers(vaultRoot);
  return (notePath: string) => matchers.some((pattern) => pattern.test(notePath));
}
