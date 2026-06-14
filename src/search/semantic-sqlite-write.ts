import { createSemanticEmbeddingProvider } from "./semantic-embedding-provider.js";
import { vectorBuffer } from "./semantic-embedding-hash.js";
import { openSemanticSqliteStore } from "./semantic-sqlite-db.js";
import type { SemanticEmbeddingProvider } from "./semantic-embedding-provider.js";
import type { SemanticSqliteDb } from "./semantic-sqlite-db.js";
import type { SemanticIndexFile, SemanticIndexedDocument } from "./semantic-types.js";

interface EmbeddedDocument {
  readonly document: SemanticIndexedDocument;
  readonly embedding?: Float32Array;
}

function insertDocument(
  db: SemanticSqliteDb,
  entry: EmbeddedDocument,
  vectorAvailable: boolean,
): void {
  const document = entry.document;
  const info = db.prepare(`
    INSERT INTO documents (
      collection, path, uri, docid, title, content, terms_json, term_frequency_json,
      line_count, mtime_ms, size, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    document.collection,
    document.path,
    document.uri,
    document.docid,
    document.title ?? null,
    document.content,
    JSON.stringify(document.terms),
    JSON.stringify(document.termFrequency),
    document.lineCount,
    document.mtimeMs,
    document.size,
  );
  const rowid = BigInt(info.lastInsertRowid);
  db.prepare("INSERT INTO documents_fts(docid, collection, path, title, content) VALUES (?, ?, ?, ?, ?)").run(
    document.docid,
    document.collection,
    document.path,
    document.title ?? "",
    document.content,
  );
  if (entry.embedding && vectorAvailable) {
    db.prepare("INSERT INTO document_vectors(rowid, embedding) VALUES (?, ?)").run(rowid, vectorBuffer(entry.embedding));
  }
}

function rewriteIndex(
  db: SemanticSqliteDb,
  index: SemanticIndexFile,
  entries: readonly EmbeddedDocument[],
  vectorAvailable: boolean,
): void {
  db.exec("DELETE FROM documents_fts; DELETE FROM documents;");
  if (vectorAvailable) db.exec("DELETE FROM document_vectors;");
  db.exec("DELETE FROM store_collections; DELETE FROM store_contexts; DELETE FROM store_meta;");
  const insertCollection = db.prepare(`
    INSERT INTO store_collections (
      name, path, pattern, ignore_patterns, include_by_default, update_command,
      context, doc_count, active_count, last_modified
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const collection of index.collections ?? []) {
    insertCollection.run(
      collection.name,
      collection.path,
      collection.pattern,
      JSON.stringify(collection.ignore),
      collection.includeByDefault ? 1 : 0,
      collection.updateCommand ?? null,
      collection.context ?? null,
      collection.documents,
      collection.activeDocuments,
      collection.lastModified ?? null,
    );
  }
  const insertContext = db.prepare("INSERT INTO store_contexts(collection, path_prefix, context, updated_at) VALUES (?, ?, ?, ?)");
  for (const context of index.contexts ?? []) {
    insertContext.run(context.collection ?? "", context.pathPrefix, context.context, context.updatedAt);
  }
  for (const entry of entries) insertDocument(db, entry, vectorAvailable);
  db.prepare("INSERT INTO store_meta(key, value) VALUES (?, ?)").run("generated_at", index.generatedAt);
  db.prepare("INSERT INTO store_meta(key, value) VALUES (?, ?)").run("vault", index.vault);
  db.prepare("INSERT INTO store_meta(key, value) VALUES (?, ?)").run("collection", index.collection);
  if (index.globalContext) {
    db.prepare("INSERT INTO store_meta(key, value) VALUES (?, ?)").run("global_context", index.globalContext);
  }
}

export async function writeSqliteSemanticIndex(
  index: SemanticIndexFile,
  opts: { readonly vault?: string; readonly index?: string; readonly embed?: boolean; readonly modelPath?: string },
): Promise<string> {
  const store = await openSemanticSqliteStore({ vault: opts.vault ?? index.vault, index: opts.index });
  let provider: SemanticEmbeddingProvider | undefined;
  try {
    const activeProvider = opts.embed === false ? undefined : await createSemanticEmbeddingProvider({ modelPath: opts.modelPath });
    provider = activeProvider;
    const entries = await Promise.all(index.documents.map(async (document): Promise<EmbeddedDocument> => ({
      document,
      embedding: activeProvider ? await activeProvider.embed(`${document.title ?? ""}\n${document.content}`) : undefined,
    })));
    const rewrite = store.db.transaction((next: SemanticIndexFile) => {
      rewriteIndex(store.db, next, entries, store.vectorAvailable);
    });
    rewrite(index);
    return store.path;
  } finally {
    await provider?.dispose();
    store.db.close();
  }
}
