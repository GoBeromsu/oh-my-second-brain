import path from "node:path";
import { realpath } from "node:fs/promises";
import { managedSourceExclusionMatcher } from "../../conventions/note-exclude.js";
import { mapWithConcurrency } from "../../conventions/vault-walk.js";
import { documentSourceFingerprint, readDocumentSource } from "./source.js";
import type { EngineStore } from "./store.js";
import { walkMarkdown } from "./sync.js";

export interface IndexSourceSnapshot {
  readonly vault: string;
  readonly collection?: string;
  readonly files: ReadonlyMap<string, string>;
  readonly contentSha256?: ReadonlyMap<string, string>;
  readonly byteVerifiedPaths?: ReadonlySet<string>;
}

export type IndexSourceVerification =
  | { readonly available: true; readonly snapshot: IndexSourceSnapshot }
  | { readonly available: false; readonly reason: string };

function inCollection(docPath: string, collection: string | undefined): boolean {
  return collection === undefined || collection === "" || docPath === collection || docPath.startsWith(`${collection}/`);
}

/** Same note eligibility as lexical synchronization; symlinks are not followed. */
export async function scanIndexSources(vault: string, collection?: string, forceBytePaths: ReadonlySet<string> = new Set()): Promise<IndexSourceSnapshot> {
  const root = await realpath(vault);
  const directory = collection === undefined ? root : path.resolve(root, collection);
  const relative = path.relative(root, directory).replaceAll("\\", "/");
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("Index source collection must stay inside the vault.");
  const excluded = await managedSourceExclusionMatcher(root);
  const files: string[] = [];
  // Enumerate from the root: a collection can also name a single Markdown file,
  // and changing an ancestor directory must follow the same lexical policy.
  for await (const file of walkMarkdown(root, root, { strict: true })) {
    if (inCollection(file, collection) && !(await excluded(file))) files.push(file);
  }
  const byteVerifiedPaths = new Set<string>();
  const entries = await mapWithConcurrency(files.sort(), 32, async file => {
    const fingerprint = await documentSourceFingerprint(root, file, root);
    const useBytes = fingerprint === null || forceBytePaths.has(file);
    if (useBytes) byteVerifiedPaths.add(file);
    const token = useBytes ? `bytes:${(await readDocumentSource(root, file)).source.contentSha256}` : `metadata:${fingerprint}`;
    return [file, token] as const;
  });
  return { vault: root, ...(collection === undefined ? {} : { collection }), files: new Map(entries), byteVerifiedPaths };
}

/**
 * Metadata validates unchanged notes. Only metadata-changed notes are read to
 * distinguish byte-identical touches from stale lexical content.
 */
export async function verifyIndexSources(store: EngineStore, vault: string, collection?: string): Promise<IndexSourceVerification> {
  try {
    const sources = store.readDocumentSources();
    if (sources === null) return { available: false, reason: "INDEX_SOURCE_UNVERIFIED: this index predates source evidence." };
    const snapshot = await scanIndexSources(vault, collection, new Set([...sources].filter(([, source]) => source.fingerprint === null).map(([docPath]) => docPath)));
    const verifiedFiles = new Map(snapshot.files);
    const byteVerifiedPaths = new Set(snapshot.byteVerifiedPaths);
    if (store.listDocPaths().some(docPath => inCollection(docPath, collection) && !snapshot.files.has(docPath))) {
      return { available: false, reason: "INDEX_SOURCE_DRIFT: indexed notes were deleted, renamed, or excluded." };
    }
    for (const [docPath, fingerprint] of snapshot.files) {
      const source = sources.get(docPath);
      if (source === undefined) return { available: false, reason: "INDEX_SOURCE_UNVERIFIED: a live note is not covered by the indexed source evidence." };
      if (source.fingerprint !== null && `metadata:${source.fingerprint}` === fingerprint) continue;
      const current = await readDocumentSource(snapshot.vault, docPath);
      if (current.source.contentSha256 !== source.contentSha256) {
        return { available: false, reason: "INDEX_SOURCE_DRIFT: note content changed after indexing." };
      }
      // Once bytes were needed, keep the same stronger check for the final
      // revalidation even if pathname and handle metadata expose different precision.
      verifiedFiles.set(docPath, `bytes:${current.source.contentSha256}`);
      byteVerifiedPaths.add(docPath);
    }
    return { available: true, snapshot: { ...snapshot, files: verifiedFiles, byteVerifiedPaths, contentSha256: new Map([...snapshot.files.keys()].map(docPath => [docPath, sources.get(docPath)!.contentSha256])) } };
  } catch (error) {
    return { available: false, reason: `INDEX_SOURCE_UNVERIFIED: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Check after retrieval and live preview reads, before claiming a fresh result. */
export async function indexSourcesUnchanged(snapshot: IndexSourceSnapshot): Promise<boolean> {
  const current = await scanIndexSources(snapshot.vault, snapshot.collection, snapshot.byteVerifiedPaths);
  return current.files.size === snapshot.files.size && [...current.files].every(([docPath, stamp]) => snapshot.files.get(docPath) === stamp);
}
