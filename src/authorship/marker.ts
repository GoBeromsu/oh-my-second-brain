/**
 * Authorship field management for OMSB.
 * Handles inserting/updating created_by and modified_by fields in markdown frontmatter.
 */

export interface AuthorshipConfig {
  agent_name: string;        // e.g., "claude"
  created_by_field: string;  // e.g., "created_by"
  modified_by_field: string; // e.g., "modified_by"
}

export const DEFAULT_AUTHORSHIP: AuthorshipConfig = {
  agent_name: "claude",
  created_by_field: "created_by",
  modified_by_field: "modified_by",
};

/**
 * Add or update authorship fields in markdown content.
 * - If no frontmatter exists, creates one with created_by
 * - If frontmatter exists but no created_by, adds created_by
 * - If created_by already exists, adds/updates modified_by
 *
 * Returns the modified content string.
 */
export function addAuthorship(
  content: string,
  config: AuthorshipConfig = DEFAULT_AUTHORSHIP,
): string {
  const wikilinkValue = `"[[${config.agent_name}]]"`;
  const createdByLine = `${config.created_by_field}: ${wikilinkValue}`;
  const modifiedByLine = `${config.modified_by_field}: ${wikilinkValue}`;

  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  if (fmMatch === null) {
    // No frontmatter — prepend a new block with created_by
    return `---\n${createdByLine}\n---\n${content}`;
  }

  const fmBody = fmMatch[1];
  const fmFull = fmMatch[0]; // e.g. "---\n...\n---"

  const createdByRegex = new RegExp(`^${escapeRegex(config.created_by_field)}\\s*:`, "m");
  const modifiedByRegex = new RegExp(`^${escapeRegex(config.modified_by_field)}\\s*:.*$`, "m");

  if (!createdByRegex.test(fmBody)) {
    // Frontmatter exists but no created_by — insert as last field before closing ---
    const newFmFull = fmFull.replace(/(\r?\n)---$/, `\n${createdByLine}$1---`);
    return content.replace(fmFull, newFmFull);
  }

  // created_by already present — handle modified_by
  if (modifiedByRegex.test(fmBody)) {
    // Update existing modified_by value
    const newFmBody = fmBody.replace(modifiedByRegex, modifiedByLine);
    const newFmFull = fmFull.replace(fmBody, newFmBody);
    return content.replace(fmFull, newFmFull);
  } else {
    // Insert modified_by after the created_by line
    const createdByLineRegex = new RegExp(
      `(^${escapeRegex(config.created_by_field)}\\s*:.*$)`,
      "m",
    );
    const newFmBody = fmBody.replace(createdByLineRegex, `$1\n${modifiedByLine}`);
    const newFmFull = fmFull.replace(fmBody, newFmBody);
    return content.replace(fmFull, newFmFull);
  }
}

/**
 * Check if a file's frontmatter has authorship fields.
 */
export function hasAuthorship(
  content: string,
  config: AuthorshipConfig = DEFAULT_AUTHORSHIP,
): { hasCreatedBy: boolean; hasModifiedBy: boolean } {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  if (fmMatch === null) {
    return { hasCreatedBy: false, hasModifiedBy: false };
  }

  const fmBody = fmMatch[1];
  const createdByRegex = new RegExp(`^${escapeRegex(config.created_by_field)}\\s*:`, "m");
  const modifiedByRegex = new RegExp(`^${escapeRegex(config.modified_by_field)}\\s*:`, "m");

  return {
    hasCreatedBy: createdByRegex.test(fmBody),
    hasModifiedBy: modifiedByRegex.test(fmBody),
  };
}

/**
 * Remove authorship fields from content (for testing/cleanup).
 */
export function removeAuthorship(
  content: string,
  config: AuthorshipConfig = DEFAULT_AUTHORSHIP,
): string {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  if (fmMatch === null) {
    return content;
  }

  const fmBody = fmMatch[1];
  const fmFull = fmMatch[0];

  const createdByLineRegex = new RegExp(`^${escapeRegex(config.created_by_field)}\\s*:.*\\r?\\n?`, "m");
  const modifiedByLineRegex = new RegExp(`^${escapeRegex(config.modified_by_field)}\\s*:.*\\r?\\n?`, "m");

  const newFmBody = fmBody
    .replace(createdByLineRegex, "")
    .replace(modifiedByLineRegex, "");

  const newFmFull = fmFull.replace(fmBody, newFmBody);
  return content.replace(fmFull, newFmFull);
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
