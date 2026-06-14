import { readSemanticIndex } from "./semantic-index.js";
import { loadIndexOrEmpty, normalizePathPrefix, now, writeIndex } from "./semantic-maintenance-shared.js";
import type { SemanticContextResult, SemanticStorage } from "./semantic-types.js";

export async function addSemanticContext(opts: {
  readonly vault: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
  readonly collection?: string;
  readonly pathPrefix?: string;
  readonly context: string;
}): Promise<SemanticContextResult> {
  const index = await loadIndexOrEmpty(opts);
  const pathPrefix = normalizePathPrefix(opts.pathPrefix);
  const contexts = [
    ...(index.contexts ?? []).filter(
      (entry) => entry.collection !== opts.collection || entry.pathPrefix !== pathPrefix,
    ),
    { collection: opts.collection, pathPrefix, context: opts.context, updatedAt: now() },
  ].sort((a, b) => (a.collection ?? "").localeCompare(b.collection ?? "") || a.pathPrefix.localeCompare(b.pathPrefix));
  await writeIndex({ ...index, contexts }, opts);
  return { available: true, contexts };
}

export async function removeSemanticContext(opts: {
  readonly vault: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
  readonly collection?: string;
  readonly pathPrefix?: string;
}): Promise<SemanticContextResult> {
  const loaded = await readSemanticIndex(opts);
  if (!loaded.available) return { available: false, reason: loaded.reason, contexts: [] };
  const pathPrefix = normalizePathPrefix(opts.pathPrefix);
  const contexts = (loaded.index.contexts ?? []).filter(
    (entry) => entry.collection !== opts.collection || entry.pathPrefix !== pathPrefix,
  );
  await writeIndex({ ...loaded.index, contexts }, opts);
  return { available: true, contexts };
}

export async function listSemanticContexts(opts: {
  readonly vault: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
}): Promise<SemanticContextResult> {
  const loaded = await readSemanticIndex(opts);
  if (!loaded.available) return { available: false, reason: loaded.reason, contexts: [] };
  return { available: true, contexts: loaded.index.contexts ?? [] };
}
