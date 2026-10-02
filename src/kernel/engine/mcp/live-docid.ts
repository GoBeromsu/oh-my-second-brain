import path from "node:path";
import { managedSourceExclusionMatcher } from "../../conventions/note-exclude.js";
import { readDocumentSource } from "../embed/source.js";

/**
 * Native docids are real vault-relative Markdown paths (ADR-001). Resolve the
 * current admitted note, rather than requiring a stale persistent index row.
 * The source capture rejects symlinks/escapes and binds the returned bytes to
 * the opened file. This does not select or downgrade the caller's backend.
 */
export async function readLiveDocumentId(vault: string, docid: string): Promise<{ readonly path: string; readonly content: string } | null> {
  if (path.isAbsolute(docid) || docid.includes("\\") || !docid.toLowerCase().endsWith(".md")) return null;
  const segments = docid.split("/");
  if (segments.some(segment => segment === "" || segment.startsWith(".") || segment === "node_modules")) return null;
  try {
    const excluded = await managedSourceExclusionMatcher(vault);
    if (await excluded(docid)) return null;
    const captured = await readDocumentSource(vault, docid);
    return { path: docid, content: captured.content };
  } catch {
    return null;
  }
}
