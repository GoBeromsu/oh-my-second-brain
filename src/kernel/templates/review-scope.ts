import { proposedTemplateId } from "./census.js";
import { deriveTemplateSourcePath } from "./paths.js";
import type { TemplateReviewContext } from "./review-context.js";
import type { TemplateId, TemplateSourcePath } from "./types.js";

function diffPaths(diff: TemplateReviewContext["census"]["diffs"][number]): readonly TemplateSourcePath[] {
  return [diff.sourcePath, diff.oldSourcePath, diff.newSourcePath]
    .filter((value): value is TemplateSourcePath => value !== undefined);
}

/** Restricts review questions to one identity while retaining the full census digest for CAS. */
export function scopeTemplateReviewContext<T extends TemplateReviewContext>(
  context: T,
  templateId: TemplateId,
): T {
  const paths = new Set<string>();
  const binding = context.policy.templates[templateId];
  if (binding !== undefined) paths.add(deriveTemplateSourcePath(binding));
  for (const entry of context.census.entries) {
    if (entry.templateId === templateId || proposedTemplateId(entry.sourcePath) === templateId) paths.add(entry.sourcePath);
  }
  for (const diff of context.census.diffs) {
    if (diff.templateId === templateId || diffPaths(diff).some(path => paths.has(path))) {
      diffPaths(diff).forEach(path => paths.add(path));
    }
  }
  return {
    ...context,
    census: {
      ...context.census,
      entries: context.census.entries.filter(entry => paths.has(entry.sourcePath)),
      diffs: context.census.diffs.filter(diff => diff.templateId === templateId || diffPaths(diff).some(path => paths.has(path))),
      diagnostics: context.census.diagnostics.filter(item =>
        (item.path === undefined && item.templateId === undefined)
        || item.templateId === templateId
        || (item.path !== undefined && paths.has(item.path))),
    },
    freshTemplateIds: context.freshTemplateIds.filter(id => id === templateId),
  };
}
