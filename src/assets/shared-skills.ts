import path from "node:path";

/** The single authored skill source used by every host installer. */
export const SHARED_SKILLS_SOURCE = "assets/skills";

/** Absolute path to the shared skill source beneath `packageRoot`. */
export function resolveSharedSkillsSource(packageRoot: string): string {
  return path.join(packageRoot, ...SHARED_SKILLS_SOURCE.split("/"));
}
