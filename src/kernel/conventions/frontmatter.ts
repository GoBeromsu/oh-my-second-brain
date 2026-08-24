import { parseDocument } from "yaml";

/**
 * Split a markdown document into its YAML frontmatter and body.
 *
 * Recognizes the standard Obsidian/Jekyll fence: a `---` line at the very start
 * of the file, the YAML block, then a closing `---` line.
 */
export interface ParsedNote {
  /** Parsed frontmatter as a plain object. Empty object when no frontmatter. */
  frontmatter: Record<string, unknown>;
  /** The markdown body after the closing fence (or the whole doc if no fence). */
  body: string;
  /** Whether a frontmatter block was present. */
  hasFrontmatter: boolean;
  diagnostics: FrontmatterDiagnostic[];
  frontmatterRaw: string;
  frontmatterRange: FrontmatterRange | null;
}

export interface FrontmatterDiagnostic {
  code: "frontmatter-yaml-parse-error" | "frontmatter-unclosed-fence" | "frontmatter-not-map";
  message: string;
}

export interface FrontmatterRange {
  start: number;
  end: number;
}

const OPEN_FENCE = /^---\r?\n/;
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function emptyParsedNote(raw: string): ParsedNote {
  return {
    frontmatter: {},
    body: raw,
    hasFrontmatter: false,
    diagnostics: [],
    frontmatterRaw: "",
    frontmatterRange: null,
  };
}

export function parseNote(raw: string): ParsedNote {
  // Only treat as frontmatter if the document opens with the fence.
  const open = OPEN_FENCE.exec(raw);
  if (!open) {
    return emptyParsedNote(raw);
  }
  const match = FENCE.exec(raw);
  if (!match) {
    const frontmatterStart = open[0].length;
    return {
      frontmatter: {},
      body: "",
      hasFrontmatter: true,
      diagnostics: [
        {
          code: "frontmatter-unclosed-fence",
          message: "Frontmatter starts with an opening fence but has no closing fence.",
        },
      ],
      frontmatterRaw: raw.slice(frontmatterStart),
      frontmatterRange: { start: frontmatterStart, end: raw.length },
    };
  }
  const yamlText = match[1] ?? "";
  const document = parseDocument(yamlText, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    return {
      frontmatter: {},
      body: raw.slice(match[0].length),
      hasFrontmatter: true,
      diagnostics: document.errors.map((error) => ({
        code: "frontmatter-yaml-parse-error",
        message: error.message,
      })),
      frontmatterRaw: yamlText,
      frontmatterRange: { start: 4, end: 4 + yamlText.length },
    };
  }

  const parsed: unknown = document.toJS();
  const frontmatter = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? Object.fromEntries(Object.entries(parsed))
    : {};
  const diagnostics: FrontmatterDiagnostic[] =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? []
      : [
          {
            code: "frontmatter-not-map",
            message: "Frontmatter must be a YAML mapping.",
          },
        ];
  return {
    frontmatter,
    body: raw.slice(match[0].length),
    hasFrontmatter: true,
    diagnostics,
    frontmatterRaw: yamlText,
    frontmatterRange: { start: 4, end: 4 + yamlText.length },
  };
}
