import * as fs from "node:fs";
import * as path from "node:path";
import type { EnforcementRule } from "./types.js";

type Severity = EnforcementRule["severity"];
type RuleType = EnforcementRule["type"];

const VALID_SEVERITIES: Severity[] = ["block", "deny", "advisory"];
const VALID_RULE_TYPES: RuleType[] = [
  "path-boundary",
  "path-boundary-exception",
  "frontmatter-required",
  "frontmatter-value",
  "naming-convention",
];

/**
 * Parse key="value" pairs from an omsb annotation string.
 * Handles both quoted values (key="val") and unquoted tokens (key=val).
 * Also handles Unicode content including Korean text.
 */
function parseAnnotationAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};

  // Match key="value" (quoted) or key=value (unquoted, no spaces)
  const pattern = /(\w[\w-]*)=(?:"([^"]*?)"|([^\s"]+))/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    const key = match[1];
    const value = match[2] !== undefined ? match[2] : match[3];
    attrs[key] = value;
  }

  return attrs;
}

/**
 * Slugify a string for rule IDs.
 */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[/\\.]/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Count line number (1-based) of a match position in source text.
 */
function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/**
 * Map annotation attributes to an EnforcementRule config object.
 */
function buildConfig(attrs: Record<string, string>): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  if (attrs["paths"]) config["paths"] = attrs["paths"].split(",").map((p) => p.trim());
  if (attrs["parent"]) config["parent"] = attrs["parent"];
  if (attrs["allows"]) config["allows"] = attrs["allows"].split(",").map((a) => a.trim());
  if (attrs["field"]) config["field"] = attrs["field"];
  if (attrs["enum"]) config["enum"] = attrs["enum"].split(",").map((e) => e.trim());
  if (attrs["pattern"]) config["pattern"] = attrs["pattern"];
  if (attrs["format"]) config["format"] = attrs["format"];

  return config;
}

/**
 * Extract Tier 2 EnforcementRules from <!-- omsb: ... --> annotations
 * in guideline markdown files.
 *
 * @param guidelinesRoot - Absolute path to the guidelines root directory
 * @param guidelineFiles - Relative paths within guidelinesRoot to scan
 */
export function extractTier2Rules(
  guidelinesRoot: string,
  guidelineFiles: string[]
): EnforcementRule[] {
  const rules: EnforcementRule[] = [];

  // Regex matches <!-- omsb: ... --> including multiline comments.
  // The [\s\S]*? ensures non-greedy matching across newlines.
  const annotationRegex = /<!--\s*omsb:\s*([\s\S]*?)\s*-->/g;

  for (const relFile of guidelineFiles) {
    const filePath = path.resolve(guidelinesRoot, relFile);
    const normalizedRoot = path.resolve(guidelinesRoot) + path.sep;
    if (!filePath.startsWith(normalizedRoot) && filePath !== path.resolve(guidelinesRoot)) {
      console.warn(`omsb tier2: path traversal blocked for "${relFile}" — skipping`);
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      console.warn(`omsb tier2: could not read guideline file "${filePath}" — skipping`);
      continue;
    }

    let match: RegExpExecArray | null;
    annotationRegex.lastIndex = 0;

    while ((match = annotationRegex.exec(content)) !== null) {
      const annotationBody = match[1];
      const line = lineAt(content, match.index);

      let attrs: Record<string, string>;
      try {
        attrs = parseAnnotationAttrs(annotationBody);
      } catch {
        console.warn(
          `omsb tier2: malformed annotation in "${filePath}:${line}" — skipping`
        );
        continue;
      }

      // Validate required attributes
      const ruleType = attrs["rule-type"] as RuleType | undefined;
      if (!ruleType) {
        console.warn(
          `omsb tier2: annotation at "${filePath}:${line}" missing rule-type — skipping`
        );
        continue;
      }
      if (!VALID_RULE_TYPES.includes(ruleType)) {
        console.warn(
          `omsb tier2: unknown rule-type "${ruleType}" at "${filePath}:${line}" — skipping`
        );
        continue;
      }

      const severity = (attrs["severity"] ?? "advisory") as Severity;
      if (!VALID_SEVERITIES.includes(severity)) {
        console.warn(
          `omsb tier2: invalid severity "${severity}" at "${filePath}:${line}" — skipping`
        );
        continue;
      }

      // Build a meaningful ID from type + field/pattern/paths context
      const idContext =
        attrs["field"] ??
        attrs["paths"] ??
        attrs["pattern"] ??
        attrs["parent"] ??
        slugify(relFile);
      const id = `t2-${slugify(ruleType)}-${slugify(idContext)}-L${line}`;

      const config = buildConfig(attrs);

      rules.push({
        id,
        type: ruleType,
        severity,
        config,
        source: {
          file: relFile,
          line,
          tier: 2,
        },
      });
    }
  }

  return rules;
}
