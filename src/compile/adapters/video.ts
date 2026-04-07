import * as path from "node:path";
import type { TermCacheEntry } from "../term-cache.js";

export interface CompileInput {
  sourcePath: string;
  content: string;
  frontmatter: Record<string, string>;
  termCache: TermCacheEntry[];
}

export interface CompileOutput {
  content: string;
  frontmatter: Record<string, string>;
  suggestedPath: string;
}

/**
 * Slugify a title for use in file paths.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export class VideoAdapter {
  private wikiOutputDir: string;

  constructor(wikiOutputDir = "") {
    this.wikiOutputDir = wikiOutputDir;
  }

  /**
   * Compile a video source note into a wiki article.
   * In real usage, this calls Claude agents. For the framework,
   * it provides the structure and a stub implementation.
   */
  compile(input: CompileInput): CompileOutput {
    const { sourcePath, content, frontmatter } = input;

    // Copy essential frontmatter fields
    const outputFrontmatter: Record<string, string> = {};
    for (const field of ["title", "date", "source_url", "tags"]) {
      if (frontmatter[field] !== undefined) {
        outputFrontmatter[field] = frontmatter[field];
      }
    }

    // Type marker only — authorship is handled by the pipeline via addAuthorship()
    outputFrontmatter["type"] = "wiki";

    // Derive title for path generation
    const title =
      frontmatter["title"] ??
      path.basename(sourcePath, ".md");
    const slug = slugify(title);
    const suggestedPath = this.wikiOutputDir
      ? path.join(this.wikiOutputDir, `${slug}.md`)
      : `${slug}.md`;

    // Stub: return source content as-is (real compilation done by Claude agents)
    return {
      content,
      frontmatter: outputFrontmatter,
      suggestedPath,
    };
  }
}
